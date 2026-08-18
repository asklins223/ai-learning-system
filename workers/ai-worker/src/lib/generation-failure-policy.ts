import { isNonRetryableError, AgentOutputError } from "./non-retryable-errors.ts";

// V1 agent 相关类已删除，保留类型兼容
export class BudgetExhaustedError extends Error {
  constructor() {
    super("budget exhausted");
    this.name = "BudgetExhaustedError";
  }
}

export class CoverageViolationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`coverage violation: ${code}`);
    this.name = "CoverageViolationError";
    this.code = code;
  }
}

export type GenerationRunBlockedCode =
  | "ai_consent_required"
  | "external_ai_disabled"
  | "image_content_not_allowed"
  | "prompt_bundle_incompatible"
  | "provider_config_invalid"
  | "provider_snapshot_mismatch"
  | "vision_provider_snapshot_mismatch";

/**
 * An internal, typed decision that the current provider/governance snapshot
 * cannot process any more checkpoints in this run. Free-form provider text
 * must never be used to construct this error.
 */
export class GenerationRunBlockedError extends Error {
  readonly code: GenerationRunBlockedCode;
  readonly scope: "run" | "kind";

  constructor(code: GenerationRunBlockedCode) {
    super(`generation run blocked: ${code}`);
    this.name = "GenerationRunBlockedError";
    this.code = code;
    this.scope =
      code === "image_content_not_allowed"
      || code === "vision_provider_snapshot_mismatch"
        ? "kind"
        : "run";
  }
}

/**
 * Privacy-safe provider transport error. The upstream response message is
 * intentionally discarded; status and providerCode are sufficient for retry
 * and circuit-breaker decisions.
 */
export class ProviderRequestError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly providerCode: string | null;
  readonly code: string;

  constructor(input: {
    provider: string;
    status: number;
    providerCode?: string | number | null;
  }) {
    super(`${input.provider} request failed with HTTP ${input.status}`);
    this.name = "ProviderRequestError";
    this.provider = input.provider;
    this.status = input.status;
    this.providerCode = input.providerCode == null
      ? null
      : String(input.providerCode).slice(0, 80);
    this.code = `provider_http_${input.status}`;
  }
}

export type GenerationFailurePolicy = {
  scope: "run" | "kind" | "unit";
  autoRetry: boolean;
  code: string | null;
};

const RUN_GLOBAL_PROVIDER_CODES = new Set([
  "arrearage",
  "insufficientbalance",
  "invalidapikey",
  "invalid_api_key",
  "overduepayment",
  "unauthorized",
]);

function normalizeProviderCode(code: string | null): string {
  return (code ?? "").toLowerCase().replace(/[^a-z0-9_]+/g, "");
}

/**
 * Keep automatic retry and failure scope as separate decisions. A broad
 * string matcher may stop retries for one job, but only typed, stable facts
 * are allowed to stop fan-out for the whole generation run.
 */
export function classifyGenerationFailure(error: unknown): GenerationFailurePolicy {
  // Agent 输出协议错误（截断/参数损坏）是确定性失败：
  // 输出预算不变时重试必然再次截断，重投只会空转。
  // 与预算耗尽同类处理：unit 直接失败，不自动重试。
  if (error instanceof AgentOutputError) {
    return {
      scope: "unit",
      autoRetry: false,
      code: error.code,
    };
  }

  if (error instanceof GenerationRunBlockedError) {
    return { scope: error.scope, autoRetry: false, code: error.code };
  }

  // R55 修复：域特定错误显式分类，防止不应重试的错误被默认 fallback 标记为 autoRetry=true。
  // 计划 §11.1: budget/deadline exhausted → 停止，绝不 partial publish。
  // 计划 §12: budget failure 只有在输入条件或新 run budget 改变后才能重新创建 run。
  // BudgetExhaustedError 是终态条件——重试同一 job 会从 DB 恢复相同 usage，立即再次耗尽。
  if (error instanceof BudgetExhaustedError) {
    return {
      scope: "run",
      autoRetry: false,
      code: "budget_exhausted",
    };
  }

  // CoverageViolationError（如 blocking_decision_exists）是结构性问题，
  // 不会因重试而改变（model_omitted/protocol_error/auto_supplemented 不会自动消失）。
  if (error instanceof CoverageViolationError) {
    return {
      scope: "run",
      autoRetry: false,
      code: error.code,
    };
  }

  if (error instanceof ProviderRequestError) {
    const normalizedCode = normalizeProviderCode(error.providerCode);
    const runGlobal =
      error.status === 401
      || error.status === 402
      || RUN_GLOBAL_PROVIDER_CODES.has(normalizedCode);
    if (runGlobal) {
      return {
        scope: "run",
        autoRetry: false,
        code: error.status === 401
          ? "provider_authentication"
          : error.status === 402
            ? "provider_billing"
            : "provider_configuration",
      };
    }

    const retryableStatus =
      error.status === 408
      || error.status === 429
      || error.status >= 500;
    return {
      scope: "unit",
      autoRetry: retryableStatus,
      code: error.code,
    };
  }

  return {
    scope: "unit",
    autoRetry: !isNonRetryableError(error),
    code: null,
  };
}
