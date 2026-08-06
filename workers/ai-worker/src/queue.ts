import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  db,
  withWorkerWorkspaceTransaction,
  type WorkerTransaction,
  type WorkerWorkspaceTransactionContext,
} from "./db.ts";
import { retryBackoffMs } from "./lib/job-retry.ts";
import { safeErrorMessage } from "@ailearn/shared";
import * as schema from "./schema/index.ts";

// A2（计划 §2.2）：常量唯一来源收敛到 SQL（ailearn_fail_job / ailearn_reap_stale_jobs）。
// TS 侧保留镜像用于日志和契约测试断言（test/retry-strategy-contract.test.ts）。
// 如果修改重试策略，只需改 SQL 迁移 + 更新此处镜像，测试会自动断言两者一致。
export const MAX_ATTEMPTS = 3;
/** Mirror of SQL backoff base (2.0s in ailearn_fail_job). Test asserts consistency. */
export const RETRY_BACKOFF_BASE_MS_MIRROR = 2_000;
/** Mirror of SQL max_attempts clamp lower bound. Test asserts consistency. */
export const MAX_ATTEMPTS_CLAMP_MIN = 1;
/** Mirror of SQL max_attempts clamp upper bound. Test asserts consistency. */
export const MAX_ATTEMPTS_CLAMP_MAX = 10;

// ARCH-02 fix: Make concurrency configurable via environment variable.
// Falls back to 3 (conservative default) when not set.
export const QUEUE_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.QUEUE_CONCURRENCY ?? 3)));
export const LEASE_TIMEOUT_MS = 120_000;

export type ClaimedJob = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  workspaceId: string;
  requestedBy: string | null;
  attempts: number;
  /** Immutable token assigned by the claim transaction. */
  leaseToken: string;
};

export type ClaimedJobRow = {
  id: string;
  type: string;
  payload: unknown;
  workspace_id: string;
  requested_by: string | null;
  attempts: number | null;
  lease_token: string;
};

export type ReapedJobRow = {
  id: string;
  status: string;
};

/** The small raw-SQL surface needed by the SECURITY DEFINER queue functions. */
export interface QueueSqlExecutor {
  execute<T extends Record<string, unknown>>(query: SQL): Promise<T[]>;
}

export type QueueTransactionRunner = <T>(
  context: WorkerWorkspaceTransactionContext,
  operation: (transaction: WorkerTransaction) => Promise<T>,
) => Promise<T>;

export type QueueJobUpdateValues = {
  status: "pending" | "succeeded" | "failed" | "dead";
  attempts?: number;
  lastError?: string;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  scheduledAt?: Date;
  leaseToken: null;
};

export type ClaimedJobFence = {
  id: string;
  workspaceId: string;
  status: "running";
  leaseToken: string;
};

export type QueueJobUpdate = {
  context: WorkerWorkspaceTransactionContext;
  fence: ClaimedJobFence;
  values: QueueJobUpdateValues;
};

// A2: QueueJobUpdater 返回类型从 boolean 扩展为 JobUpdateResult。
// - 成功路径仍返回 boolean（兼容 markJobSucceeded / markUnknownJobFailed）
// - 失败路径返回 FailJobTransition（SQL 计算的重试参数）
// 测试 mock 返回 boolean 仍然兼容（markJobFailed 检测到 boolean 时回退到本地计算）
export type FailJobTransition = {
  updated: boolean;
  status: "pending" | "dead";
  attempts: number;
  backoffMs: number;
};

export type JobUpdateResult = boolean | FailJobTransition;

export type QueueJobUpdater = (update: QueueJobUpdate) => Promise<JobUpdateResult>;

// 向后兼容：旧代码使用 FailedJobTransition 名称
export type FailedJobTransition = FailJobTransition;

const defaultSqlExecutor: QueueSqlExecutor = {
  execute: async <T extends Record<string, unknown>>(query: SQL) =>
    await db.execute<T>(query) as unknown as T[],
};

/** Map the database function's snake_case result without leaking it to handlers. */
export function mapClaimedJobRow(row: ClaimedJobRow): ClaimedJob {
  return {
    id: row.id,
    type: row.type,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    workspaceId: row.workspace_id,
    requestedBy: row.requested_by,
    attempts: row.attempts ?? 0,
    leaseToken: row.lease_token,
  };
}

export async function claimJobs(
  executor: QueueSqlExecutor = defaultSqlExecutor,
  concurrency = QUEUE_CONCURRENCY,
  maxAttempts = MAX_ATTEMPTS,
): Promise<ClaimedJob[]> {
  // Claim/reap are the only intentional cross-workspace queue operations. The
  // fixed SECURITY DEFINER function owns locking and assigns a token per row.
  const rows = await executor.execute<ClaimedJobRow>(sql`
    SELECT id, type, payload, workspace_id, requested_by, attempts, lease_token
    FROM public.ailearn_claim_jobs(${concurrency}, ${maxAttempts})
  `);
  return rows.map(mapClaimedJobRow);
}

