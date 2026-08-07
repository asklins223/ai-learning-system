// A3（计划 §2.3）：显式配置 undici 连接池参数。
// Node.js 20+ 内置 undici 默认池，但参数不可调。
// 通过 setGlobalDispatcher 显式配置，使生产环境可通过环境变量调参。
import { initHttpPool } from "./lib/http-pool.ts";
initHttpPool();

import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { logger } from "./lib/logger.ts";
import postgres from "postgres";
import { closeDatabase, db, resolveWorkerDatabaseUrl, withWorkerWorkspaceTransaction } from "./db.ts";
import { NOTIFY_CHANNEL } from "./lib/job-notify.ts";
import * as schema from "./schema/index.ts";
import { runAlignEvidence, runEvaluateValidation, type JobPayload } from "./handlers/index.ts";
import { runParseSource } from "./handlers/parse-source.ts";
import { runGenerateValidationQuestion } from "./handlers/generate-validation-question.ts";
import { runEvaluateRubric } from "./handlers/evaluate-rubric.ts";
import { runCardSupervisorAgent } from "./handlers/card-supervisor-agent.ts";
import { reconcileSupervisorAgentRuns } from "./agent/reconciler.ts";

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
import { safeErrorMessage, sanitizeOperationalError, NON_TERMINAL_UNIT_STATUSES } from "@ailearn/shared";
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
  jobOldestPendingAgeSeconds,
  jobQueueDepth,
  JOB_STATUSES,
  startMetricsServer,
} from "./lib/metrics.ts";

const HANDLERS = {
  // Supervisor Agent v1：唯一 Agent job type（计划 §5.2）
  execute_card_agent_turn: runCardSupervisorAgent,
  align_evidence: runAlignEvidence,
  evaluate_validation: dispatchEvaluateValidation,
  parse_source: runParseSource,
  generate_validation_question: runGenerateValidationQuestion,
} as const;

const POLL_MS = 500;
const POLL_MAX_MS = 5_000; // QUAL-08: max backoff when queue is idle
const QUEUE_METRICS_REFRESH_MS = 5_000;
let lastQueueMetricsRefreshAt = 0;
let currentPollMs = POLL_MS; // adaptive: grows when idle, resets on activity
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

// Agent job 的 payload 结构与文本管线 job 不同（使用 agentUnitId 而非
// generationUnitId，且没有 noteVersionId），需要独立的失败投影路径。
const AGENT_TERMINAL_RUN_STATUSES = new Set([
  "needs_attention",
  "partial_ready",
  "succeeded",
  "cancelled",
  "superseded",
]);

async function projectGenerationFailure(
  job: ClaimedJob,
  error: unknown,
  terminal: boolean,
  retryable: boolean,
): Promise<boolean> {
  if (!job.payload.generationRunId) return false;
  try {
    if (job.type === "execute_card_agent_turn") {
      return await projectAgentJobFailure({
        job,
        error,
        terminal,
        retryable,
      });
    }
    return false;
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
    return false;
  }
}

/**
 * Agent job (execute_card_agent_turn) 的失败投影。
 *
 * Agent job 的 payload 使用 agentUnitId（而非 generationUnitId）且没有
 * noteVersionId，需要独立的失败投影路径。
 *
 * 非终态失败时，agent handler 的 catch 块已将 unit 标记为 retryable_failed，
 * 此处无需重复操作，直接返回 false。
 *
 * 终态失败时，将 unit 标记为 terminal_failed，原子取消同一 run 下所有
 * 非终态 unit，并将 run 标记为 needs_attention。
 */
