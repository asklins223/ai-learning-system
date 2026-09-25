/**
 * 方案 20 C2/C3：Worker V2 Outbox 消费 Handler。
 *
 * 消费 `card_generation_run_outbox_v2` 中的 pending job，执行真实的四阶段
 * V2 生成管道（§10.1 标准链路）：
 *
 * 1. Evidence Seal + Input Closure（已在 generation-run 创建时完成）
 * 2. Learnability Planner（0 卡 → 成功终态 no_cards_recommended，不进 Author）
 * 3. Candidate Author（budget = plan.activationHardMax，不得扩大）
 * 4. deterministic precheck → 独立 Grounding 调用 → assembler 生成 Binding Plan
 *    → 独立 Pedagogy 调用（输入含 bindingPlanHashes）→ deck gate
 *    → 最多一次 bounded repair → review_ready / needs_attention /
 *      no_cards_recommended
 *
 * jobType：
 * - card_generation_plan                    → 完整管道
 * - card_generation_regenerate_candidate    → R5 接线（本轮 fail-closed）
 * - card_generation_replan_set              → R5 接线（本轮 fail-closed）
 * 未知 jobType → fail job（不允许静默 complete）。
 *
 * LLM 开关：`CARD_GENERATION_V2_LLM === "true"` 时构造真实四阶段 providers；
 * 否则使用确定性 provider（测试/离线模式）。确定性 provider 永不得在生产默认
 * 路径发布（§10.5）。
 *
 * worker 通过 raw SQL 访问 V2 表（V2 drizzle schema 已下沉
 * @ailearn/shared/db-schema，canonical 定义在 packages/shared；表名以该
 * schema 为准）。纯逻辑层经 @ailearn/shared/card-generation-v2-pipeline 消费。
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";
import { logger } from "../lib/logger.ts";
import { runWithAbortTimeout } from "../lib/handler-timeout.ts";
import type { CardGenerationUsageTotals } from "../card-generation-v2/providers.ts";

function sanitizeOperationalError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1000);
  if (typeof error === "string") return error.slice(0, 1000);
  try {
    return JSON.stringify(error).slice(0, 1000);
  } catch {
    return String(error).slice(0, 1000);
  }
}
import {
  executePlanner,
  type AtomExtractionProvider,
  type ExistingObjectiveRef,
} from "@ailearn/shared/card-generation-v2-pipeline";
import {
  executeAuthor,
  authorCandidateForObjective,
  budgetedPlanObjectives,
  plannedObjectiveForCandidateV2,
  summarizePracticeQuotaV2,
  DeterministicAuthoringProvider,
  type AuthoringProvider,
} from "@ailearn/shared/card-generation-v2-pipeline";
import {
  runGroundingCritic,
  runPedagogyCritic,
  runDeterministicFinalGates,
  deterministicGroundingPrecheck,
  deterministicPedagogyPrecheck,
  computeSemanticClustersV2,
  type GroundingCriticProvider,
  type PedagogyCriticProvider,
  type PedagogyCriticInput,
  type QualityReportV2,
  type QualityIssue,
} from "@ailearn/shared/card-generation-v2-pipeline";
import type {
  PedagogyCriticReportV2,
  PedagogyIssueCodeV2,
} from "@ailearn/shared/card-quality-v2-contracts";
import {
  runCandidateDeterministicGatesV2,
} from "@ailearn/shared/card-generation-v2-pipeline";
import {
  filterBlocksBySourceScope,
  type SealedEvidenceEntryV2,
} from "@ailearn/shared/card-generation-v2-pipeline";
import {
  mapWithConcurrency,
} from "@ailearn/shared/card-generation-v2-pipeline";
import { CardGenerationPipelineErrorV2 } from "@ailearn/shared/card-generation-v2-pipeline";
import {
  assembleCandidateEvidenceBindingPlanV2,
  type AssemblerEvidenceManifest,
} from "@ailearn/shared/card-generation-v2-pipeline";
import {
  computeCandidateEvidenceSetHashV2,
  computeCandidateRevisionHashV2,
  computeCardPlanHashV2,
  computeRubricHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import { computePedagogyReportHash } from "../card-generation-v2/providers.ts";
import {
  generationSemanticSpecV2Schema,
  generationInputSnapshotV2Schema,
} from "@ailearn/shared/card-generation-v2-contracts";
import type {
  LearningCardCandidateRevisionV2,
  CardHintPairV2,
  GenerationSemanticSpecV2,
  GenerationInputSnapshotV2,
  CardGenerationLiveProgressV2,
} from "@ailearn/shared/card-generation-v2-contracts";

// ─── Outbox claim ────────────────────────────────────────────────────────

interface PendingOutboxJob {
  id: string;
  workspaceId: string;
  runId: string;
  jobType: string;
  payload: Record<string, unknown>;
  /**
   * 认领时写入的不可变租约令牌（migration 新增列 lease_token），
   * complete/fail 用它做 status+lease 门闩，防止租约过期后迟到的完成/失败
   * 覆盖他人已提交的结果（仿 0121 learning-run outbox 的 owner CAS 范式）。
   */
  leaseToken: string;
}

/**
 * V2 outbox 租约时长（30 分钟）。
 *
 * 仍保留 30 分钟的宽窗口作为启动/连接故障的兜底，同时 processV2OutboxJob
 * 会在管道执行期间周期续租。这样慢速但正常的 planner→author→grounding→pedagogy
 * 不会被 reaper 误回收，worker 真正失联时仍可由 lease 过期触发回收。
 * 120s 一次性租约在没有 heartbeat 时会在正常 job 跑完前过期，reaper 会把它
 * 误回收并发重跑整管道；因此这里采用“长窗口 + heartbeat + token CAS”的组合。
 * lease_expires_at 的真实用途是回收「崩溃/失联 worker 的孤儿 job」，而非惩罚
 * 仍在合法执行的长任务；token CAS 防止过期后迟到的结果覆盖新 owner。
 * 代价是 heartbeat 不可用时崩溃后的孤儿最长需 30min 才能被 reaper 回收；正常
 * 路径则会持续续租。
 *
 * 2026-09-15（评审 M1）：租约窗口不再被当作"job 最长时长"的同义词——阶段级护栏
 * 由 `V2_PIPELINE_BUDGET_MS`（默认 20min，严格小于本窗口）承担：预算到期会
 * abort 在途 LLM 调用并把 job 终结为 failed（不重试），因此正常路径不可能撑满
 * 30min 租约窗口。
 */
export const V2_OUTBOX_LEASE_TIMEOUT_MS = 30 * 60_000;

/**
 * 单个 V2 job 的**墙钟预算**（阶段级护栏，评审 M1）。
 *
 * 20 卡上限时理论最坏 ≈ planner 1 + author ≤20 + grounding ≤20 + pedagogy 1 +
 * bounded repair ≤20 ≈ 62 次调用 × 单调用 75s ≈ 77min，远超 30min 租约窗口；
 * 此前没有任何阶段级预算，只能靠租约心跳兜底（心跳依赖 DB 可用，DB 故障时
 * 租约静默流失）。本预算在到期时 abort 整个 job 的 LLM 调用并把 job 直接终结
 * 为 failed（**不重试**——重试会把同样的钱再花一遍），run 落 needs_attention
 * 并带可解释原因。
 *
 * 默认 20min：足够覆盖正常 20 卡管道，同时严格小于 30min 租约窗口。
 * 可经 V2_PIPELINE_BUDGET_MS 覆盖。
 */
export const V2_PIPELINE_BUDGET_MS = (() => {
  const raw = Number(process.env.V2_PIPELINE_BUDGET_MS ?? 20 * 60_000);
  if (Number.isFinite(raw) && raw > 0) return raw;
  logger.warn(
    { raw: process.env.V2_PIPELINE_BUDGET_MS },
    "V2_PIPELINE_BUDGET_MS 非法，回退 20min",
  );
  return 20 * 60_000;
})();

/**
 * 租约续租（= 租约丢失探测）间隔。
 *
 * H5（2026-09-15 评审）：此前为 `lease/3 = 10min`——租约一旦被 reaper 回收，
 * 最坏 10min 后才发现，期间每个在途/后续 LLM 调用都是纯损失（单调用最长 75s）。
 * 收紧到 2min（仍远小于 30min 租约，留足抖动余量），把"租约已丢但仍在烧钱"
 * 的窗口从分钟级降到 2min。每次续租只是一条 `UPDATE ... WHERE id AND lease_token`
 * （走主键），开销可忽略。
 */
export const V2_LEASE_RENEWAL_INTERVAL_MS = (() => {
  const raw = Number(process.env.V2_LEASE_RENEWAL_INTERVAL_MS ?? 120_000);
  if (Number.isFinite(raw) && raw >= 5_000 && raw < V2_OUTBOX_LEASE_TIMEOUT_MS) return raw;
  return 120_000;
})();

/**
 * V2 outbox 的进程内并发上限。
 *
 * poll 是被主 worker tick 周期调用的；单次 poll 超时后，已经认领的管道仍会
 * 在后台继续执行。因此只限制单次 claim 不够，必须把仍在运行的管道纳入全局
 * inflight 计数，否则每个 tick 都能再认领一批，最终打满 DB/provider 连接池。
 */
export const V2_OUTBOX_MAX_CONCURRENCY = (() => {
  const raw = Number(process.env.V2_OUTBOX_MAX_CONCURRENCY ?? 4);
  if (Number.isInteger(raw) && raw > 0 && raw <= 64) return raw;
  logger.warn(
    { raw: process.env.V2_OUTBOX_MAX_CONCURRENCY },
    "V2_OUTBOX_MAX_CONCURRENCY 非法，回退 4",
  );
  return 4;
})();

/**
 * 本进程在途的 V2 job：promise → 它认领时拿到的租约凭据。
 * 记凭据是为了关停时能把租约**交还**（`releaseInflightV2OutboxLeases`）；
 * 只记 promise 的话，强杀之后只能等 30 分钟租约自然过期。
 */
const v2Inflight = new Map<Promise<void>, { jobId: string; leaseToken: string }>();

/** 本进程在途 V2 job 数。 */
export function getV2OutboxInflightCount(): number {
  return v2Inflight.size;
}

/**
 * V2 管线**阶段内**并发上限（2026-09-17 极限延迟改造）。
 *
 * author 与 grounding 都是逐候选调用 provider：候选之间无数据依赖，串行时墙钟
 * = N × 单次调用（dev 实测 N=5 时 12 次调用 93.1s ≈ 端到端 93.7s）。
 * 改为有界并发后墙钟 = ceil(N / 本值) × 单次调用。
 *
 * 默认 12：**不惜成本换墙钟** —— 服务端卡上限 `SERVER_POLICY_MAX_CARDS` 是 20，
 * 取 12 让绝大多数 run（实测 planner 产出 5 个目标）一波跑完；N>12 时才分批。
 * 取值过大会把 provider 打满触发 429，反而因退避更慢；实测 6 并发无任何限流，
 * 12 为在"一波跑完"与"provider 压力"之间的取值。可经 V2_STAGE_CONCURRENCY 覆盖
 * （1–32）。
 */
/**
 * 是否启用**投机 pedagogy**（与 grounding 波并发）。
 *
 * 2026-09-17：作为可关的开关保留，用于同窗口 A/B 对照——该改动的收益依赖
 * "grounding/去重是否淘汰候选"（淘汰则投机报告作废、要多付一次调用），
 * 必须在同一 provider 窗口内对照才能判断，不能靠跨窗口的绝对秒数。
 */
export const V2_SPECULATIVE_PEDAGOGY = process.env.V2_SPECULATIVE_PEDAGOGY !== "0";

export const V2_STAGE_CONCURRENCY = (() => {
  const raw = Number(process.env.V2_STAGE_CONCURRENCY ?? 12);
  if (Number.isInteger(raw) && raw > 0 && raw <= 32) return raw;
  logger.warn(
    { raw: process.env.V2_STAGE_CONCURRENCY },
    "V2_STAGE_CONCURRENCY 非法，回退 12",
  );
  return 12;
})();

/** 等待当前 worker 已认领的 V2 管道结束；返回是否在 deadline 内排空。 */
export async function waitForV2OutboxDrain(timeoutMs: number): Promise<boolean> {
  if (v2Inflight.size === 0) return true;

  const pending = Promise.allSettled([...v2Inflight.keys()]).then(() => true);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * V2 poll 的总超时上界（对齐租约窗口）。
 *
 * pollV2Outbox 被 worker 主 tick 调用（index.ts tick()），而 V2 管道是分钟级
 * 多轮 LLM 调用。`CardGenerationProviderRuntime.chatJson` 会把 AbortSignal 透传给
 * `provider.chatCompletion`：调用方传入的外部 signal，或单调用预算
 * `V2_PROVIDER_CALL_TIMEOUT_MS`（默认 75s，AbortSignal.timeout）任一中止信号都会
 * 真中止底层 HTTP 调用（第五轮审计 W#4 修复：不再是「不传 signal、靠外层挂起」）。
 * 故此常量不再用于为单个卡死 LLM 调用兜底，而是给整次 poll 一个总量上界：
 * - 与租约窗口一致：poll 永不超出「单 job 的最坏合法时长」，语义上 poll 的生命
 *   期被限制在释放前必须能完成/失败该 job 的窗口内；
 * - 超时后 poll 立即返回（tick 继续），底层任务继续后台运行——因租约 30min 未过期，
 *   后台任务仍可带 lease CAS 完成/失败该 job，reaper 不会误回收，不丢副作用；
 *   仅「主循环继续推进」与「阻塞等待该 job」解耦。
 */
export const V2_POLL_TIMEOUT_MS = V2_OUTBOX_LEASE_TIMEOUT_MS;

/**
 * Claim pending V2 outbox jobs。
 * 使用 `FOR UPDATE SKIP LOCKED` 实现并发安全的 claim；认领即写入租约
 * （started_at / lease_token / lease_expires_at），供 complete/fail 门闩及
 * reaper 回收孤儿使用。
 *
 * 依赖迁移：新增列 started_at timestamptz、lease_token uuid、lease_expires_at timestamptz。
 *
 * round-8 🟡5（保持现状 + 说明）：本 claim 可能在 poll 的 5s awaitBudgetMs 边界被 abort。
 * abort 只让 pollV2Outbox 返回（Promise.race 拒绝），不会取消本函数内部 db.execute；
 * 已认领改行若已提交（status=processing + lease_token），其所属 `processV2OutboxJob`
 * 由 abortable 内的**同一后台连续体**继续执行（processV2OutboxJob 不接收 poll signal），
 * 因此正常情况下不会出现"认领后无主"。仅当整个 worker 恰好在这条缝隙整体退出时，
 * 该行才保持 processing 等待 reaper（30min lease 过期后回收，lease_token CAS 兜底，
 * 不丢数据、不重复计费）。最小正确方案：不改 claim 逻辑，靠连续体 + reaper 双兜底。
 */
export async function claimV2OutboxJobs(limit = 1): Promise<PendingOutboxJob[]> {
  const rows = await db.execute(sql`
    UPDATE public.card_generation_run_outbox_v2
    SET status = 'processing', processed_at = now(),
        started_at = now(),
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + make_interval(secs => ${V2_OUTBOX_LEASE_TIMEOUT_MS / 1000}),
        next_attempt_at = NULL
    WHERE id IN (
      SELECT id FROM public.card_generation_run_outbox_v2
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, workspace_id, run_id, job_type, payload, lease_token
  `);
  return rows.map((r) => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    runId: String(r.run_id),
    jobType: String(r.job_type),
    payload: r.payload as Record<string, unknown>,
    leaseToken: String(r.lease_token),
  }));
}

/**
 * 续租 V2 outbox job。返回 false 表示租约已被 reaper/其他 worker 接管；调用方
 * 必须停止提交结果，不能把迟到的完成或失败写回他人的 lease。
 */