export type ReapedJobs = {
  total: number;
  pending: number;
  dead: number;
  ids: string[];
};

export async function reapStaleJobs(
  executor: QueueSqlExecutor = defaultSqlExecutor,
  leaseTimeoutMs = LEASE_TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
): Promise<ReapedJobs> {
  const rows = await executor.execute<ReapedJobRow>(sql`
    SELECT id, status
    FROM public.ailearn_reap_stale_jobs(${leaseTimeoutMs}, ${maxAttempts})
  `);
  return {
    total: rows.length,
    pending: rows.filter((row) => row.status === "pending").length,
    dead: rows.filter((row) => row.status === "dead").length,
    ids: rows.map((row) => row.id),
  };
}

export function createClaimedJobUpdate(
  job: ClaimedJob,
  values: QueueJobUpdateValues,
): QueueJobUpdate {
  return {
    context: { workspaceId: job.workspaceId, userId: job.requestedBy },
    fence: {
      id: job.id,
      workspaceId: job.workspaceId,
      status: "running",
      leaseToken: job.leaseToken,
    },
    values,
  };
}

/**
 * Adapt a workspace-scoped Drizzle transaction into the queue update contract.
 * Every update is fenced by both the immutable lease token and running state.
 *
 * This implementation is retained for unit tests that verify the fence
 * conditions (WHERE clause, SET values) without a real database.  Production
 * code uses {@link createSqlFunctionQueueJobUpdater} which delegates to the
 * SECURITY DEFINER functions created in migration 0022.
 */
export function createDrizzleQueueJobUpdater(
  runTransaction: QueueTransactionRunner = withWorkerWorkspaceTransaction,
): QueueJobUpdater {
  return async ({ context, fence, values }) => {
    const rows = await runTransaction(
      context,
      (tx) => tx
        .update(schema.jobs)
        .set(values)
        .where(
          and(
            eq(schema.jobs.id, fence.id),
            eq(schema.jobs.workspaceId, fence.workspaceId),
            eq(schema.jobs.status, fence.status),
            eq(schema.jobs.leaseToken, fence.leaseToken),
          ),
        )
        .returning({ id: schema.jobs.id }),
    );
    return rows.length > 0;
  };
}

/** Raw row type returned by ailearn_fail_job (migration 0064+). */
type FailJobRawRow = {
  status: string;
  attempts: number;
  backoff_ms: bigint | number;
  is_dead: boolean;
  scheduled_at: Date | null;
  last_error: string | null;
  finished_at: Date | null;
};

/**
 * SEC-01: Production queue updater that delegates to the SECURITY DEFINER
 * functions `ailearn_finish_job` and `ailearn_fail_job` (migration 0022/0064).
 *
 * A2（计划 §2.2）：失败路径直接消费 SQL 返回的重试参数（status/attempts/backoff_ms），
 * 应用层不再自行计算。这消除了常量双源问题。
 *
 * 对于 markJobSucceeded：仍返回 boolean。
 * 对于 markJobFailed/markJobDead：返回 FailJobTransition（SQL 计算值）。
 * 对于 markUnknownJobFailed：仍返回 boolean（走 max_attempts=1 强制 dead 路径，
 *   调用方 markUnknownJobFailed 只需要 updated 布尔值）。
 */
export function createSqlFunctionQueueJobUpdater(
  executor: QueueSqlExecutor = defaultSqlExecutor,
): QueueJobUpdater {
  return async ({ fence, values }) => {
    if (values.status === "succeeded") {
      const rows = await executor.execute<{ ok: boolean }>(sql`
        SELECT ailearn_finish_job(
          ${fence.id},
          ${fence.workspaceId},
          ${fence.leaseToken}
        ) AS ok
      `);
      return rows.length > 0 && rows[0].ok === true;
    }

    // "failed" is used by markUnknownJobFailed and must transition to dead
    // immediately.  Pass max_attempts=1 so ailearn_fail_job forces the dead
    // state regardless of the job's current attempt count.
    const maxAttempts = values.status === "failed" ? 1 : MAX_ATTEMPTS;
    const rows = await executor.execute<FailJobRawRow>(sql`
      SELECT status, attempts, backoff_ms, is_dead, scheduled_at, last_error, finished_at
      FROM ailearn_fail_job(
        ${fence.id},
        ${fence.workspaceId},
        ${fence.leaseToken},
        ${values.lastError ?? ""},
        ${maxAttempts}
      )
    `);

    if (rows.length === 0) {
      return { updated: false, status: "dead" as const, attempts: 0, backoffMs: 0 };
    }

    const row = rows[0];
    // markUnknownJobFailed 只需要 boolean（它通过 values.status="failed" 走 max_attempts=1 路径）
    if (values.status === "failed") {
      return true;
    }

    // markJobFailed 路径：返回 SQL 计算的重试参数
    return {
      updated: true,
      status: row.status as "pending" | "dead",
      attempts: row.attempts,
      backoffMs: Number(row.backoff_ms),
    };
  };
}