async function projectAgentJobFailure(input: {
  job: ClaimedJob;
  error: unknown;
  terminal: boolean;
  retryable: boolean;
}): Promise<boolean> {
  const agentUnitId = input.job.payload.agentUnitId;
  const runId = input.job.payload.generationRunId;
  if (typeof agentUnitId !== "string" || typeof runId !== "string") return false;

  // 非终态：agent handler 已标记 unit 为 retryable_failed，无需额外投影
  if (!input.terminal) return false;

  const sanitized = sanitizeOperationalError(input.error);
  const errorCode = `agent_${sanitized.category}`;

  return withWorkerWorkspaceTransaction(
    { workspaceId: input.job.workspaceId, userId: input.job.requestedBy },
    async (tx) => {
      const [run] = await tx
        .select({
          id: schema.cardGenerationRuns.id,
          workspaceId: schema.cardGenerationRuns.workspaceId,
          status: schema.cardGenerationRuns.status,
          stateVersion: schema.cardGenerationRuns.stateVersion,
          nextEventSequence: schema.cardGenerationRuns.nextEventSequence,
        })
        .from(schema.cardGenerationRuns)
        .where(and(
          eq(schema.cardGenerationRuns.id, runId),
          eq(schema.cardGenerationRuns.workspaceId, input.job.workspaceId),
        ))
        .for("update");
      if (!run || AGENT_TERMINAL_RUN_STATUSES.has(run.status)) return false;

      const now = new Date();

      // 标记当前 unit 为 terminal_failed
      await tx
        .update(schema.cardGenerationUnits)
        .set({
          status: "terminal_failed",
          errorCode,
          finishedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(schema.cardGenerationUnits.id, agentUnitId),
          eq(schema.cardGenerationUnits.workspaceId, input.job.workspaceId),
        ));

      // 原子取消同一 run 下所有非终态 unit（保留 waiting_child parent 链）。
      // 检查点保留修复：waiting_child 的 parent 正在等它的子任务完成，是重试恢复的
      // 关键链路。若把 parent 也取消，用户 `/retry` 重排队失败的子任务后，
      // resumeParentSupervisorIfNeeded 因 parent 已终态而无法恢复，run 会永久卡死。
      // 因此只取消 pending/running/retryable_failed 等兄弟 unit，保留 waiting_child。
      await tx
        .update(schema.cardGenerationUnits)
        .set({
          status: "cancelled",
          finishedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(schema.cardGenerationUnits.runId, runId),
          eq(schema.cardGenerationUnits.workspaceId, input.job.workspaceId),
          inArray(schema.cardGenerationUnits.status, NON_TERMINAL_UNIT_STATUSES),
          ne(schema.cardGenerationUnits.id, agentUnitId),
          ne(schema.cardGenerationUnits.status, "waiting_child"),
        ));

      // 标记 run 为 needs_attention
      await tx
        .update(schema.cardGenerationRuns)
        .set({
          status: "needs_attention",
          stateVersion: sql`${schema.cardGenerationRuns.stateVersion} + 1`,
          nextEventSequence: sql`${schema.cardGenerationRuns.nextEventSequence} + 1`,
          errorCode,
          retryable: input.retryable,
          updatedAt: now,
          finishedAt: now,
        })
        .where(and(
          eq(schema.cardGenerationRuns.id, run.id),
          eq(schema.cardGenerationRuns.workspaceId, run.workspaceId),
          eq(schema.cardGenerationRuns.stateVersion, run.stateVersion),
        ));

      return true;
    },
  );
}

/**
 * 关键补漏:SQL reaper 只翻转 jobs 行。worker 崩溃/断电后被 reaper 判死的
 * generation job,如果不在这里投影回 run/unit,对应检查点会永远停在
 * "running",整个 run 卡死且 /retry 也捞不到它。lease 已失效,但失败
 * 投影本身不依赖 lease(走 workspace 事务 + run 行锁),可以安全补账。
 */
async function projectReapedGenerationJobs(reapedIds: string[]): Promise<number> {
  if (reapedIds.length === 0) return 0;
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
    return 0;
  }
  let projected = 0;
  // PERF-46/62 修复：将串行处理改为分批并行处理。
  // 每个 dead job 的 failure projection 涉及独立的事务（workspace 事务 + 行锁），
  // 不同 workspace/run 之间无依赖关系，可以安全并行。
  // 使用每批 10 个的并发度，避免同时开启过多事务。
  const BATCH_SIZE = 10;
  for (let i = 0; i < deadRows.length; i += BATCH_SIZE) {
    const batch = deadRows.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (row) => {
        if (!row.generationRunId) return false;
        const updated = await projectGenerationFailure(
          {
            id: row.id,
            type: row.type,
            payload: (row.payload ?? {}) as Record<string, unknown>,
            workspaceId: row.workspaceId,
            requestedBy: row.requestedBy,
            attempts: row.attempts ?? 0,
            // lease 已失效，但失败投影不依赖 lease（workspace 事务 + 行锁）
            leaseToken: "",
          },
          row.lastError
            ?? new Error("job lease expired and was reaped (worker crash or stall)"),
          true,
          true,
        );
        return updated;
      }),
    );
    projected += results.filter(Boolean).length;
  }
  return projected;
}

