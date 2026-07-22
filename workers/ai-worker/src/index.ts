// P2-1: Node.js 20+ fetch 内部已使用 undici 连接池并默认开启 keep-alive。
// 全局 fetch 会自动复用 TCP+TLS 连接，无需显式配置 Agent。
// 如需进一步调优连接池参数，可安装 undici npm 包并使用 setGlobalDispatcher。

import { logger } from "./lib/logger.ts";
import { closeDatabase } from "./db.ts";
import { runGenerateCard, runAlignEvidence, runEvaluateValidation } from "./handlers/index.ts";
import { runParseSource } from "./handlers/parse-source.ts";
import { runWithAbortTimeout } from "./lib/handler-timeout.ts";
import { resolveHandlerTimeout, RESOLVED_TIMEOUT_INFO } from "./lib/handler-timeout-config.ts";
import { isNonRetryableError } from "./lib/non-retryable-errors.ts";
import {
  claimJobs,
  markJobDead,
  markJobFailed,
  markJobSucceeded,
  markUnknownJobFailed,
  reapStaleJobs,
  QUEUE_CONCURRENCY,
  type ClaimedJob,
} from "./queue.ts";
// OPS-01: Prometheus 指标（ADR-0006 §1-3）
import {
  jobTerminalTotal,
  jobRetriesTotal,
  jobLeaseLostTotal,
  jobNonRetryableDeadTotal,
  jobDurationSeconds,
  startMetricsServer,
} from "./lib/metrics.ts";

const HANDLERS = {
  generate_card: runGenerateCard,
  align_evidence: runAlignEvidence,
  evaluate_validation: runEvaluateValidation,
  parse_source: runParseSource,
} as const;

const POLL_MS = 500;
// F-010: 模型调用超时现在按 job 类型分别配置，见 handler-timeout-config.ts
// 全局默认仍可通过 WORKER_MODEL_TIMEOUT_MS 环境变量覆盖。

// F-010: 优雅关停标志
let shuttingDown = false;
function setupGracefulShutdown() {
  const handler = () => {
    if (!shuttingDown) {
      shuttingDown = true;
      logger.info("received shutdown signal, finishing current job…");
    }
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}
setupGracefulShutdown();

// 处理单个 job 的完整生命周期（claim 后的执行 + 状态转换 + 指标记录）。
// 从 tick() 提取为独立函数以支持 fire-and-forget 并行处理。
async function processJob(job: ClaimedJob): Promise<void> {
  const handler = HANDLERS[job.type as keyof typeof HANDLERS];
  if (!handler) {
    const unknownUpdated = await markUnknownJobFailed(job);
    if (!unknownUpdated) {
      logger.warn({ jobId: job.id }, "unknown job lease was already reaped; status left unchanged");
    }
    return;
  }

  // OPS-01: 记录 job 运行时长（ADR-0006 §2）
  const jobStart = Date.now();
  try {
    // F-010: 为 handler 添加超时保护（按 job 类型解析超时阈值）
    // R-007: 超时会中止 provider；leaseToken 继续保护迟到 handler 的业务提交。
    const handlerTimeoutMs = resolveHandlerTimeout(job.type);
    await runWithAbortTimeout(
      (signal) => handler({
          id: job.id,
          payload: job.payload,
          workspaceId: job.workspaceId,
          requestedBy: job.requestedBy,
          leaseToken: job.leaseToken,
          signal,
        }),
      handlerTimeoutMs,
      (lateError) => logger.warn(
        { jobId: job.id, err: lateError },
        "timed-out handler settled after its lease was released",
      ),
    );

    // G-001: 原子条件 UPDATE — 只有 status=running 且 lease_token 与 claim 时相同才提交 succeeded。
    // 如果 job 被 reaper 回收并重新 claim，lease_token 会不同，UPDATE 影响 0 行。
    const successUpdated = await markJobSucceeded(job);
    jobDurationSeconds.labels(job.type).observe((Date.now() - jobStart) / 1000);
    if (!successUpdated) {
      // OPS-01: lease 丢失 — job 被 reaper 回收并重新 claim
      jobLeaseLostTotal.labels(job.type).inc();
      logger.warn(
        { jobId: job.id },
        "job was reaped or re-claimed during execution — skipping result commit to avoid duplicate side effects",
      );
      return;
    }
    // OPS-01: 记录终态
    jobTerminalTotal.labels(job.type, "succeeded").inc();
    logger.info({ jobId: job.id, type: job.type }, "job ok");
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    jobDurationSeconds.labels(job.type).observe((Date.now() - jobStart) / 1000);

    // 非重试错误（欠费/鉴权/配置）直接标记 dead，不浪费重试次数。
    if (isNonRetryableError(err) || isNonRetryableError(message)) {
      const failure = await markJobDead(job, message);
      if (!failure.updated) {
        jobLeaseLostTotal.labels(job.type).inc();
        logger.warn(
          { jobId: job.id },
          "job was reaped during execution — skipping non-retryable dead update to avoid double-counting",
        );
        return;
      }
      jobNonRetryableDeadTotal.labels(job.type).inc();
      jobTerminalTotal.labels(job.type, "dead").inc();
      logger.error(
        {
          jobId: job.id,
          error: message,
          reason: "non-retryable",
        },
        "job marked dead — non-retryable error (billing/auth/config)",
      );
      return;
    }

    // G-001: 失败时也使用原子条件 UPDATE，避免覆盖 reaper 的状态
    const failure = await markJobFailed(job, message);
    if (!failure.updated) {
      // OPS-01: lease 丢失 — job 被 reaper 回收
      jobLeaseLostTotal.labels(job.type).inc();
      logger.warn(
        { jobId: job.id },
        "job was reaped during execution — skipping failure update to avoid double-counting",
      );
      return;
    }
    // OPS-01: 记录重试或终态
    if (failure.status === "pending") {
      jobRetriesTotal.labels(job.type).inc();
    } else {
      // dead — 终态
      jobTerminalTotal.labels(job.type, "dead").inc();
    }
    logger.error(
      {
        jobId: job.id,
        error: message,
        attempts: failure.attempts,
        backoffMs: failure.backoffMs,
      },
      "job failed",
    );
  }
}

// 追踪在途 job 的 Promise，用于优雅关停时等待全部完成。
// semaphore 模型：tick() 不再 await 所有 job 完成后才认领下一批，
// 而是每个 slot 空闲后立即在下次 tick 补充，避免慢 job 堵塞快 job 的 slot。
const inflight = new Set<Promise<void>>();

async function tick(): Promise<void> {
  // F-010: 先回收悬挂作业
  const reaped = await reapStaleJobs();
  if (reaped.total > 0) {
    logger.warn(
      {
        count: reaped.total,
        pending: reaped.pending,
        dead: reaped.dead,
        ids: reaped.ids,
      },
      "reaped stale running jobs",
    );
  }

  // F-010: 优雅关停时不认领新作业
  if (shuttingDown) return;

  // 只 claim 需要补充的 job 数量，每个 job 独立处理（fire-and-forget）。
  // 各 handler 事务中的 advisory lock 保证并发安全：
  //   generate_card    — workspace 级锁，同 workspace 串行化
  //   align_evidence   — key point 级锁，不同 key point 可并行
  //   evaluate_validation — 输入维度锁（cardId+keyPointId+userId+question+userAnswer），
  //                         防止相同输入的不同 job 并发写入重复 validation_events
  // AI 模型调用是网络 IO，并行处理可让多个 job 的模型调用同时进行。
  const available = QUEUE_CONCURRENCY - inflight.size;
  if (available <= 0) return;

  const candidates = await claimJobs(undefined, available);

  for (const job of candidates) {
    const promise = processJob(job).catch((err) => {
      // processJob 内部已有完整的 try/catch，此 catch 仅防止意外 rejection。
      logger.error(
        { jobId: job.id, err },
        "job processing rejected unexpectedly",
      );
    });
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise));
  }
}

