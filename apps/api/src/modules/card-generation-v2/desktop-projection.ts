import {
  cardGenerationCandidateListV1Schema,
  cardGenerationCandidateV1Schema,
  cardGenerationPracticeQuotaV1Schema,
  cardGenerationActiveSummaryListV1Schema,
  cardGenerationCloseResultV1Schema,
  cardGenerationJobAcceptedV1Schema,
  cardGenerationPlanServerViewV2Schema,
  cardGenerationReviewResultV1Schema,
  cardGenerationRunServerViewV2Schema,
  cardGenerationCancelResultV1Schema,
  cardGenerationRetryResultV1Schema,
  cardGenerationRecoveryProjectionV1Schema,
  type CardGenerationRunServerViewV2,
  type CardGenerationCandidateListV1,
  type CardGenerationCloseResultV1,
  type CardGenerationJobAcceptedV1,
  type CardGenerationReviewResultV1,
  type CardGenerationCancelResultV1,
  type CardGenerationRetryResultV1,
} from "@ailearn/shared/card-generation-desktop-contracts";
import { cardActivationReceiptV2Schema, candidateRevealV2Schema } from "@ailearn/shared/card-generation-v2-contracts";
import type { CardPlanV2 } from "@ailearn/shared/card-generation-v2-contracts";
import { z } from "zod";

type CardGenerationRecoveryInput = Pick<
  CardGenerationRunServerViewV2,
  "runId" | "noteId" | "noteVersionId" | "status" | "sourceOutdated" | "error"
>;

const recoveryRunStatuses = new Set(["needs_attention", "failed", "stale"]);

function publicRecoveryReason(value: CardGenerationRecoveryInput) {
  if (value.status === "stale" || value.sourceOutdated) return "source_outdated" as const;
  const errorCode = value.error?.code.toLowerCase() ?? "";
  if (/(provider|credential|model|ai_)/.test(errorCode)) return "provider_unavailable" as const;
  if (/(quality|grounding|pedagogy|evidence|critic)/.test(errorCode)) return "quality_gate_failed" as const;
  if (value.status === "failed") return "run_failed" as const;
  if (value.status === "needs_attention") return "attention_required" as const;
  return "unknown" as const;
}

/**
 * 这次失败是否值得"就地再试一次"（2026-09-18）。
 *
 * 判据（三条都要满足，宁可少给也不要给错）：
 * 1. run 处于 `needs_attention` —— 不是 failed/stale；来源没过期（sourceOutdated=false），
 *    否则重跑只会对着过期来源再失败一次；
 * 2. run.error_code 是**质量门禁**类失败（`quality_gate_failed`）——这是"内容没过 critic"
 *    这一唯一可用重试消除的原因。provider/配置类失败（缺 key、余额不足）重跑无意义；
 * 3. 输入快照与已封存来源都还在（run 行存在即满足；来源过期由第 1 条排除）。
 *
 * 反例：`generation_failed` 且 error_message 是 "missing API key" —— 用户点重试只会
 * 再花一次时间再次失败，属于把服务端问题伪装成用户可操作的按钮，因此不签发。
 */
function inPlaceRetryable(value: CardGenerationRecoveryInput): boolean {
  if (value.status !== "needs_attention") return false;
  if (value.sourceOutdated) return false;
  return (value.error?.code ?? "") === "quality_gate_failed";
}

export function projectCardGenerationRecoveryV1(value: CardGenerationRecoveryInput) {
  if (!recoveryRunStatuses.has(value.status)) return null;
  const sourceRef = { noteId: value.noteId, noteVersionId: value.noteVersionId };
  const retryable = inPlaceRetryable(value);
  return cardGenerationRecoveryProjectionV1Schema.parse({
    version: 1,
    publicReasonCode: publicRecoveryReason(value),
    // 默认仍是"仅重新同步"：契约不会把一次失败的 run 悄悄变成同 run 重试。
    // 唯一例外是**服务端确认可就地重试**的质量门禁失败（见 inPlaceRetryable）——
    // 此时显式签发 retry_generation 动作，由用户点击触发（绝不自动重放）。
    retryability: retryable ? "retry_in_place" : "resync_required",
    allowedActions: [
      { kind: "refresh_status", runId: value.runId },
      { kind: "return_note", route: "note.detail", sourceRef },
      ...(retryable ? [{ kind: "retry_generation" as const, runId: value.runId }] : []),
    ],
  });
}

