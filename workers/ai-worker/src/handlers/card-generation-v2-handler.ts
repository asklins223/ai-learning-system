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
 * worker 通过 raw SQL 访问 V2 表（V2 schema 在 apps/api 中定义，worker 不直接
 * import V2 drizzle schema）+ 复用 apps/api 的纯逻辑 service 函数。
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";
import { logger } from "../lib/logger.ts";
import { runWithAbortTimeout } from "../lib/handler-timeout.ts";

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
} from "../../../../apps/api/src/modules/card-generation-v2/planner-service.ts";
import {
  executeAuthor,
  DeterministicAuthoringProvider,
  type AuthoringProvider,
} from "../../../../apps/api/src/modules/card-generation-v2/author-service.ts";
import {
  runGroundingCritic,
  runPedagogyCritic,
  runDeterministicFinalGates,
  deterministicGroundingPrecheck,
  deterministicPedagogyPrecheck,
  type GroundingCriticProvider,
  type PedagogyCriticProvider,
  type PedagogyCriticInput,
  type QualityReportV2,
  type QualityIssue,
} from "../../../../apps/api/src/modules/card-generation-v2/critic-service.ts";
import type {
  PedagogyCriticReportV2,
  PedagogyIssueCodeV2,
} from "@ailearn/shared/card-quality-v2-contracts";
import {
  runCandidateDeterministicGatesV2,
} from "../../../../apps/api/src/modules/card-generation-v2/deterministic-gates.ts";
import {
  filterBlocksBySourceScope,
  type SealedEvidenceEntryV2,
} from "../../../../apps/api/src/modules/card-generation-v2/evidence-seal-service.ts";
import {
  persistCandidateEvidenceBindingPlanV2,
  type AssemblerEvidenceManifest,
} from "../../../../apps/api/src/modules/card-generation-v2/binding-plan-assembler.ts";
import {
  computeCandidateEvidenceSetHashV2,
  computeCandidateRevisionHashV2,
  computeCardPlanHashV2,
  computeRubricHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import { computePedagogyReportHash } from "../card-generation-v2/providers.ts";import {
  insertEvent,
} from "../../../../apps/api/src/modules/card-generation-v2/helpers.ts";
import {
  generationSemanticSpecV2Schema,
  generationInputSnapshotV2Schema,
} from "@ailearn/shared/card-generation-v2-contracts";
import type {
  LearningCardCandidateRevisionV2,
  GenerationSemanticSpecV2,
  GenerationInputSnapshotV2,
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
 * 选择（方案 a，第四轮审计 #2/#25）：直接放大到「覆盖整个四阶段 LLM 管道」，
 * 而非保持 120s + 处理中续租。理由：
 * - V2 管道（planner→author→grounding→pedagogy）是分钟级的多轮模型调用，
 *   期间无任何 lease 心跳（worker 不在 tick 间隙对 processing 行做周期续租）。
 *   120s 一次性租约必然在慢速但**正常**的 job 跑完前过期，reaper 会用
 *   `lease_expires_at < now()` 把它误回收 → 并发重跑整管道 + 误计 attempts
 *   （正常慢被计为崩溃/超时，最终 attempts>=3 被误杀）。
 * - lease_expires_at 的真实用途是回收「崩溃/失联 worker 的孤儿 job」，而非
 *   惩罚仍在合法执行的长任务。reaper 依赖「到期即死」前提：只有租约时长足以
 *   覆盖最坏情况管道时长，reaper 才能把「租约过期」等同于「worker 失联」。
 * - 代价：崩溃后孤儿最长需 30min 才能被 reaper 回收（对比主队列的指数退避 + 
 *   started_at 双窗口）。主队列有退避 + handler 超时护栏，V2 两条都没有；
 *   在补上 handler 级超时（#26）之前，放大租约是唯一能同时避免「误杀正常 job」
 *   的简便手段。V2 当前未激活（CARD_GENERATION_V2_LLM != "true" 走确定性快路径），
 *   实时风险低；激活前应再评估「阶段间续租」或「接入 handler 超时」。
 */
export const V2_OUTBOX_LEASE_TIMEOUT_MS = 30 * 60_000;

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
        lease_expires_at = now() + make_interval(secs => ${V2_OUTBOX_LEASE_TIMEOUT_MS / 1000})
    WHERE id IN (
      SELECT id FROM public.card_generation_run_outbox_v2
      WHERE status = 'pending'
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
 */
export async function failV2OutboxJob(
  jobId: string,
  leaseToken: string,
  error: string,
  retryable = true,
  runId?: string | null,
  workspaceId?: string | null,
): Promise<void> {
  if (!retryable) {
    await db.execute(sql`
      UPDATE public.card_generation_run_outbox_v2
      SET status = 'failed', attempts = attempts + 1, last_error = ${error},
          started_at = NULL, lease_token = NULL, lease_expires_at = NULL
      WHERE id = ${jobId} AND status = 'processing' AND lease_token = ${leaseToken}
    `);
    if (runId && workspaceId) {
      await db.execute(sql`
        UPDATE public.card_generation_runs_v2
        SET status = 'needs_attention', error_code = 'generation_failed', error_message = ${error},
            updated_at = now()
        WHERE id = ${runId} AND workspace_id = ${workspaceId}
          AND status NOT IN ('review_ready', 'no_cards_recommended', 'activating', 'activated',
                             'closed_without_activation', 'failed', 'cancelled', 'stale')
      `);
    }
    return;
  }
  await db.execute(sql`
    UPDATE public.card_generation_run_outbox_v2
    SET status = CASE
      WHEN attempts >= 6 THEN 'failed'
      ELSE 'pending'
    END,
    attempts = attempts + 1,
    last_error = ${error},
    started_at = NULL, lease_token = NULL, lease_expires_at = NULL
    WHERE id = ${jobId} AND status = 'processing' AND lease_token = ${leaseToken}
  `);
  if (runId && workspaceId) {
    await db.execute(sql`
      UPDATE public.card_generation_runs_v2
      SET status = CASE
        WHEN attempts + 1 >= 6 THEN 'needs_attention'
        ELSE status
      END,
      error_code = CASE
        WHEN attempts + 1 >= 6 THEN 'generation_failed'
        ELSE error_code
      END,
      error_message = CASE
        WHEN attempts + 1 >= 6 THEN ${error}
        ELSE error_message
      END,
      updated_at = now()
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
        AND status NOT IN ('review_ready', 'no_cards_recommended', 'activating', 'activated',
                           'closed_without_activation', 'failed', 'cancelled', 'stale')
    `);
  }
}

/**
 * Reap stale processing outbox jobs（孤儿回收）。
 * worker 崩溃/网络分区时 leasing job 永卡 processing，此函数把超期未更新的
 * processing 行收回复投。按 `lease_expires_at < now()` 判定过期（单窗口，租约
 * 到期即回收，与 claim 写入的 120s 租约及主队列 started_at 单窗口语义一致，
 * 修复第三轮 W#2 的"双重减去"）。
 *
 * 回收语义对齐主队列 0105 `ailearn_reap_stale_jobs`（修复第三轮 W#1）：每次
 * 回收都 `attempts = attempts + 1`；回收后即达重试上限（attempts >= 3）的行
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
  const rows = await db.execute(sql`
    UPDATE public.card_generation_run_outbox_v2
    SET status = CASE
        WHEN attempts + 1 >= 6 THEN 'failed'
        ELSE 'pending'
      END,
        attempts = attempts + 1,
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
    RETURNING id
  `);
  return rows.length;
}

// ─── V2 Generation Pipeline Handler ──────────────────────────────────────

/** 判别错误是否可重试（provider 5xx/429/408/超时 → retryable；schema/协议 → non-retryable）。 */
function isNonRetryableErrorLike(error: unknown): boolean {
  // 本地可分类错误（CardGenerationProviderErrorLike 携带 `retryable` 布尔）。
  if (error instanceof CardGenerationProviderErrorLike) return !error.retryable;
  // providers.ts（独立模块，避免循环依赖）抛出的 CardGenerationProviderError：
  // 其 `kind` ∈ {"retryable","non-retryable"}；同时兼容旧式 `retryable === false`。
  if (typeof error === "object" && error !== null) {
    const e = error as { name?: string; kind?: string; retryable?: boolean };
    if (e.name === "CardGenerationProviderError") {
      if (e.kind === "non-retryable") return true;
      if (e.retryable === false) return true;
    }
  }
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
 */
export async function processV2OutboxJob(job: PendingOutboxJob): Promise<void> {
  logger.info({ jobId: job.id, runId: job.runId, jobType: job.jobType }, "V2 outbox job processing");

  let retryable = true;
  try {
    switch (job.jobType) {
      case "card_generation_plan":
        await processCardGenerationPlan(job);
        break;
      case "card_generation_regenerate_candidate":
        await processRegenerateCandidateJob(job);
        break;
      case "card_generation_replan_set":
        await processReplanSetJob(job);
        break;
      case "card_generation_recheck_candidate":
        await processRecheckCandidateJob(job);
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
    await completeV2OutboxJob(job.id, job.leaseToken);
  } catch (error) {
    retryable = isRetryableProviderError(error);
    const message = sanitizeOperationalError(error);
    if (process.env.V2_E2E_DEBUG_ERRORS === "1") {
      // eslint-disable-next-line no-console
      console.error("V2_JOB_DEBUG", job.jobType, job.runId, (error as Error)?.stack ?? String(error));
    }
    logger.error({ jobId: job.id, runId: job.runId, error: message, retryable }, "V2 outbox job failed");
    await failV2OutboxJob(job.id, job.leaseToken, message, retryable, job.runId, job.workspaceId);
  }
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
  // R33：payload 兼容两种落库形状——对象（drizzle insert）或 jsonb 字符串
  //（直接 postgres-js + ::jsonb 双编码路径）；统一归一化后校验。
  let rawPayload: unknown = job.payload;
  if (typeof rawPayload === "string") {
    try {
      rawPayload = JSON.parse(rawPayload);
    } catch {
      rawPayload = {};
    }
  }
  const payload = (rawPayload ?? {}) as { runId?: string; workspaceId?: string; receiptId?: string };
  if (!payload.workspaceId || !payload.runId || !payload.receiptId) {
    throw new CardGenerationProviderErrorLike(
      false,
      `card_v2_post_activation payload missing fields: ${JSON.stringify(job.payload)}`,
    );
  }
  await withWorkerWorkspaceTransaction(
    { workspaceId: payload.workspaceId, userId: null },
    async (tx) => {
      // 1. 幂等：台账已存在 → 已完成消费。
      const existing = await tx.execute(sql`
        SELECT id FROM public.card_generation_post_activation_consumptions
        WHERE workspace_id = ${payload.workspaceId} AND receipt_id = ${payload.receiptId}
        LIMIT 1
      `);
      if (existing.length > 0) return;

      // 2. receipt 必须存在。
      const receiptRows = await tx.execute(sql`
        SELECT mappings FROM public.card_activation_receipts_v2
        WHERE workspace_id = ${payload.workspaceId} AND receipt_id = ${payload.receiptId}
        LIMIT 1
      `);
      if (receiptRows.length === 0) {
        throw new CardGenerationProviderErrorLike(
          false,
          `post-activation receipt not found: ${payload.receiptId}`,
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
          `post-activation receipt has no mappings (retryable): ${payload.receiptId}`,
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
        WHERE workspace_id = ${payload.workspaceId} AND card_id = ANY(${cardIdsLiteral}::uuid[])
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
        WHERE workspace_id = ${payload.workspaceId} AND objective_id = ANY(${objectiveIdsLiteral}::uuid[])
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
        VALUES (${payload.workspaceId}, ${payload.runId}, ${payload.receiptId},
                ${cardIdsLiteral}::uuid[], ${objectiveIdsLiteral}::uuid[],
                ${cardIds.length}, ${objectiveIds.length}, 0)
        ON CONFLICT (workspace_id, receipt_id) DO NOTHING
      `);
      logger.info(
        { jobId: job.id, runId: job.runId, receiptId: payload.receiptId, cardCount: cardIds.length, objectiveCount: objectiveIds.length },
        "V2 post-activation projection consumed (idempotent ledger written)",
      );
    },
  );
}

// ─── Sealed Evidence Loader ──────────────────────────────────────────────

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
      const start = Math.max(0, Number(e.startOffset ?? 0));
      const end = Math.min(blockText.length, Number(e.endOffset ?? blockText.length));
      e.content = blockText.slice(start, end);
    }
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
 * 执行完整的 V2 四阶段生成管道。
 */
async function processCardGenerationPlan(job: PendingOutboxJob): Promise<void> {
  const { workspaceId, runId } = job;
  const useLLM = process.env.CARD_GENERATION_V2_LLM === "true";

  await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    // 1. Load run（FOR UPDATE 行锁：防止同 run 的双 job 并发跑完整 LLM 管道，
    //    避免 TOCTOU 双份计费/双写终态。在 withWorkerWorkspaceTransaction 事务内
    //    持锁到提交，契合 W2。）
    //    ── 激活前评估（第三轮 W#3，保持不拆）──────────────────────────────────
    //    本锁覆盖整个四阶段 LLM 管道（planner→author→grounding→pedagogy，分钟级），
    //    期间 DB 行锁 + 连接被长时间占用（long-held transaction 反模式），同 run 的
    //    regenerate/replan/recheck job 需阻塞等待该锁至提交。这是"串行化同 run"的
    //    W2 本意；**不在此拆分事务**——若把 LLM 调用移到事务外，会重新引入 TOCTOU
    //    （双 worker 并发看同一 run.status → 双份计费/双写终态），需重构为状态机
    //    门闩（如 run.status 乐观 CAS，或租约 token）方能豁免。V2 当前未激活
    //    （无生产写入），风险低；激活前必须评估「把 LLM 调用移出事务 + 状态机门闩」。
    //    ──────────────────────────────────────────────────────────────────────
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

    if (run.status !== "planning") {
      logger.info({ runId, status: run.status }, "V2 run not in planning state, skipping");
      return;
    }

    const inputSnapshot = run.input_snapshot as unknown as GenerationInputSnapshotV2;
    const semanticSpec = run.semantic_spec as unknown as GenerationSemanticSpecV2;
    // 存储时 input_snapshot_hash/semantic_spec_hash 是对"无自引用字段"的对象计算的
    // （§9.2），读回后补齐，保证 planner/hashing 拿到完整契约对象。
    inputSnapshot.inputSnapshotHash = run.input_snapshot_hash;
    semanticSpec.semanticSpecHash = run.semantic_spec_hash;
    // §24：非法 schema fail-closed（与 loadV2RunInputs 同一口径）
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
    // ── 激活前评估（第四轮审计 #5）：整份 scoped note 的 source text join 成单
    //    sourceContent 字符串，并随 sealed evidence 一起贯穿四阶段 LLM 输入/内存。
    //    大笔记可达数十万字符。当前 V2 未激活（确定性快路径），单 job 内存可控；
    //    激活前须为源文本设规模上限或分块，避免 LLM 输入 token 超限 / 内存峰值。
    const sourceContent = scopedBlocks.map((b) => b.content).join("\n");

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
    logger.info(
      { runId, route: routeResult.route, reasons: routeResult.reasons },
      "V2 pipeline route classified",
    );

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

    // 4a. 构造 providers（LLM 或确定性）
    const providers = useLLM
      ? await buildProvidersForRun({ workspaceId, job, semanticSpec })
      : null;

    // 5. Execute Planner
    const plannerResult = await executePlanner({
      runId,
      workspaceId,
      inputSnapshot,
      semanticSpec,
      blocks: scopedBlocks,
      unsupportedSourceBlocks,
      existingObjectives,
      clientHardMaxCards: inputSnapshot?.rawRequest?.quantity?.hardMaxCards,
      extractionProvider: useLLM && providers ? providers.plannerExtraction : undefined,
    });

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
        SET status = 'no_cards_recommended', updated_at = now()
        WHERE id = ${runId} AND workspace_id = ${workspaceId}
      `);
      await insertEvent(tx, workspaceId, runId, "card_generation.no_cards_recommended", {
        reasonCodes: plan.result.reasonCodes,
      });
      return;
    }

    // 8. Execute Author（budget = plan.activationHardMax，不得扩大）
    const authoringProvider: AuthoringProvider = useLLM && providers
      ? providers.author
      : new DeterministicAuthoringProvider();
    const authorResult = await executeAuthor({
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
    });

    // 9. Update run status to authoring
    await tx.execute(sql`
      UPDATE public.card_generation_runs_v2
      SET status = 'authoring', updated_at = now()
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
    `);
    // 2026-08-16（实机验证，溯源日志）：author 阶段结果摘要。
    logger.info({
      runId,
      stage: "author",
      candidateCount: authorResult.candidates.length,
      candidateIds: authorResult.candidates.map((c) => c.candidateId),
    }, "[v2-pipeline] author completed");

    // 10. Persist candidates + set evidenceSetHash（基于 sealed manifest）
    const candidates = authorResult.candidates.map((c) => ({
      ...c,
      evidenceSetHash: sealed.evidenceSetHash,
    }));
    if (candidates.length > 0) {
      // 批量 INSERT 全部候选（多行 VALUES），避免每候选一次 round-trip
      await tx.execute(sql`
        INSERT INTO public.card_generation_candidates_v2
          (id, workspace_id, run_id, candidate_id, candidate_revision_id, revision,
           plan_revision_id, plan_version, plan_hash, card_content_epoch,
           plan_objective_local_id, recommendation, derived_from,
           objective_draft, presentation_draft, evidence_set_hash,
           candidate_revision_hash, quality_state, review_decision, publish_state)
        VALUES ${sql.join(candidates.map((candidate) => sql`(
          ${randomUUID()}, ${workspaceId}, ${runId},
          ${candidate.candidateId}, ${candidate.candidateRevisionId}, ${candidate.revision},
          ${candidate.planRevisionId}, ${candidate.planVersion}, ${candidate.planHash},
          ${candidate.cardContentEpoch}, ${candidate.planObjectiveLocalId},
          ${JSON.stringify(candidate.recommendation)}::jsonb,
          ${JSON.stringify(candidate.derivedFromCandidateRevisions)}::jsonb,
          ${JSON.stringify(candidate.objective)}::jsonb,
          ${JSON.stringify(candidate.presentation)}::jsonb,
          ${candidate.evidenceSetHash},
          ${candidate.candidateRevisionHash},
          'authored', 'undecided', 'unpublished'
        )`), sql`, `)}
      `);
      // 批量写入 authored 事件（一次 MAX + 一次多行 INSERT）
      await insertEventsBatched(tx, workspaceId, runId, candidates.map((candidate) => ({
        eventType: "card_candidate.authored",
        payload: {
          candidateId: candidate.candidateId,
          candidateRevisionId: candidate.candidateRevisionId,
        },
      })));
    }

    // 11. Update run status to checking
    await tx.execute(sql`
      UPDATE public.card_generation_runs_v2
      SET status = 'checking', updated_at = now()
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
    `);

    // 12-16. Per-candidate critics + assembler + deterministic gates + deck gate + 终态
    await critiqueAndFinalizeCandidates(tx, {
      runId,
      workspaceId,
      run,
      plan,
      candidates,
      sealed,
      sourceContent,
      existingObjectives,
      providers,
      useLLM,
    });
  });
}

// ─── Critic + Assembler + Deck Gate（§12-16，可复用于 regenerate/replan）────

/**
 * 对候选集执行：确定性 precheck → 独立 Grounding + binding plan → 独立 Pedagogy
 * → bounded repair（LLM 模式）→ deck gate → run 终态（review_ready / needs_attention）。
 * 供主管线、regenerate_candidate（单候选）与 replan_set（全量新计划）复用。
 */
async function critiqueAndFinalizeCandidates(
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
    useLLM: boolean;
    /** Recheck must never create an unbounded chain of authored revisions. */
    allowBoundedRepair?: boolean;
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
    useLLM,
    allowBoundedRepair = true,
  } = input;

    // 12. Per-candidate critics + assembler + deterministic gates
    const qualityReports: QualityReportV2[] = [];
    const groundingContractReports: Record<string, Awaited<ReturnType<typeof runGroundingCritic>>> = {};
    const bindingPlanHashesByRevision: Record<string, string> = {};
    const passedCandidates: LearningCardCandidateRevisionV2[] = [];
    // 批量写：候选状态更新与 grounding 事件在循环内累积，循环后一次性 flush
    const candidateStatusUpdates: Array<{
      candidateRevisionId: string;
      newQualityState: string;
      bindingPlanHash: string | null;
    }> = [];
    const groundingEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];

    for (const candidate of candidates) {
      // 12.1 deterministic precheck（补充信号）
      const precheckGating = runCandidateDeterministicGatesV2({
        candidate,
        evidenceManifest: sealed.evidenceManifest as never,
      });
      const groundingPre = deterministicGroundingPrecheck(candidate, sourceContent);
      const pedagogyPre = deterministicPedagogyPrecheck(candidate, sourceContent);
      const allPre = [...precheckGating, ...groundingPre, ...pedagogyPre];
      const fatalPre = allPre.filter((i) => i.severity === "hard");

      // 12.2 独立 Grounding + Assembler Binding Plan
      let qualityReport: QualityReportV2;
      let bindingPlanHash: string | null = null;

      if (fatalPre.length === 0) {
        try {
          const groundingContract = useLLM && providers
            ? await runGroundingCritic(
                { candidate, evidenceManifest: sealed.evidenceManifest as never, existingObjectives },
                providers.grounding,
              )
            : await runDeterministicGroundingContract(candidate, sealed.evidenceManifest);

          if (groundingContract.verdict === "pass") {
            const binding = await persistCandidateEvidenceBindingPlanV2(tx, {
              runId,
              workspaceId,
              candidate,
              groundingReport: groundingContract,
              evidenceManifest: sealed.evidenceManifest,
              eligibilityVector: sealed.eligibility,
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
            // ── 激活前评估（round-8 🟡3，保持现状）────────────────────────────
            // 可重试返回后：processV2OutboxJob 走 retryable → failV2OutboxJob → 回
            // pending → 整条管道（planner→author→grounding→pedagogy）重跑。DB 侧
            // 因整条包在单个 withWorkerWorkspaceTransaction 中，事务回滚使
            // plan/candidate/status 全部 UNDO，**DB 无半写**（防重复副作用仅覆盖 DB）。
            // 但 LLM **成本**副作用不在其列：planner/author 此前的调用已真实出钱，重跑
            // 时被全部重放 → 每重试一次=重放 once 已付费的前置阶段，token 双花/三花。
            // 激活后 grounding 抖动会线性放大模型费用；建议考虑阶段级 checkpoint /
            // 缓存 planner+author 结果，或 grounding 单阶段重试而非整管道。
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
      } else {
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
            payload: { candidateId: candidate.candidateId, bindingPlanHash },
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

    // 13. 独立 Pedagogy Critic（set-level，输入含 bindingPlanHashes）
    const readyCandidates = passedCandidates;
    const pedagogyReport = readyCandidates.length > 0
      ? await runPedagogyCritic(
          {
            runId,
            candidate: readyCandidates[0],
            candidates: readyCandidates,
            candidateEvidenceBindingPlanHashes: readyCandidates.map((c) => bindingPlanHashesByRevision[c.candidateRevisionId] ?? ""),
            existingObjectives: existingObjectives.map((o) => ({ objectiveId: o.objectiveId, objectiveStatement: o.objectiveStatement, publicSummary: o.publicSummary })),
            plan: { planRevisionId: plan.planRevisionId, planVersion: plan.planVersion, planHash: plan.planHash },
            inputHash: run.input_snapshot_hash,
          },
          useLLM && providers ? providers.pedagogy : new DeterministicPedagogyProvider(),
        )
      : null;

    // 2026-08-16（实机验证，溯源日志）：pedagogy 集合级结果。
    if (pedagogyReport) {
      logger.info({
        runId,
        stage: "pedagogy",
        verdict: pedagogyReport.verdict,
        perCandidate: pedagogyReport.perCandidate.map((p) => `${p.candidateId}:${p.verdict}`),
        readyCandidateCount: readyCandidates.length,
      }, "[v2-pipeline] pedagogy completed");
    } else {
      logger.info({ runId, stage: "pedagogy", readyCandidateCount: readyCandidates.length }, "[v2-pipeline] pedagogy skipped (no ready candidates)");
    }

    // 13.1 依据 pedagogy 结论过滤候选
    let afterRepair = readyCandidates;
    let repaired = false;
    if (pedagogyReport) {
      const pc: Array<{ candidateId: string; verdict: string }> = pedagogyReport.perCandidate;
      const keepSet = new Set(pc.filter((p) => p.verdict === "keep").map((p) => p.candidateId));
      const rewriteSet = new Set(pc.filter((p) => p.verdict === "rewrite").map((p) => p.candidateId));
      // bounded repair：每个失败候选最多 repair 一次
      if (allowBoundedRepair && useLLM && providers && rewriteSet.size > 0 && !repaired) {
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
      return {
        reportId: randomUUID(),
        reportType: "pedagogy" as const,
        candidateRevisionId: c.candidateRevisionId,
        candidateRevisionHash: c.candidateRevisionHash,
        inputHash: run.input_snapshot_hash,
        version: 2,
        reportHash: simplifiedReportHash({ reportType: "pedagogy", candidateRevisionId: c.candidateRevisionId, inputHash: run.input_snapshot_hash, issues: [], verdict: pedagogyPassed ? "passed" : "failed", gateVersion: "v2" }),
        issues: [],
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

    // 15b. R35/§17.7：per-candidate pedagogy 事件（此前缺失生产者，批量写）
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
        },
      };
    });
    if (pedagogyEvents.length > 0) {
      await insertEventsBatched(tx, workspaceId, runId, pedagogyEvents);
    }

    // 16. 终态判定
    const survivors = afterRepair;
    // R35/§12.5：pedagogy set-level `no_cards` 结论 → 成功终态
    // no_cards_recommended（不落 needs_attention；0 卡是可解释的成功结果）。
    const pedagogyNoCards = pedagogyReport?.verdict === "no_cards";
    if (pedagogyNoCards) {
      await insertEvent(tx, workspaceId, runId, "card_generation.no_cards_recommended", {
        reason: "pedagogy_no_cards",
      });
      await tx.execute(sql`
        UPDATE public.card_generation_runs_v2
        SET status = 'no_cards_recommended', updated_at = now()
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
      await tx.execute(sql`
        UPDATE public.card_generation_runs_v2
        SET status = 'needs_attention', updated_at = now()
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
      SET status = 'review_ready', updated_at = now()
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

async function loadV2RunInputs(tx: WorkerTransaction, workspaceId: string, runId: string) {
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
  // ── 激活前评估（第四轮审计 #5）：同 processCardGenerationPlan——整份 scoped
  //    note 的 source text join 成 sourceContent，随 sealed evidence 贯穿
  //    regenerate/replan/recheck 管道。未激活时确定性快路径，内存可控；
  //    激活前须设源文本规模上限或分块。
  const sourceContent = scopedBlocks.map((b) => b.content).join("\n");

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
async function processRegenerateCandidateJob(job: PendingOutboxJob): Promise<void> {
  const { workspaceId, runId } = job;
  const useLLM = process.env.CARD_GENERATION_V2_LLM === "true";
  const payload = job.payload as { candidateRevisionId?: string; feedbackReasonCodes?: string[] };

  await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
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
      ? await buildProvidersForRun({ workspaceId, job, semanticSpec: ctx.semanticSpec })
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
      useLLM,
      allowBoundedRepair: false,
    });
    await insertEvent(tx, workspaceId, runId, "card_candidate.regenerated", {
      candidateId: candidate.candidateId,
      previousRevisionId: candidateRevisionId,
      newRevisionId: newRevision.candidateRevisionId,
      revision: newRevision.revision,
    });
  });
}

/**
 * §17.4 replan_set：worker 创建新 immutable CardPlan revision（planVersion+1，
 * previous_plan_revision_id=旧）→ 旧计划未激活候选 supersede → 全量重新 author
 * → 重跑双 Critic + deck gate。planHash 按新版本重算（§11.6 同一 canonical 规则）。
 */
async function processReplanSetJob(job: PendingOutboxJob): Promise<void> {
  const { workspaceId, runId } = job;
  const useLLM = process.env.CARD_GENERATION_V2_LLM === "true";
  const payload = job.payload as { feedbackReasonCodes?: string[] };

  await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    const ctx = await loadV2RunInputs(tx, workspaceId, runId);
    const run = ctx.run;
    if (!["review_ready", "needs_attention"].includes(run.status as string)) {
      // jobType 状态门闩不合法：确定性业务违约，非重试
      throw new CardGenerationProviderErrorLike(false, `replan requires review_ready/needs_attention run (got ${String(run.status)})`);
    }
    const providers = useLLM
      ? await buildProvidersForRun({ workspaceId, job, semanticSpec: ctx.semanticSpec })
      : null;

    // 1. 重跑 planner（同输入；feedback 偏好为 soft，仅 LLM 模式消费）
    const plannerResult = await executePlanner({
      runId,
      workspaceId,
      inputSnapshot: ctx.inputSnapshot,
      semanticSpec: ctx.semanticSpec,
      blocks: ctx.scopedBlocks,
      unsupportedSourceBlocks: ctx.unsupportedSourceBlocks,
      existingObjectives: ctx.existingObjectives,
      clientHardMaxCards: ctx.inputSnapshot?.rawRequest?.quantity?.hardMaxCards,
      extractionProvider: useLLM && providers ? providers.plannerExtraction : undefined,
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
    });
    const candidates = authorResult.candidates.map((c) => ({
      ...c,
      evidenceSetHash: ctx.sealed.evidenceSetHash,
    }));
    for (const candidate of candidates) {
      await tx.execute(sql`
        INSERT INTO public.card_generation_candidates_v2
          (id, workspace_id, run_id, candidate_id, candidate_revision_id, revision,
           plan_revision_id, plan_version, plan_hash, card_content_epoch,
           plan_objective_local_id, recommendation, derived_from,
           objective_draft, presentation_draft, evidence_set_hash,
           candidate_revision_hash, quality_state, review_decision, publish_state)
        VALUES (
          ${randomUUID()}, ${workspaceId}, ${runId},
          ${candidate.candidateId}, ${candidate.candidateRevisionId}, ${candidate.revision},
          ${candidate.planRevisionId}, ${candidate.planVersion}, ${candidate.planHash},
          ${candidate.cardContentEpoch}, ${candidate.planObjectiveLocalId},
          ${JSON.stringify(candidate.recommendation)}::jsonb,
          ${JSON.stringify(candidate.derivedFromCandidateRevisions)}::jsonb,
          ${JSON.stringify(candidate.objective)}::jsonb,
          ${JSON.stringify(candidate.presentation)}::jsonb,
          ${candidate.evidenceSetHash},
          ${candidate.candidateRevisionHash},
          'authored', 'undecided', 'unpublished'
        )
      `);
      await insertEvent(tx, workspaceId, runId, "card_candidate.authored", {
        candidateId: candidate.candidateId,
        candidateRevisionId: candidate.candidateRevisionId,
      });
    }

    // 6. checking → 重跑双 Critic + deck gate（§17.4 新计划必须完整过门禁）
    await tx.execute(sql`
      UPDATE public.card_generation_runs_v2
      SET status = 'checking', updated_at = now()
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
      useLLM,
    });
    await insertEvent(tx, workspaceId, runId, "card_generation.replan_completed", {
      planVersion: plan.planVersion,
      previousPlanRevisionId: prevPlanRevisionId,
      feedbackReasonCodes: payload.feedbackReasonCodes ?? [],
    });
  });
}

// ─── 候选行 → 对象构建（regenerate/recheck 复用）──────────────────────────

function candidateRowToObject(
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
async function processRecheckCandidateJob(job: PendingOutboxJob): Promise<void> {
  const { workspaceId, runId } = job;
  const useLLM = process.env.CARD_GENERATION_V2_LLM === "true";
  const payload = job.payload as { candidateRevisionId?: string; reason?: string };

  await withWorkerWorkspaceTransaction({ workspaceId, userId: null }, async (tx) => {
    const ctx = await loadV2RunInputs(tx, workspaceId, runId);
    const run = ctx.run;
    if (!["review_ready", "needs_attention"].includes(run.status as string)) {
      // jobType 状态门闩不合法：确定性业务违约，非重试
      throw new CardGenerationProviderErrorLike(false, `recheck requires review_ready/needs_attention run (got ${String(run.status)})`);
    }
    const candidateRevisionId = payload.candidateRevisionId;
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
    const candidate = candidateRowToObject(row, runId);

    const providers = useLLM
      ? await buildProvidersForRun({ workspaceId, job, semanticSpec: ctx.semanticSpec })
      : null;

    // 完整重跑门禁（§12.2/§12.3：编辑/合并产物无绕 Gate 权）
    await critiqueAndFinalizeCandidates(tx, {
      runId,
      workspaceId,
      run: run as unknown as { input_snapshot_hash: string; semantic_spec_hash: string },
      plan: ctx.plan,
      candidates: [candidate],
      sealed: ctx.sealed,
      sourceContent: ctx.sourceContent,
      existingObjectives: ctx.existingObjectives,
      providers,
      useLLM,
      // The initial generation already consumed the single bounded repair
      // budget. A recheck must only rerun the gates for this immutable
      // authored revision; allowing another repair here creates an unbounded
      // recheck → authored-revision chain when the critic keeps returning
      // `rewrite`.
      allowBoundedRepair: false,
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
    if (Number(usableLatest[0]?.count ?? 0) > 0) {
      await tx.execute(sql`
        UPDATE public.card_generation_runs_v2
        SET status = 'review_ready', updated_at = now()
        WHERE id = ${runId} AND workspace_id = ${workspaceId}
          AND status = 'needs_attention'
      `);
    }
    await insertEvent(tx, workspaceId, runId, "card_candidate.recheck_completed", {
      candidateId: candidate.candidateId,
      candidateRevisionId: candidate.candidateRevisionId,
      revision: candidate.revision,
      reason: payload.reason ?? "edit",
    });
  });
}

// ─── Bounded Repair（§12.5）──────────────────────────────────────────────

/**
 * 对失败候选做局部 repair：调 author provider 重写 → 新 immutable revision。
 * 返回新 revision 的 candidate 对象，由调用方决定重跑 gates。
 */
async function boundedRepairCandidate(
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
  },
): Promise<LearningCardCandidateRevisionV2> {
  const authorInput = {
    planObjective: {
      objectiveLocalId: input.candidate.planObjectiveLocalId,
      objectiveStatement: input.candidate.objective.objectiveStatement,
      knowledgeForm: input.candidate.objective.knowledgeForm,
    } as never,
    sourceContent: input.sourceContent,
    semanticSpecHash: input.semanticSpecHash,
    planHash: input.plan.planHash,
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
       objective_draft, presentation_draft, evidence_set_hash,
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

// ─── Providers 构造（惰性，减小 worker 重边）─────────────────────────────

async function buildProvidersForRun(input: {
  workspaceId: string;
  job: PendingOutboxJob;
  semanticSpec: GenerationSemanticSpecV2;
}): Promise<{
  plannerExtraction: AtomExtractionProvider;
  author: AuthoringProvider;
  grounding: GroundingCriticProvider;
  pedagogy: PedagogyCriticProvider;
}> {
  const { buildCardGenerationProviders } = await import("../card-generation-v2/providers.ts");
  const providers = await buildCardGenerationProviders({
    workspaceId: input.workspaceId,
    userId: null,
    semanticSpec: input.semanticSpec,
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
 * （运行中 job 继续后台跑，靠 30min 租约 + lease CAS + reaper 兜底，不丢副作用、
 * 不重复计费），从而使主循环每次 tick 仅最多阻塞该预算时长即恢复。
 */
export const V2_POLL_TICK_BUDGET_MS = 5_000;

export async function pollV2Outbox(limit = 1, awaitBudgetMs = V2_POLL_TIMEOUT_MS): Promise<number> {
  // 孤儿回收：节流地重置超期 processing 行为 pending，保证崩溃恢复且不浪费
  // 空闲时的扫描查询（V2_REAP_THROTTLE_MS）。reap 失败不阻断 claim。
  // 整体用 runWithAbortTimeout 包裹，使 poll 返回有上界（默认 V2_POLL_TIMEOUT_MS；
  // 主 tick 传更小的 V2_POLL_TICK_BUDGET_MS），防止卡死的 V2 LLM HTTP 调用冻结主
  // tick（第四轮审计 #3/#26）。超时后底层任务继续后台运行，靠 30min 租约 + reaper
  // 兜底。job 内每个 chatJson 调用本身还有 75s 单调用 abort。
  // ── 激活前评估（round-8 🟠2，保持现状）─────────────────────────────────────
  // 上述 abort 只解耦"主 tick 的阻塞"，并不释放资源：abortable 内同一后台连续体
  // 会把已认领 job 的 processV2OutboxJob 继续跑完（processV2OutboxJob 不接收 poll
  // signal，仅 chatJson 各自 75s abort）。因此 5s 预算期间，一个 LLM 模式的慢 job
  // 仍会长时间占用：DB 连接 + withWorkerWorkspaceTransaction 的长事务 + run 行
  // FOR UPDATE 锁，最坏 ~8.75min（whole pipeline）。后续 tick 再 claim（limit=1）
  // 其它 pending job 若属同一 run（如 replan 排在 plan 后）会排队等该 run 行锁；
  // 多 run 高并发后台慢 job 叠加有连接池耗尽风险。V2 未激活无损；激活前需评估
  // 「阶段间续租 / 把 LLM 移出事务 + 状态机 run.status 门闩」（代码 L595-601 亦自标）。
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
      const jobs = await claimV2OutboxJobs(limit);
      for (const job of jobs) {
        await processV2OutboxJob(job);
      }
      return jobs.length;
    },
    awaitBudgetMs,
    (lateError) => logger.warn(
      { error: sanitizeOperationalError(lateError) },
      "V2 outbox poll hit timeout; background job continues under 30min lease",
    ),
  );
}
