/**
 * commit_requested outbox 消费者（API 侧）。
 *
 * 链路（方案 12 §7.2 / §8.6）：
 *   评估 worker persistAssessmentBundleWithTransaction 推进
 *   processing_phase='assessment_complete' 后，同事务入队 commit_requested
 *   → API 定时器用 SECURITY DEFINER claim 函数（0109）跨 workspace 领取
 *   → withWorkspaceTransaction 内 stabilizeEpisode（Pg repo + Pg Commit
 *   executor）执行 episode-commit 编排（幂等 commit key + CAS 锁序 +
 *   canonical/schedule 写端口）。
 *
 * 诚实边界（不伪造）：
 * - modality=voice 时评估报告足够完整签发 mastery；
 * - structured_proof 的运行时判定（structuredProofEligible /
 *   equivalenceGatePassed）当前无落库来源，保守取 false → 最高
 *   facet_eligible 提交（facet observation 落 canonical），绝不虚发
 *   mastery 升级；reducer 结果由评估报告推演（报告写入成功即 reducer
 *   可评估）。
 */

import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import { createPgVerticalSliceRepository } from "./vertical-slice-repo-pg.ts";
import { createPgCommitExecutor } from "./commit-executor-pg.ts";
import {
  stabilizeEpisode,
  type OnCommitApplied,
  type StabilizeMasteryPlan,
  type StabilizeModality,
} from "./vertical-slice.ts";
import { RubricVerdict } from "@ailearn/shared";
import {
  RubricSessionResult,
  RUBRIC_SESSION_REDUCER_VERSION,
  type ReducerResult,
  type RubricAssessment,
} from "./trust-service.ts";
import type { EpisodeRow } from "./session-service.ts";

export interface CommitOutboxJob {
  id: string;
  workspaceId: string;
  userId: string;
  sessionId: string;
  episodeId: string;
  artifactId: string;
  attempts: number;
  leaseOwner: string;
  leaseExpiresAt: Date | null;
}

export class CommitOutboxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CommitOutboxError";
    this.code = code;
  }
}

// ─── claim（0109 SECURITY DEFINER 函数，跨 workspace）────────────────────

export async function claimCommitRequested(
  workerId: string,
  leaseMs: number,
  now: Date,
): Promise<CommitOutboxJob | null> {
  const { db } = await import("../../db/client.ts");
  const rows = await db.execute(sql`
    SELECT * FROM public.ailearn_claim_commit_outbox(
      ${workerId}, ${leaseMs}, ${now.toISOString()}
    )
  `);
  const rowsArr = rows as Array<Record<string, unknown>>;
  const row = rowsArr[0];
  if (row === undefined) return null;
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    episodeId: String(row.episode_id),
    artifactId: String((payload as { artifactId?: string })?.artifactId ?? ""),
    attempts: Number(row.attempts ?? 0),
    leaseOwner: String(row.lease_owner ?? workerId),
    leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)) : null,
  };
}

// ─── markProcessed / release ──────────────────────────────────────────────

export async function markCommitOutboxProcessed(jobId: string, workerId: string): Promise<void> {
  const { db } = await import("../../db/client.ts");
  await db.execute(sql`
    UPDATE public.learning_session_processing_outbox
    SET processed_at = now(), leased_at = NULL, lease_owner = NULL,
        lease_expires_at = NULL, updated_at = now()
    WHERE id = ${jobId} AND lease_owner = ${workerId}
  `);
}

export async function releaseCommitOutbox(
  jobId: string,
  workerId: string,
  availableAt: Date,
  error: string,
): Promise<void> {
  const { db } = await import("../../db/client.ts");
  await db.execute(sql`
    UPDATE public.learning_session_processing_outbox
    SET available_at = ${availableAt.toISOString()},
        lease_owner = NULL, leased_at = NULL, lease_expires_at = NULL,
        last_error = ${error.slice(0, 500)}, updated_at = now()
    WHERE id = ${jobId} AND lease_owner = ${workerId}
  `);
}

// ─── StabilizeEpisodeInput 构造（真实数据聚合 + 诚实保守默认）──────────────