export async function renewV2OutboxLease(jobId: string, leaseToken: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE public.card_generation_run_outbox_v2
    SET lease_expires_at = now() + make_interval(secs => ${V2_OUTBOX_LEASE_TIMEOUT_MS / 1000})
    WHERE id = ${jobId} AND status = 'processing' AND lease_token = ${leaseToken}
      AND lease_expires_at > now()
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * Fence a V2 pipeline at the transaction boundary.  The lease update is part
 * of the same transaction as the pipeline writes, so a reaper that won the
 * token CAS makes the whole transaction roll back instead of leaving a late
 * candidate/run mutation behind.
 */
async function fenceV2OutboxLease(tx: WorkerTransaction, job: PendingOutboxJob): Promise<void> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE public.card_generation_run_outbox_v2
    SET lease_expires_at = now() + make_interval(secs => ${V2_OUTBOX_LEASE_TIMEOUT_MS / 1000})
    WHERE id = ${job.id} AND status = 'processing' AND lease_token = ${job.leaseToken}
      AND lease_expires_at > now()
    RETURNING id
  `);
  if (rows.length === 0) {
    throw new Error("V2 outbox lease lost before transaction commit");
  }
}

/**
 * 交还本进程持有的**一条** V2 租约：清空 token 并把过期时间推到当下。
 *
 * 为什么不直接改回 pending：`reapStaleV2OutboxJobs` 已经是"过期租约 → attempts+1 +
 * 退避 + 重投"的唯一实现，另起一条接管路径会让两处语义漂移；这里只是把它的前提
 * （`lease_expires_at < now()`）提前造成。
 *
 * 为什么连 `lease_token` 一起清空：本进程此刻可能还有在途 LLM 调用与一个未提交的
 * 大事务。token 一空，它的 `fenceV2OutboxLease` 当场失败（整个事务回滚），迟到的
 * complete/fail 也过不了 token CAS（0 行）——防双付的语义照旧成立，只是不再挂满
 * 30 分钟。
 */
export async function releaseV2OutboxLease(jobId: string, leaseToken: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE public.card_generation_run_outbox_v2
    SET lease_token = NULL, lease_expires_at = now()
    WHERE id = ${jobId} AND status = 'processing' AND lease_token = ${leaseToken}
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * 关停前交还所有在途租约（由 `index.ts` 的 drain 分支调用）。
 *
 * dev 里 tsx watch 只给 5 秒（日志原话：`Process didn't exit in 5s. Force killing...`），
 * 而一条付费管道要跑几分钟。不在这一刻交还，进程被强杀后这条 run 的租约会一直挂到
 * 自然过期（30 分钟）：其间那篇笔记被 in-flight 守卫锁住（再点生成只吃 409），
 * 已经花掉的钱也白付。返回交还条数，仅用于日志。
 */
export async function releaseInflightV2OutboxLeases(): Promise<number> {
  let released = 0;
  for (const { jobId, leaseToken } of v2Inflight.values()) {
    try {
      if (await releaseV2OutboxLease(jobId, leaseToken)) released += 1;
    } catch (error) {
      logger.warn(
        { jobId, error: sanitizeOperationalError(error) },
        "V2 outbox lease release failed",
      );
    }
  }
  return released;
}

/**
 * 写一次生成过程的**实时进度读数**（迁移 0249，实走复盘 #2）。
 *
 * 为什么要有这个东西：主管道跑在一个分钟级事务里（`processCardGenerationPlan` 起
 * 那个 `withWorkerWorkspaceTransaction`），期间候选行与 `run.status` 对外都不可见，
 * 所以 `progress.authored` 在整段生成里恒为 0——那一格进度不是"跳过了几个值"，是
 * 压根读不到。这里只把**读数**提前落盘，产物仍然原子提交（逐候选提交是 §21 的 A1，
 * 它的前置是重放语义 + 候选幂等，另一批）。
 *
 * 两道刻意设计：
 * - 租约核对是**只读**的。管道事务里的 `fenceV2OutboxLease` 会 UPDATE 同一行 outbox
 *   并持锁到提交，这里若加 `FOR UPDATE` 就会排在它后面阻塞分钟级，短事务就白短路了。
 * - 失败**不抛**。读数写不进去的代价是"那一格不动"，不是"这批卡丢了"。
 *
 * 第三道是 2026-09-21 实机量出来的补丁：这个函数**必须**用 `isolated: true` 开独立事务。
 * 默认的 `withWorkerWorkspaceTransaction` 会加入当前作用域里那条事务，而调用点就在
 * `processCardGenerationPlan` 自己的事务里（handler `:1205` 开的那个），于是读数跟着
 * 管道一起提交 —— 对外仍然要等整批 LLM 跑完才可见。真跑实测：124.3 秒的生成里
 * HTTP 只采到 `[0, 8]`，读数行的 `updated_at` 与大事务开始时间逐微秒相同。
 * 判据见 `card-generation-v2-live-progress-postgres.integration.ts`「tick 不加入调用方的事务」。
 */
export async function writeCardGenerationLiveProgress(
  job: PendingOutboxJob,
  progress: CardGenerationLiveProgressV2,
): Promise<boolean> {
  try {
    return await withWorkerWorkspaceTransaction(
      { workspaceId: job.workspaceId, userId: null },
      async (tx) => {
        const alive = await tx.execute(sql`
          SELECT 1 FROM public.card_generation_run_outbox_v2
          WHERE id = ${job.id} AND status = 'processing' AND lease_token = ${job.leaseToken}
            AND lease_expires_at > now()
          LIMIT 1
        `);
        if (alive.length === 0) return false;
        await tx.execute(sql`
          INSERT INTO public.card_generation_run_progress_v2
            (run_id, workspace_id, lease_token, progress, updated_at)
          VALUES (${job.runId}, ${job.workspaceId}, ${job.leaseToken},
                  ${JSON.stringify(progress)}::jsonb, now())
          ON CONFLICT (run_id) DO UPDATE
          SET lease_token = EXCLUDED.lease_token,
              progress = EXCLUDED.progress,
              updated_at = now()
        `);
        return true;
      },
      { isolated: true },
    );
  } catch (error) {
    logger.warn({ runId: job.runId, err: sanitizeOperationalError(error) },
      "[v2-pipeline] live progress write skipped");
    return false;
  }
}

/**
 * Mark outbox job as completed（status + lease 门闩）。
 * 仅当该行确系本次认领的 lease_token 且仍处于 processing 时才更新；否则
 * 表示租约已被 reaper 回收或移交给他人，迟到完成必须静默忽略。
 */
export async function completeV2OutboxJob(jobId: string, leaseToken: string): Promise<void> {
  await db.execute(sql`
    UPDATE public.card_generation_run_outbox_v2
    SET status = 'completed', processed_at = now(),
        started_at = NULL, lease_token = NULL, lease_expires_at = NULL
    WHERE id = ${jobId} AND status = 'processing' AND lease_token = ${leaseToken}
      AND lease_expires_at > now()
  `);
}

/**
 * Mark outbox job as failed and increment attempts（status + lease 门闩）。
 *
 * §17.1 重试分类：
 * - retryable（provider/网络 5xx/429/408/超时）→ 保留 pending，attempts < 6 重试；
 * - non-retryable（schema/协议错误）→ 直接 failed。
 * 门闩条件与 complete 相同：仅当 lease_token 匹配且仍 processing 时生效。
 *
 * 2026-08-16（实机验证修复）：outbox 终态 failed 时同步把 run 置为
 * `needs_attention` 并写 error（此前 run 永远卡 planning，用户端只见
 * "生成中"永不结束）。retryable 重试中不动 run（仍 planning/processing）。
 *
 * 2026-08-25（AI 设计审计修复）：retryable 分支原先的第二条 run UPDATE 在
 * CASE 里引用了 runs 表上不存在的 `attempts` 列（该列只在 outbox 表），
 * PostgreSQL 解析期必抛 42703——run 回写是死代码且每次可重试失败都污染
 * poll 日志。现改为第一条 UPDATE `RETURNING status`，以 outbox 行的实际
 * 终态决定是否同步 run：status='failed'（重试耗尽或达上限）才置
 * needs_attention，语义与非重试分支及文档声明完全一致。
 */
export async function failV2OutboxJob(
  jobId: string,
  leaseToken: string,
  error: string,
  retryable = true,
): Promise<void> {
  if (!retryable) {
    // Outbox 终态与 run 的 needs_attention 必须在同一 SQL 语句内完成。
    // 若先成功释放 outbox lease、再单独 UPDATE run，第二步失败会留下
    // “outbox=failed、run=planning/processing”的永久悬挂状态。
    await db.execute(sql`
      WITH updated AS (
        UPDATE public.card_generation_run_outbox_v2
        SET status = 'failed', attempts = attempts + 1, last_error = ${error},
            started_at = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE id = ${jobId} AND status = 'processing' AND lease_token = ${leaseToken}
          AND lease_expires_at > now()
        RETURNING id, run_id, workspace_id
      )
      UPDATE public.card_generation_runs_v2 AS run
      SET status = 'needs_attention', error_code = 'generation_failed', error_message = ${error},
          updated_at = now()
      FROM updated
      WHERE updated.run_id = run.id
        AND updated.workspace_id = run.workspace_id
        AND run.status NOT IN ('review_ready', 'no_cards_recommended', 'activating', 'activated',
                               'closed_without_activation', 'failed', 'cancelled', 'stale')
    `);
    return;
  }
  // 与 reaper 保持同一语义：本次失败后 attempts + 1 达到 6 就终止，
  // 不再让正常失败路径比崩溃回收路径多重试一次。
  //
  // 2026-09-15（管线评审 H1）：retryable 分支此前**无退避**——status 直接回
  // pending，下一个 poll 立即重新认领并重放整条已付费的 LLM 管道（planner→
  // author→grounding→pedagogy），429/5xx 时形成重试风暴。现在写入指数退避的
  // 下次可认领时间：attempts=0..4 → 15s/30s/60s/120s/240s（封顶 300s）。
  // 退避只改变排队时机，不改变 attempts 上限与 fail-closed 语义。
  await db.execute(sql`
    WITH updated AS (
      UPDATE public.card_generation_run_outbox_v2
      SET status = CASE
        WHEN attempts + 1 >= 6 THEN 'failed'
        ELSE 'pending'
      END,
      attempts = attempts + 1,
      next_attempt_at = CASE
        WHEN attempts + 1 >= 6 THEN NULL
        ELSE now() + make_interval(secs => LEAST(300, 15 * power(2, attempts))::int)
      END,
      last_error = ${error},
      started_at = NULL, lease_token = NULL, lease_expires_at = NULL
      WHERE id = ${jobId} AND status = 'processing' AND lease_token = ${leaseToken}
        AND lease_expires_at > now()
      RETURNING status, run_id, workspace_id
    )
    UPDATE public.card_generation_runs_v2 AS run
    SET status = 'needs_attention', error_code = 'generation_failed', error_message = ${error},
        updated_at = now()
    FROM updated
    WHERE updated.status = 'failed'
      AND updated.run_id = run.id
      AND updated.workspace_id = run.workspace_id
      AND run.status NOT IN ('review_ready', 'no_cards_recommended', 'activating', 'activated',
                             'closed_without_activation', 'failed', 'cancelled', 'stale')
  `);
}

/**
 * Reap stale processing outbox jobs（孤儿回收）。
 * worker 崩溃/网络分区时 leasing job 永卡 processing，此函数把超期未更新的
 * processing 行收回复投。按 `lease_expires_at < now()` 判定过期（单窗口，租约
 * 到期即回收，与 claim 写入的 30min 租约及主队列 started_at 单窗口语义一致，
 * 修复第三轮 W#2 的"双重减去"）。
 *
 * 回收语义对齐主队列 0105 `ailearn_reap_stale_jobs`（修复第三轮 W#1）：每次
 * 回收都 `attempts = attempts + 1`；回收后即达重试上限（attempts + 1 >= 6）的行
 * 转 `failed`（不再无限重投，崩溃路径也计入重试上限）；否则重置回 `pending`
 * 并清空租约三列（started_at / lease_token / lease_expires_at），供重新认领。
 *
 * 子查询含 `FOR UPDATE SKIP LOCKED`（对齐主队列 0105 reaper，第四轮审计 #4）：防
 * 多 worker 实例并发 reap 同一批超期行——已被本实例锁定排队待回收的行会被跳过，
 * 避免外 UPDATE 相互阻塞甚至重复回收同一行（并行 UPDATE 到同一 id 会因锁等待而
 * 串行化，且一个实例已 SET 租约清空、另一实例再命中时范围已变）。
 *
 * 返回被回收（重置/转失败）的行数。
 */
export async function reapStaleV2OutboxJobs(limit = 100): Promise<number> {
  const rows = await db.execute<{
    id: string;
    run_id: string;
    workspace_id: string;
    status: string;
  }>(sql`
    WITH reaped AS (
      UPDATE public.card_generation_run_outbox_v2
      SET status = CASE
          WHEN attempts + 1 >= 6 THEN 'failed'
          ELSE 'pending'
        END,
          attempts = attempts + 1,
          -- H1（2026-09-15）：回收重投同样退避，避免崩溃恢复时多个孤儿 job
          -- 在同一个 tick 被立即重领并同时重放整条 LLM 管道。
          next_attempt_at = CASE
            WHEN attempts + 1 >= 6 THEN NULL
            ELSE now() + make_interval(secs => LEAST(300, 15 * power(2, attempts))::int)
          END,
          started_at = NULL, lease_token = NULL, lease_expires_at = NULL,
          processed_at = NULL
      WHERE id IN (
        SELECT id FROM public.card_generation_run_outbox_v2
        WHERE status = 'processing'
          AND lease_expires_at < now()
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, run_id, workspace_id, status
    ), marked AS (
      UPDATE public.card_generation_runs_v2 AS run
      SET status = 'needs_attention', error_code = 'generation_failed',
          error_message = 'V2 outbox lease expired', updated_at = now()
      FROM reaped
      WHERE reaped.status = 'failed'
        AND reaped.run_id = run.id
        AND reaped.workspace_id = run.workspace_id
        AND run.status NOT IN ('review_ready', 'no_cards_recommended', 'activating', 'activated',
                               'closed_without_activation', 'failed', 'cancelled', 'stale')
    )
    SELECT id, run_id, workspace_id, status FROM reaped
  `);
  return rows.length;
}

// ─── V2 Generation Pipeline Handler ──────────────────────────────────────

/**
 * 判别错误是否不可重试（provider 5xx/429/408/超时 → retryable；
 * schema/协议/配置 → non-retryable）。
 *
 * 2026-09-17（实机事故修复）：除类实例的 `kind` 字段外，**同时**识别裸 Error 上
 * 的 `retryable` 布尔。事故形态是 `providers.ts` 的 mock/未配置 provider
 * fail-closed 抛出的 `Error`，只设置了 `retryable = false`、没有 `kind`——
 * 本函数此前只读 `kind`，于是这个显式标记为"不可重试"的配置错误被当成可重试：
 * outbox 退避重试 6 次（15/30/60/120/240s，实测 7m45s 墙钟）、期间零 LLM 调用，
 * 用户只看到长时间"生成中"然后 needs_attention。两种形状都必须被尊重，
 * 否则"显式标注不可重试"这件事在读取侧形同虚设。
 *
 * 已导出供单测直接覆盖（此前是模块私有函数，分类错误无法被测试捕获）。
 */
export function isNonRetryableErrorLike(error: unknown): boolean {
  // 本地可分类错误（CardGenerationProviderErrorLike 携带 `retryable` 布尔）。
  if (error instanceof CardGenerationProviderErrorLike) return !error.retryable;
  // providers.ts（独立模块，避免循环依赖）抛出的 CardGenerationProviderError：
  // 类实例走 `kind`；历史/裸 Error 形态走 `retryable`。两者都给出明确结论时
  // 以 `kind` 为准（它是 canonical 形状）。
  if (typeof error === "object" && error !== null) {
    const e = error as { name?: string; kind?: string; retryable?: unknown };
    if (e.name === "CardGenerationProviderError") {
      if (e.kind === "non-retryable") return true;
      if (e.kind === "retryable") return false;
      if (e.retryable === false) return true;
      if (e.retryable === true) return false;
    }
  }
  // 2026-08-25（AI 设计审计修复）：shared 纯逻辑抛的领域错误（seal/binding
  // plan 的确定性校验失败，全部为 4xx）是确定性结论，重试只会原样复现——且
  // 每次重试都重放 planner+author 的 LLM 调用（token 双花）。worker 与
  // packages/shared 之间只有单一物理副本，instanceof 判定可靠；api 子类
  // （CardGenerationV2ServiceError）继承本基类，同样被覆盖。
  if (error instanceof CardGenerationPipelineErrorV2) return true;
  return false;
}

function isRetryableProviderError(error: unknown): boolean {
  // ── round-8 🟡4 标注（保持现状 + 说明）────────────────────────────────────
  // 事务内 DB 抛的确定性"数据违约"错误（唯一约束违反 / RLS 拒绝 / 类型 cast 失败）
  // 也是普通 Error → 这里被判 retryable → 会重跑整条（可能 LP-heavy）管道最多 3 次
  // 才失败。因事务每次回滚，**安全但浪费**（LLM 模式下 token 双花，同 🟡3 机制）。
  // 未在此加代码级分类的理由：DB 错误码因 driver 而异，粗略按"查询错误 vs 连接瞬态"
  // 匹配易误判——把瞬态连接错误（connection reset/timeout/池耗尽）误判为 non-retryable
  // 会破坏既有的超时/5xx 重试语义，回归风险高于收益。激活前若要做，应让 worker 的 DB
  // 驱动对违反类错误（23xxx / 42xxx）抛出结构化（可判 non-retryable）错误，再据其校验
  // （pg error code 前缀）白名单分类；当前不做，仅在审计留档。
  // ──────────────────────────────────────────────────────────────────────
  return !isNonRetryableErrorLike(error);
}

/** 轻量可分类错误类型（避免依赖 providers 导致 worker 重边）。 */
class CardGenerationProviderErrorLike extends Error {
  readonly retryable: boolean;
  constructor(retryable: boolean, message: string) {
    super(message);
    this.name = "CardGenerationProviderError";
    this.retryable = retryable;
  }
}

/** 真实计算 QualityReportV2 的 reportHash（§12.4 report 绑定 exact closure）。 */
function simplifiedReportHash(fields: Record<string, unknown>): string {
  return hashCanonicalV2("card-generation-v2/quality-report", fields);
}

/**
 * 处理 V2 outbox job 的主入口。根据 jobType 分发到对应的处理函数。
 *
 * 2026-09-15（管线评审 H5/M1）：本函数持有一个 job 级的 AbortController——
 * 1. 租约丢失（renew 失败 = 已被 reaper 回收或移交给他人）时立即 abort：
 *    此前只置 `leaseLost` 标志，管道不做任何中途检查，已开始的 LLM 调用序列
 *    照常跑完（单调用最长 75s），最后 fence CAS 抛错回滚事务——DB 副作用被保护，
 *    但**全部 LLM 成本副作用已经损失**，且重投后新 owner 再跑一遍。现在 abort
 *    会让后续每次 chatJson 立即失败、阶段边界立即退出（`isRetryableProviderError`
 *    路径不再产生新调用），把不可回滚的成本损失压到最小。
 * 2. 墙钟预算（`V2_PIPELINE_BUDGET_MS`）到期同样 abort，并把 job 直接终结为
 *    failed（不重试：重试只会把同样的钱再花一遍），run → needs_attention。
 *
 * `signal` 会被透传到四个阶段的 provider 调用与逐候选循环。
 */
export async function processV2OutboxJob(job: PendingOutboxJob): Promise<void> {
  logger.info({ jobId: job.id, runId: job.runId, jobType: job.jobType }, "V2 outbox job processing");

  let retryable = true;
  let leaseLost = false;
  let budgetExhausted = false;
  const abortController = new AbortController();
  const pipelineSignal = abortController.signal;
  const budgetTimer = setTimeout(() => {
    budgetExhausted = true;
    logger.warn(
      { jobId: job.id, runId: job.runId, budgetMs: V2_PIPELINE_BUDGET_MS },
      "V2 pipeline wall-clock budget exhausted; aborting remaining LLM calls (terminal, no retry)",
    );
    abortController.abort(new Error(`V2 pipeline budget exhausted after ${V2_PIPELINE_BUDGET_MS}ms`));
  }, V2_PIPELINE_BUDGET_MS);
  budgetTimer.unref?.();

  const leaseRenewal = async (): Promise<void> => {
    try {
      const renewed = await renewV2OutboxLease(job.id, job.leaseToken);
      if (!renewed) {
        leaseLost = true;
        // H5：租约丢失 = 结果已被他人接管，继续执行只会烧钱。立即中止在途/后续调用。
        abortController.abort(new Error("V2 outbox lease lost"));
        logger.warn(
          { jobId: job.id, runId: job.runId },
          "V2 outbox lease was lost; aborting remaining LLM calls (late result suppressed)",
        );
      }
    } catch (error) {
      // 短暂 DB 故障不要立刻放弃；下一次 heartbeat 会重试。若租约实际过期，
      // 最后的 complete/fail 仍由 status+lease_token CAS 拦截。
      logger.warn(
        { jobId: job.id, runId: job.runId, error: sanitizeOperationalError(error) },
        "V2 outbox lease renewal failed",
      );
    }
  };
  const renewalTimer = setInterval(() => {
    void leaseRenewal();
  }, V2_LEASE_RENEWAL_INTERVAL_MS);
  renewalTimer.unref?.();

  try {
    switch (job.jobType) {
      case "card_generation_plan":
        await processCardGenerationPlan(job, pipelineSignal);
        break;
      case "card_generation_regenerate_candidate":
        await processRegenerateCandidateJob(job, pipelineSignal);
        break;
      case "card_generation_replan_set":
        await processReplanSetJob(job, pipelineSignal);
        break;
      case "card_generation_recheck_candidate":
        await processRecheckCandidateJob(job, pipelineSignal);
        break;
      case "card_v2_post_activation":
        // §17.5 step 17：outbox 异步投影消费——按 receiptId 幂等对账
        // （receipt/cards/objectives 存在性 + lifecycle 校验），对账结果写入
        // 台账；personal projection 保持 0 变化（表 CHECK 结构化强制）。
        // R33：由原 ack-only 改为真实消费者（见 processPostActivationProjection）。
        await processPostActivationProjection(job);
        break;
      default:
        // §17.1：未知 jobType → 失败（不得静默 complete）。
        throw new CardGenerationProviderErrorLike(false, `unknown V2 outbox job type: ${job.jobType}`);
    }

    await leaseRenewal();
    if (leaseLost) return;
    await completeV2OutboxJob(job.id, job.leaseToken);
  } catch (error) {
    if (leaseLost) return;
    const message = sanitizeOperationalError(error);
    if (budgetExhausted) {
      // M1：预算耗尽 = 确定性终止。重试会把同样的模型费用再花一遍，且必然
      // 同样超时，因此 non-retryable 直接终结（run → needs_attention）。
      logger.error(
        { jobId: job.id, runId: job.runId, error: message, budgetMs: V2_PIPELINE_BUDGET_MS },
        "V2 outbox job terminated: pipeline wall-clock budget exhausted",
      );
      await failV2OutboxJob(
        job.id,
        job.leaseToken,
        `V2 pipeline wall-clock budget exhausted after ${V2_PIPELINE_BUDGET_MS}ms (terminal, not retried)`,
        false,
      );
      return;
    }
    retryable = isRetryableProviderError(error);
    if (pipelineSignal.aborted && retryable) {
      // 调用方主动 abort（非预算）：不作为可重试失败回队列，直接按 non-retryable
      // 终结，避免"被取消的管道"立刻重放一遍完整 LLM 序列。
      retryable = false;
    }
    if (process.env.V2_E2E_DEBUG_ERRORS === "1") {
      // eslint-disable-next-line no-console
      console.error("V2_JOB_DEBUG", job.jobType, job.runId, (error as Error)?.stack ?? String(error));
    }
    logger.error({ jobId: job.id, runId: job.runId, error: message, retryable }, "V2 outbox job failed");
    await failV2OutboxJob(job.id, job.leaseToken, message, retryable);
  } finally {
    clearInterval(renewalTimer);
    clearTimeout(budgetTimer);
  }
}

/**
 * 阶段边界的中止检查（H5/M1）：在开始下一批付费调用之前确认调用方仍在等结果。
 *
 * provider 侧也会在看到已 abort 的 signal 时立即失败；此处的显式检查保证
 * **不再发起新的调用**（而不是发出后再中止），把成本损失压到最小。
 */
function throwIfPipelineAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("V2 pipeline aborted by caller");
}

/**
 * L1（2026-09-15 管线评审）：确定性 provider 只允许用于离线/测试路径。
 *
 * 生产环境里 V2 已启用但 `CARD_GENERATION_V2_LLM != "true"` 属于配置漂移：
 * 确定性 grounding 契约只校验"候选引用的证据 ID 都在 manifest 内"，不校验内容
 * 与证据的对应关系，会静默放行低质候选。此护栏与 `buildCardGenerationProviders`
 * 的"LLM 模式解析到 mock 即 fail-fast"方向对称：生产必须显式配置 LLM，
 * 或显式豁免离线模式（V2_ALLOW_DETERMINISTIC_PROVIDERS=1）。
 */
function assertDeterministicProvidersAllowed(useLLM: boolean): void {
  if (useLLM) return;
  if (process.env.NODE_ENV !== "production") return;
  if (process.env.V2_ALLOW_DETERMINISTIC_PROVIDERS === "1") return;
  throw new CardGenerationProviderErrorLike(
    false,
    "card-generation-v2 deterministic providers are not allowed in production: "
    + "set CARD_GENERATION_V2_LLM=true (LLM pipeline) or V2_ALLOW_DETERMINISTIC_PROVIDERS=1 (explicit offline override)",
  );
}

// ─── Post-Activation Projection Consumer（§17.5 step 17，R33）─────────────

/**
 * 消费 `card_v2_post_activation` outbox job：按 receiptId **幂等**对账
 * Card 列表/搜索/shared topology 投影。
 *
 * 语义（R33，替换原 ack-only 占位）：
 * 1. 台账已存在（同 workspace+receiptId）→ 已消费，直接返回（幂等重放）；
 * 2. receipt 必须存在且含 mappings（激活事务同事务写入；缺失 = 数据不一致
 *    → 非重试失败，不得静默完成；mappings 尚未就绪 = 时序瞬态 → retryable）；
 * 3. mapping 引用的 learning_cards_v2 / learning_objectives_v2 必须全部存在
 *    且 lifecycle='active'（shared topology 对账；任一缺失/未 active 可能是激活事务
 *    与下游 states 异步推进的时序窗口 → **retryable**，靠幂等重试自愈，而非
 *    一次性 failed 固化瞬时不一致）；payload 结构错误 → 非重试失败；
 * 4. 对账结果写入 `card_generation_post_activation_consumptions` 台账；
 *    personal projection 保持 0 变化——消费者唯一的写就是台账，且表 CHECK
 *    `personal_projection_writes = 0` 结构化强制（§17.5 step 17）。
 *
 * 全部读写在 ailearn_worker 角色 + workspace 上下文中执行（RLS NOBYPASSRLS
 * 验证，与主管线一致）。
 */
async function processPostActivationProjection(job: PendingOutboxJob): Promise<void> {
  // R33：payload 兼容两种落库形状——对象（drizzle insert）或 **jsonb 字符串**
  // （直接 postgres-js + `::jsonb` 的双编码路径）。归一化必须在结构校验**之前**：
  // 否则一次可正常消费的任务会被判成"结构错误"、以**非重试**失败固化下来
  // （实测 R33 用例即此路径：期望的失败原因是"台账里找不到 receipt"，而不是
  // "payload 不是对象"）。
  let normalizedPayload: unknown = job.payload;
  if (typeof normalizedPayload === "string") {
    try {
      normalizedPayload = JSON.parse(normalizedPayload);
    } catch {
      normalizedPayload = null;
    }
  }
  if (normalizedPayload === null || typeof normalizedPayload !== "object" || Array.isArray(normalizedPayload)) {
    throw new CardGenerationProviderErrorLike(
      false,
      `card_v2_post_activation payload must be an object: ${JSON.stringify(job.payload)}`,
    );
  }
  const rawPayload = normalizedPayload as Record<string, unknown>;
  const runId = rawPayload.runId;
  const workspaceId = rawPayload.workspaceId;
  const receiptId = rawPayload.receiptId;
  if (
    typeof workspaceId !== "string"
    || typeof runId !== "string"
    || typeof receiptId !== "string"
    || workspaceId.length === 0
    || runId.length === 0
    || receiptId.length === 0
  ) {
    throw new CardGenerationProviderErrorLike(
      false,
      `card_v2_post_activation payload missing fields: ${JSON.stringify(job.payload)}`,
    );
  }
  await withWorkerWorkspaceTransaction(
    { workspaceId, userId: null },
    async (tx) => {
      // 1. 幂等：台账已存在 → 已完成消费。
      const existing = await tx.execute(sql`
        SELECT id FROM public.card_generation_post_activation_consumptions
        WHERE workspace_id = ${workspaceId} AND receipt_id = ${receiptId}
        LIMIT 1
      `);
      if (existing.length > 0) return;

      // 2. receipt 必须存在。
      const receiptRows = await tx.execute(sql`
        SELECT mappings FROM public.card_activation_receipts_v2
        WHERE workspace_id = ${workspaceId} AND receipt_id = ${receiptId}
        LIMIT 1
      `);
      if (receiptRows.length === 0) {
        throw new CardGenerationProviderErrorLike(
          false,
          `post-activation receipt not found: ${receiptId}`,
        );
      }
      const mappings = (receiptRows[0] as { mappings: unknown }).mappings as Array<{
        candidateRevisionId: string;
        cardId: string;
        objectiveId: string;
      }>;
      if (!Array.isArray(mappings) || mappings.length === 0) {
        // 时序瞬态：receipt 行已可见但其 mappings 可能尚未提交/仍为空（激活事务
        // 提交与下游推进存在窗口）。按幂等对账类消费者重试是安全的（receiptId 去重），
        // 返 retryable 让 job 回 pending 限次重投，避免一次性 failed 固化瞬时不一致。
        throw new CardGenerationProviderErrorLike(
          true,
          `post-activation receipt has no mappings (retryable): ${receiptId}`,
        );
      }
      const cardIds = [...new Set(mappings.map((m) => m.cardId))];
      const objectiveIds = [...new Set(mappings.map((m) => m.objectiveId))];
      // R29/R32：drizzle+postgres-js 数组参数序列化不可靠（malformed array
      // literal）——显式 `{uuid,...}::uuid[]` 字面量（id 均来自本库 uuid 列）。
      const cardIdsLiteral = `{${cardIds.join(",")}}`;
      const objectiveIdsLiteral = `{${objectiveIds.join(",")}}`;

      // 3. Card/Objective 存在性 + lifecycle 对账（shared topology）。
      const cardRows = await tx.execute(sql`
        SELECT card_id, lifecycle FROM public.learning_cards_v2
        WHERE workspace_id = ${workspaceId} AND card_id = ANY(${cardIdsLiteral}::uuid[])
      `);
      const cardById = new Map(
        cardRows.map((r) => {
          const row = r as { card_id: string; lifecycle: string };
          return [String(row.card_id), String(row.lifecycle)] as const;
        }),
      );
      for (const id of cardIds) {
        const lifecycle = cardById.get(id);
        if (!lifecycle) {
          // 时序瞬态：卡片可能尚未落库/尚不可见（激活事务与下游 states 推进解耦）。
          // 对账类消费者重试安全（receiptId 幂等去重）→ retryable，避免固化瞬时不一致。
          throw new CardGenerationProviderErrorLike(true, `post-activation card missing (retryable): ${id}`);
        }
        if (lifecycle !== "active") {
          // lifecycle 可能由下游异步推进到 active——未就绪属于时序瞬态 → retryable。
          throw new CardGenerationProviderErrorLike(
            true,
            `post-activation card not active (retryable): ${id} (${lifecycle})`,
          );
        }
      }

      const objRows = await tx.execute(sql`
        SELECT objective_id, lifecycle FROM public.learning_objectives_v2
        WHERE workspace_id = ${workspaceId} AND objective_id = ANY(${objectiveIdsLiteral}::uuid[])
      `);
      const objById = new Map(
        objRows.map((r) => {
          const row = r as { objective_id: string; lifecycle: string };
          return [String(row.objective_id), String(row.lifecycle)] as const;
        }),
      );
      for (const id of objectiveIds) {
        const lifecycle = objById.get(id);
        if (!lifecycle) {
          // 同卡卡的时序瞬态：objective 可能尚不可见 → retryable（幂等重试安全）。
          throw new CardGenerationProviderErrorLike(true, `post-activation objective missing (retryable): ${id}`);
        }
        if (lifecycle !== "active") {
          throw new CardGenerationProviderErrorLike(
            true,
            `post-activation objective not active (retryable): ${id} (${lifecycle})`,
          );
        }
      }

      // 4. 台账写入（幂等；personal_projection_writes=0 由表 CHECK 强制）。
      await tx.execute(sql`
        INSERT INTO public.card_generation_post_activation_consumptions
          (workspace_id, run_id, receipt_id, card_ids, objective_ids,
           reconciled_card_count, reconciled_objective_count, personal_projection_writes)
        VALUES (${workspaceId}, ${runId}, ${receiptId},
                ${cardIdsLiteral}::uuid[], ${objectiveIdsLiteral}::uuid[],
                ${cardIds.length}, ${objectiveIds.length}, 0)
        ON CONFLICT (workspace_id, receipt_id) DO NOTHING
      `);
      logger.info(
        { jobId: job.id, runId: job.runId, receiptId, cardCount: cardIds.length, objectiveCount: objectiveIds.length },
        "V2 post-activation projection consumed (idempotent ledger written)",
      );
      await fenceV2OutboxLease(tx, job);
    },
  );
}

// ─── Sealed Evidence Loader ──────────────────────────────────────────────

