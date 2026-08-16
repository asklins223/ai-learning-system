/**
 * LearningRun 服务（文档 16 §13 P2 纵切）。
 *
 * 事务纪律：全部函数接收 `tx: ApiTransaction`，只在调用方
 * withWorkspaceTransaction 事务内执行（路由层统一包装；RLS 上下文由
 * withWorkspaceTransaction 设置）。禁止在事务外直接写表。
 *
 * P2 范围：card/today/review 入口 + text/voice 单一 Task + pause/resume/end/
 * skip/request_hint/switch_variant 动作 + draft CAS + 原子 submission +
 * result/return-contract。star_map/onboarding sandbox 入口 fail closed
 * （后续阶段开放），结构题与 followup 属 P4。
 *
 * 关键不变量：
 * - 创建幂等：learning_run_idempotency(workspace,user,key) 唯一；
 * - 提交原子：校验 → assistance snapshot → 锁 Artifact → 排队 Assessment →
 *   outbox（§12.3 七步在同一事务）；
 * - declared_unable 只走 submission，不进 action API；
 * - 答案正文不进事件 payload / outbox payload。
 */

import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { interactionQualifications } from "../../db/schema/learning-runs.ts";
import type { ApiTransaction } from "../../db/client.ts";
import {
  learningActivityLeases,
  learningArtifacts,
  learningAssessments,
  learningRunActionLedger,
  learningRunEvents,
  learningRunIdempotency,
  learningRunPrivateContracts,
  learningRunProcessingOutbox,
  learningRuns,
  learningTaskDisclosureProfiles,
  learningTaskDrafts,
  learningTaskPresentationHistory,
  learningTaskPrivateSolutions,
  learningTaskSafetyReports,
  learningTaskVariants,
  learningTasks,
} from "../../db/schema/learning-runs.ts";
import {
  cardKeyPoints,
  learningCards,
} from "../../db/schema/card.ts";
import {
  evidenceEligibilityStatesV2,
  learningObjectivesV2,
} from "../../db/schema/card-generation-v2.ts";
import { reviewSchedules } from "../../db/schema/evidence.ts";
import type {
  CreateLearningRunRequestV1,
  LearningRunActionV1,
  LearningRunPublicV1,
  LearningRunResultV1,
  LearningRunReturnContractV1,
  SchedulingAuthorizationV1,
  SubmitTaskArtifactV1,
} from "@ailearn/shared";
import {
  computeRunContractHash,
  planRun,
  buildVariant,
  buildClosure,
  buildDeterministicHint,
  clampTimeBudget,
  rubricTargetIdsOf,
  sha256Hex,
  type PlannerOptions,
  type PlannedTaskInput,
  type PlannerV2Target,
  type RunPlannerTargetInput,
} from "./run-planner.ts";
import {
  freezeTargetSnapshotV2,
  prepareCardContentEpoch,
  loadFrozenTargetSnapshotV2,
  buildLearningRunTargetPublicV2,
  type FrozenTargetSnapshotV2,
} from "../card-generation-v2/target-snapshot-adapter.ts";
import type { LearningRunOriginV2 } from "@ailearn/shared";
import {
  artifactAlreadyLocked,
  contextStale,
  idempotencyConflict,
  invalidPhase,
  LearningRunServiceError,
  runNotFound,
  scheduleGenerationChanged,
  staleRunRevision,
  staleTaskRevision,
  variantNotAuthorized,
} from "./run-errors.ts";
import { buildRunPublicView } from "./run-view.ts";
import { decryptDraftPayload, encryptDraftPayload, isDraftEncryptionAvailable } from "./run-draft-crypto.ts";

// ─── 服务接口（路由层注入）───────────────────────────────────────────────

export interface RunScope {
  workspaceId: string;
  userId: string;
}

export interface CreateRunInput extends RunScope {
  request: CreateLearningRunRequestV1;
}

/** §16.3 V2 PREPARE 请求（wire 上带 originV2；与 V1 的 origin 互斥）。 */
export interface CreateLearningRunV2Request {
  originV2: LearningRunOriginV2;
  goal: LearningRunPublicV1["goal"];
  requestedTimeBudgetSeconds?: number;
  responsePreference?: "adaptive" | "voice" | "text" | "structured";
  idempotencyKey: string;
}

export interface CreateRunV2Input extends RunScope {
  request: CreateLearningRunV2Request;
}

export interface ActionInput extends RunScope {
  runId: string;
  runRevision: number;
  runtimeEpoch: number;
  taskRevision?: number;
  action: LearningRunActionV1;
  idempotencyKey: string;
}

export interface DraftInput extends RunScope {
  runId: string;
  taskId: string;
  variantId: string;
  variantRevision: number;
  taskRevision: number;
  expectedDraftRevision: number | null;
  payload: unknown | null;
  rendererState: unknown;
  idempotencyKey: string;
}

export interface SubmitInput extends RunScope {
  runId: string;
  taskId: string;
  request: SubmitTaskArtifactV1;
}

// ─── 权限与读取 ──────────────────────────────────────────────────────────

async function loadRun(tx: ApiTransaction, scope: RunScope, runId: string, forUpdate = false) {
  const query = tx
    .select()
    .from(learningRuns)
    .where(and(
      eq(learningRuns.id, runId),
      eq(learningRuns.workspaceId, scope.workspaceId),
      eq(learningRuns.userId, scope.userId),
    ))
    .limit(1);
  // §13.2.1：写路径用 Run row lock（FOR UPDATE）保证 revision/epoch CAS 原子。
  const rows = forUpdate ? await query.for("update").execute() : await query;
  const row = rows[0];
  if (!row) throw runNotFound();
  return row;
}

// ─── createRun（PREPARE：origin 解析 → 授权 → 确定性规划 → 原子写入）────

async function resolveOriginTarget(
  tx: ApiTransaction,
  scope: RunScope,
  request: CreateLearningRunRequestV1,
): Promise<{
  keyPointId: string;
  fingerprint: string;
  claim: string;
  evidenceContentHashes: string[];
  quote?: string;
  sandboxNamespaceId?: string;
  schedulingAuthorization: SchedulingAuthorizationV1;
  returnTarget: LearningRunPublicV1["returnTarget"];
}> {
  const origin = request.origin;

  if (origin.kind === "star_map") {
    // P7：星图行动面已接入 Projection V2——校验基线 checkpoint（解析失败、
    // 作用域不符或落后于最新投影 → 409 stale，禁止基于陈旧图启动 Run）。
    const { parseCheckpointToken, watermarkBehind } = await import("../understanding/projection-checkpoint.ts");
    const baseline = parseCheckpointToken(origin.baselineCheckpoint.token);
    if (!baseline
      || baseline.workspaceId !== scope.workspaceId
      || baseline.userId !== scope.userId) {
      throw contextStale("投影基线 checkpoint 无效或作用域不符");
    }
    const { understandingProjectionCheckpoints } = await import("../../db/schema/understanding-projection.ts");
    const latestRows = await tx
      .select({
        canonical: understandingProjectionCheckpoints.lastCanonicalEventId,
        practice: understandingProjectionCheckpoints.lastPracticeEventId,
        capturedAt: understandingProjectionCheckpoints.capturedAt,
      })
      .from(understandingProjectionCheckpoints)
      .where(and(
        eq(understandingProjectionCheckpoints.workspaceId, scope.workspaceId),
        eq(understandingProjectionCheckpoints.userId, scope.userId),
      ))
      .orderBy(desc(understandingProjectionCheckpoints.capturedAt))
      .limit(1);
    const latest = latestRows[0]
      ? {
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          lastCanonicalEventId: latestRows[0].canonical,
          lastPracticeEventId: latestRows[0].practice,
          capturedAt: latestRows[0].capturedAt.toISOString(),
        }
      : null;
    if (watermarkBehind(baseline, latest)) {
      throw contextStale("投影基线已过期（星图有新的变化）");
    }
    const canonical = await fetchCanonicalTarget(tx, scope, origin.keyPointId);
    // star_map 从行动面启动：无 pending review schedule 时 create_initial
    // （与 card 入口同一授权规则）；有 pending 则 consume_pending。
    const schedRows = await tx
      .select({ id: reviewSchedules.id, generation: reviewSchedules.generation, status: reviewSchedules.status })
      .from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.keyPointId, origin.keyPointId),
        eq(reviewSchedules.workspaceId, scope.workspaceId),
        eq(reviewSchedules.userId, scope.userId),
        eq(reviewSchedules.status, "pending"),
      ))
      .orderBy(desc(reviewSchedules.generation))
      .limit(1);
    const schedulingAuthorization: SchedulingAuthorizationV1 = schedRows[0]
      ? {
          kind: "consume_pending",
          scheduleId: schedRows[0].id,
          scheduleGeneration: schedRows[0].generation,
          keyPointId: origin.keyPointId,
          targetFingerprint: canonical.fingerprint,
          dueAt: new Date().toISOString(),
          schedulerPolicyId: "review-schedule-v1",
        }
      : {
          kind: "create_initial",
          keyPointId: origin.keyPointId,
          targetFingerprint: canonical.fingerprint,
          schedulerPolicyId: "review-schedule-v1",
        };
    return {
      keyPointId: origin.keyPointId,
      ...canonical,
      schedulingAuthorization,
      returnTarget: {
        kind: "star_map",
        keyPointId: origin.keyPointId,
        lens: origin.lens,
        filter: origin.filter,
        routePlanId: origin.routePlanId,
      },
    };
  }
  if (origin.kind === "onboarding" && origin.sampleMode === "sandbox") {
    // §16.4：sandbox Run 必须携带有效 namespace（active + 未过期 + 属于本
    // user/workspace）；缺失/无效 fail closed（不冒充隔离教学空间）。
    const { companionSandboxNamespaces } = await import("../../db/schema/companion-sandbox.ts");
    if (!origin.sandboxNamespaceId) {
      throw contextStale("沙箱教学空间参数缺失");
    }
    const nsRows = await tx
      .select({ id: companionSandboxNamespaces.id, status: companionSandboxNamespaces.status, expiresAt: companionSandboxNamespaces.expiresAt })
      .from(companionSandboxNamespaces)
      .where(and(
        eq(companionSandboxNamespaces.id, origin.sandboxNamespaceId),
        eq(companionSandboxNamespaces.workspaceId, scope.workspaceId),
        eq(companionSandboxNamespaces.userId, scope.userId),
      ))
      .limit(1);
    const namespace = nsRows[0];
    if (!namespace || namespace.status !== "active" || namespace.expiresAt.getTime() < Date.now()) {
      throw contextStale("沙箱教学空间不存在或已过期");
    }
    const canonical = await fetchCanonicalTarget(tx, scope, origin.keyPointId);
    return {
      keyPointId: origin.keyPointId,
      ...canonical,
      sandboxNamespaceId: origin.sandboxNamespaceId,
      schedulingAuthorization: { kind: "no_effect", reasonCode: "sandbox" },
      returnTarget: { kind: "onboarding", destination: "today" },
    };
  }

  if (origin.kind === "card") {
    const kpRows = await tx
      .select({ kpId: cardKeyPoints.id, claim: cardKeyPoints.claim })
      .from(cardKeyPoints)
      .innerJoin(learningCards, eq(learningCards.id, cardKeyPoints.cardId))
      .where(and(
        eq(cardKeyPoints.id, origin.keyPointId),
        eq(cardKeyPoints.workspaceId, scope.workspaceId),
        eq(learningCards.id, origin.cardId),
        eq(learningCards.workspaceId, scope.workspaceId),
        eq(learningCards.status, "active"),
      ))
      .limit(1);
    if (kpRows.length === 0) throw contextStale("学习卡或要点不存在");
    return buildCardTarget(tx, scope, origin.keyPointId, {
      kind: "card",
      cardId: origin.cardId,
      keyPointId: origin.keyPointId,
    });
  }

  if (origin.kind === "review") {
    const schedRows = await tx
      .select({
        id: reviewSchedules.id,
        keyPointId: reviewSchedules.keyPointId,
        generation: reviewSchedules.generation,
        status: reviewSchedules.status,
      })
      .from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.id, origin.scheduleId),
        eq(reviewSchedules.workspaceId, scope.workspaceId),
        eq(reviewSchedules.userId, scope.userId),
      ))
      .limit(1);
    const sched = schedRows[0];
    if (!sched || sched.keyPointId !== origin.keyPointId || sched.generation !== origin.scheduleGeneration) {
      throw scheduleGenerationChanged();
    }
    if (sched.status !== "pending") {
      throw scheduleGenerationChanged();
    }
    const kpRows = await tx
      .select({ claim: cardKeyPoints.claim })
      .from(cardKeyPoints)
      .where(and(
        eq(cardKeyPoints.id, origin.keyPointId),
        eq(cardKeyPoints.workspaceId, scope.workspaceId),
      ))
      .limit(1);
    if (kpRows.length === 0) throw contextStale("学习要点不存在");
    const canonical = await fetchCanonicalTarget(tx, scope, origin.keyPointId);
    const schedulingAuthorization: SchedulingAuthorizationV1 = {
      kind: "consume_pending",
      scheduleId: origin.scheduleId,
      scheduleGeneration: origin.scheduleGeneration,
      keyPointId: origin.keyPointId,
      targetFingerprint: canonical.fingerprint,
      dueAt: new Date().toISOString(),
      schedulerPolicyId: "review-schedule-v1",
    };
    return {
      keyPointId: origin.keyPointId,
      ...canonical,
      schedulingAuthorization,
      returnTarget: { kind: "review", scheduleId: origin.scheduleId, keyPointId: origin.keyPointId },
    };
  }

  if (origin.kind === "today" || origin.kind === "onboarding") {
    const canonical = await fetchCanonicalTarget(tx, scope, origin.keyPointId);
    return {
      keyPointId: origin.keyPointId,
      ...canonical,
      schedulingAuthorization: {
        kind: "no_effect",
        reasonCode: "not_authorized",
      },
      returnTarget: origin.kind === "today"
        ? { kind: "today" }
        : { kind: "onboarding", destination: "today" },
    };
  }

  throw contextStale("不支持的入口");
}

async function buildCardTarget(
  tx: ApiTransaction,
  scope: RunScope,
  keyPointId: string,
  returnTarget: LearningRunPublicV1["returnTarget"],
) {
  const canonical = await fetchCanonicalTarget(tx, scope, keyPointId);
  // 卡上巩固：若该 keyPoint 已有 pending schedule，不重复创建也不消费
  // （到期复习走 review origin；卡上巩固 0 schedule 副作用）。
  const schedRows = await tx
    .select({ id: reviewSchedules.id })
    .from(reviewSchedules)
    .where(and(
      eq(reviewSchedules.workspaceId, scope.workspaceId),
      eq(reviewSchedules.userId, scope.userId),
      eq(reviewSchedules.keyPointId, keyPointId),
      eq(reviewSchedules.status, "pending"),
    ))
    .limit(1);
  const schedulingAuthorization: SchedulingAuthorizationV1 = schedRows.length === 0
    ? {
        kind: "create_initial",
        keyPointId,
        targetFingerprint: canonical.fingerprint,
        schedulerPolicyId: "review-schedule-v1",
      }
    : { kind: "no_effect", reasonCode: "not_authorized" };
  return { keyPointId, ...canonical, schedulingAuthorization, returnTarget };
}

