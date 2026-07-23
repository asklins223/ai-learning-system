/**
 * OPS-01: Prometheus 指标模块（ADR-0006 §1-3）
 *
 * 暴露 Prometheus-compatible 指标，供 SLO 计算和告警使用。
 * 所有 label 必须为低基数 allowlist，禁止自由文本。
 *
 * 指标分类（对应 ADR-0006 §2 与 v0.5 计划 §6.6 Must 指标集）：
 *   - HTTP：请求量、成功率、p95 延迟、5xx 数、readiness
 *   - Job：queue depth、oldest pending、wait/runtime、retry/dead、lease lost/reap
 *   - Provider：调用量、延迟、超时、schema failure、用户配置错误
 *   - Database：迁移版本、连接池状态、事务失败、RLS 拒绝
 *   - Funnel：邀请发出/消费、onboarding 完成、生成卡、提交验证、完成复习
 *   - Release：版本、commit、migration、镜像 digest
 *
 * 隐私约束（ADR-0006 §4）：
 *   - 永不记录 Note/Source/answer/quote/question 正文
 *   - 永不记录 API Key、Cookie、CSRF、Authorization、完整 URL query
 *   - 永不记录 Provider 原始请求/响应
 *   - lease token 只记录不可复用的短 fingerprint
 *   - workspace/user 标识使用 HMAC 后的不可逆标识
 */