export function projectCardGenerationJobAcceptedV1(value: unknown): CardGenerationJobAcceptedV1 {
  const server = cardGenerationJobAcceptedV1Schema.omit({ version: true }).parse(value);
  return cardGenerationJobAcceptedV1Schema.parse({
    version: 1,
    runId: server.runId,
    status: server.status,
  });
}

export function parseCardGenerationRunServerViewV2(value: unknown) {
  return cardGenerationRunServerViewV2Schema.parse(value);
}

export function parseCardGenerationPlanV2(value: unknown): CardPlanV2 {
  return cardGenerationPlanServerViewV2Schema.parse(value);
}

export function projectCardGenerationCandidatesV1(runId: string, value: unknown): CardGenerationCandidateListV1 {
  const server = z.strictObject({
    candidates: z.array(cardGenerationCandidateV1Schema.omit({ version: true })).max(1000),
    practiceQuota: cardGenerationPracticeQuotaV1Schema,
  }).parse(value);
  return cardGenerationCandidateListV1Schema.parse({
    version: 1,
    runId,
    candidates: server.candidates.map((candidate) => cardGenerationCandidateV1Schema.parse({ version: 1, ...candidate })),
    practiceQuota: server.practiceQuota,
  });
}

export function projectCardGenerationActiveSummaryListV1(value: unknown) {
  const runs = z.array(cardGenerationRunServerViewV2Schema).max(20).parse(value);
  return cardGenerationActiveSummaryListV1Schema.parse({
    version: 1,
    items: runs.map((run) => ({
      version: 1,
      runId: run.runId,
      noteId: run.noteId,
      noteVersionId: run.noteVersionId,
      status: run.status,
      currentPlanVersion: run.currentPlanVersion,
      reviewDraftRevision: run.reviewDraftRevision,
      updatedAt: run.updatedAt,
      recovery: run.recovery,
      route: { kind: "note.cardGeneration", cardGenerationRunId: run.runId },
    })),
  });
}

export function projectCardGenerationReviewResultV1(value: unknown): CardGenerationReviewResultV1 {
  const server = cardGenerationReviewResultV1Schema.omit({ version: true }).parse(value);
  return cardGenerationReviewResultV1Schema.parse({
    version: 1,
    runId: server.runId,
    actionType: server.actionType,
    reviewDraftRevision: server.reviewDraftRevision,
    ...(server.candidateId ? { candidateId: server.candidateId } : {}),
    ...(server.feedbackReasonCodes ? { feedbackReasonCodes: server.feedbackReasonCodes } : {}),
  });
}

export function projectCardGenerationCancelResultV1(value: unknown): CardGenerationCancelResultV1 {
  const server = cardGenerationCancelResultV1Schema.omit({ version: true }).parse(value);
  return cardGenerationCancelResultV1Schema.parse({
    version: 1,
    runId: server.runId,
    status: server.status,
  });
}

/**
 * 就地重试的回执（2026-09-18）：告诉客户端 run 已回到工作态。
 *
 * 复用 cancel 的结果形状（同构：只有 runId + status），因为客户端需要的是同一件事——
 * "服务端收下了这次操作，run 现在处于某个状态"。契约上单独命名，避免把重试伪装成取消。
 */
export function projectCardGenerationRetryResultV1(value: unknown): CardGenerationRetryResultV1 {
  const server = cardGenerationRetryResultV1Schema.parse(value);
  return { version: 1, runId: server.runId, status: server.status };
}

export function projectCardGenerationCloseResultV1(value: unknown): CardGenerationCloseResultV1 {
  const server = cardGenerationCloseResultV1Schema.omit({ version: true }).parse(value);
  return cardGenerationCloseResultV1Schema.parse({
    version: 1,
    runId: server.runId,
    status: server.status,
    reviewDraftRevision: server.reviewDraftRevision,
  });
}

export function parseCardActivationReceiptV2(value: unknown) {
  return cardActivationReceiptV2Schema.parse(value);
}

export function parseCandidateRevealV2(value: unknown) {
  return candidateRevealV2Schema.parse(value);
}
