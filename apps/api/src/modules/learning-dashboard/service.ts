/**
 * Plan 23 W3-01..W3-06：LearningDashboardV2 服务。
 *
 * - counts 全部按 Objective 口径（hidden alias=0：只统计 learning_objectives_v2
 *   active；archived/superseded 不进 activeObjectives）；
 * - mode 与 counts 同一 eligibility cutoff（同一事务/同一 now）；
 * - primaryFocus 优先级：resume > review due > first validation > practice 建议
 *   （W3-03 规则表）；
 * - 部分依赖失败 → 显式 degraded mode，不伪装空工作区（§19.2）；
 * - Dashboard revision 由 surface revisions 派生，供 ETag 失效。
 */
import { and, eq, lt, inArray, sql, desc, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { ApiTransaction } from "../../db/client.ts";
import { learningObjectivesV2 } from "../../db/schema/card-generation-v2.ts";
import { learningRuns } from "../../db/schema/learning-runs.ts";
import { reviewSchedules } from "../../db/schema/evidence.ts";
import { notes } from "../../db/schema/note.ts";
import type { LearningDashboardV2 } from "@ailearn/shared";
import {
  assembleObjectiveSurfaceV3,
  listObjectiveSurfacesV3,
  type SurfaceContext,
} from "../learning-objectives/surface-service.ts";
import { resolvePrimaryActionV3 } from "../learning-objectives/action-resolver.ts";
import {
  dashboardBuildDurationSeconds,
  dashboardEmptyWithActiveObjectivesTotal,
  objectivesWithoutOriginGauge,
} from "../../lib/metrics.ts";

const ACTIVE_RUN_PHASES = [
  "preparing",
  "active",
  "assessing",
  "checkpoint",
  "committing",
  "paused",
] as const;

const FOCUS_LIMIT = 50;
const QUEUE_LIMIT = 5;
const RECENT_LIMIT = 5;

export interface DashboardContext extends SurfaceContext {
  workspaceId: string;
  userId: string;
}

export async function buildLearningDashboardV2(
  tx: ApiTransaction,
  ctx: DashboardContext,
): Promise<LearningDashboardV2> {
  const now = new Date();
  const snapshotAt = now.toISOString();

  // ── RL-09 指标：Dashboard 全流程计时 ──────────────────────────────────
  const dashboardStartedAt = Date.now();

  // ── counts（W3-01）─────────────────────────────────────────────────────
  let counts: LearningDashboardV2["counts"];
  let degraded: LearningDashboardV2["degradation"] = null;
  try {
    const [notesCount, objectivesCount, runsCount, dueCount, repairCount] = await Promise.all([
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(notes)
        .where(and(eq(notes.workspaceId, ctx.workspaceId), isNull(notes.deletedAt))),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
          eq(learningObjectivesV2.lifecycle, "active"),
        )),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(learningRuns)
        .where(and(
          eq(learningRuns.workspaceId, ctx.workspaceId),
          eq(learningRuns.userId, ctx.userId),
          inArray(learningRuns.phase, [...ACTIVE_RUN_PHASES]),
        )),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(reviewSchedules)
        .where(and(
          eq(reviewSchedules.workspaceId, ctx.workspaceId),
          eq(reviewSchedules.userId, ctx.userId),
          eq(reviewSchedules.status, "pending"),
          lt(reviewSchedules.nextReviewAt, now),
        )),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
          eq(learningObjectivesV2.lifecycle, "active"),
          sql`NOT EXISTS (SELECT 1 FROM learning_objective_origins_v2 o
             WHERE o.workspace_id = learning_objectives_v2.workspace_id
               AND o.objective_id = learning_objectives_v2.objective_id)`,
        )),
    ]);
    counts = {
      notes: Number(notesCount[0]?.n ?? 0),
      activeObjectives: Number(objectivesCount[0]?.n ?? 0),
      activeRuns: Number(runsCount[0]?.n ?? 0),
      reviewsDue: Number(dueCount[0]?.n ?? 0),
      needsRepair: Number(repairCount[0]?.n ?? 0),
    };
  } catch (err) {
    degraded = {
      unavailableSections: ["counts"],
      retryable: true,
    };
    counts = { notes: 0, activeObjectives: 0, activeRuns: 0, reviewsDue: 0, needsRepair: 0 };
  }

  // ── mode（同一 cutoff）────────────────────────────────────────────────
  let mode: LearningDashboardV2["mode"];
  if (degraded) {
    mode = "degraded";
  } else if (counts.notes === 0 && counts.activeObjectives === 0) {
    mode = "first_use";
  } else if (counts.activeObjectives === 0) {
    mode = "notes_without_objectives";
  } else if (counts.activeRuns > 0) {
    mode = "run_in_progress";
  } else if (counts.reviewsDue > 0) {
    mode = "review_due";
  } else {
    mode = "objectives_ready";
  }

  // ── RL-09/RL-10 metrics（post-mode）────────────────────────────────
  objectivesWithoutOriginGauge.set(counts.needsRepair);
  if (
    (mode === "first_use" || mode === "notes_without_objectives") &&
    counts.activeObjectives > 0
  ) {
    dashboardEmptyWithActiveObjectivesTotal.inc();
  }

  // ── primary focus / queue / recent（W3-02..W3-04）──────────────────────
  let primaryFocus: LearningDashboardV2["primaryFocus"] = null;
  let queue: LearningDashboardV2["queue"] = [];
  let recentObjectives: LearningDashboardV2["recentObjectives"] = [];
  let suggestedNote: LearningDashboardV2["suggestedNote"] = null;
  let surfaceRevisionSum = 0;

  if (counts.activeObjectives > 0) {
    try {
      const page = await listObjectiveSurfacesV3(tx, ctx, { limit: FOCUS_LIMIT });
      const scored = page.items
        .map((surface) => ({
          surface,
          score: priorityScore(surface),
          reasonCodes: priorityReasons(surface),
        }))
        .sort((a, b) => a.score - b.score || b.surface.updatedAt.localeCompare(a.surface.updatedAt));

      const primary = scored[0];
      if (primary) {
        primaryFocus = {
          objective: primary.surface,
          reasonCodes: primary.reasonCodes,
          action: primary.surface.primaryAction,
        };
      }
      queue = scored
        .slice(1, 1 + QUEUE_LIMIT)
        .filter((s) => s.surface.primaryAction.kind !== "none")
        .map((s) => ({
          objective: s.surface,
          reasonCodes: s.reasonCodes,
          action: s.surface.primaryAction,
        }));
      // FE-10：recent 不重复展示 primary item
      recentObjectives = [...page.items]
        .filter((s) => s.objectiveId !== primary?.surface.objectiveId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, RECENT_LIMIT);
      surfaceRevisionSum = page.items.reduce((acc, s) => acc + s.surfaceRevision, 0);
    } catch (err) {
      degraded = degraded ?? { unavailableSections: [], retryable: true };
      degraded.unavailableSections.push("focus");
      mode = "degraded";
    }
  } else if (counts.notes > 0) {
    try {
      const noteRows = await tx
        .select({ id: notes.id, currentVersionId: notes.currentVersionId, title: notes.title })
        .from(notes)
        .where(and(eq(notes.workspaceId, ctx.workspaceId), isNull(notes.deletedAt)))
        .orderBy(desc(notes.updatedAt))
        .limit(1);
      if (noteRows[0]) {
        suggestedNote = {
          noteId: noteRows[0].id,
          noteVersionId: noteRows[0].currentVersionId ?? noteRows[0].id,
          title: noteRows[0].title,
          reasonCodes: ["notes_without_objectives"],
        };
      }
    } catch {
      // suggestedNote 失败不降级整个 Dashboard
    }
  }

  const dashboardRevision = createHash("sha256")
    .update(JSON.stringify({ counts, surfaceRevisionSum, snapshotAt }))
    .digest("hex")
    .slice(0, 24);

  // RL-09：Dashboard E2E 延迟记录。
  dashboardBuildDurationSeconds.observe((Date.now() - dashboardStartedAt) / 1000);

  return {
    version: 2,
    snapshotAt,
    dashboardRevision,
    counts,
    mode,
    primaryFocus,
    queue,
    recentObjectives,
    suggestedNote,
    degradation: degraded,
  };
}