/**
 * 单条证据文本进入 prompt 的字符上限（评审 M7）。
 *
 * Grounding 阶段每个候选都会携带**全部**证据引文，token 成本为
 * O(candidates × evidence)；不分块/不设上限时大笔记会直接顶穿模型上下文。
 * 上限只作用于**prompt 呈现**，sealed 证据本身的哈希/偏移/闭包不受影响
 * （quoteHash 仍来自完整切片）。
 */
export const V2_EVIDENCE_QUOTE_MAX_CHARS = (() => {
  const raw = Number(process.env.V2_EVIDENCE_QUOTE_MAX_CHARS ?? 2_000);
  return Number.isInteger(raw) && raw > 0 ? raw : 2_000;
})();

/**
 * 每 job 全部证据文本的合计上限（评审 M7）：按 blockId 顺序累计，超出的引文
 * 截断到剩余额度（额度耗尽则为空串），避免"证据数 × 单条上限"仍然爆炸。
 */
export const V2_EVIDENCE_TOTAL_MAX_CHARS = (() => {
  const raw = Number(process.env.V2_EVIDENCE_TOTAL_MAX_CHARS ?? 40_000);
  return Number.isInteger(raw) && raw > 0 ? raw : 40_000;
})();

/** 源文本（scoped note join）进入 author prompt 的字符上限（评审 M7）。 */
export const V2_SOURCE_CONTENT_MAX_CHARS = (() => {
  const raw = Number(process.env.V2_SOURCE_CONTENT_MAX_CHARS ?? 60_000);
  return Number.isInteger(raw) && raw > 0 ? raw : 60_000;
})();

/**
 * 源文本规模上限（M7）：超限时截断并显式告警（不静默）。
 *
 * 原注释自认"大笔记可达数十万字符"且"激活前须为源文本设规模上限或分块"——
 * 本函数兑现该上限：单 job 的内存峰值与 prompt token 规模被钉住。
 */
export function capSourceContentForPrompts(
  sourceContent: string,
  workspaceId: string,
): { content: string; truncated: boolean } {
  if (sourceContent.length <= V2_SOURCE_CONTENT_MAX_CHARS) {
    return { content: sourceContent, truncated: false };
  }
  logger.warn(
    {
      workspaceId,
      sourceLength: sourceContent.length,
      limit: V2_SOURCE_CONTENT_MAX_CHARS,
    },
    "V2 source content truncated for prompts (规模上限，防止 token/内存峰值)",
  );
  return { content: sourceContent.slice(0, V2_SOURCE_CONTENT_MAX_CHARS), truncated: true };
}

/** 证据文本规模上限（M7）：逐条 + 合计双上限，超限时告警。 */
function capEvidenceTextForPrompts(
  evidence: SealedEvidenceEntryV2[],
  workspaceId: string,
): void {
  let remaining = V2_EVIDENCE_TOTAL_MAX_CHARS;
  let truncated = 0;
  for (const entry of evidence) {
    const text = entry.content ?? "";
    const perEntry = text.slice(0, V2_EVIDENCE_QUOTE_MAX_CHARS);
    const allowed = Math.max(0, Math.min(perEntry.length, remaining));
    if (allowed < text.length) truncated += 1;
    entry.content = perEntry.slice(0, allowed);
    remaining -= allowed;
  }
  if (truncated > 0) {
    logger.warn(
      {
        workspaceId,
        truncatedEntries: truncated,
        totalEntries: evidence.length,
        perEntryLimit: V2_EVIDENCE_QUOTE_MAX_CHARS,
        totalLimit: V2_EVIDENCE_TOTAL_MAX_CHARS,
      },
      "V2 evidence text truncated for prompts (规模上限，防止 O(candidates × evidence) token 膨胀)",
    );
  }
}

async function loadSealedEvidence(tx: WorkerTransaction, workspaceId: string, sourceSnapshotId: string) {
  const snapshotRows = (await tx.execute(sql`
    SELECT evidence_snapshot_id, evidence_snapshot_hash, source_snapshot_id, block_id,
           start_offset, end_offset, quote_hash, block_content_hash
    FROM public.evidence_snapshots_v2
    WHERE workspace_id = ${workspaceId} AND source_snapshot_id = ${sourceSnapshotId}
    ORDER BY block_id, start_offset
  `)) as Array<Record<string, unknown>>;
  const evidence: SealedEvidenceEntryV2[] = snapshotRows.map((r) => ({
    evidenceSnapshotId: String(r.evidence_snapshot_id),
    evidenceSnapshotHash: String(r.evidence_snapshot_hash),
    sourceSnapshotId: String(r.source_snapshot_id),
    blockId: String(r.block_id),
    startOffset: Number(r.start_offset),
    endOffset: Number(r.end_offset),
    quoteHash: r.quote_hash ? String(r.quote_hash) : "",
    blockContentHash: String(r.block_content_hash),
  }));

  let eligibility: Array<{ evidenceSnapshotId: string; eligibilityEpoch: number; status: string; stateHash: string }> = [];
  if (evidence.length > 0) {
    const eligRows = (await tx.execute(sql`
      SELECT ees.evidence_snapshot_id, ees.eligibility_epoch, ees.status, ees.eligibility_vector_hash
      FROM public.evidence_eligibility_states_v2 ees
      JOIN public.evidence_snapshots_v2 es ON es.evidence_snapshot_id = ees.evidence_snapshot_id
      WHERE ees.workspace_id = ${workspaceId} AND es.source_snapshot_id = ${sourceSnapshotId}
    `)) as Array<Record<string, unknown>>;
    eligibility = eligRows.map((r) => ({
      evidenceSnapshotId: String(r.evidence_snapshot_id),
      eligibilityEpoch: Number(r.eligibility_epoch),
      status: String(r.status),
      stateHash: String(r.eligibility_vector_hash),
    }));
  }

  // R29：Grounding 需要真实证据文本——按 blockId 查 note_blocks，按 [startOffset, endOffset) 切片。
  if (evidence.length > 0) {
    const blockIds = [...new Set(evidence.map((e) => e.blockId))];
    // drizzle+postgres-js 对数组参数的序列化不可靠（malformed array literal）——
    // 手工构造 {uuid,...} 字面量并 cast。
    const blockIdsLiteral = `{${blockIds.join(",")}}`;
    const blockRows = (await tx.execute(sql`
      SELECT id, content FROM public.note_blocks WHERE id = ANY(${blockIdsLiteral}::uuid[])
    `)) as Array<{ id: string; content: string }>;
    const byId = new Map(blockRows.map((b) => [String(b.id), String(b.content ?? "")]));
    for (const e of evidence) {
      const blockText = byId.get(e.blockId) ?? "";
      // AI P0-11（2026-09-15 审计）：seal 时写入的 block_content_hash / quote_hash
      // 此前从未被重算。note_blocks.content 在 autosave 中是**原地 UPDATE**
      // （apps/api/src/modules/note/service.ts:452-467）——block id 不变、正文可变，
      // 于是"seal 之后、worker 读取之前"编辑笔记，会让**新正文配上旧 hash** 进入
      // 制卡管道：grounding 的 evidence 闭包与落库的 evidenceSetHash 都声称是旧内容。
      // 伴星路径（companion-grounded-evidence.ts:44-49）与 learning-runs Critic
      // （run-critic.ts:364-369）都会在这里 throw；本路径此前是唯一缺口。
      // 非重试：笔记已改，重放同一 snapshot 不会自愈，必须重新 seal。
      if (hashCanonicalV2("block", { content: blockText }) !== e.blockContentHash) {
        throw new CardGenerationProviderErrorLike(
          false,
          `sealed evidence block changed since seal (evidenceSnapshotId=${e.evidenceSnapshotId}, blockId=${e.blockId}): note edited after seal`,
        );
      }
      const start = Math.max(0, Number(e.startOffset ?? 0));
      const end = Math.min(blockText.length, Number(e.endOffset ?? blockText.length));
      const quote = blockText.slice(start, end);
      if (e.quoteHash && hashCanonicalV2("evidence-quote", { quote }) !== e.quoteHash) {
        throw new CardGenerationProviderErrorLike(
          false,
          `sealed evidence quote changed since seal (evidenceSnapshotId=${e.evidenceSnapshotId}, blockId=${e.blockId})`,
        );
      }
      e.content = quote;
    }
    capEvidenceTextForPrompts(evidence, workspaceId);
  }

  const evidenceManifest: AssemblerEvidenceManifest = {
    workspaceId,
    sourceSnapshotId,
    evidence,
  };
  return {
    evidenceManifest,
    eligibility,
    evidenceSetHash: computeCandidateEvidenceSetHashV2(
      evidence.map((e) => ({ evidenceSnapshotId: e.evidenceSnapshotId, evidenceSnapshotHash: e.evidenceSnapshotHash })),
    ),
  };
}

/**
 * 执行完整的 V2 四阶段生成管道（A1 · B1：计划与作者**分两次提交**）。
 *
 * 为什么拆：整条管道原先在同一个事务里，计划行、候选行、终态要么一起出现要么一起
 * 消失——"崩在作者中途"等于整批作废、已付费的 planner 调用一起赔进去。拆成两段之后
 * 计划先进库，重投只需读回它（§39 事实 2：`planRevisionId` 每次执行现造，
 * 若重放时"复用上次候选 + 用这版新计划继续跑"，审计链当场断裂）。
 *
 * 代价与它的前置（§39 事实 3/4）：`run.status` 一旦提前提交，"看状态"的入口守卫就会把
 * 重投变成**静默空转**（run 永远停在 authoring，这篇笔记此后每次生成都吃 409）。
 * 所以判活改看**自己那条 outbox 租约**：每段事务提交前都核对一次，核对不过就停下不写。
 *
 * `signal`：job 级取消信号（租约丢失 / 墙钟预算耗尽）——透传到四个阶段的
 * LLM 调用与逐候选循环（H5/M1）。
 */
async function processCardGenerationPlan(job: PendingOutboxJob, signal?: AbortSignal): Promise<void> {
  const { workspaceId, runId } = job;
  const useLLM = process.env.CARD_GENERATION_V2_LLM === "true";
  // L1（评审）：确定性 provider 只能用于离线/测试路径（见 helper 说明）。
  assertDeterministicProvidersAllowed(useLLM);

  // 治理（同意 + 数据外发政策 + provider 选择）必须在事务外解析，理由见
  // resolveCardGenerationGovernance 的注释。确定性路径不出网，因而不需要它。
  const governanceContext = useLLM
    ? await resolveCardGenerationGovernance(workspaceId, runId)
    : null;

  const planPhase = await runV2PlanPhase(job, signal, governanceContext);
  if (planPhase.kind !== "continued") {
    // yielded = 别的租约已把这个批次跑到终态之后又重投；finished = 零卡是成功终态。
    // 两种都不该继续花作者的钱。
    if (planPhase.kind === "yielded") {
      logger.info({ runId }, "[v2-pipeline] plan phase yielded (terminal state or already resumed elsewhere)");
    }
    return;
  }
  await runV2AuthoringPhase(job, signal, governanceContext);
}

/**
 * 阶段一：规划 + 把计划提交出去（自己的短事务）。
 *
 * - `planning`（含尚未推进的 `queued`/`source_sealing`）→ 真规划一次，落计划行、
 *   `current_plan_version`、`status='authoring'`，一次提交；
 * - `authoring`/`checking` → 上一遍已把计划交出去了，**读回同一版**，不再规划；
 * - 终态 → 让路（今天也是让路，这里是回归位）。
 */
async function runV2PlanPhase(
  job: PendingOutboxJob,
  signal: AbortSignal | undefined,
  governanceContext: Awaited<ReturnType<typeof resolveCardGenerationGovernance>> | null,
): Promise<{ kind: "continued" } | { kind: "yielded" } | { kind: "finished" }> {
  const { workspaceId, runId } = job;
  const useLLM = process.env.CARD_GENERATION_V2_LLM === "true";

  // ── 短事务 A：门闩 + 读输入 + 路由事件（D5 §5.2 第三件第 1 步，39d W3-2）────
  // 这里原来是一整段**分钟级事务**：入口 `FOR UPDATE` 拿到 run 行锁后一路持到规划
  // 跑完，于是"持业务行锁等外部模型"（D5 §5.1 实测的两处之一，`:1417`）。
  // 双跑防护本来就不挂在这把锁上：`fenceV2OutboxLease`（outbox 租约）在入口挡
  // "要不要发起这次付费调用"，同一道闩在短事务 B 开头再核一次挡提交；锁只管它
  // 自己注释里那句话——串行化"同一 run 在同一时刻的两个提交"。
  const prepared = await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    // 1. Load run（FOR UPDATE 行锁：防止同 run 的双 job 并发跑完整 LLM 管道，
    //    避免 TOCTOU 双份计费/双写终态。在 withWorkerWorkspaceTransaction 事务内
    //    持锁到提交，契合 W2。）
    //    ── A1 · B1 之后这把锁只覆盖**规划段**（此前覆盖四阶段全程）─────────────
    //    双跑防护不再靠"锁住到作者跑完"，而是靠 outbox 租约：本函数第一句就核对
    //    租约是不是自己的（`fenceV2OutboxLease`：status=processing + token 相同 +
    //    未过期，并顺手续期），不是自己的就抛错、一个字都不写。锁只用来串行化
    //    "同一 run 在同一时刻的两个提交"。
    //    2026-09-15（管线评审 H4 部分缓解）：job 级墙钟预算（V2_PIPELINE_BUDGET_MS，
    //    到期 abort 并终结）与租约丢失即时 abort（H5）仍在，最坏占用有确定上界。
    const runRows = await tx.execute(sql`
      SELECT id, workspace_id, note_id, note_version_id, status, card_content_epoch,
             semantic_spec, input_snapshot, semantic_spec_hash, input_snapshot_hash,
             current_plan_version
      FROM public.card_generation_runs_v2
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
      FOR UPDATE
      LIMIT 1
    `);
    if (runRows.length === 0) {
      // 确定性数据违约（run 不存在）：非重试，job 直接 failed（§17.5 口径）
      throw new CardGenerationProviderErrorLike(false, `V2 run not found: ${runId}`);
    }
    const run = runRows[0] as {
      id: string; workspace_id: string; note_id: string; note_version_id: string;
      status: string; card_content_epoch: number;
      semantic_spec: Record<string, unknown>; input_snapshot: Record<string, unknown>;
      semantic_spec_hash: string; input_snapshot_hash: string;
      current_plan_version: number;
    };

    // 入口门闩（§39 第 3 条）：判活看租约，不看 run.status。
    // 它比提交前的那道同名核对多管一件事：**根本不发起已付费的规划调用**。
    // 库里看不出差别（两道闩都挡写），差别在钱上——那一半只能由 B5 的真跑量出来。
    await fenceV2OutboxLease(tx, job);

    if (run.status === "authoring" || run.status === "checking") {
      // 重放：上一遍已经把计划提交了（也许还有半成品候选）。这里**不重新规划**，
      // 只确认这一版计划在库里可读回——读不到就是状态与数据矛盾，fail-closed。
      const committed = await tx.execute(sql`
        SELECT 1 AS ok FROM public.card_generation_plans_v2
        WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
          AND plan_version = ${run.current_plan_version}
        LIMIT 1
      `);
      if (committed.length === 0) {
        throw new CardGenerationProviderErrorLike(
          false,
          `V2 run is ${run.status} but plan v${run.current_plan_version} is not committed`,
        );
      }
      logger.info({
        runId, status: run.status, planVersion: run.current_plan_version,
      }, "[v2-pipeline] resuming from the committed plan (planner not re-run)");
      return { kind: "continued" as const };
    }

    if (!["queued", "source_sealing", "planning"].includes(run.status)) {
      // 终态（review_ready / needs_attention / no_cards_recommended / activated / …）：
      // 重投安静让路，什么都不改。
      logger.info({ runId, status: run.status }, "V2 run already settled, skipping");
      return { kind: "yielded" as const };
    }

    const inputSnapshot = run.input_snapshot as unknown as GenerationInputSnapshotV2;
    const semanticSpec = run.semantic_spec as unknown as GenerationSemanticSpecV2;
    // 存储时 input_snapshot_hash/semantic_spec_hash 是对"无自引用字段"的对象计算的
    // （§9.2），读回后先补齐，再按 §24 做 zod 严格校验（非法 schema fail-closed，
    // 违反契约直接以非重试错误失败 job，绝不带病生成）。
    inputSnapshot.inputSnapshotHash = run.input_snapshot_hash;
    semanticSpec.semanticSpecHash = run.semantic_spec_hash;
    const specParse = generationSemanticSpecV2Schema.safeParse(semanticSpec);
    if (!specParse.success) {
      const paths = specParse.error.issues.map((i) => i.path.join(".")).join(",");
      // schema 违反是永久错误：非重试，job 直接 failed（§24 fail-closed）
      throw new CardGenerationProviderErrorLike(false, `V2 semantic spec schema violation: ${paths}`);
    }
    const snapshotParse = generationInputSnapshotV2Schema.safeParse(inputSnapshot);
    if (!snapshotParse.success) {
      const paths = snapshotParse.error.issues.map((i) => i.path.join(".")).join(",");
      throw new CardGenerationProviderErrorLike(false, `V2 input snapshot schema violation: ${paths}`);
    }
    const sourceSnapshotId = inputSnapshot.sourceSnapshot.sourceSnapshotId;

    // 2. Load sealed evidence + eligibility（不再直读 note_blocks 作为 closure；
    //    sourceScope 已在 seal 阶段体现）。
    const sealed = await loadSealedEvidence(tx, workspaceId, sourceSnapshotId);

    // 3. Load note blocks（filtered by sourceScope）作为 LLM 输入文本
    const blockRows = (await tx.execute(sql`
      SELECT id, type, content, ordinal
      FROM public.note_blocks
      WHERE version_id = ${run.note_version_id}
      ORDER BY ordinal ASC
    `)) as Array<{ id: string; type: string; content: string; ordinal: number }>;

    const scopedBlocks = filterBlocksBySourceScope(
      blockRows.map((b) => ({ blockId: b.id, type: b.type, content: b.content, ordinal: b.ordinal })),
      inputSnapshot.rawRequest.sourceScope,
    ).map((s) => ({ blockId: s.block.blockId, type: s.block.type, content: s.slice, ordinal: s.block.ordinal }));
    // §14.2（R36）：被 seal 剔除的非文本模态 block（image/code/diagram/formula/
    // table）——region evidence 未实现时这些来源无法可靠制卡，必须显式提示，
    // 不得静默跳过或回退为无来源文本猜测。
    const unsupportedSourceBlocks = blockRows
      .filter((b) => ["image", "code", "diagram", "formula", "table"].includes(String(b.type ?? "").toLowerCase()))
      .map((b) => ({ blockId: b.id, type: b.type, content: b.content, ordinal: b.ordinal }));
    // ── M7（2026-09-15 管线评审）：整份 scoped note 的 source text join 成单
    //    sourceContent 字符串，并随 sealed evidence 一起贯穿四阶段 LLM 输入/内存。
    //    历史上大笔记可达数十万字符且无上限——现在经 capSourceContentForPrompts
    //    设硬上限（超限截断 + 告警），把单 job 内存峰值与 prompt token 规模钉住；
    //    sealed 证据的哈希/偏移闭包不受影响（证据文本另有逐条 + 合计双上限）。
    const sourceContent = capSourceContentForPrompts(
      scopedBlocks.map((b) => b.content).join("\n"),
      workspaceId,
    ).content;

    // 4a. R35/§10.2：显式管线路由（light/standard）——判定 + 事件 + 观测。
    //     路由不改变质量要求（Grounding/Pedagogy 仍独立成立），只决定编排标记。
    //     注意：scopedBlocks 经 filterBlocksBySourceScope 过滤（code/image 等
    //     非 sealable 类型被剔除），路由判定必须基于原始 blockRows 才能看到
    //     非文本模态（region evidence 未实现时 code 走拒绝路径，但路由仍须 standard）。
    const { classifyV2PipelineRoute } = await import("../card-generation-v2/pipeline-route.ts");
    const routeResult = classifyV2PipelineRoute({
      blocks: blockRows.map((b) => ({ type: String(b.type), content: String(b.content) })),
      evidenceCount: sealed.evidenceManifest.evidence.length,
      sourceTextLength: sourceContent.length,
    });
    await insertEvent(tx, workspaceId, runId, routeResult.route === "light"
      ? "pipeline.route.light"
      : "pipeline.route.standard", {
      reasons: routeResult.reasons,
      evidenceCount: sealed.evidenceManifest.evidence.length,
      sourceTextLength: sourceContent.length,
    });

    // 4. Load existing active objectives for dedup
    const existingObjRows = (await tx.execute(sql`
      SELECT lor.objective_id, lor.semantic_target_fingerprint,
             lor.objective_statement, lor.public_summary
      FROM public.learning_objective_revisions_v2 lor
      JOIN public.learning_objectives_v2 lo ON lo.objective_id = lor.objective_id
        AND lo.workspace_id = lor.workspace_id
      WHERE lo.workspace_id = ${workspaceId}
        AND lo.lifecycle = 'active'
        AND lor.revision = lo.current_revision
    `)) as Array<{
      objective_id: string; semantic_target_fingerprint: string;
      objective_statement: string; public_summary: string;
    }>;
    const existingObjectives: ExistingObjectiveRef[] = existingObjRows.map((r) => ({
      objectiveId: r.objective_id,
      semanticTargetFingerprint: r.semantic_target_fingerprint,
      objectiveStatement: r.objective_statement,
      publicSummary: r.public_summary,
    }));

    return {
      kind: "plan" as const,
      inputSnapshot,
      semanticSpec,
      scopedBlocks,
      unsupportedSourceBlocks,
      existingObjectives,
      evidenceManifest: sealed.evidenceManifest,
    };
  });

  // 重放（上一遍已交计划）与终态让路：这两支**不发起付费调用**，原样返回。
  if (prepared.kind !== "plan") return prepared;

  // ── 事务外：这一版计划的付费调用 ──────────────────────────────────────────
  // 4a. 构造 providers（LLM 或确定性）。它也搬出来了：provider 选择要读治理与
  //     配置，留在事务里等于让"读配置"也跟着持锁。
  const providers = useLLM
    ? await buildProvidersForRun({
        workspaceId, job, semanticSpec: prepared.semanticSpec, governanceContext,
      })
    : null;

  // 5. Execute Planner
  //    H5/M1：阶段边界检查——租约已丢失或预算已耗尽时不再发起新的付费调用。
  throwIfPipelineAborted(signal);
  const plannerResult = await executePlanner({
    runId,
    workspaceId,
    inputSnapshot: prepared.inputSnapshot,
    semanticSpec: prepared.semanticSpec,
    blocks: prepared.scopedBlocks,
    unsupportedSourceBlocks: prepared.unsupportedSourceBlocks,
    existingObjectives: prepared.existingObjectives,
    clientHardMaxCards: prepared.inputSnapshot?.rawRequest?.quantity?.hardMaxCards,
    extractionProvider: providers ? providers.plannerExtraction : undefined,
    // M3：把 sealed 证据清单与取消信号交给 planner（prompt 中"从可用证据 ID
    // 列表选择 evidenceRefIds"此前无从满足，existingObjectives 也恒为空）。
    evidenceList: prepared.evidenceManifest.evidence.map((e) => ({
      evidenceSnapshotId: e.evidenceSnapshotId,
      quoteHash: e.quoteHash ?? null,
    })),
    signal,
  });

  // ── 短事务 B：再核门闩 → 写这一版计划 → 推状态 ────────────────────────────
  // A 与 B 之间隔着一次外部调用，那期间租约可能被 reaper 拿走、job 可能已 aborted。
  // 拒收靠的是本事务**结尾**那两道 `fenceV2OutboxLease`（两个返回分支各一道）：
  // 它们与上面的写在同一个事务里，核对不过就整段回滚——旧尝试的规划结果一行都落不下去。
  return withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    // 6. Persist plan
    const plan = plannerResult.plan;
    // 2026-08-16（实机验证，溯源日志）：planner 阶段结果摘要。
    logger.info({
      runId,
      stage: "planner",
      resultKind: plan.result.kind,
      objectiveCount: plan.result.kind === "author_candidates" ? plan.result.objectives.length : 0,
      atomDecisions: plan.atomDecisions.length,
      planHash: plan.planHash,
    }, "[v2-pipeline] planner completed");
    await tx.execute(sql`
      INSERT INTO public.card_generation_plans_v2
        (id, workspace_id, run_id, plan_revision_id, plan_version, previous_plan_revision_id,
         input_snapshot_hash, card_content_epoch, result, atom_decisions, plan_hash)
      VALUES (
        ${randomUUID()}, ${workspaceId}, ${runId}, ${plan.planRevisionId},
        ${plan.planVersion}, NULL,
        ${plan.inputSnapshotHash}, ${plan.cardContentEpoch},
        ${JSON.stringify(plan.result)}::jsonb,
        ${JSON.stringify(plan.atomDecisions)}::jsonb,
        ${plan.planHash}
      )
    `);

    await tx.execute(sql`
      UPDATE public.card_generation_runs_v2
      SET current_plan_version = ${plan.planVersion}, updated_at = now()
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
    `);

    await insertEvent(tx, workspaceId, runId, "card_generation.plan_completed", {
      planRevisionId: plan.planRevisionId,
      planHash: plan.planHash,
      resultKind: plan.result.kind,
    });

    // 7. If no_cards_recommended → 成功终态，不进 Author
    if (plan.result.kind === "no_cards_recommended") {
      await tx.execute(sql`
        UPDATE public.card_generation_runs_v2
        SET status = 'no_cards_recommended', error_code = NULL, error_message = NULL, updated_at = now()
        WHERE id = ${runId} AND workspace_id = ${workspaceId}
      `);
      await insertEvent(tx, workspaceId, runId, "card_generation.no_cards_recommended", {
        reasonCodes: plan.result.reasonCodes,
      });
      await fenceV2OutboxLease(tx, job);
      return { kind: "finished" as const };
    }

    // 8. 计划已冻结 → 状态推进到 authoring，并**在这里提交**。
    //    界面上这一刻起就是"正在出卡"（`LIVE_PROGRESS_STATUSES` 含 authoring，A2 那句
    //    "第几步"的读数因此也一起活了），而库里还没有任何候选行——这正是 A1 的起点。
    await tx.execute(sql`
      UPDATE public.card_generation_runs_v2
      SET status = 'authoring', error_code = NULL, error_message = NULL, updated_at = now()
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
    `);
    await fenceV2OutboxLease(tx, job);
    return { kind: "continued" as const };
  });
}

