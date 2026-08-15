/**
 * LearningRun 服务错误与统一错误码（文档 16 §13.1）。
 */

import { LearningRunErrorCode } from "@ailearn/shared";

export type LearningRunErrorCodeValue = LearningRunErrorCode;

export class LearningRunServiceError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly recoveryData?: Record<string, unknown>;

  constructor(code: string, message: string, statusCode: number, recoveryData?: Record<string, unknown>) {
    super(message);
    this.name = "LearningRunServiceError";
    this.code = code;
    this.statusCode = statusCode;
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

export function epochMismatch(): LearningRunServiceError {
  return new LearningRunServiceError(LearningRunErrorCode.EPOCH_MISMATCH, "运行纪元不匹配", 409);
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

export function contextStale(message = "学习目标已变化，请重新开始"): LearningRunServiceError {
  return new LearningRunServiceError(LearningRunErrorCode.CONTEXT_STALE, message, 409);
}

export function runNotFound(): LearningRunServiceError {
  return new LearningRunServiceError("run_not_found", "学习运行不存在", 404);
}

export function permissionDenied(): LearningRunServiceError {
  return new LearningRunServiceError(LearningRunErrorCode.PERMISSION_DENIED, "无权访问该运行", 403);
}

export function idempotencyConflict(): LearningRunServiceError {
  return new LearningRunServiceError(
    LearningRunErrorCode.IDEMPOTENCY_CONFLICT,
    "相同请求已使用不同的幂等键处理",
    409,
  );
}
