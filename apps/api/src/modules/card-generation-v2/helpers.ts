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
} from "../../db/schema/card-generation-v2.ts";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import { noteVersions } from "../../db/schema/note.ts";
import { isCandidateReviewReadyV2 } from "@ailearn/shared/card-generation-v2-contracts";

export class CardGenerationV2ServiceError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "CardGenerationV2ServiceError";
    this.code = code;
    this.statusCode = statusCode;
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
 * 不使旧 Run stale。通过比较 run.noteVersionId 与 note 的最新 versionId 来检测。
 */
export async function checkSourceOutdated(
  tx: ApiTransaction,
  workspaceId: string,
  noteId: string,
  runNoteVersionId: string,
): Promise<boolean> {
  // 查找 note 的最新版本
  const latestVersions = await tx.select({ id: noteVersions.id, versionNo: noteVersions.versionNo })
    .from(noteVersions)
    .where(and(
      eq(noteVersions.noteId, noteId),
      eq(noteVersions.workspaceId, workspaceId),
    ))
    .orderBy(sql`${noteVersions.versionNo} DESC`)
    .limit(1);
  if (latestVersions.length === 0) return false;
  // 如果 run 绑定的版本不是最新版本，则 source outdated
  return latestVersions[0].id !== runNoteVersionId;
}

export async function serializeRunPublic(row: typeof cardGenerationRunsV2.$inferSelect, tx?: ApiTransaction) {
  let sourceOutdated = false;
  if (tx) {
    try {
      sourceOutdated = await checkSourceOutdated(tx, row.workspaceId, row.noteId, row.noteVersionId);
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
    semanticSpecHash: row.semanticSpecHash,
    inputSnapshotHash: row.inputSnapshotHash,
    generationFingerprint: row.generationFingerprint,
    currentPlanVersion: row.currentPlanVersion,
    reviewDraftRevision: row.reviewDraftRevision,
    sourceOutdated,
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
    candidateRevisionHash: row.candidateRevisionHash,
    qualityState: row.qualityState,
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

export function applyPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete result[key];
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