import promClient, {
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";

// ─── 指标注册器 ──────────────────────────────────────────────────────────

/**
 * 独立的 Registry 实例，避免与全局默认注册器冲突。
 * 只暴露显式定义的指标，不自动收集 Node.js 运行时指标。
 */
export const registry = new promClient.Registry();

// 收集 Node.js 默认指标（process_cpu、process_memory、gc 等），
// 用于容量和性能分析，但不包含业务 label。
collectDefaultMetrics({ register: registry });

// ─── 常量与 allowlist ────────────────────────────────────────────────────

/**
 * HTTP route template allowlist。
 * 只记录路由模板（如 GET /notes/:id），不记录实际路径参数，
 * 避免高基数和路径参数泄漏。
 */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * HTTP status class allowlist（2xx/3xx/4xx/5xx）。
 * 只记录状态类，不记录精确状态码，降低基数。
 */
export const HTTP_STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const;

/**
 * Job type allowlist — 对应 HANDLERS 注册表。
 */
export const JOB_TYPES = [
  "generate_card",
  "align_evidence",
  "evaluate_validation",
  "parse_source",
] as const;

/**
 * Job status allowlist。
 */
export const JOB_STATUSES = ["pending", "running", "succeeded", "failed", "dead"] as const;

/**
 * Provider operation allowlist。
 */
export const PROVIDER_OPERATIONS = ["generate_card", "align_evidence", "evaluate_validation"] as const;

/**
 * 错误分类 allowlist — 自由文本错误必须先归类。
 */
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

/**
 * Funnel 事件 allowlist（ADR-0006 §2）。
 */
export const FUNNEL_EVENTS = [
  "invite_created",
  "invite_consumed",
  "invite_revoked",
  "onboarding_step",
  "onboarding_completed",
  "card_generation_terminal",
  "validation_submitted",
  "validation_terminal",
  "review_attempt_terminal",
  "job_claimed",
  "job_retried",
  "job_dead",
  "job_lease_lost",
  "provider_call_terminal",
  "backup_terminal",
  "release_deployed",
  "release_rolled_back",
] as const;

// ─── HTTP 指标 ──────────────────────────────────────────────────────────

/** HTTP 请求总量计数器 */
export const httpRequestsTotal = new Counter({
  name: "ailearn_http_requests_total",
  help: "Total HTTP requests by method, route template, and status class",
  labelNames: ["method", "route", "status_class"] as const,
  registers: [registry],
});

/** HTTP 请求延迟直方图（秒）— 用于 p95 计算 */
export const httpRequestDurationSeconds = new Histogram({
  name: "ailearn_http_request_duration_seconds",
  help: "HTTP request duration in seconds by method and route template",
  labelNames: ["method", "route"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/** HTTP 5xx 错误计数器 */
export const httpErrors5xxTotal = new Counter({
  name: "ailearn_http_errors_5xx_total",
  help: "Total HTTP 5xx responses by method and route template",
  labelNames: ["method", "route"] as const,
  registers: [registry],
});

/** Readiness 状态 gauge（1=ready, 0=not ready） */
export const readinessStatus = new Gauge({
  name: "ailearn_readiness_status",
  help: "API readiness status (1=ready, 0=not ready)",
  registers: [registry],
});

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

// ─── Database 指标 ──────────────────────────────────────────────────────

/** 数据库迁移版本 gauge */
export const dbMigrationVersion = new Gauge({
  name: "ailearn_db_migration_version",
  help: "Latest applied database migration version",
  registers: [registry],
});

/** 数据库连接池活跃连接数 gauge */
export const dbPoolActiveConnections = new Gauge({
  name: "ailearn_db_pool_active_connections",
  help: "Active database connections in the pool",
  registers: [registry],
});

/** 数据库事务失败计数器 */
export const dbTransactionFailuresTotal = new Counter({
  name: "ailearn_db_transaction_failures_total",
  help: "Total database transaction failures",
  registers: [registry],
});

/** RLS 拒绝计数器 */
export const dbRlsDeniedTotal = new Counter({
  name: "ailearn_db_rls_denied_total",
  help: "Total RLS policy denials",
  registers: [registry],
});

/** 最近成功备份时间戳 gauge（Unix epoch 秒） */
export const dbLastSuccessfulBackupTimestamp = new Gauge({
  name: "ailearn_db_last_successful_backup_timestamp",
  help: "Unix timestamp of the last verified successful backup",
  registers: [registry],
});

// ─── Funnel 指标（ADR-0006 §2）──────────────────────────────────────────

/** Alpha 漏斗事件计数器 */
export const funnelEventsTotal = new Counter({
  name: "ailearn_funnel_events_total",
  help: "Alpha funnel events by event type",
  labelNames: ["event"] as const,
  registers: [registry],
});

// ─── Release 指标 ───────────────────────────────────────────────────────

/** Release 信息 gauge（固定值，用于 Prometheus label 关联） */
export const releaseInfo = new Gauge({
  name: "ailearn_release_info",
  help: "Release metadata: version, commit, migration count",
  labelNames: ["version", "commit", "migrations"] as const,
  registers: [registry],
});

// ─── 辅助函数 ───────────────────────────────────────────────────────────

/**
 * 将 HTTP 状态码映射到 status class。
 * 只允许 2xx/3xx/4xx/5xx 四类，降低基数。
 */
export function statusToClass(status: number): (typeof HTTP_STATUS_CLASSES)[number] {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

/**
 * 将路由路径规范化为模板。
 * 去除路径参数（UUID、数字）和 query string，避免高基数和参数泄漏。
 * 例如：/notes/550e8400-e29b-41d4-a716-446655440000 → /notes/:id
 *      /search?q=sensitive+content → /search
 */
export function normalizeRouteTemplate(path: string): string {
  return path
    // 去除 query string（ADR-0006 §4 禁止记录完整 URL query）
    .replace(/\?.*$/, "")
    // UUID → :id
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    // 纯数字 → :id
    .replace(/\/\d+/g, "/:id")
    // 尾部斜杠
    .replace(/\/$/, "") || "/";
}

/**
 * 将自由文本错误归类到 allowlist 分类。
 * 避免在指标 label 中使用原始错误消息。
 */
export function categorizeError(error: unknown): (typeof ERROR_CATEGORIES)[number] {
  if (error === null || error === undefined) return "unknown";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
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
 * 记录 Funnel 事件。
 * 所有 funnel 事件必须通过此函数记录，确保 label 在 allowlist 内。
 */
export function recordFunnelEvent(event: (typeof FUNNEL_EVENTS)[number]): void {
  funnelEventsTotal.inc({ event });
}

/**
 * 设置 Release 信息。
 * 在 API 启动时调用一次，将版本信息暴露为 Prometheus label。
 */
export function setReleaseInfo(version: string, commit: string, migrations: number): void {
  releaseInfo.set({ version, commit, migrations: String(migrations) }, 1);
}

/**
 * 生成 metrics 响应文本。
 * 供 /metrics 端点使用。
 */
export async function getMetricsText(): Promise<string> {
  return registry.metrics();
}

/**
 * 获取 registry 的 content type。
 * 供 /metrics 端点设置 Content-Type header。
 */
export function getMetricsContentType(): string {
  return registry.contentType;
}
