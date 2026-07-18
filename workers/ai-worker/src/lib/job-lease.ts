import { and, eq } from "drizzle-orm";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";

export interface JobLeaseContext {
  id: string;
  leaseToken: string;
  signal?: AbortSignal;
}

type WorkerTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class JobLeaseLostError extends Error {
  constructor(jobId: string, reason: "aborted" | "inactive") {
    super(reason === "aborted"
      ? `job ${jobId} was aborted before committing side effects`
      : `job ${jobId} no longer owns its lease`);
    this.name = "JobLeaseLostError";
  }
}

export function throwIfJobAborted(job: JobLeaseContext): void {
  if (job.signal?.aborted) {
    throw new JobLeaseLostError(job.id, "aborted");
  }
}

/**
 * Fail closed before any handler side effect. The second abort check closes
 * the window where cancellation fires while the lease lookup is in flight.
 */
export async function assertJobLease(job: JobLeaseContext): Promise<void> {
  throwIfJobAborted(job);
  const activeLease = await db.query.jobs.findFirst({
    columns: { id: true },
    where: and(
      eq(schema.jobs.id, job.id),
      eq(schema.jobs.status, "running"),
      eq(schema.jobs.leaseToken, job.leaseToken),
    ),
  });
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
  const [activeLease] = await tx
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.id, job.id),
        eq(schema.jobs.status, "running"),
        eq(schema.jobs.leaseToken, job.leaseToken),
      ),
    )
    .for("update");
  throwIfJobAborted(job);
  if (!activeLease) {
    throw new JobLeaseLostError(job.id, "inactive");
  }

  // Refresh the lease while the transaction owns the row lock. This prevents a
  // reaper from releasing a still-running handler in the small window between
  // the fenced business commit and the outer job-status update.
  await tx
    .update(schema.jobs)
    .set({ startedAt: new Date() })
    .where(
      and(
        eq(schema.jobs.id, job.id),
        eq(schema.jobs.status, "running"),
        eq(schema.jobs.leaseToken, job.leaseToken),
      ),
    );
  throwIfJobAborted(job);
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
