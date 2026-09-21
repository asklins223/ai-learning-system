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

import { AIConsentRequiredError, AIDataPolicyDeniedError, AIProviderNotConfiguredError } from "./governance.ts";
// 稳定 P1（2026-09-15 审计）：作业 payload 与类型不符是确定性失败。
import { JobPayloadContractError } from "@ailearn/shared/job-payload-contracts";

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
  // 2026-09-15 审计（稳定 P1-3）：**保留** "account is in good standing"。
  // 初看像取反写错（正常状态的短语怎么会被当成错误？），但它对应的是 DashScope
  // 欠费时的真实报文（见 __tests__/non-retryable-errors.test.ts 的 fixture）：
  //   "dashscope 400: Access denied, please make sure your account is in good standing."
  // 语义是"请确保账户状态正常"= 账户当前**不正常**。删掉它会丢掉这条真实检测。
  // 同时补上英文直述的负向写法作为别名（其它 provider 可能这样报）。
  "account is in good standing",
  "not in good standing",
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
 * 文本兜底里的 HTTP 401/403 识别。
 *
 * 2026-09-15 审计（稳定 P1-3）：此前是裸 `/\b40[13]\b/`——消息正文里只要出现
 * 401/403 这个数字就被判成不可重试（"card 403 not found"、"401 tokens" 都会），
 * 把本可重试的 job 直接处死。现在要求出现在明确的 HTTP 状态语境中。
 *
 * 覆盖："403 Forbidden" / "401 unauthorized" / "status 401" / "HTTP 403" /
 * "error code: 403" / "dashscope 401: ..."。
 */
const HTTP_401_403_CONTEXT =
  /\b(?:status|http|code|error)\b[^a-z0-9]{0,12}\b40[13]\b|\b40[13]\b[^a-z0-9]{0,4}(?:forbidden|unauthorized|access denied)\b|\b40[13]\s*:/;

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
 * Companion Agent 预算耗尽（步数/工具调用数/执行时间）。
 *
 * 预算是确定性的：它按 run 累计并落库，重投同一 job 只会读到已耗尽的预算，
 * 快速失败后再被重投，直到重试上限——纯调度浪费。与 AgentOutputError 同类，
 * 必须直接标记 dead，让用户重新发起一轮对话。
 */
export class CompanionAgentBudgetExceededError extends Error {
  readonly code = "AGENT_BUDGET_EXCEEDED" as const;

  constructor(message: string) {
    super(message);
    this.name = "CompanionAgentBudgetExceededError";
  }
}

/**
 * 伴星记忆抽取的输出不可用（方案 29 §4.3）。
 *
 * 与 `AgentOutputError` 同类：模型没给出符合 schema 的 JSON，是**输出本身**的问题，
 * 重投同一个 job 不会改变结果（handler 内部已经重试过一次采样）。
 *
 * 加这个类的直接动机：抽取器此前在解析失败时 `return` 而不抛错，于是
 * `jobs.status` 记成 `succeeded`——242 个"成功"的抽取 job 写进了 **0** 行记忆，
 * 整条写路径在监控上看起来完全健康。判 dead 才能让它可见。
 */
export class MemoryExtractOutputError extends Error {
  readonly code = "MEMORY_EXTRACT_OUTPUT_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "MemoryExtractOutputError";
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

  // Agent 预算耗尽同理：run 级预算跨重投累计，重试不可能恢复。
  if (error instanceof CompanionAgentBudgetExceededError) return true;

  // 记忆抽取输出不合规同理：内部已重试过一次采样，重投不会给出更好的输出。
  if (error instanceof MemoryExtractOutputError) return true;

  // 2026-08-12+（15a 根因修复）：AI 同意/协议缺失（sendToExternal=false、
  // 未签署协议）——用户不操作设置重试必败，直接 dead 并让前端引导设置。
  // 此前按可重试处理（重试 3 次全失败，浪费且错误信息无引导）。
  if (error instanceof AIConsentRequiredError) return true;
  if (error instanceof AIDataPolicyDeniedError) return true;
  // AI P0-1（2026-09-15 审计）：严格模式下 provider 未配置 = 配置错误。
  // 重试不会让缺失的 API key 出现，直接 dead 并让部署方看到明确原因。
  if (error instanceof AIProviderNotConfiguredError) return true;

  // 稳定 P1（2026-09-15 审计）：作业 payload 不符合该作业类型的契约（缺字段、
  // 字段名拼错、类型不对）——重试不会让缺失字段出现，只会空转三次租约、把同一条
  // 错误推迟到第三次之后才暴露。直接 dead，让"生产者写错了"这件事立刻可见。
  if (error instanceof JobPayloadContractError) return true;

  // QUAL-24 修复：优先检查结构化错误类型
  // ProviderRequestError 包含 status 和 providerCode 字段，
  // 可直接通过 HTTP 状态码判断，避免文本匹配的误判风险
  if (error !== null && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      // 401 Unauthorized, 403 Forbidden → 不可重试
      if (status === 401 || status === 403) return true;
      // 2026-09-15 审计（稳定 P1-3 附加发现）：402 Payment Required 此前**不在**
      // 不可重试集合里，只能靠文本短语兜底。欠费/额度是确定性条件，重试不可能自愈，
      // 而 migration 0220 的注释记录了实测后果：dev 库 13 个 job 各自对 HTTP 402
      // 空转 7 次（该版本的退避只降低了频率，没有消除无效重试）。
      if (status === 402) return true;
      // 2026-08-12（模型调用面审计）：与结构化 provider 错误策略对齐——
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
  // 必须带 HTTP 状态语境（见 HTTP_401_403_CONTEXT），不再裸匹配数字。
  if (HTTP_401_403_CONTEXT.test(lower)) return true;

  return NON_RETRYABLE_PATTERNS.some((pattern) => lower.includes(pattern));
}