/**
 * Recover the narrow crash window where a queue job reached `dead` but its
 * generation checkpoint projection failed (for example because the process
 * restarted between the two transactions). Without this startup sweep the
 * unit can remain `running` forever even though no active queue job exists.
 *
 * Select only the latest job for each generation unit. Older dead attempts
 * must never overwrite a newer pending/running/succeeded retry.
 */
export async function reconcileTerminalGenerationJobs(): Promise<number> {
  const batchSize = 500;
  const maxBatches = 10;
  let projectedTotal = 0;
  let skippedBatches = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await db.execute<{ id: string }>(sql`
      WITH latest_generation_jobs AS (
        SELECT DISTINCT ON (generation_unit_id)
          id,
          generation_run_id,
          generation_unit_id,
          status
        FROM public.jobs
        WHERE generation_run_id IS NOT NULL
          AND generation_unit_id IS NOT NULL
          AND scheduled_at >= clock_timestamp() - interval '30 days'
        ORDER BY
          generation_unit_id,
          COALESCE(finished_at, started_at, scheduled_at) DESC,
          id DESC
      )
      SELECT latest.id
      FROM latest_generation_jobs AS latest
      JOIN public.card_generation_units AS generation_unit
        ON generation_unit.id = latest.generation_unit_id
      JOIN public.card_generation_runs AS generation_run
        ON generation_run.id = latest.generation_run_id
      WHERE latest.status = 'dead'
        AND generation_unit.status NOT IN (
          'succeeded',
          'terminal_failed',
          'cancelled',
          'superseded'
        )
        AND generation_run.status NOT IN (
          'needs_attention',
          'partial_ready',
          'succeeded',
          'cancelled',
          'superseded'
        )
      ORDER BY latest.id
      LIMIT ${batchSize}
    `) as unknown as Array<{ id: string }>;
    if (rows.length === 0) break;

    // ARCH-08 fix: Wrap batch projection in try/catch and continue the loop
    // even when a batch yields 0 projections. Previously, a batch returning
    // 0 projected jobs would break the loop, leaving subsequent batches of
    // dead jobs unprocessed until the next restart. Now we only break when
    // there are no more rows to process (rows.length < batchSize means we've
    // consumed all dead jobs).
    let projected = 0;
    try {
      projected = await projectReapedGenerationJobs(rows.map((row) => row.id));
      projectedTotal += projected;
    } catch (error) {
      // Log and continue — individual job projections inside
      // projectReapedGenerationJobs already have their own try/catch, but
      // a catastrophic failure (e.g., DB disconnect) should not prevent
      // the next batch from being attempted.
      logger.error(
        { batch, error: sanitizeOperationalError(error) },
        "reconcileTerminalGenerationJobs: batch projection failed, continuing to next batch",
      );
      skippedBatches += 1;
    }

    if (rows.length < batchSize) break;
  }
  if (skippedBatches > 0) {
    logger.warn(
      { skippedBatches, projectedTotal },
      "reconcileTerminalGenerationJobs: some batches were skipped due to errors; remaining dead jobs will be retried on next startup",
    );
  }
  return projectedTotal;
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
    // ARCH-04 设计权衡说明：
    // 开发环境在 detail 字段中记录原始 error message（可能含 SQL 参数等敏感信息），
    // 生产环境仅使用 sanitizeOperationalError 脱敏后的安全版本。
    // 这是有意的隐私设计——生产环境绝不在日志中暴露可能包含用户数据的原始错误。
    // 代价是生产环境调试时需要通过 safeError 中的分类信息推断根因。
    // detail 字段绕过 pino 的 err/error 序列化器（会剥离 message），使根因可见。
    if (process.env.NODE_ENV === "development") {
      logger.warn(
        {
          jobId: job.id,
          type: job.type,
          detail: err instanceof Error ? err.message : String(err),
          ...(err instanceof Error && err.cause
            ? { cause: err.cause instanceof Error ? err.cause.message : String(err.cause) }
            : {}),
        },
        "job error detail (development)",
      );
    }
    const autoRetry = !(isNonRetryableError(err) || isNonRetryableError(message));
    jobDurationSeconds.labels(job.type).observe((Date.now() - jobStart) / 1000);

    // 非重试错误（欠费/鉴权/配置）直接标记 dead，不浪费重试次数。
    if (!autoRetry) {
      const failure = await markJobDead(job, message);
      if (!failure.updated) {
        jobLeaseLostTotal.labels(job.type).inc();
        logger.warn(
          { jobId: job.id },
          "job was reaped during execution — skipping non-retryable dead update to avoid double-counting",
        );
        return;
      }
      await projectGenerationFailure(
        job,
        err,
        true,
        false,
      );
      jobNonRetryableDeadTotal.labels(job.type).inc();
      jobTerminalTotal.labels(job.type, "dead").inc();
      logger.error(
        {
          jobId: job.id,
          error: safeError,
          reason: "non-retryable",
          ...(process.env.NODE_ENV === "development"
            ? { detail: err instanceof Error ? err.message : String(err) }
            : {}),
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
      await projectGenerationFailure(
        job,
        err,
        false,
        true,
      );
      jobRetriesTotal.labels(job.type).inc();
    } else {
      // dead — 终态
      await projectGenerationFailure(
        job,
        err,
        true,
        true,
      );
      jobTerminalTotal.labels(job.type, "dead").inc();
    }
    logger.error(
      {
        jobId: job.id,
        error: safeError,
        attempts: failure.attempts,
        backoffMs: failure.backoffMs,
        ...(process.env.NODE_ENV === "development"
          ? { detail: err instanceof Error ? err.message : String(err) }
          : {}),
      },
      "job failed",
    );
  }
}