/** 从 canonical 输入计算 target fingerprint（card+evidence content 哈希）。 */
async function fetchCanonicalTarget(
  tx: ApiTransaction,
  scope: RunScope,
  keyPointId: string,
): Promise<{ fingerprint: string; claim: string; evidenceContentHashes: string[]; quote?: string }> {
  const rows = await tx
    .select({
      keyPointId: cardKeyPoints.id,
      claim: cardKeyPoints.claim,
      quote: cardKeyPoints.quoteText,
    })
    .from(cardKeyPoints)
    .where(and(
      eq(cardKeyPoints.id, keyPointId),
      eq(cardKeyPoints.workspaceId, scope.workspaceId),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) throw contextStale("学习要点不存在");
  const fingerprint = sha256Hex(
    `kp:${row.keyPointId}|claim:${row.claim}|quote:${row.quote}`,
  );
  return {
    fingerprint,
    claim: row.claim,
    evidenceContentHashes: [sha256Hex(row.quote)],
    // P4 relation 题面节点 label（公开引用原文，非答案）。
    quote: row.quote,
  };
}

/**
 * §6.2/§12.2 补充证据 Task（V1 practice 微修补）：activate_followup 时即时
 * 规划并持久化一个 text 开放回答短任务（intent=repair；无 qualification →
 * purpose=practice / ceiling=practice_only，§7.7 上限）。
 */
async function planFollowupTask(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  run: typeof learningRuns.$inferSelect,
  at: Date,
): Promise<{ taskId: string }> {
  // run.origin 存的是 request.origin（无外层包装）；resolveOriginTarget 需要完整 request。
  const target = await resolveOriginTarget(tx, scope, { origin: run.origin } as never);
  const taskId = crypto.randomUUID();
  // resolveOriginTarget 返回 fingerprint（V1/V2 统一语义）；planner 需要
  // sourceFingerprint 字段名。
  const plannerTarget: RunPlannerTargetInput = {
    keyPointId: target.keyPointId,
    claim: target.claim,
    sourceFingerprint: target.fingerprint,
    evidenceContentHashes: target.evidenceContentHashes,
    quote: target.quote,
  };
  const followupTask: PlannedTaskInput = {
    taskId,
    runId: run.id,
    sequence: 2,
    intent: "repair",
    prompt: `请补充说明这个要点：${target.claim}。指出上次回答中不准确或不完整的部分并纠正。`,
    targetSummary: target.claim.slice(0, 160),
    hintLevels: 1,
    primaryFamily: "text",
    purpose: "practice",
    templateTrustCeiling: "practice_only",
    estimatedActiveSeconds: 40,
  };
  const textVariant = buildVariant(run.id, taskId, "text", 40, plannerTarget, followupTask);
  const closure = buildClosure(
    run.id, taskId, textVariant, plannerTarget, followupTask,
    sha256Hex(`followup:${run.id}:${taskId}`),
  );
  await tx.insert(learningTasks).values({
    id: taskId,
    runId: run.id,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    sequence: 2,
    intent: "repair",
    prompt: followupTask.prompt,
    targetSummary: followupTask.targetSummary,
    hintLevels: 1,
    status: "active",
    revision: 1,
    presentedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  await tx.insert(learningTaskVariants).values({
    id: textVariant.variantId,
    taskId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    purpose: "practice",
    templateTrustCeiling: "practice_only",
    estimatedActiveSeconds: 40,
    interaction: textVariant.interaction,
    publicPayloadHash: textVariant.publicPayloadHash,
    inputSchemaHash: textVariant.inputSchemaHash,
    disclosureProfileHash: textVariant.disclosureProfileHash,
    privateSolutionHash: closure.privateSolutionHash,
    safetyReportHash: closure.reportHash,
    rubricTargetIds: rubricTargetIdsOf(closure.solution),
    alternatives: [],
    revision: 1,
    status: "active",
    createdAt: at,
    updatedAt: at,
  });
  await tx.insert(learningTaskPrivateSolutions).values({
    variantId: textVariant.variantId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    solution: closure.solution,
    privateSolutionHash: closure.privateSolutionHash,
    runPlanHash: closure.runPlanHash,
    createdAt: at,
  });
  await tx.insert(learningTaskSafetyReports).values({
    taskId,
    variantId: textVariant.variantId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    publicPayloadHash: textVariant.publicPayloadHash,
    inputSchemaHash: textVariant.inputSchemaHash,
    privateSolutionHash: closure.privateSolutionHash,
    disclosureProfileHash: textVariant.disclosureProfileHash,
    qualificationProfileHash: null,
    runPlanHash: closure.runPlanHash,
    injectionScan: closure.safetyReport.injectionScan,
    privateLeakageScan: closure.safetyReport.privateLeakageScan,
    schemaValidation: closure.safetyReport.schemaValidation,
    accessibilityProfile: closure.safetyReport.accessibilityProfile,
    activationDecision: closure.safetyReport.activationDecision,
    reportHash: closure.reportHash,
    createdAt: at,
  });
  const existingDisclosure = await tx
    .select({ id: learningTaskDisclosureProfiles.id })
    .from(learningTaskDisclosureProfiles)
    .where(and(
      eq(learningTaskDisclosureProfiles.workspaceId, scope.workspaceId),
      eq(learningTaskDisclosureProfiles.profileHash, textVariant.disclosureProfileHash),
    ))
    .limit(1);
  if (!existingDisclosure[0]) {
    await tx.insert(learningTaskDisclosureProfiles).values({
      variantId: textVariant.variantId,
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      disclosedFieldPaths: closure.disclosure.disclosedFieldPaths,
      hiddenFieldPaths: closure.disclosure.hiddenFieldPaths,
      answerBearingFieldsHidden: true,
      profileHash: textVariant.disclosureProfileHash,
      createdAt: at,
    });
  }
  return { taskId };
}

/**
 * §7.8：Run 结算回填 presentation_history（outcome/exposed；按 runId 幂等）。
 * exposed 以服务端事件账本判定（learning_task.hint_requested），不信任客户端。
 */
export async function backfillPresentationHistory(
  tx: ApiTransaction,
  input: { runId: string; outcome: string },
): Promise<void> {
  const hintRows = await tx
    .select({ id: learningRunEvents.id })
    .from(learningRunEvents)
    .where(and(
      eq(learningRunEvents.runId, input.runId),
      eq(learningRunEvents.eventType, "learning_task.hint_requested"),
    ))
    .limit(1);
  await tx
    .update(learningTaskPresentationHistory)
    .set({ outcome: input.outcome, exposed: hintRows.length > 0 })
    .where(eq(learningTaskPresentationHistory.runId, input.runId));
}


// F16·①（round-4）：createRun/createRunV2 每次热路径都全表物化 interaction
// qualifications（无 WHERE）。表为全局参考表（无 workspaceId 维度，见 migration
// 0144），故可安全做进程内短 TTL 缓存（60s）：参考数据低频更新，缓存可消
// 每请求全扫热点。cache-hit 检查时顺带清过期条目，避免 Map 无界。
type InteractionQualificationRow = { approvedCeiling: "practice_only" | "diagnostic_only" | "facet_eligible" | "mastery_eligible"; expiresAt: string | null };
const INTERACTION_QUALIFICATION_CACHE_TTL_MS = 60_000;
const interactionQualificationCache = new Map<string, { at: number; data: Map<string, InteractionQualificationRow> }>();

/** §7.7：读取已审批且未过期的 interaction qualification（family → ceiling）。 */
async function loadInteractionQualifications(
  tx: ApiTransaction,
): Promise<Map<string, InteractionQualificationRow>> {
  const now = Date.now();
  const cached = interactionQualificationCache.get("interaction_qualifications");
  // 命中检查时顺带清理过期条目（有界）。
  if (cached) {
    if (now - cached.at < INTERACTION_QUALIFICATION_CACHE_TTL_MS) return cached.data;
    interactionQualificationCache.delete("interaction_qualifications");
  }
  const rows = await tx
    .select({
      family: interactionQualifications.family,
      approvedCeiling: interactionQualifications.approvedCeiling,
      expiresAt: interactionQualifications.expiresAt,
    })
    .from(interactionQualifications);
  const data = new Map(rows.map((row) => [
    row.family,
    { approvedCeiling: row.approvedCeiling, expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null },
  ]));
  interactionQualificationCache.set("interaction_qualifications", { at: now, data });
  return data;
}

/** §7.8：查询同一 (user,kp,intent) 最近 30 天已呈现的 publicPayloadHash 集合。 */
async function recentPresentedPayloadHashes(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string; keyPointId: string },
): Promise<Set<string>> {
  const rows = await tx
    .select({ publicPayloadHash: learningTaskPresentationHistory.publicPayloadHash })
    .from(learningTaskPresentationHistory)
    .where(and(
      eq(learningTaskPresentationHistory.workspaceId, scope.workspaceId),
      eq(learningTaskPresentationHistory.userId, scope.userId),
      eq(learningTaskPresentationHistory.keyPointId, scope.keyPointId),
      gte(learningTaskPresentationHistory.presentedAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
    ))
    // 热路径：只取最近一批用于展示去重（presentation-dedup 只需近端历史）。
    .orderBy(desc(learningTaskPresentationHistory.presentedAt))
    .limit(50);
  return new Set(rows.map((row) => row.publicPayloadHash));
}
export async function createRun(
  tx: ApiTransaction,
  input: CreateRunInput,
  now: () => Date = () => new Date(),
): Promise<LearningRunPublicV1> {
  const { workspaceId, userId } = input;
  const request = input.request;

  // 幂等：同 key 重放返回既有 Run 的公共快照；请求内容不同 → idempotency_conflict。
  // client_request_id 列保存请求指纹（origin/goal/预算/偏好），用于重放校验。
  // P7：star_map origin 的 baselineCheckpoint 是发起时刻快照（capturedAt/token
  // 每次投影刷新都会变化），不属于请求语义内容——指纹中剥离，否则同一天
  // 幂等重放必然 409（checkpoint 新鲜度由 resolveOriginTarget 单独校验）。
  const fingerprintOrigin = request.origin.kind === "star_map"
    ? { ...request.origin, baselineCheckpoint: { version: 1, token: "<opaque>" } }
    : request.origin;
  const requestFingerprint = sha256Hex(JSON.stringify({
    origin: fingerprintOrigin,
    goal: request.goal,
    requestedTimeBudgetSeconds: request.requestedTimeBudgetSeconds ?? null,
    responsePreference: request.responsePreference ?? null,
  }));
  const idemRows = await tx
    .select({ runId: learningRunIdempotency.runId, clientRequestId: learningRunIdempotency.clientRequestId })
    .from(learningRunIdempotency)
    .where(and(
      eq(learningRunIdempotency.workspaceId, workspaceId),
      eq(learningRunIdempotency.userId, userId),
      eq(learningRunIdempotency.idempotencyKey, request.idempotencyKey),
    ))
    .limit(1);
  if (idemRows[0]) {
    if (idemRows[0].clientRequestId !== requestFingerprint) {
      throw idempotencyConflict();
    }
    return getRunPublicView(tx, { workspaceId, userId, runId: idemRows[0].runId });
  }

  const target = await resolveOriginTarget(tx, { workspaceId, userId }, request);

  const timeBudgetSeconds = clampTimeBudget(request.requestedTimeBudgetSeconds);
  const runId = crypto.randomUUID();
  const [recentPublicPayloadHashes, interactionQualifications] = await Promise.all([
    recentPresentedPayloadHashes(tx, {
      workspaceId,
      userId,
      keyPointId: target.keyPointId,
    }),
    loadInteractionQualifications(tx),
  ]);
  const plannerOptions: PlannerOptions = {
    runId,
    goal: request.goal,
    responsePreference: request.responsePreference ?? "adaptive",
    timeBudgetSeconds,
    recentPublicPayloadHashes,
    interactionQualifications,
  };
  const plan = planRun(
    {
      keyPointId: target.keyPointId,
      claim: target.claim,
      sourceFingerprint: target.fingerprint,
      evidenceContentHashes: target.evidenceContentHashes,
      quote: target.quote,
    },
    plannerOptions,
  );

  const runtimeEpoch = 0;
  const contractHash = computeRunContractHash({
    runId,
    workspaceId,
    userId,
    keyPointId: target.keyPointId,
    targetFingerprint: target.fingerprint,
    runtimeEpoch,
    timeBudgetSeconds,
    planningClosesAtActiveSecond: 150,
    schedulingAuthorization: target.schedulingAuthorization,
    taskPlanHash: plan.runPlanHash,
    projectionBaselineCheckpointToken: null,
  });

  const task = plan.tasks[0];
  const primaryVariant = plan.primaryVariant;
  const alternativeVariant = plan.alternativeVariant;

  // 事务内原子写入：run + private contract + task + variants + closures + events。
  const createdAt = now();
  await tx.insert(learningRuns).values({
    id: runId,
    workspaceId,
    userId,
    origin: request.origin,
    returnTarget: target.returnTarget,
    keyPointId: target.keyPointId,
    targetFingerprint: target.fingerprint,
    goal: request.goal,
    phase: "active",
    timeBudgetSeconds,
    plannedActiveSeconds: plan.plannedActiveSeconds,
    activeTaskId: task.taskId,
    revision: 1,
    runtimeEpoch,
    sandboxNamespaceId: target.sandboxNamespaceId ?? null,
    createdAt,
    updatedAt: createdAt,
  });
  // 幂等占位（onConflictDoNothing）：并发同 key 双请求只有一方插入成功；
  // 输者删除自己刚插入的 Run 行并返回 winner 视图——绝不因唯一索引冲突 500。
  const insertedIdem = await tx.insert(learningRunIdempotency).values({
    workspaceId,
    userId,
    idempotencyKey: request.idempotencyKey,
    clientRequestId: requestFingerprint,
    runId,
    createdAt,
  }).onConflictDoNothing().returning({ runId: learningRunIdempotency.runId });
  if (insertedIdem.length === 0) {
    await tx.delete(learningRuns).where(eq(learningRuns.id, runId));
    const winner = await tx
      .select({ runId: learningRunIdempotency.runId, clientRequestId: learningRunIdempotency.clientRequestId })
      .from(learningRunIdempotency)
      .where(and(
        eq(learningRunIdempotency.workspaceId, workspaceId),
        eq(learningRunIdempotency.userId, userId),
        eq(learningRunIdempotency.idempotencyKey, request.idempotencyKey),
      ))
      .limit(1);
    if (!winner[0]) throw idempotencyConflict();
    if (winner[0].clientRequestId !== requestFingerprint) throw idempotencyConflict();
    return getRunPublicView(tx, { workspaceId, userId, runId: winner[0].runId });
  }
  await tx.insert(learningRunPrivateContracts).values({
    runId,
    workspaceId,
    userId,
    keyPointId: target.keyPointId,
    targetFingerprint: target.fingerprint,
    runtimeEpoch,
    timeBudgetSeconds,
    planningClosesAtActiveSecond: 150,
    schedulingAuthorization: target.schedulingAuthorization,
    taskPlanHash: plan.runPlanHash,
    projectionBaselineCheckpointToken: null,
    contractHash,
    createdAt,
  });
  // §21.3 legacy additive sidecar：V1 run 无 V2 snapshot，PREPARE 时追加只读
  // attachment（不改写任何旧 hash/序列）。
  // 2026-08-14 摘除（方案 20 C5 中间态）：其映射查询依赖的 `public.cards`
  // 表不存在、attachment 表对 ailearn_api 尚无 RLS INSERT 权限——在 createRun
  // 单事务内失败会把整个事务标记 aborted（"current transaction is aborted"），
  // 直接破坏方案 16 的 PREPARE 主链路。方案 20 恢复实施时必须以事务外
  // （新事务/异步）方式重新接入，且表/权限就绪后再放开。
  // 接入点：createRun 成功返回后，以独立 withWorkspaceTransaction 调用
  //   resolveKeyPointIdToObjectiveId + createLegacyTargetSnapshotAttachmentV2
  //   （两者仍在 card-generation-v2/target-snapshot-adapter.ts 导出）。
  await tx.insert(learningTasks).values({
    id: task.taskId,
    runId,
    workspaceId,
    userId,
    sequence: task.sequence,
    intent: task.intent,
    prompt: task.prompt,
    targetSummary: task.targetSummary,
    hintLevels: task.hintLevels,
    status: "active",
    revision: 1,
    presentedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  });
  // PERF-A#13：在变体循环前一次性 IN 查询两个 variant 的 disclosure profile
  // 存在性，避免每个 variant 在 PREPARE 热路径各加一次 SELECT 往返。
  const disclosureHashes = Array.from(new Set(
    [primaryVariant, alternativeVariant]
      .map((v) => v.disclosureProfileHash)
      .filter((h): h is string => Boolean(h)),
  ));
  const existingDisclosureHashes = new Set<string>();
  if (disclosureHashes.length > 0) {
    const existingDisclosureRows = await tx
      .select({ profileHash: learningTaskDisclosureProfiles.profileHash })
      .from(learningTaskDisclosureProfiles)
      .where(and(
        eq(learningTaskDisclosureProfiles.workspaceId, workspaceId),
        inArray(learningTaskDisclosureProfiles.profileHash, disclosureHashes),
      ));
    for (const r of existingDisclosureRows) existingDisclosureHashes.add(r.profileHash);
  }
  for (const [index, variant] of [primaryVariant, alternativeVariant].entries()) {
    const closure = plan.closures[variant.variantId];
    await tx.insert(learningTaskVariants).values({
      id: variant.variantId,
      taskId: task.taskId,
      workspaceId,
      userId,
      purpose: task.purpose,
      templateTrustCeiling: task.templateTrustCeiling,
      estimatedActiveSeconds: task.estimatedActiveSeconds,
      interaction: variant.interaction,
      publicPayloadHash: variant.publicPayloadHash,
      inputSchemaHash: variant.inputSchemaHash,
      disclosureProfileHash: variant.disclosureProfileHash,
      // 0120：private 闭包冗余到 variant 行（api 进程提交时读；private 表
      // 对 ailearn_api 保持仅 INSERT 无 SELECT 的隔离）。
      privateSolutionHash: closure.privateSolutionHash,
      safetyReportHash: closure.reportHash,
      rubricTargetIds: rubricTargetIdsOf(closure.solution),
      alternatives: [],
      revision: 1,
      // §7.4：备选 Variant 预授权但未激活（standby）；主 Variant active。
      status: index === 0 ? "active" : "standby",
      createdAt,
      updatedAt: createdAt,
    });
    await tx.insert(learningTaskPrivateSolutions).values({
      variantId: variant.variantId,
      workspaceId,
      userId,
      solution: closure.solution,
      privateSolutionHash: closure.privateSolutionHash,
      runPlanHash: closure.runPlanHash,
      createdAt,
    });
    await tx.insert(learningTaskSafetyReports).values({
      taskId: task.taskId,
      variantId: variant.variantId,
      workspaceId,
      userId,
      publicPayloadHash: variant.publicPayloadHash,
      inputSchemaHash: variant.inputSchemaHash,
      privateSolutionHash: closure.privateSolutionHash,
      disclosureProfileHash: variant.disclosureProfileHash,
      qualificationProfileHash: null,
      runPlanHash: closure.runPlanHash,
      injectionScan: closure.safetyReport.injectionScan,
      privateLeakageScan: closure.safetyReport.privateLeakageScan,
      schemaValidation: closure.safetyReport.schemaValidation,
      accessibilityProfile: closure.safetyReport.accessibilityProfile,
      activationDecision: closure.safetyReport.activationDecision,
      reportHash: closure.reportHash,
      createdAt,
    });
    // disclosure profile：同 (workspace, profileHash) 幂等复用（同一目标的
    // 确定性变体重建不得撞 hash 唯一约束——23505 修复）。
    // PERF-A#13：存在性已由循环前一次 IN 查询预载，无需每 variant SELECT。
    if (!existingDisclosureHashes.has(variant.disclosureProfileHash)) {
      await tx.insert(learningTaskDisclosureProfiles).values({
        variantId: variant.variantId,
        workspaceId,
        userId,
        disclosedFieldPaths: closure.disclosure.disclosedFieldPaths,
        hiddenFieldPaths: closure.disclosure.hiddenFieldPaths,
        answerBearingFieldsHidden: true,
        profileHash: variant.disclosureProfileHash,
        createdAt,
      });
    }
  }
  await tx.insert(learningTaskPresentationHistory).values({
    workspaceId,
    userId,
    keyPointId: target.keyPointId,
    intent: task.intent,
    publicPayloadHash: primaryVariant.publicPayloadHash,
    interactionFamily: primaryVariant.interaction.kind,
    presentedAt: createdAt,
    outcome: "not_answered",
    exposed: false,
    // 迁移 0143：runId 关联，结算时回填 outcome/exposed（§7.8）。
    runId,
    createdAt,
  });
  // 幂等行已在事务开头占位（onConflictDoNothing）。
  // 事件流（sequence 1..4，同步推进 eventCursor）——一次多行 INSERT。
  const eventValues = [
    { runId, workspaceId, userId, eventType: "learning_run.created", payload: {} },
    { runId, workspaceId, userId, eventType: "learning_run.prepared", payload: {} },
    { runId, workspaceId, userId, eventType: "learning_run.started", payload: {} },
    { runId, workspaceId, userId, eventType: "learning_task.presented", payload: { taskId: task.taskId } },
  ];
  await tx.insert(learningRunEvents).values(
    eventValues.map((event, index) => ({
      runId: event.runId,
      workspaceId,
      userId,
      sequence: index + 1,
      eventType: event.eventType as never,
      payload: event.payload,
      occurredAt: createdAt,
    })),
  );
  await tx.update(learningRuns)
    .set({ eventCursor: eventValues.length, updatedAt: createdAt })
    .where(eq(learningRuns.id, runId));

  return getRunPublicView(tx, { workspaceId, userId, runId });
}

// ─── createRunV2（§16.2 PREPARE：V2 Origin → freeze snapshot → V2 planner）────

/**
 * V2 run 的 keyPointId 语义：作为 Objective ID alias（§16.3）。DB 列
 * learning_runs.key_point_id 仍是 cardKeyPoints FK（RESTRICT），因此要求该
 * objective 存在相应急剧的 cardKeyPoint 别名行（迁移期 objectiveId 常复用
 * 原 keyPoint UUID）；无别名 → fail closed（未做 V1→V2 alias 迁移）。
 */
async function resolveV2ObjectiveKeyPoint(
  tx: ApiTransaction,
  scope: RunScope,
  objectiveId: string,
): Promise<{ keyPointId: string }> {
  const rows = await tx
    .select({ id: cardKeyPoints.id })
    .from(cardKeyPoints)
    .where(and(
      eq(cardKeyPoints.id, objectiveId),
      eq(cardKeyPoints.workspaceId, scope.workspaceId),
    ))
    .limit(1);
  if (!rows[0]) {
    throw contextStale("该 objective 还没有可用的 keyPointId alias（V2 迁移未完成）");
  }
  return { keyPointId: objectiveId };
}

/**
 * §16.3 V2 schedulingAuthorization：
 * - review：必须存在匹配 objective 的 pending schedule 且 generation OCC；
 * - card：无 pending schedule 时 create_initial，否则 no_effect；
 * - star_map：有 pending 则 consume_pending，否则 create_initial；
 * - today/onboarding：no_effect。
 */
async function resolveV2Scheduling(
  tx: ApiTransaction,
  scope: RunScope,
  origin: LearningRunOriginV2,
  objectiveId: string,
  semanticTargetFingerprint: string,
): Promise<SchedulingAuthorizationV1> {
  const findPending = async () => {
    const rows = await tx
      .select({ id: reviewSchedules.id, generation: reviewSchedules.generation })
      .from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.workspaceId, scope.workspaceId),
        eq(reviewSchedules.userId, scope.userId),
        eq(reviewSchedules.keyPointId, objectiveId),
        eq(reviewSchedules.status, "pending"),
      ))
      .orderBy(desc(reviewSchedules.generation))
      .limit(1);
    return rows[0] ?? null;
  };

  if (origin.kind === "review") {
    const rows = await tx
      .select({
        id: reviewSchedules.id,
        keyPointId: reviewSchedules.keyPointId,
        generation: reviewSchedules.generation,
        status: reviewSchedules.status,
      })
      .from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.id, origin.scheduleId),
        eq(reviewSchedules.workspaceId, scope.workspaceId),
        eq(reviewSchedules.userId, scope.userId),
      ))
      .limit(1);
    const sched = rows[0];
    if (!sched || sched.keyPointId !== objectiveId || sched.generation !== origin.scheduleGeneration) {
      throw scheduleGenerationChanged();
    }
    if (sched.status !== "pending") throw scheduleGenerationChanged();
    return {
      kind: "consume_pending",
      scheduleId: origin.scheduleId,
      scheduleGeneration: origin.scheduleGeneration,
      keyPointId: objectiveId,
      targetFingerprint: semanticTargetFingerprint,
      dueAt: new Date().toISOString(),
      schedulerPolicyId: "review-schedule-v1",
    };
  }
  if (origin.kind === "card" || origin.kind === "star_map") {
    const pending = await findPending();
    if (pending) {
      return {
        kind: "consume_pending",
        scheduleId: pending.id,
        scheduleGeneration: pending.generation,
        keyPointId: objectiveId,
        targetFingerprint: semanticTargetFingerprint,
        dueAt: new Date().toISOString(),
        schedulerPolicyId: "review-schedule-v1",
      };
    }
    return {
      kind: "create_initial",
      keyPointId: objectiveId,
      targetFingerprint: semanticTargetFingerprint,
      schedulerPolicyId: "review-schedule-v1",
    };
  }
  return { kind: "no_effect", reasonCode: "not_authorized" };
}

