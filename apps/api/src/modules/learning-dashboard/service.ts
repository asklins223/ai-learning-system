/**
 * Plan 23 W3-01..W3-06：LearningDashboardV2 服务。
 *
 * - counts 全部按 Objective 口径（hidden alias=0：只统计 learning_objectives_v2
 *   active；archived/superseded 不进 activeObjectives）；
 * - mode 与 counts 同一 eligibility cutoff（同一事务/同一 now）；
 * - primaryFocus 优先级：resume > review due > first validation > practice 建议
 *   （W3-03 规则表）；
 * - 部分依赖失败 → 显式 degraded mode，不伪装空工作区（§19.2）；
 * - Dashboard revision 只由稳定内容（counts/mode/degradation + 各 section 的
 *   objectiveId+surfaceRevision 标识）派生，排除 snapshotAt，供 ETag 304 协商。
 */
import { and, eq, lt, inArray, sql, desc, isNull, or, lte } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { ApiTransaction } from "../../db/client.ts";
import { learningObjectivesV2, learningObjectiveRevisionsV2 } from "@ailearn/shared/db-schema/card-generation-v2";
import { learningRuns } from "@ailearn/shared/db-schema/learning-runs";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import { notes } from "@ailearn/shared/db-schema/note";
import { visibleNotesCondition, visibleObjectivesCondition } from "../note/visibility.ts";
import type { LearningDashboardV2 } from "@ailearn/shared";
import { reviewScheduleTargetsConsumableCardPredicate } from "../review/consumer-eligibility.ts";
import {
  assembleObjectiveSurfaceV3,
  listObjectiveSurfacesV3,
  type SurfaceContext,
} from "../learning-objectives/surface-service.ts";
import { resolvePrimaryActionV3 } from "../learning-objectives/action-resolver.ts";
import {
  dashboardBuildDurationSeconds,
  dashboardEmptyWithActiveObjectivesTotal,
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
/** 在途清单与 room 投影那一节同一个上限（`roomActiveRunSummaryDataSchema` 也是 20）。 */
const ACTIVE_RUN_LIMIT = 20;
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
        // 批次 4.5：这一格与下面 `suggestedNote` 必须同一个判据。它们一起决定
        // `mode`（first_use / notes_without_objectives）并进 `dashboardRevision`
        // 的哈希——只筛一个的话，缓存键与内容会按人错位。
        .where(and(eq(notes.workspaceId, ctx.workspaceId), visibleNotesCondition(ctx.userId), isNull(notes.deletedAt))),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(learningObjectivesV2)
        // 批次 4.5 收尾：目标可见性跟着它的来源笔记走，所以这一格与上面的 notes
        // 计数同一个人判据——它同样进 `mode` 和 `dashboardRevision` 的哈希。
        .where(and(
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
          eq(learningObjectivesV2.lifecycle, "active"),
          visibleObjectivesCondition(ctx.userId, learningObjectivesV2.objectiveId),
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
          // 与 Member V2 到期队列同一条口径（review/service.ts）：延后期内的卡
          // 不算「到期」，指向不可消费卡的排期也不算——否则页 14 的数字和页 15
          // 的队列对不上。
          or(
            isNull(reviewSchedules.userDeferredUntil),
            lte(reviewSchedules.userDeferredUntil, now),
          ),
          reviewScheduleTargetsConsumableCardPredicate(),
        )),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
          eq(learningObjectivesV2.lifecycle, "active"),
          visibleObjectivesCondition(ctx.userId, learningObjectivesV2.objectiveId),
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

  // ── 在途 run 清单（审计 F24）────────────────────────────────────────────
  // 与 `counts.activeRuns` 同一条判据（workspace + user + ACTIVE_RUN_PHASES）、同一个上限。
  // 名字来自目标当前修订的 conceptLabel；V2 的每一种 origin 都带顶层 objectiveId。
  let activeRuns: LearningDashboardV2["activeRuns"] = [];
  try {
    const runRows = await tx
      .select({
        runId: learningRuns.id,
        phase: learningRuns.phase,
        origin: learningRuns.origin,
        updatedAt: learningRuns.updatedAt,
      })
      .from(learningRuns)
      .where(and(
        eq(learningRuns.workspaceId, ctx.workspaceId),
        eq(learningRuns.userId, ctx.userId),
        inArray(learningRuns.phase, [...ACTIVE_RUN_PHASES]),
      ))
      .orderBy(desc(learningRuns.updatedAt))
      .limit(ACTIVE_RUN_LIMIT);

    const objectiveIds = [...new Set(runRows.flatMap((row) => {
      if (row.origin && typeof row.origin === "object") {
        const objectiveId = (row.origin as { objectiveId?: unknown }).objectiveId;
        if (typeof objectiveId === "string" && objectiveId.length > 0) return [objectiveId];
      }
      return [];
    }))];
    const labelRows = objectiveIds.length > 0
      ? await tx
          .select({
            objectiveId: learningObjectivesV2.objectiveId,
            conceptLabel: learningObjectiveRevisionsV2.conceptLabel,
          })
          .from(learningObjectivesV2)
          .innerJoin(
            learningObjectiveRevisionsV2,
            and(
              eq(learningObjectiveRevisionsV2.workspaceId, learningObjectivesV2.workspaceId),
              eq(learningObjectiveRevisionsV2.objectiveRevisionId, learningObjectivesV2.currentObjectiveRevisionId),
            ),
          )
          .where(and(
            eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
            inArray(learningObjectivesV2.objectiveId, objectiveIds),
            // 与 counts / queue / recent 那三处同一道判据：目标不可见时名字留空，
            // 而这条 run 本身还在（它是用户自己的行）。
            visibleObjectivesCondition(ctx.userId, learningObjectivesV2.objectiveId),
          ))
      : [];
    const labelById = new Map(labelRows.map((row) => [row.objectiveId, row.conceptLabel]));
    activeRuns = runRows.map((row) => {
      const objectiveId = row.origin && typeof row.origin === "object"
        && typeof (row.origin as { objectiveId?: unknown }).objectiveId === "string"
        ? (row.origin as { objectiveId: string }).objectiveId
        : null;
      return {
        runId: row.runId,
        phase: row.phase,
        objectiveId,
        conceptLabel: objectiveId ? labelById.get(objectiveId) ?? null : null,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  } catch (err) {
    // 与 counts 同一档降级：清单读不到就让这一节显式失败，不给一个空清单冒充"没有"。
    const unavailable = new Set(degraded?.unavailableSections ?? []);
    unavailable.add("activeRuns");
    degraded = { unavailableSections: [...unavailable], retryable: true };
    activeRuns = [];
  }

  // ── mode（同一 cutoff）────────────────────────────────────────────────
  // §9.3 状态优先级：degraded > first_use > empty_after_filter >
  // notes_without_objectives > run_in_progress > review_due > objectives_ready
  let mode: LearningDashboardV2["mode"];
  if (degraded) {
    mode = "degraded";
  } else if (counts.notes === 0 && counts.activeObjectives === 0) {
    // 无 Note 且无 active Objective → first_use
    mode = "first_use";
  } else if (counts.activeObjectives === 0) {
    // 有 Note 但无 active Objective：需要区分两种情况：
    // - notes_without_objectives：从未生成过 Objective（无 archived/superseded）
    // - empty_after_filter：所有 Objective 已归档或不可用（§9.3）
    try {
      const totalObjectives = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
          inArray(learningObjectivesV2.lifecycle, ["archived", "superseded"]),
          visibleObjectivesCondition(ctx.userId, learningObjectivesV2.objectiveId),
        ));
      const hasArchivedObjectives = Number(totalObjectives[0]?.n ?? 0) > 0;
      mode = hasArchivedObjectives ? "empty_after_filter" : "notes_without_objectives";
    } catch {
      // 查询失败时降级为 notes_without_objectives（更安全的默认值）
      mode = "notes_without_objectives";
    }
  } else if (counts.activeRuns > 0) {
    mode = "run_in_progress";
  } else if (counts.reviewsDue > 0) {
    mode = "review_due";
  } else {
    mode = "objectives_ready";
  }

  // ── RL-09/RL-10 metrics（post-mode）────────────────────────────────
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
        .where(and(eq(notes.workspaceId, ctx.workspaceId), visibleNotesCondition(ctx.userId), isNull(notes.deletedAt)))
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

  // dashboardRevision：只对稳定内容做哈希，排除 snapshotAt。snapshotAt 每次
  // 请求都重新生成，混入哈希会让 ETag 每次必变，routes.ts 的
  // If-None-Match → 304 分支永不可达。稳定内容 = counts + mode + degradation
  // + primaryFocus/queue/recent 的 objectiveId+surfaceRevision 标识 +
  // suggestedNote 的 noteId+noteVersionId。
  const stableIdentity = {
    counts,
    mode,
    // 清单也进哈希：它变了 ETag 就得变，否则客户端会拿 304 继续显示旧的十条。
    activeRuns,
    degradation: degraded,
    primaryFocus: primaryFocus
      ? {
          objectiveId: primaryFocus.objective.objectiveId,
          surfaceRevision: primaryFocus.objective.surfaceRevision,
        }
      : null,
    queue: queue.map((entry) => ({
      objectiveId: entry.objective.objectiveId,
      surfaceRevision: entry.objective.surfaceRevision,
    })),
    recent: recentObjectives.map((objective) => ({
      objectiveId: objective.objectiveId,
      surfaceRevision: objective.surfaceRevision,
    })),
    suggestedNote: suggestedNote
      ? { noteId: suggestedNote.noteId, noteVersionId: suggestedNote.noteVersionId }
      : null,
  };
  const dashboardRevision = createHash("sha256")
    .update(JSON.stringify(stableIdentity))
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
    activeRuns,
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