/**
 * 读回这一版计划**已经落库的首稿候选**（A1·B2 的复用来源）。
 *
 * 单独一条只读事务：作者阶段不在任何大事务里，所以这里也不能"顺手借用"外层 tx——
 * 借了就等于把逐张提交重新放回持锁期间（见 `runV2AuthoringPhase` 的说明）。
 * 只认 revision=1：更高的 revision 属于有界修复/重生成，永远要重走门禁，
 * 不能被当成"这一遍已经交过稿"。
 */
async function loadCommittedFirstRevisions(
  workspaceId: string,
  runId: string,
  planVersion: number,
): Promise<Array<Record<string, unknown>>> {
  return withWorkerWorkspaceTransaction(
    { workspaceId, userId: null },
    async (tx) => (await tx.execute(sql`
      SELECT * FROM public.card_generation_candidates_v2
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
        AND plan_version = ${planVersion} AND revision = 1
    `)) as unknown as Array<Record<string, unknown>>,
    { isolated: true },
  );
}

/**
 * 阶段二：作者 + 双 Critic + deck gate + 终态（自己的事务）。
 *
 * 入口用 `loadV2RunInputs`（与 regenerate/replan/recheck 同一个加载器）：它 FOR UPDATE
 * 锁 run、按 `current_plan_version` 读回**那一版已提交的计划**，所以重放时作者拿到的是
 * 同一套计划身份（§39 事实 2），不是重新规划的第二个 planRevisionId。
 */
async function runV2AuthoringPhase(
  job: PendingOutboxJob,
  signal: AbortSignal | undefined,
  governanceContext: Awaited<ReturnType<typeof resolveCardGenerationGovernance>> | null,
): Promise<void> {
  const { workspaceId, runId } = job;
  const useLLM = process.env.CARD_GENERATION_V2_LLM === "true";

  // 读输入用的是**自己的短事务**，读完就把锁放掉（A1 · B2）。
  //
  // 为什么不能让作者待在阶段二的大事务里：候选表对 run 行有外键，插子表要拿父行的
  // FOR KEY SHARE，而 `loadV2RunInputs` 的 `SELECT … FOR UPDATE` 与它互斥——
  // 逐张提交若发生在外层持锁期间，就是同一条管道自己等自己（实测：Postgres 判死锁，
  // 整条 job 失败，库里一张候选都没有）。拆成"读 → 逐张提交 → 评审"三段之后，
  // 只有评审段重新锁 run。
  const ctx = await withWorkerWorkspaceTransaction(
    { workspaceId, userId: null },
    async (tx) => await loadV2RunInputs(tx, workspaceId, runId),
  );
  {
    // 加载器把 run 行读成开放记录（它同时服务 regenerate/replan/recheck 三种口径），
    // 本阶段只用到哈希闭包这两列。
    const run = ctx.run as { input_snapshot_hash: string; semantic_spec_hash: string };
    const semanticSpec = ctx.semanticSpec;
    const sealed = ctx.sealed;
    const sourceContent = ctx.sourceContent;
    const existingObjectives = ctx.existingObjectives;
    const plan = ctx.plan;
    if (!plan) {
      // 阶段一保证过计划已提交；读不到就是数据矛盾，非重试（绝不"没有计划也照样跑"）。
      throw new CardGenerationProviderErrorLike(false, `V2 authoring phase has no committed plan: ${runId}`);
    }
    const providers = useLLM
      ? await buildProvidersForRun({ workspaceId, job, semanticSpec, governanceContext })
      : null;

    // 8+12. 按候选**流水线**执行 author → 逐张落盘 → grounding（A1·B2 + 极限延迟改造）。
    //
    // 此前是两段独立的并发波：等**全部** author 完成 → 再发起 grounding 波，
    // 墙钟 = max(author_i) + max(grounding_i)——每个波的**最慢**一次调用被各付一次。
    // 现在每个候选自己串成一条链（author_i → 提交_i → precheck → grounding_i），候选之间
    // 并发：墙钟 = max(author_i + grounding_i) ≤ max(author_i) + max(grounding_i)。
    //
    // A1·B2 改的是"什么时候进库"：候选一出作者的手就**单独提交**（`commitAuthoredCandidateV2`），
    // 于是第 1 张写完另一条连接就看得见，崩溃也不再赔掉整批作者调用；重放时同目标已有行的
    // 那张**不再调作者**，直接用库里那条（§39 事实 2：身份必须沿用已提交那一版）。
    // 其余不变：调用次数、候选顺序、落库语句顺序都与改造前一致。
    throwIfPipelineAborted(signal);
    // 这一版计划已经落库的候选（重放/并发的复用来源）。只认 revision=1：那是作者首稿，
    // 更高的 revision 属于有界修复/重生成，永远要重走门禁，不能被当成"已交过的稿"。
    const committedRows = await loadCommittedFirstRevisions(workspaceId, runId, plan.planVersion);
    const committedByObjective = new Map(committedRows.map((row) => [
      String(row.plan_objective_local_id),
      candidateRowToObject(row, runId),
    ]));
    /**
     * 这一遍**没有叫作者**的那几张（`authored_reused` 事件的定义就是这个：跳过作者）。
     * 注意不要把"插入了才发现库里已有"也算进来——那种情况作者已经被叫过、钱已经付了，
     * 记成复用就是把审计写假（只在上面 `stored` 分支里 push）。
     */
    const reusedCandidates: LearningCardCandidateRevisionV2[] = [];
    const authoringProvider: AuthoringProvider = providers
      ? providers.author
      : new DeterministicAuthoringProvider();
    const authorInput = {
      runId,
      workspaceId,
      plan,
      sourceContent,
      semanticSpecHash: run.semantic_spec_hash,
      provider: authoringProvider,
      evidenceList: sealed.evidenceManifest.evidence.map((e) => ({
        evidenceSnapshotId: e.evidenceSnapshotId,
        quoteHash: e.quoteHash ?? null,
      })),
      // M2：sealed manifest 的 evidenceSetHash 是 candidateRevisionHash 的闭包
      // 输入——由调用方给出，author-service 不再使用 provider 自报值。
      evidenceSetHash: sealed.evidenceSetHash,
      signal,
      providerConcurrency: V2_STAGE_CONCURRENCY,
    };
    const pipelineAbort = new AbortController();
    const pipelineSignal = signal ? AbortSignal.any([signal, pipelineAbort.signal]) : pipelineAbort.signal;
    // §8.5：作者预算 = plan.activationHardMax（**不得扩大**）。超出预算会让
    // deck gate 以 count_out_of_plan 硬失败整条 run——内容通过两道 critic 也交付不了。
    const planObjectives = budgetedPlanObjectives(plan);
    /**
     * 按下标（= 计划顺序）收集已 author 的候选。
     *
     * 必须按**计划顺序**而不是"author 完成顺序"：mapWithConcurrency 的完成顺序是
     * 乱的，而最终牌堆（grounding 通过 ∧ 去重后）是计划顺序。投机 pedagogy 的复用
     * 守卫要求逐位相同，用完成顺序会让守卫**每次都失败**（实测：pedagogy 被调用两次、
     * 墙钟反而变慢）——守卫本身是对的，错的是喂给它的序列。
     */
    const authoredByIndex: Array<LearningCardCandidateRevisionV2 | undefined> =
      new Array(planObjectives.length);
    let authoredCount = 0;
    /**
     * 与正常路径**同源**的 per-candidate soft precheck 信号。
     * 投机调用必须拿到与"收尾阶段重新计算"完全一致的输入（同一个纯函数、
     * 同一份候选与 sourceContent），否则复用路径与重跑路径的 pedagogy 输入不等价。
     */
    const softSignalsForPedagogy: Record<string, QualityIssue[]> = {};
    let speculativePedagogy: Promise<SpeculativePedagogy | null> | null = null;
    const startSpeculativePedagogy = (
      judged: LearningCardCandidateRevisionV2[],
    ): Promise<SpeculativePedagogy | null> => {
      if (judged.length === 0) return Promise.resolve(null);
      logger.info({ runId, candidateCount: judged.length }, "[v2-pipeline] pedagogy started speculatively (overlapping grounding)");
      return runPedagogyCritic(
        {
          runId,
          candidate: judged[0],
          candidates: judged,
          // 占位：真实 binding plan hash 只有在 grounding 之后才存在；复用路径会替换。
          candidateEvidenceBindingPlanHashes: judged.map((c) => c.candidateRevisionHash),
          existingObjectives: existingObjectives.map((o) => ({ objectiveId: o.objectiveId, objectiveStatement: o.objectiveStatement, publicSummary: o.publicSummary })),
          softPrecheckIssues: { ...softSignalsForPedagogy },
          plan: { planRevisionId: plan.planRevisionId, planVersion: plan.planVersion, planHash: plan.planHash },
          inputHash: run.input_snapshot_hash,
          generationRequest: semanticSpec.semanticRequest,
          signal: pipelineSignal,
        },
        providers ? providers.pedagogy : new DeterministicPedagogyProvider(),
      ).then(
        (report) => ({ report, judgedCandidateIds: judged.map((c) => c.candidateId) }),
        (error) => {
          // 投机失败不改变语义：交给收尾阶段按最终集合正常调用（届时同样的错误会
          // 以原有路径抛出/分类）。这里只记录，避免 unhandled rejection。
          logger.warn({ runId, err: String(error) }, "[v2-pipeline] speculative pedagogy failed; will run after grounding");
          return null;
        },
      );
    };
    /** 提示与候选一起在同一次提交里落库（`commitAuthoredCandidateV2`），不进 revision 哈希（迁移 0234）。 */
    // 0249：计划已冻结、作者还没开工 → 先把分母写出去，界面这一刻起就有"共 N 张"。
    await writeCardGenerationLiveProgress(job, {
      plannedCards: planObjectives.length, authored: 0, gatePassed: 0, gateFailed: 0,
    });
    const candidatePipelines = await mapWithConcurrency(
      planObjectives,
      V2_STAGE_CONCURRENCY,
      async (planObj, index): Promise<CandidateGroundingOutcome> => {
        throwIfPipelineAborted(signal);
        const stored = committedByObjective.get(planObj.objectiveLocalId);
        let candidate: LearningCardCandidateRevisionV2;
        if (stored) {
          // 重放：这一版的这张卡已经在库里了 → **作者一次都不叫**（那是最贵的一段付费）。
          candidate = stored;
          reusedCandidates.push(stored);
          logger.info({
            runId, candidateId: stored.candidateId, planObjectiveLocalId: planObj.objectiveLocalId,
          }, "[v2-pipeline] candidate reused from the committed row (author not called)");
        } else {
          const authoredCandidate = await authorCandidateForObjective(authorInput, planObj);
          const fresh = authoredCandidate.candidate;
          // M2：evidenceSetHash 闭包断言（与改造前一致：不一致即闭包断裂，fail-closed）。
          if (fresh.evidenceSetHash !== sealed.evidenceSetHash) {
            throw new CardGenerationProviderErrorLike(
              false,
              `candidate evidence set hash closure mismatch: candidate=${fresh.evidenceSetHash} sealed=${sealed.evidenceSetHash}`,
            );
          }
          const committed = await commitAuthoredCandidateV2({
            workspaceId, runId, candidate: fresh, hints: authoredCandidate.hints,
          });
          candidate = committed.candidate;
          if (!committed.insertedByUs) {
            // 库里已有同目标的行（租约被抢之后才会走到这里）：身份必须用库里那条，
            // 但这不是复用——作者已经被叫过、钱已经付了，所以**不发** authored_reused。
            logger.warn({
              runId, candidateId: candidate.candidateId,
              planObjectiveLocalId: planObj.objectiveLocalId,
            }, "[v2-pipeline] authored candidate collided with an already committed row; using the stored identity");
          }
        }
        // precheck 在 author 之后、grounding 之前算（纯计算）——这样"最后一个 author
        // 完成"时，全部候选的 soft 信号都已就绪，投机 pedagogy 的输入才与正常路径等价。
        const precheck = buildCandidatePrecheck(candidate, sourceContent, sealed.evidenceManifest);
        if (precheck.softPre.length > 0) {
          softSignalsForPedagogy[candidate.candidateId] = precheck.softPre;
        }
        authoredByIndex[index] = candidate;
        authoredCount += 1;
        // 0249：每写完一张 tick 一格（候选行本身此刻已经单独提交过了）。
        await writeCardGenerationLiveProgress(job, {
          plannedCards: planObjectives.length, authored: authoredCount, gatePassed: 0, gateFailed: 0,
        });
        if (V2_SPECULATIVE_PEDAGOGY && authoredCount === planObjectives.length && !speculativePedagogy) {
          speculativePedagogy = startSpeculativePedagogy(
            authoredByIndex.filter((c): c is LearningCardCandidateRevisionV2 => c !== undefined),
          );
        }
        return callGroundingCritic({
          precheck,
          sealed,
          existingObjectives,
          providers,
          stageSignal: pipelineSignal,
          // 可重试错误：abort 其余在途链（不再为注定回滚的 job 付费），
          // 错误本身按候选顺序在收尾阶段抛出（语义与串行版本一致）。
          onRetryableError: (error) => pipelineAbort.abort(error),
          signal,
        });
      },
    );
    const candidates = candidatePipelines.map((outcome) => outcome.candidate);
    const precomputedPedagogy = speculativePedagogy ? await speculativePedagogy : null;
    const precomputedGrounding = new Map(
      candidatePipelines.map((outcome) => [outcome.candidate.candidateRevisionId, outcome] as const),
    );

    // 2026-08-16（实机验证，溯源日志）：author 阶段结果摘要。
    logger.info({
      runId,
      stage: "author",
      candidateCount: candidates.length,
      candidateIds: candidates.map((c) => c.candidateId),
      usage: providers?.usageTotals(),
    }, "[v2-pipeline] author completed");

  await reviewAndFinalizeV2Candidates({
    job,
    signal,
    workspaceId,
    runId,
    plan,
    sealed,
    sourceContent,
    existingObjectives,
    providers,
    semanticRequest: semanticSpec.semanticRequest,
    candidates,
    precomputedGrounding,
    precomputedPedagogy,
    reusedCandidates,
    inputSnapshotHash: run.input_snapshot_hash,
  });
  }
}

/**
 * 阶段二的后半段：复用审计 + 双 Critic + deck gate + 终态（重新锁 run 的一个事务）。
 *
 * 候选行在这之前**已经逐张提交**（A1·B2），所以这一段只做两件事：把"哪几张是复用的"
 * 记进事件流，以及对已提交的行下门禁结论。
 *
 * 为什么"跳过作者"要留事件：库里"这一遍直接用了已提交的那条"与"这一遍又写了一次
 * 却被五列唯一索引挡下"是完全同形的（行数、身份都看不出差别）。没有这条事件，
 * "重放不再付费"就只能靠读代码相信，出事时也查不到是哪一遍。
 */
async function reviewAndFinalizeV2Candidates(input: {
  job: PendingOutboxJob;
  signal: AbortSignal | undefined;
  workspaceId: string;
  runId: string;
  plan: NonNullable<Awaited<ReturnType<typeof loadV2RunInputs>>["plan"]>;
  sealed: Awaited<ReturnType<typeof loadSealedEvidence>>;
  sourceContent: string;
  existingObjectives: ExistingObjectiveRef[];
  providers: Awaited<ReturnType<typeof buildProvidersForRun>> | null;
  semanticRequest: unknown;
  candidates: LearningCardCandidateRevisionV2[];
  precomputedGrounding: Map<string, CandidateGroundingOutcome>;
  precomputedPedagogy: SpeculativePedagogy | null;
  reusedCandidates: LearningCardCandidateRevisionV2[];
  inputSnapshotHash: string;
}): Promise<void> {
  const { job, workspaceId, runId } = input;
  await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    // 重新按当前版本读回 run / 证据闭包：这段的一切判定都要站在**已提交**的数据上，
    // 而不是作者阶段那份内存快照（§39 B3）。
    const ctx = await loadV2RunInputs(tx, workspaceId, runId);
    if (input.reusedCandidates.length > 0) {
      await insertEventsBatched(tx, workspaceId, runId, input.reusedCandidates.map((candidate) => ({
        eventType: "card_candidate.authored_reused",
        payload: {
          candidateId: candidate.candidateId,
          candidateRevisionId: candidate.candidateRevisionId,
        },
      })));
    }

    await tx.execute(sql`
      UPDATE public.card_generation_runs_v2
      SET status = 'checking', error_code = NULL, error_message = NULL, updated_at = now()
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
    `);

    // 12-16. Per-candidate critics + assembler + deterministic gates + deck gate + 终态
    await critiqueAndFinalizeCandidates(tx, {
      runId,
      workspaceId,
      run: ctx.run as unknown as { input_snapshot_hash: string; semantic_spec_hash: string },
      plan: ctx.plan ?? input.plan,
      candidates: input.candidates,
      sealed: ctx.sealed,
      sourceContent: ctx.sourceContent,
      existingObjectives: ctx.existingObjectives,
      providers: input.providers,
      signal: input.signal,
      // 按候选流水线预计算的 grounding 结果：跳过本函数内部的 provider 波，
      // 直接进入串行收尾（写入顺序/事件/判定完全不变）。
      precomputedGrounding: input.precomputedGrounding,
      // 与 grounding 波并发算出的投机 pedagogy（集合未变则直接复用，省一个阶段）。
      precomputedPedagogy: input.precomputedPedagogy,
      // M4：用户 generation 请求（semanticRequest），透传给 Pedagogy Critic。
      generationRequest: input.semanticRequest,
    });
    await fenceV2OutboxLease(tx, job);
    // M5：本次 job 执行的 LLM 用量汇总（成本审计；此前 result.usage 被整体丢弃，
    // 系统无法回答"一个 run 实际花了多少 token"）。
    if (input.providers) {
      logger.info({
        runId,
        usage: input.providers.usageTotals(),
      }, "[v2-pipeline] job LLM usage summary");
    }
  });
}

// ─── Critic + Assembler + Deck Gate（§12-16，可复用于 regenerate/replan）────

/**
 * §10.1 step 8 Global Selector / Merge / Dedup（M6 接线）。
 *
 * 对已通过 grounding 的候选做全集合语义聚类（`computeSemanticClustersV2`：
 * 规范化 statement token 集 Jaccard + 共享证据），每个 duplicate/mergeable 簇
 * 只保留 **authoring 顺序最前** 的一个成员（确定性；authoring 顺序 = 计划顺序），
 * 其余作为冗余候选交给调用方标记落选。
 *
 * 为什么必须在这里做：deck gate 的语义重复检查是 deck 级 hard issue，直接命中
 * 会让整个 run 进 needs_attention——同主题多篇笔记（CJK 单字 token 集下
 * Jaccard ≥0.85 极易触顶）会持续"烧完整条管道再整体失败"。去重是 §10.1 契约里
 * step 8 的职责，deck gate 只应作为 backstop。
 */
export function selectDistinctCandidatesV2(
  candidates: LearningCardCandidateRevisionV2[],
): {
  kept: LearningCardCandidateRevisionV2[];
  dropped: Array<{
    candidate: LearningCardCandidateRevisionV2;
    relation: "duplicate" | "mergeable";
    keptCandidateId: string;
    clusterId: string;
  }>;
} {
  if (candidates.length < 2) return { kept: candidates, dropped: [] };
  const clusters = computeSemanticClustersV2(candidates);
  const droppedByCandidateId = new Map<string, {
    relation: "duplicate" | "mergeable";
    keptCandidateId: string;
    clusterId: string;
  }>();
  for (const cluster of clusters) {
    if (cluster.relation === "distinct" || cluster.candidateIds.length < 2) continue;
    const memberSet = new Set(cluster.candidateIds);
    const orderedMemberIds = candidates
      .filter((c) => memberSet.has(c.candidateId))
      .map((c) => c.candidateId);
    const [keepId, ...redundantIds] = orderedMemberIds;
    if (!keepId) continue;
    for (const id of redundantIds) {
      droppedByCandidateId.set(id, {
        relation: cluster.relation,
        keptCandidateId: keepId,
        clusterId: cluster.clusterId,
      });
    }
  }
  if (droppedByCandidateId.size === 0) return { kept: candidates, dropped: [] };
  const kept = candidates.filter((c) => !droppedByCandidateId.has(c.candidateId));
  const dropped = candidates
    .filter((c) => droppedByCandidateId.has(c.candidateId))
    .map((c) => ({
      candidate: c,
      ...(droppedByCandidateId.get(c.candidateId) as {
        relation: "duplicate" | "mergeable";
        keptCandidateId: string;
        clusterId: string;
      }),
    }));
  return { kept, dropped };
}

/**
 * 单候选 grounding 阶段的产物（provider 调用结果 + precheck 信号，**未落库**）。
 *
 * 2026-09-17（极限延迟改造）：把它显式建模，使"调用 provider"与"写 DB"彻底分离——
 * 前者可以按候选流水线/并发进行，后者必须在事务内按原顺序串行收尾。
 */
export interface CandidateGroundingOutcome {
  candidate: LearningCardCandidateRevisionV2;
  fatalPre: QualityIssue[];
  softPre: QualityIssue[];
  contract: Awaited<ReturnType<typeof runGroundingCritic>> | null;
  error: unknown;
}

/** 投机 pedagogy 的产物：报告 + 它实际评审过的候选序列（守卫用）。 */
export interface SpeculativePedagogy {
  report: PedagogyCriticReportV2;
  /** 评审时的候选顺序（candidateId）；与最终牌堆序列逐位比较，不同则重跑。 */
  judgedCandidateIds: string[];
}

/**
 * 投机 pedagogy 的复用守卫：**逐位相同**（含顺序）才允许复用。
 *
 * 为什么必须严格到顺序：pedagogy 的 perCandidate 判定与 `candidateRevisionHashes` /
 * `candidateEvidenceBindingPlanHashes` 数组**按下标对应**（prompt 明说），集合相同
 * 但顺序不同会把 verdict 挂到错误候选上。任何差异一律重跑，宁可贵一次调用。
 */
export function isSameCandidateSequence(judged: readonly string[], finalIds: readonly string[]): boolean {
  if (judged.length !== finalIds.length) return false;
  return judged.every((id, index) => id === finalIds[index]);
}

/**
 * 把服务端真实 binding plan hashes 写回报告并重算 reportHash。
 *
 * 投机调用发生在 grounding 之前，此时 hash 尚不存在，prompt 里用的是占位值；
 * 复用路径必须替换为真实值——`candidateEvidenceBindingPlanHashes` 是报告的冻结
 * 字段之一，reportHash 必须绑定替换后的内容，否则审计闭包与真实输入不一致。
 */
export function withBindingPlanHashes(
  report: PedagogyCriticReportV2,
  bindingPlanHashes: string[],
): PedagogyCriticReportV2 {
  const { reportHash: _ignored, ...withoutHash } = report;
  const next = { ...withoutHash, candidateEvidenceBindingPlanHashes: bindingPlanHashes };
  return { ...next, reportHash: computePedagogyReportHash(next) };
}