/**
 * §16.2 createRunV2（PREPARE V2 路径）。
 *
 * 顺序：解析 Origin → workspace-scoped active Objective+Card（fail closed，
 * 经由 freeze）→ 读 cardContentEpoch → freeze LearningTargetSnapshotV2 →
 * 调度授权 → V2 planner（只消费 snapshot）→ 原子写 run/private contract（含
 * V2 target 闭包）/task/variants/events。V2 run 的 contract 冻结 expected
 * objective lifecycle epoch 与 evidence eligibility vector hash。
 */
export async function createRunV2(
  tx: ApiTransaction,
  input: CreateRunV2Input,
  now: () => Date = () => new Date(),
): Promise<{
  runId: string;
  frozen: FrozenTargetSnapshotV2;
  snapshotId: string;
}> {
  const { workspaceId, userId } = input;
  const request = input.request;
  const originV2 = request.originV2;

  // 幂等：同 key 重放返回既有 run（重新加载 frozen snapshot）。
  const requestFingerprint = sha256Hex(JSON.stringify({
    originV2,
    goal: request.goal,
    requestedTimeBudgetSeconds: request.requestedTimeBudgetSeconds ?? null,
    responsePreference: request.responsePreference ?? null,
  }));
  const idemRows = await tx
    .select({ runId: learningRunIdempotency.runId, clientRequestId: learningRunIdempotency.clientRequestId })
    .from(learningRunIdempotency)
    .where(and(
      eq(learningRunIdempotency.workspaceId, workspaceId),
      eq(learningRunIdempotency.userId, userId),
      eq(learningRunIdempotency.idempotencyKey, request.idempotencyKey),
    ))
    .limit(1);
  if (idemRows[0]) {
    if (idemRows[0].clientRequestId !== requestFingerprint) throw idempotencyConflict();
    const runRows = await tx.select().from(learningRuns).where(eq(learningRuns.id, idemRows[0].runId)).limit(1);
    if (!runRows[0]) throw contextStale("幂等 run 不存在");
    const snap = await loadFrozenTargetSnapshotV2(tx, workspaceId, idemRows[0].runId);
    if (!snap) throw contextStale("幂等 V2 run 缺少 frozen snapshot");
    return { runId: idemRows[0].runId, frozen: { snapshot: snap, publicTarget: buildLearningRunTargetPublicV2(snap), objectiveLifecycleEpoch: snap.objectiveLifecycleEpoch, evidenceEligibilityVectorHash: snap.target.evidenceEligibilityVectorHash, cardContentEpoch: snap.cardContentEpoch }, snapshotId: snap.snapshotId };
  }

  const objectiveId = originV2.objectiveId;
  // resolveV2ObjectiveKeyPoint 校验迁移期 stable keyPointId alias（§29.4）
  await resolveV2ObjectiveKeyPoint(tx, { workspaceId, userId }, objectiveId);
  const cardContentEpoch = await prepareCardContentEpoch(tx, workspaceId);
  const runId = crypto.randomUUID();

  // lts_v2_run_fk（0138：snapshot.run_id → learning_runs.id RESTRICT）要求 run 行
  // 先于 snapshot 存在。先插骨架行（phase='preparing'，target_fingerprint 占位，
  // 同事务内对外不可见），freeze/plan 完成后 UPDATE 为最终值（R20 修复）。
  const createdAt0 = now();
  await tx.insert(learningRuns).values({
    id: runId,
    workspaceId,
    userId,
    origin: originV2 as never,
    returnTarget: { kind: originV2.kind === "review" ? "review" : originV2.kind === "card" ? "card" : originV2.kind === "star_map" ? "star_map" : originV2.kind === "today" ? "today" : "onboarding", objectiveId } as never,
    keyPointId: objectiveId,
    targetFingerprint: "",
    goal: request.goal,
    createdAt: createdAt0,
    updatedAt: createdAt0,
  });

  // PREPARE 内部起算：freeze snapshot（读 exact revisions，不读 live claim）。
  const frozen = await freezeTargetSnapshotV2(tx, {
    workspaceId,
    userId,
    runId,
    objectiveId,
    cardContentEpoch,
  });

  const schedulingAuthorization = await resolveV2Scheduling(
    tx,
    { workspaceId, userId },
    originV2,
    objectiveId,
    frozen.snapshot.target.semanticTargetFingerprint,
  );

  const timeBudgetSeconds = clampTimeBudget(request.requestedTimeBudgetSeconds);
  const v2Target: PlannerV2Target = {
    objectiveStatement: frozen.snapshot.target.objectiveStatement,
    publicSummary: frozen.snapshot.target.publicSummary,
    knowledgeForm: frozen.snapshot.target.knowledgeForm,
    preferredIntents: frozen.snapshot.target.preferredIntents,
    canonicalAnswer: frozen.snapshot.target.canonicalAnswer,
    scoringRubric: frozen.snapshot.target.scoringRubric,
    relations: frozen.snapshot.target.relations,
    evidence: frozen.snapshot.target.evidence,
    publishedTargetEligibility: frozen.snapshot.publishedTargetEligibility,
  };
  const [recentPublicPayloadHashes, interactionQualifications] = await Promise.all([
    recentPresentedPayloadHashes(tx, {
      workspaceId,
      userId,
      keyPointId: objectiveId,
    }),
    loadInteractionQualifications(tx),
  ]);
  const plannerOptions: PlannerOptions = {
    runId,
    goal: request.goal,
    responsePreference: request.responsePreference ?? "adaptive",
    timeBudgetSeconds,
    recentPublicPayloadHashes,
    interactionQualifications,
  };
  const plan = planRun(
    {
      keyPointId: objectiveId,
      claim: frozen.snapshot.target.objectiveStatement,
      sourceFingerprint: frozen.snapshot.target.semanticTargetFingerprint,
      evidenceContentHashes: frozen.snapshot.target.evidence.map((e) => e.evidenceSnapshotHash),
      v2: v2Target,
    },
    plannerOptions,
  );

  const runtimeEpoch = 0;
  const contractHash = computeRunContractHash({
    runId,
    workspaceId,
    userId,
    keyPointId: objectiveId,
    targetFingerprint: frozen.snapshot.target.semanticTargetFingerprint,
    runtimeEpoch,
    timeBudgetSeconds,
    planningClosesAtActiveSecond: 150,
    schedulingAuthorization,
    taskPlanHash: plan.runPlanHash,
    projectionBaselineCheckpointToken: null,
    // §16.2 step 8：V2 Run 把 snapshotHash 纳入 private contract hash closure。
    snapshotHash: frozen.snapshot.snapshotHash,
  });

  const task = plan.tasks[0];
  const primaryVariant = plan.primaryVariant;
  const alternativeVariant = plan.alternativeVariant;
  const createdAt = now();

  // 骨架行在 freeze 前已插入（lts_v2_run_fk）；此处 UPDATE 为 plan 后的最终值。
  await tx.update(learningRuns)
    .set({
      targetFingerprint: frozen.snapshot.target.semanticTargetFingerprint,
      timeBudgetSeconds,
      plannedActiveSeconds: plan.plannedActiveSeconds,
      activeTaskId: task.taskId,
      phase: "active",
      sandboxNamespaceId: originV2.kind === "onboarding" && originV2.sampleMode === "sandbox" ? originV2.sandboxNamespaceId ?? null : null,
      updatedAt: createdAt,
    })
    .where(and(
      eq(learningRuns.id, runId),
      eq(learningRuns.workspaceId, workspaceId),
    ));
  await tx.insert(learningRunIdempotency).values({
    workspaceId,
    userId,
    idempotencyKey: request.idempotencyKey,
    clientRequestId: requestFingerprint,
    runId,
    createdAt,
  }).onConflictDoNothing();

  // V2 private contract：冻结 target 闭包 + expected lifecycle epoch + evidence vector。
  await tx.insert(learningRunPrivateContracts).values({
    runId,
    workspaceId,
    userId,
    keyPointId: objectiveId,
    targetFingerprint: frozen.snapshot.target.semanticTargetFingerprint,
    runtimeEpoch,
    timeBudgetSeconds,
    planningClosesAtActiveSecond: 150,
    schedulingAuthorization,
    taskPlanHash: plan.runPlanHash,
    projectionBaselineCheckpointToken: null,
    contractHash,
    snapshotId: frozen.snapshot.snapshotId,
    snapshotHash: frozen.snapshot.snapshotHash,
    semanticTargetFingerprint: frozen.snapshot.target.semanticTargetFingerprint,
    targetRevisionHash: frozen.snapshot.target.targetRevisionHash,
    expectedObjectiveLifecycleEpoch: frozen.objectiveLifecycleEpoch,
    evidenceEligibilityVectorHash: frozen.evidenceEligibilityVectorHash,
    publishedTargetEligibility: frozen.snapshot.publishedTargetEligibility,
    createdAt,
  });
  await tx.insert(learningTasks).values({
    id: task.taskId,
    runId,
    workspaceId,
    userId,
    sequence: task.sequence,
    intent: task.intent,
    prompt: task.prompt,
    targetSummary: task.targetSummary,
    hintLevels: task.hintLevels,
    status: "active",
    revision: 1,
    presentedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  });
  // PERF-A#13：在变体循环前一次性 IN 查询两个 variant 的 disclosure profile
  // 存在性，避免每个 variant 在 PREPARE 热路径各加一次 SELECT 往返。
  const disclosureHashesV2 = Array.from(new Set(
    [primaryVariant, alternativeVariant]
      .map((v) => v.disclosureProfileHash)
      .filter((h): h is string => Boolean(h)),
  ));
  const existingDisclosureHashesV2 = new Set<string>();
  if (disclosureHashesV2.length > 0) {
    const existingDisclosureRowsV2 = await tx
      .select({ profileHash: learningTaskDisclosureProfiles.profileHash })
      .from(learningTaskDisclosureProfiles)
      .where(and(
        eq(learningTaskDisclosureProfiles.workspaceId, workspaceId),
        inArray(learningTaskDisclosureProfiles.profileHash, disclosureHashesV2),
      ));
    for (const r of existingDisclosureRowsV2) existingDisclosureHashesV2.add(r.profileHash);
  }
  for (const [index, variant] of [primaryVariant, alternativeVariant].entries()) {
    const closure = plan.closures[variant.variantId];
    await tx.insert(learningTaskVariants).values({
      id: variant.variantId,
      taskId: task.taskId,
      workspaceId,
      userId,
      purpose: task.purpose,
      templateTrustCeiling: task.templateTrustCeiling,
      estimatedActiveSeconds: task.estimatedActiveSeconds,
      interaction: variant.interaction,
      publicPayloadHash: variant.publicPayloadHash,
      inputSchemaHash: variant.inputSchemaHash,
      disclosureProfileHash: variant.disclosureProfileHash,
      privateSolutionHash: closure.privateSolutionHash,
      safetyReportHash: closure.reportHash,
      rubricTargetIds: rubricTargetIdsOf(closure.solution),
      alternatives: [],
      revision: 1,
      status: index === 0 ? "active" : "standby",
      createdAt,
      updatedAt: createdAt,
    });
    await tx.insert(learningTaskPrivateSolutions).values({
      variantId: variant.variantId,
      workspaceId,
      userId,
      solution: closure.solution,
      privateSolutionHash: closure.privateSolutionHash,
      runPlanHash: closure.runPlanHash,
      createdAt,
    });
    await tx.insert(learningTaskSafetyReports).values({
      taskId: task.taskId,
      variantId: variant.variantId,
      workspaceId,
      userId,
      publicPayloadHash: variant.publicPayloadHash,
      inputSchemaHash: variant.inputSchemaHash,
      privateSolutionHash: closure.privateSolutionHash,
      disclosureProfileHash: variant.disclosureProfileHash,
      qualificationProfileHash: null,
      runPlanHash: closure.runPlanHash,
      injectionScan: closure.safetyReport.injectionScan,
      privateLeakageScan: closure.safetyReport.privateLeakageScan,
      schemaValidation: closure.safetyReport.schemaValidation,
      accessibilityProfile: closure.safetyReport.accessibilityProfile,
      activationDecision: closure.safetyReport.activationDecision,
      reportHash: closure.reportHash,
      createdAt,
    });
    // disclosure profile：同 (workspace, profileHash) 幂等复用（同一目标的
    // 确定性变体重建不得撞 hash 唯一约束——23505 修复）。
    // PERF-A#13：存在性已由循环前一次 IN 查询预载，无需每 variant SELECT。
    if (!existingDisclosureHashesV2.has(variant.disclosureProfileHash)) {
      await tx.insert(learningTaskDisclosureProfiles).values({
        variantId: variant.variantId,
        workspaceId,
        userId,
        disclosedFieldPaths: closure.disclosure.disclosedFieldPaths,
        hiddenFieldPaths: closure.disclosure.hiddenFieldPaths,
        answerBearingFieldsHidden: true,
        profileHash: variant.disclosureProfileHash,
        createdAt,
      });
    }
  }
  await tx.insert(learningTaskPresentationHistory).values({
    workspaceId,
    userId,
    keyPointId: objectiveId,
    intent: task.intent,
    publicPayloadHash: primaryVariant.publicPayloadHash,
    interactionFamily: primaryVariant.interaction.kind,
    presentedAt: createdAt,
    outcome: "not_answered",
    exposed: false,
    // 迁移 0143：runId 关联，结算时回填 outcome/exposed（§7.8）。
    runId,
    createdAt,
  });

  const eventValues = [
    { runId, workspaceId, userId, eventType: "learning_run.created", payload: {} },
    { runId, workspaceId, userId, eventType: "learning_run.prepared", payload: { snapshotId: frozen.snapshot.snapshotId } },
    { runId, workspaceId, userId, eventType: "learning_run.started", payload: {} },
    { runId, workspaceId, userId, eventType: "learning_task.presented", payload: { taskId: task.taskId } },
  ];
  for (const [index, event] of eventValues.entries()) {
    await tx.insert(learningRunEvents).values({
      runId: event.runId,
      workspaceId,
      userId,
      sequence: index + 1,
      eventType: event.eventType as never,
      payload: event.payload,
      occurredAt: createdAt,
    });
  }
  await tx.update(learningRuns)
    .set({ eventCursor: eventValues.length, updatedAt: createdAt })
    .where(eq(learningRuns.id, runId));

  return { runId, frozen, snapshotId: frozen.snapshot.snapshotId };
}