async function countCompletedScenes(
  tx: ApiTransaction,
  workspaceId: string,
  userId: string,
  episodeId: string,
): Promise<{ required: number; completed: number; anyBlocked: boolean }> {
  const probeRows = (await tx.execute(sql`
    SELECT p.id AS "probeId",
           (SELECT count(*)::int FROM learning_response_artifacts a
            WHERE a.episode_id = ${episodeId}
              AND a.workspace_id = ${workspaceId}
              AND a.user_id = ${userId}
              AND a.status = 'locked'
              AND a.probe_id = p.id) AS "lockedArtifactCount"
    FROM learning_session_probes p
    WHERE p.episode_id = ${episodeId}
    ORDER BY p.sequence, p.id
  `)) as Array<Record<string, unknown>>;

  const required = probeRows.length;
  const completed = probeRows.filter((row) => Number(row.lockedArtifactCount ?? 0) > 0).length;
  // blocked：任一 required probe 无 locked artifact 或任何 locked artifact 带
  // 协助标记（stabilizeEpisode 的 artifactEligibility 会再校验 fingerprint）。
  const anyBlocked = probeRows.length > 0 && completed < probeRows.length;
  return { required, completed, anyBlocked };
}

function deriveReducerResult(assessments: RubricAssessment[]): ReducerResult {
  const required = assessments.filter((a) => a.verdict !== undefined);
  const missing = required.some((a) => a.verdict === RubricVerdict.MISSING);
  const contradicted = required.some((a) => a.verdict === RubricVerdict.CONTRADICTED);
  const notAssessable = required.some((a) => a.verdict === RubricVerdict.NOT_ASSESSABLE);
  const allCovered = required.length > 0 && !missing && !notAssessable;
  const coveredCount = required.filter(
    (a) => a.verdict === RubricVerdict.COVERED || a.verdict === RubricVerdict.PARTIAL,
  ).length;
  const weightedCoverage = required.length === 0 ? 0 : coveredCount / required.length;
  return {
    result: notAssessable
      ? RubricSessionResult.NOT_ASSESSABLE
      : contradicted || missing
        ? RubricSessionResult.FAIL
        : allCovered
          ? RubricSessionResult.PASS
          : RubricSessionResult.PARTIAL,
    weightedCoverage,
    hasContradiction: contradicted,
    allRequiredCovered: allCovered,
    missingRequired: missing,
    notAssessableRequired: notAssessable,
    reducerVersion: RUBRIC_SESSION_REDUCER_VERSION,
    invariantViolation: false,
    reasonCodes: [],
  };
}

async function buildStabilizeInput(
  tx: ApiTransaction,
  episode: EpisodeRow,
  assessments: RubricAssessment[],
  ctx: { workspaceId: string; userId: string; cardId: string; now: Date },
): Promise<{
  modality: StabilizeModality;
  plan: StabilizeMasteryPlan;
  reducerResult: ReducerResult;
}> {
  const scenes = await countCompletedScenes(tx, ctx.workspaceId, ctx.userId, episode.id);
  const reducerResult = deriveReducerResult(assessments);
  const modality: StabilizeModality =
    episode.formalPlan.kind === "voice_mastery" ? "voice" : "structured_proof";
  const plan: StabilizeMasteryPlan = {
    planKind: episode.formalPlan.kind,
    schedulingDecision: episode.schedulingDecision,
    requiredSceneCount: scenes.required,
    completedRequiredSceneCount: scenes.completed,
    anyRequiredSceneBlocked: scenes.anyBlocked,
    // structured_proof 的运行时资格/等价门无落库来源：诚实保守 false
    //（最高 facet_eligible，绝不虚发 mastery）。
    structuredProofEligible: false,
    equivalenceGatePassed: false,
    // 由评估报告推演（required rubric 无 missing）
    allRequiredFacetsCovered: !reducerResult.missingRequired,
  };
  return { modality, plan, reducerResult };
}

function resolveCardId(episode: EpisodeRow): string {
  if (episode.originRef.type === "card") return episode.originRef.id;
  return episode.keyPointId;
}

