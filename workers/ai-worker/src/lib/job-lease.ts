import { and, eq, sql } from "drizzle-orm";
import {
  setWorkerTransactionContext,
  withWorkerWorkspaceTransaction,
  type WorkerTransaction,
} from "../db.ts";
import * as schema from "@ailearn/shared/db-schema";

export interface JobLeaseContext {
  id: string;
  workspaceId: string;
  requestedBy: string | null;
  leaseToken: string;
  signal?: AbortSignal;
}

export class JobLeaseLostError extends Error {
  readonly reason: "aborted" | "inactive";
  constructor(jobId: string, reason: "aborted" | "inactive") {
    super(reason === "aborted"
      ? `job ${jobId} was aborted before committing side effects`
      : `job ${jobId} no longer owns its lease`);
    this.name = "JobLeaseLostError";
    this.reason = reason;
  }
}

export function throwIfJobAborted(job: JobLeaseContext): void {
  if (job.signal?.aborted) {
    throw new JobLeaseLostError(job.id, "aborted");
  }
}

/** Bind every handler transaction to the job's immutable workspace/actor. */
export function withJobTransaction<T>(
  job: JobLeaseContext,
  operation: (transaction: WorkerTransaction) => Promise<T>,
): Promise<T> {
  return withWorkerWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.requestedBy },
    operation,
  );
}

/**
 * Fail closed before any handler side effect. The second abort check closes
 * the window where cancellation fires while the lease lookup is in flight.
 */
export async function assertJobLease(job: JobLeaseContext): Promise<void> {
  throwIfJobAborted(job);
  const activeLease = await withWorkerWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.requestedBy },
    (tx) => tx.query.jobs.findFirst({
      columns: { id: true },
      where: and(
        eq(schema.jobs.id, job.id),
        eq(schema.jobs.workspaceId, job.workspaceId),
        eq(schema.jobs.status, "running"),
        eq(schema.jobs.leaseToken, job.leaseToken),
      ),
    }),
  );
  throwIfJobAborted(job);
  if (!activeLease) {
    throw new JobLeaseLostError(job.id, "inactive");
  }

}

/**
 * Lock the jobs row for the lifetime of the business transaction. Reapers and
 * retry claims cannot replace the lease between this assertion and commit.
 */
export async function lockJobLease(
  tx: WorkerTransaction,
  job: JobLeaseContext,
): Promise<void> {
  throwIfJobAborted(job);
  await setWorkerTransactionContext(
    tx,
    { workspaceId: job.workspaceId, userId: job.requestedBy },
  );
  const [activeLease] = await tx
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.id, job.id),
        eq(schema.jobs.workspaceId, job.workspaceId),
        eq(schema.jobs.status, "running"),
        eq(schema.jobs.leaseToken, job.leaseToken),
      ),
    )
    .for("update");
  throwIfJobAborted(job);
  if (!activeLease) {
    throw new JobLeaseLostError(job.id, "inactive");
  }

  // SEC-01: Refresh the lease via the SECURITY DEFINER function instead of a
  // direct UPDATE.  This prevents a reaper from releasing a still-running
  // handler in the small window between the fenced business commit and the
  // outer job-status update, and ensures the Worker never needs blanket UPDATE
  // on jobs after RLS enforce.
  const renewRows = await tx.execute<{ ok: boolean }>(sql`
    SELECT ailearn_renew_job_lease(
      ${job.id},
      ${job.workspaceId},
      ${job.leaseToken}
    ) AS ok
  `);
  throwIfJobAborted(job);
  if (renewRows.length === 0 || renewRows[0].ok !== true) {
    throw new JobLeaseLostError(job.id, "inactive");
  }
}

export async function isJobLeaseActive(job: JobLeaseContext): Promise<boolean> {
  try {
    await assertJobLease(job);
    return true;
  } catch (err) {
    if (err instanceof JobLeaseLostError) return false;
    throw err;
  }
}