// ─── getRunPublicView ────────────────────────────────────────────────────

export async function getRunPublicView(
  tx: ApiTransaction,
  input: RunScope & { runId: string },
): Promise<LearningRunPublicV1> {
  const runRow = await loadRun(tx, input, input.runId);
  const [taskRows, variantRows, contractRows, assessmentRows] = await Promise.all([
    tx.select().from(learningTasks).where(eq(learningTasks.runId, runRow.id)),
    tx.select().from(learningTaskVariants).where(inArray(
      learningTaskVariants.taskId,
      tx.select({ id: learningTasks.id }).from(learningTasks).where(eq(learningTasks.runId, runRow.id)),
    )),
    tx.select().from(learningRunPrivateContracts).where(eq(learningRunPrivateContracts.runId, runRow.id)).limit(1),
    tx.select().from(learningAssessments).where(eq(learningAssessments.runId, runRow.id)),
  ]);

  const view = buildRunPublicView({
    run: {
      id: runRow.id,
      workspaceId: runRow.workspaceId,
      userId: runRow.userId,
      assistantSessionId: runRow.assistantSessionId,
      origin: runRow.origin as never,
      returnTarget: runRow.returnTarget as never,
      keyPointId: runRow.keyPointId,
      targetFingerprint: runRow.targetFingerprint,
      goal: runRow.goal as never,
      phase: runRow.phase,
      timeBudgetSeconds: runRow.timeBudgetSeconds,
      plannedActiveSeconds: runRow.plannedActiveSeconds,
      activeSecondsUsed: runRow.activeSecondsUsed,
      activeTaskId: runRow.activeTaskId,
      checkpoint: runRow.checkpoint as never,
      failure: runRow.failure as never,
      projectionStatus: runRow.projectionStatus as never,
      projectionBaselineCheckpointToken: runRow.projectionBaselineCheckpointToken,
      revision: runRow.revision,
      runtimeEpoch: runRow.runtimeEpoch,
      eventCursor: runRow.eventCursor,
      result: runRow.result as unknown as LearningRunResultV1 | null,
    },
    tasks: taskRows.map((t) => ({
      id: t.id,
      runId: t.runId,
      sequence: t.sequence,
      intent: t.intent as never,
      prompt: t.prompt,
      targetSummary: t.targetSummary,
      hintLevels: t.hintLevels as never,
      status: t.status,
      revision: t.revision,
      activeVariantId: runRow.activeTaskId === t.id ? activeVariantIdFor(variantRows, t.id) : null,
    })),
    variants: variantRows.map((v) => ({
      id: v.id,
      taskId: v.taskId,
      purpose: v.purpose as never,
      templateTrustCeiling: v.templateTrustCeiling as never,
      estimatedActiveSeconds: v.estimatedActiveSeconds,
      interaction: v.interaction as never,
      publicPayloadHash: v.publicPayloadHash,
      inputSchemaHash: v.inputSchemaHash,
      disclosureProfileHash: v.disclosureProfileHash,
      revision: v.revision,
      status: v.status as never,
      alternativeFamily: null as never,
    })),
    assessment: assessmentRows[0]
      ? {
          id: assessmentRows[0].id,
          runId: assessmentRows[0].runId,
          taskId: assessmentRows[0].taskId,
          artifactId: assessmentRows[0].artifactId,
          source: assessmentRows[0].source as never,
          status: assessmentRows[0].status,
          rubricResults: assessmentRows[0].rubricResults as never,
          trustClass: assessmentRows[0].trustClass as never,
          reportHash: assessmentRows[0].reportHash,
        }
      : null,
    baselineCheckpoint: null,
    schedulingAuthorization: contractRows[0]?.schedulingAuthorization ?? null,
  });
  return view;
}

function activeVariantIdFor(
  variants: Array<{ id: string; taskId: string; status: string }>,
  taskId: string,
): string | null {
  const active = variants.find((v) => v.taskId === taskId && v.status === "active");
  return active?.id ?? null;
}

// ─── applyAction（§13.2 状态机 P2 子集）──────────────────────────────────

