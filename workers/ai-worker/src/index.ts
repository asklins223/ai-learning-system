import { sql } from "drizzle-orm";
import { logger } from "./lib/logger.ts";
import postgres from "postgres";
import { closeDatabase, db, resolveWorkerStatementTimeoutMs, resolveWorkerDatabaseUrl } from "./db.ts";
import { NOTIFY_CHANNEL } from "./lib/job-notify.ts";
import { markSourceParseFailed, runParseSource } from "./handlers/parse-source.ts";
import { runCompanionDialogue } from "./handlers/companion-dialogue.ts";
import { runCompanionMemoryExtract } from "./handlers/companion-memory-extractor.ts";
import { runCompanionSummarizer } from "./handlers/companion-summarizer.ts";
import { runCompanionMemoryEmbeddingRebuild } from "./handlers/companion-memory-embedding.ts";
import { runCompanionDailySummary } from "./handlers/companion-daily-summary.ts";
import { runCompanionThought } from "./handlers/companion-thought.ts";
import { tickCompanionDailySummaryScheduler } from "./handlers/companion-daily-summary-scheduler.ts";
import { tickCompanionThoughtScheduler } from "./handlers/companion-thought-scheduler.ts";
import { tickCompanionMemoryMaintenance } from "./handlers/companion-memory-maintenance.ts";
import { tickCompanionProposalExpiry } from "./handlers/companion-proposal-expiry-scheduler.ts";
import { tickCompanionRunReconcile } from "./handlers/companion-run-reconcile-scheduler.ts";
import { tickCompanionReminderDelivery } from "./handlers/companion-reminder-scheduler.ts";
import {
  getV2OutboxInflightCount,
  pollV2Outbox,
  releaseInflightV2OutboxLeases,
  V2_POLL_TICK_BUDGET_MS,
  waitForV2OutboxDrain,
} from "./handlers/card-generation-v2-handler.ts";

import { runWithAbortTimeout } from "./lib/handler-timeout.ts";
import { resolveHandlerTimeout, RESOLVED_TIMEOUT_INFO } from "./lib/handler-timeout-config.ts";
import { isNonRetryableError } from "./lib/non-retryable-errors.ts";
import { createPollWakeSignal } from "./lib/poll-wakeup.ts";
import { JobResourceClass, readJobPayloadString, safeErrorMessage, sanitizeOperationalError } from "@ailearn/shared";
import { computeClaimLimits } from "./lib/worker-concurrency.ts";
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
  resolveMetricsPort,
  startMetricsServer,
} from "./lib/metrics.ts";

const HANDLERS = {
  parse_source: runParseSource,
  // Companion Agent：统一对话入口（payload 只含 opaque runId）
  companion_agent: runCompanionDialogue,
  // 22 真桌宠记忆与上下文：日常提取 / 会话摘要 / embedding 重建
  companion_memory_extract: runCompanionMemoryExtract,
  companion_summarizer: runCompanionSummarizer,
  companion_memory_embedding_rebuild: runCompanionMemoryEmbeddingRebuild,
  companion_daily_summary: runCompanionDailySummary,
  // 念头管线切片②（2026-09-18）：候选念头生成 + 表达 + 送达。
  companion_thought: runCompanionThought,
} as const;

/**
 * 判死时的收尾（审计 F32 / F27 剩下的那半）。
 *
 * 通用 job 循环只认识 `jobs` 那张表；而"这一次失败"对用户意味着什么，只有各类型自己
 * 知道——采集失败就该让 `sources.status` 变成 `failed`（列表显示"解析失败"、
 * 详情给"重新解析"），否则界面永远说"待解析/正在解析"。收尾失败只记日志：
 * job 已经是终态，这里再抛只会让人以为终态没写成。
 */
const DEAD_FINALIZERS: Partial<Record<string, (job: { id: string; workspaceId: string; requestedBy: string | null; payload: Record<string, unknown>; leaseToken: string; signal?: AbortSignal }, message: string) => Promise<void>>> = {
  parse_source: markSourceParseFailed,
};

const POLL_MS = 500;
const POLL_MAX_MS = 5_000; // QUAL-08: max backoff when queue is idle

