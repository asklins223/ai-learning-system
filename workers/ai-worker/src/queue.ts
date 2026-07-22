import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  db,
  withWorkerWorkspaceTransaction,
  type WorkerTransaction,
  type WorkerWorkspaceTransactionContext,
} from "./db.ts";
import { retryBackoffMs } from "./lib/job-retry.ts";
import * as schema from "./schema/index.ts";

export const MAX_ATTEMPTS = 3;
export const QUEUE_CONCURRENCY = 3;
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

export type QueueJobUpdater = (update: QueueJobUpdate) => Promise<boolean>;

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

/**
 * SEC-01: Production queue updater that delegates to the SECURITY DEFINER
 * functions `ailearn_finish_job` and `ailearn_fail_job` (migration 0022).
 *
 * Unlike {@link createDrizzleQueueJobUpdater}, this path does NOT grant the
 * Worker a blanket UPDATE on the jobs table.  Each transition goes through a
 * function whose body is fixed at migration time, so the Worker cannot set
 * arbitrary column values or bypass the (id, workspace_id, running,
 * lease_token) fence.
 *
 * The `values` computed by `markJobSucceeded` / `markJobFailed` (status,
 * attempts, backoff) are application-layer expectations used for logging and
 * the `FailedJobTransition` return type.  The SQL function recomputes the
 * same values internally; the two code paths must stay in sync.
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
    const rows = await executor.execute<{ status: string }>(sql`
      SELECT status FROM ailearn_fail_job(
        ${fence.id},
        ${fence.workspaceId},
        ${fence.leaseToken},
        ${values.lastError ?? ""},
        ${maxAttempts}
      )
    `);
    return rows.length > 0;
  };
}

const defaultJobUpdater = createSqlFunctionQueueJobUpdater();

export async function markUnknownJobFailed(
  job: ClaimedJob,
  updateJob: QueueJobUpdater = defaultJobUpdater,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  return updateJob(createClaimedJobUpdate(job, {
    status: "failed",
    lastError: `unknown job type ${job.type}`,
    finishedAt: now(),
    attempts: MAX_ATTEMPTS,
    startedAt: null,
    leaseToken: null,
  }));
}

export async function markJobSucceeded(
  job: ClaimedJob,
  updateJob: QueueJobUpdater = defaultJobUpdater,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  return updateJob(createClaimedJobUpdate(job, {
    status: "succeeded",
    finishedAt: now(),
    leaseToken: null,
  }));
}

export type FailedJobTransition = {
  updated: boolean;
  status: "pending" | "dead";
  attempts: number;
  backoffMs: number;
};

export async function markJobFailed(
  job: ClaimedJob,
  message: string,
  updateJob: QueueJobUpdater = defaultJobUpdater,
  now: () => Date = () => new Date(),
  epochMs: () => number = Date.now,
): Promise<FailedJobTransition> {
  const nextAttempts = job.attempts + 1;
  const isDead = nextAttempts >= MAX_ATTEMPTS;
  // Retry delays: 2s / 4s; dead jobs are never retried.
  const backoffMs = isDead ? 0 : retryBackoffMs(job.attempts);
  const status = isDead ? "dead" : "pending";
  const updated = await updateJob(createClaimedJobUpdate(job, {
    status,
    attempts: nextAttempts,
    lastError: message,
    startedAt: null,
    leaseToken: null,
    finishedAt: isDead ? now() : null,
    scheduledAt: new Date(epochMs() + backoffMs),
  }));
  return { updated, status, attempts: nextAttempts, backoffMs };
}

/**
 * Force a job to the dead terminal state regardless of its current attempt
 * count.  Used for non-retryable errors (billing, auth, config) where retrying
 * would only waste time and inflate error metrics.
 *
 * The `status: "failed"` in the update values triggers `max_attempts=1` in the
 * SECURITY DEFINER SQL function, which forces the transition to dead even when
 * the job's current attempt count is below MAX_ATTEMPTS.  This mirrors the
 * behaviour of {@link markUnknownJobFailed}.
 */
export async function markJobDead(
  job: ClaimedJob,
  message: string,
  updateJob: QueueJobUpdater = defaultJobUpdater,
  now: () => Date = () => new Date(),
): Promise<FailedJobTransition> {
  const updated = await updateJob(createClaimedJobUpdate(job, {
    status: "failed",
    lastError: message,
    finishedAt: now(),
    attempts: MAX_ATTEMPTS,
    startedAt: null,
    leaseToken: null,
  }));
  return { updated, status: "dead", attempts: MAX_ATTEMPTS, backoffMs: 0 };
}
