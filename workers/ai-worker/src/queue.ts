import { sql, type SQL } from "drizzle-orm";
import { parseQueueConcurrency } from "./lib/worker-concurrency.ts";
import {
  db,
  type WorkerWorkspaceTransactionContext,
} from "./db.ts";
import { safeErrorMessage } from "@ailearn/shared";

// A2（计划 §2.2）：常量唯一来源收敛到 SQL（ailearn_fail_job / ailearn_reap_stale_jobs）。
// MAX_ATTEMPTS 仍被应用层使用（死信强制收敛与 claim/reap 调用），其值必须与
// SQL 默认 max_attempts 一致（retry-strategy-contract.test.ts 会断言）。
export const MAX_ATTEMPTS = 3;

// ARCH-02 fix: Make concurrency configurable via environment variable.
// Falls back to 3 (conservative default) when not set.
//
// 设计 P1-13（2026-09-15 审计）：解析逻辑抽到 lib/worker-concurrency.ts，
// 与 db.ts 的池宽推导共用同一实现（此前两处逐字重复，而 db.ts 的注释却声称
// "永不漂移"——拷贝本身就是漂移源；db.ts 不能 import 本文件，会成环）。
export const QUEUE_CONCURRENCY = parseQueueConcurrency(process.env.QUEUE_CONCURRENCY);
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

export type FailJobTransition = {
  updated: boolean;
  status: "pending" | "dead";
  attempts: number;
  backoffMs: number;
};

export type JobUpdateResult = FailJobTransition | {
  updated: boolean;
  status: "succeeded";
  attempts: number;
  backoffMs: number;
};

export type QueueJobUpdater = (update: QueueJobUpdate) => Promise<JobUpdateResult>;

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
 * 所有状态转换都返回统一的结构；失败路径额外携带 SQL 计算出的重试参数。
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
      return {
        updated: rows.length > 0 && rows[0].ok === true,
        status: "succeeded" as const,
        attempts: 0,
        backoffMs: 0,
      };
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
    if (values.status === "failed") {
      return {
        updated: true,
        status: "dead" as const,
        attempts: row.attempts,
        backoffMs: 0,
      };
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
  return result.updated;
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
  return result.updated;
}

/**
 * A2（计划 §2.2）：重试参数由 SQL 函数 ailearn_fail_job 计算，应用层直接消费返回值。
 *
 * 修改前（已废弃）：应用层自行计算 nextAttempts/isDead/backoffMs/status/scheduledAt，
 * SQL 函数内部重新计算相同值，两者必须手动保持同步。
 *
 * 修改后：应用层只传递 lastError，SQL 函数返回计算好的 status/attempts/backoff_ms。
 * 常量唯一来源是 SQL 迁移（backoff base 2s、max_attempts clamp 1-10）。
 * TS 侧只保留 MAX_ATTEMPTS 用于死信强制收敛与 claim/reap 调用。
 */
export async function markJobFailed(
  job: ClaimedJob,
  message: string,
  updateJob: QueueJobUpdater = defaultJobUpdater,
): Promise<FailJobTransition> {
  const result = await updateJob(createClaimedJobUpdate(job, {
    // SQL uses status="pending" to select the retrying max-attempts policy;
    // it computes the terminal status, attempt count and backoff atomically.
    status: "pending",
    lastError: safeErrorMessage(message),
    startedAt: null,
    leaseToken: null,
    finishedAt: null,
  }));
  if (result.status === "succeeded") {
    throw new Error("queue failure transition returned a success status");
  }
  return result;
}

/**
 * Force a job to the dead terminal state regardless of its current attempt
 * count.  Used for non-retryable errors (billing, auth, config) where retrying
 * would only waste time and inflate error metrics.
 *
 * A2: 重试参数由 SQL 函数计算。values.status="failed" 触发 max_attempts=1，
 * 使 ailearn_fail_job 强制 dead 状态。应用层消费 SQL 返回值。
 *
 */
export async function markJobDead(
  job: ClaimedJob,
  message: string,
  updateJob: QueueJobUpdater = defaultJobUpdater,
  now: () => Date = () => new Date(),
): Promise<FailJobTransition> {
  const result = await updateJob(createClaimedJobUpdate(job, {
    status: "failed",
    lastError: safeErrorMessage(message),
    finishedAt: now(),
    attempts: MAX_ATTEMPTS,
    startedAt: null,
    leaseToken: null,
  }));
  if (result.status === "succeeded") {
    throw new Error("queue dead-letter transition returned a success status");
  }
  return result;
}
