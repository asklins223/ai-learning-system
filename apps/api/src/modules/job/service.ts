import { withWorkspaceTransaction } from "../../db/client.ts";
import { currentRequestId } from "../../lib/request-context.ts";
import { jobs } from "@ailearn/shared/db-schema/job";
import { and, eq, count, inArray, sql } from "drizzle-orm";
import {
  JobResourceClass,
  JobType,
  JobStatus,
  MAX_PENDING_JOBS_PER_WORKSPACE,
  COMPANION_MEMORY_JOB_PAYLOAD_FIELDS,
  withCompanionActor,
  readSafeErrorCode,
  AI_CONSENT_REQUIRED_CODE,
} from "@ailearn/shared";
import type { JobPayloadFor } from "@ailearn/shared/job-payload-contracts";

/**
 * 把当前请求 id 并入 job payload（设计 P1-15：跨进程 trace）。
 *
 * 不在请求上下文（后台任务/测试/直接调用）时原样返回，避免写出
 * `traceId: undefined` 这类无意义字段。字段名取自共享契约，worker 侧用同一常量读。
 */
function withTraceId<T extends Record<string, unknown>>(payload: T): T | (T & { traceId: string }) {
  const traceId = currentRequestId();
  if (!traceId) return payload;
  return { ...payload, [COMPANION_MEMORY_JOB_PAYLOAD_FIELDS.traceId]: traceId };
}

export interface CreateJobBaseInput {
  workspaceId: string;
  requestedBy: string;
  dedupe?: {
    /**
     * Payload field the dedupe probe matches on. Must be unique to the job's
     * own purpose: the companion Agent continuation job carries BOTH `runId`
     * (shared with the original turn job) and `proposalId` (continuation-only),
     * and keying on `runId` would match the still-running original job and drop
     * the continuation. The field name is bound as a query parameter, so adding
     * a value here is not an injection surface.
     */
    payloadField: "noteVersionId" | "submissionId" | "runId" | "proposalId";
    value: string;
  };
}

/**
 * 入队输入：**按作业类型分型**的 payload（稳定 P1，2026-09-15 审计）。
 *
 * 此前 `payload: Record<string, unknown>` 对所有类型一视同仁——非 companion 作业
 * （parse_source）本可以有精确契约，却和 companion_* 一样完全不设防。现在按
 * `JobPayloadFor<T>` 取形状：
 *   - 已在 shared 的 `TypedJobPayloadByType` 登记的类型 → 精确契约
 *     （漏字段/错类型/多写字段当场编译失败）；
 *   - 未登记的类型（当前只有 companion_*）→ 仍是不透明 JSON，它们的 payload 由
 *     各自的契约模块管理，这里不替它们做决定。
 *
 * 于是"以后新增非 companion 作业"不会悄悄退回弱类型：往那张表登记即可。
 */
export type CreateJobInput = {
  [TJobType in JobType]: CreateJobBaseInput & {
    type: TJobType;
    payload: JobPayloadFor<TJobType>;
  };
}[JobType];

export type JobFailureReason =
  | "ai_consent_required"
  | "unknown";

/**
 * Projects the persisted privacy-safe error into a user-actionable reason.
 * `last_error` has already been sanitised by the worker, so this function must
 * only inspect stable machine codes and must never return the stored string.
 *
 * 设计 P1-15（2026-09-15 审计）：此前用 `lastError.endsWith(":ai_consent_required")`
 * 自行解析格式——与生产端 `safeErrorMessage` 的格式构成**隐式契约**，改格式或改
 * 码名都会静默失配（用户看不到"去签署同意"的引导）。现在解析器
 * （`readSafeErrorCode`）与码常量（`AI_CONSENT_REQUIRED_CODE`）都来自
 * `@ailearn/shared`，与 worker 侧同源。
 *
 * 同时删除 `"external_ai_disabled"` 分支：全仓（含 docs/config）搜索确认**没有任何
 * 生产者**会发出该码，属死分支（AGENTS.md：无调用方的分支直接删除）。
 */
export function classifyJobFailureReason(
  lastError: string | null | undefined,
): JobFailureReason | null {
  if (!lastError) return null;
  if (readSafeErrorCode(lastError) === AI_CONSENT_REQUIRED_CODE) {
    return "ai_consent_required";
  }
  return "unknown";
}

function jobScheduling(type: JobType): { priority: number; resourceClass: string } {
  switch (type) {
    case JobType.COMPANION_AGENT:
      return { priority: 100, resourceClass: JobResourceClass.INTERACTIVE_AI };
    case JobType.PARSE_SOURCE:
      return { priority: 70, resourceClass: JobResourceClass.CARD_FOREGROUND };
    case JobType.COMPANION_MEMORY_EXTRACT:
    case JobType.COMPANION_SUMMARIZER:
    case JobType.COMPANION_DAILY_SUMMARY:
    case JobType.COMPANION_MEMORY_EMBEDDING_REBUILD:
      return { priority: 10, resourceClass: JobResourceClass.MAINTENANCE };
    default:
      return { priority: 40, resourceClass: JobResourceClass.MAINTENANCE };
  }
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
  return withWorkspaceTransaction(
    { workspaceId: input.workspaceId, userId: input.requestedBy },
    async (tx) => {
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
      const scheduling = jobScheduling(input.type);

      const [job] = await tx
        .insert(jobs)
        .values({
          type: input.type,
          workspaceId: input.workspaceId,
          requestedBy: input.requestedBy,
          // Persist the trusted session actor in payloads whose worker contract
          // needs the user scope; requested_by remains the queue-level RLS authority.
          // 设计 P1-8（2026-09-15 审计）：字段名走共享契约常量，避免与读取侧漂移。
          // 设计 P1-15：附带当前请求 id（traceId），worker 日志据此与 API 日志关联。
          payload: withCompanionActor(withTraceId(input.payload), input.requestedBy),
          status: JobStatus.PENDING,
          priority: scheduling.priority,
          resourceClass: scheduling.resourceClass,
        })
        .returning();
      return job;
    },
  );
}

/**
 * BUG-73 修复：使用 withWorkspaceTransaction 设置 DB 级工作区上下文（防御纵深/RLS）。
 */
export async function listJobs(workspaceId: string, userId: string, opts?: { limit?: number }) {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const rows = await tx.query.jobs.findMany({
        where: eq(jobs.workspaceId, workspaceId),
        orderBy: (j, { desc }) => [desc(j.scheduledAt)],
        limit: Math.max(1, Math.min(100, opts?.limit ?? 50)),
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
        failureReason: classifyJobFailureReason(j.lastError),
      }));
    },
  );
}

/**
 * 防御纵深：service 层也按 workspaceId 过滤，route 已做一层但避免被绕过。
 *
 * BUG-73 修复：使用 withWorkspaceTransaction 设置 DB 级工作区上下文（防御纵深/RLS）。
 */
export async function getJob(id: string, workspaceId: string, userId: string) {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const job = await tx.query.jobs.findFirst({
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
        failureReason: classifyJobFailureReason(job.lastError),
      };
    },
  );
}
