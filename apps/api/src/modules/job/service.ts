import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/client.ts";
import { jobs } from "../../db/schema/job.ts";
import { learningCards } from "../../db/schema/card.ts";
import { noteVersions } from "../../db/schema/note.ts";
import { and, desc, eq, count, inArray, sql } from "drizzle-orm";
import {
  CardStatus,
  JobType,
  JobStatus,
  MAX_PENDING_JOBS_PER_WORKSPACE,
} from "@ailearn/shared";

export interface CreateJobInput {
  type: JobType;
  workspaceId: string;
  payload: Record<string, unknown>;
  dedupe?: {
    payloadField: "noteVersionId";
    value: string;
  };
}

/** N-001: 对已经在同一锁域内计算出的 pending 数量执行配额断言。 */
function assertJobQuota(pendingCount: number): void {
  if (pendingCount >= MAX_PENDING_JOBS_PER_WORKSPACE) {
    const err = new Error(
      `workspace has ${pendingCount} pending jobs (max ${MAX_PENDING_JOBS_PER_WORKSPACE})`,
    );
    (err as Error & { statusCode: number }).statusCode = 429;
    throw err;
  }
}

/**
 * Lightweight job dispatcher. Writes to our `jobs` table. The worker polls
 * the table at a short interval and runs the matching handler. This is a
 * pragmatic alternative to pg-boss for the V0.1 slice — easy to debug and
 * self-contained.
 *
 * N-001: 工作区 pending job 配额检查，单个工作区最多 50 条 pending job。
 * 超限时抛出 429 错误，防止单个成员耗尽队列和模型预算。
 */
export async function createJob(input: CreateJobInput) {
  // 同一 workspace 的“计数 + 插入”必须共享事务级 advisory lock，
  // 否则并发请求都可能在 49 条时通过检查并突破配额。
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${input.workspaceId}`}, 0)
      )
    `);
    if (input.dedupe) {
      const existing = await tx.query.jobs.findFirst({
        where: and(
          eq(jobs.workspaceId, input.workspaceId),
          eq(jobs.type, input.type),
          inArray(jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
          sql`${jobs.payload}->>${input.dedupe.payloadField} = ${input.dedupe.value}`,
        ),
      });
      if (existing) return existing;
    }
    const pendingRows = await tx
      .select({ count: count() })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, input.workspaceId),
          eq(jobs.status, JobStatus.PENDING),
        ),
      );
    assertJobQuota(Number(pendingRows[0]?.count ?? 0));

    const [job] = await tx
      .insert(jobs)
      .values({
        type: input.type,
        workspaceId: input.workspaceId,
        payload: input.payload,
        status: JobStatus.PENDING,
      })
      .returning();
    return job;
  });
}

export type GenerateCardEnqueueResult = {
  state: "generating" | "generated";
  cardId: string | null;
  jobId: string | null;
  generatedVersionId: string | null;
};

/**
 * Atomically hydrate/dedupe/enqueue generation for one note version.
 *
 * The public status read and the worker can commit between two ordinary
 * queries. Repeating the active-card and active-job checks under the same
 * workspace advisory lock used by the worker closes that window.
 */
export async function createGenerateCardJob(input: {
  workspaceId: string;
  userId: string;
  noteId: string;
  noteVersionId: string;
}): Promise<GenerateCardEnqueueResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${input.workspaceId}`}, 0)
      )
    `);

    const currentCard = await tx.query.learningCards.findFirst({
      where: and(
        eq(learningCards.workspaceId, input.workspaceId),
        eq(learningCards.noteVersionId, input.noteVersionId),
        eq(learningCards.status, CardStatus.ACTIVE),
      ),
      orderBy: [desc(learningCards.createdAt)],
    });
    const activeJob = await tx.query.jobs.findFirst({
      where: and(
        eq(jobs.workspaceId, input.workspaceId),
        eq(jobs.type, JobType.GENERATE_CARD),
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
        sql`${jobs.payload}->>'noteVersionId' = ${input.noteVersionId}`,
      ),
      orderBy: [desc(jobs.scheduledAt)],
    });

    const [previousCard] = await tx
      .select({ id: learningCards.id, noteVersionId: learningCards.noteVersionId })
      .from(learningCards)
      .innerJoin(noteVersions, eq(noteVersions.id, learningCards.noteVersionId))
      .where(and(
        eq(learningCards.workspaceId, input.workspaceId),
        eq(learningCards.status, CardStatus.ACTIVE),
        eq(noteVersions.noteId, input.noteId),
      ))
      .orderBy(desc(learningCards.createdAt))
      .limit(1);

    if (activeJob) {
      return {
        state: "generating",
        cardId: currentCard?.id ?? previousCard?.id ?? null,
        jobId: activeJob.id,
        generatedVersionId: currentCard?.noteVersionId ?? previousCard?.noteVersionId ?? null,
      };
    }

    if (currentCard) {
      return {
        state: "generated",
        cardId: currentCard.id,
        jobId: null,
        generatedVersionId: currentCard.noteVersionId,
      };
    }

    const pendingRows = await tx
      .select({ count: count() })
      .from(jobs)
      .where(and(
        eq(jobs.workspaceId, input.workspaceId),
        eq(jobs.status, JobStatus.PENDING),
      ));
    assertJobQuota(Number(pendingRows[0]?.count ?? 0));

    const [job] = await tx
      .insert(jobs)
      .values({
        type: JobType.GENERATE_CARD,
        workspaceId: input.workspaceId,
        payload: {
          noteVersionId: input.noteVersionId,
          userId: input.userId,
          ...(previousCard && previousCard.noteVersionId !== input.noteVersionId
            ? { oldCardId: previousCard.id }
            : {}),
        },
        status: JobStatus.PENDING,
      })
      .returning();

    return {
      state: "generating",
      cardId: previousCard?.id ?? null,
      jobId: job.id,
      generatedVersionId: previousCard?.noteVersionId ?? null,
    };
  });
}

export async function listJobs(workspaceId: string) {
  const rows = await db.query.jobs.findMany({
    where: eq(jobs.workspaceId, workspaceId),
    orderBy: (j, { desc }) => [desc(j.scheduledAt)],
    limit: 50,
  });
  // R-006: 脱敏 — 不返回 payload 中的敏感字段（question/userAnswer/userId）和完整 lastError
  return rows.map((j) => ({
    id: j.id,
    type: j.type,
    status: j.status,
    attempts: j.attempts,
    scheduledAt: j.scheduledAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    lastError: j.lastError ? "error occurred" : null,
  }));
}

// 防御纵深：service 层也按 workspaceId 过滤，route 已做一层但避免被绕过。
export async function getJob(id: string, workspaceId: string) {
  const job = await db.query.jobs.findFirst({
    where: and(eq(jobs.id, id), eq(jobs.workspaceId, workspaceId)),
  });
  if (!job) return null;
  // R-006: 脱敏 — 不返回 payload 和完整 lastError
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    scheduledAt: job.scheduledAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastError: job.lastError ? "error occurred" : null,
  };
}