/** W3-03 优先级：分数越低越优先。 */
function priorityScore(surface: Awaited<ReturnType<typeof assembleObjectiveSurfaceV3>>): number {
  switch (surface.primaryAction.kind) {
    case "resume_run":
      return 0;
    case "create_review_run":
      return 1;
    case "create_run":
      return surface.personal.initialValidation?.status === "ready" ? 2 : 3;
    case "practice_only":
      return 4;
    case "refresh":
      return 5;
    case "view_successor":
      return 6;
    case "none":
      return 7;
    default:
      return 8;
  }
}

function priorityReasons(
  surface: Awaited<ReturnType<typeof assembleObjectiveSurfaceV3>>,
): string[] {
  switch (surface.primaryAction.kind) {
    case "resume_run":
      return ["resume_active_run"];
    case "create_review_run":
      return ["review_due_schedule"];
    case "create_run":
      return surface.personal.initialValidation?.status === "ready"
        ? ["first_validation_ready"]
        : ["objective_ready"];
    case "practice_only":
      return ["practice_only_reveal"];
    case "refresh":
      return ["missing_origin_repair"];
    case "view_successor":
      return ["superseded_has_successor"];
    case "none":
      return ["no_action_available"];
    default:
      return ["unknown_action"];
  }
}

export { resolvePrimaryActionV3 };