/** 12.1 deterministic precheck（纯计算，无 IO）。 */
export function buildCandidatePrecheck(
  candidate: LearningCardCandidateRevisionV2,
  sourceContent: string,
  evidenceManifest: unknown,
): { candidate: LearningCardCandidateRevisionV2; fatalPre: QualityIssue[]; softPre: QualityIssue[] } {
  const precheckGating = runCandidateDeterministicGatesV2({
    candidate,
    evidenceManifest: evidenceManifest as never,
  });
  const groundingPre = deterministicGroundingPrecheck(candidate, sourceContent);
  const pedagogyPre = deterministicPedagogyPrecheck(candidate, sourceContent);
  const allPre = [...precheckGating, ...groundingPre, ...pedagogyPre];
  return {
    candidate,
    fatalPre: allPre.filter((i) => i.severity === "hard"),
    // 2026-08-25（AI 设计审计修复，§4.5 兑现注释承诺）：soft 信号不再算完
    // 即弃——随 grounding 事件落审计面（排查误杀/漏检可取证），并注入
    // Pedagogy Critic 的 per-candidate 输入作为风险参考。
    softPre: allPre.filter((i) => i.severity === "soft"),
  };
}

/**
 * 12.2 grounding provider 调用（**纯网络，无 tx**）。
 *
 * 抽成独立函数是为了让主管线能在候选 i 的 author 一返回就调用它（按候选流水线），
 * 同时 regenerate/recheck/replan 路径继续用并发波调用——两条路径共用同一份错误
 * 分类语义：可重试错误交给 `onRetryableError`（调用方 abort 其余在途调用）后原样
 * 返回，非重试错误也原样返回，由串行收尾阶段统一裁决。
 */
export async function callGroundingCritic(args: {
  precheck: { candidate: LearningCardCandidateRevisionV2; fatalPre: QualityIssue[]; softPre: QualityIssue[] };
  sealed: Awaited<ReturnType<typeof loadSealedEvidence>>;
  existingObjectives: ExistingObjectiveRef[];
  providers: Awaited<ReturnType<typeof buildProvidersForRun>> | null;
  stageSignal: AbortSignal;
  onRetryableError: (error: unknown) => void;
  signal?: AbortSignal;
}): Promise<CandidateGroundingOutcome> {
  const { precheck, sealed, existingObjectives, providers, stageSignal } = args;
  const { candidate, fatalPre, softPre } = precheck;
  // H5/M1：每个候选（= 一组新的 grounding/critic 付费调用）开始前的取消检查。
  throwIfPipelineAborted(args.signal);
  // 有 fatal precheck 的候选不发起调用（确定性失败，无需付费）。
  if (fatalPre.length > 0) {
    return { candidate, fatalPre, softPre, contract: null, error: null };
  }
  try {
    const contract = providers
      ? await runGroundingCritic(
          { candidate, evidenceManifest: sealed.evidenceManifest as never, existingObjectives, signal: stageSignal },
          providers.grounding,
        )
      : await runDeterministicGroundingContract(candidate, sealed.evidenceManifest);
    return { candidate, fatalPre, softPre, contract, error: null };
  } catch (error) {
    if (isRetryableProviderError(error)) {
      // 立即止损：其余在途/排队调用看到 abort 后不再发起新请求。
      args.onRetryableError(error);
    }
    return { candidate, fatalPre, softPre, contract: null, error };
  }
}

/**
 * 对候选集执行：确定性 precheck → 独立 Grounding + binding plan → 独立 Pedagogy
 * → bounded repair（LLM 模式）→ deck gate → run 终态（review_ready / needs_attention）。
 * 供主管线、regenerate_candidate（单候选）与 replan_set（全量新计划）复用。
 *
 * 导出只为一种验证：拿一对**脚本 provider** 把 pedagogy 的三种裁决（keep /
 * rewrite / drop）各来一次，从而确定性地走到"有界修复 + 丢卡"这条尾段。
 * 过去这条分支只能靠运气（确定性 pedagogy 恒 pass），运行时行为未因此改变。
 */
export async function critiqueAndFinalizeCandidates(
  tx: WorkerTransaction,
  input: {
    runId: string;
    workspaceId: string;
    run: { input_snapshot_hash: string; semantic_spec_hash: string };
    plan: Awaited<ReturnType<typeof executePlanner>>["plan"];
    candidates: LearningCardCandidateRevisionV2[];
    sealed: Awaited<ReturnType<typeof loadSealedEvidence>>;
    sourceContent: string;
    existingObjectives: ExistingObjectiveRef[];
    providers: Awaited<ReturnType<typeof buildProvidersForRun>> | null;
    /** Recheck must never create an unbounded chain of authored revisions. */
    allowBoundedRepair?: boolean;
    /** H5/M1：job 级取消信号（租约丢失 / 墙钟预算耗尽）。 */
    signal?: AbortSignal;
    /** M4：用户 generation 请求（semanticRequest），透传给 Pedagogy Critic。 */
    generationRequest?: unknown;
    /**
     * 2026-09-17（极限延迟改造）：调用方**按候选流水线**预计算的 grounding 结果
     * （candidateRevisionId → outcome）。提供时本函数跳过 provider 调用阶段，
     * 直接进入串行收尾——主管线用它在候选 i 的 author 完成后立即发起候选 i 的
     * grounding，从而把 `max(author)+max(grounding)` 压成 `max(author+grounding)`。
     * 未提供时行为与改造前一致（函数内部并发调用）。
     */
    precomputedGrounding?: Map<string, CandidateGroundingOutcome>;
    /**
     * 2026-09-17（极限延迟改造）：主管线在最后一个候选 author 完成时就发起的
     * **投机 pedagogy**（与 grounding 波并发）。仅在"被评审序列 === 最终牌堆序列"
     * 时复用；否则按最终集合重跑（见本函数 §13 的守卫）。
     */
    precomputedPedagogy?: SpeculativePedagogy | null;
  },
): Promise<void> {
  const {
    runId,
    workspaceId,
    run,
    plan,
    candidates,
    sealed,
    sourceContent,
    existingObjectives,
    providers,
    allowBoundedRepair = true,
    signal,
    generationRequest,
  } = input;

    // 12. Per-candidate critics + assembler + deterministic gates
    const qualityReports: QualityReportV2[] = [];
    const groundingContractReports: Record<string, Awaited<ReturnType<typeof runGroundingCritic>>> = {};
    const bindingPlanHashesByRevision: Record<string, string> = {};
    // 2026-08-25（AI 设计审计修复）：per-candidate soft precheck 信号（供
    // Pedagogy Critic 输入参考与审计）。
    const softSignalsByCandidate: Record<string, QualityIssue[]> = {};
    const passedCandidates: LearningCardCandidateRevisionV2[] = [];
    // 批量写：候选状态更新与 grounding 事件在循环内累积，循环后一次性 flush
    const candidateStatusUpdates: Array<{
      candidateRevisionId: string;
      newQualityState: string;
      bindingPlanHash: string | null;
    }> = [];
    const groundingEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];

    // 12.1 deterministic precheck（纯计算）：保持逐候选顺序计算，结果按下标留存。
    const prechecks = candidates.map((candidate) => {
      const precheck = buildCandidatePrecheck(candidate, sourceContent, sealed.evidenceManifest);
      if (precheck.softPre.length > 0) {
        softSignalsByCandidate[candidate.candidateId] = precheck.softPre;
      }
      return precheck;
    });

    // 12.2 独立 Grounding
    //
    // 2026-09-17（极限延迟改造）：provider 调用既可在此并发（本函数的默认路径，
    // regenerate/recheck/replan 走这里），也可由调用方**按候选流水线**预计算后
    // 传入（`precomputedGrounding`：主管线让候选 i 的 grounding 紧跟候选 i 的
    // author，墙钟从 `max(author)+max(grounding)` 降到 `max(author+grounding)`）。
    // 无论哪条路径，**所有 tx 写入、事件、顺序判定都在下面的串行收尾阶段**，
    // 事务内语句顺序、事件顺序、binding plan 落库顺序与改造前逐字一致。
    //
    // 错误语义不变：
    // - 可重试错误 → abort 本阶段其余在途/排队调用（不再为注定回滚的 job 付费），
    //   并在收尾阶段按**候选顺序**抛出第一个，行为与串行版本一致；
    // - 非重试错误 → 该候选合成 grounding_failed 质量报告（确定性质量裁决）。
    const stageAbort = new AbortController();
    const stageSignal = signal ? AbortSignal.any([signal, stageAbort.signal]) : stageAbort.signal;
    const groundingOutcomes = input.precomputedGrounding
      ? prechecks.map((precheck) => {
          const precomputed = input.precomputedGrounding?.get(precheck.candidate.candidateRevisionId);
          if (!precomputed) {
            // 预计算结果必须覆盖每个候选：缺失意味着调用方与候选集不一致（编程错误），
            // fail-closed 抛错而不是静默跳过 grounding。
            throw new CardGenerationProviderErrorLike(
              false,
              `precomputed grounding outcome missing for candidate ${precheck.candidate.candidateRevisionId}`,
            );
          }
          return precomputed;
        })
      : await mapWithConcurrency(
          prechecks,
          V2_STAGE_CONCURRENCY,
          (precheck) => callGroundingCritic({
            precheck,
            sealed,
            existingObjectives,
            providers,
            stageSignal,
            onRetryableError: (error) => stageAbort.abort(error),
            signal,
          }),
        );

    // 12.3 串行收尾：DB 写入 / 事件 / 顺序判定（与改造前逐字一致）。
    for (const outcome of groundingOutcomes) {
      const { candidate, fatalPre, contract } = outcome;
      const softPre = softSignalsByCandidate[candidate.candidateId] ?? [];
      let qualityReport: QualityReportV2;
      let bindingPlanHash: string | null = null;

      if (fatalPre.length > 0) {
        qualityReport = {
          reportId: randomUUID(),
          reportType: "grounding",
          candidateRevisionId: candidate.candidateRevisionId,
          candidateRevisionHash: candidate.candidateRevisionHash,
          inputHash: candidate.evidenceSetHash,
          version: 2,
          reportHash: simplifiedReportHash({ reportType: "grounding", candidateRevisionId: candidate.candidateRevisionId, inputHash: candidate.evidenceSetHash, issues: fatalPre, verdict: fatalPre.length ? "failed" : "passed", gateVersion: "deterministic-gate-v1" }),
          issues: fatalPre,
          verdict: fatalPre.length ? "failed" : "passed",
          gateVersion: "deterministic-gate-v1",
        };
      } else {
        try {
          // 并发阶段捕获的错误在此重新抛出，交给下面的分类分支处理
          // （与串行版本"调用抛错 → 同一 catch"完全等价）。
          if (outcome.error) throw outcome.error;
          const groundingContract = contract as Awaited<ReturnType<typeof runGroundingCritic>>;

          if (groundingContract.verdict === "pass") {
            // 2026-08-24（§4.4 第二批）：plan 组装走 shared 纯逻辑层；
            // 持久化（INSERT binding plan 行）由下方 worker 本地 IO 实现——
            // 与 api 的 persistCandidateEvidenceBindingPlanV2 落同一张表、
            // 同样的列闭包（R32：完整 bindings 条目）。
            const binding = assembleCandidateEvidenceBindingPlanV2({
              runId,
              workspaceId,
              candidate,
              groundingReport: groundingContract,
              evidenceManifest: sealed.evidenceManifest,
              eligibilityVector: sealed.eligibility,
            });
            await insertBindingPlanRow(tx, {
              runId,
              workspaceId,
              candidate,
              result: binding,
            });
            bindingPlanHash = binding.bindingPlanHash;
            groundingContractReports[candidate.candidateRevisionId] = groundingContract;
          }
          qualityReport = groundingContractToQualityReport(groundingContract);
        } catch (err) {
          // 对齐 planner/author/pedagogy 语义（round-6 🟠1 修复落定）：
          // - 瞬时/可重试错误（provider 5xx/429/408/超时/网络、DB 瞬态）→ 向上抛，
          //   由 processV2OutboxJob 走 retryable 路径回 pending 限次重试，绝不把一
          //   次抖动固化为候选永久落选（健康候选不应因抖动即 quality_state=failed）。
          // - 确定性/非重试错误（schema/协议违约，如 grounding strict parse 失败、
          //   CardGenerationProviderError(kind=non-retryable)）→ 保持现状：合成
          //   grounding_failed 质量报告并标记候选 failed（代表确定性的质量裁决）。
          if (isRetryableProviderError(err)) {
            logger.warn(
              { candidateId: candidate.candidateId, runId, err: String(err) },
              "grounding retryable failure — rethrowing for job-level retry",
            );
            // ── H1（2026-09-15 管线评审，已缓解）──────────────────────────────
            // 语义未变：可重试错误向上抛，processV2OutboxJob 走 retryable →
            // failV2OutboxJob → 回 pending（attempts < 6）重试；DB 侧因整条包在单个
            // withWorkerWorkspaceTransaction 中，事务回滚使 plan/candidate/status
            // 全部 UNDO（**DB 无半写**）。
            // 代价（LLM 成本副作用不可回滚：重跑会重放已付费的 planner/author）
            // 现在有三重收窄：
            //   1. `CardGenerationProviderRuntime.chatJson` 在调用点内退避重试
            //      （V2_PROVIDER_CALL_RETRIES，默认 2 次）——瞬时抖动不再升级为整
            //      管道重放；
            //   2. 单 job 的 LLM 调用预算（V2_MAX_LLM_CALLS_PER_JOB，默认 96）在
            //      预算处截断重试风暴；
            //   3. outbox 退避（15s→300s，migration 0220）避免密集重领。
            // 2026-09-17（性能改造）：并发阶段已在首个可重试错误时 abort 其余
            // 在途调用，本路径的"继续为注定回滚的 job 付费"进一步收窄。
            // 长期正解仍是"阶段级 checkpoint / 把 LLM 调用移出事务"，未在本轮实施。
            // ─────────────────────────────────────────────────────────────────
            throw err;
          }
          logger.warn({ candidateId: candidate.candidateId, err: String(err) }, "grounding failed for candidate (deterministic)");
          const gIssues: QualityIssue[] = [{ code: "grounding_failed", severity: "hard", detail: String(err instanceof Error ? err.message : err) }];
          qualityReport = {
            reportId: randomUUID(),
            reportType: "grounding",
            candidateRevisionId: candidate.candidateRevisionId,
            candidateRevisionHash: candidate.candidateRevisionHash,
            inputHash: candidate.evidenceSetHash,
            version: 2,
            reportHash: simplifiedReportHash({ reportType: "grounding", candidateRevisionId: candidate.candidateRevisionId, inputHash: candidate.evidenceSetHash, issues: gIssues, verdict: "failed", gateVersion: "v2" }),
            issues: gIssues,
            verdict: "failed",
            gateVersion: "v2",
          };
        }
      }

      qualityReports.push(qualityReport);
      // 2026-08-16（实机验证，溯源日志）：每候选 grounding 结果。
      logger.info({
        runId,
        stage: "grounding",
        candidateId: candidate.candidateId,
        verdict: qualityReport.verdict,
        bindingPlanHash: bindingPlanHash ?? null,
        issues: qualityReport.issues.slice(0, 10).map((i) => ({ code: i.code, detail: String(i.detail).slice(0, 200) })),
      }, "[v2-pipeline] grounding per-candidate result");
      const groundingPassed = qualityReport.verdict === "passed" && bindingPlanHash !== null;
      if (groundingPassed && bindingPlanHash) bindingPlanHashesByRevision[candidate.candidateRevisionId] = bindingPlanHash;

      // 12.3 candidate 状态更新 + events（累积，循环后批量 flush）
      const newQualityState = groundingPassed ? "passed" : "failed";
      candidateStatusUpdates.push({
        candidateRevisionId: candidate.candidateRevisionId,
        newQualityState,
        bindingPlanHash,
      });
      groundingEvents.push(groundingPassed
        ? {
            eventType: "card_candidate.grounding_passed",
            payload: {
              candidateId: candidate.candidateId,
              bindingPlanHash,
              ...(softPre.length > 0 ? { softPrecheckIssues: softPre } : {}),
            },
          }
        : {
            eventType: "card_candidate.grounding_failed",
            payload: { candidateId: candidate.candidateId, issues: qualityReport.issues },
          });

      if (groundingPassed) passedCandidates.push(candidate);
    }

    // 批量 flush candidate 状态更新（单次 VALUES 更新）
    if (candidateStatusUpdates.length > 0) {
      await tx.execute(sql`
        UPDATE public.card_generation_candidates_v2 AS c
        SET quality_state = v.new_quality_state, updated_at = now(),
            evidence_binding_plan_hash = v.binding_plan_hash
        FROM (VALUES
          ${sql.join(candidateStatusUpdates.map((u) => sql`(${u.candidateRevisionId}::uuid, ${u.newQualityState}, ${u.bindingPlanHash})`), sql`, `)}
        ) AS v(candidate_revision_id, new_quality_state, binding_plan_hash)
        WHERE c.candidate_revision_id = v.candidate_revision_id
          AND c.workspace_id = ${workspaceId}
      `);
    }
    // 批量写 grounding 事件（一次 MAX + 一次多行 INSERT）
    if (groundingEvents.length > 0) {
      await insertEventsBatched(tx, workspaceId, runId, groundingEvents);
    }

    // 12.4 Global Selector / Merge / Dedup（§10.1 step 8，M6 接线）
    //
    // 2026-09-15（管线评审 M6）：此前 §10.1 step 8 的"全局选择/合并/去重"从未接线
    // （computeSemanticClustersV2 / mergeDuplicateCandidates 只被 deck gate 消费）——
    // 语义重复的候选一路走到 step 12 的 deck gate，被判 deck 级 hard issue
    // （semantic_duplicate / mergeable_fragmentation），整个 run 进 needs_attention：
    // 20 张卡里只要任意两张 statement token Jaccard ≥0.85（CJK 单字 token 集在
    // 同主题下极易触顶），刚烧完整条管道费用的 run 就整体失败。
    //
    // 现在按契约在 grounding 之后、Pedagogy Critic 之前完成去重选择：
    // 每个 duplicate/mergeable 簇保留一个候选（保持 authoring 顺序 = 计划顺序），
    // 其余标记 quality_state='failed' 并写可解释事件（它们确实未通过 §13.2 的
    // deck 级去重裁决，revision 记录保持不可变、不删除）。deck gate 的语义聚类
    // 检查保留为 backstop——去重后不应再有命中。
    const { kept: dedupedCandidates, dropped: droppedDuplicates } = selectDistinctCandidatesV2(passedCandidates);
    if (droppedDuplicates.length > 0) {
      await tx.execute(sql`
        UPDATE public.card_generation_candidates_v2
        SET quality_state = 'failed', updated_at = now()
        WHERE workspace_id = ${workspaceId}
          AND candidate_revision_id IN (${sql.join(
            droppedDuplicates.map((d) => sql`${d.candidate.candidateRevisionId}::uuid`),
            sql`, `,
          )})
      `);
      await insertEventsBatched(tx, workspaceId, runId, droppedDuplicates.map((d) => ({
        eventType: "card_candidate.dropped_semantic_duplicate",
        payload: {
          candidateId: d.candidate.candidateId,
          candidateRevisionId: d.candidate.candidateRevisionId,
          relation: d.relation,
          keptCandidateId: d.keptCandidateId,
          clusterId: d.clusterId,
        },
      })));
      logger.warn({
        runId,
        droppedCount: droppedDuplicates.length,
        keptCount: dedupedCandidates.length,
        dropped: droppedDuplicates.map((d) => `${d.candidate.candidateId}:${d.relation}->${d.keptCandidateId}`),
      }, "[v2-pipeline] semantic dedup (step 8) dropped redundant candidates");
    }

    // 13. 独立 Pedagogy Critic（set-level，输入含 bindingPlanHashes）
    //     去重后的集合进入 Critic —— set 级判定（重复/可合并）看到的是真实待评审集。
    throwIfPipelineAborted(signal);
    const readyCandidates = dedupedCandidates;
    const readyIds = readyCandidates.map((c) => c.candidateId);
    /**
     * 2026-09-17（极限延迟改造）：pedagogy **投机复用**。
     *
     * pedagogy 是集合级调用，只依赖候选内容；它与 grounding 唯一的关联是
     * `candidateEvidenceBindingPlanHashes`，而该字段只是 prompt 里的不透明标识
     * （判定不读它），且报告里的值由服务端覆盖写入。因此主管线在**最后一个候选
     * author 完成时**就用占位 hash 发起 pedagogy，与仍在跑的 grounding 波并发
     * （关键路径 4 阶段 → 3 阶段）。
     *
     * 正确性由**严格集合相等**守卫：只有"被评审的候选序列"与"最终进入牌堆的候选
     * 序列"逐位相同（含顺序）才复用；任何差异（grounding 淘汰、语义去重落选）都
     * 退回按最终集合重跑一次 pedagogy。重跑是少数路径，代价 +1 次调用，换来常见
     * 路径省下整整一个阶段。
     */
    const speculative = input.precomputedPedagogy ?? null;
    const reuseSpeculative = speculative !== null
      && readyCandidates.length > 0
      && isSameCandidateSequence(speculative.judgedCandidateIds, readyIds);
    const pedagogyReport = readyCandidates.length === 0
      ? null
      : reuseSpeculative && speculative
        ? withBindingPlanHashes(
            speculative.report,
            readyCandidates.map((c) => bindingPlanHashesByRevision[c.candidateRevisionId] ?? ""),
          )
        : await runPedagogyCritic(
            {
              runId,
              candidate: readyCandidates[0],
              candidates: readyCandidates,
              candidateEvidenceBindingPlanHashes: readyCandidates.map((c) => bindingPlanHashesByRevision[c.candidateRevisionId] ?? ""),
              existingObjectives: existingObjectives.map((o) => ({ objectiveId: o.objectiveId, objectiveStatement: o.objectiveStatement, publicSummary: o.publicSummary })),
              softPrecheckIssues: softSignalsByCandidate,
              plan: { planRevisionId: plan.planRevisionId, planVersion: plan.planVersion, planHash: plan.planHash },
              inputHash: run.input_snapshot_hash,
              // M4：用户 generation 请求此前恒为空对象，`goal_mismatch` 无判定输入。
              generationRequest,
              signal,
            },
            providers ? providers.pedagogy : new DeterministicPedagogyProvider(),
          );
    if (speculative) {
      logger.info(
        {
          runId,
          reuseSpeculative,
          judgedCount: speculative.judgedCandidateIds.length,
          readyCount: readyIds.length,
          // 诊断用：守卫失败时对比两个序列（各取前 8 位）。
          judgedIds: speculative.judgedCandidateIds.map((id) => id.slice(0, 8)),
          readyIds: readyIds.map((id) => id.slice(0, 8)),
        },
        reuseSpeculative
          ? "[v2-pipeline] pedagogy reused speculative report (set unchanged; one stage saved)"
          : "[v2-pipeline] pedagogy re-run (candidate set changed after grounding/dedup)",
      );
    }

    // 2026-08-16（实机验证，溯源日志）：pedagogy 集合级结果。
    if (pedagogyReport) {
      logger.info({
        runId,
        stage: "pedagogy",
        verdict: pedagogyReport.verdict,
        perCandidate: pedagogyReport.perCandidate.map((p) => `${p.candidateId}:${p.verdict}`),
        readyCandidateCount: readyCandidates.length,
        usage: providers?.usageTotals(),
      }, "[v2-pipeline] pedagogy completed");
    } else {
      logger.info({ runId, stage: "pedagogy", readyCandidateCount: readyCandidates.length }, "[v2-pipeline] pedagogy skipped (no ready candidates)");
    }

    // 13.1 依据 pedagogy 结论过滤候选
    let afterRepair = readyCandidates;
    let repaired = false;
    /**
     * 本次已投递的 recheck job 数。
     *
     * 2026-09-17（修假失败）：pedagogy 判 `rewrite` 的候选按设计移出牌堆、新 revision
     * 交给 `card_generation_recheck_candidate` 重新过门禁。若主管线在 recheck 完成前
     * 就把 run 终态化为 needs_attention，用户在 UI 上会先看到"需处理"（实测 22s 后
     * 又被 recheck 翻回 review_ready）——这是**用户可见的假失败**。
     * 现在有 pending recheck 时保持 `checking`（生成中），由 recheck 收口。
     */
    let pendingRecheckCount = 0;
    if (pedagogyReport) {
      const pc: Array<{ candidateId: string; verdict: string }> = pedagogyReport.perCandidate;
      const keepSet = new Set(pc.filter((p) => p.verdict === "keep").map((p) => p.candidateId));
      const rewriteSet = new Set(pc.filter((p) => p.verdict === "rewrite").map((p) => p.candidateId));
      // bounded repair：每个失败候选最多 repair 一次
      if (allowBoundedRepair && providers && rewriteSet.size > 0 && !repaired) {
        const repairedRevisions: LearningCardCandidateRevisionV2[] = [];
        for (const c of afterRepair) {
          if (rewriteSet.has(c.candidateId)) {
            const repairedC = await boundedRepairCandidate(tx, {
              runId, workspaceId, plan, candidate: c, sourceContent, sealed,
              authoringProvider: providers.author, semanticSpecHash: run.semantic_spec_hash,
            });
            repairedRevisions.push(repairedC);
            repaired = true;
          }
        }
        if (repairedRevisions.length > 0) {
          // 2026-08-16（实机验证修复）：repair 的新 revision **不进入** deck
          // gate 名单——它没有重新跑 grounding/pedagogy（报告仍绑定旧
          // revision），混入必然触发 candidate_revision_mismatch 导致整个
          // run 无法 review_ready（deepseek-v4-flash 实测：1 个 rewrite 候选
          // repair 后 deck gate failed → run needs_attention）。新 revision
          // 保持 authored 状态，由候选审核页的 recheck 流程重新走质量门禁。
          // keep 候选照常 review_ready。
          afterRepair = afterRepair.filter((c) => !rewriteSet.has(c.candidateId));

          // 生成主流程也必须真正触发这条 recheck 流程。此前这里只写入
          // authored revision，却没有 enqueue recheck job，导致候选审核页
          // 永远展示“重新检查中”，并且启用按钮一直被锁住。
          pendingRecheckCount = repairedRevisions.length;
          for (const repairedCandidate of repairedRevisions) {
            await tx.execute(sql`
              INSERT INTO public.card_generation_run_outbox_v2
                (id, workspace_id, run_id, job_type, payload, status)
              VALUES (
                ${randomUUID()}, ${workspaceId}, ${runId},
                'card_generation_recheck_candidate',
                ${JSON.stringify({
                  runId,
                  workspaceId,
                  candidateId: repairedCandidate.candidateId,
                  candidateRevisionId: repairedCandidate.candidateRevisionId,
                  revision: repairedCandidate.revision,
                  reason: 'bounded_repair',
                })}::jsonb,
                'pending'
              )
            `);
          }
        }
      }
      afterRepair = afterRepair.filter((c) => keepSet.has(c.candidateId) || rewriteSet.has(c.candidateId));

      /**
       * §52：牌堆定论之后，把"过了各自门禁但没进这一批"的候选回写成 `dropped`。
       *
       * 不这么做，这些行会永远停在 `passed`（`quality_state` 只在 grounding 那一次
       * 批量 UPDATE 里被写过），而审核页判"可保留/可激活"看的正是 `passed` ——
       * 真跑 4938cf7f 实测：牌堆 2 张、界面给出 4 张，练习件配额也读出与结算事件
       * 不同的数。去重丢弃的那些在 2116 已被标 `failed`，这里只补 pedagogy 这一路。
       *
       * 两个排除项是必须的：
       * - `rewriteSet` 里的原 revision 不是"被丢弃"，它的新 revision 正在等复核，
       *   标成 dropped 会让审核页对一个还在进行的流程下结论；
       * - 事件在**过滤之前**的 `readyCandidates` 上算，否则被丢掉的那张既没状态
       *   也没事件（这正是今天它的行为）。
       */
      const inDeckIds = new Set(afterRepair.map((c) => c.candidateId));
      const droppedByPedagogy = readyCandidates.filter((c) =>
        !inDeckIds.has(c.candidateId) && !rewriteSet.has(c.candidateId));
      if (droppedByPedagogy.length > 0) {
        await tx.execute(sql`
          UPDATE public.card_generation_candidates_v2
          SET quality_state = 'dropped', updated_at = now()
          WHERE workspace_id = ${workspaceId}
            AND candidate_revision_id IN (${sql.join(
              droppedByPedagogy.map((c) => sql`${c.candidateRevisionId}::uuid`), sql`, `)})
        `);
        await insertEventsBatched(tx, workspaceId, runId, droppedByPedagogy.map((c) => ({
          eventType: "card_candidate.dropped",
          payload: {
            candidateId: c.candidateId,
            candidateRevisionId: c.candidateRevisionId,
            relation: "pedagogy_drop",
          },
        })));
      }
    }

    // 14. deck gate（含 binding plan hashes）
    // R30：grounding/pedagogy 报告数组必须真实填充——空数组会让任何 passed 候选
    // 触发 candidate_revision_mismatch（确定性模式无 passed 候选掩盖了此缺陷；
    // LLM 模式 grounding_passed 后必现，导致永远无法 review_ready）。
    const groundingReportsForGate: QualityReportV2[] = afterRepair.map((c) =>
      qualityReports.find((qr) => qr.reportType === "grounding" && qr.candidateRevisionId === c.candidateRevisionId)
      ?? {
        reportId: randomUUID(),
        reportType: "grounding" as const,
        candidateRevisionId: c.candidateRevisionId,
        candidateRevisionHash: c.candidateRevisionHash,
        inputHash: c.evidenceSetHash,
        version: 2,
        reportHash: simplifiedReportHash({ reportType: "grounding", candidateRevisionId: c.candidateRevisionId, inputHash: c.evidenceSetHash, issues: [], verdict: "failed", gateVersion: "v2" }),
        issues: [],
        verdict: "failed" as const,
        gateVersion: "v2",
      },
    );
    const pedagogyReportsForGate: QualityReportV2[] = afterRepair.map((c) => {
      const pc = pedagogyReport?.perCandidate.find((p) => p.candidateId === c.candidateId);
      const pedagogyPassed = pc?.verdict === "keep"
        || (pc?.verdict === "rewrite" && repaired);
      // 2026-08-25（AI 设计审计修复）：冻结 issue code 落入质量报告（此前
      // 硬编码空数组，语义裁决结果零审计痕迹）。
      const issues: QualityIssue[] = (pc?.hardIssues ?? []).map((code) => ({
        code,
        severity: "hard" as const,
        detail: "pedagogy critic frozen issue code (per-candidate)",
      }));
      return {
        reportId: randomUUID(),
        reportType: "pedagogy" as const,
        candidateRevisionId: c.candidateRevisionId,
        candidateRevisionHash: c.candidateRevisionHash,
        inputHash: run.input_snapshot_hash,
        version: 2,
        reportHash: simplifiedReportHash({ reportType: "pedagogy", candidateRevisionId: c.candidateRevisionId, inputHash: run.input_snapshot_hash, issues, verdict: pedagogyPassed ? "passed" : "failed", gateVersion: "v2" }),
        issues,
        verdict: (pedagogyPassed ? "passed" : "failed") as "passed" | "failed",
        gateVersion: "v2",
      };
    });
    const finalGate = runDeterministicFinalGates(
      afterRepair.map((c) => ({ ...c, evidenceSetHash: sealed.evidenceSetHash })),
      groundingReportsForGate,
      pedagogyReportsForGate,
      { planRevisionId: plan.planRevisionId, planVersion: plan.planVersion, planHash: plan.planHash, runId },
      plan.result.kind === "author_candidates" ? plan.result.activationHardMax : 0,
    );

    // 15. 持久化质量报告（card_candidate_quality_reports_v2，真实 reportHash，批量）
    const reportsToInsert = qualityReports.filter(
      (qr) => typeof qr.reportHash === "string" && qr.reportHash.length === 64,
    );
    if (reportsToInsert.length > 0) {
      await tx.execute(sql`
        INSERT INTO public.card_candidate_quality_reports_v2
          (id, workspace_id, run_id, candidate_revision_id, report_type, input_hash,
           report, verdict, gate_version, report_hash)
        VALUES ${sql.join(reportsToInsert.map((qr) => sql`(
          ${randomUUID()}, ${workspaceId}, ${runId}, ${qr.candidateRevisionId},
          ${qr.reportType}, ${qr.inputHash}, ${JSON.stringify(qr)}::jsonb,
          ${qr.verdict}, ${qr.gateVersion}, ${qr.reportHash}
        )`), sql`, `)}
      `);
    }

    // 15b. R35/§17.7：per-candidate pedagogy 事件（此前缺失生产者，批量写）。
    // 2026-08-25（AI 设计审计修复）：payload 携带冻结 issue code，语义裁决可审计。
    const pedagogyEvents = afterRepair.map((c) => {
      const pc = pedagogyReport?.perCandidate.find((p) => p.candidateId === c.candidateId);
      const pedagogyPassed = pc?.verdict === "keep"
        || (pc?.verdict === "rewrite" && repaired);
      return {
        eventType: pedagogyPassed
          ? "card_candidate.pedagogy_passed"
          : "card_candidate.pedagogy_failed",
        payload: {
          candidateId: c.candidateId,
          candidateRevisionId: c.candidateRevisionId,
          verdict: pc?.verdict ?? "unknown",
          ...(pc && pc.hardIssues.length > 0 ? { hardIssues: pc.hardIssues } : {}),
        },
      };
    });
    if (pedagogyEvents.length > 0) {
      await insertEventsBatched(tx, workspaceId, runId, pedagogyEvents);
    }

    // 16. 终态判定
    const survivors = afterRepair;
    // D6 的另一半：配额点名之后必须有人回答"到底交没交上"。缺额落成一条事件，
    // 否则"这批一道练习件都没有"与"配额被无声跳过"在数据上同形（v24 之前那个
    // 读不出供给的坑换个位置重演）。只算**形状对上**的：要求 single_choice 却交了
    // ordering，整批的模态铺开并没有发生。
    if (survivors.length > 0) {
      const quota = summarizePracticeQuotaV2(
        budgetedPlanObjectives(plan),
        new Map(survivors.map((candidate) => {
          const item = candidate.objective.practiceItem;
          return [candidate.planObjectiveLocalId, {
            form: item?.kind ?? null,
            // 宽度按形状取：选择题数选项、配对题数配对（判断题/排序题没有下限）。
            optionCount: !item ? 0
              : item.kind === "single_choice" ? item.options.length
              : item.kind === "matching" ? item.pairs.length
              : 0,
          }];
        })),
      );
      if (quota.misses.length > 0) {
        await insertEvent(tx, workspaceId, runId, "card_generation.practice_quota_short", {
          requiredCount: quota.requiredCount,
          metCount: quota.metCount,
          misses: quota.misses,
        });
      }
    }
    // R35/§12.5：pedagogy set-level `no_cards` 结论 → 成功终态
    // no_cards_recommended（不落 needs_attention；0 卡是可解释的成功结果）。
    const pedagogyNoCards = pedagogyReport?.verdict === "no_cards";
    if (pedagogyNoCards) {
      await insertEvent(tx, workspaceId, runId, "card_generation.no_cards_recommended", {
        reason: "pedagogy_no_cards",
      });
      await tx.execute(sql`
        UPDATE public.card_generation_runs_v2
        SET status = 'no_cards_recommended', error_code = NULL, error_message = NULL, updated_at = now()
        WHERE id = ${runId} AND workspace_id = ${workspaceId}
      `);
      return;
    }
    if (survivors.length === 0 || !finalGate.passed) {
      // 全部失败或 deck-level hard gate 不通过：若无候选通过且 pedagogy 未给
      // no_cards 结论 → needs_attention（§12.5/§13.2）。
      await insertEvent(tx, workspaceId, runId, "card_generation.deck_gate_report", {
        passed: finalGate.passed,
        issues: finalGate.gateReport.issues,
      });
      if (survivors.length === 0 && pendingRecheckCount > 0) {
        // 候选全部被判 rewrite、新 revision 正在复核：保持"生成中"，由 recheck 收口
        // （避免用户看到 needs_attention 的假失败）。
        await tx.execute(sql`
          UPDATE public.card_generation_runs_v2
          SET status = 'checking', error_code = NULL, error_message = NULL, updated_at = now()
          WHERE id = ${runId} AND workspace_id = ${workspaceId}
        `);
        await insertEvent(tx, workspaceId, runId, "card_generation.awaiting_recheck", {
          pendingRecheckCount,
        });
        return;
      }
      // 2026-09-18：把失败原因**落库到 run 行**（此前只写进事件流，run.error_code
      // 为 null）。恢复投影需要据此判断"这次失败是否可就地重试"——用户端不是事件流
      // 消费者，它只读 run 行；没有这个码，唯一候选被 critic 否决的 run 会被当成
      // "服务端需要进一步处理"的黑盒，用户只能重开一次全新生成。
      await tx.execute(sql`
        UPDATE public.card_generation_runs_v2
        SET status = 'needs_attention', error_code = 'quality_gate_failed', updated_at = now()
        WHERE id = ${runId} AND workspace_id = ${workspaceId}
      `);
      await insertEvent(tx, workspaceId, runId, "card_generation.needs_attention", {
        reason: survivors.length === 0
          ? "all_candidates_failed_quality_gates"
          : "deck_gate_failed",
      });
      return;
    }

    // review_ready
    await tx.execute(sql`
      UPDATE public.card_generation_runs_v2
      SET status = 'review_ready', error_code = NULL, error_message = NULL, updated_at = now()
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
    `);
    await insertEventsBatched(tx, workspaceId, runId, survivors.map((candidate) => ({
      eventType: "card_candidate.review_ready",
      payload: {
        candidateId: candidate.candidateId,
        candidateRevisionId: candidate.candidateRevisionId,
        candidateEvidenceBindingPlanHash: bindingPlanHashesByRevision[candidate.candidateRevisionId] ?? null,
      },
    })));
}

