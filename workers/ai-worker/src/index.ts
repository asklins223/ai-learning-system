import { and, eq, sql } from "drizzle-orm";
import { logger } from "./lib/logger.ts";
import * as schema from "./schema/index.ts";
import { closeDatabase, db, withWorkerWorkspaceTransaction } from "./db.ts";
import { runGenerateCard, runAlignEvidence, runEvaluateValidation } from "./handlers/index.ts";
import { runParseSource } from "./handlers/parse-source.ts";
import { runWithAbortTimeout } from "./lib/handler-timeout.ts";
import { retryBackoffMs } from "./lib/job-retry.ts";

const HANDLERS = {
  generate_card: runGenerateCard,
  align_evidence: runAlignEvidence,
  evaluate_validation: runEvaluateValidation,
  parse_source: runParseSource,
} as const;

const POLL_MS = 1500;
const MAX_ATTEMPTS = 3;
const CONCURRENCY = 1; // F-010: 每次只认领 1 条作业，串行处理避免扩大故障面
const LEASE_TIMEOUT_MS = 120_000; // F-010: 租约超时 2 分钟
const MODEL_TIMEOUT_MS = 90_000; // F-010: 模型调用超时 90 秒

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

type ClaimedJob = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  workspaceId: string;
  requestedBy: string | null;
  attempts: number;
  // G-001: 不可变 lease token — claim 时生成并写入 DB，完成/失败时以此作为原子条件
  leaseToken: string;
};

/**
 * F-010: 回收器 — 将 startedAt 超过 LEASE_TIMEOUT_MS 仍为 running 的作业重置为 pending。
 * R-007: 回收时递增 attempts，确保超时作业最终达到 MAX_ATTEMPTS 而非无限重试。
 */
async function reapStaleJobs(): Promise<number> {
  const reaped = await db.execute<{ id: string; status: string }>(sql`
    SELECT id, status
    FROM public.ailearn_reap_stale_jobs(${LEASE_TIMEOUT_MS}, ${MAX_ATTEMPTS})
  `);
  const pending = reaped.filter((row) => row.status === "pending");
  const dead = reaped.filter((row) => row.status === "dead");
  const total = reaped.length;
  if (total > 0) {
    logger.warn(
      {
        count: total,
        pending: pending.length,
        dead: dead.length,
        ids: reaped.map((row) => row.id),
      },
      "reaped stale running jobs",
    );
  }
  return total;
}

/**
 * 原子抢占待执行 job：
 * - 用 FOR UPDATE SKIP LOCKED 避免多 worker 抢同一批任务
 * - 同时过滤 attempts < MAX_ATTEMPTS，避免死循环拉取已耗尽重试的 pending job
 * - scheduledAt <= now() 实现退避：重试任务不会被立即拉走
 * F-010: 改为只认领 CONCURRENCY 条作业
 * 在同一事务内将状态置 running，保证锁内提交。
 */
async function claimJobs(): Promise<ClaimedJob[]> {
  // Claim/reap are the only intentional cross-workspace queue operations. The
  // fixed SECURITY DEFINER function owns locking and assigns a token per row.
  const rows = await db.execute<{
    id: string;
    type: string;
    payload: unknown;
    workspace_id: string;
    requested_by: string | null;
    attempts: number | null;
    lease_token: string;
  }>(sql`
    SELECT id, type, payload, workspace_id, requested_by, attempts, lease_token
    FROM public.ailearn_claim_jobs(${CONCURRENCY}, ${MAX_ATTEMPTS})
  `);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    workspaceId: row.workspace_id,
    requestedBy: row.requested_by,
    attempts: row.attempts ?? 0,
    leaseToken: row.lease_token,
  }));
}