/**
 * 终态转换（ailearn_finish_job / ailearn_fail_job / markUnknownJobFailed）的墙钟上界。
 *
 * 稳定 P0-5（2026-09-15 审计）：这些调用此前是裸 `await`，且连接池没有
 * statement_timeout——一条挂起的语句（锁等待/半开连接）会让 processJob 的
 * promise 永不 settle：`inflight.delete` 不执行 → `available <= 0` → worker
 * 永久停止 claim，而 `/metrics` 仍返回 200、编排器不会重启，队列静默停摆。
 *
 * 现在 DB 侧 statement_timeout（db.ts，默认 60s）会先杀掉语句，所以正常情况下
 * 拿到的是真实 DB 错误；这里 JS 侧的竞速是第二道保险（驱动/socket 层挂起，
 * DB 超时覆盖不到），取 statement_timeout + 5s 余量。
 */
const TERMINAL_TRANSITION_TIMEOUT_MS = resolveWorkerStatementTimeoutMs() + 5_000;
const QUEUE_METRICS_REFRESH_MS = 5_000;
let lastQueueMetricsRefreshAt = 0;
/**
 * 孤儿 job 回收（reapStaleJobs）的节流间隔（稳定 P1-5，2026-09-15 审计）。
 * 租约为 120s，30s 粒度足够；避免每个 tick（可低至 500ms）全表扫 jobs。
 */
const REAP_THROTTLE_MS = 30_000;
let lastReapAt = 0;
let currentPollMs = POLL_MS; // adaptive: grows when idle, resets on activity
// F-010: 模型调用超时现在按 job 类型分别配置，见 handler-timeout-config.ts
// 全局默认仍可通过 WORKER_MODEL_TIMEOUT_MS 环境变量覆盖。

// F-010: 优雅关停标志
let shuttingDown = false;
const pollWake = createPollWakeSignal();
export function setupGracefulShutdown() {
  const handler = () => {
    if (!shuttingDown) {
      shuttingDown = true;
      pollWake.wake();
      logger.info("received shutdown signal, finishing current job…");
    }
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  // 2026-08-11：全局异步错误兜底——Node≥15 默认 unhandledRejection 直接 crash，
  // 单点意外 rejection（DB 连接抖动、第三方库边缘）即崩整个 worker，在途 job
  // 遗留、租约悬挂。记录并尝试优雅退出（shuttingDown 路径已处理 drain）。
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason) }, "unhandledRejection — exiting");
    process.exitCode = 1;
    process.kill(process.pid, "SIGTERM");
  });
  process.on("uncaughtException", (error) => {
    logger.error({ err: error }, "uncaughtException — exiting");
    process.exitCode = 1;
    process.kill(process.pid, "SIGTERM");
  });
}
setupGracefulShutdown();