// ─── 公共加载器（regenerate/replan 复用）──────────────────────────────────

export async function loadV2RunInputs(tx: WorkerTransaction, workspaceId: string, runId: string) {
  // FOR UPDATE 行锁：loadV2RunInputs 仅在 withWorkerWorkspaceTransaction（真实事务）
  // 内被 regenerate/replan/recheck 调用，事务内持锁可串行化同 run 的并发 job，
  // 防止 read-then-modify 的 TOCTOU 竞态（W2）。
  const runRows = (await tx.execute(sql`
    SELECT id, workspace_id, note_id, note_version_id, status, card_content_epoch,
           semantic_spec, input_snapshot, semantic_spec_hash, input_snapshot_hash,
           current_plan_version
    FROM public.card_generation_runs_v2
    WHERE id = ${runId} AND workspace_id = ${workspaceId}
    FOR UPDATE
    LIMIT 1
  `)) as Array<Record<string, unknown>>;
  // 确定性数据违约（run 不存在）：非重试（§24 fail-closed，与 plan/schema 同口径）
  if (runRows.length === 0) throw new CardGenerationProviderErrorLike(false, `V2 run not found: ${runId}`);
  const run = runRows[0];
  const inputSnapshot = run.input_snapshot as unknown as GenerationInputSnapshotV2;
  const semanticSpec = run.semantic_spec as unknown as GenerationSemanticSpecV2;
  // 存储时 input_snapshot_hash/semantic_spec_hash 是对"无自引用字段"的对象计算的
  // （§9.2），读回后先补齐，再按 §24 做 zod 严格校验（非法 schema fail-closed，
  // 违反契约直接以非重试错误失败 job，绝不带病生成）。
  inputSnapshot.inputSnapshotHash = run.input_snapshot_hash as string;
  semanticSpec.semanticSpecHash = run.semantic_spec_hash as string;
  const specParse = generationSemanticSpecV2Schema.safeParse(semanticSpec);
  if (!specParse.success) {
    const paths = specParse.error.issues.map((i) => i.path.join(".")).join(",");
    // schema 违反是永久错误：非重试，job 直接 failed（§24 fail-closed）
    throw new CardGenerationProviderErrorLike(false, `V2 semantic spec schema violation: ${paths}`);
  }
  const snapshotParse = generationInputSnapshotV2Schema.safeParse(inputSnapshot);
  if (!snapshotParse.success) {
    const paths = snapshotParse.error.issues.map((i) => i.path.join(".")).join(",");
    throw new CardGenerationProviderErrorLike(false, `V2 input snapshot schema violation: ${paths}`);
  }
  const sourceSnapshotId = inputSnapshot.sourceSnapshot.sourceSnapshotId;

  const sealed = await loadSealedEvidence(tx, workspaceId, sourceSnapshotId);

  const blockRows = (await tx.execute(sql`
    SELECT id, type, content, ordinal
    FROM public.note_blocks
    WHERE version_id = ${run.note_version_id}
    ORDER BY ordinal ASC
  `)) as Array<{ id: string; type: string; content: string; ordinal: number }>;
  const scopedBlocks = filterBlocksBySourceScope(
    blockRows.map((b) => ({ blockId: b.id, type: b.type, content: b.content, ordinal: b.ordinal })),
    inputSnapshot.rawRequest.sourceScope,
  ).map((s) => ({ blockId: s.block.blockId, type: s.block.type, content: s.slice, ordinal: s.block.ordinal }));
  // §14.2（R36）：被 seal 剔除的非文本模态 block——region evidence 未实现时
  // 无法可靠制卡，replan/regenerate 同样必须显式提示。
  const unsupportedSourceBlocks = blockRows
    .filter((b) => ["image", "code", "diagram", "formula", "table"].includes(String(b.type ?? "").toLowerCase()))
    .map((b) => ({ blockId: b.id, type: b.type, content: b.content, ordinal: b.ordinal }));
  // 同 processCardGenerationPlan（M7）：源文本规模硬上限（超限截断 + 告警），
  // regenerate/replan/recheck 管道共用同一护栏，避免大笔记在重跑路径上再次膨胀。
  const sourceContent = capSourceContentForPrompts(
    scopedBlocks.map((b) => b.content).join("\n"),
    workspaceId,
  ).content;

  const existingObjRows = (await tx.execute(sql`
    SELECT lor.objective_id, lor.semantic_target_fingerprint,
           lor.objective_statement, lor.public_summary
    FROM public.learning_objective_revisions_v2 lor
    JOIN public.learning_objectives_v2 lo ON lo.objective_id = lor.objective_id
      AND lo.workspace_id = lor.workspace_id
    WHERE lo.workspace_id = ${workspaceId}
      AND lo.lifecycle = 'active'
      AND lor.revision = lo.current_revision
  `)) as Array<{
    objective_id: string; semantic_target_fingerprint: string;
    objective_statement: string; public_summary: string;
  }>;
  const existingObjectives: ExistingObjectiveRef[] = existingObjRows.map((r) => ({
    objectiveId: r.objective_id,
    semanticTargetFingerprint: r.semantic_target_fingerprint,
    objectiveStatement: r.objective_statement,
    publicSummary: r.public_summary,
  }));

  const planRows = (await tx.execute(sql`
    SELECT plan_revision_id, plan_version, previous_plan_revision_id, plan_hash,
           result, atom_decisions
    FROM public.card_generation_plans_v2
    WHERE run_id = ${runId} AND workspace_id = ${workspaceId}
      AND plan_version = ${run.current_plan_version}
    LIMIT 1
  `)) as Array<Record<string, unknown>>;
  const plan: Awaited<ReturnType<typeof executePlanner>>["plan"] | null = planRows.length === 0
    ? null
    : {
        version: 2,
        planRevisionId: planRows[0].plan_revision_id as string,
        runId,
        inputSnapshotHash: inputSnapshot.inputSnapshotHash,
        cardContentEpoch: Number(run.card_content_epoch),
        planVersion: Number(planRows[0].plan_version),
        previousPlanRevisionId: (planRows[0].previous_plan_revision_id as string | null) ?? null,
        result: planRows[0].result as never,
        atomDecisions: planRows[0].atom_decisions as never,
        planHash: planRows[0].plan_hash as string,
      };

  return { run, inputSnapshot, semanticSpec, sealed, scopedBlocks, unsupportedSourceBlocks, sourceContent, existingObjectives, plan };
}

/**
 * §17.4 regenerate_candidate：worker 重写该候选 → 新 immutable revision →
 * 重跑双 Critic + deck gate（复用 critiqueAndFinalizeCandidates）。
 * 旧 revision 只 supersede、不覆盖；重写失败 → run needs_attention（fail closed）。
 */
async function processRegenerateCandidateJob(job: PendingOutboxJob, signal?: AbortSignal): Promise<void> {
  const { workspaceId, runId } = job;
  const useLLM = process.env.CARD_GENERATION_V2_LLM === "true";
  assertDeterministicProvidersAllowed(useLLM);
  const payload = job.payload as { candidateRevisionId?: string; feedbackReasonCodes?: string[] };

  // 治理（同意 + 数据外发政策 + provider 选择）必须在事务外解析，理由见
  // resolveCardGenerationGovernance 的注释。确定性路径不出网，因而不需要它。
  const governanceContext = useLLM
    ? await resolveCardGenerationGovernance(workspaceId, runId)
    : null;

  await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    throwIfPipelineAborted(signal);
    const ctx = await loadV2RunInputs(tx, workspaceId, runId);
    const run = ctx.run;
    if (!["review_ready", "needs_attention"].includes(run.status as string)) {
      // jobType 状态门闩不合法：确定性业务违约，非重试
      throw new CardGenerationProviderErrorLike(false, `regenerate requires review_ready/needs_attention run (got ${String(run.status)})`);
    }
    const candidateRevisionId = payload.candidateRevisionId;
    if (!candidateRevisionId) throw new CardGenerationProviderErrorLike(false, "regenerate job missing candidateRevisionId");
    if (!ctx.plan) throw new CardGenerationProviderErrorLike(false, "regenerate requires an existing plan");

    const candRows = (await tx.execute(sql`
      SELECT candidate_id, candidate_revision_id, revision,
             plan_revision_id, plan_version, plan_hash, card_content_epoch,
             plan_objective_local_id, recommendation, derived_from,
             objective_draft, presentation_draft, evidence_set_hash,
             candidate_revision_hash, publish_state
      FROM public.card_generation_candidates_v2
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
        AND candidate_revision_id = ${candidateRevisionId}
      LIMIT 1
    `)) as Array<Record<string, unknown>>;
    if (candRows.length === 0) throw new CardGenerationProviderErrorLike(false, `candidate not found: ${candidateRevisionId}`);
    const row = candRows[0];
    if (row.publish_state !== "unpublished") {
      throw new CardGenerationProviderErrorLike(false, `candidate ${candidateRevisionId} already ${String(row.publish_state)}, cannot regenerate`);
    }

    const candidate = candidateRowToObject(row, runId);

    // 旧 revision 不可变：supersede（不覆盖、不删除）
    await tx.execute(sql`
      UPDATE public.card_generation_candidates_v2
      SET publish_state = 'superseded', updated_at = now()
      WHERE candidate_revision_id = ${candidateRevisionId} AND workspace_id = ${workspaceId}
        AND publish_state = 'unpublished'
    `);
    await insertEvent(tx, workspaceId, runId, "card_candidate.regenerating", {
      candidateId: candidate.candidateId,
      candidateRevisionId,
      feedbackReasonCodes: payload.feedbackReasonCodes ?? [],
    });

    const providers = useLLM
      ? await buildProvidersForRun({ workspaceId, job, semanticSpec: ctx.semanticSpec, governanceContext })
      : null;
    const newRevision = await boundedRepairCandidate(tx, {
      runId,
      workspaceId,
      plan: ctx.plan,
      candidate,
      sourceContent: ctx.sourceContent,
      sealed: ctx.sealed,
      authoringProvider: providers?.author ?? new DeterministicAuthoringProvider(),
      semanticSpecHash: run.semantic_spec_hash as string,
      signal,
    });

    // §17.4：新 revision 完整重跑门禁（grounding + pedagogy + deck gate）
    await critiqueAndFinalizeCandidates(tx, {
      runId,
      workspaceId,
      run: run as unknown as { input_snapshot_hash: string; semantic_spec_hash: string },
      plan: ctx.plan,
      candidates: [newRevision],
      sealed: ctx.sealed,
      sourceContent: ctx.sourceContent,
      existingObjectives: ctx.existingObjectives,
      providers,
      allowBoundedRepair: false,
      signal,
      generationRequest: ctx.semanticSpec.semanticRequest,
    });
    await insertEvent(tx, workspaceId, runId, "card_candidate.regenerated", {
      candidateId: candidate.candidateId,
      previousRevisionId: candidateRevisionId,
      newRevisionId: newRevision.candidateRevisionId,
      revision: newRevision.revision,
    });
    await fenceV2OutboxLease(tx, job);
  });
}

/**
 * §17.4 replan_set：worker 创建新 immutable CardPlan revision（planVersion+1，
 * previous_plan_revision_id=旧）→ 旧计划未激活候选 supersede → 全量重新 author
 * → 重跑双 Critic + deck gate。planHash 按新版本重算（§11.6 同一 canonical 规则）。
 */
