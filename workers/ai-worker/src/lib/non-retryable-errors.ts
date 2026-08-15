/**
 * Non-retryable error detection.
 *
 * Some provider errors indicate a condition that will not resolve on retry:
 *   - Account billing issues (overdue payment, access denied)
 *   - Authentication / authorization failures (invalid key, forbidden)
 *   - Configuration errors (missing API key)
 *
 * Retrying these errors wastes lease time, delays user feedback, and inflates
 * the error metrics.  When detected, the tick loop should mark the job as dead
 * immediately instead of going through the normal retry cycle.
 *
 * BUG-22/77/SEC-13/SEC-24 修复：移除过于宽泛的模式匹配，改为使用精确短语匹配。
 */

import { AIConsentRequiredError } from "./governance.ts";

/**
 * Patterns that identify non-retryable errors.
 * Each entry is matched case-insensitively against the error message.
 *
 * 注意：模式必须足够精确，避免误匹配可重试的错误消息。
 * 例如 "billing" 会匹配 "billing cycle reset successful" 等非错误消息，
 * "is required for" 会匹配 "field noteVersionId is required for this operation" 等可重试错误。
 */
const NON_RETRYABLE_PATTERNS: readonly string[] = [
  // Billing / account standing — 使用精确短语而非单词匹配
  "overdue-payment",
  "overdue payment",
  "account is in good standing",
  "payment required",
  "insufficient balance",
  "account suspended",
  "account deactivated",
  "billing plan not found",
  "billing quota exceeded",
  // Authentication — 使用精确短语
  "invalid api key",
  "invalid_api_key",
  "unauthorized",
  "authentication failed",
  "api key is required",
  "dashscope_api_key is required",
  "api key not configured",
  // Authorization — 使用精确短语，移除过于宽泛的 "forbidden"
  "access forbidden",
  "permission denied",
  "access denied",
  // Configuration — 移除 "is required for"（过于宽泛），使用精确短语
  "not configured",
  "consent not signed",
  "provider snapshot mismatch",
];

/**
 * Agent 输出协议错误 — 模型输出本身不可用，重试不会改变结果。
 *
 * - `output_truncated`：输出达到 token 上限被截断（finish_reason: "length"）。
 *   截断是确定性的：相同的输出预算下重试仍会截断，重投只会无限空转。
 * - `arguments_malformed`：工具调用 arguments 不是合法 JSON（不可静默降级）。
 */
export class AgentOutputError extends Error {
  readonly code: "output_truncated" | "arguments_malformed";

  constructor(
    code: "output_truncated" | "arguments_malformed",
    message: string,
  ) {
    super(message);
    this.name = "AgentOutputError";
    this.code = code;
  }
}

/**
 * Returns true if the error message indicates a condition that will not
 * resolve on retry (billing, auth, config errors).
 *
 * BUG-22/77 修复：移除 "is required for"、"billing"、"forbidden" 等过于宽泛的模式，
 * 改用精确短语匹配，避免误将可重试错误标记为不可重试。
 *
 * QUAL-24 修复：优先检查结构化 ProviderRequestError 的 HTTP 状态码，
 * 401/403 状态码直接判定为不可重试，不依赖文本匹配。
 * 只有当错误不是结构化 ProviderRequestError 时，才回退到文本模式匹配。
 */
export function isNonRetryableError(error: unknown): boolean {
  // 输出协议错误（截断/参数损坏）是确定性失败：重试不会改变输出预算，
  // 重投只会空转。必须直接标记 dead，交给用户重新生成。
  if (error instanceof AgentOutputError) return true;

  // 2026-08-12+（15a 根因修复）：AI 同意/协议缺失（sendToExternal=false、
  // 未签署协议）——用户不操作设置重试必败，直接 dead 并让前端引导设置。
  // 此前按可重试处理（重试 3 次全失败，浪费且错误信息无引导）。
  if (error instanceof AIConsentRequiredError) return true;

  // QUAL-24 修复：优先检查结构化错误类型
  // ProviderRequestError 包含 status 和 providerCode 字段，
  // 可直接通过 HTTP 状态码判断，避免文本匹配的误判风险
  if (error !== null && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      // 401 Unauthorized, 403 Forbidden → 不可重试
      if (status === 401 || status === 403) return true;
      // 2026-08-12（模型调用面审计）：与 generation-failure-policy 对齐——
      // 400（含 context_length_exceeded）/404（模型不存在）/422（验证失败）
      // 都是确定性请求错误，重试无意义（此前会无意义重试 3 次烧配额）。
      // 仅 408/429/5xx 可重试。
      if (status === 400 || status === 404 || status === 422) return true;
      // 其他状态码（408/429/5xx）可重试，继续走文本匹配兜底
    }
  }

  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : String(error);
  const lower = message.toLowerCase();

  // QUAL-24 补充：从错误消息文本中提取 HTTP 状态码。
  // 匹配 "403 Forbidden"、"dashscope 401: ..." 等模式。
  if (/\b40[13]\b/.test(lower)) return true;

  return NON_RETRYABLE_PATTERNS.some((pattern) => lower.includes(pattern));
}