const defaultJobUpdater = createSqlFunctionQueueJobUpdater();

export async function markUnknownJobFailed(
  job: ClaimedJob,
  updateJob: QueueJobUpdater = defaultJobUpdater,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const result = await updateJob(createClaimedJobUpdate(job, {
    status: "failed",
    lastError: `unknown job type ${job.type}`,
    finishedAt: now(),
    attempts: MAX_ATTEMPTS,
    startedAt: null,
    leaseToken: null,
  }));
  return typeof result === "boolean" ? result : result.updated;
}

export async function markJobSucceeded(
  job: ClaimedJob,
  updateJob: QueueJobUpdater = defaultJobUpdater,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const result = await updateJob(createClaimedJobUpdate(job, {
    status: "succeeded",
    finishedAt: now(),
    leaseToken: null,
  }));
  return typeof result === "boolean" ? result : result.updated;
}

/**
 * A2（计划 §2.2）：重试参数由 SQL 函数 ailearn_fail_job 计算，应用层直接消费返回值。
 *
 * 修改前（已废弃）：应用层自行计算 nextAttempts/isDead/backoffMs/status/scheduledAt，
 * SQL 函数内部重新计算相同值，两者必须手动保持同步。
 *
 * 修改后：应用层只传递 lastError，SQL 函数返回计算好的 status/attempts/backoff_ms。
 * 常量唯一来源是 SQL 迁移（backoff base 2s、max_attempts clamp 3-10）。
 * TS 侧保留 MAX_ATTEMPTS / retryBackoffMs 镜像用于日志和契约测试断言。
 *
 * 向后兼容：当 updateJob 是测试 mock 返回 boolean 时，回退到本地计算。
 */
export async function markJobFailed(
  job: ClaimedJob,
  message: string,
  updateJob: QueueJobUpdater = defaultJobUpdater,
  now: () => Date = () => new Date(),
  epochMs: () => number = Date.now,
): Promise<FailedJobTransition> {
  // A2: 本地计算用于 values（兼容 Drizzle updater 和测试 mock 的 SET 断言）。
  // 生产 SQL updater 忽略 status/attempts/scheduledAt/finishedAt，只使用 lastError
  // 和通过 values.status 推导的 maxAttempts（"failed"→1, 其他→MAX_ATTEMPTS）。
  // SQL 函数内部重新计算正确的 status/attempts/backoff，并返回给应用层消费。
  const nextAttempts = job.attempts + 1;
  const isDead = nextAttempts >= MAX_ATTEMPTS;
  const backoffMs = isDead ? 0 : retryBackoffMs(job.attempts);
  const status = isDead ? "dead" : "pending";

  const result = await updateJob(createClaimedJobUpdate(job, {
    status,
    attempts: nextAttempts,
    lastError: safeErrorMessage(message),
    startedAt: null,
    leaseToken: null,
    finishedAt: isDead ? now() : null,
    scheduledAt: new Date(epochMs() + backoffMs),
  }));

  // A2: 优先使用 SQL 返回值（生产路径）
  if (typeof result !== "boolean") {
    return result;
  }

  // 回退路径：测试 mock 返回 boolean，使用本地计算
  return { updated: result, status, attempts: nextAttempts, backoffMs };
}

/**
 * Force a job to the dead terminal state regardless of its current attempt
 * count.  Used for non-retryable errors (billing, auth, config) where retrying
 * would only waste time and inflate error metrics.
 *
 * A2: 重试参数由 SQL 函数计算。values.status="failed" 触发 max_attempts=1，
 * 使 ailearn_fail_job 强制 dead 状态。应用层消费 SQL 返回值。
 *
 * 向后兼容：当 updateJob 是测试 mock 返回 boolean 时，回退到本地计算。
 */
export async function markJobDead(
  job: ClaimedJob,
  message: string,
  updateJob: QueueJobUpdater = defaultJobUpdater,
  now: () => Date = () => new Date(),
): Promise<FailedJobTransition> {
  const result = await updateJob(createClaimedJobUpdate(job, {
    status: "failed",
    lastError: safeErrorMessage(message),
    finishedAt: now(),
    attempts: MAX_ATTEMPTS,
    startedAt: null,
    leaseToken: null,
  }));

  // A2: 优先使用 SQL 返回值（生产路径）
  if (typeof result !== "boolean") {
    return result;
  }

  // 回退路径：测试 mock 返回 boolean
  return { updated: result, status: "dead", attempts: MAX_ATTEMPTS, backoffMs: 0 };
}