async function processReplanSetJob(job: PendingOutboxJob, signal?: AbortSignal): Promise<void> {
  const { workspaceId, runId } = job;
  const useLLM = process.env.CARD_GENERATION_V2_LLM === "true";
  assertDeterministicProvidersAllowed(useLLM);
  const payload = job.payload as { feedbackReasonCodes?: string[] };

  // 治理（同意 + 数据外发政策 + provider 选择）必须在事务外解析，理由见
  // resolveCardGenerationGovernance 的注释。确定性路径不出网，因而不需要它。
  const governanceContext = useLLM
    ? await resolveCardGenerationGovernance(workspaceId, runId)
    : null;

  await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    throwIfPipelineAborted(signal);
    const ctx = await loadV2RunInputs(tx, workspaceId, runId);
    const run = ctx.run;
    // 2026-09-18：接受 `checking`。新增的**run 级就地重试**入口
    // （apps/api `retryGenerationRunV2`）在派发本任务前就把 run 推进到工作态
    // `checking`——目的是让用户点完立刻看到"又动起来了"，而不是继续停在
    // 「需要处理」直到 worker 更新。若不接受该状态，任务会以非重试错误失败，
    // 把一次本该成功的重试变成 generation_failed（实测踩到过）。
    // 语义上 `checking` 本来就属于本任务的前置状态：主管线自己在这一步也是
    // 把 run 置为 `checking` 再走 author/critic（与 recheck 任务同一口径）。
    if (!["review_ready", "needs_attention", "checking"].includes(run.status as string)) {
      // jobType 状态门闩不合法：确定性业务违约，非重试
      throw new CardGenerationProviderErrorLike(false, `replan requires review_ready/needs_attention/checking run (got ${String(run.status)})`);
    }
    const providers = useLLM
      ? await buildProvidersForRun({ workspaceId, job, semanticSpec: ctx.semanticSpec, governanceContext })
      : null;

    // 1. 重跑 planner（同输入；feedback 偏好为 soft，仅 LLM 模式消费）
    throwIfPipelineAborted(signal);
    const plannerResult = await executePlanner({
      runId,
      workspaceId,
      inputSnapshot: ctx.inputSnapshot,
      semanticSpec: ctx.semanticSpec,
      blocks: ctx.scopedBlocks,
      unsupportedSourceBlocks: ctx.unsupportedSourceBlocks,
      existingObjectives: ctx.existingObjectives,
      clientHardMaxCards: ctx.inputSnapshot?.rawRequest?.quantity?.hardMaxCards,
      extractionProvider: providers ? providers.plannerExtraction : undefined,
      evidenceList: ctx.sealed.evidenceManifest.evidence.map((e) => ({
        evidenceSnapshotId: e.evidenceSnapshotId,
        quoteHash: e.quoteHash ?? null,
      })),
      signal,
    });
    const prevPlanRows = (await tx.execute(sql`
      SELECT plan_revision_id FROM public.card_generation_plans_v2
      WHERE run_id = ${runId} AND workspace_id = ${workspaceId}
        AND plan_version = ${run.current_plan_version}
      LIMIT 1
    `)) as Array<{ plan_revision_id: string }>;
    const prevPlanRevisionId = prevPlanRows[0]?.plan_revision_id ?? null;
    const newPlanVersion = Number(run.current_plan_version) + 1;

    // 2. 新版本 plan + 重算 planHash（§11.6 canonical 序列化）
    const { planHash: _dropped, ...planWithoutHash } = plannerResult.plan;
    const finalPlan: Awaited<ReturnType<typeof executePlanner>>["plan"] = {
      ...planWithoutHash,
      planVersion: newPlanVersion,
      previousPlanRevisionId: prevPlanRevisionId,
      planHash: "",
    };
    const plan = { ...finalPlan, planHash: computeCardPlanHashV2(finalPlan) };

    await tx.execute(sql`
      INSERT INTO public.card_generation_plans_v2
        (id, workspace_id, run_id, plan_revision_id, plan_version, previous_plan_revision_id,
         input_snapshot_hash, card_content_epoch, result, atom_decisions, plan_hash)
      VALUES (
        ${randomUUID()}, ${workspaceId}, ${runId}, ${plan.planRevisionId},
        ${plan.planVersion}, ${plan.previousPlanRevisionId},
        ${plan.inputSnapshotHash}, ${plan.cardContentEpoch},
        ${JSON.stringify(plan.result)}::jsonb,
        ${JSON.stringify(plan.atomDecisions)}::jsonb,
        ${plan.planHash}
      )
    `);

    // 3. 旧计划未激活候选 supersede（immutable，不删除）；review_decision 取
    // CHECK 枚举值 'reject'（§11.4 状态机合法迁移）。
    await tx.execute(sql`
      UPDATE public.card_generation_candidates_v2
      SET publish_state = 'superseded', review_decision = 'reject', updated_at = now()
      WHERE run_id = ${runId} AND workspace_id = ${workspaceId}
        AND plan_version = ${run.current_plan_version} AND publish_state = 'unpublished'
    `);

    // 4. run 推进到 authoring + 新 current_plan_version
    await tx.execute(sql`
      UPDATE public.card_generation_runs_v2
      SET current_plan_version = ${newPlanVersion}, status = 'authoring', updated_at = now()
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
    `);

    // 5. 全量重新 author + 持久化候选
    throwIfPipelineAborted(signal);
    const authorResult = await executeAuthor({
      runId,
      workspaceId,
      plan,
      sourceContent: ctx.sourceContent,
      semanticSpecHash: run.semantic_spec_hash as string,
      provider: providers?.author ?? new DeterministicAuthoringProvider(),
      evidenceList: ctx.sealed.evidenceManifest.evidence.map((e) => ({
        evidenceSnapshotId: e.evidenceSnapshotId,
        quoteHash: e.quoteHash ?? null,
      })),
      // M2：同主管线——sealed manifest 的 evidenceSetHash 参与 revision hash 闭包。
      evidenceSetHash: ctx.sealed.evidenceSetHash,
      signal,
      // 2026-09-17（性能改造）：与主管线一致，replan 的 author 也并发。
      providerConcurrency: V2_STAGE_CONCURRENCY,
    });
    const candidates = authorResult.candidates.map((c) => {
      if (c.evidenceSetHash !== ctx.sealed.evidenceSetHash) {
        throw new CardGenerationProviderErrorLike(
          false,
          `candidate evidence set hash closure mismatch: candidate=${c.evidenceSetHash} sealed=${ctx.sealed.evidenceSetHash}`,
        );
      }
      return c;
    });
    // M8（2026-09-15 管线评审）：此前 replan 逐候选 INSERT + 逐候选 insertEvent
    // （每候选 2 次 SQL，且每次事件插入还带一次 MAX 往返——20 卡 ≈ 120 次
    // round-trip），在已经很长的 run 行锁窗口内继续放大延迟。改为与主管线一致的
    // 批量写（一次多行 INSERT + 一次 insertEventsBatched），并由共享 helper
    // 保证两条路径不再漂移。
    await insertAuthoredCandidatesBatched(
      tx, workspaceId, runId, candidates, authorResult.hintsByCandidateRevisionId,
    );

    // 6. checking → 重跑双 Critic + deck gate（§17.4 新计划必须完整过门禁）
    await tx.execute(sql`
      UPDATE public.card_generation_runs_v2
      SET status = 'checking', error_code = NULL, error_message = NULL, updated_at = now()
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
    `);
    await critiqueAndFinalizeCandidates(tx, {
      runId,
      workspaceId,
      run: run as unknown as { input_snapshot_hash: string; semantic_spec_hash: string },
      plan,
      candidates,
      sealed: ctx.sealed,
      sourceContent: ctx.sourceContent,
      existingObjectives: ctx.existingObjectives,
      providers,
      signal,
      generationRequest: ctx.semanticSpec.semanticRequest,
    });
    await insertEvent(tx, workspaceId, runId, "card_generation.replan_completed", {
      planVersion: plan.planVersion,
      previousPlanRevisionId: prevPlanRevisionId,
      feedbackReasonCodes: payload.feedbackReasonCodes ?? [],
    });
    await fenceV2OutboxLease(tx, job);
  });
}

// ─── 候选行 → 对象构建（regenerate/recheck 复用）──────────────────────────

export function candidateRowToObject(
  row: Record<string, unknown>,
  runId: string,
): LearningCardCandidateRevisionV2 {
  return {
    version: 2,
    candidateRevisionId: row.candidate_revision_id as string,
    candidateId: row.candidate_id as string,
    revision: Number(row.revision),
    runId,
    planRevisionId: row.plan_revision_id as string,
    planVersion: Number(row.plan_version),
    planHash: row.plan_hash as string,
    cardContentEpoch: Number(row.card_content_epoch),
    planObjectiveLocalId: row.plan_objective_local_id as string,
    recommendation: row.recommendation as never,
    derivedFromCandidateRevisions: row.derived_from as never,
    objective: row.objective_draft as never,
    presentation: row.presentation_draft as never,
    evidenceSetHash: row.evidence_set_hash as string,
    candidateRevisionHash: row.candidate_revision_hash as string,
  } as unknown as LearningCardCandidateRevisionV2;
}

/**
 * §12.2/§12.3 recheck：edit/merge 产物（qualityState=checking/authored）由 worker
 * 对新 revision 完整重跑 grounding/pedagogy/deck gate；旧 revision 保持不可变。
 * 通过则 review_ready，失败则 needs_attention（fail closed，用户编辑无绕 Gate 权）。
 */
/**
 * 复核的主体：这一轮的门禁判据 ＋ 被点名那一版候选的原文。
 *
 * 抽出来只为一件事——#19 把这条链拆成"读→判→写"三相以后，**读要发生两次**：
 * 相位 1 取材料给模型判，相位 3 在真正提交前重验材料还在原位。两处判据与文案必须逐字
 * 一致，否则第二次重验会红在不该红的地方。
 */
async function loadRecheckSubjectV2(
  tx: WorkerTransaction,
  args: { workspaceId: string; runId: string; candidateRevisionId?: string },
): Promise<{
  ctx: Awaited<ReturnType<typeof loadV2RunInputs>>;
  /** 已经过"必须有计划"那道闸，所以这里显式收成非空（相位 2 在事务外用得到它）。 */
  plan: NonNullable<Awaited<ReturnType<typeof loadV2RunInputs>>["plan"]>;
  candidate: LearningCardCandidateRevisionV2;
}> {
  const { workspaceId, runId, candidateRevisionId } = args;
  const ctx = await loadV2RunInputs(tx, workspaceId, runId);
  const run = ctx.run;
  if (!["review_ready", "needs_attention", "checking"].includes(run.status as string)) {
    // jobType 状态门闩不合法：确定性业务违约，非重试。
    // `checking` = 主管线在"候选被判 rewrite、等待复核"时保持的进行中状态。
    throw new CardGenerationProviderErrorLike(false, `recheck requires review_ready/needs_attention/checking run (got ${String(run.status)})`);
  }
  if (!candidateRevisionId) throw new CardGenerationProviderErrorLike(false, "recheck job missing candidateRevisionId");
  if (!ctx.plan) throw new CardGenerationProviderErrorLike(false, "recheck requires an existing plan");

  const candRows = (await tx.execute(sql`
    SELECT candidate_id, candidate_revision_id, revision,
           plan_revision_id, plan_version, plan_hash, card_content_epoch,
           plan_objective_local_id, recommendation, derived_from,
           objective_draft, presentation_draft, evidence_set_hash,
           candidate_revision_hash, publish_state
    FROM public.card_generation_candidates_v2
    WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
      AND candidate_revision_id = ${candidateRevisionId}
    LIMIT 1
  `)) as Array<Record<string, unknown>>;
  if (candRows.length === 0) throw new CardGenerationProviderErrorLike(false, `candidate not found: ${candidateRevisionId}`);
  const row = candRows[0];
  if (row.publish_state !== "unpublished") {
    throw new CardGenerationProviderErrorLike(false, `candidate ${candidateRevisionId} already ${String(row.publish_state)}, cannot recheck`);
  }
  return { ctx, plan: ctx.plan, candidate: candidateRowToObject(row, runId) };
}

/**
 * 2026-09-25（#19 第一刀）：单候选复核重排成**三相：读 → 判（出网）→ 写**。
 *
 * 原来整条链挤在同一个 `withWorkerWorkspaceTransaction` 里：grounding 与 pedagogy 两次
 * provider 调用都发生在事务内，一次慢响应就把这条 run 的行锁按住，同池上的后台扫表
 * 只能等它。现在模型调用整个搬到事务外，**用的不是新机器**，而是主管线 2026-09-17
 * 已经建好、并且已经被真实流量跑过的两套入参：
 * - `precomputedGrounding`：按 `candidateRevisionId` 逐位供入，漏斗里缺任何一格都
 *   fail-closed 抛错（不会静默跳过判定）；
 * - `precomputedPedagogy`：走原有的**严格序列相等**守卫，守卫不过它自己在事务内重跑，
 *   所以预计算最多省一次调用、绝不会错用一次判定。
 *
 * 事务外那一段读到的材料会过期，相位 3 因此重验：候选仍未启用、run 仍在可复核状态、
 * **计划与证据闭包逐字没变**（哈希变了＝刚才那两次判定读的是旧材料，判不得，改判重试
 * 让 job 从头再走一遍）。outbox 租约由 `processV2OutboxJob` 已有的心跳续着，末尾仍由
 * `fenceV2OutboxLease` 兜底——这一段和改前一样。
 */
async function processRecheckCandidateJob(job: PendingOutboxJob, signal?: AbortSignal): Promise<void> {
  const { workspaceId, runId } = job;
  const useLLM = process.env.CARD_GENERATION_V2_LLM === "true";
  assertDeterministicProvidersAllowed(useLLM);
  const payload = job.payload as { candidateRevisionId?: string; reason?: string };

  // 治理（同意 + 数据外发政策 + provider 选择）必须在事务外解析，理由见
  // resolveCardGenerationGovernance 的注释。确定性路径不出网，因而不需要它。
  const governanceContext = useLLM
    ? await resolveCardGenerationGovernance(workspaceId, runId)
    : null;

  // 相位 1：只读的一小段事务，把判据与候选原文取出来（一个字节都不写）。
  const staged = await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    throwIfPipelineAborted(signal);
    return loadRecheckSubjectV2(tx, {
      workspaceId,
      runId,
      candidateRevisionId: payload.candidateRevisionId,
    });
  });
  const ctx = staged.ctx;
  const plan = staged.plan;
  const run = ctx.run;
  const candidate = staged.candidate;

  // 相位 2：出网。这一段的 provider 调用发生在**没有事务**的地方。
  const providers = useLLM
    ? await buildProvidersForRun({ workspaceId, job, semanticSpec: ctx.semanticSpec, governanceContext })
    : null;
  const precheck = buildCandidatePrecheck(candidate, ctx.sourceContent, ctx.sealed.evidenceManifest);
  const stageAbort = new AbortController();
  const stageSignal = signal ? AbortSignal.any([signal, stageAbort.signal]) : stageAbort.signal;
  const groundingOutcome = await callGroundingCritic({
    precheck,
    sealed: ctx.sealed,
    existingObjectives: ctx.existingObjectives,
    providers,
    stageSignal,
    onRetryableError: (error) => stageAbort.abort(error),
    signal,
  });
  /**
   * pedagogy 只在"这一版显然进得了牌堆"时才预先发起：确定性 fatal、调用出错、
   * grounding 判 fail 三种情况下漏斗会把候选剔掉、根本不需要集合级判定，先问就是
   * 白花钱。真判错了（漏斗仍然要评审）漏斗按原路径在事务内自己跑一次——**贵一次，
   * 不会少一次**。
   */
  const worthPrecomputingPedagogy =
    groundingOutcome.fatalPre.length === 0 && !groundingOutcome.error && groundingOutcome.contract?.verdict === "pass";
  const precomputedPedagogy: SpeculativePedagogy | null = worthPrecomputingPedagogy
    ? await runPedagogyCritic(
        {
          runId,
          candidate,
          candidates: [candidate],
          // 占位：真实 binding plan hash 要等事务内落库才有；复用路径会覆盖并重算哈希。
          candidateEvidenceBindingPlanHashes: [candidate.candidateRevisionHash],
          existingObjectives: ctx.existingObjectives.map((o) => ({
            objectiveId: o.objectiveId, objectiveStatement: o.objectiveStatement, publicSummary: o.publicSummary,
          })),
          softPrecheckIssues: precheck.softPre.length > 0 ? { [candidate.candidateId]: precheck.softPre } : {},
          plan: { planRevisionId: plan.planRevisionId, planVersion: plan.planVersion, planHash: plan.planHash },
          inputHash: (run as unknown as { input_snapshot_hash: string }).input_snapshot_hash,
          generationRequest: ctx.semanticSpec.semanticRequest,
          signal: stageSignal,
        },
        providers ? providers.pedagogy : new DeterministicPedagogyProvider(),
      ).then((report) => ({ report, judgedCandidateIds: [candidate.candidateId] }))
        .catch((error) => {
          // 与主管线同语义：预计算失败不改变判定，交给漏斗按最终集合正常调用一次。
          logger.warn({ runId, err: String(error) }, "[v2-recheck] pre-transaction pedagogy failed; the funnel will run it");
          return null;
        })
    : null;

  // 相位 3：写。这一段里没有任何 provider 调用。
  await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    throwIfPipelineAborted(signal);
    const current = await loadRecheckSubjectV2(tx, {
      workspaceId,
      runId,
      candidateRevisionId: payload.candidateRevisionId,
    });
    if (
      current.candidate.candidateRevisionHash !== candidate.candidateRevisionHash
      || String(current.plan.planHash) !== String(plan.planHash)
      || String(current.plan.planRevisionId) !== String(plan.planRevisionId)
      || current.ctx.sealed.evidenceSetHash !== ctx.sealed.evidenceSetHash
      || String(current.ctx.run.input_snapshot_hash) !== String(run.input_snapshot_hash)
    ) {
      // 判定读的是旧材料 → 这一轮的结论不能落。抛可重试让 job 重走一遍（相位 2 会
      // 照新材料重判），而不是把过期判定写进牌堆。
      throw new CardGenerationProviderErrorLike(
        true,
        "recheck inputs changed while the gates were being judged; this pass is discarded",
      );
    }
    // 完整重跑门禁（§12.2/§12.3：编辑/合并产物无绕 Gate 权）
    await critiqueAndFinalizeCandidates(tx, {
      runId,
      workspaceId,
      run: current.ctx.run as unknown as { input_snapshot_hash: string; semantic_spec_hash: string },
      plan: current.plan,
      candidates: [candidate],
      sealed: current.ctx.sealed,
      sourceContent: current.ctx.sourceContent,
      existingObjectives: current.ctx.existingObjectives,
      providers,
      precomputedGrounding: new Map([[candidate.candidateRevisionId, groundingOutcome]]),
      precomputedPedagogy,
      // The initial generation already consumed the single bounded repair
      // budget. A recheck must only rerun the gates for this immutable
      // authored revision; allowing another repair here creates an unbounded
      // recheck → authored-revision chain when the critic keeps returning
      // `rewrite`.
      allowBoundedRepair: false,
      signal,
      generationRequest: current.ctx.semanticSpec.semanticRequest,
    });
    // 单个候选复核失败不应让同一 run 中其它仍可启用的最新候选
    // 一并进入 needs_attention；用户仍应能保留并启用通过门禁的候选。
    // 只有没有任何最新 passed 候选时，才维持 fail-closed 的 needs_attention。
    const usableLatest = (await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT DISTINCT ON (candidate_id)
          quality_state, review_decision, publish_state
        FROM public.card_generation_candidates_v2
        WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
        ORDER BY candidate_id, revision DESC
      ) latest
      WHERE latest.quality_state = 'passed'
        AND latest.review_decision IN ('undecided', 'keep')
        AND latest.publish_state = 'unpublished'
    `)) as Array<{ count: number | string }>;
    /**
     * 是否还有**其它**待复核 job（本次这个已处于 processing，按 id 排除）。
     * 只有全部 recheck 都结束才允许离开 `checking`——否则两个 rewrite 候选会让
     * 状态在 needs_attention / review_ready 之间来回翻。
     */
    const otherPending = (await tx.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM public.card_generation_run_outbox_v2
      WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
        AND job_type = 'card_generation_recheck_candidate'
        AND status IN ('pending', 'processing')
        AND id <> ${job.id}
    `)) as Array<{ count: number | string }>;
    const stillWaiting = Number(otherPending[0]?.count ?? 0) > 0;
    if (Number(usableLatest[0]?.count ?? 0) > 0) {
      await tx.execute(sql`
        UPDATE public.card_generation_runs_v2
        SET status = 'review_ready', error_code = NULL, error_message = NULL, updated_at = now()
        WHERE id = ${runId} AND workspace_id = ${workspaceId}
          AND status IN ('needs_attention', 'checking')
      `);
    } else if (!stillWaiting) {
      // 没有任何可用的最新候选，且所有复核都已结束 → fail-closed 收口为
      // needs_attention（此前依赖主管线已置 needs_attention；现在主管线在待复核
      // 期间保持 checking，必须在这里显式收口，否则 run 会永久停在 checking）。
      await tx.execute(sql`
        UPDATE public.card_generation_runs_v2
        SET status = 'needs_attention', error_code = 'quality_gate_failed', updated_at = now()
        WHERE id = ${runId} AND workspace_id = ${workspaceId}
          AND status = 'checking'
      `);
      await insertEvent(tx, workspaceId, runId, "card_generation.needs_attention", {
        reason: "all_candidates_failed_quality_gates",
      });
    }
    await insertEvent(tx, workspaceId, runId, "card_candidate.recheck_completed", {
      candidateId: candidate.candidateId,
      candidateRevisionId: candidate.candidateRevisionId,
      revision: candidate.revision,
      reason: payload.reason ?? "edit",
    });
    await fenceV2OutboxLease(tx, job);
  });
}

// ─── Bounded Repair（§12.5）──────────────────────────────────────────────

/**
 * 对失败候选做局部 repair：调 author provider 重写 → 新 immutable revision。
 * 返回新 revision 的 candidate 对象，由调用方决定重跑 gates。
 */
export async function boundedRepairCandidate(
  tx: WorkerTransaction,
  input: {
    runId: string;
    workspaceId: string;
    plan: Awaited<ReturnType<typeof executePlanner>>["plan"];
    candidate: LearningCardCandidateRevisionV2;
    sourceContent: string;
    sealed: Awaited<ReturnType<typeof loadSealedEvidence>>;
    authoringProvider: AuthoringProvider;
    semanticSpecHash: string;
    /** H5/M1：job 级取消信号（租约丢失 / 墙钟预算耗尽）。 */
    signal?: AbortSignal;
  },
): Promise<LearningCardCandidateRevisionV2> {
  throwIfPipelineAborted(input.signal);
  const authorInput = {
    // 真正的计划目标，不是现场拼的替身：author provider 从里面取 strategy 与
    // practiceForm，替身会让提示构建在 `spec.label` 上炸（见 helper 注释）。
    planObjective: plannedObjectiveForCandidateV2(input.plan, input.candidate.planObjectiveLocalId),
    sourceContent: input.sourceContent,
    semanticSpecHash: input.semanticSpecHash,
    planHash: input.plan.planHash,
    evidenceSetHash: input.sealed.evidenceSetHash,
    signal: input.signal,
  };
  const providerOutput = await input.authoringProvider.authorCandidate(authorInput);

  const newRevisionId = randomUUID();
  const newRevision: LearningCardCandidateRevisionV2 = {
    ...input.candidate,
    candidateRevisionId: newRevisionId,
    revision: input.candidate.revision + 1,
    derivedFromCandidateRevisions: [...input.candidate.derivedFromCandidateRevisions, {
      candidateRevisionId: input.candidate.candidateRevisionId,
      candidateId: input.candidate.candidateId,
      revision: input.candidate.revision,
      revisionHash: input.candidate.candidateRevisionHash,
    }],
    // bounded repair 仍然基于同一份 sealed source。部分模型会在重写时
    // 忽略 evidenceRefIds；不能让“改写题面”把原本有效的证据闭包丢掉，
    // 否则后续 recheck 必然被 no_evidence_reference hard gate 拒绝。
    objective: (() => {
      const originalUnits = new Map(
        input.candidate.objective.rubric.units.map((unit) => [unit.rubricUnitId, unit]),
      );
      const rubricWithoutHash = {
        ...providerOutput.objective.rubric,
        units: providerOutput.objective.rubric.units.map((unit, index) => {
          const original = originalUnits.get(unit.rubricUnitId)
            ?? input.candidate.objective.rubric.units[index];
          return {
            ...unit,
            evidenceRefIds: unit.evidenceRefIds.length > 0
              ? unit.evidenceRefIds
              : original?.evidenceRefIds ?? [],
          };
        }),
      };
      const evidenceRefIds = providerOutput.objective.evidenceRefIds.length > 0
        ? providerOutput.objective.evidenceRefIds
        : input.candidate.objective.evidenceRefIds;
      return {
        ...providerOutput.objective,
        evidenceRefIds,
        rubric: {
          ...rubricWithoutHash,
          rubricHash: computeRubricHashV2(rubricWithoutHash),
        },
      };
    })(),
    presentation: providerOutput.presentation,
    evidenceSetHash: input.sealed.evidenceSetHash,
  };
  // 重算 candidateRevisionHash（§11.6：调用共享 hash 函数）
  const { candidateRevisionHash: _drop, ...withoutHash } = newRevision;
  const newHash = computeCandidateRevisionHashV2(withoutHash);
  const final = { ...newRevision, candidateRevisionHash: newHash };

  await tx.execute(sql`
    INSERT INTO public.card_generation_candidates_v2
      (id, workspace_id, run_id, candidate_id, candidate_revision_id, revision,
       plan_revision_id, plan_version, plan_hash, card_content_epoch,
       plan_objective_local_id, recommendation, derived_from,
       objective_draft, presentation_draft, hints, evidence_set_hash,
       candidate_revision_hash, quality_state, review_decision, publish_state)
    VALUES (
      ${randomUUID()}, ${input.workspaceId}, ${input.runId},
      ${final.candidateId}, ${final.candidateRevisionId}, ${final.revision},
      ${final.planRevisionId}, ${final.planVersion}, ${final.planHash},
      ${final.cardContentEpoch}, ${final.planObjectiveLocalId},
      ${JSON.stringify(final.recommendation)}::jsonb,
      ${JSON.stringify(final.derivedFromCandidateRevisions)}::jsonb,
      ${JSON.stringify(final.objective)}::jsonb,
      ${JSON.stringify(final.presentation)}::jsonb,
      ${JSON.stringify(providerOutput.hints)}::jsonb,
      ${final.evidenceSetHash},
      ${final.candidateRevisionHash},
      'authored', 'undecided', 'unpublished'
    )
  `);
  return final;
}

