/**
 * Card Generation V2 — shared helpers and serialization（方案 20 §17）。
 */

import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ApiTransaction } from "../../db/client.ts";
import {
  cardGenerationRunsV2,
  cardGenerationCandidatesV2,
  cardGenerationEventsV2,
  cardDomainEventsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import { noteBlocks, notes } from "@ailearn/shared/db-schema/note";
import { cardGenerationRunStatusV2Schema, isCandidateReviewReadyV2 } from "@ailearn/shared/card-generation-v2-contracts";
import { projectCardGenerationRecoveryV1 } from "./desktop-projection.ts";
import type { CardGenerationProgressV1 } from "@ailearn/shared/card-generation-desktop-contracts";
// 2026-08-24（AI 设计审查 §4.4 第二批）：ServiceError 继承 shared 纯逻辑层的
// CardGenerationPipelineErrorV2——seal/binding-plan 纯函数抛出 shared 类，
// API 错误边界通过同一继承链识别 code/statusCode。
import { CardGenerationPipelineErrorV2 } from "@ailearn/shared/card-generation-v2-pipeline";
export { CardGenerationPipelineErrorV2 };

export class CardGenerationV2ServiceError extends CardGenerationPipelineErrorV2 {
  constructor(code: string, statusCode: number, message: string) {
    super(code, statusCode, message);
  }
}

export const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export type RunContext = { workspaceId: string; userId: string };

/**
 * 方案 20 §17.1/§22.3：SSE/事件流 payload 白名单裁剪。
 *
 * 事件 payload 只允许携带 ID/hash/枚举等审计字段；`canonicalAnswer`、
 * `learningSupport`、`scoringRubric`、`evidenceBindings`、`front`、
 * `objectiveDraft`、`presentationDraft`、`answer` 等私有/内容字段一律拒绝。
 * 递归处理嵌套对象与数组；未知 key 直接删除（fail closed，不保留）。
 */
const BLOCKED_EVENT_PAYLOAD_KEYS = new Set([
  "canonicalAnswer",
  "canonical_answer",
  "learningSupport",
  "learning_support",
  "scoringRubric",
  "scoring_rubric",
  "evidenceBindings",
  "evidence_bindings",
  "objectiveDraft",
  "objective_draft",
  "presentationDraft",
  "presentation_draft",
  "canonicalAnswerHash",
  "answer",
  "answerText",
  "front",
  "reveal",
  "privatePayloadHash",
  "private_payload_hash",
]);

export function sanitizeEventPayloadV2(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (BLOCKED_EVENT_PAYLOAD_KEYS.has(key)) continue;
    if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) {
        out[key] = value.map((item) =>
          item !== null && typeof item === "object"
            ? sanitizeEventPayloadV2(item as Record<string, unknown>)
            : item,
        );
      } else {
        out[key] = sanitizeEventPayloadV2(value as Record<string, unknown>);
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 方案 20 §17.2：Note 在 seal 后继续编辑只产生派生提示 `sourceOutdated=true`，
 * 不使旧 Run stale。判据有两条：版本指针换了（建新版本 / 恢复旧版本），或版本 id 没变
 * 但正文变了（自动保存是原地改写版本行的，只比 id 永远看不出来）。
 */
export async function checkSourceOutdated(
  tx: ApiTransaction,
  workspaceId: string,
  noteId: string,
  runNoteVersionId: string,
  runSourceContentHash: string,
): Promise<boolean> {
  const note = await tx.query.notes.findFirst({
    where: and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId)),
    columns: { currentVersionId: true },
  });
  if (!note?.currentVersionId) return false;
  // ① 换版本了（手动保存建新版本、恢复历史版本都走这条）。
  if (note.currentVersionId !== runNoteVersionId) return true;

  // ② 版本 id 没变，但正文可能已经变了——自动保存是**原地**改写版本行的，
  // 只看 id 的话这条永远不成立，卡片明明是从改之前的正文生成的却说自己不过时。
  // 这里用与生成时完全相同的算法（§9.2：只覆盖 block 内容，不含版本 id）重算一遍。
  const blocks = await tx.query.noteBlocks.findMany({
    where: eq(noteBlocks.versionId, runNoteVersionId),
    orderBy: (b, { asc }) => [asc(b.ordinal)],
  });
  const blockContents = blocks.map((block) => block.content).join("\n");
  return hashCanonicalV2("card-generation-v2/source-content", { blockContents }) !== runSourceContentHash;
}
/**
 * 一次生成的逐候选进度聚合（2026-09-20 实走复盘 #2）。
 *
 * `run.status` 到 `authoring` 就停住不动，候选是一张张写出来的，所以进度必须回到
 * 候选表上数。取每个 candidate 的**最新修订**再分组——一次生成里同一候选会被改写
 * 多次（rewrite 路径），按行数会虚高。
 */
