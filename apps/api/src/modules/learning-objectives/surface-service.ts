/**
 * Plan 23 W2-09/W2-10/W2-17/W2-18：Objective Surface 装配器。
 *
 * - content：概念标题/公开说明/knowledgeForm/lifecycle/freshness/presentation
 *   （读取 Objective revision 与 active Card，不读 legacy summary）；
 * - sources：Origin 血缘 + 主来源 Note 标题（多来源按 supportGrade 排序）；
 * - personal：initialValidation / activeRun / review / practiceTrailCount /
 *   lastCanonicalAt（全部服务端状态，不靠客户端推断）；
 * - primaryAction：resolvePrimaryActionV3（服务端唯一裁决）。
 * - successorObjectiveId：从 learning_objective_lineage_v2 读取（superseded 场景）。
 *
 * 公共边界：本文件永不输出 canonicalAnswer / rubric / private payload。
 *
 * Bug 1 修复：cursor 原先用 new Date(options.cursor) 解析 objectiveId，类型不匹配。
 * Bug 3 修复：原先逐条调用 assembleObjectiveSurfaceV3 导致 N+1，改为批量加载。
 * Bug 7 修复：practiceTrailCount / lastCanonicalAt 从 outbox 读取（不再硬编码）。
 * Bug 8 修复：successorObjectiveId 从 lineage 表读取（不再硬编码 null）。
 * Bug 9 修复：practiceOnly 从 learning_exposures_v2 读取曝光状态（不再硬编码 false）。
 * Bug 10 修复：detail assembler 中 loadActiveRun 与 runIdRows 查询合并（消除重复查询）。
 *
 * 注意：API 端 schema 中 keyPointId 已移除：
 * - learning_runs 没有 keyPointId 列，严格 V2 origin 直接携带 objectiveId
 * - review_schedules 没有 keyPointId 列，用 subjectType='card' + subjectId=objectiveId
 * - canonical_learning_event_outbox / practice_trail_event_outbox 没有 keyPointId 列，
 *   通过 runId 间接关联（origin alias coalesce 查询，同上）
 */
import { and, eq, asc, inArray, sql, desc } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningCardsV2,
  initialValidationRemindersV2,
  learningObjectiveLineageV2,
  learningObjectiveOriginsV2,
  learningExposuresV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { learningRuns, canonicalLearningEventOutbox, practiceTrailEventOutbox } from "@ailearn/shared/db-schema/learning-runs";
import { notes } from "@ailearn/shared/db-schema/note";
import { visibleNotesCondition, visibleObjectivesCondition } from "../note/visibility.ts";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import type {
  LearningObjectiveSurfaceV3,
  ObjectiveOriginV3,
  ObjectiveListItemV3,
  ObjectivePersonalStateV3,
  KnowledgeFormV2,
  ObjectiveSurfaceLifecycleV3,
} from "@ailearn/shared";
import { DomainError, cardStrategyV2Schema, learningRunOutcomeSchema } from "@ailearn/shared";
import { listOriginsByObjective, rowToWire } from "./origin-service.ts";
import { resolvePrimaryActionV3, type ActionResolverInputV3 } from "./action-resolver.ts";
import { readAnswerModePreference } from "../companion-shell/answer-mode-preference.ts";
import { surfaceQueryDurationSeconds, surfaceSlowQueryTotal } from "../../lib/metrics.ts";

export class ObjectiveNotFoundError extends DomainError {
  constructor(objectiveId: string, workspaceId: string) {
    super({ name: "ObjectiveNotFoundError", code: "objective_not_found", message: "objective " + objectiveId + " not found in workspace " + workspaceId, statusCode: 404 });
  }
}

export interface SurfaceContext {
  workspaceId: string;
  userId: string;
}

type ObjectivePersonalStateInput = {
  readonly lifecycle: ObjectiveSurfaceLifecycleV3;
  readonly freshness: LearningObjectiveSurfaceV3["content"]["freshness"];
  readonly activeRun: LearningObjectiveSurfaceV3["personal"]["activeRun"];
  readonly review: LearningObjectiveSurfaceV3["personal"]["review"];
  readonly lastCanonicalAt: string | null;
};

/** One server-owned precedence table for every Objective projection. */
function resolveObjectivePersonalState(input: ObjectivePersonalStateInput): ObjectivePersonalStateV3 {
  if (input.lifecycle === "archived") return "archived";
  if (input.lifecycle === "superseded") return "superseded";
  if (input.activeRun) return "learning";
  if (input.review?.status === "due") return "due_review";
  if (input.review?.status === "scheduled") return "scheduled";
  if (input.freshness === "source_outdated") return "outdated";
  return input.lastCanonicalAt ? "stable" : "unvalidated";
}

const ACTIVE_RUN_PHASES = [
  "preparing",
  "active",
  "assessing",
  "checkpoint",
  "committing",
  "paused",
] as const;

// ─── 个人状态 loader（W2-11..13）──────────────────────────────────────────

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

async function loadReview(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  objectiveId: string,
): Promise<LearningObjectiveSurfaceV3["personal"]["review"]> {
  // V2：reviewSchedules 没有 keyPointId 列，用 subjectType='card' + subjectId=objectiveId。
  const rows = await tx
    .select()
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.workspaceId, ctx.workspaceId),
      eq(reviewSchedules.userId, ctx.userId),
      eq(reviewSchedules.subjectType, "card"),
      eq(reviewSchedules.subjectId, objectiveId),
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

// ─── exposure / practiceOnly 判定（§7.4 Reveal 语义）─────────────────────

/** §15.2 受控 Reveal exposure kinds（§16.2 只受控 Reveal 污染）。 */
const REVEAL_EXPOSURE_KINDS = ["answer_reveal", "evidence_reveal", "answer_editor_view"] as const;

