// P2-1: Node.js 20+ fetch 内部已使用 undici 连接池并默认开启 keep-alive。
// 全局 fetch 会自动复用 TCP+TLS 连接，无需显式配置 Agent。
// 如需进一步调优连接池参数，可安装 undici npm 包并使用 setGlobalDispatcher。

import { and, eq, inArray } from "drizzle-orm";
import { logger } from "./lib/logger.ts";
import { closeDatabase, db } from "./db.ts";
import * as schema from "./schema/index.ts";
import { runGenerateCard, runAlignEvidence, runEvaluateValidation, type JobPayload } from "./handlers/index.ts";
import { runParseSource } from "./handlers/parse-source.ts";
import { runGenerateValidationQuestion } from "./handlers/generate-validation-question.ts";
import { runEvaluateRubric } from "./handlers/evaluate-rubric.ts";
import {
  projectTextPipelineJobFailure,
  runAnalyzeCardImage,
  runMapCardGeneration,
  runPlanCardSet,
  runPlanCardGeneration,
  runPublishCardGeneration,
  runReduceCardGeneration,
  runRenderCardGeneration,
} from "./handlers/card-generation-text.ts";

/**
 * Dispatch evaluate_validation jobs based on payload format:
 * - v0.6: payload contains `submissionId` → use runEvaluateRubric (rubric-based evaluation)
 * - v0.5: legacy payload with cardId/question/userAnswer → use runEvaluateValidation
 *
 * This ensures backward compatibility while routing new v0.6 sessions to the
 * trusted mastery closed-loop handler.
 */
function dispatchEvaluateValidation(job: JobPayload) {
  if (job.payload.submissionId) {
    return runEvaluateRubric(job);
  }
  return runEvaluateValidation(job);
}
import { runWithAbortTimeout } from "./lib/handler-timeout.ts";
import { resolveHandlerTimeout, RESOLVED_TIMEOUT_INFO } from "./lib/handler-timeout-config.ts";
import { isNonRetryableError } from "./lib/non-retryable-errors.ts";
import { safeErrorMessage, sanitizeOperationalError } from "@ailearn/shared";
import { markCardGenerationRunNeedsAttention } from "./lib/card-generation-run.ts";
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
  plan_card_generation: runPlanCardGeneration,
  analyze_card_image: runAnalyzeCardImage,
  map_card_generation: runMapCardGeneration,
  reduce_card_generation: runReduceCardGeneration,
  plan_card_set: runPlanCardSet,
  render_card_generation: runRenderCardGeneration,
  publish_card_generation: runPublishCardGeneration,
  align_evidence: runAlignEvidence,
  evaluate_validation: dispatchEvaluateValidation,
  parse_source: runParseSource,
  generate_validation_question: runGenerateValidationQuestion,
} as const;

const POLL_MS = 500;
// F-010: 模型调用超时现在按 job 类型分别配置，见 handler-timeout-config.ts
// 全局默认仍可通过 WORKER_MODEL_TIMEOUT_MS 环境变量覆盖。

