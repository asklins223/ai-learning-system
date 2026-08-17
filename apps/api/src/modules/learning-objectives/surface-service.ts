/**
 * Plan 23 W2-09/W2-10/W2-17/W2-18：Objective Surface 装配器。
 *
 * - content：概念标题/公开说明/knowledgeForm/lifecycle/freshness/presentation
 *   （读取 Objective revision 与 active Card，不读 legacy summary）；
 * - sources：Origin 血缘 + 主来源 Note 标题（多来源按 supportGrade 排序）；
 * - personal：initialValidation / activeRun / review（服务端状态，不靠客户端推断）；
 * - primaryAction：resolvePrimaryActionV3（服务端唯一裁决）。
 *
 * 公共边界：本文件永不输出 canonicalAnswer / rubric / private payload。
 */
import { and, eq, asc, inArray, sql, lt, desc } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningCardsV2,
  initialValidationRemindersV2,
} from "../../db/schema/card-generation-v2.ts";
import { learningRuns } from "../../db/schema/learning-runs.ts";
import { notes } from "../../db/schema/note.ts";
import { reviewSchedules } from "../../db/schema/evidence.ts";
import type {
  LearningObjectiveSurfaceV3,
  ObjectiveOriginV3,
  ObjectiveListItemV3,
} from "@ailearn/shared";
import { listOriginsByObjective } from "./origin-service.ts";
import { resolvePrimaryActionV3, type ActionResolverInputV3 } from "./action-resolver.ts";

export class ObjectiveNotFoundError extends Error {
  constructor(objectiveId: string, workspaceId: string) {
    super("objective " + objectiveId + " not found in workspace " + workspaceId);
    this.name = "ObjectiveNotFoundError";
  }
}

export interface SurfaceContext {
  workspaceId: string;
  userId: string;
  /** create_run 场景入口（默认 home）。 */
  origin?: "card" | "home" | "today" | "review" | "graph" | "onboarding" | "pet";
  goal?: string;
}

const ACTIVE_RUN_PHASES = [
  "preparing",
  "active",
  "assessing",
  "checkpoint",
  "committing",
  "paused",
] as const;

// ─── 个人状态 loader（W2-11..13 精简版；投影 adapter 边界在 W4 收紧）──────