interface ExposureInfo {
  practiceOnly: boolean;
  reasonCodes: string[];
}

/**
 * Bug 9 修复：从 learning_exposures_v2 读取曝光状态判定 practiceOnly。
 *
 * §7.4 Reveal 语义：用户"查看参考内容"后，服务端先持久化 Exposure 到
 * learning_exposures_v2（exposureKind = 'answer_reveal' 等），然后返回答案。
 * 如果存在受控 Reveal exposure 记录，则 practiceOnly = true，
 * 主行动从 "开始首次验证" 变为 "带着参考内容练一下"（practice_only）。
 *
 * 客户端不得自行决定 Trust（§7.4 第 5 条）。
 */
async function loadExposureInfo(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  objectiveId: string,
): Promise<ExposureInfo> {
  const rows = await tx
    .select({ exposureKind: learningExposuresV2.exposureKind })
    .from(learningExposuresV2)
    .where(and(
      eq(learningExposuresV2.workspaceId, ctx.workspaceId),
      eq(learningExposuresV2.userId, ctx.userId),
      eq(learningExposuresV2.objectiveId, objectiveId),
      inArray(learningExposuresV2.exposureKind, [...REVEAL_EXPOSURE_KINDS]),
    ))
    .limit(1);
  const hasRevealExposure = rows.length > 0;
  return {
    practiceOnly: hasRevealExposure,
    reasonCodes: hasRevealExposure ? ["exposed"] : [],
  };
}

// ─── freshness（W2-08：note 新版本 → source_outdated）────────────────────

async function computeFreshness(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  origins: ObjectiveOriginV3[],
): Promise<"fresh" | "source_outdated" | "legacy_unreviewed"> {
  const noteOrigins = origins.filter((o) => o.kind === "note");
  if (noteOrigins.length === 0) {
    return origins.length === 0 ? "legacy_unreviewed" : "fresh";
  }
  const noteIds = [
    ...new Set(
      noteOrigins
        .map((o) => (o.kind === "note" ? o.noteId : null))
        .filter((id): id is string => id !== null),
    ),
  ];
  if (noteIds.length === 0) return "fresh";
  const noteRows = await tx
    .select({ id: notes.id, currentVersionId: notes.currentVersionId })
    .from(notes)
    .where(and(
      eq(notes.workspaceId, ctx.workspaceId),
      visibleNotesCondition(ctx.userId),
      inArray(notes.id, noteIds),
    ));
  const currentByNote = new Map(noteRows.map((n) => [n.id, n.currentVersionId]));
  // 修复：origin.noteVersionId 为 null 时（手动迁移/早期数据），
  // 无法做版本比较，不应误判为 source_outdated。只有当 origin 有明确
  // noteVersionId 且与当前版本不一致时才标记 outdated。
  const outdated = noteOrigins.some(
    (o) =>
      o.kind === "note" &&
      o.noteVersionId !== null &&
      currentByNote.get(o.noteId) !== null &&
      currentByNote.get(o.noteId) !== undefined &&
      currentByNote.get(o.noteId) !== o.noteVersionId,
  );
  return outdated ? "source_outdated" : "fresh";
}

// ─── RL-09 指标：surface 装配耗时计时 ──────────────────────────────────────

function withSurfaceTimer<T>(queryType: "detail" | "list", fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  return fn().finally(() => {
    const elapsedSec = (Date.now() - start) / 1000;
    surfaceQueryDurationSeconds.observe({ query_type: queryType }, elapsedSec);
    // RL-09 P0：超过 1s 阈值记慢查询告警
    if (elapsedSec > 1) {
      surfaceSlowQueryTotal.inc({ query_type: queryType });
    }
  });
}

// ─── detail assembler（W2-17）────────────────────────────────────────────

export function assembleObjectiveSurfaceV3(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  objectiveId: string,
): Promise<LearningObjectiveSurfaceV3> {
  return withSurfaceTimer("detail", () => assembleObjectiveSurfaceV3Inner(tx, ctx, objectiveId));
}