// ─── 确定性辅助 ──────────────────────────────────────────────────────────

/**
 * 确定性 Grounding：sealed 有证据时，逐一校验 answer/rubric 引用均落在
 * sealed evidence 范围内 → pass（保持离线/测试可用）。
 */
async function runDeterministicGroundingContract(
  candidate: LearningCardCandidateRevisionV2,
  evidenceManifest: AssemblerEvidenceManifest,
): Promise<Awaited<ReturnType<typeof runGroundingCritic>>> {
  const reportId = randomUUID();
  const allEntailed = evidenceManifest.evidence.length > 0;
  const candidateSnapIds = [...candidate.objective.evidenceRefIds, ...candidate.objective.rubric.units.flatMap((u) => u.evidenceRefIds)];
  const manifestIds = new Set(evidenceManifest.evidence.map((e) => e.evidenceSnapshotId));
  const anyRefOutside = candidateSnapIds.length > 0 && candidateSnapIds.some((id) => !manifestIds.has(id));
  const verdict = allEntailed && !anyRefOutside ? "pass" : "fail";
  return {
    version: 2,
    reportId,
    candidateRevisionId: candidate.candidateRevisionId,
    candidateRevisionHash: candidate.candidateRevisionHash,
    evidenceSetHash: computeCandidateEvidenceSetHashV2(evidenceManifest.evidence.map((e) => ({ evidenceSnapshotId: e.evidenceSnapshotId, evidenceSnapshotHash: e.evidenceSnapshotHash }))),
    evidenceEligibilityVectorHash: candidate.evidenceSetHash,
    inputHash: candidate.evidenceSetHash,
    verdict,
    answerUnits: [],
    learningSupport: [],
    relationSupport: [],
    rubricSupport: [],
    hardIssues: verdict === "fail" ? ["deterministic grounding failed"] : [],
    criticVersion: "deterministic-grounding-v1",
    reportHash: hashCanonicalV2("card-generation-v2/grounding-critic-report", {
      candidateRevisionId: candidate.candidateRevisionId,
      evidenceSetHash: computeCandidateEvidenceSetHashV2(evidenceManifest.evidence.map((e) => ({ evidenceSnapshotId: e.evidenceSnapshotId, evidenceSnapshotHash: e.evidenceSnapshotHash }))),
      verdict,
      hardIssues: verdict === "fail" ? ["deterministic grounding failed"] : [],
    }),
  };
}

function groundingContractToQualityReport(
  contract: Awaited<ReturnType<typeof runGroundingCritic>>,
): QualityReportV2 {
  return {
    reportId: contract.reportId ?? randomUUID(),
    reportType: "grounding",
    candidateRevisionId: contract.candidateRevisionId,
    candidateRevisionHash: contract.candidateRevisionHash,
    inputHash: contract.inputHash,
    version: 2,
    reportHash: contract.reportHash,
    issues: contract.hardIssues.map((h) => ({ code: "grounding_hard", severity: "hard" as const, detail: h })),
    verdict: contract.verdict === "pass" ? "passed" : contract.verdict === "abstain" ? "failed" : "failed",
    gateVersion: contract.criticVersion,
  };
}

/** 确定性 Pedagogy provider（离线模式）。 */
class DeterministicPedagogyProvider implements PedagogyCriticProvider {
  async evaluate(input: PedagogyCriticInput): Promise<PedagogyCriticReportV2> {
    const keep = input.candidates.map((c) => ({
      candidateId: c.candidateId,
      verdict: "keep" as const,
      hardIssues: [] as PedagogyIssueCodeV2[],
    }));
    const report = {
      version: 2 as const,
      runId: input.runId,
      candidateRevisionHashes: input.candidates.map((c) => c.candidateRevisionHash),
      candidateEvidenceBindingPlanHashes: input.candidateEvidenceBindingPlanHashes,
      planRevisionId: input.plan?.planRevisionId ?? randomUUID(),
      planVersion: input.plan?.planVersion ?? 1,
      planHash: input.plan?.planHash ?? "",
      inputHash: input.inputHash,
      verdict: "pass" as const,
      perCandidate: keep,
      setIssues: [] as PedagogyIssueCodeV2[],
      recommendedFinalCount: keep.length,
      criticVersion: "deterministic-pedagogy-v1",
      reportHash: "",
    };
    const reportHash = computePedagogyReportHash(stripReportHash(report));
    return { ...report, reportHash };
  }
}

function stripReportHash(report: { reportHash: string }) {
  const { reportHash: _, ...rest } = report;
  return rest;
}

/**
 * 持久化 binding plan 行到 `candidate_evidence_binding_plans_v2`
 * （2026-08-24 §4.4 第二批：plan 组装在 shared 纯逻辑层，本函数是 worker
 * 侧 IO——与 apps/api persistCandidateEvidenceBindingPlanV2 落同一张表、
 * 同样的列闭包（R32：完整 bindings 条目），仅以 raw SQL 表达。
 * 注意：表/列名以 packages/shared db-schema 的 drizzle 定义为准
 * （candidate_evidence_binding_plans_v2，无 card_ 前缀）。）
 */
async function insertBindingPlanRow(
  tx: WorkerTransaction,
  args: {
    runId: string;
    workspaceId: string;
    candidate: LearningCardCandidateRevisionV2;
    result: ReturnType<typeof assembleCandidateEvidenceBindingPlanV2>;
  },
): Promise<void> {
  const { runId, workspaceId, candidate, result } = args;
  await tx.execute(sql`
    INSERT INTO public.candidate_evidence_binding_plans_v2
      (id, workspace_id, binding_plan_id, run_id,
       candidate_revision_id, candidate_revision_hash,
       plan_revision_id, plan_version, plan_hash,
       target_unit_bindings, binding_plan_hash, evidence_eligibility_vector_hash)
    VALUES (
      gen_random_uuid(), ${workspaceId}, ${result.bindingPlanId}, ${runId},
      ${candidate.candidateRevisionId}, ${candidate.candidateRevisionHash},
      ${candidate.planRevisionId}, ${candidate.planVersion}, ${candidate.planHash},
      ${JSON.stringify(result.plan.bindings)}::jsonb, ${result.bindingPlanHash},
      ${result.evidenceEligibilityVectorHash}
    )
  `);
}

/** 单条 V2 运行事件写入（一次 MAX + 一次 INSERT；语义同 api helpers.insertEvent）。 */
async function insertEvent(
  tx: WorkerTransaction,
  workspaceId: string,
  runId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await insertEventsBatched(tx, workspaceId, runId, [{ eventType, payload }]);
}

/**
 * 批量写入 V2 领域事件（一次 MAX + 一次多行 INSERT）。
 * event_seq 在同一 (workspace, run) 内唯一且递增；批量写入时按插入顺序
 * 顺序分配 seq，避免逐事件 MAX 查询 + INSERT 的 N+1 round-trip。
 * 仅在事务内调用（调用方已持有 run 行锁/事务上下文）。
 */
async function insertEventsBatched(
  tx: WorkerTransaction,
  workspaceId: string,
  runId: string,
  events: Array<{ eventType: string; payload: Record<string, unknown> }>,
): Promise<void> {
  if (events.length === 0) return;
  const rows = await tx.execute(sql`
    SELECT COALESCE(MAX(event_seq), 0) AS max_seq
    FROM public.card_generation_events_v2
    WHERE workspace_id = ${workspaceId} AND run_id = ${runId}
  `);
  const base = Number(rows[0]?.max_seq ?? 0);
  await tx.execute(sql`
    INSERT INTO public.card_generation_events_v2
      (id, workspace_id, run_id, event_seq, event_type, payload, created_at)
    VALUES ${sql.join(events.map((e, i) => sql`(
      gen_random_uuid(), ${workspaceId}, ${runId}, ${base + i + 1},
      ${e.eventType}, ${JSON.stringify(e.payload)}::jsonb, now()
    )`), sql`, `)}
  `);
}

/**
 * 落库缺省值。作者链路总会给出提示，这里只兜住"确实没有提示"的行（历史数据、
 * 以及不经过作者的未来来源）；读取方见到空 level1 时退回按卡片结构派生的提示。
 */
const EMPTY_HINTS: CardHintPairV2 = { level1: "", level2: "" };

/**
 * 批量持久化刚 author 出来的候选（一次多行 INSERT + 一次批量事件）。
 *
 * M8（2026-09-15 管线评审）：主管线此前已批量化，replan 仍是逐候选 INSERT +
 * 逐候选 insertEvent（每候选 2 次 SQL，事件插入还各带一次 MAX 往返）。两条路径
 * 合并到本 helper，杜绝再次漂移。
 */
/**
 * 候选行的列清单与取值（A1·B2 抽出来共用）。
 *
 * 抽出来的理由不是省事：批量落地的 replan 与逐候选落地的主管线**必须**写同一份列，
 * 否则"哪条路径少写一列"又会变成一次考古（M8 当年合并两条路径就是这个原因）。
 */
const AUTHORED_CANDIDATE_COLUMNS = sql`(
  id, workspace_id, run_id, candidate_id, candidate_revision_id, revision,
  plan_revision_id, plan_version, plan_hash, card_content_epoch,
  plan_objective_local_id, recommendation, derived_from,
  objective_draft, presentation_draft, hints, evidence_set_hash,
  candidate_revision_hash, quality_state, review_decision, publish_state
)`;

function authoredCandidateValues(
  candidate: LearningCardCandidateRevisionV2,
  workspaceId: string,
  runId: string,
  hintsByCandidateRevisionId: Map<string, CardHintPairV2>,
) {
  return sql`(
      ${randomUUID()}, ${workspaceId}, ${runId},
      ${candidate.candidateId}, ${candidate.candidateRevisionId}, ${candidate.revision},
      ${candidate.planRevisionId}, ${candidate.planVersion}, ${candidate.planHash},
      ${candidate.cardContentEpoch}, ${candidate.planObjectiveLocalId},
      ${JSON.stringify(candidate.recommendation)}::jsonb,
      ${JSON.stringify(candidate.derivedFromCandidateRevisions)}::jsonb,
      ${JSON.stringify(candidate.objective)}::jsonb,
      ${JSON.stringify(candidate.presentation)}::jsonb,
      ${JSON.stringify(hintsByCandidateRevisionId.get(candidate.candidateRevisionId) ?? EMPTY_HINTS)}::jsonb,
      ${candidate.evidenceSetHash},
      ${candidate.candidateRevisionHash},
      'authored', 'undecided', 'unpublished'
    )`;
}

export async function insertAuthoredCandidatesBatched(
  tx: WorkerTransaction,
  workspaceId: string,
  runId: string,
  candidates: LearningCardCandidateRevisionV2[],
  hintsByCandidateRevisionId: Map<string, CardHintPairV2>,
  options: { skipExisting?: boolean } = {},
): Promise<string[]> {
  if (candidates.length === 0) return [];
  // A1·B2：`skipExisting` 时同目标的已提交行**跳过而不是报错**，并且只给真的插进去
  // 的那些发事件——主管线逐候选提交与重放复用都靠这个返回值判断"这张是我写的吗"。
  const inserted = options.skipExisting
    ? (await tx.execute(sql`
        INSERT INTO public.card_generation_candidates_v2
          ${AUTHORED_CANDIDATE_COLUMNS}
        VALUES ${sql.join(candidates.map((candidate) => authoredCandidateValues(candidate, workspaceId, runId, hintsByCandidateRevisionId)), sql`, `)}
        ON CONFLICT (workspace_id, run_id, plan_version, plan_objective_local_id, revision)
        DO NOTHING
        RETURNING candidate_revision_id
      `)) as Array<{ candidate_revision_id: string }>
    : (await tx.execute(sql`
        INSERT INTO public.card_generation_candidates_v2
          ${AUTHORED_CANDIDATE_COLUMNS}
        VALUES ${sql.join(candidates.map((candidate) => authoredCandidateValues(candidate, workspaceId, runId, hintsByCandidateRevisionId)), sql`, `)}
        RETURNING candidate_revision_id
      `)) as Array<{ candidate_revision_id: string }>;
  const insertedIds = new Set(inserted.map((row) => String(row.candidate_revision_id)));
  const authored = candidates.filter((candidate) => insertedIds.has(candidate.candidateRevisionId));
  await insertEventsBatched(tx, workspaceId, runId, authored.map((candidate) => ({
    eventType: "card_candidate.authored",
    payload: {
      candidateId: candidate.candidateId,
      candidateRevisionId: candidate.candidateRevisionId,
    },
  })));
  return [...insertedIds];
}

/**
 * 逐候选提交（A1 · B2）：一张候选一个短事务，行与它的 `authored` 事件同生同死。
 *
 * 为什么事件要跟在同一个事务里：分开写就会出现"行在、事件没有"的崩溃窗口，而事件是
 * 审核页与审计回答"这张卡是哪一遍产出的"的凭证。
 *
 * 为什么要重试：`event_seq` 由 `MAX+1` 分配，`(workspace_id, run_id, event_seq)` 是唯一
 * 索引——两张候选各自的短事务并发写同一 run 的事件会撞（23505）。撞了只能**重开整个
 * 短事务**（Postgres 里语句一旦报错，当前事务已进入中止状态，原地重跑不了），
 * 重开之后重新分配 seq。候选行本身不会重复插（冲突目标是 0253 那条五列索引，DO NOTHING）。
 *
 * 返回 true = 这一行是本次写进去的；false = 库里已有同目标行（并发/重放），
 * 调用方必须改用它，不能带着自己新造的身份继续跑。
 */
async function commitAuthoredCandidateV2(input: {
  workspaceId: string;
  runId: string;
  candidate: LearningCardCandidateRevisionV2;
  hints: CardHintPairV2 | undefined;
}): Promise<{ candidate: LearningCardCandidateRevisionV2; insertedByUs: boolean }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await withWorkerWorkspaceTransaction(
        { workspaceId: input.workspaceId, userId: null },
        async (tx) => {
          // 事件序号是 MAX+1 分配的：并发逐张提交会在 (workspace_id, run_id, event_seq)
          // 这条唯一索引上互相撞。先按 run 取一把事务级 advisory 锁，把"取号 + 写入"
          // 串起来——只在逐张提交这条新路径上加，评审段仍是单事务，不与之重叠。
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.runId}))`);
          const ids = await insertAuthoredCandidatesBatched(
            tx, input.workspaceId, input.runId, [input.candidate],
            new Map([[input.candidate.candidateRevisionId, input.hints ?? EMPTY_HINTS]]),
            { skipExisting: true },
          );
          if (ids.length > 0) {
            return { candidate: input.candidate, insertedByUs: true };
          }
          // 同目标已有行：把**库里那条**读回来继续跑。带着自己新造的身份往下走会让
          // 后面的门禁 UPDATE 打在一条不存在的 revision 上（静默 0 行）。
          const rows = (await tx.execute(sql`
            SELECT * FROM public.card_generation_candidates_v2
            WHERE workspace_id = ${input.workspaceId} AND run_id = ${input.runId}
              AND plan_version = ${input.candidate.planVersion}
              AND plan_objective_local_id = ${input.candidate.planObjectiveLocalId}
              AND revision = ${input.candidate.revision}
            LIMIT 1
          `)) as unknown as Array<Record<string, unknown>>;
          if (rows.length === 0) {
            throw new CardGenerationProviderErrorLike(
              false,
              `candidate row vanished between conflict and read: ${input.candidate.planObjectiveLocalId}`,
            );
          }
          return { candidate: candidateRowToObject(rows[0], input.runId), insertedByUs: false };
        },
        { isolated: true },
      );
    } catch (error) {
      if (isUniqueEventSeqCollision(error) && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

/** 只认这一种唯一冲突（事件序号被并发抢走），别的约束违反照常往上抛。 */
function isUniqueEventSeqCollision(error: unknown): boolean {
  // drizzle 会把驱动层报错再包一层（`Failed query: …`），真正的 code 只出现在
  // cause 链上，而且不止一层——所以这里整条链走一遍，而不是只看第一层。
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const part = current as { code?: unknown; cause?: unknown; message?: unknown };
    if (part.code === "23505" || part.code === "40P01") return true;
    if (/cge_v2_ws_run_seq_idx|deadlock detected/.test(String(part.message ?? ""))) return true;
    current = part.cause;
  }
  return false;
}

// ─── Providers 构造（惰性，减小 worker 重边）─────────────────────────────

/**
 * 在开管道事务**之前**解析治理上下文（A，2026-09-21）。
 *
 * 0237 把 AI 同意与数据外发政策从工作区级搬到账号级之后，读 `user_ai_settings`
 * 必须带 `app.user_id`；而这四条 LLM 管道的事务是以 `userId: null` 打开的，
 * 在事务内部再开一个带用户身份的作用域会被作用域守卫直接拒
 * （`nested worker workspace database work cannot change workspace or user context`）。
 * 伴星侧（`companion-thought.ts`、`companion-dialogue.ts`）一直是在事务外解析好
 * 再传进去的，这里对齐同一个写法：一次普通读取 + 一次解析，都在 tx 外完成。
 */
async function resolveCardGenerationGovernance(workspaceId: string, runId: string) {
  const ownerRows = await db.execute(sql`
    SELECT user_id FROM public.card_generation_runs_v2
    WHERE id = ${runId} AND workspace_id = ${workspaceId}
    LIMIT 1
  `) as unknown as Array<{ user_id: string }>;
  const userId = ownerRows[0]?.user_id ?? null;
  if (!userId) {
    throw new Error(`card-generation run ${runId} has no owning user; refusing to call an external provider`);
  }
  const { resolveAIGovernanceContext } = await import("../lib/governance.ts");
  return { userId, governance: await resolveAIGovernanceContext(workspaceId, userId) };
}

async function buildProvidersForRun(input: {
  workspaceId: string;
  job: PendingOutboxJob;
  semanticSpec: GenerationSemanticSpecV2;
  governanceContext: Awaited<ReturnType<typeof resolveCardGenerationGovernance>> | null;
}): Promise<{
  plannerExtraction: AtomExtractionProvider;
  author: AuthoringProvider;
  grounding: GroundingCriticProvider;
  pedagogy: PedagogyCriticProvider;
  /** M5：本次 job 执行的累计 token/调用用量（成本审计 + 熔断输入）。 */
  usageTotals: () => CardGenerationUsageTotals;
}> {
  if (!input.governanceContext) {
    throw new Error("LLM 路径必须在事务外先解析治理上下文（同意与外发政策是账号级的）");
  }
  const { buildCardGenerationProviders } = await import("../card-generation-v2/providers.ts");
  const providers = await buildCardGenerationProviders({
    workspaceId: input.workspaceId,
    userId: input.governanceContext.userId,
    semanticSpec: input.semanticSpec,
    governance: input.governanceContext.governance,
  });
  return providers;
}

// ─── V2 Outbox Poll Loop ─────────────────────────────────────────────────

// 第五轮审计 W#6：reap 节流——每次 poll 都全表扫 reaper 在 V2 空闲（无缓存 job）
// 时是纯浪费查询。仅当距上次 reap >30s 才真正执行，其余 poll 跳过 reap 直接 claim。
const V2_REAP_THROTTLE_MS = 30_000;
let lastV2ReapAt = 0;

/**
 * 主 tick 单次 poll 的 await 预算（round-7 🟡2 修复）。
 *
 * 之前 index.ts `tick()` 对 `pollV2Outbox(1)` 同步 await，最坏被「单个 V2 job 的
 * 整个管道（planner→author→grounding→pedagogy，~8.75min）」阻塞，延迟**下一 tick**
 * 主队列的 claim/分发。修复：主 tick 以本小预算调用 poll，超时后 poll 立即返回
 * （运行中 job 继续后台跑，靠 heartbeat、30min 租约 + lease CAS + reaper 兜底，不丢副作用、
 * 不重复计费），从而使主循环每次 tick 仅最多阻塞该预算时长即恢复。
 */
export const V2_POLL_TICK_BUDGET_MS = 5_000;

export async function pollV2Outbox(limit = 1, awaitBudgetMs = V2_POLL_TIMEOUT_MS): Promise<number> {
  // 孤儿回收：节流地重置超期 processing 行为 pending，保证崩溃恢复且不浪费
  // 空闲时的扫描查询（V2_REAP_THROTTLE_MS）。reap 失败不阻断 claim。
  // 整体用 runWithAbortTimeout 包裹，使 poll 返回有上界（默认 V2_POLL_TIMEOUT_MS；
  // 主 tick 传更小的 V2_POLL_TICK_BUDGET_MS），防止卡死的 V2 LLM HTTP 调用冻结主
  // tick（第四轮审计 #3/#26）。超时后底层任务继续后台运行，靠 heartbeat、30min
  // 租约 + token CAS + reaper 兜底。job 内每个 chatJson 调用本身还有 75s 单调用 abort。
  // ── H4（2026-09-15 管线评审，部分缓解 / 事务结构未变）──────────────────────
  // 上述 abort 只解耦"主 tick 的阻塞"，并不释放资源：abortable 内同一后台连续体
  // 会把已认领 job 的 processV2OutboxJob 继续跑完（poll 的 abort 不复用为 job
  // signal；job 有独立 signal：租约丢失 / 墙钟预算）。因此 5s 预算期间，一个 LLM
  // 模式的慢 job 仍会长时间占用：DB 连接 + withWorkerWorkspaceTransaction 的长事务
  // + run 行 FOR UPDATE 锁。后续 tick 再 claim（limit=1）其它 pending job 若属同一
  // run（如 replan 排在 plan 后）会排队等该 run 行锁；多 run 高并发后台慢 job 叠加
  // 有连接池耗尽风险。
  // 本轮已加的硬边界：job 墙钟预算（V2_PIPELINE_BUDGET_MS，默认 20min < 30min
  // 租约）到期即 abort 并终结 job（不重试）；租约丢失即时 abort（H5）；单 job LLM
  // 调用预算封顶。仍**未**实施的长期正解：把 LLM 调用移出事务 + 状态机 run.status
  // 门闩（消除长事务/行锁本身），见 processCardGenerationPlan 的 H4 说明。
  // ──────────────────────────────────────────────────────────────────────────
  return runWithAbortTimeout(
    async () => {
      const now = Date.now();
      if (now - lastV2ReapAt > V2_REAP_THROTTLE_MS) {
        lastV2ReapAt = now;
        try {
          await reapStaleV2OutboxJobs();
        } catch (error) {
          logger.warn({ error: sanitizeOperationalError(error) }, "V2 outbox reap failed");
        }
      }
      const capacity = V2_OUTBOX_MAX_CONCURRENCY - v2Inflight.size;
      if (capacity <= 0) {
        logger.debug(
          { inflight: v2Inflight.size, maxConcurrency: V2_OUTBOX_MAX_CONCURRENCY },
          "V2 outbox concurrency cap reached",
        );
        return 0;
      }

      const jobs = await claimV2OutboxJobs(Math.min(limit, capacity));
      const running = jobs.map((job) => {
        const promise = processV2OutboxJob(job);
        v2Inflight.set(promise, { jobId: job.id, leaseToken: job.leaseToken });
        promise.then(
          () => v2Inflight.delete(promise),
          (error) => {
            v2Inflight.delete(promise);
            logger.error(
              { jobId: job.id, runId: job.runId, error: sanitizeOperationalError(error) },
              "V2 outbox job rejected unexpectedly",
            );
          },
        );
        return promise;
      });
      // 主 tick 可以因 awaitBudgetMs 超时而提前返回；此处的 promise 仍被
      // v2Inflight 持有，后续 tick 不会越过并发上限继续 claim。
      await Promise.allSettled(running);
      return jobs.length;
    },
    awaitBudgetMs,
    (lateError) => logger.warn(
      { error: sanitizeOperationalError(lateError) },
      "V2 outbox poll hit timeout; background job continues under 30min lease",
    ),
  );
}
