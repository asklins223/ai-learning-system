/**
 * LearningRun 服务错误与统一错误码（文档 16 §13.1）。
 */

import { LearningRunErrorCode } from "@ailearn/shared";
import { DomainError } from "@ailearn/shared";

export class LearningRunServiceError extends DomainError {
  readonly recoveryData?: Record<string, unknown>;

  constructor(code: string, message: string, statusCode: number, recoveryData?: Record<string, unknown>) {
    super({ name: "LearningRunServiceError", code, message, statusCode });
    this.recoveryData = recoveryData;
  }
}

export function staleRunRevision(currentRevision: number, expected: number): LearningRunServiceError {
  return new LearningRunServiceError(
    LearningRunErrorCode.STALE_RUN_REVISION,
    "运行状态已变化，请刷新后重试",
    409,
    { currentRevision, expected },
  );
}

export function staleTaskRevision(current: number, expected: number): LearningRunServiceError {
  return new LearningRunServiceError(
    LearningRunErrorCode.STALE_TASK_REVISION,
    "任务状态已变化，请刷新后重试",
    409,
    { current, expected },
  );
}

export function invalidPhase(phase: string, expected: string): LearningRunServiceError {
  return new LearningRunServiceError(
    LearningRunErrorCode.INVALID_PHASE,
    `当前阶段（${phase}）不允许该操作，需要 ${expected}`,
    409,
  );
}

export function artifactAlreadyLocked(): LearningRunServiceError {
  return new LearningRunServiceError(
    LearningRunErrorCode.ARTIFACT_ALREADY_LOCKED,
    "本任务已有锁定的作答，不能重复提交",
    409,
  );
}

export function scheduleGenerationChanged(): LearningRunServiceError {
  return new LearningRunServiceError(
    LearningRunErrorCode.SCHEDULE_GENERATION_CHANGED,
    "复习安排已更新，请返回复习队列重新开始",
    409,
  );
}

export function variantNotAuthorized(): LearningRunServiceError {
  return new LearningRunServiceError(
    LearningRunErrorCode.VARIANT_NOT_AUTHORIZED,
    "该交互方式当前不可用",
    409,
  );
}

export function contextStale(message = "学习卡已变化，请重新开始"): LearningRunServiceError {
  return new LearningRunServiceError(LearningRunErrorCode.CONTEXT_STALE, message, 409);
}

/**
 * 冻结失败按**原因**给用户可见说法（39d W3-4）。
 *
 * 此前所有 `TargetSnapshotError` 都落在同一句"学习卡已变化或当前不可用，请刷新复习队列"上，
 * 而从 W3-4 起这句话会说两件假话：目标本身不可用时根本不涉及卡；无卡目标从来没有卡，
 * 却被指着去刷新复习队列。这条链路上的 message 是直接进界面 `role="alert"` 那一行的
 * （`learning-run-surface.tsx` 的 failure.message），所以文案就是产品行为，不是日志。
 * 状态码一律仍是 `CONTEXT_STALE`/409：客户端按 code 归一化，改文案不改合同。
 */
const FREEZE_FAILURE_COPY: Record<string, string> = {
  objective_not_found_or_inactive: "这个学习目标已经不可用，请换一个目标或重新提出一个",
  objective_revision_not_found: "这个学习目标的最新内容还没准备好，请稍后重新开始",
  target_evidence_missing: "这个目标还没有可依据的原稿内容，暂时开不了练习",
  evidence_snapshot_not_found: "这个目标的原稿依据不完整，暂时开不了练习",
  evidence_eligibility_missing: "这个目标的原稿依据不完整，暂时开不了练习",
  evidence_not_usable: "这个目标的原稿依据当前不可用，暂时开不了练习",
  // 卡自己的失败仍然说卡——那句本来就对。
  card_publication_not_found: "学习卡已变化或当前不可用，请刷新复习队列",
  card_content_epoch_invalid: "学习卡已变化或当前不可用，请刷新复习队列",
};

export function contextStaleFromFreezeCode(code: string): LearningRunServiceError {
  return contextStale(
    FREEZE_FAILURE_COPY[code] ?? "这个目标现在开不了练习，请稍后重试",
  );
}

export function runNotFound(): LearningRunServiceError {
  return new LearningRunServiceError("run_not_found", "学习运行不存在", 404);
}

export function idempotencyConflict(): LearningRunServiceError {
  return new LearningRunServiceError(
    LearningRunErrorCode.IDEMPOTENCY_CONFLICT,
    "相同请求已使用不同的幂等键处理",
    409,
  );
}