async function assembleObjectiveSurfaceV3Inner(
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
      visibleObjectivesCondition(ctx.userId, learningObjectivesV2.objectiveId),
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
          visibleObjectivesCondition(ctx.userId, learningObjectiveRevisionsV2.objectiveId),
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
        .map((o) => (o.kind === "note" ? o.noteId : null))
        .filter((id): id is string => id !== null),
    ),
  ];
  let primaryNote: LearningObjectiveSurfaceV3["sources"]["primaryNote"] = null;
  if (noteIds.length > 0) {
    const noteRows = await tx
      .select({ id: notes.id, title: notes.title, currentVersionId: notes.currentVersionId })
      .from(notes)
      .where(and(
        eq(notes.workspaceId, ctx.workspaceId),
        visibleNotesCondition(ctx.userId),
        inArray(notes.id, noteIds),
      ));
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

  // Bug 10 修复：loadActiveRun 查询的活跃 run 是 runIdRows 的子集。
  // 合并为一次查询：先查该 objective 的所有 runs（含 phase + origin），
  // 在内存中同时提取 activeRun 和 runId 列表。
  const allRunRows = await tx
    .select({
      runId: learningRuns.id,
      phase: learningRuns.phase,
      createdAt: learningRuns.createdAt,
    })
    .from(learningRuns)
    .where(and(
      eq(learningRuns.workspaceId, ctx.workspaceId),
      eq(learningRuns.userId, ctx.userId),
      sql`${learningRuns.origin}->>'objectiveId' = ${objectiveId}`,
    ))
    .orderBy(desc(learningRuns.createdAt));
  const activeRunRow = allRunRows.find((r) =>
    (ACTIVE_RUN_PHASES as readonly string[]).includes(r.phase));
  const activeRun = activeRunRow
    ? { runId: activeRunRow.runId, phase: activeRunRow.phase }
    : null;
  const latestResultRows = await tx
    .select({
      runId: learningRuns.id,
      outcome: sql<string>`${learningRuns.result}->>'outcome'`,
      completedAt: learningRuns.updatedAt,
    })
    .from(learningRuns)
    .where(and(
      eq(learningRuns.workspaceId, ctx.workspaceId),
      eq(learningRuns.userId, ctx.userId),
      sql`${learningRuns.origin}->>'objectiveId' = ${objectiveId}`,
      sql`${learningRuns.result} IS NOT NULL`,
    ))
    .orderBy(desc(learningRuns.updatedAt))
    .limit(1);
  const lastCompletedRun = latestResultRows[0];
  const lastOutcome = learningRunOutcomeSchema.safeParse(lastCompletedRun?.outcome);
  const latestResult = lastCompletedRun && lastOutcome.success
    ? { runId: lastCompletedRun.runId, completedAt: lastCompletedRun.completedAt.toISOString(), outcome: lastOutcome.data }
    : null;

  const [initialValidation, review, exposureInfo] = await Promise.all([
    loadInitialValidation(tx, ctx, objectiveId),
    loadReview(tx, ctx, objectiveId),
    loadExposureInfo(tx, ctx, objectiveId),
  ]);

  // Bug 8 修复：从 lineage 表读取 successor 信息（superseded → view_successor）
  let successorObjectiveId: string | null = null;
  let successorCardId: string | null = null;
  if (objective.lifecycle === "superseded" && objective.currentObjectiveRevisionId) {
    const lineageRows = await tx
      .select()
      .from(learningObjectiveLineageV2)
      .where(and(
        eq(learningObjectiveLineageV2.workspaceId, ctx.workspaceId),
        eq(learningObjectiveLineageV2.predecessorRevisionId, objective.currentObjectiveRevisionId),
        eq(learningObjectiveLineageV2.relation, "supersedes"),
      ))
      .limit(1);
    if (lineageRows[0]) {
      const successorRevisionRows = await tx
        .select({ objectiveId: learningObjectiveRevisionsV2.objectiveId })
        .from(learningObjectiveRevisionsV2)
        .where(and(
          eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
          eq(learningObjectiveRevisionsV2.objectiveRevisionId, lineageRows[0].successorRevisionId),
          visibleObjectivesCondition(ctx.userId, learningObjectiveRevisionsV2.objectiveId),
        ))
        .limit(1);
      if (successorRevisionRows[0]) {
        successorObjectiveId = successorRevisionRows[0].objectiveId;
        const successorCardRows = await tx
          .select({ cardId: learningCardsV2.cardId })
          .from(learningCardsV2)
          .where(and(
            eq(learningCardsV2.workspaceId, ctx.workspaceId),
            eq(learningCardsV2.objectiveId, successorObjectiveId),
            eq(learningCardsV2.lifecycle, "active"),
          ))
          .limit(1);
        successorCardId = successorCardRows[0]?.cardId ?? null;
      }
    }
  }

  // Bug 7 修复：从 outbox 读取 practice trail 和 last canonical
  // outbox 没有 keyPointId 列，通过 runId 间接关联。
  // Bug 10 修复：runIds 已从上面的合并查询获得，不再重复查询。
  let practiceTrailCount = 0;
  let lastCanonicalAt: string | null = null;

  /**
   * Bug 7 / Bug 10 的继续收口（0269 轮 M32）：以前是把这篇目标**历史上所有** run 的 id
   * 收成数组，再喂给两个 `inArray`。那个 id 列表随练习次数线性增长，详情页每打开一次就
   * 重造一次、两条查询各带一遍参数，而结果只要"一个计数 + 一个时间戳"。
   *
   * 改成经 `learning_runs` 直接 join：`origin->>'objectiveId'` 有表达式索引（0222），
   * 两张 outbox 各自有以 run_id 可用开头的索引，join 方向是"这篇目标的少量 run → 探 outbox"。
   * 两条标量子查询合成**一次**往返。原来的 `runIds.length > 0` 门一起去掉——没有 run 时
   * 两条子查询自然给 null / 0，与旧路径同结果。
   */
  const trailRows = await tx.execute(sql`
    SELECT
      (
        SELECT o.created_at
        FROM public.canonical_learning_event_outbox o
        JOIN public.learning_runs cr
          ON cr.id = o.run_id
         AND cr.workspace_id = o.workspace_id
         AND cr.user_id = o.user_id
        WHERE cr.workspace_id = ${ctx.workspaceId}::uuid
          AND cr.user_id = ${ctx.userId}::uuid
          AND cr.origin ->> 'objectiveId' = ${objectiveId}
          AND o.workspace_id = ${ctx.workspaceId}::uuid
          AND o.user_id = ${ctx.userId}::uuid
          AND o.status = 'published'
        ORDER BY o.created_at DESC
        LIMIT 1
      ) AS last_canonical_at,
      (
        SELECT count(*)::int
        FROM public.practice_trail_event_outbox p
        JOIN public.learning_runs pr
          ON pr.id = p.run_id
         AND pr.workspace_id = p.workspace_id
         AND pr.user_id = p.user_id
        WHERE pr.workspace_id = ${ctx.workspaceId}::uuid
          AND pr.user_id = ${ctx.userId}::uuid
          AND pr.origin ->> 'objectiveId' = ${objectiveId}
          AND p.workspace_id = ${ctx.workspaceId}::uuid
          AND p.user_id = ${ctx.userId}::uuid
          AND p.status = 'published'
      ) AS practice_count
  `);
  const trail = (trailRows[0] ?? {}) as Record<string, unknown>;
  const lastCanonicalRaw = trail.last_canonical_at;
  if (lastCanonicalRaw instanceof Date) {
    lastCanonicalAt = lastCanonicalRaw.toISOString();
  } else if (typeof lastCanonicalRaw === "string" && lastCanonicalRaw.length > 0) {
    lastCanonicalAt = new Date(lastCanonicalRaw).toISOString();
  }
  practiceTrailCount = Number(trail.practice_count ?? 0);

  // 账号「作答方式」偏好：详情页只有这一个目标，就地读一次。这里**不**调用
  // `getAnswerModePreference`——它会在这条已经开着的事务里再开一个事务。
  const { preference: answerModePreference } = await readAnswerModePreference(tx, ctx.userId);

  const actionInput: ActionResolverInputV3 = {
    objectiveId,
    lifecycle: objective.lifecycle as ActionResolverInputV3["lifecycle"],
    successorObjectiveId,
    successorCardId,
    hasActiveCard: Boolean(card),
    cardId: card?.cardId ?? null,
    activeRun,
    hasPriorFormalResult: lastCanonicalAt !== null,
    reviewDue: review?.status === "due" ? { scheduleId: review.scheduleId, generation: review.generation } : null,
    initialReady: initialValidation?.status === "ready"
      ? { reminderId: initialValidation.reminderId, qualificationNotBefore: initialValidation.qualificationNotBefore ?? new Date(0).toISOString() }
      : null,
    initialDeferred: initialValidation?.status === "deferred"
      ? { reminderId: initialValidation.reminderId, qualificationNotBefore: initialValidation.qualificationNotBefore ?? new Date(0).toISOString() }
      : null,
    practiceOnly: exposureInfo.practiceOnly,
    practiceReasonCodes: exposureInfo.reasonCodes,
    answerModePreference,
  };
  const primaryAction = resolvePrimaryActionV3(actionInput);
  const personalState = {
    state: resolveObjectivePersonalState({
      lifecycle: objective.lifecycle as ObjectiveSurfaceLifecycleV3,
      freshness,
      activeRun,
      review,
      lastCanonicalAt,
    }),
    activeRunId: activeRun?.runId ?? null,
  };

  return {
    version: 3,
    objectiveId,
    surfaceRevision: objective.surfaceRevision,
    lifecycleEpoch: objective.lifecycleEpoch,
    content: {
      conceptLabel: revision?.conceptLabel ?? null,
      publicSummary: revision?.publicSummary ?? "",
      knowledgeForm: (revision?.knowledgeForm ?? "fact") as KnowledgeFormV2,
      cardStrategy: card ? cardStrategyV2Schema.parse(card.strategy) : null,
      lifecycle: objective.lifecycle as ObjectiveSurfaceLifecycleV3,
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
      practiceTrailCount,
      lastCanonicalAt,
      latestResult,
    },
    lifecycle: {
      status: objective.lifecycle as ObjectiveSurfaceLifecycleV3,
      successorObjectiveId,
    },
    personalState,
    primaryAction,
    createdAt: objective.createdAt.toISOString(),
    updatedAt: objective.updatedAt.toISOString(),
  };
}