// 追踪在途 job 的 Promise，用于优雅关停时等待全部完成。
// semaphore 模型：tick() 不再 await 所有 job 完成后才认领下一批，
// 而是每个 slot 空闲后立即在下次 tick 补充，避免慢 job 堵塞快 job 的 slot。
//
// ARCH-03 修复：内存背压控制
// 在固定并发数（QUEUE_CONCURRENCY）的基础上，增加内存使用监控。
// 当进程堆内存超过阈值时，暂停认领新 job，防止多个重型 job 同时运行导致 OOM。
// 内存阈值默认为 1.5GB（可通过环境变量 WORKER_MEMORY_LIMIT_MB 配置）。
const WORKER_MEMORY_LIMIT_MB = Number(process.env.WORKER_MEMORY_LIMIT_MB ?? 1536);
// 记录上次跳过认领的时间，避免日志刷屏
let lastMemorySkipLogAt = 0;

/**
 * 检查当前进程内存使用是否在安全范围内。
 * 如果堆内存使用超过阈值，返回 false 并记录警告日志。
 */
function isMemoryAvailable(): boolean {
  const memUsage = process.memoryUsage();
  const heapUsedMB = memUsage.heapUsed / (1024 * 1024);
  if (heapUsedMB > WORKER_MEMORY_LIMIT_MB) {
    // 每 30 秒最多记录一次警告，避免日志刷屏
    const now = Date.now();
    if (now - lastMemorySkipLogAt > 30_000) {
      lastMemorySkipLogAt = now;
      logger.warn(
        {
          heapUsedMB: Math.round(heapUsedMB),
          limitMB: WORKER_MEMORY_LIMIT_MB,
          rssMB: Math.round(memUsage.rss / (1024 * 1024)),
          inflight: inflight.size,
        },
        "内存使用超过阈值，暂停认领新 job（ARCH-03 背压控制）",
      );
    }
    return false;
  }
  return true;
}

const inflight = new Set<Promise<void>>();