async function tick() {
  // F-010: 先回收悬挂作业
  await reapStaleJobs();

  // F-010: 优雅关停时不认领新作业
  if (shuttingDown) return;

  const candidates = await claimJobs();

  for (const job of candidates) {
    const handler = HANDLERS[job.type as keyof typeof HANDLERS];
    if (!handler) {
      const unknownResult = await withWorkerWorkspaceTransaction(
        { workspaceId: job.workspaceId, userId: job.requestedBy },
        (tx) => tx
          .update(schema.jobs)
          .set({
            status: "failed",
            lastError: `unknown job type ${job.type}`,
            finishedAt: new Date(),
            attempts: MAX_ATTEMPTS,
            startedAt: null,
            leaseToken: null,
          })
          .where(
            and(
              eq(schema.jobs.id, job.id),
              eq(schema.jobs.workspaceId, job.workspaceId),
              eq(schema.jobs.status, "running"),
              eq(schema.jobs.leaseToken, job.leaseToken),
            ),
          )
          .returning({ id: schema.jobs.id }),
      );
      if (unknownResult.length === 0) {
        logger.warn({ jobId: job.id }, "unknown job lease was already reaped; status left unchanged");
      }
      continue;
    }

    try {
      // F-010: 为 handler 添加超时保护
      // R-007: 超时会中止 provider；leaseToken 继续保护迟到 handler 的业务提交。
      await runWithAbortTimeout(
        (signal) => handler({
            id: job.id,
            payload: job.payload,
            workspaceId: job.workspaceId,
            requestedBy: job.requestedBy,
            leaseToken: job.leaseToken,
            signal,
          }),
        MODEL_TIMEOUT_MS,
        (lateError) => logger.warn(
          { jobId: job.id, err: lateError },
          "timed-out handler settled after its lease was released",
        ),
      );

      // G-001: 原子条件 UPDATE — 只有 status=running 且 lease_token 与 claim 时相同才提交 succeeded。
      // 如果 job 被 reaper 回收并重新 claim，lease_token 会不同，UPDATE 影响 0 行。
      const successResult = await withWorkerWorkspaceTransaction(
        { workspaceId: job.workspaceId, userId: job.requestedBy },
        (tx) => tx
          .update(schema.jobs)
          .set({ status: "succeeded", finishedAt: new Date(), leaseToken: null })
          .where(
            and(
              eq(schema.jobs.id, job.id),
              eq(schema.jobs.workspaceId, job.workspaceId),
              eq(schema.jobs.status, "running"),
              eq(schema.jobs.leaseToken, job.leaseToken),
            ),
          )
          .returning({ id: schema.jobs.id }),
      );
      if (successResult.length === 0) {
        logger.warn(
          { jobId: job.id },
          "job was reaped or re-claimed during execution — skipping result commit to avoid duplicate side effects",
        );
        continue;
      }
      logger.info({ jobId: job.id, type: job.type }, "job ok");
    } catch (err) {
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
      const nextAttempts = job.attempts + 1;
      const isDead = nextAttempts >= MAX_ATTEMPTS;
      // 退避：10s / 20s / 40s；dead 任务不再重试。
      const backoffMs = isDead ? 0 : retryBackoffMs(job.attempts);
      // G-001: 失败时也使用原子条件 UPDATE，避免覆盖 reaper 的状态
      const failResult = await withWorkerWorkspaceTransaction(
        { workspaceId: job.workspaceId, userId: job.requestedBy },
        (tx) => tx
          .update(schema.jobs)
          .set({
            status: isDead ? "dead" : "pending",
            attempts: nextAttempts,
            lastError: message,
            startedAt: null,
            leaseToken: null,
            finishedAt: isDead ? new Date() : null,
            scheduledAt: new Date(Date.now() + backoffMs),
          })
          .where(
            and(
              eq(schema.jobs.id, job.id),
              eq(schema.jobs.workspaceId, job.workspaceId),
              eq(schema.jobs.status, "running"),
              eq(schema.jobs.leaseToken, job.leaseToken),
            ),
          )
          .returning({ id: schema.jobs.id }),
      );
      if (failResult.length === 0) {
        logger.warn(
          { jobId: job.id },
          "job was reaped during execution — skipping failure update to avoid double-counting",
        );
        continue;
      }
      logger.error(
        { jobId: job.id, error: message, attempts: nextAttempts, backoffMs },
        "job failed",
      );
    }
  }
}

async function main() {
  logger.info("AI worker started, polling for jobs…");
  try {
    while (true) {
      try {
        await tick();
      } catch (err) {
        logger.error({ err }, "tick failed");
      }
      // F-010: 优雅关停 — 当前作业结束后退出。
      if (shuttingDown) {
        logger.info("shutdown complete, exiting");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  logger.error({ err }, "AI worker stopped unexpectedly");
  process.exitCode = 1;
});