// ─── list assembler（W2-18：批量加载无 N+1 + 稳定 cursor）────────────────

export interface ObjectiveListOptions {
  lifecycle?: "active" | "archived" | "superseded";
  limit: number;
  /** 稳定 cursor：上一页最后一条的 objectiveId。 */
  cursor?: string;
}

/** 辅助：查 cursor 对应的 objective 行（用于 cursor-based 分页的 WHERE 条件）。 */
async function getCursorRow(
  tx: ApiTransaction,
  workspaceId: string,
  cursorObjectiveId: string,
): Promise<{ createdAt: Date; id: string } | null> {
  const rows = await tx
    .select({ createdAt: learningObjectivesV2.createdAt, id: learningObjectivesV2.id })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, workspaceId),
      eq(learningObjectivesV2.objectiveId, cursorObjectiveId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

export async function listObjectiveSurfacesV3(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  options: ObjectiveListOptions,
): Promise<{ items: LearningObjectiveSurfaceV3[]; total: number; nextCursor: string | null }> {
  return withSurfaceTimer("list", () => listObjectiveSurfacesV3Inner(tx, ctx, options));
}

async function listObjectiveSurfacesV3Inner(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  options: ObjectiveListOptions,
): Promise<{ items: LearningObjectiveSurfaceV3[]; total: number; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit, 1), 100);
  const lifecycle = options.lifecycle ?? "active";

  // Bug 1 修复：cursor 是 objectiveId，先查到对应的 (createdAt, id)，再做稳定分页。
  let cursorCondition = undefined;
  if (options.cursor) {
    const cursorRow = await getCursorRow(tx, ctx.workspaceId, options.cursor);
    if (cursorRow) {
      cursorCondition = sql`(${learningObjectivesV2.createdAt} < ${cursorRow.createdAt}
        OR (${learningObjectivesV2.createdAt} = ${cursorRow.createdAt}
          AND ${learningObjectivesV2.id} < ${cursorRow.id}))`;
    }
  }

  // 修复：list 查询和 count 查询并行执行，减少总延迟，
  // 同时在同一事务 snapshot 下保证一致性（PostgreSQL 事务内多次读看到同一 snapshot）。
  const where = and(
    eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
    eq(learningObjectivesV2.lifecycle, lifecycle),
    cursorCondition ?? undefined,
  );
  // 列表项必须和详情页共享同一个不变量：currentObjectiveRevisionId
  // 必须指向当前 workspace、当前 objective 的真实 revision。历史清理或
  // 旧 seed 可能留下孤儿 projection；如果把它们列出，用户点击后只会
  // 得到“目标不存在”，形成一个产品层面的死链接。
  const validCurrentRevision = and(
    eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
    eq(learningObjectiveRevisionsV2.objectiveId, learningObjectivesV2.objectiveId),
    eq(learningObjectiveRevisionsV2.objectiveRevisionId, learningObjectivesV2.currentObjectiveRevisionId),
  );
  const [rows, countRows] = await Promise.all([
    tx
      .select({
        objectiveId: learningObjectivesV2.objectiveId,
        id: learningObjectivesV2.id,
        createdAt: learningObjectivesV2.createdAt,
        currentObjectiveRevisionId: learningObjectivesV2.currentObjectiveRevisionId,
        lifecycleEpoch: learningObjectivesV2.lifecycleEpoch,
        surfaceRevision: learningObjectivesV2.surfaceRevision,
        updatedAt: learningObjectivesV2.updatedAt,
      })
      .from(learningObjectivesV2)
      .innerJoin(learningObjectiveRevisionsV2, validCurrentRevision)
      // 可见性判据写在两条查询各自身上，不塞进上面的 `where` 常量：那条离这两处
      // 都太远，"每个读点就近带判据"那条棘轮按局部窗口判，塞进常量等于把它藏起来。
      .where(and(where, visibleObjectivesCondition(ctx.userId, learningObjectivesV2.objectiveId)))
      .orderBy(desc(learningObjectivesV2.createdAt), desc(learningObjectivesV2.id))
      .limit(limit + 1),
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(learningObjectivesV2)
      .innerJoin(learningObjectiveRevisionsV2, validCurrentRevision)
      .where(and(
        eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
        eq(learningObjectivesV2.lifecycle, lifecycle),
        visibleObjectivesCondition(ctx.userId, learningObjectivesV2.objectiveId),
      )),
  ]);
  const pageRows = rows.slice(0, limit);
  const objectiveIds = pageRows.map((r) => r.objectiveId);

  const items = objectiveIds.length > 0
    ? await batchAssembleObjectiveSurfacesV3(tx, ctx, objectiveIds, pageRows)
    : [];

  const total = Number(countRows[0]?.n ?? 0);
  const nextCursor =
    rows.length > limit && pageRows.length > 0
      ? pageRows[pageRows.length - 1].objectiveId
      : null;
  return { items, total, nextCursor };
}