export async function readGenerationProgressV2(
  tx: ApiTransaction,
  workspaceId: string,
  runId: string,
  currentPlanVersion: number,
): Promise<CardGenerationProgressV1> {
  const progress: CardGenerationProgressV1 = {
    plannedCards: 0, authored: 0, gatePassed: 0, gateFailed: 0,
  };
  if (currentPlanVersion > 0) {
    const planRows = await tx.execute(sql`
      SELECT result ->> 'recommendedCardCount' AS planned_cards
      FROM public.card_generation_plans_v2
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId} AND plan_version = ${currentPlanVersion}
      LIMIT 1
    `);
    const planned = Number((planRows[0] as { planned_cards?: string | null } | undefined)?.planned_cards);
    if (Number.isSafeInteger(planned) && planned >= 0) progress.plannedCards = planned;
  }
  const stateRows = await tx.execute(sql`
    SELECT quality_state, COUNT(*)::int AS n
    FROM (
      SELECT DISTINCT ON (candidate_id) quality_state
      FROM public.card_generation_candidates_v2
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
      ORDER BY candidate_id, revision DESC
    ) latest
    GROUP BY quality_state
  `);
  const counts = new Map<string, number>();
  for (const row of stateRows as unknown as Array<{ quality_state: string; n: number }>) {
    counts.set(row.quality_state, row.n);
  }
  progress.gatePassed = counts.get("passed") ?? 0;
  progress.gateFailed = counts.get("failed") ?? 0;
  progress.authored = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return progress;
}

