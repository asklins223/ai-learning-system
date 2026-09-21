/**
 * OPS-01: Worker Prometheus 指标模块（ADR-0006 §1-3）
 *
 * Worker 侧指标覆盖 Job 队列（depth/terminal/retry/lease lost/duration）
 * 和当前 Companion 记忆/摘要任务。
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

export const JOB_STATUSES = ["pending", "running", "succeeded", "failed", "dead"] as const;

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

// ─── 方案 22：Companion Memory 可观测性（§9.9）──────────────────────────

/**
 * 桌宠记忆检索模式计数器（vector / keyword_fallback）。
 * 每次 Context Orchestrator 检索后记录。
 */
export const companionMemoryRetrievalModeTotal = new Counter({
  name: "ailearn_companion_memory_retrieval_mode_total",
  help: "Companion memory retrieval mode (vector or keyword_fallback)",
  labelNames: ["mode"] as const,
  registers: [registry],
});

/**
 * 每轮对话实际使用的记忆数量直方图。
 */
export const companionMemoryUsedCount = new Histogram({
  name: "ailearn_companion_memory_used_count",
  help: "Number of memories used per companion dialogue turn",
  buckets: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  registers: [registry],
});

/**
 * 会话摘要任务结果计数器（success / failed）。
 */
export const companionSummaryTotal = new Counter({
  name: "ailearn_companion_summary_total",
  help: "Companion summarizer task results",
  labelNames: ["status"] as const,
  registers: [registry],
});

/**
 * 桌宠日记生成结果计数器。
 *
 * 标签就是 `companion_daily_summaries.failure_reason` 那四个取值加 `generated`：
 * 日记改成由她按人格写之后，"没有日记"有三种成因且只有一种该重试，
 * 光看 jobs.status 分不出"没同意"和"模型挂了"。
 */
export const companionDiaryTotal = new Counter({
  name: "ailearn_companion_diary_total",
  help: "Companion daily diary generation results",
  labelNames: ["result"] as const,
  registers: [registry],
});

/**
 * 启动一个轻量 HTTP 服务器暴露 /metrics 端点。
 * Prometheus scraper 通过此端口拉取 Worker 指标。
 *
 * 端口通过 WORKER_METRICS_PORT 环境变量配置，默认 9100。
 */
export function resolveMetricsPort(raw = process.env.WORKER_METRICS_PORT): number {
  if (raw === undefined || raw.trim() === "") return 9_100;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : 9_100;
}

export interface MetricsServerOptions {
  /**
   * 稳定 P1-4（2026-09-15 审计）：worker 健康检查此前只 fetch `/metrics`——那只是
   * Prometheus registry 的序列化，DB 不可达或并发槽漏光时它照样返回 200，编排器
   * 因此永远不会重启 worker，队列静默停摆（与 API 侧 `/ready` 做 schema 探测形成
   * 反差）。传入 readyProbe 后暴露 `/ready` 做真实依赖探测。
   *
   * 未传 readyProbe 时 `/ready` 返回 503（fail-closed）：宁可让没接探测的部署
   * 显式暴露出"未就绪"，也不要出现"没探测 = 健康"的假阳性。
   */
  readyProbe?: () => Promise<void>;
}

export function startMetricsServer(
  port = resolveMetricsPort(),
  options: MetricsServerOptions = {},
): http.Server {
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
    if (req.url === "/ready") {
      const probe = options.readyProbe;
      if (!probe) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("not ready: ready probe not configured\n");
        return;
      }
      try {
        await probe();
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ready\n");
      } catch (err) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end(`not ready: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return;
    }
    res.writeHead(404);
    res.end("Not Found\n");
  });

  // 2026-08-11：监听 'error'——端口占用/地址不可用时异步 error 事件若无监听
  // 会让进程崩溃且无日志（此前 listen 后无人处理 error）。
  server.on("error", (err) => {
    console.error(`[metrics] metrics server error on port ${port}: ${err.message}`);
  });

  server.listen(port, "0.0.0.0");
  return server;
}