async function refreshQueueMetrics(nowMs = Date.now()): Promise<void> {
  if (nowMs - lastQueueMetricsRefreshAt < QUEUE_METRICS_REFRESH_MS) return;
  lastQueueMetricsRefreshAt = nowMs;
  try {
    const [depthRows, ageRows] = await Promise.all([
      db.execute<{ status: string; total: number }>(sql`
        SELECT status::text AS status, count(*)::integer AS total
        FROM public.jobs
        GROUP BY status
      `) as unknown as Promise<Array<{ status: string; total: number }>>,
      db.execute<{ oldest_pending_age_seconds: number }>(sql`
        SELECT COALESCE(
          EXTRACT(EPOCH FROM (clock_timestamp() - min(scheduled_at))),
          0
        )::double precision AS oldest_pending_age_seconds
        FROM public.jobs
        WHERE status = 'pending'
      `) as unknown as Promise<Array<{ oldest_pending_age_seconds: number }>>,
    ]);
    for (const status of JOB_STATUSES) {
      jobQueueDepth.labels(status).set(0);
    }
    for (const row of depthRows) {
      if ((JOB_STATUSES as readonly string[]).includes(row.status)) {
        jobQueueDepth.labels(row.status).set(Number(row.total));
      }
    }
    jobOldestPendingAgeSeconds.set(
      Math.max(0, Number(ageRows[0]?.oldest_pending_age_seconds ?? 0)),
    );
  } catch (error) {
    logger.warn(
      { error: sanitizeOperationalError(error) },
      "failed to refresh queue metrics",
    );
  }
}

export async function tick(): Promise<void> {
  // ARCH-07: Check shutdown first — skip reapStaleJobs and metrics refresh
  // during graceful shutdown to avoid unnecessary database queries.
  if (shuttingDown) return;

  // PERF-05 修复：refreshQueueMetrics 和 reapStaleJobs 可以并行执行
  // 因为两者互不依赖，避免空闲队列的 tick 延迟叠加
  const [, reaped] = await Promise.all([
    refreshQueueMetrics(),
    reapStaleJobs(),
  ]);
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

  // ARCH-03 修复：内存背压检查
  // 当进程堆内存超过阈值时，暂停认领新 job，等待现有 job 完成释放内存
  if (!isMemoryAvailable()) return;

  // 只 claim 需要补充的 job 数量，每个 job 独立处理（fire-and-forget）。
  // 各 handler 事务中的 advisory lock 保证并发安全：
  //   execute_card_agent_turn — workspace 级锁，同 workspace 串行化
  //   align_evidence   — key point 级锁，不同 key point 可并行
  //   evaluate_validation — 输入维度锁（cardId+keyPointId+userId+question+userAnswer），
  //                         防止相同输入的不同 job 并发写入重复 validation_events
  // AI 模型调用是网络 IO，并行处理可让多个 job 的模型调用同时进行。
  const available = QUEUE_CONCURRENCY - inflight.size;
  if (available <= 0) return;

  const candidates = await claimJobs(undefined, available);

  // QUAL-08: Adaptive polling — reset to fast poll when jobs are found,
  // exponentially back off when queue is idle.
  if (candidates.length > 0) {
    currentPollMs = POLL_MS;
  } else {
    currentPollMs = Math.min(POLL_MAX_MS, currentPollMs * 2);
  }

  for (const job of candidates) {
    // BUG-10 修复：确保 finally 总是执行，即使 catch 中抛出异常
    const promise = processJob(job).catch((err) => {
      // processJob 内部已有完整的 try/catch，此 catch 仅防止意外 rejection。
      logger.error(
        { jobId: job.id, err },
        "job processing rejected unexpectedly",
      );
      return undefined; // 确保返回一个 resolved promise，finally 会执行
    });
    inflight.add(promise);
    // BUG-10 修复：使用 .then().catch().finally() 链确保 inflight.delete 总是执行
    promise.then(() => inflight.delete(promise)).catch(() => inflight.delete(promise));
  }
}

