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
  "generate_card",
  "plan_card_generation",
  "analyze_card_image",
  "map_card_generation",
  "reduce_card_generation",
  "plan_card_set",
  "render_card_generation",
  "publish_card_generation",
  "align_evidence",
  "evaluate_validation",
  "parse_source",
  "generate_validation_question",
] as const;

export const JOB_STATUSES = ["pending", "running", "succeeded", "failed", "dead"] as const;

export const PROVIDER_OPERATIONS = [
  "generate_card",
  "generate_card_repair",
  "card_map",
  "image_understanding",
  "image_card_map",
  "align_evidence",
  "evaluate_validation",
  "evaluate_rubric",
  "generate_validation_question",
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

// ─── 辅助函数 ───────────────────────────────────────────────────────────

/**
 * 将自由文本错误归类到 allowlist 分类。
 * 与 API 侧 categorizeError 保持同步。
 */
export function categorizeError(error: unknown): (typeof ERROR_CATEGORIES)[number] {
  if (error === null || error === undefined) return "unknown";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out") || message.includes("abort")) return "timeout";
  if (message.includes("schema") || message.includes("parse") || message.includes("invalid json")) return "schema_failure";
  if (message.includes("500") || message.includes("502") || message.includes("503") || message.includes("504")) return "provider_5xx";
  if (message.includes("401") || message.includes("403") || message.includes("auth")) return "auth_error";
  if (message.includes("quota") || message.includes("rate limit") || message.includes("429")) return "quota_exceeded";
  if (message.includes("network") || message.includes("econnrefused") || message.includes("enotfound")) return "network_error";
  if (message.includes("rls") || message.includes("policy")) return "rls_denied";
  if (message.includes("validation") || message.includes("invalid")) return "validation_error";
  if (message.includes("400") || message.includes("422")) return "provider_4xx";
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