async function main() {
  // OPS-01: 启动 Prometheus metrics HTTP 服务器（ADR-0006 §1）
  const metricsPort = Number(process.env.WORKER_METRICS_PORT ?? 9100);
  const metricsServer = startMetricsServer(metricsPort);
  logger.info({ port: metricsPort }, "worker metrics server started");

  logger.info(
    {
      leaseTimeoutMs: RESOLVED_TIMEOUT_INFO.leaseTimeoutMs,
      maxAllowedTimeoutMs: RESOLVED_TIMEOUT_INFO.maxAllowedTimeoutMs,
      defaultTimeouts: RESOLVED_TIMEOUT_INFO.defaultTimeouts,
      envOverrides: {
        global: process.env.WORKER_MODEL_TIMEOUT_MS,
        generate_card: process.env.WORKER_TIMEOUT_GENERATE_CARD_MS,
        evaluate_validation: process.env.WORKER_TIMEOUT_EVALUATE_VALIDATION_MS,
        align_evidence: process.env.WORKER_TIMEOUT_ALIGN_EVIDENCE_MS,
        parse_source: process.env.WORKER_TIMEOUT_PARSE_SOURCE_MS,
      },
    },
    "handler timeout configuration resolved",
  );

  logger.info(
    { concurrency: QUEUE_CONCURRENCY, pollMs: POLL_MS },
    "AI worker started, polling for jobs…",
  );
  try {
    while (true) {
      try {
        await tick();
      } catch (err) {
        logger.error({ err }, "tick failed");
      }
      // F-010: 优雅关停 — 不再认领新作业，等待在途 job 完成后退出。
      if (shuttingDown) {
        if (inflight.size > 0) {
          logger.info(
            { inflight: inflight.size },
            "shutdown signal received, waiting for in-flight jobs to finish…",
          );
          await Promise.allSettled([...inflight]);
        }
        logger.info("shutdown complete, exiting");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    metricsServer.close();
    await closeDatabase();
  }
}

main().catch((err) => {
  logger.error({ err }, "AI worker stopped unexpectedly");
  process.exitCode = 1;
});