export async function applyAction(
  tx: ApiTransaction,
  input: ActionInput,
  now: () => Date = () => new Date(),
): Promise<{ acceptedActionId: string; actionResult: "state_changed" | "hint_revealed" | "variant_switched"; hint?: { hintId: string; level: 1 | 2 | 3; text: string; exposureEventId: string }; previousVariantId?: string; activeVariantId?: string; snapshot: LearningRunPublicV1 }> {
  const run = await loadRun(tx, input, input.runId, true);
  if (run.runtimeEpoch !== input.runtimeEpoch) throw new LearningRunServiceError("epoch_mismatch", "运行纪元不匹配", 409);
  if (run.revision !== input.runRevision) throw staleRunRevision(run.revision, input.runRevision);
  const at = now();
  const requestHash = sha256Hex(JSON.stringify(input.action));

  // 幂等账本
  const ledgerRows = await tx
    .select({
      responseStatus: learningRunActionLedger.responseStatus,
      responseSnapshot: learningRunActionLedger.responseSnapshot,
      acceptedActionId: learningRunActionLedger.acceptedActionId,
      requestHash: learningRunActionLedger.requestHash,
    })
    .from(learningRunActionLedger)
    .where(and(
      eq(learningRunActionLedger.runId, input.runId),
      eq(learningRunActionLedger.idempotencyKey, input.idempotencyKey),
    ))
    .limit(1);
  if (ledgerRows[0]) {
    // 同 key 不同内容 → idempotency_conflict（§13.1），绝不静默返回旧响应。
    if (ledgerRows[0].requestHash !== requestHash) throw idempotencyConflict();
    if (ledgerRows[0].responseStatus === "success" && ledgerRows[0].responseSnapshot) {
      const snap = ledgerRows[0].responseSnapshot as {
        actionResult: string;
        hint?: { hintId: string; level: 1 | 2 | 3; text: string; exposureEventId: string };
        previousVariantId?: string;
        activeVariantId?: string;
        snapshot: LearningRunPublicV1;
      };
      return {
        acceptedActionId: ledgerRows[0].acceptedActionId ?? "",
        actionResult: snap.actionResult as "state_changed",
        hint: snap.hint,
        previousVariantId: snap.previousVariantId,
        activeVariantId: snap.activeVariantId,
        snapshot: snap.snapshot,
      };
    }
    throw new LearningRunServiceError("action_in_progress", "该操作正在处理", 409);
  }

  const writeLedger = (requestHash: string, snapshot: Record<string, unknown>, _actionResult: string, acceptedActionId: string) =>
    tx.insert(learningRunActionLedger).values({
      runId: input.runId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      actionKind: input.action.kind,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      responseStatus: "success",
      responseSnapshot: snapshot,
      acceptedActionId,
      createdAt: at,
      updatedAt: at,
    });

  const acceptedActionId = crypto.randomUUID();

  switch (input.action.kind) {
    case "pause": {
      if (run.phase !== "active") throw invalidPhase(run.phase, "active");
      await tx.update(learningRuns)
        .set({ phase: "paused", revision: run.revision + 1, updatedAt: at })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_run.paused", {}, at, run.eventCursor);
      break;
    }
    case "resume": {
      if (run.phase !== "paused") throw invalidPhase(run.phase, "paused");
      await tx.update(learningRuns)
        .set({ phase: "active", revision: run.revision + 1, updatedAt: at })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_run.resumed", {}, at, run.eventCursor);
      break;
    }
    case "skip_run": {
      if (!["active", "paused", "checkpoint"].includes(run.phase)) throw invalidPhase(run.phase, "active");
      const skippedResult: LearningRunResultV1 = {
        outcome: "skipped",
        demonstratedFacets: [],
        gapFacets: [],
        scheduleImpact: { kind: "none", reasonCode: "skipped" },
        returnTarget: run.returnTarget as LearningRunPublicV1["returnTarget"],
      };
      await tx.update(learningRuns)
        .set({
          phase: "skipped",
          result: skippedResult as never,
          terminalReasonCode: "user_ended",
          revision: run.revision + 1,
          updatedAt: at,
        })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_run.skipped", {}, at, run.eventCursor);
      break;
    }
    case "skip_task": {
      if (run.phase !== "active") throw invalidPhase(run.phase, "active");
      const taskId = input.action.taskId;
      const taskRows = await tx.select().from(learningTasks).where(and(eq(learningTasks.id, taskId), eq(learningTasks.runId, run.id))).limit(1);
      if (!taskRows[0]) throw new LearningRunServiceError("task_not_found", "任务不存在", 404);
      await tx.update(learningTasks).set({ status: "skipped", revision: taskRows[0].revision + 1, updatedAt: at })
        .where(eq(learningTasks.id, taskId));
      // P2 单任务无 followup：skip_task → run skipped（§13.2 无预授权替代时）。
      const skippedResult: LearningRunResultV1 = {
        outcome: "skipped",
        demonstratedFacets: [],
        gapFacets: [],
        scheduleImpact: { kind: "none", reasonCode: "skipped" },
        returnTarget: run.returnTarget as LearningRunPublicV1["returnTarget"],
      };
      await tx.update(learningRuns)
        .set({
          phase: "skipped",
          result: skippedResult as never,
          terminalReasonCode: "user_ended",
          revision: run.revision + 1,
          updatedAt: at,
        })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_task.skipped", { taskId }, at, run.eventCursor);
      await insertRunEvent(tx, input, "learning_run.skipped", {}, at, run.eventCursor);
      break;
    }
    case "end": {
      if (run.phase === "completed") {
        // §13.2.5：Commit 完成后到达的 End 返回 completed snapshot（幂等）。
        break;
      }
      if (run.phase === "assessing" || run.phase === "committing") {
        if (!input.action.abandonLockedEvidence) {
          throw invalidPhase(run.phase, "active");
        }
        // abandon CAS 赢：epoch 前移，迟到 Assessment/Commit 无副作用。
        await tx.update(learningRuns)
          .set({
            phase: "ended",
            terminalReasonCode: "user_ended",
            runtimeEpoch: run.runtimeEpoch + 1,
            revision: run.revision + 1,
            activeTaskId: null,
            updatedAt: at,
          })
          .where(eq(learningRuns.id, run.id));
      } else if (["preparing", "active", "paused"].includes(run.phase)) {
        await tx.update(learningRuns)
          .set({
            phase: "ended",
            terminalReasonCode: "user_ended",
            revision: run.revision + 1,
            activeTaskId: null,
            updatedAt: at,
          })
          .where(eq(learningRuns.id, run.id));
      } else {
        throw invalidPhase(run.phase, "active");
      }
      await insertRunEvent(tx, input, "learning_run.ended", {}, at, run.eventCursor);
      break;
    }
    case "request_hint": {
      if (run.phase !== "active" || !run.activeTaskId) throw invalidPhase(run.phase ?? "none", "active");
      const level = input.action.level;
      const taskRows = await tx.select().from(learningTasks).where(and(eq(learningTasks.id, run.activeTaskId), eq(learningTasks.runId, run.id))).limit(1);
      if (!taskRows[0]) throw new LearningRunServiceError("task_not_found", "任务不存在", 404);
      if (level > taskRows[0].hintLevels) throw new LearningRunServiceError("hint_not_available", "该级别提示不可用", 409);
      // 先写 exposure（事件）再返回提示；重放同 idempotencyKey 不新增 exposure。
      const exposureEventId = crypto.randomUUID();
      await insertRunEvent(tx, input, "learning_task.hint_requested", { taskId: run.activeTaskId, hintLevel: level }, at, run.eventCursor);
      await tx.update(learningRuns).set({ revision: run.revision + 1, updatedAt: at }).where(eq(learningRuns.id, run.id));
      const text = buildDeterministicHint({ intent: taskRows[0].intent as never }, level);
      const snapshot = {
        actionResult: "hint_revealed",
        hint: { hintId: crypto.randomUUID(), level, text, exposureEventId },
        snapshot: await getRunPublicView(tx, { workspaceId: input.workspaceId, userId: input.userId, runId: run.id }),
      };
      await writeLedger(requestHash, snapshot, "hint_revealed", acceptedActionId);
      return {
        acceptedActionId,
        actionResult: "hint_revealed",
        hint: snapshot.hint,
        snapshot: snapshot.snapshot,
      };
    }
    case "switch_variant": {
      if (run.phase !== "active" || !run.activeTaskId) throw invalidPhase(run.phase ?? "none", "active");
      const targetVariantId = input.action.alternativeId;
      // F16·②（round-4）：variants 读取加 FOR UPDATE —— 锁定目标与当前 active
      // 行，防止并发 submitArtifact 在 run 锁释放窗口对已被取代的旧 variant 命中
      // status='active' 检查（stale-submit 竞态）。write 段随后在自事务内提交。
      const variantRows = await tx
        .select()
        .from(learningTaskVariants)
        .where(and(eq(learningTaskVariants.id, targetVariantId), eq(learningTaskVariants.taskId, run.activeTaskId)))
        .limit(1)
        .for("update");
      if (!variantRows[0] || variantRows[0].status !== "standby") throw variantNotAuthorized();
      const currentRows = await tx
        .select()
        .from(learningTaskVariants)
        .where(and(eq(learningTaskVariants.taskId, run.activeTaskId), eq(learningTaskVariants.status, "active")))
        .for("update");
      for (const v of currentRows) {
        // 旧 active → superseded（§7.4：旧 revision 随即不可提交）。
        await tx.update(learningTaskVariants).set({ status: "superseded", updatedAt: at }).where(eq(learningTaskVariants.id, v.id));
      }
      await tx.update(learningTaskVariants).set({ status: "active", updatedAt: at }).where(eq(learningTaskVariants.id, targetVariantId));
      await tx.update(learningRuns).set({ revision: run.revision + 1, updatedAt: at }).where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_task.variant_switched", {
        taskId: run.activeTaskId,
        previousVariantId: currentRows.find((v) => v.id !== targetVariantId)?.id ?? null,
        activeVariantId: targetVariantId,
      }, at, run.eventCursor);
      const snapshot = await getRunPublicView(tx, { workspaceId: input.workspaceId, userId: input.userId, runId: run.id });
      const snap = {
        actionResult: "variant_switched",
        previousVariantId: currentRows.find((v) => v.id !== targetVariantId)?.id ?? "",
        activeVariantId: targetVariantId,
        snapshot,
      };
      await writeLedger(requestHash, snap, "variant_switched", acceptedActionId);
      return {
        acceptedActionId,
        actionResult: "variant_switched",
        previousVariantId: snap.previousVariantId,
        activeVariantId: snap.activeVariantId,
        snapshot,
      };
    }
    case "finish_without_commit": {
      // §13.1：只对 not_assessable checkpoint 有效，生成 0 学习副作用的结果并 completed。
      const checkpoint = run.checkpoint as { kind?: string } | null;
      if (run.phase !== "checkpoint" || checkpoint?.kind !== "not_assessable") {
        throw invalidPhase(run.phase ?? "none", "checkpoint(not_assessable)");
      }
      const result: LearningRunResultV1 = {
        outcome: "not_assessable",
        demonstratedFacets: [],
        gapFacets: [],
        scheduleImpact: { kind: "none", reasonCode: "not_assessable" },
        returnTarget: run.returnTarget as LearningRunPublicV1["returnTarget"],
      };
      await tx.update(learningRuns)
        .set({
          phase: "completed",
          checkpoint: null,
          result: result as never,
          revision: run.revision + 1,
          updatedAt: at,
        })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_run.completed", {}, at, run.eventCursor);
      break;
    }
    case "finish_current_evidence": {
      // §13.2：只对 checkpoint(partial) 有效——按已有可信证据进入 Commit
      // （facet_evidence：只写允许的 facet，UI 明示"已证明一部分"）。
      const checkpointKind = (run.checkpoint as { kind?: string } | null)?.kind;
      if (run.phase !== "checkpoint" || checkpointKind !== "partial") {
        throw invalidPhase(run.phase ?? "none", "checkpoint(partial)");
      }
      const assessmentRows = await tx
        .select({
          id: learningAssessments.id,
          taskId: learningAssessments.taskId,
          artifactId: learningAssessments.artifactId,
        })
        .from(learningAssessments)
        .where(and(
          eq(learningAssessments.runId, run.id),
          eq(learningAssessments.status, "completed"),
        ))
        .limit(1);
      const assessment = assessmentRows[0];
      if (!assessment) {
        throw new LearningRunServiceError("assessment_not_found", "评估尚未完成，无法结算", 409);
      }
      await tx.update(learningRuns)
        .set({ phase: "committing", revision: run.revision + 1, updatedAt: at })
        .where(eq(learningRuns.id, run.id));
      await tx.insert(learningRunProcessingOutbox).values({
        runId: run.id,
        taskId: assessment.taskId,
        artifactId: assessment.artifactId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        commandType: "commit_requested",
        payload: { assessmentId: assessment.id, disposition: "facet_evidence" },
        idempotencyKey: `commit:facet:${assessment.id}`,
        availableAt: at,
        createdAt: at,
        updatedAt: at,
      });
      // 与 demonstrated/unable 路径一致：Commit 完成才写 learning_commit.completed
      // 事件（learning_run_events 枚举无 commit_started）。
      break;
    }
    case "activate_followup": {
      // §6.2/§13.2：checkpoint 且 followup 已预授权（allowedFollowupIds）时
      // 激活补充证据 Task（V1 practice 微修补；激活时即时规划并持久化）。
      const checkpoint = run.checkpoint as { kind?: string; allowedFollowupIds?: string[] } | null;
      const followupId = String((input.action as { followupId?: string }).followupId ?? "");
      if (!checkpoint || !Array.isArray(checkpoint.allowedFollowupIds) || !checkpoint.allowedFollowupIds.includes(followupId)) {
        throw new LearningRunServiceError("followup_not_authorized", "该补充任务未获授权", 409);
      }
      const at = now();
      const { taskId } = await planFollowupTask(tx, {
        workspaceId: input.workspaceId,
        userId: input.userId,
      }, run, at);
      await tx.update(learningRuns)
        .set({
          phase: "active",
          activeTaskId: taskId,
          checkpoint: null,
          failure: null,
          revision: run.revision + 1,
          updatedAt: at,
        })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_task.presented", { taskId }, at, run.eventCursor);
      break;
    }
    case "retry_prepare": {
      // §13.2：recoverable_error(stage=prepare) → 重新 PREPARE（重跑规划并
      // 重写 planning 产物；角度轮换会避开已呈现题面）。
      const failure = run.failure as { stage?: string } | null;
      if (run.phase !== "recoverable_error" || failure?.stage !== "prepare") {
        throw invalidPhase(run.phase ?? "none", "recoverable_error(stage=prepare)");
      }
      const at = now();
      const target = await resolveOriginTarget(tx, { workspaceId: input.workspaceId, userId: input.userId }, run.origin as never);
      const timeBudgetSeconds = clampTimeBudget(run.timeBudgetSeconds);
      const recentPublicPayloadHashes = await recentPresentedPayloadHashes(tx, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        keyPointId: target.keyPointId,
      });
      const plan = planRun(
        {
          keyPointId: target.keyPointId,
          claim: target.claim,
          sourceFingerprint: target.fingerprint,
          evidenceContentHashes: target.evidenceContentHashes,
          quote: target.quote,
        },
        {
          runId: run.id,
          goal: run.goal as PlannerOptions["goal"],
          responsePreference: (run.origin as { responsePreference?: string }).responsePreference as PlannerOptions["responsePreference"] ?? "adaptive",
          timeBudgetSeconds,
          recentPublicPayloadHashes,
        },
      );
      // 重写 planning 产物：旧 tasks 级联清除（prepare 失败时无 assessment）。
      await tx.delete(learningTasks).where(eq(learningTasks.runId, run.id));
      const task = plan.tasks[0];
      await tx.insert(learningTasks).values({
        id: task.taskId,
        runId: run.id,
        workspaceId: input.workspaceId,
        userId: input.userId,
        sequence: task.sequence,
        intent: task.intent,
        prompt: task.prompt,
        targetSummary: task.targetSummary,
        hintLevels: task.hintLevels,
        status: "active",
        revision: 1,
        presentedAt: at,
        createdAt: at,
        updatedAt: at,
      });
      for (const [index, variant] of [plan.primaryVariant, plan.alternativeVariant].entries()) {
        const closure = plan.closures[variant.variantId];
        await tx.insert(learningTaskVariants).values({
          id: variant.variantId,
          taskId: task.taskId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          purpose: task.purpose,
          templateTrustCeiling: task.templateTrustCeiling,
          estimatedActiveSeconds: task.estimatedActiveSeconds,
          interaction: variant.interaction,
          publicPayloadHash: variant.publicPayloadHash,
          inputSchemaHash: variant.inputSchemaHash,
          disclosureProfileHash: variant.disclosureProfileHash,
          privateSolutionHash: closure.privateSolutionHash,
          safetyReportHash: closure.reportHash,
          rubricTargetIds: rubricTargetIdsOf(closure.solution),
          alternatives: [],
          revision: 1,
          status: index === 0 ? "active" : "standby",
          createdAt: at,
          updatedAt: at,
        });
        await tx.insert(learningTaskPrivateSolutions).values({
          variantId: variant.variantId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          solution: closure.solution,
          privateSolutionHash: closure.privateSolutionHash,
          runPlanHash: closure.runPlanHash,
          createdAt: at,
        });
        await tx.insert(learningTaskSafetyReports).values({
          taskId: task.taskId,
          variantId: variant.variantId,
          workspaceId: input.workspaceId,
          userId: input.userId,
          publicPayloadHash: variant.publicPayloadHash,
          inputSchemaHash: variant.inputSchemaHash,
          privateSolutionHash: closure.privateSolutionHash,
          disclosureProfileHash: variant.disclosureProfileHash,
          qualificationProfileHash: null,
          runPlanHash: closure.runPlanHash,
          injectionScan: closure.safetyReport.injectionScan,
          privateLeakageScan: closure.safetyReport.privateLeakageScan,
          schemaValidation: closure.safetyReport.schemaValidation,
          accessibilityProfile: closure.safetyReport.accessibilityProfile,
          activationDecision: closure.safetyReport.activationDecision,
          reportHash: closure.reportHash,
          createdAt: at,
        });
        // disclosure profile 按 hash 去重（与 createRun 一致）。
        const existingDisclosure = await tx
          .select({ id: learningTaskDisclosureProfiles.id })
          .from(learningTaskDisclosureProfiles)
          .where(and(
            eq(learningTaskDisclosureProfiles.workspaceId, input.workspaceId),
            eq(learningTaskDisclosureProfiles.profileHash, variant.disclosureProfileHash),
          ))
          .limit(1);
        if (!existingDisclosure[0]) {
          await tx.insert(learningTaskDisclosureProfiles).values({
            variantId: variant.variantId,
            workspaceId: input.workspaceId,
            userId: input.userId,
            disclosedFieldPaths: closure.disclosure.disclosedFieldPaths,
            hiddenFieldPaths: closure.disclosure.hiddenFieldPaths,
            answerBearingFieldsHidden: true,
            profileHash: variant.disclosureProfileHash,
            createdAt: at,
          });
        }
      }
      await tx.update(learningRuns)
        .set({
          phase: "active",
          activeTaskId: task.taskId,
          plannedActiveSeconds: plan.plannedActiveSeconds,
          failure: null,
          revision: run.revision + 1,
          updatedAt: at,
        })
        .where(eq(learningRuns.id, run.id));
      await insertRunEvent(tx, input, "learning_run.started", {}, at, run.eventCursor);
      break;
    }
    case "retry_assessment": {
      // §13.2：recoverable_error(stage=assessment) → 重新排队评估。
      const failure = run.failure as { stage?: string } | null;
      if (run.phase !== "recoverable_error" || failure?.stage !== "assessment") {
        throw invalidPhase(run.phase ?? "none", "recoverable_error(stage=assessment)");
      }
      const at = now();
      const assessmentRows = await tx
        .select({ id: learningAssessments.id, taskId: learningAssessments.taskId, artifactId: learningAssessments.artifactId })
        .from(learningAssessments)
        .where(and(
          eq(learningAssessments.runId, run.id),
          eq(learningAssessments.status, "failed"),
        ))
        .orderBy(desc(learningAssessments.createdAt))
        .limit(1);
      const assessment = assessmentRows[0] ?? null;
      if (!assessment) {
        throw new LearningRunServiceError("assessment_not_found", "没有可重试的评估", 409);
      }
      await tx.update(learningAssessments)
        .set({ status: "queued", updatedAt: at })
        .where(eq(learningAssessments.id, assessment.id));
      await tx.update(learningRuns)
        .set({ phase: "assessing", failure: null, revision: run.revision + 1, updatedAt: at })
        .where(eq(learningRuns.id, run.id));
      await tx.insert(learningRunProcessingOutbox).values({
        runId: run.id,
        taskId: assessment.taskId,
        artifactId: assessment.artifactId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        commandType: "assessment_requested",
        payload: { assessmentId: assessment.id },
        idempotencyKey: `assessment:retry:${assessment.id}`,
        availableAt: at,
        createdAt: at,
        updatedAt: at,
      });
      await insertRunEvent(tx, input, "learning_assessment.queued", { assessmentId: assessment.id }, at, run.eventCursor);
      break;
    }
    case "retry_commit": {
      // §13.2：recoverable_error(stage=commit) → 重新入队 Commit。
      const failure = run.failure as { stage?: string } | null;
      if (run.phase !== "recoverable_error" || failure?.stage !== "commit") {
        throw invalidPhase(run.phase ?? "none", "recoverable_error(stage=commit)");
      }
      const at = now();
      const assessmentRows = await tx
        .select({ id: learningAssessments.id, taskId: learningAssessments.taskId, artifactId: learningAssessments.artifactId, trustClass: learningAssessments.trustClass })
        .from(learningAssessments)
        .where(and(
          eq(learningAssessments.runId, run.id),
          eq(learningAssessments.status, "completed"),
        ))
        .orderBy(desc(learningAssessments.createdAt))
        .limit(1);
      const assessment = assessmentRows[0];
      if (!assessment) {
        throw new LearningRunServiceError("assessment_not_found", "没有可重试的 Commit", 409);
      }
      // disposition 从 completed assessment 的 trustClass 确定性推导
      // （mastery_eligible → mastery_evidence；其余可信 → facet_evidence）。
      const disposition = assessment.trustClass === "mastery_eligible" ? "mastery_evidence" : "facet_evidence";
      await tx.update(learningRuns)
        .set({ phase: "committing", failure: null, revision: run.revision + 1, updatedAt: at })
        .where(eq(learningRuns.id, run.id));
      await tx.insert(learningRunProcessingOutbox).values({
        runId: run.id,
        taskId: assessment.taskId,
        artifactId: assessment.artifactId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        commandType: "commit_requested",
        payload: { assessmentId: assessment.id, disposition },
        idempotencyKey: `commit:retry:${assessment.id}`,
        availableAt: at,
        createdAt: at,
        updatedAt: at,
      });
      await insertRunEvent(tx, input, "learning_commit.failed", { retry: true }, at, run.eventCursor);
      break;
    }
    default: {
      throw new LearningRunServiceError("action_not_supported", "该操作将在后续阶段开放", 409);
    }
  }

  const snapshot = await getRunPublicView(tx, { workspaceId: input.workspaceId, userId: input.userId, runId: run.id });
  await writeLedger(requestHash, { actionResult: "state_changed", snapshot }, "state_changed", acceptedActionId);
  return { acceptedActionId, actionResult: "state_changed", snapshot };
}