async function loadInitialValidation(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  objectiveId: string,
): Promise<LearningObjectiveSurfaceV3["personal"]["initialValidation"]> {
  const rows = await tx
    .select()
    .from(initialValidationRemindersV2)
    .where(and(
      eq(initialValidationRemindersV2.workspaceId, ctx.workspaceId),
      eq(initialValidationRemindersV2.userId, ctx.userId),
      eq(initialValidationRemindersV2.objectiveId, objectiveId),
      inArray(initialValidationRemindersV2.status, ["pending", "ready"]),
    ))
    .orderBy(desc(initialValidationRemindersV2.updatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const now = new Date();
  const notBefore = row.qualificationNotBefore;
  const ready =
    row.status === "ready" || (row.status === "pending" && notBefore.getTime() <= now.getTime());
  return {
    reminderId: row.reminderId,
    status: ready ? "ready" : "deferred",
    qualificationNotBefore: notBefore.toISOString(),
  };
}

async function loadActiveRun(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  objectiveId: string,
): Promise<LearningObjectiveSurfaceV3["personal"]["activeRun"]> {
  // V2 run 通过 key_point_id = objectiveId（alias 规则，方案 20 §29.4）
  const rows = await tx
    .select({ runId: learningRuns.id, phase: learningRuns.phase })
    .from(learningRuns)
    .where(and(
      eq(learningRuns.workspaceId, ctx.workspaceId),
      eq(learningRuns.userId, ctx.userId),
      eq(learningRuns.keyPointId, objectiveId),
      inArray(learningRuns.phase, [...ACTIVE_RUN_PHASES]),
    ))
    .orderBy(desc(learningRuns.createdAt))
    .limit(1);
  const row = rows[0];
  return row ? { runId: row.runId, phase: row.phase } : null;
}

async function loadReview(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  objectiveId: string,
): Promise<LearningObjectiveSurfaceV3["personal"]["review"]> {
  const rows = await tx
    .select()
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.workspaceId, ctx.workspaceId),
      eq(reviewSchedules.userId, ctx.userId),
      eq(reviewSchedules.keyPointId, objectiveId),
      eq(reviewSchedules.status, "pending"),
    ))
    .orderBy(asc(reviewSchedules.nextReviewAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const due = row.nextReviewAt.getTime() <= Date.now();
  return {
    status: due ? "due" : "scheduled",
    scheduleId: row.id,
    generation: row.generation,
    dueAt: row.nextReviewAt.toISOString(),
  };
}

// ─── freshness（W2-08 简化：note 新版本 → source_outdated）────────────────

async function computeFreshness(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  origins: ObjectiveOriginV3[],
): Promise<"fresh" | "source_outdated" | "legacy_unreviewed"> {
  const noteOrigins = origins.filter((o) => o.kind === "note");
  if (noteOrigins.length === 0) {
    return origins.length === 0 ? "legacy_unreviewed" : "fresh";
  }
  const noteIds = [...new Set(noteOrigins.map((o) => (o.kind === "note" ? o.noteId : null)).filter(Boolean))];
  if (noteIds.length === 0) return "fresh";
  const noteRows = await tx
    .select({ id: notes.id, currentVersionId: notes.currentVersionId })
    .from(notes)
    .where(and(eq(notes.workspaceId, ctx.workspaceId), inArray(notes.id, noteIds as string[])));
  const currentByNote = new Map(noteRows.map((n) => [n.id, n.currentVersionId]));
  const outdated = noteOrigins.some(
    (o) =>
      o.kind === "note" &&
      currentByNote.get(o.noteId) !== null &&
      currentByNote.get(o.noteId) !== undefined &&
      currentByNote.get(o.noteId) !== o.noteVersionId,
  );
  return outdated ? "source_outdated" : "fresh";
}

// ─── detail assembler（W2-17）────────────────────────────────────────────

export async function assembleObjectiveSurfaceV3(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  objectiveId: string,
): Promise<LearningObjectiveSurfaceV3> {
  const objectiveRows = await tx
    .select()
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
      eq(learningObjectivesV2.objectiveId, objectiveId),
    ))
    .limit(1);
  const objective = objectiveRows[0];
  if (!objective) {
    throw new ObjectiveNotFoundError(objectiveId, ctx.workspaceId);
  }

  const revisionRows = objective.currentObjectiveRevisionId
    ? await tx
        .select()
        .from(learningObjectiveRevisionsV2)
        .where(and(
          eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
          eq(learningObjectiveRevisionsV2.objectiveRevisionId, objective.currentObjectiveRevisionId),
        ))
        .limit(1)
    : [];
  const revision = revisionRows[0];

  const cardRows = await tx
    .select()
    .from(learningCardsV2)
    .where(and(
      eq(learningCardsV2.workspaceId, ctx.workspaceId),
      eq(learningCardsV2.objectiveId, objectiveId),
      eq(learningCardsV2.lifecycle, "active"),
    ))
    .limit(1);
  const card = cardRows[0];

  const origins = await listOriginsByObjective(tx, ctx.workspaceId, objectiveId);

  // 主来源 Note 标题
  const noteIds = [
    ...new Set(
      origins
        .filter((o) => o.kind === "note" && o.noteId)
        .map((o) => (o.kind === "note" ? o.noteId : null)),
    ),
  ];
  let primaryNote: LearningObjectiveSurfaceV3["sources"]["primaryNote"] = null;
  if (noteIds.length > 0) {
    const noteRows = await tx
      .select({ id: notes.id, title: notes.title, currentVersionId: notes.currentVersionId })
      .from(notes)
      .where(and(eq(notes.workspaceId, ctx.workspaceId), inArray(notes.id, noteIds as string[])));
    const primaryOrigin = origins.find((o) => o.kind === "note" && o.supportGrade === "primary")
      ?? origins.find((o) => o.kind === "note");
    if (primaryOrigin && primaryOrigin.kind === "note") {
      const noteRow = noteRows.find((n) => n.id === primaryOrigin.noteId);
      if (noteRow) {
        primaryNote = {
          noteId: primaryOrigin.noteId,
          noteVersionId: primaryOrigin.noteVersionId,
          title: noteRow.title,
        };
      }
    }
  }

  const freshness = await computeFreshness(tx, ctx, origins);

  const [initialValidation, activeRun, review] = await Promise.all([
    loadInitialValidation(tx, ctx, objectiveId),
    loadActiveRun(tx, ctx, objectiveId),
    loadReview(tx, ctx, objectiveId),
  ]);

  const actionInput: ActionResolverInputV3 = {
    objectiveId,
    lifecycle: objective.lifecycle as ActionResolverInputV3["lifecycle"],
    successorObjectiveId: null,
    successorCardId: null,
    hasActiveCard: Boolean(card),
    cardId: card?.cardId ?? null,
    activeRun,
    reviewDue: review?.status === "due" ? { scheduleId: review.scheduleId, generation: review.generation } : null,
    initialReady: initialValidation?.status === "ready"
      ? { reminderId: initialValidation.reminderId, qualificationNotBefore: initialValidation.qualificationNotBefore ?? new Date(0).toISOString() }
      : null,
    practiceOnly: false,
    practiceReasonCodes: [],
    origin: ctx.origin ?? "home",
    goal: ctx.goal ?? "继续学习",
  };
  const primaryAction = resolvePrimaryActionV3(actionInput);

  return {
    version: 3,
    objectiveId,
    surfaceRevision: objective.surfaceRevision,
    content: {
      conceptLabel: revision?.conceptLabel ?? null,
      publicSummary: revision?.publicSummary ?? "",
      knowledgeForm: (revision?.knowledgeForm ?? "fact") as never,
      lifecycle: objective.lifecycle as never,
      freshness,
      presentation: {
        cardId: card?.cardId ?? null,
        cardRevision: card?.cardRevision ?? null,
        publicationRevision: card?.currentPublicationRevision ?? null,
      },
      sourceLabel: card?.sourceLabel ?? null,
    },
    sources: {
      origins,
      primaryNote,
      missingOrigin: origins.length === 0,
    },
    personal: {
      initialValidation,
      activeRun,
      review,
      // TODO(W4 TP-06)：practice trail / last canonical 由方案 16 projection adapter 提供。
      practiceTrailCount: 0,
      lastCanonicalAt: null,
    },
    lifecycle: {
      status: objective.lifecycle as never,
      successorObjectiveId: null,
    },
    primaryAction,
    createdAt: objective.createdAt.toISOString(),
    updatedAt: objective.updatedAt.toISOString(),
  };
}