/**
 * 批量装配多个 Objective Surface（消除 N+1）。
 * 一次查所有 objective 的 revision/card/origin/note/initialValidation/activeRun/review/
 * canonicalEvent/practiceTrail/lineage，然后在内存中组装。
 */
async function batchAssembleObjectiveSurfacesV3(
  tx: ApiTransaction,
  ctx: SurfaceContext,
  objectiveIds: string[],
  objectiveRows: Array<{
    objectiveId: string;
    id: string;
    createdAt: Date;
    currentObjectiveRevisionId: string | null;
    lifecycleEpoch: number;
    surfaceRevision: number;
    updatedAt: Date;
  }>,
): Promise<LearningObjectiveSurfaceV3[]> {

  // 1. 批量查完整 objective 行（含 lifecycle 字段，用于 successor 判断）
  const fullObjectiveRows = await tx
    .select()
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
      inArray(learningObjectivesV2.objectiveId, objectiveIds),
      visibleObjectivesCondition(ctx.userId, learningObjectivesV2.objectiveId),
    ));
  const fullObjectiveByMap = new Map(fullObjectiveRows.map((r) => [r.objectiveId, r]));

  // 2. 批量查 revisions
  const revisionIds = objectiveRows
    .map((r) => r.currentObjectiveRevisionId)
    .filter(Boolean) as string[];
  const revisionRows = revisionIds.length > 0
    ? await tx
        .select()
        .from(learningObjectiveRevisionsV2)
        .where(and(
          eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
          inArray(learningObjectiveRevisionsV2.objectiveRevisionId, revisionIds),
          visibleObjectivesCondition(ctx.userId, learningObjectiveRevisionsV2.objectiveId),
        ))
    : [];
  const revisionByObjective = new Map(
    revisionRows.map((r) => [r.objectiveId, r]),
  );

  // 3. 批量查 active cards
  const cardRows = objectiveIds.length > 0
    ? await tx
        .select()
        .from(learningCardsV2)
        .where(and(
          eq(learningCardsV2.workspaceId, ctx.workspaceId),
          inArray(learningCardsV2.objectiveId, objectiveIds),
          eq(learningCardsV2.lifecycle, "active"),
        ))
    : [];
  const cardByObjective = new Map(cardRows.map((c) => [c.objectiveId, c]));

  // 4. 批量查 origins（直接从表查，再用 rowToOriginWire 转换）
  const allOriginRows = objectiveIds.length > 0
    ? await tx
        .select()
        .from(learningObjectiveOriginsV2)
        .where(and(
          eq(learningObjectiveOriginsV2.workspaceId, ctx.workspaceId),
          inArray(learningObjectiveOriginsV2.objectiveId, objectiveIds),
        ))
        .orderBy(asc(learningObjectiveOriginsV2.boundAt), asc(learningObjectiveOriginsV2.id))
    : [];
  const originsByObjective = new Map<string, ObjectiveOriginV3[]>();
  for (const row of allOriginRows) {
    const list = originsByObjective.get(row.objectiveId) ?? [];
    list.push(rowToWire(row));
    originsByObjective.set(row.objectiveId, list);
  }

  // 5. 批量查 note titles
  const noteIds = [...new Set(
    allOriginRows
      .filter((o) => o.originKind === "note" && o.noteId)
      .map((o) => o.noteId!)
  )];
  const noteRows = noteIds.length > 0
    ? await tx
        .select({ id: notes.id, title: notes.title, currentVersionId: notes.currentVersionId })
        .from(notes)
        // 详情页(:313)与批量页(这里)必须是同一条判据，否则"列表里没有、点进去有标题"。
        .where(and(
          eq(notes.workspaceId, ctx.workspaceId),
          visibleNotesCondition(ctx.userId),
          inArray(notes.id, noteIds),
        ))
    : [];
  const noteById = new Map(noteRows.map((n) => [n.id, n]));

  // 6. 批量查 initial validation reminders
  const ivRows = objectiveIds.length > 0
    ? await tx
        .select()
        .from(initialValidationRemindersV2)
        .where(and(
          eq(initialValidationRemindersV2.workspaceId, ctx.workspaceId),
          eq(initialValidationRemindersV2.userId, ctx.userId),
          inArray(initialValidationRemindersV2.objectiveId, objectiveIds),
          inArray(initialValidationRemindersV2.status, ["pending", "ready"]),
        ))
        .orderBy(desc(initialValidationRemindersV2.updatedAt))
    : [];
  const ivByObjective = new Map<string, typeof ivRows[0]>();
  for (const row of ivRows) {
    if (!ivByObjective.has(row.objectiveId)) {
      ivByObjective.set(row.objectiveId, row);
    }
  }

  // 7. 批量查 all runs（按 origin.objectiveId 查询）
  // 性能修复：原先查该用户全量 runs 再在内存中过滤，当用户有大量历史
  // runs 时会严重退化。按严格 V2 origin 的 objectiveId 直接筛选。
  // IN (...) 限定到目标 objectiveIds，只查相关 runs。
  // 安全：objectiveIds 作为 Drizzle sql 参数绑定（非 sql.raw 拼接），无注入风险。
  const objectiveIdSet = new Set(objectiveIds);
  const allRunRows = objectiveIds.length > 0
    ? await tx
        .select({
          runId: learningRuns.id,
          phase: learningRuns.phase,
          origin: learningRuns.origin,
          createdAt: learningRuns.createdAt,
        })
        .from(learningRuns)
        .where(and(
          eq(learningRuns.workspaceId, ctx.workspaceId),
          eq(learningRuns.userId, ctx.userId),
          // Keep each objective id as a bound scalar. Interpolating the JS
          // array directly into ANY(...::text[]) breaks with postgres-js.
          sql`${learningRuns.origin}->>'objectiveId' IN (${sql.join(objectiveIds.map((id) => sql`${id}`), sql`, `)})`,
        ))
        .orderBy(desc(learningRuns.createdAt))
    : [];
  // 从 all runs 中同时提取 activeRun 映射和 allRunIds 列表
  const runByObjective = new Map<string, { runId: string; phase: string }>();
  const allRunIds: string[] = [];
  const runIdToObjective = new Map<string, string>();
  for (const run of allRunRows) {
    const origin = run.origin as Record<string, unknown> | null;
    const originObjectiveId = origin?.objectiveId as string | undefined;
    if (originObjectiveId && objectiveIdSet.has(originObjectiveId)) {
      allRunIds.push(run.runId);
      runIdToObjective.set(run.runId, originObjectiveId);
      // activeRun = 第一个匹配的 active-phase run（allRunRows 已按 createdAt DESC 排序）
      if ((ACTIVE_RUN_PHASES as readonly string[]).includes(run.phase) && !runByObjective.has(originObjectiveId)) {
        runByObjective.set(originObjectiveId, { runId: run.runId, phase: run.phase });
      }
    }
  }

  // 8. 批量查 review schedules（subjectType='card', subjectId=objectiveId）
  const scheduleRows = objectiveIds.length > 0
    ? await tx
        .select()
        .from(reviewSchedules)
        .where(and(
          eq(reviewSchedules.workspaceId, ctx.workspaceId),
          eq(reviewSchedules.userId, ctx.userId),
          eq(reviewSchedules.subjectType, "card"),
          inArray(reviewSchedules.subjectId, objectiveIds),
          eq(reviewSchedules.status, "pending"),
        ))
        .orderBy(asc(reviewSchedules.nextReviewAt))
    : [];
  const scheduleByObjective = new Map<string, typeof scheduleRows[0]>();
  for (const s of scheduleRows) {
    if (!scheduleByObjective.has(s.subjectId)) {
      scheduleByObjective.set(s.subjectId, s);
    }
  }

  // 9. 批量查 canonical events + practice trail counts（通过 runId 间接关联）
  // allRunIds 和 runIdToObjective 已在 step 7 中构建。
  const lastCanonicalByObjective = new Map<string, string>();
  const practiceCountByObjective = new Map<string, number>();

  if (allRunIds.length > 0) {
    const [canonicalRows, practiceRows] = await Promise.all([
      tx
        .select({
          runId: canonicalLearningEventOutbox.runId,
          createdAt: canonicalLearningEventOutbox.createdAt,
        })
        .from(canonicalLearningEventOutbox)
        .where(and(
          eq(canonicalLearningEventOutbox.workspaceId, ctx.workspaceId),
          eq(canonicalLearningEventOutbox.userId, ctx.userId),
          inArray(canonicalLearningEventOutbox.runId, allRunIds),
          eq(canonicalLearningEventOutbox.status, "published"),
        ))
        .orderBy(desc(canonicalLearningEventOutbox.createdAt)),
      tx
        .select({
          runId: practiceTrailEventOutbox.runId,
          n: sql<number>`count(*)::int`,
        })
        .from(practiceTrailEventOutbox)
        .where(and(
          eq(practiceTrailEventOutbox.workspaceId, ctx.workspaceId),
          eq(practiceTrailEventOutbox.userId, ctx.userId),
          inArray(practiceTrailEventOutbox.runId, allRunIds),
          eq(practiceTrailEventOutbox.status, "published"),
        ))
        .groupBy(practiceTrailEventOutbox.runId),
    ]);

    for (const row of canonicalRows) {
      const objId = runIdToObjective.get(row.runId);
      if (objId && !lastCanonicalByObjective.has(objId)) {
        lastCanonicalByObjective.set(objId, row.createdAt.toISOString());
      }
    }
    for (const row of practiceRows) {
      const objId = runIdToObjective.get(row.runId);
      if (objId) {
        practiceCountByObjective.set(objId, (practiceCountByObjective.get(objId) ?? 0) + Number(row.n));
      }
    }
  }

  // 10. 批量查 lineage（superseded → successor）
  const allRevisionIds = objectiveRows
    .map((r) => r.currentObjectiveRevisionId)
    .filter(Boolean) as string[];
  const lineageRows = allRevisionIds.length > 0
    ? await tx
        .select()
        .from(learningObjectiveLineageV2)
        .where(and(
          eq(learningObjectiveLineageV2.workspaceId, ctx.workspaceId),
          inArray(learningObjectiveLineageV2.predecessorRevisionId, allRevisionIds),
          eq(learningObjectiveLineageV2.relation, "supersedes"),
        ))
    : [];
  const successorByRevision = new Map<string, string>();
  for (const lin of lineageRows) {
    successorByRevision.set(lin.predecessorRevisionId, lin.successorRevisionId);
  }
  const successorRevisionIds = [...new Set(lineageRows.map((l) => l.successorRevisionId))];
  const successorRevisionRows = successorRevisionIds.length > 0
    ? await tx
        .select({
          objectiveRevisionId: learningObjectiveRevisionsV2.objectiveRevisionId,
          objectiveId: learningObjectiveRevisionsV2.objectiveId,
        })
        .from(learningObjectiveRevisionsV2)
        .where(and(
          eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
          inArray(learningObjectiveRevisionsV2.objectiveRevisionId, successorRevisionIds),
          visibleObjectivesCondition(ctx.userId, learningObjectiveRevisionsV2.objectiveId),
        ))
    : [];
  const successorObjByRevision = new Map(successorRevisionRows.map((r) => [r.objectiveRevisionId, r.objectiveId]));
  const successorObjIds = [...new Set(successorRevisionRows.map((r) => r.objectiveId))];
  const successorCardRows = successorObjIds.length > 0
    ? await tx
        .select({ objectiveId: learningCardsV2.objectiveId, cardId: learningCardsV2.cardId })
        .from(learningCardsV2)
        .where(and(
          eq(learningCardsV2.workspaceId, ctx.workspaceId),
          inArray(learningCardsV2.objectiveId, successorObjIds),
          eq(learningCardsV2.lifecycle, "active"),
        ))
    : [];
  const cardByObjectiveForSuccessor = new Map(successorCardRows.map((c) => [c.objectiveId, c.cardId]));

  // 10.5 批量查 exposure（practiceOnly 判定；§7.4 Reveal 语义）
  const exposureRows = objectiveIds.length > 0
    ? await tx
        .select({ objectiveId: learningExposuresV2.objectiveId })
        .from(learningExposuresV2)
        .where(and(
          eq(learningExposuresV2.workspaceId, ctx.workspaceId),
          eq(learningExposuresV2.userId, ctx.userId),
          inArray(learningExposuresV2.objectiveId, objectiveIds),
          inArray(learningExposuresV2.exposureKind, [...REVEAL_EXPOSURE_KINDS]),
        ))
        .groupBy(learningExposuresV2.objectiveId)
    : [];
  const exposedObjectives = new Set(exposureRows.map((r) => r.objectiveId));

  // 10.6 账号「作答方式」偏好：**循环外读一次**。列表页几十个目标共用同一个
  // 值，逐目标读就是 doc 34 L15 批评的那种「接线接成了 N+1」。
  const { preference: answerModePreference } = await readAnswerModePreference(tx, ctx.userId);

  // 11. 装配 Surface（内存组装，不再查 DB）
  const now = new Date();
  const results: LearningObjectiveSurfaceV3[] = [];

  for (const objRow of objectiveRows) {
    const objectiveId = objRow.objectiveId;
    const fullObjective = fullObjectiveByMap.get(objectiveId);
    const lifecycle = (fullObjective?.lifecycle ?? "active") as "active" | "archived" | "superseded";
    const revision = revisionByObjective.get(objectiveId);
    const card = cardByObjective.get(objectiveId);
    const origins = originsByObjective.get(objectiveId) ?? [];

    // primaryNote
    let primaryNote: LearningObjectiveSurfaceV3["sources"]["primaryNote"] = null;
    const noteOrigin = origins.find((o) => o.kind === "note" && o.supportGrade === "primary")
      ?? origins.find((o) => o.kind === "note");
    if (noteOrigin && noteOrigin.kind === "note") {
      const noteRow = noteById.get(noteOrigin.noteId);
      if (noteRow) {
        primaryNote = {
          noteId: noteOrigin.noteId,
          noteVersionId: noteOrigin.noteVersionId,
          title: noteRow.title,
        };
      }
    }

    // freshness
    let freshness: "fresh" | "source_outdated" | "legacy_unreviewed" = "fresh";
    const noteOrigins = origins.filter((o) => o.kind === "note");
    if (noteOrigins.length === 0) {
      freshness = origins.length === 0 ? "legacy_unreviewed" : "fresh";
    } else {
      const outdated = noteOrigins.some((o) => {
        if (o.kind !== "note") return false;
        // 修复：origin.noteVersionId 为 null 时不参与版本比较（同 computeFreshness）。
        if (o.noteVersionId === null) return false;
        const noteRow = noteById.get(o.noteId);
        return noteRow && noteRow.currentVersionId !== null
          && noteRow.currentVersionId !== undefined
          && noteRow.currentVersionId !== o.noteVersionId;
      });
      freshness = outdated ? "source_outdated" : "fresh";
    }

    // personal states
    const ivRow = ivByObjective.get(objectiveId);
    let initialValidation: LearningObjectiveSurfaceV3["personal"]["initialValidation"] = null;
    if (ivRow) {
      const notBefore = ivRow.qualificationNotBefore;
      const ready = ivRow.status === "ready" || (ivRow.status === "pending" && notBefore.getTime() <= now.getTime());
      initialValidation = {
        reminderId: ivRow.reminderId,
        status: ready ? "ready" : "deferred",
        qualificationNotBefore: notBefore.toISOString(),
      };
    }
    const activeRun = runByObjective.get(objectiveId) ?? null;
    const schedRow = scheduleByObjective.get(objectiveId);
    let review: LearningObjectiveSurfaceV3["personal"]["review"] = null;
    if (schedRow) {
      const due = schedRow.nextReviewAt.getTime() <= now.getTime();
      review = {
        status: due ? "due" : "scheduled",
        scheduleId: schedRow.id,
        generation: schedRow.generation,
        dueAt: schedRow.nextReviewAt.toISOString(),
      };
    }

    // successor
    let successorObjectiveId: string | null = null;
    let successorCardId: string | null = null;
    if (objRow.currentObjectiveRevisionId) {
      const successorRevisionId = successorByRevision.get(objRow.currentObjectiveRevisionId);
      if (successorRevisionId) {
        successorObjectiveId = successorObjByRevision.get(successorRevisionId) ?? null;
        if (successorObjectiveId) {
          successorCardId = cardByObjectiveForSuccessor.get(successorObjectiveId) ?? null;
        }
      }
    }

    const practiceTrailCount = practiceCountByObjective.get(objectiveId) ?? 0;
    const lastCanonicalAt = lastCanonicalByObjective.get(objectiveId) ?? null;

    const actionInput: ActionResolverInputV3 = {
      objectiveId,
      lifecycle,
      successorObjectiveId,
      successorCardId,
      hasActiveCard: Boolean(card),
      cardId: card?.cardId ?? null,
      activeRun,
      hasPriorFormalResult: lastCanonicalAt !== null,
      reviewDue: review?.status === "due" ? { scheduleId: review.scheduleId, generation: review.generation } : null,
      initialReady: initialValidation?.status === "ready"
        ? { reminderId: initialValidation.reminderId, qualificationNotBefore: initialValidation.qualificationNotBefore ?? new Date(0).toISOString() }
        : null,
      initialDeferred: initialValidation?.status === "deferred"
        ? { reminderId: initialValidation.reminderId, qualificationNotBefore: initialValidation.qualificationNotBefore ?? new Date(0).toISOString() }
        : null,
      practiceOnly: exposedObjectives.has(objectiveId),
      practiceReasonCodes: exposedObjectives.has(objectiveId) ? ["exposed"] : [],
      answerModePreference,
    };
    const primaryAction = resolvePrimaryActionV3(actionInput);
    const personalState = {
      state: resolveObjectivePersonalState({
        lifecycle: lifecycle as ObjectiveSurfaceLifecycleV3,
        freshness,
        activeRun,
        review,
        lastCanonicalAt,
      }),
      activeRunId: activeRun?.runId ?? null,
    };

    results.push({
      version: 3,
      objectiveId,
      surfaceRevision: objRow.surfaceRevision,
      lifecycleEpoch: fullObjective?.lifecycleEpoch ?? 1,
      content: {
        conceptLabel: revision?.conceptLabel ?? null,
        publicSummary: revision?.publicSummary ?? "",
        knowledgeForm: (revision?.knowledgeForm ?? "fact") as KnowledgeFormV2,
        cardStrategy: card ? cardStrategyV2Schema.parse(card.strategy) : null,
        lifecycle: lifecycle as ObjectiveSurfaceLifecycleV3,
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
        practiceTrailCount,
        lastCanonicalAt,
      },
      lifecycle: {
        status: lifecycle as ObjectiveSurfaceLifecycleV3,
        successorObjectiveId,
      },
      personalState,
      primaryAction,
      createdAt: objRow.createdAt.toISOString(),
      updatedAt: objRow.updatedAt.toISOString(),
    });
  }

  return results;
}

/** 列表 item（轻量；W3 卡库用）。 */
export function toObjectiveListItemV3(surface: LearningObjectiveSurfaceV3): ObjectiveListItemV3 {
  return {
    objectiveId: surface.objectiveId,
    surfaceRevision: surface.surfaceRevision,
    conceptLabel: surface.content.conceptLabel,
    publicSummary: surface.content.publicSummary,
    knowledgeForm: surface.content.knowledgeForm,
    cardStrategy: surface.content.cardStrategy,
    lifecycle: surface.content.lifecycle,
    freshness: surface.content.freshness,
    primaryNoteTitle: surface.sources.primaryNote?.title ?? null,
    createdAt: surface.createdAt,
    personalState: surface.personalState,
    progress: {
      practiceTrailCount: surface.personal.practiceTrailCount,
      lastCanonicalAt: surface.personal.lastCanonicalAt,
      reviewDueAt: surface.personal.review?.dueAt ?? null,
      initialValidation: surface.personal.initialValidation?.status === "idle"
        ? null
        : surface.personal.initialValidation?.status ?? null,
      validationNotBefore: surface.personal.initialValidation?.qualificationNotBefore ?? null,
    },
    primaryAction: surface.primaryAction,
  };
}