async function insertRunEvent(
  tx: ApiTransaction,
  input: ActionInput,
  eventType: string,
  payload: Record<string, unknown>,
  at: Date,
  _hintCursor: number,
): Promise<void> {
  // 事务内重读最新 cursor（调用方传入的内存快照可能已过期——同一动作
  // 连续写多条事件时必须递增，否则撞 UNIQUE(run_id, sequence)）。
  const rows = await tx
    .select({ eventCursor: learningRuns.eventCursor })
    .from(learningRuns)
    .where(eq(learningRuns.id, input.runId))
    .limit(1);
  const sequence = (rows[0]?.eventCursor ?? 0) + 1;
  await tx.insert(learningRunEvents).values({
    runId: input.runId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    sequence,
    eventType: eventType as never,
    payload: payload as never,
    occurredAt: at,
  });
  await tx.update(learningRuns)
    .set({ eventCursor: sequence, updatedAt: at })
    .where(eq(learningRuns.id, input.runId));
}

// ─── draft（§12.7 CAS）───────────────────────────────────────────────────

export async function putDraft(
  tx: ApiTransaction,
  input: DraftInput,
  now: () => Date = () => new Date(),
): Promise<unknown> {
  const run = await loadRun(tx, input, input.runId);
  if (!["active", "paused"].includes(run.phase)) throw invalidPhase(run.phase, "active");
  if (run.activeTaskId !== input.taskId) throw new LearningRunServiceError("task_not_active", "该任务不是当前任务", 409);

  const taskRows = await tx.select().from(learningTasks).where(and(eq(learningTasks.id, input.taskId), eq(learningTasks.runId, run.id))).limit(1);
  if (!taskRows[0]) throw new LearningRunServiceError("task_not_found", "任务不存在", 404);
  if (taskRows[0].revision !== input.taskRevision) throw staleTaskRevision(taskRows[0].revision, input.taskRevision);
  const variantRows = await tx.select().from(learningTaskVariants)
    .where(and(eq(learningTaskVariants.id, input.variantId), eq(learningTaskVariants.taskId, input.taskId), eq(learningTaskVariants.status, "active")))
    .limit(1);
  if (!variantRows[0]) throw variantNotAuthorized();
  if (variantRows[0].revision !== input.variantRevision) throw variantNotAuthorized();

  const at = now();
  // §12.7 CAS：draft 行锁（FOR UPDATE）防并发丢更新。
  const existing = await tx
    .select()
    .from(learningTaskDrafts)
    .where(eq(learningTaskDrafts.taskId, input.taskId))
    .limit(1)
    .for("update")
    .execute();
  const current = existing[0];
  if (input.expectedDraftRevision !== null && current?.draftRevision !== input.expectedDraftRevision) {
    throw new LearningRunServiceError("stale_draft_revision", "草稿已变化，请重新保存", 409, {
      currentDraftRevision: current?.draftRevision ?? null,
    });
  }
  const draftRevision = (current?.draftRevision ?? 0) + 1;
  const expiresAt = new Date(at.getTime() + 24 * 60 * 60 * 1000);
  // §12.7：静态加密落库——payload 与 rendererState 一起加密（rendererState
  // 可能含光标/选中位置，不得明文）；无密钥 fail closed（绝不落明文）。
  const encrypted = encryptDraftPayload({
    payload: input.payload,
    rendererState: input.rendererState,
  });
  if (!isDraftEncryptionAvailable() || encrypted === null) {
    throw new LearningRunServiceError("draft_encryption_unavailable", "草稿保存暂不可用", 409);
  }
  if (current) {
    await tx.update(learningTaskDrafts).set({
      variantId: input.variantId,
      taskRevision: input.taskRevision,
      draftRevision,
      payload: encrypted as never,
      rendererState: {} as never,
      savedAt: at,
      expiresAt,
      updatedAt: at,
    }).where(eq(learningTaskDrafts.taskId, input.taskId));
  } else {
    await tx.insert(learningTaskDrafts).values({
      runId: run.id,
      taskId: input.taskId,
      variantId: input.variantId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      taskRevision: input.taskRevision,
      draftRevision,
      payload: encrypted as never,
      rendererState: {} as never,
      savedAt: at,
      expiresAt,
      createdAt: at,
      updatedAt: at,
    });
  }
  return {
    version: 1,
    runId: run.id,
    taskId: input.taskId,
    variantId: input.variantId,
    taskRevision: input.taskRevision,
    draftRevision,
    savedAt: at.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function deleteDraft(
  tx: ApiTransaction,
  input: RunScope & { runId: string; taskId: string },
): Promise<void> {
  const run = await loadRun(tx, input, input.runId);
  void run;
  await tx.delete(learningTaskDrafts).where(and(
    eq(learningTaskDrafts.taskId, input.taskId),
    eq(learningTaskDrafts.workspaceId, input.workspaceId),
    eq(learningTaskDrafts.userId, input.userId),
  ));
}

/** 读取当前草稿（跨设备恢复；解密失败返回 payload=null，绝不伪造）。 */
export async function getDraft(
  tx: ApiTransaction,
  input: RunScope & { runId: string; taskId: string },
): Promise<unknown | null> {
  const run = await loadRun(tx, input, input.runId);
  void run;
  const rows = await tx
    .select()
    .from(learningTaskDrafts)
    .where(and(
      eq(learningTaskDrafts.taskId, input.taskId),
      eq(learningTaskDrafts.workspaceId, input.workspaceId),
      eq(learningTaskDrafts.userId, input.userId),
    ))
    .limit(1);
  const draft = rows[0];
  if (!draft) return null;
  if (!isDraftEncryptionAvailable()) {
    throw new LearningRunServiceError("draft_encryption_unavailable", "草稿恢复暂不可用", 409);
  }
  const decrypted = decryptDraftPayload(draft.payload) as {
    payload: unknown;
    rendererState: unknown;
  } | null;
  if (decrypted === null) {
    // 密文损坏：fail closed（返回空 payload，绝不伪造）。
    return {
      version: 1,
      runId: draft.runId,
      taskId: draft.taskId,
      variantId: draft.variantId,
      taskRevision: draft.taskRevision,
      draftRevision: draft.draftRevision,
      payload: null,
      rendererState: {},
      savedAt: draft.savedAt.toISOString(),
      expiresAt: draft.expiresAt.toISOString(),
    };
  }
  return {
    version: 1,
    runId: draft.runId,
    taskId: draft.taskId,
    variantId: draft.variantId,
    taskRevision: draft.taskRevision,
    draftRevision: draft.draftRevision,
    payload: decrypted.payload,
    rendererState: decrypted.rendererState,
    savedAt: draft.savedAt.toISOString(),
    expiresAt: draft.expiresAt.toISOString(),
  };
}

// ─── submitArtifact（§12.3 原子提交）─────────────────────────────────────

/**
 * §16.2/§16.7：V2 Artifact lock 的 epoch 复验。
 * - V1 run（private contract 无 snapshotHash）→ 无操作；
 * - V2 run：FOR UPDATE 锁定全部 evidence eligibility 行（稳定 id 顺序），
 *   复验 expectedObjectiveLifecycleEpoch 与每个 expectedEvidenceEligibilityEpoch；
 *   任何 restricted/revoked 或 epoch 漂移 → fail closed。
 */
async function revalidateV2ArtifactEpochs(
  tx: ApiTransaction,
  runId: string,
): Promise<void> {
  const contractRows = await tx
    .select({
      workspaceId: learningRunPrivateContracts.workspaceId,
      snapshotHash: learningRunPrivateContracts.snapshotHash,
      expectedObjectiveLifecycleEpoch: learningRunPrivateContracts.expectedObjectiveLifecycleEpoch,
    })
    .from(learningRunPrivateContracts)
    .where(eq(learningRunPrivateContracts.runId, runId))
    .limit(1);
  const contract = contractRows[0];
  if (!contract?.snapshotHash) return; // V1 run：无 V2 闭包复验。

  const snapshot = await loadFrozenTargetSnapshotV2(tx, contract.workspaceId, runId);
  if (!snapshot) throw new LearningRunServiceError("v2_snapshot_missing", "V2 run 缺少 frozen snapshot", 409);

  // 1. 复验 objective lifecycle：仍 active 且 epoch 未漂移。
  const objRows = await tx
    .select({ lifecycle: learningObjectivesV2.lifecycle, lifecycleEpoch: learningObjectivesV2.lifecycleEpoch })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, snapshot.workspaceId),
      eq(learningObjectivesV2.objectiveId, snapshot.target.objectiveId),
    ))
    .limit(1);
  const obj = objRows[0];
  if (!obj || obj.lifecycle !== "active") {
    throw new LearningRunServiceError("v2_artifact_objective_stale", "objective 生命周期已变更", 409);
  }
  if (contract.expectedObjectiveLifecycleEpoch !== null
      && obj.lifecycleEpoch !== contract.expectedObjectiveLifecycleEpoch) {
    throw new LearningRunServiceError("v2_artifact_objective_epoch_drift", "objective lifecycle epoch 漂移", 409);
  }

  // 2. 按稳定 evidence id 顺序锁定 eligibility 行并逐一复验（usable + epoch 匹配）。
  const evidence = [...snapshot.target.evidence].sort((a, b) => a.evidenceSnapshotId.localeCompare(b.evidenceSnapshotId));
  if (evidence.length === 0) return;
  // 批量锁定全部 evidence 行（一次 round-trip），按 evidenceSnapshotId 稳定排序
  // 保持锁顺序一致，避免逐条 SELECT ... FOR UPDATE 的 N 次往返与锁持有时间延长。
  const evidenceIds = evidence.map((e) => e.evidenceSnapshotId);
  const evRows = await tx
    .select({
      evidenceSnapshotId: evidenceEligibilityStatesV2.evidenceSnapshotId,
      status: evidenceEligibilityStatesV2.status,
      eligibilityEpoch: evidenceEligibilityStatesV2.eligibilityEpoch,
    })
    .from(evidenceEligibilityStatesV2)
    .where(and(
      eq(evidenceEligibilityStatesV2.workspaceId, snapshot.workspaceId),
      inArray(evidenceEligibilityStatesV2.evidenceSnapshotId, evidenceIds),
    ))
    .for("update")
    .orderBy(evidenceEligibilityStatesV2.evidenceSnapshotId);
  const byEvidenceId = new Map(evRows.map((r) => [r.evidenceSnapshotId, r]));
  for (const e of evidence) {
    const row = byEvidenceId.get(e.evidenceSnapshotId);
    if (!row || row.status !== "usable") {
      throw new LearningRunServiceError("v2_artifact_evidence_not_usable",
        `evidence ${e.evidenceSnapshotId} 状态 ${row?.status ?? "missing"}`, 409);
    }
    if (row.eligibilityEpoch !== e.expectedEvidenceEligibilityEpoch) {
      throw new LearningRunServiceError("v2_artifact_evidence_epoch_drift",
        `evidence ${e.evidenceSnapshotId} epoch 漂移`, 409);
    }
  }
}