// ─── 消费编排 ─────────────────────────────────────────────────────────────

/**
 * 处理一行 commit_requested。返回：
 * - "committed"：commit 应用成功（可能 idempotent）；
 * - "skipped"：episode 已非 active / 已 committed 等无需处理情形；
 * 抛出错误由调用方 release（退避重试）或死信。
 */
export async function processCommitOutboxJob(job: CommitOutboxJob): Promise<"committed" | "skipped"> {
  const applied: Array<Parameters<OnCommitApplied>[0]> = [];
  const result = await withWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.userId },
    async (tx) => {
      const repo = createPgVerticalSliceRepository(tx);
      const executor = createPgCommitExecutor(tx);
      const episode = await repo.findEpisode(job.workspaceId, job.userId, job.episodeId);
      if (episode === null) {
        throw new CommitOutboxError("episode_not_found", `episode ${job.episodeId} 不存在`);
      }
      if (episode.status !== "active") {
        // 已 committed / stale / cancelled → 无操作，直接标记完成（幂等）。
        return { outcome: "skipped" as const };
      }
      const assessments = await repo.listRubricAssessments(job.workspaceId, job.userId, job.episodeId);
      const built = await buildStabilizeInput(tx, episode, assessments, {
        workspaceId: job.workspaceId,
        userId: job.userId,
        cardId: resolveCardId(episode),
        now: new Date(),
      });
      const stabilize = await stabilizeEpisode(
        {
          workspaceId: job.workspaceId,
          userId: job.userId,
          episodeId: job.episodeId,
          cardId: resolveCardId(episode),
          modality: built.modality,
          plan: built.plan,
          assisted: false,
          integrityFailure: false,
          providerFailure: false,
          notAssessable: false,
          userDeclaredUnable: false,
          reducerResult: built.reducerResult,
          now: new Date(),
        },
        repo,
        executor,
        (ctx) => { applied.push(ctx); },
      );
      // 终态闭环（0098：status='completed' ⇒ processing_phase='committed'）：
      // commitEpisode 只写 canonical outbox/schedule/audit，episode 行本身的
      // 状态推进在编排完成后由本消费方同事务完成（CAS status='active'）。
      if (stabilize.commit?.ok) {
        await tx.execute(sql`
          UPDATE learning_episodes
          SET status = 'completed', processing_phase = 'committed', updated_at = now()
          WHERE id = ${job.episodeId}
            AND workspace_id = ${job.workspaceId}
            AND user_id = ${job.userId}
            AND status = 'active'
        `);
      }
      return { outcome: "committed" as const };
    },
  );

  // 2026-08-15（方案 16 P9）：旧 permit-based proactive 触发桥已删除
  // （learning_run_v1 下本 tick 停用；新主动路径 = proactive-hook 的
  // run.completed 确定性 delivery）。

  return result.outcome;
}

/** API 定时器入口：claim → 处理 → 标记/退避。 */
export async function runCommitOutboxTick(workerId: string, leaseMs: number): Promise<number> {
  const claimed: CommitOutboxJob[] = [];
  for (let i = 0; i < 10; i += 1) {
    const job = await claimCommitRequested(workerId, leaseMs, new Date());
    if (job === null) break;
    claimed.push(job);
  }
  let processed = 0;
  for (const job of claimed) {
    try {
      await processCommitOutboxJob(job);
      await markCommitOutboxProcessed(job.id, workerId);
      processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (job.attempts >= 7) {
        // 死信：置 available_at='infinity'，保留行供人工审计。
        await releaseCommitOutbox(job.id, workerId, new Date("infinity"), `dead: ${message}`);
      } else {
        const backoffMs = Math.min(2000 * (job.attempts + 1), 60000);
        await releaseCommitOutbox(
          job.id,
          workerId,
          new Date(Date.now() + backoffMs),
          message,
        );
      }
    }
  }
  return processed;
}

/** 每 tick 用到的 worker id（与 API 进程绑定）。 */
export function createCommitOutboxWorkerId(): string {
  return `api-commit-${process.pid}-${randomUUID().slice(0, 8)}`;
}