// 处理单个 job 的完整生命周期（claim 后的执行 + 状态转换 + 指标记录）。
// 从 tick() 提取为独立函数以支持 fire-and-forget 并行处理。
export async function processJob(job: ClaimedJob): Promise<void> {
  // 设计 P1-15（2026-09-15 审计）：payload 里携带的"发起该 job 的 API 请求 id"，
  // 打进本 job 的关键日志，使 API 日志与 worker 日志可用同一 id 关联
  // （此前跨进程排障只能靠猜）。旧 job/直连 job 没有该字段时为 undefined，
  // 不影响既有日志结构。
  const traceId = readJobPayloadString(job.payload, "traceId");
  const handler = HANDLERS[job.type as keyof typeof HANDLERS];
  if (!handler) {
    // 稳定 P0-5（2026-09-15 审计）：终态转换加墙钟上界，避免挂起语句永久占槽。
    const unknownUpdated = await runWithAbortTimeout(
      () => markUnknownJobFailed(job),
      TERMINAL_TRANSITION_TIMEOUT_MS,
      (lateError) => logger.error(
        { jobId: job.id, err: lateError },
        "unknown-job transition settled after deadline (reaper will reconcile)",
      ),
    ).catch((err) => {
      logger.error({ jobId: job.id, err }, "unknown-job transition failed or timed out");
      return false;
    });
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
    //
    // 稳定 P0-5（2026-09-15 审计）：加墙钟上界。超时意味着**结果未知**，因此与
    // lease 丢失同路处理——只记日志并交给 reaper 按租约回收，绝不把可能已成功的
    // job 误判成失败（那会让上层重放整条已付费管道）。
    let successUpdated: boolean;
    try {
      successUpdated = await runWithAbortTimeout(
        () => markJobSucceeded(job),
        TERMINAL_TRANSITION_TIMEOUT_MS,
        (lateError) => logger.error(
          { jobId: job.id, err: lateError },
          "success transition settled after deadline (outcome unknown; reaper will reconcile)",
        ),
      );
    } catch (terminalErr) {
      jobLeaseLostTotal.labels(job.type).inc();
      logger.error(
        { jobId: job.id, err: terminalErr },
        "job success transition failed or timed out — leaving status to lease reaper (no double state change)",
      );
      return;
    }
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
    logger.info({ jobId: job.id, type: job.type, traceId }, "job ok");
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
          traceId,
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
      // 稳定 P0-5：终态转换加墙钟上界；超时即结果未知，交给 reaper，不重试。
      const failure = await runWithAbortTimeout(
        () => markJobDead(job, message),
        TERMINAL_TRANSITION_TIMEOUT_MS,
        (lateError) => logger.error(
          { jobId: job.id, err: lateError },
          "dead transition settled after deadline (reaper will reconcile)",
        ),
      ).catch((terminalErr) => {
        logger.error(
          { jobId: job.id, err: terminalErr },
          "dead transition failed or timed out — leaving status to lease reaper",
        );
        return { updated: false, status: "dead" as const, attempts: 0, backoffMs: 0 };
      });
      if (!failure.updated) {
        jobLeaseLostTotal.labels(job.type).inc();
        logger.warn(
          { jobId: job.id, traceId },
          "job was reaped during execution — skipping non-retryable dead update to avoid double-counting",
        );
        return;
      }
      jobNonRetryableDeadTotal.labels(job.type).inc();
      jobTerminalTotal.labels(job.type, "dead").inc();
      await DEAD_FINALIZERS[job.type]?.(job, message);
      logger.error(
        {
          jobId: job.id,
          traceId,
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
    // 稳定 P0-5：同样加墙钟上界；超时即结果未知 → 交给 reaper 按租约回收。
    const failure = await runWithAbortTimeout(
      () => markJobFailed(job, message),
      TERMINAL_TRANSITION_TIMEOUT_MS,
      (lateError) => logger.error(
        { jobId: job.id, err: lateError },
        "failure transition settled after deadline (reaper will reconcile)",
      ),
    ).catch((terminalErr) => {
      logger.error(
        { jobId: job.id, err: terminalErr },
        "failure transition failed or timed out — leaving status to lease reaper",
      );
      return { updated: false, status: "pending" as const, attempts: 0, backoffMs: 0 };
    });
    if (!failure.updated) {
      // OPS-01: lease 丢失 — job 被 reaper 回收
      jobLeaseLostTotal.labels(job.type).inc();
      logger.warn(
        { jobId: job.id, traceId },
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
      await DEAD_FINALIZERS[job.type]?.(job, message);
    }
    logger.error(
      {
        jobId: job.id,
        traceId,
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
// 2026-08-11：数值 env 裸 Number() 无校验——非法值（如 "abc"）→ NaN，
// 内存背压静默失效。解析失败时回退默认值并告警。
const WORKER_MEMORY_LIMIT_MB = (() => {
  const raw = Number(process.env.WORKER_MEMORY_LIMIT_MB ?? 1536);
  if (Number.isFinite(raw) && raw > 0) return raw;
  logger.warn({ raw: process.env.WORKER_MEMORY_LIMIT_MB }, "WORKER_MEMORY_LIMIT_MB 非法，回退 1536");
  return 1536;
})();
// 记录上次跳过认领的时间，避免日志刷屏
let lastMemorySkipLogAt = 0;

/**
 * 检查当前进程内存使用是否在安全范围内。
 * 如果堆内存使用超过阈值，返回 false 并记录警告日志。
 */
/**
 * 主 tick 里的 V2 制卡 outbox 一次 poll（预算 5 秒即返回，运行中的 job 继续后台跑）。
 *
 * 抽出来是因为它原来只在**函数末尾**被调用一次，而中间有一句
 * `if (claimLimits.interactiveLimit <= 0) return;`：主队列 4 条槽都被占时（后台 job
 * 单个可跑 110 秒），整轮直接返回，V2 既不被领取也不续约心跳，最长要多等一整个
 * handler 预算才轮到。
 *
 * 注意这**不是**把 V2 挪到主队列之前——第五轮审计 W#5 明确要求 V2 排在 claim/分发
 * 之后，免得串行 poll 延迟主队列并发配额的分配。顺序照旧，只是让那条早退不再顺手
 * 跳过 V2 的义务。
 */
async function pollV2OutboxWithinTick(): Promise<void> {
  try {
    await pollV2Outbox(1, V2_POLL_TICK_BUDGET_MS);
  } catch (error) {
    logger.warn(
      { error: sanitizeOperationalError(error) },
      "V2 card generation outbox poll failed",
    );
  }
}

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

/**
 * 在途 job：promise → 队列资源类（`JobResourceClass`）。
 *
 * 记录类别是为了给下一次 claim 算名额：后台（maintenance / card_foreground）
 * 最多占用 `并发 - INTERACTIVE_RESERVE_SLOTS` 个槽位，交互车道永远留一个空位
 * （见 lib/worker-concurrency.ts 的 computeClaimLimits）。
 */
const inflight = new Map<Promise<void>, string>();

async function refreshQueueMetrics(nowMs = Date.now()): Promise<void> {
  if (nowMs - lastQueueMetricsRefreshAt < QUEUE_METRICS_REFRESH_MS) return;
  lastQueueMetricsRefreshAt = nowMs;
  try {
    const [depthRows, ageRows] = await Promise.all([
      db.execute<{ status: string; total: number }>(sql`
        SELECT * FROM public.ailearn_queue_job_depth()
      `) as unknown as Promise<Array<{ status: string; total: number }>>,
      db.execute<{ oldest_pending_age_seconds: number }>(sql`
        SELECT public.ailearn_queue_oldest_pending_age() AS oldest_pending_age_seconds
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
  //
  // 稳定 P1-5（2026-09-15 审计）：refreshQueueMetrics 早已自节流（5s），但
  // reapStaleJobs 此前**每个 tick 都全表扫**一遍 jobs（找 status='running' 且
  // 过期的行）——空闲时也是纯浪费，且 tick 的 POLL_MS 可低到 500ms。
  // 这里对齐 V2 outbox 的做法（V2_REAP_THROTTLE_MS）加 30s 节流：租约是 120s，
  // 30s 的回收粒度足够及时；重试调度由 scheduled_at + claim 负责，不依赖 reap。
  const nowMs = Date.now();
  const shouldReap = nowMs - lastReapAt >= REAP_THROTTLE_MS;
  if (shouldReap) lastReapAt = nowMs;
  const [, reaped] = await Promise.all([
    refreshQueueMetrics(nowMs),
    shouldReap
      ? reapStaleJobs()
      : Promise.resolve({ total: 0, pending: 0, dead: 0, ids: [] as string[] }),
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
  }

  // F-010: 优雅关停时不认领新作业
  if (shuttingDown) return;

  // ARCH-03 修复：内存背压检查
  // 当进程堆内存超过阈值时，暂停认领新 job，等待现有 job 完成释放内存
  if (!isMemoryAvailable()) return;

  // 22 方案：桌宠日记每日 01:00 调度 + 记忆衰减维护（内部 throttle）。
  await tickCompanionDailySummaryScheduler();
  await tickCompanionMemoryMaintenance();
  // 念头管线切片②（2026-09-18）：念头生成调度（4h 桶幂等，内部 15min 节流）。
  await tickCompanionThoughtScheduler();
  // Agent 方案 §5：过期/世代失效的确认兜底回收（内部 throttle）。
  // 不放在 claim 之后——被锁死的 conversation 没有 job 可 claim，必须在每轮
  // tick 都尝试终结，否则 run 会永久停在 waiting_for_confirmation。
  await tickCompanionProposalExpiry();
  // 方案 29 §9.3：job 已死/缺失的孤儿 run 回收。与上一条同一个理由——必须在 claim
  // 之前跑，被锁死的会话压根没有可 claim 的 job。
  await tickCompanionRunReconcile();
  // 方案 29 §4.6：到点提醒兑现（每分钟一次，函数自身幂等）。放在 claim 之前同属
  // "不依赖有没有 job 可认领"这一类后台义务。
  await tickCompanionReminderDelivery();

  // 只 claim 需要补充的 job 数量，每个 job 独立处理（fire-and-forget）。
  // AI 模型调用是网络 IO，并行处理可让多个 job 的模型调用同时进行。
  // 交互车道保留：后台 job（maintenance / card_foreground）拿不到超过
  // `并发 - INTERACTIVE_RESERVE_SLOTS` 的位置，最后一个空槽只对 interactive_ai
  // 开放（见 lib/worker-concurrency.ts 的 computeClaimLimits）。
  let inflightBackground = 0;
  for (const resourceClass of inflight.values()) {
    if (resourceClass !== JobResourceClass.INTERACTIVE_AI) inflightBackground += 1;
  }
  const claimLimits = computeClaimLimits({
    concurrency: QUEUE_CONCURRENCY,
    inflightTotal: inflight.size,
    inflightBackground,
  });
  if (claimLimits.interactiveLimit <= 0) {
    // 主队列没槽位也要把 V2 的义务走完（见 `pollV2OutboxWithinTick` 的说明）。
    await pollV2OutboxWithinTick();
    return;
  }

  // 2026-08-11：DB 错误退避——tick 顶层 DB 调用（refreshQueueMetrics/reap/
  // claimJobs）抛错时，若不做退避会以 POLL_MS 紧循环重试（DB 抖动时放大负载）。
  // 连续失败指数退避至 POLL_MAX_MS，成功即重置（当前实现退避点：claimJobs；
  // reap/refresh 抛错经 671 行 tick 的 catch 记录，仍按当前档位重试）。
  let candidates: ClaimedJob[] = [];
  try {
    candidates = await claimJobs(undefined, claimLimits);
  } catch (error) {
    // 2026-08-11：DB 错误退避——tick 顶层 DB 调用抛错时若不退避会以
    // POLL_MS 紧循环重试（DB 抖动放大负载）。复用 adaptive 机制指数退避。
    logger.error(
      { error: sanitizeOperationalError(error) },
      "claimJobs failed — backing off",
    );
    currentPollMs = Math.min(POLL_MAX_MS, currentPollMs * 2);
    return;
  }
  currentPollMs = POLL_MS;

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
    inflight.set(promise, job.resourceClass);
    // BUG-10 修复：使用 .then().catch().finally() 链确保 inflight.delete 总是执行
    promise.then(() => inflight.delete(promise)).catch(() => inflight.delete(promise));
  }

  // V2 Card Generation outbox poll (方案 20 C2)。
  if (shuttingDown) return;
  // 第五轮审计 W#5：置于主队列 claim/分发**之后**——V2 串行 poll 不能再延迟主
  // 队列并发配额（available）的分配与 claim；先按配额拿到主队列 job 并分发，
  // 最后才 poll V2。round-7 🟡2 修复：主 tick 以 V2_POLL_TICK_BUDGET_MS（5s）调用
  // poll，使本 tick 仅最多阻塞该预算即返回——V2 job 的运行（最长整套 ~8.75min）
  // 不再串行阻塞**下一 tick** 主队列的 claim/分发。超预算时 poll 返回、运行中 job
  // 继续后台跑（30min 租约 + lease CAS + reaper 兜底，不丢副作用、不重复计费）。
  // 每个 job 已 fire-and-forget（inflight），V2 poll 失败仅告警不断主循环。
  await pollV2OutboxWithinTick();
}

export async function main() {
  // OPS-01: 启动 Prometheus metrics HTTP 服务器（ADR-0006 §1）
  const metricsPort = resolveMetricsPort();
  // 稳定 P1-4（2026-09-15 审计）：暴露 /ready 做真实依赖探测（DB 可达性）。
  // 之前的健康检查只打 /metrics，DB 宕机或槽漏光时仍报健康，容器不会被重启。
  const metricsServer = startMetricsServer(metricsPort, {
    readyProbe: async () => {
      await db.execute(sql`SELECT 1`);
    },
  });
  logger.info({ port: metricsPort }, "worker metrics server started");

  // P4-6 接线: LISTEN/NOTIFY 快速唤醒(轮询分级兜底保留,计划 §5.4)。
  // Notify 到达会直接打断当前 poll sleep，而不是只影响下一轮的间隔。
  // 失败仅警告，回退纯轮询。
  let notifyConnection: ReturnType<typeof postgres> | undefined;
  try {
    if (process.env.WORKER_DISABLE_NOTIFY !== "1") {
      const pgListen = postgres(resolveWorkerDatabaseUrl(), { max: 1 });
      // 先赋值:listen 失败也要在 catch/finally 关闭,防连接泄漏阻塞进程退出
      notifyConnection = pgListen;
      // 建立超时 3s:连接挂起(如网络/权限)不能阻塞 worker 启动(shutdown 依赖进入主循环)
      const listenPromise = pgListen.listen(NOTIFY_CHANNEL, () => {
        currentPollMs = POLL_MS;
        pollWake.wake();
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
        if (inflight.size > 0 || getV2OutboxInflightCount() > 0) {
          // 先把在途的 V2 租约交还，再等 drain：dev 里 tsx watch 只给 5 秒
          // （`Process didn't exit in 5s. Force killing...`），一条付费管道跑不完。
          // 不交还的话，强杀后这条 run 的租约要挂满 30 分钟才可能被重投——那半小时里
          // 笔记被 in-flight 守卫锁住，而钱已经付过了。交还后本进程迟到的写入会被
          // 自己的 token fence 挡掉（见 releaseV2OutboxLease），不会双写。
          if (getV2OutboxInflightCount() > 0) {
            const released = await releaseInflightV2OutboxLeases().catch((error) => {
              logger.warn({ error: String(error) }, "V2 lease release on shutdown threw");
              return 0;
            });
            logger.info(
              { released, v2Inflight: getV2OutboxInflightCount() },
              "V2 outbox leases returned so the next worker can take over immediately",
            );
          }
          logger.info(
            {
              inflight: inflight.size,
              v2Inflight: getV2OutboxInflightCount(),
            },
            "shutdown signal received, waiting for in-flight jobs to finish…",
          );
          // 修复：优雅关停 drain 必须有界。某个 handler（如底层 provider 调用不响应
          // abort）可能永远不结束，worker 会一直等，最后被 SIGKILL 强杀，在途 job
          // 遗留在 running 状态且 lease 未释放，整个 run 永久卡住（reaper 只在 tick 里跑）。
          // 到点后强制退出，遗留 job 由下一个 worker 启动时的 reapStaleJobs 回收。
          // 2026-08-11：非法值（NaN）时回退默认 45s——此前 NaN 经 Math.max(1000, NaN)
          // → NaN，setTimeout(NaN) 立即触发 → 优雅关停变即时强退。
          const configuredDrainTimeoutMs = Number(process.env.WORKER_DRAIN_TIMEOUT_MS ?? 45_000);
          const drainTimeoutMs = Number.isFinite(configuredDrainTimeoutMs)
            ? Math.max(1_000, configuredDrainTimeoutMs)
            : 45_000;
          const drainDeadline = new Promise<void>((resolve) => {
            const t = setTimeout(resolve, drainTimeoutMs);
            t.unref();
          });
          await Promise.race([
            Promise.all([
              Promise.allSettled([...inflight.keys()]),
              waitForV2OutboxDrain(drainTimeoutMs),
            ]),
            drainDeadline,
          ]);
          if (inflight.size > 0 || getV2OutboxInflightCount() > 0) {
            logger.warn(
              {
                inflight: inflight.size,
                v2Inflight: getV2OutboxInflightCount(),
                drainTimeoutMs,
              },
              "drain timeout reached, exiting anyway (orphaned running jobs will be reaped by the next worker startup)",
            );
          }
        }
        logger.info("shutdown complete, exiting");
        return;
      }
      await pollWake.wait(currentPollMs);
    }
  } finally {
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