export async function submitArtifact(
  tx: ApiTransaction,
  input: SubmitInput,
  now: () => Date = () => new Date(),
): Promise<unknown> {
  const run = await loadRun(tx, input, input.runId, true);

  // 幂等：同 idempotencyKey 重放返回原 receipt（不重复锁定）；同 key 不同
  // 内容 → idempotency_conflict。必须先于 phase/revision 校验——提交成功后
  // run 已进入 assessing，重放必须仍然安全返回原回执。
  const submissionRequestHash = sha256Hex(JSON.stringify({
    variantId: input.request.variantId,
    variantRevision: input.request.variantRevision,
    taskRevision: input.request.taskRevision,
    inputSchemaHash: input.request.inputSchemaHash,
    payload: input.request.payload,
  }));
  const ledgerRows = await tx
    .select({
      responseSnapshot: learningRunActionLedger.responseSnapshot,
      responseStatus: learningRunActionLedger.responseStatus,
      requestHash: learningRunActionLedger.requestHash,
    })
    .from(learningRunActionLedger)
    .where(and(
      eq(learningRunActionLedger.runId, run.id),
      eq(learningRunActionLedger.idempotencyKey, input.request.idempotencyKey),
    ))
    .limit(1);
  if (ledgerRows[0]) {
    if (ledgerRows[0].requestHash !== submissionRequestHash) throw idempotencyConflict();
    if (ledgerRows[0].responseStatus === "success" && ledgerRows[0].responseSnapshot) {
      return ledgerRows[0].responseSnapshot;
    }
    throw new LearningRunServiceError("submission_in_progress", "提交正在处理", 409);
  }

  if (run.phase !== "active") throw invalidPhase(run.phase, "active");
  if (run.revision !== input.request.runRevision) throw staleRunRevision(run.revision, input.request.runRevision);
  if (run.activeTaskId !== input.taskId) throw new LearningRunServiceError("task_not_active", "该任务不是当前任务", 409);

  const taskRows = await tx.select().from(learningTasks).where(and(eq(learningTasks.id, input.taskId), eq(learningTasks.runId, run.id))).limit(1);
  if (!taskRows[0]) throw new LearningRunServiceError("task_not_found", "任务不存在", 404);
  const task = taskRows[0];
  if (task.revision !== input.request.taskRevision) throw staleTaskRevision(task.revision, input.request.taskRevision);

  const variantRows = await tx.select().from(learningTaskVariants)
    .where(and(eq(learningTaskVariants.id, input.request.variantId), eq(learningTaskVariants.taskId, input.taskId), eq(learningTaskVariants.status, "active")))
    .limit(1);
  if (!variantRows[0]) throw variantNotAuthorized();
  const variant = variantRows[0];
  if (variant.revision !== input.request.variantRevision) throw variantNotAuthorized();
  if (variant.inputSchemaHash !== input.request.inputSchemaHash) throw variantNotAuthorized();

  // payload ↔ interaction 匹配（§12.3：结构化答案不得冒充文本；text/voice 只允许开放回答；
  // P4 结构 payload 做 allowlist 校验：ID 集合必须属于当前 Variant）。
  const payload = input.request.payload;
  const interaction = variant.interaction as {
    kind: string;
    publicTokenIds?: string[];
    publicNodeIds?: string[];
    allowedEdgeKinds?: string[];
    publicElementIds?: string[];
    allowedOperationKinds?: string[];
    replacementOptionIds?: string[];
  };
  if (interaction.kind === "text_response" && payload.kind !== "text" && payload.kind !== "declared_unable") {
    throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
  }
  if (interaction.kind === "voice_teachback" && payload.kind !== "voice" && payload.kind !== "declared_unable") {
    throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
  }
  if (interaction.kind === "ordering") {
    if (payload.kind !== "ordering") throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
    const allowed = new Set(interaction.publicTokenIds ?? []);
    const ordered = payload.orderedTokenIds;
    if (ordered.length !== allowed.size || ordered.some((id) => !allowed.has(id)) || new Set(ordered).size !== ordered.length) {
      throw new LearningRunServiceError("payload_variant_mismatch", "排序内容与题目不符", 400);
    }
  }
  if (interaction.kind === "relation_canvas") {
    if (payload.kind !== "relation") throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
    const nodes = new Set(interaction.publicNodeIds ?? []);
    const edgeKinds = new Set(interaction.allowedEdgeKinds ?? []);
    if (payload.edges.length > 16) {
      throw new LearningRunServiceError("payload_variant_mismatch", "关系数量超出题目允许范围", 400);
    }
    for (const edge of payload.edges) {
      if (!nodes.has(edge.fromNodeId) || !nodes.has(edge.toNodeId) || !edgeKinds.has(edge.edgeKind)) {
        throw new LearningRunServiceError("payload_variant_mismatch", "关系内容与题目不符", 400);
      }
    }
  }
  if (interaction.kind === "repair") {
    if (payload.kind !== "repair") throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
    const elements = new Set(interaction.publicElementIds ?? []);
    const ops = new Set(interaction.allowedOperationKinds ?? []);
    const options = new Set(interaction.replacementOptionIds ?? []);
    if (payload.operations.length > 16) {
      throw new LearningRunServiceError("payload_variant_mismatch", "修复操作数量超出题目允许范围", 400);
    }
    for (const operation of payload.operations) {
      if (!ops.has(operation.op)) {
        throw new LearningRunServiceError("payload_variant_mismatch", "修复操作与题目不符", 400);
      }
      const elementKey = operation.op === "insert"
        ? (operation as { afterElementId?: string | null }).afterElementId ?? null
        : (operation as { elementId?: string }).elementId ?? null;
      if (elementKey !== null && !elements.has(elementKey)) {
        throw new LearningRunServiceError("payload_variant_mismatch", "修复操作与题目不符", 400);
      }
      const optionKey = (operation as { replacementOptionId?: string }).replacementOptionId;
      if (optionKey !== undefined && !options.has(optionKey)) {
        throw new LearningRunServiceError("payload_variant_mismatch", "修复选项与题目不符", 400);
      }
      // replace/insert 必须携带选项（remove/move 不允许携带）。
      if ((operation.op === "replace" || operation.op === "insert") && optionKey === undefined) {
        throw new LearningRunServiceError("payload_variant_mismatch", "修复操作缺少选项", 400);
      }
    }
  }

  // §5.3/§12.3 structured_bundle：一次原子提交两个 part（partAnswers 逐项
  // allowlist 校验——partId/ID 集合必须属于当前 Variant；缺 part 或伪造 ID
  // fail closed）。
  if (interaction.kind === "structured_bundle") {
    const bundle = interaction as unknown as {
      parts: Array<{
        partId: string;
        interaction: {
          kind: "ordering" | "relation_canvas" | "repair";
          publicTokenIds?: string[];
          publicNodeIds?: string[];
          allowedEdgeKinds?: string[];
          publicElementIds?: string[];
          allowedOperationKinds?: string[];
          replacementOptionIds?: string[];
        };
      }>;
    };
    if (payload.kind !== "structured_bundle") {
      throw new LearningRunServiceError("payload_variant_mismatch", "作答类型与题目不符", 400);
    }
    const partAnswers = payload.partAnswers;
    if (!Array.isArray(partAnswers) || partAnswers.length !== bundle.parts.length) {
      throw new LearningRunServiceError("payload_variant_mismatch", "组合作答的 part 数量与题目不符", 400);
    }
    for (let index = 0; index < partAnswers.length; index += 1) {
      const part = bundle.parts[index];
      const answer = partAnswers[index] as { kind?: string; partId?: string } & Record<string, unknown>;
      if (answer.partId !== part.partId) {
        throw new LearningRunServiceError("payload_variant_mismatch", "part 引用与题目不符", 400);
      }
      const partInteraction = part.interaction;
      if (partInteraction.kind === "ordering") {
        if (answer.kind !== "ordering") throw new LearningRunServiceError("payload_variant_mismatch", "part 作答类型与题目不符", 400);
        const allowed = new Set(partInteraction.publicTokenIds ?? []);
        const ordered = (answer.orderedTokenIds ?? []) as string[];
        if (ordered.length !== allowed.size || ordered.some((id) => !allowed.has(id)) || new Set(ordered).size !== ordered.length) {
          throw new LearningRunServiceError("payload_variant_mismatch", "排序内容与题目不符", 400);
        }
      } else if (partInteraction.kind === "relation_canvas") {
        if (answer.kind !== "relation") throw new LearningRunServiceError("payload_variant_mismatch", "part 作答类型与题目不符", 400);
        const nodes = new Set(partInteraction.publicNodeIds ?? []);
        const edgeKinds = new Set(partInteraction.allowedEdgeKinds ?? []);
        const edges = (answer.edges ?? []) as Array<{ fromNodeId: string; toNodeId: string; edgeKind: string }>;
        if (edges.length > 16) throw new LearningRunServiceError("payload_variant_mismatch", "关系数量超出题目允许范围", 400);
        for (const edge of edges) {
          if (!nodes.has(edge.fromNodeId) || !nodes.has(edge.toNodeId) || !edgeKinds.has(edge.edgeKind)) {
            throw new LearningRunServiceError("payload_variant_mismatch", "关系内容与题目不符", 400);
          }
        }
      } else if (partInteraction.kind === "repair") {
        if (answer.kind !== "repair") throw new LearningRunServiceError("payload_variant_mismatch", "part 作答类型与题目不符", 400);
        const elements = new Set(partInteraction.publicElementIds ?? []);
        const ops = new Set(partInteraction.allowedOperationKinds ?? []);
        const options = new Set(partInteraction.replacementOptionIds ?? []);
        const operations = (answer.operations ?? []) as Array<Record<string, unknown>>;
        if (operations.length > 16) throw new LearningRunServiceError("payload_variant_mismatch", "修复操作数量超出题目允许范围", 400);
        for (const operation of operations) {
          const op = operation.op as string;
          if (!ops.has(op)) throw new LearningRunServiceError("payload_variant_mismatch", "修复操作与题目不符", 400);
          const elementKey = op === "insert"
            ? (operation.afterElementId as string | null | undefined) ?? null
            : (operation.elementId as string | null | undefined) ?? null;
          if (elementKey !== null && !elements.has(elementKey)) {
            throw new LearningRunServiceError("payload_variant_mismatch", "修复操作与题目不符", 400);
          }
          const optionKey = operation.replacementOptionId as string | undefined;
          if (optionKey !== undefined && !options.has(optionKey)) {
            throw new LearningRunServiceError("payload_variant_mismatch", "修复选项与题目不符", 400);
          }
          if ((op === "replace" || op === "insert") && optionKey === undefined) {
            throw new LearningRunServiceError("payload_variant_mismatch", "修复操作缺少选项", 400);
          }
        }
      } else {
        throw new LearningRunServiceError("payload_variant_mismatch", "part 类型无法识别", 400);
      }
    }
  }

  // 已锁定检查（§12.3：artifact_already_locked）。
  const lockedRows = await tx.select().from(learningArtifacts)
    .where(and(eq(learningArtifacts.taskId, input.taskId), eq(learningArtifacts.status, "locked")))
    .limit(1);
  if (lockedRows.length > 0) throw artifactAlreadyLocked();

  const at = now();

  // assistance snapshot：从事件账本判定提示暴露（服务端事实，不信任客户端）。
  const hintRows = await tx.select().from(learningRunEvents)
    .where(and(eq(learningRunEvents.runId, run.id), eq(learningRunEvents.eventType, "learning_task.hint_requested")))
    .limit(1);
  const assistanceSnapshotHash = hintRows.length > 0
    ? sha256Hex("assistance:practice_only:hint_requested")
    : sha256Hex("assistance:none");

  // §16.2/§16.7 V2 Artifact lock：按稳定 evidence id 顺序锁定 eligibility 行，
  // 复验 objective lifecycle epoch 与全部 expectedEvidenceEligibilityEpoch；
  // 任何 restricted/revoked 或 epoch 漂移 → fail closed（绝不锁成 trusted Artifact）。
  await revalidateV2ArtifactEpochs(tx, run.id);

  // 0120：closure 哈希从 variant 行读（private 表对 ailearn_api 无 SELECT）。
  const artifactId = crypto.randomUUID();
  const assessmentId = crypto.randomUUID();
  const payloadHash = sha256Hex(JSON.stringify(payload));

  await tx.insert(learningArtifacts).values({
    id: artifactId,
    runId: run.id,
    taskId: input.taskId,
    variantId: variant.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    revision: 1,
    payload: payload as never,
    payloadHash,
    publicPayloadHash: variant.publicPayloadHash,
    inputSchemaHash: variant.inputSchemaHash,
    privateSolutionHash: variant.privateSolutionHash ?? "",
    safetyReportHash: variant.safetyReportHash ?? "",
    disclosureProfileHash: variant.disclosureProfileHash,
    assistanceSnapshotHash,
    qualificationProfileHash: null,
    status: "locked",
    lockedAt: at,
    createdAt: at,
    updatedAt: at,
  });
  await tx.insert(learningAssessments).values({
    id: assessmentId,
    runId: run.id,
    taskId: input.taskId,
    artifactId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    source: payload.kind === "declared_unable"
      ? "deterministic_declared_unable"
      : payload.kind === "ordering" || payload.kind === "relation" || payload.kind === "repair" || payload.kind === "structured_bundle"
        ? "deterministic_structured"
        : "assessment_critic",
    status: "queued",
    rubricResults: [],
    createdAt: at,
    updatedAt: at,
  });
  await tx.update(learningTasks).set({ status: "answered", revision: task.revision + 1, updatedAt: at })
    .where(eq(learningTasks.id, input.taskId));
  await tx.update(learningRuns).set({ phase: "assessing", revision: run.revision + 1, updatedAt: at })
    .where(eq(learningRuns.id, run.id));

  // 事件 + 幂等账本（同事务）。
  await tx.insert(learningRunEvents).values({
    runId: run.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    sequence: run.eventCursor + 1,
    eventType: "learning_artifact.locked",
    payload: { taskId: input.taskId, artifactId },
    occurredAt: at,
  });
  await tx.insert(learningRunEvents).values({
    runId: run.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    sequence: run.eventCursor + 2,
    eventType: "learning_assessment.queued",
    payload: { taskId: input.taskId, artifactId, assessmentId },
    occurredAt: at,
  });
  await tx.update(learningRuns).set({ eventCursor: run.eventCursor + 2, updatedAt: at }).where(eq(learningRuns.id, run.id));

  const receipt = {
    version: 1,
    runId: run.id,
    taskId: input.taskId,
    artifactId,
    artifactRevision: 1,
    artifactStatus: "locked",
    assessment: { assessmentId, status: "queued" },
    runRevision: run.revision + 1,
    taskRevision: task.revision + 1,
    eventCursor: run.eventCursor + 2,
  };
  // §13.5：Assessment 只能由内部 outbox 驱动（不在提交事务外暴露 assess 调用）。
  await tx.insert(learningRunProcessingOutbox).values({
    runId: run.id,
    taskId: input.taskId,
    artifactId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    commandType: "assessment_requested",
    payload: { taskId: input.taskId, artifactId, assessmentId },
    idempotencyKey: `assessment:${assessmentId}`,
    availableAt: at,
    createdAt: at,
    updatedAt: at,
  });
  await tx.insert(learningRunActionLedger).values({
    runId: run.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    actionKind: "submit",
    idempotencyKey: input.request.idempotencyKey,
    requestHash: submissionRequestHash,
    responseStatus: "success",
    responseSnapshot: receipt,
    acceptedActionId: crypto.randomUUID(),
    createdAt: at,
    updatedAt: at,
  });

  return receipt;
}