// ─── list assembler（W2-18 精简：无 N+1 批量 + 稳定 cursor）────────────────

export interface ObjectiveListOptions {
  lifecycle?: "active" | "archived" | "superseded";
  limit: number;
  /** 稳定 cursor：encoded objectiveId（createdAt 排序）。 */
  cursor?: string;
}

export async function listObjectiveSurfacesV3(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  options: ObjectiveListOptions,
): Promise<{ items: LearningObjectiveSurfaceV3[]; total: number; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit, 1), 100);
  const where = and(
    eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
    options.lifecycle ? eq(learningObjectivesV2.lifecycle, options.lifecycle) : undefined,
    options.cursor ? lt(learningObjectivesV2.createdAt, new Date(options.cursor)) : undefined,
  );
  const rows = await tx
    .select({ objectiveId: learningObjectivesV2.objectiveId })
    .from(learningObjectivesV2)
    .where(where)
    .orderBy(desc(learningObjectivesV2.createdAt), desc(learningObjectivesV2.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const items: LearningObjectiveSurfaceV3[] = [];
  for (const row of pageRows) {
    items.push(await assembleObjectiveSurfaceV3(tx, ctx, row.objectiveId));
  }
  const countRows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
      options.lifecycle ? eq(learningObjectivesV2.lifecycle, options.lifecycle) : undefined,
    ));
  const total = Number(countRows[0]?.n ?? 0);
  const nextCursor =
    rows.length > limit && pageRows.length > 0
      ? pageRows[pageRows.length - 1].objectiveId
      : null;
  return { items, total, nextCursor };
}

/** 列表 item（轻量；W3 卡库用）。 */
export function toObjectiveListItemV3(surface: LearningObjectiveSurfaceV3): ObjectiveListItemV3 {
  return {
    objectiveId: surface.objectiveId,
    surfaceRevision: surface.surfaceRevision,
    conceptLabel: surface.content.conceptLabel,
    publicSummary: surface.content.publicSummary,
    knowledgeForm: surface.content.knowledgeForm,
    lifecycle: surface.content.lifecycle,
    freshness: surface.content.freshness,
    primaryNoteTitle: surface.sources.primaryNote?.title ?? null,
    personalState: {
      state: surface.personal.activeRun
        ? "learning"
        : surface.personal.review?.status === "due"
          ? "due_review"
          : surface.personal.initialValidation?.status === "ready"
            ? "unvalidated"
            : surface.content.lifecycle === "archived"
              ? "archived"
              : "stable",
      activeRunId: surface.personal.activeRun?.runId ?? null,
    },
    primaryAction: surface.primaryAction,
  };
}