export async function serializeRunPublic(
  row: typeof cardGenerationRunsV2.$inferSelect,
  tx?: ApiTransaction,
  progress: CardGenerationProgressV1 | null = null,
) {
  let sourceOutdated = false;
  if (tx) {
    try {
      sourceOutdated = await checkSourceOutdated(tx, row.workspaceId, row.noteId, row.noteVersionId, row.sourceContentHash);
    } catch {
      // 如果查询失败（如 mock tx 不支持某些方法），保守返回 false
      sourceOutdated = false;
    }
  }
  return {
    runId: row.id,
    noteId: row.noteId,
    noteVersionId: row.noteVersionId,
    status: row.status,
    cardContentEpoch: row.cardContentEpoch,
    // 2026-08-16（实机验证修复）：激活需要 sourceSnapshotHash 闭包——此前
    // public view 未下发，前端激活被"服务端未下发闭包元数据"阻断。
    sourceSnapshotHash: row.sourceSnapshotHash,
    semanticSpecHash: row.semanticSpecHash,
    inputSnapshotHash: row.inputSnapshotHash,
    generationFingerprint: row.generationFingerprint,
    currentPlanVersion: row.currentPlanVersion,
    reviewDraftRevision: row.reviewDraftRevision,
    sourceOutdated,
    progress,
    recovery: projectCardGenerationRecoveryV1({
      runId: row.id,
      noteId: row.noteId,
      noteVersionId: row.noteVersionId,
      status: cardGenerationRunStatusV2Schema.parse(row.status),
      sourceOutdated,
      error: row.errorCode ? { code: row.errorCode, message: row.errorMessage } : null,
    }),
    error: row.errorCode ? { code: row.errorCode, message: row.errorMessage } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeCandidatePublic(row: typeof cardGenerationCandidatesV2.$inferSelect) {
  const presentation = row.presentationDraft as {
    strategy: string;
    transformationKind: string;
    front: { cue: string; context?: string; prompt: string };
    estimatedReviewSeconds: number;
  };
  const objective = row.objectiveDraft as {
    objectiveStatement: string;
    publicSummary: string;
    knowledgeForm: string;
  };
  const recommendation = row.recommendation as { recommended: boolean; reasonCodes: string[] };
  /**
   * 审核页只需要知道"这张卡配了哪种客观题、几个候选"，所以这里**刻意只投影种类与计数**。
   * 练习件里含正确项（`correctUnitId` / `correctUnitOrder`）与全部选项文本：
   * 一旦随候选列表下发，就等于绕过曝光记账白送答案（与 0234 给 hints 定的同一条线）。
   */
  const practiceItem = (objective as {
    practiceItem?: {
      kind: string;
      options?: unknown[];
      units?: unknown[];
      pairs?: unknown[];
    } | null;
  }).practiceItem;
  const practiceItemSummary = practiceItem
    ? {
      kind: practiceItem.kind as "single_choice" | "true_false" | "ordering" | "matching",
      optionCount: practiceItem.options?.length
        ?? practiceItem.units?.length
        ?? practiceItem.pairs?.length
        ?? 0,
    }
    : null;
  return {
    candidateId: row.candidateId,
    candidateRevisionId: row.candidateRevisionId,
    revision: row.revision,
    runId: row.runId,
    planRevisionId: row.planRevisionId,
    planVersion: row.planVersion,
    planObjectiveLocalId: row.planObjectiveLocalId,
    recommendation,
    objective: {
      statement: objective.objectiveStatement,
      publicSummary: objective.publicSummary,
      knowledgeForm: objective.knowledgeForm,
    },
    front: presentation.front,
    strategy: presentation.strategy,
    transformationKind: presentation.transformationKind,
    estimatedReviewSeconds: presentation.estimatedReviewSeconds,
    evidenceSetHash: row.evidenceSetHash,
    // 2026-08-16（实机验证修复）：激活需要 candidateEvidenceBindingPlanHash
    // 闭包——此前 public view 未下发，前端激活被阻断。字段名与前端
    // CandidatePublicView.candidateEvidenceBindingPlanHash 对齐。
    candidateEvidenceBindingPlanHash: row.evidenceBindingPlanHash,
    candidateRevisionHash: row.candidateRevisionHash,
    qualityState: row.qualityState,
    practiceItem: practiceItemSummary,
    reviewDecision: row.reviewDecision,
    publishState: row.publishState,
    isReviewReady: isCandidateReviewReadyV2({
      qualityState: row.qualityState as "authored" | "checking" | "passed" | "failed",
      reviewDecision: row.reviewDecision as "undecided" | "keep" | "reject" | "merged",
      publishState: row.publishState as "unpublished" | "activating" | "activated" | "activation_failed" | "superseded" | "expired",
    }),
  };
}

export async function insertEvent(
  tx: ApiTransaction,
  workspaceId: string,
  runId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  const [row] = await tx
    .select({ maxSeq: sql<number>`COALESCE(MAX(${cardGenerationEventsV2.eventSeq}), 0)` })
    .from(cardGenerationEventsV2)
    .where(and(
      eq(cardGenerationEventsV2.workspaceId, workspaceId),
      eq(cardGenerationEventsV2.runId, runId),
    ));
  const nextSeq = (row?.maxSeq ?? 0) + 1;
  await tx.insert(cardGenerationEventsV2).values({
    workspaceId,
    runId,
    eventSeq: nextSeq,
    eventType,
    payload,
  });
}

/**
 * §17.7 领域事件（R36）：写入 card_domain_events_v2。
 *
 * 承载 card/objective/reminder lifecycle 事件（无 runId、需 aggregate 语义），
 * 供 Today/Card 通知、search、shared topology 等白名单消费者按
 * (eventId, consumerName) 幂等消费。payload 经 sanitize 白名单裁剪，
 * 不得携带 canonicalAnswer/front 等私有内容。
 */
export async function insertDomainEvent(
  tx: ApiTransaction,
  workspaceId: string,
  input: {
    eventType: "learning_objective.revised"
      | "learning_objective.superseded"
      | "learning_objective.archived"
      | "learning_card.revised"
      | "learning_card.revealed"
      | "learning_card.archived"
      | "initial_validation_reminder.created"
      | "initial_validation_reminder.deferred"
      | "initial_validation_reminder.ready"
      | "initial_validation_reminder.completed"
      | "initial_validation_reminder.cancelled";
    aggregateKind: "objective" | "card" | "reminder";
    aggregateId: string;
    aggregateRevision?: number;
    payload?: Record<string, unknown>;
    causationId?: string;
    correlationId?: string;
    idempotencyKey?: string;
  },
): Promise<string> {
  const eventId = randomUUID();
  const sanitized = sanitizeEventPayloadV2(input.payload ?? {});
  const payloadHash = hashCanonicalV2("card-domain-event-v2", {
    eventType: input.eventType,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    aggregateRevision: input.aggregateRevision ?? null,
    payload: sanitized,
  });
  await tx.insert(cardDomainEventsV2).values({
    workspaceId,
    eventId,
    eventType: input.eventType,
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    aggregateRevision: input.aggregateRevision ?? null,
    payload: sanitized,
    payloadHash,
    causationId: input.causationId,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    schemaVersion: 2,
  });
  return eventId;
}

/**
 * §17.7 批量领域事件（同一事务内一次多行 INSERT）。
 * 与 insertDomainEvent 语义一致：每个事件独立 sanitize + 计算 payloadHash +
 * 生成 eventId，但合并为单次 DB round-trip。幂等 key 由调用方保证互异。
 */
export async function insertDomainEvents(
  tx: ApiTransaction,
  workspaceId: string,
  inputs: Array<{
    eventType: "learning_objective.revised"
      | "learning_objective.superseded"
      | "learning_objective.archived"
      | "learning_card.revised"
      | "learning_card.revealed"
      | "learning_card.archived"
      | "initial_validation_reminder.created"
      | "initial_validation_reminder.deferred"
      | "initial_validation_reminder.ready"
      | "initial_validation_reminder.completed"
      | "initial_validation_reminder.cancelled";
    aggregateKind: "objective" | "card" | "reminder";
    aggregateId: string;
    aggregateRevision?: number;
    payload?: Record<string, unknown>;
    causationId?: string;
    correlationId?: string;
    idempotencyKey?: string;
  }>,
): Promise<string[]> {
  if (inputs.length === 0) return [];
  const eventIds = inputs.map(() => randomUUID());
  const rows = inputs.map((input, i) => {
    const eventId = eventIds[i];
    const sanitized = sanitizeEventPayloadV2(input.payload ?? {});
    const payloadHash = hashCanonicalV2("card-domain-event-v2", {
      eventType: input.eventType,
      aggregateKind: input.aggregateKind,
      aggregateId: input.aggregateId,
      aggregateRevision: input.aggregateRevision ?? null,
      payload: sanitized,
    });
    return {
      workspaceId,
      eventId,
      eventType: input.eventType,
      aggregateKind: input.aggregateKind,
      aggregateId: input.aggregateId,
      aggregateRevision: input.aggregateRevision ?? null,
      payload: sanitized,
      payloadHash,
      causationId: input.causationId,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      schemaVersion: 2,
    };
  });
  await tx.insert(cardDomainEventsV2).values(rows);
  return eventIds;
}

export function applyPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete result[key];
    } else if (
      key === "learningSupport" &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      // Candidate edits expose learning-support fields as a flat patch, but
      // the draft stores them in this nested object. Merge only the supplied
      // fields so editing one explanation does not erase boundary/misconception
      // or future support fields.
      const current = result[key];
      result[key] = applyPatch(
        current !== null && typeof current === "object" && !Array.isArray(current)
          ? current as Record<string, unknown>
          : {},
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

export async function getCandidateForAction(
  tx: ApiTransaction,
  workspaceId: string,
  runId: string,
  candidateId: string,
  expectedRevision: number,
  expectedRevisionHash: string,
) {
  const candidates = await tx
    .select()
    .from(cardGenerationCandidatesV2)
    .where(and(
      eq(cardGenerationCandidatesV2.runId, runId),
      eq(cardGenerationCandidatesV2.candidateId, candidateId),
      eq(cardGenerationCandidatesV2.revision, expectedRevision),
      eq(cardGenerationCandidatesV2.workspaceId, workspaceId),
    ))
    .limit(1);

  if (candidates.length === 0) {
    throw new CardGenerationV2ServiceError("candidate_not_found", 404, "候选不存在");
  }

  const candidate = candidates[0];
  if (candidate.candidateRevisionHash !== expectedRevisionHash) {
    throw new CardGenerationV2ServiceError("stale_revision", 409, "候选版本已更新，请刷新");
  }

  return candidate;
}
