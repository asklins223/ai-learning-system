/**
 * OPS-01: Worker Prometheus 指标模块（ADR-0006 §1-3）
 *
 * Worker 侧指标覆盖 Job 队列（depth/terminal/retry/lease lost/duration）
 * 和 AI Provider 调用（calls/duration/errors）。
 *
 * 指标命名与 API 侧 lib/metrics.ts 保持一致，使 Prometheus 可以用同一
 * 套告警规则跨进程聚合。
 *
 * 隐私约束（ADR-0006 §4）：
 *   - 永不记录 Note/Source/answer/quote/question 正文
 *   - 永不记录 API Key、lease token 原文
 *   - workspace/user 标识不作为 label
 */

import promClient, {
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";
import http from "node:http";

// ─── 指标注册器 ──────────────────────────────────────────────────────────

const registry = new promClient.Registry();
collectDefaultMetrics({ register: registry });

// ─── allowlist ───────────────────────────────────────────────────────────

export const JOB_TYPES = [
  "execute_card_agent_turn",
  "align_evidence",
  "evaluate_validation",
  "parse_source",
  "generate_validation_question",
  // 救火 4b：Learning Session 评测（review should-fix #2——指标 allowlist 补新类型）
  "learning_session_assess",
] as const;

export const JOB_STATUSES = ["pending", "running", "succeeded", "failed", "dead"] as const;

/**
 * Provider 调用操作 allowlist。
 *
 * P0-4（实施计划 §5.0 P0-4 / §4.1）：
 * 现状仅含 4 个非角色 key（align_evidence / evaluate_validation /
 * evaluate_rubric / generate_validation_question）。Agent 类角色
 * （Supervisor v1 的全部角色）的 provider 调用统一经
 * AgentRuntime.executeTurn 执行，此处补充全部角色名，使
 * duration / token / finish_reason 指标按角色可观测。
 */
export const PROVIDER_OPERATIONS = [
  // 非 Agent 业务操作（既有）
  "align_evidence",
  "evaluate_validation",
  "evaluate_rubric",
  "generate_validation_question",
  // Agent 角色（Supervisor Agent v1，与 card-agent-contracts.ts AgentRole 对齐）
  "generation_supervisor",
  "text_extractor",
  "code_extractor",
  "vision_specialist",
  "deck_composer",
  "grounding_critic",
  "repairer",
] as const;

export const ERROR_CATEGORIES = [
  "timeout",
  "schema_failure",
  "provider_5xx",
  "provider_4xx",
  "auth_error",
  "quota_exceeded",
  "network_error",
  "rls_denied",
  "validation_error",
  "unknown",
] as const;

// ─── Job 指标 ───────────────────────────────────────────────────────────

/** Job 队列深度 gauge（按 status 分桶） */
export const jobQueueDepth = new Gauge({
  name: "ailearn_job_queue_depth",
  help: "Number of jobs in queue by status",
  labelNames: ["status"] as const,
  registers: [registry],
});

/** 最老 pending job 的等待秒数 gauge */
export const jobOldestPendingAgeSeconds = new Gauge({
  name: "ailearn_job_oldest_pending_age_seconds",
  help: "Age of the oldest pending job in seconds",
  registers: [registry],
});

/** Job 终态计数器（succeeded/dead） */
export const jobTerminalTotal = new Counter({
  name: "ailearn_job_terminal_total",
  help: "Total jobs that reached a terminal state",
  labelNames: ["type", "status"] as const,
  registers: [registry],
});

/** Job 重试计数器 */
export const jobRetriesTotal = new Counter({
  name: "ailearn_job_retries_total",
  help: "Total job retries by type",
  labelNames: ["type"] as const,
  registers: [registry],
});

/** Job lease 丢失计数器 */
export const jobLeaseLostTotal = new Counter({
  name: "ailearn_job_lease_lost_total",
  help: "Total jobs where the lease was lost or reaped",
  labelNames: ["type"] as const,
  registers: [registry],
});

/** Job 因不可重试错误（欠费/鉴权/配置）直接进入 dead 状态的计数器 */
export const jobNonRetryableDeadTotal = new Counter({
  name: "ailearn_job_non_retryable_dead_total",
  help: "Total jobs marked dead due to non-retryable errors (billing/auth/config)",
  labelNames: ["type"] as const,
  registers: [registry],
});

/** Job 运行时长直方图（秒） */
export const jobDurationSeconds = new Histogram({
  name: "ailearn_job_duration_seconds",
  help: "Job execution duration in seconds by type",
  labelNames: ["type"] as const,
  buckets: [0.5, 1, 2.5, 5, 10, 15, 30, 60, 90, 120],
  registers: [registry],
});

// ─── Provider 指标 ──────────────────────────────────────────────────────

/** P4-7: Stage 转换延迟直方图(§5.4:Stage Transition Latency 记录) */
export const stageTransitionLatencySeconds = new Histogram({
  name: "ailearn_stage_transition_latency_seconds",
  help: "Stage transition latency in seconds by from/to stage",
  labelNames: ["fromStage", "toStage"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

/** P4-7: Time to First Tool Call 直方图(每 turn 内首工具调用耗时) */
export const timeToFirstToolCallSeconds = new Histogram({
  name: "ailearn_time_to_first_tool_call_seconds",
  help: "Time to first tool call within an agent turn",
  labelNames: ["role"] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

/** Provider 调用计数器 */
export const providerCallsTotal = new Counter({
  name: "ailearn_provider_calls_total",
  help: "Total AI provider calls by operation and status",
  labelNames: ["operation", "status"] as const,
  registers: [registry],
});

/** Provider 调用延迟直方图（秒） */
export const providerCallDurationSeconds = new Histogram({
  name: "ailearn_provider_call_duration_seconds",
  help: "AI provider call duration in seconds by operation",
  labelNames: ["operation"] as const,
  buckets: [0.5, 1, 2.5, 5, 10, 15, 30, 60, 90],
  registers: [registry],
});

/** Provider 错误计数器（按错误分类） */
export const providerErrorsTotal = new Counter({
  name: "ailearn_provider_errors_total",
  help: "Total AI provider errors by operation and error category",
  labelNames: ["operation", "error_category"] as const,
  registers: [registry],
});

// ─── Provider 级指标（P0-4，实施计划 §4.1） ────────────────────────────
// 由 AgentRuntime.executeTurn 统一埋点（全部 Agent 角色 provider 调用入口），
// 按 role / model / finish_reason 可观测。

/** Provider 输入 token 计数器 */
export const providerInputTokensTotal = new Counter({
  name: "ailearn_provider_input_tokens_total",
  help: "Total provider input tokens by role and model",
  labelNames: ["role", "model"] as const,
  registers: [registry],
});

/** Provider 输出 token 计数器 */
export const providerOutputTokensTotal = new Counter({
  name: "ailearn_provider_output_tokens_total",
  help: "Total provider output tokens by role and model",
  labelNames: ["role", "model"] as const,
  registers: [registry],
});

/** Provider prompt cache 命中 token 计数器（B2） */
export const providerCacheHitTokensTotal = new Counter({
  name: "ailearn_provider_cache_hit_tokens_total",
  help: "Total prompt cache hit tokens by role and model",
  labelNames: ["role", "model"] as const,
  registers: [registry],
});

/** Provider prompt cache 未命中 token 计数器（B2） */
export const providerCacheMissTokensTotal = new Counter({
  name: "ailearn_provider_cache_miss_tokens_total",
  help: "Total prompt cache miss tokens by role and model",
  labelNames: ["role", "model"] as const,
  registers: [registry],
});

/** Provider finish reason 计数器（stop/tool_calls/length/content_filter/error） */
export const providerFinishReasonTotal = new Counter({
  name: "ailearn_provider_finish_reason_total",
  help: "Total provider calls by role and finish reason",
  labelNames: ["role", "finish_reason"] as const,
  registers: [registry],
});

/** Provider 输出截断计数器（finishReason === "length"，质量信号） */
export const providerResponseTruncatedTotal = new Counter({
  name: "ailearn_provider_response_truncated_total",
  help: "Total provider responses truncated due to max tokens by role",
  labelNames: ["role"] as const,
  registers: [registry],
});

// ─── 辅助函数 ───────────────────────────────────────────────────────────

/**
 * 记录一次 Agent 角色 provider 调用（P0-4 统一埋点）。
 *
 * 由 AgentRuntime.executeTurn 在 provider 调用成功后调用；
 * role 取 AgentTurnRequest.role，model 取 request.model（缺省 provider
 * 默认模型时由调用方传入）。truncated 由 finishReason === "length" 判定。
 */
export function recordProviderTurnMetrics(input: {
  role: string;
  model: string;
  durationMs: number;
  finishReason: string;
  promptTokens: number | null | undefined;
  completionTokens: number | null | undefined;
  cacheHitTokens: number | null | undefined;
  cacheMissTokens: number | null | undefined;
}): void {
  const { role, model } = input;
  providerCallsTotal.labels(role, "success").inc();
  providerCallDurationSeconds.labels(role).observe(input.durationMs / 1000);
  providerFinishReasonTotal.labels(role, input.finishReason).inc();
  if (input.finishReason === "length") {
    providerResponseTruncatedTotal.labels(role).inc();
  }
  if (input.promptTokens != null) providerInputTokensTotal.labels(role, model).inc(input.promptTokens);
  if (input.completionTokens != null) providerOutputTokensTotal.labels(role, model).inc(input.completionTokens);
  if (input.cacheHitTokens != null) providerCacheHitTokensTotal.labels(role, model).inc(input.cacheHitTokens);
  if (input.cacheMissTokens != null) providerCacheMissTokensTotal.labels(role, model).inc(input.cacheMissTokens);
}

/**
 * 将自由文本错误归类到 allowlist 分类。
 * 与 API 侧 categorizeError 保持同步。
 *
 * QUAL-21 修复：与 isNonRetryableError（QUAL-24）保持一致的分类策略——
 * 优先检查结构化 ProviderRequestError 的 HTTP 状态码，避免文本子串匹配的误判。
 * 例如 "timeout after 5000ms" 不再被误分类为 provider_5xx（匹配 "500"）。
 * 只有当错误不是结构化 ProviderRequestError 时，才回退到文本模式匹配。
 */
export function categorizeError(error: unknown): (typeof ERROR_CATEGORIES)[number] {
  if (error === null || error === undefined) return "unknown";

  // QUAL-21: 优先检查结构化错误类型，与 isNonRetryableError 保持一致
  if (typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      if (status >= 500) return "provider_5xx";
      if (status === 401 || status === 403) return "auth_error";
      if (status === 429) return "quota_exceeded";
      if (status >= 400 && status < 500) return "provider_4xx";
    }
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out") || message.includes("abort")) return "timeout";
  if (message.includes("schema") || message.includes("parse") || message.includes("invalid json")) return "schema_failure";
  // QUAL-21: 文本匹配仅作为结构化检查的回退，优先级降低
  if (message.includes("quota") || message.includes("rate limit")) return "quota_exceeded";
  if (message.includes("network") || message.includes("econnrefused") || message.includes("enotfound")) return "network_error";
  if (message.includes("rls") || message.includes("policy")) return "rls_denied";
  if (message.includes("validation") || message.includes("invalid")) return "validation_error";
  if (message.includes("auth")) return "auth_error";
  return "unknown";
}

/**
 * 启动一个轻量 HTTP 服务器暴露 /metrics 端点。
 * Prometheus scraper 通过此端口拉取 Worker 指标。
 *
 * 端口通过 WORKER_METRICS_PORT 环境变量配置，默认 9100。
 */
export function startMetricsServer(port = Number(process.env.WORKER_METRICS_PORT ?? 9100)): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      try {
        const metrics = await registry.metrics();
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(metrics);
      } catch (err) {
        res.writeHead(500);
        res.end(`# metrics collection failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return;
    }
    res.writeHead(404);
    res.end("Not Found\n");
  });

  server.listen(port, "0.0.0.0");
  return server;
}