export async function main() {
  // OPS-01: 启动 Prometheus metrics HTTP 服务器（ADR-0006 §1）
  const metricsPort = Number(process.env.WORKER_METRICS_PORT ?? 9100);
  const metricsServer = startMetricsServer(metricsPort);
  logger.info({ port: metricsPort }, "worker metrics server started");

  // P4-6 接线: LISTEN/NOTIFY 快速唤醒(轮询分级兜底保留,计划 §5.4)。
  // Notify 到达 → 重置轮询间隔为快速档(≤POLL_MS 即再次 poll),
  // 缩短空闲背退 2s→500ms 级唤醒延迟。失败仅警告,回退纯轮询。
  let notifyConnection: ReturnType<typeof postgres> | undefined;
  try {
    if (process.env.WORKER_DISABLE_NOTIFY !== "1") {
      const pgListen = postgres(resolveWorkerDatabaseUrl(), { max: 1 });
      // 先赋值:listen 失败也要在 catch/finally 关闭,防连接泄漏阻塞进程退出
      notifyConnection = pgListen;
      // 建立超时 3s:连接挂起(如网络/权限)不能阻塞 worker 启动(shutdown 依赖进入主循环)
      const listenPromise = pgListen.listen(NOTIFY_CHANNEL, () => {
        currentPollMs = POLL_MS;
        logger.debug({ channel: NOTIFY_CHANNEL }, "P4-6: job notify 唤醒,轮询加速");
      });
      await Promise.race([
        listenPromise,
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error("LISTEN 建立超时(3s)")), 3_000);
          t.unref();
        }),
      ]);
      logger.info({ channel: NOTIFY_CHANNEL }, "P4-6: worker LISTEN 已建立(notify 快速唤醒)");
    }
  } catch (err) {
    if (notifyConnection) {
      await notifyConnection.end({ timeout: 2 }).catch(() => undefined);
      notifyConnection = undefined;
    }
    logger.warn({ err }, "P4-6: LISTEN 建立失败,回退纯轮询兜底");
  }

  logger.info(
    {
      leaseTimeoutMs: RESOLVED_TIMEOUT_INFO.leaseTimeoutMs,
      maxAllowedTimeoutMs: RESOLVED_TIMEOUT_INFO.maxAllowedTimeoutMs,
      defaultTimeouts: RESOLVED_TIMEOUT_INFO.defaultTimeouts,
      envOverrides: {
        global: process.env.WORKER_MODEL_TIMEOUT_MS,
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
    const reconciled = await reconcileTerminalGenerationJobs();
    if (reconciled > 0) {
      logger.warn(
        { projectedJobs: reconciled },
        "reconciled terminal generation jobs left without a durable checkpoint projection",
      );
    }
  } catch (error) {
    logger.error(
      { error: sanitizeOperationalError(error) },
      "startup generation projection reconciliation failed",
    );
  }
  // P0-06b: 启动时执行 Supervisor Agent reconciler
  try {
    const supResult = await reconcileSupervisorAgentRuns();
    if (supResult.cancelledUnits > 0 || supResult.resumedParents > 0) {
      logger.warn(
        supResult,
        "startup supervisor agent reconciliation: cleaned up dangling units and resumed stuck parents",
      );
    }
  } catch (error) {
    logger.error(
      { error: sanitizeOperationalError(error) },
      "startup supervisor agent reconciliation failed",
    );
  }
  // P0-06b: 定时执行 Supervisor Agent reconciler（每 60 秒）
  const RECONCILER_INTERVAL_MS = 60_000;
  const reconcilerTimer = setInterval(async () => {
    try {
      await reconcileSupervisorAgentRuns();
    } catch (error) {
      logger.error(
        { error: sanitizeOperationalError(error) },
        "periodic supervisor agent reconciliation failed",
      );
    }
  }, RECONCILER_INTERVAL_MS);
  reconcilerTimer.unref(); // 不阻止进程退出
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
          // 修复：优雅关停 drain 必须有界。某个 handler（如底层 provider 调用不响应
          // abort）可能永远不结束，worker 会一直等，最后被 SIGKILL 强杀，在途 job
          // 遗留在 running 状态且 lease 未释放，整个 run 永久卡住（reaper 只在 tick 里跑）。
          // 到点后强制退出，遗留 job 由下一个 worker 启动时的 reapStaleJobs 回收。
          const drainTimeoutMs = Math.max(
            1_000,
            Number(process.env.WORKER_DRAIN_TIMEOUT_MS ?? 45_000),
          );
          const drainDeadline = new Promise<void>((resolve) => {
            const t = setTimeout(resolve, drainTimeoutMs);
            t.unref();
          });
          await Promise.race([
            Promise.allSettled([...inflight]),
            drainDeadline,
          ]);
          if (inflight.size > 0) {
            logger.warn(
              { inflight: inflight.size, drainTimeoutMs },
              "drain timeout reached, exiting anyway (orphaned running jobs will be reaped by the next worker startup)",
            );
          }
        }
        logger.info("shutdown complete, exiting");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, currentPollMs));
    }
  } finally {
    clearInterval(reconcilerTimer);
    if (notifyConnection) {
      await notifyConnection.end({ timeout: 2 }).catch(() => undefined);
    }
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