// F-010: 优雅关停标志
let shuttingDown = false;
export function setupGracefulShutdown() {
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

const TEXT_GENERATION_JOB_TYPES = new Set([
  "plan_card_generation",
  "analyze_card_image",
  "map_card_generation",
  "reduce_card_generation",
  "plan_card_set",
  "render_card_generation",
  "publish_card_generation",
]);

async function projectGenerationFailure(
  job: ClaimedJob,
  error: unknown,
  terminal: boolean,
  retryable: boolean,
): Promise<void> {
  if (!job.payload.generationRunId) return;
  try {
    if (job.type === "generate_card") {
      if (!terminal) return;
      await markCardGenerationRunNeedsAttention({
        workspaceId: job.workspaceId,
        requestedBy: job.requestedBy,
        payload: job.payload,
        error,
        retryable,
      });
    } else if (TEXT_GENERATION_JOB_TYPES.has(job.type)) {
      await projectTextPipelineJobFailure({
        job,
        error,
        terminal,
        retryable,
      });
    }
  } catch (projectionError) {
    // The job terminal transition is already committed. Keep the projection
    // failure privacy-safe so reconciliation can repair the run later without
    // leaking provider/database text into logs.
    logger.error(
      {
        jobId: job.id,
        error: sanitizeOperationalError(projectionError),
      },
      "failed to project generation job state to generation run",
    );
  }
}

/**
 * 关键补漏:SQL reaper 只翻转 jobs 行。worker 崩溃/断电后被 reaper 判死的
 * generation job,如果不在这里投影回 run/unit,对应检查点会永远停在
 * "running",整个 run 卡死且 /retry 也捞不到它。lease 已失效,但失败
 * 投影本身不依赖 lease(走 workspace 事务 + run 行锁),可以安全补账。
 */
async function projectReapedGenerationJobs(reapedIds: string[]): Promise<void> {
  if (reapedIds.length === 0) return;
  let deadRows: Array<typeof schema.jobs.$inferSelect> = [];
  try {
    deadRows = await db.query.jobs.findMany({
      where: and(
        inArray(schema.jobs.id, reapedIds),
        eq(schema.jobs.status, "dead"),
      ),
    });
  } catch (error) {
    logger.error(
      { error: sanitizeOperationalError(error) },
      "failed to load reaped jobs for generation projection",
    );
    return;
  }
  for (const row of deadRows) {
    if (!row.generationRunId) continue;
    await projectGenerationFailure(
      {
        id: row.id,
        type: row.type,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        workspaceId: row.workspaceId,
        requestedBy: row.requestedBy,
        attempts: row.attempts ?? 0,
        // The lease died with the reaped worker; failure projection never
        // touches the lease fence (workspace transaction + row locks only).
        leaseToken: "",
      },
      new Error("job lease expired and was reaped (worker crash or stall)"),
      true,
      true,
    );
  }
}

// 处理单个 job 的完整生命周期（claim 后的执行 + 状态转换 + 指标记录）。
// 从 tick() 提取为独立函数以支持 fire-and-forget 并行处理。
export async function processJob(job: ClaimedJob): Promise<void> {
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
    const message = safeErrorMessage(err);
    const safeError = sanitizeOperationalError(err);
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
      await projectGenerationFailure(job, err, true, false);
      jobNonRetryableDeadTotal.labels(job.type).inc();
      jobTerminalTotal.labels(job.type, "dead").inc();
      logger.error(
        {
          jobId: job.id,
          error: safeError,
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
      await projectGenerationFailure(job, err, false, true);
      jobRetriesTotal.labels(job.type).inc();
    } else {
      // dead — 终态
      await projectGenerationFailure(job, err, true, true);
      jobTerminalTotal.labels(job.type, "dead").inc();
    }
    logger.error(
      {
        jobId: job.id,
        error: safeError,
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

export async function tick(): Promise<void> {
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
    // Reaped-to-dead generation jobs must settle their run checkpoints, or
    // the run wedges in a permanently "running" unit (see helper docstring).
    await projectReapedGenerationJobs(reaped.ids);
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

export async function main() {
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
        plan_card_generation: process.env.WORKER_TIMEOUT_PLAN_CARD_GENERATION_MS,
        analyze_card_image: process.env.WORKER_TIMEOUT_ANALYZE_CARD_IMAGE_MS,
        map_card_generation: process.env.WORKER_TIMEOUT_MAP_CARD_GENERATION_MS,
        reduce_card_generation: process.env.WORKER_TIMEOUT_REDUCE_CARD_GENERATION_MS,
        publish_card_generation: process.env.WORKER_TIMEOUT_PUBLISH_CARD_GENERATION_MS,
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

// Tests can explicitly import the lifecycle functions without starting the
// polling loop. Requiring NODE_ENV=test prevents an accidental production env
// variable from silently disabling the worker.
const autostartDisabledForTest = process.env.NODE_ENV === "test"
  && process.env.WORKER_DISABLE_AUTOSTART === "1";
if (!autostartDisabledForTest) {
  main().catch((err) => {
    logger.error({ err }, "AI worker stopped unexpectedly");
    process.exitCode = 1;
  });
}