// ─── getResult / getReturnContract ───────────────────────────────────────

export async function getResultPayload(
  tx: ApiTransaction,
  input: RunScope & { runId: string },
): Promise<
  | { status: "pending"; httpStatus: 202; phase: LearningRunPublicV1["phase"]; revision: number }
  | { status: "learning_result"; httpStatus: 200; result: LearningRunResultV1 }
  | { status: "terminal_without_result"; httpStatus: 200; phase: "ended" | "cancelled" | "stale"; reasonCode: string }
> {
  const run = await loadRun(tx, input, input.runId);
  if (run.result) {
    return { status: "learning_result", httpStatus: 200, result: run.result as unknown as LearningRunResultV1 };
  }
  if (run.phase === "ended" || run.phase === "cancelled" || run.phase === "stale") {
    return {
      status: "terminal_without_result",
      httpStatus: 200,
      phase: run.phase,
      reasonCode: run.terminalReasonCode ?? "user_ended",
    };
  }
  return { status: "pending", httpStatus: 202, phase: run.phase, revision: run.revision };
}

export async function getReturnContract(
  tx: ApiTransaction,
  input: RunScope & { runId: string },
): Promise<LearningRunReturnContractV1> {
  const run = await loadRun(tx, input, input.runId);
  const returnTarget = run.returnTarget as LearningRunPublicV1["returnTarget"];
  const activePhases = ["preparing", "active", "assessing", "checkpoint", "committing", "paused", "recoverable_error"];
  if (activePhases.includes(run.phase)) {
    return {
      version: 1,
      status: "run_active",
      runPhase: run.phase as never,
      returnTarget,
    };
  }
  // P7：终态按 change set 物化状态返回投影语义。
  const { understandingChangeSets } = await import("../../db/schema/understanding-projection.ts");
  const changeSetRows = await tx
    .select()
    .from(understandingChangeSets)
    .where(and(
      eq(understandingChangeSets.runId, input.runId),
      eq(understandingChangeSets.workspaceId, input.workspaceId),
      eq(understandingChangeSets.userId, input.userId),
    ))
    .orderBy(desc(understandingChangeSets.createdAt))
    .limit(1);
  const changeSet = changeSetRows[0];
  if (changeSet) {
    return {
      version: 1,
      status: "ready",
      sourceChange: changeSet.kind === "canonical"
        ? { kind: "canonical", canonicalEventId: changeSet.sourceEventId }
        : { kind: "practice_only", practiceEventId: changeSet.sourceEventId },
      targetCheckpoint: {
        version: 1,
        workspaceId: input.workspaceId,
        userId: input.userId,
        token: changeSet.toCheckpointToken,
        capturedAt: changeSet.createdAt.toISOString(),
      },
      returnTarget,
      changeSetId: changeSet.changeSetId,
    };
  }
  // canonical/practice 发生过但 change set 未物化（投影暂时失败）→ pending。
  const runResult = run.result as { outcome?: string } | null;
  if (runResult && (runResult.outcome === "demonstrated" || runResult.outcome === "declared_unable" || runResult.outcome === "practice_completed")) {
    return {
      version: 1,
      status: "projection_pending",
      sourceChange: runResult.outcome === "practice_completed"
        ? { kind: "practice_only", practiceEventId: `practice:${sha256Hex(`${input.runId}:structured`).slice(0, 24)}` }
        : { kind: "canonical", canonicalEventId: `canonical:${sha256Hex(`${input.runId}`).slice(0, 24)}` },
      currentCheckpoint: {
        version: 1,
        workspaceId: input.workspaceId,
        userId: input.userId,
        token: "initial",
        capturedAt: new Date(0).toISOString(),
      },
      returnTarget,
      retryAfterMs: 3000,
    };
  }
  // skipped/ended 无 practice trail：0 投影变化。
  return {
    version: 1,
    status: "no_projection_change",
    sourceChange: { kind: "none" },
    returnTarget,
  };
}

// ─── SSE 事件读取 ────────────────────────────────────────────────────────

// F8（round-4）：SSE 每 tick 无界读该 run 全部事件日志（含 jsonb payload）入内存。
// 改为 keyset 谓词（sequence > after）+ LIMIT 分批：SSE 轮询循环每 3s 续读、cursor
// 随返回递增，天然支持续流；Last-Event-ID 契约与事件顺序保持（ORDER BY sequence）。
const SSE_EVENTS_BATCH = 200;
// F15·①：每 (run) 保留的最多 lease 条数（超出的旧行在下次续租时 DELETE）。
const ACTIVITY_LEASE_KEEP_LATEST = 50;

export async function getEventsAfter(
  tx: ApiTransaction,
  input: RunScope & { runId: string; afterSequence: number },
): Promise<Array<{ sequence: number; eventType: string; payload: Record<string, unknown>; occurredAt: string }>> {
  await loadRun(tx, input, input.runId);
  // F8：把 seq > after 过滤下推到 SQL 谓词（命中 (runId,occurredAt) 前缀索引外还应
  // 结合 sequence 界；LIMIT 约束每 tick 内存/传输体积）。调用方（SSE 轮询/集成测试）
  // 通过 cursor 递增续读，返回 shape 保持不变。
  const rows = await tx
    .select()
    .from(learningRunEvents)
    .where(and(
      eq(learningRunEvents.runId, input.runId),
      eq(learningRunEvents.workspaceId, input.workspaceId),
      eq(learningRunEvents.userId, input.userId),
      gt(learningRunEvents.sequence, input.afterSequence),
    ))
    .orderBy(learningRunEvents.sequence)
    .limit(SSE_EVENTS_BATCH);
  return rows.map((r) => ({
    sequence: r.sequence,
    eventType: r.eventType,
    payload: r.payload as Record<string, unknown>,
    occurredAt: r.occurredAt.toISOString(),
  }));
}

// ─── 活动时间 lease（§13.3）─────────────────────────────────────────────

export async function recordActivityLease(
  tx: ApiTransaction,
  input: RunScope & { runId: string; deviceSessionId: string; startedAt: string; endedAt: string },
): Promise<void> {
  const run = await loadRun(tx, input, input.runId, true);
  if (run.phase !== "active") throw invalidPhase(run.phase, "active");
  const receivedStartedAt = new Date(input.startedAt);
  const receivedEndedAt = new Date(input.endedAt);
  if (Number.isNaN(receivedStartedAt.getTime()) || Number.isNaN(receivedEndedAt.getTime())) {
    throw new LearningRunServiceError("invalid_lease", "续租时间非法", 400);
  }
  // §13.3：客户端 reported duration 非权威——服务端以接收时间与最近一次已
  // 计费 lease 的结束时间为下界（重叠/重复 lease 幂等去重），每次最多计 20 秒。
  const lastRows = await tx
    .select({ leaseEndedAt: learningActivityLeases.leaseEndedAt })
    .from(learningActivityLeases)
    .where(and(
      eq(learningActivityLeases.runId, run.id),
      eq(learningActivityLeases.deviceSessionId, input.deviceSessionId),
    ))
    .orderBy(desc(learningActivityLeases.leaseEndedAt))
    .limit(1);
  const lowerBoundMs = Math.max(
    receivedStartedAt.getTime(),
    lastRows[0]?.leaseEndedAt.getTime() ?? receivedStartedAt.getTime(),
  );
  const upperBoundMs = Math.min(receivedEndedAt.getTime(), Date.now());
  const creditedSeconds = Math.min(
    20,
    Math.max(0, Math.floor((upperBoundMs - lowerBoundMs) / 1000)),
  );
  // F15·①（round-4）：learning_activity_leases 纯 append-only 无 TTL 清理 → 表无界
  // 增长（activeSecondsUsed 上限 180 不抑制行增长）。客户端每 15s 续租（POST
  // /activity-lease），每次写入前删除该 run 的旧 lease：仅保留最近
  // ACTIVITY_LEASE_KEEP_LATEST 条 + 清掉 24h 前全部（双条件，NOT IN 子查询借助
  // run_idx 有界）。幂等去重由 onConflictDoNothing 保证，删除不影响计费语义。
  await tx.delete(learningActivityLeases)
    .where(and(
      eq(learningActivityLeases.runId, run.id),
      sql`${learningActivityLeases.createdAt} < now() - interval '24 hours'`, // 超 24h 全部清
    ));
  await tx.delete(learningActivityLeases).where(and(
    eq(learningActivityLeases.runId, run.id),
    sql`${learningActivityLeases.id} NOT IN (
      SELECT ${learningActivityLeases.id} FROM ${learningActivityLeases}
      WHERE ${learningActivityLeases.runId} = ${run.id}
      ORDER BY ${learningActivityLeases.leaseEndedAt} DESC
      LIMIT ${ACTIVITY_LEASE_KEEP_LATEST}
    )`,
  ));
  // F15·②：run 行为 loadRun(..., true) FOR UPDATE 热行写锁 保持——结算/commit
  // 的 CAS（activeSecondsUsed 上限 + 幂等去重）已兜底并发计费正确性；若拆分锁
  // 会引入计数竞态，维持现状更安全。
  const inserted = await tx.insert(learningActivityLeases).values({
    runId: run.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    deviceSessionId: input.deviceSessionId,
    leaseStartedAt: receivedStartedAt,
    leaseEndedAt: receivedEndedAt,
    creditedSeconds,
    createdAt: new Date(),
  }).onConflictDoNothing().returning({ id: learningActivityLeases.id });
  if (inserted.length === 0) return; // 重复 lease（同 (run,device,startedAt)）不计费。
  await tx.update(learningRuns)
    .set({
      activeSecondsUsed: Math.min(180, run.activeSecondsUsed + creditedSeconds),
      updatedAt: new Date(),
    })
    .where(eq(learningRuns.id, run.id));
}

// ─── 导出供 Finalizer 使用 ───────────────────────────────────────────────

export { learningRuns, learningAssessments, learningArtifacts, learningRunEvents };
