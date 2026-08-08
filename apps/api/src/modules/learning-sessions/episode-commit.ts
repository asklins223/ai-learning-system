/**
 * 任务 06-2：Episode COMMIT 事务编排（§4.3 / 01-2 §7.4/§8.6 / 01-3 §12.2）。
 *
 * 本文件是 contract 冻结版本的互斥纯函数层 + 可注入 commit 端口编排：
 * - `COMMIT_LOCK_ORDER`：§4.3 固定锁序
 *   runtime-control → learning_episode → authoritative target/version guard →
 *   keyPoint schedule guard → input schedule（仅 consume_pending 时）；
 * - `evaluateCommitCas`：单次 CAS 同时验证 runtimeEpoch / episodeEpoch /
 *   Episode active&&!cancelled&&!stale / content revision+fingerprint /
 *   scheduling decision hash / kill=false；create_initial 另验证不存在 active
 *   pending，consume_pending 另验证精确 generation 仍 active；任一失败整体
 *   归因为 stale/cancelled/blocked（operational_only，0 学习副作用）；
 * - `deriveEpisodeCommitDisposition`：01-2 §8.6 六步优先级互斥纯函数，唯一返回值；
 * - `planCommitSideEffects`：disposition → 唯一事实落点（现有 validation/review/
 *   understanding canonical facts）+ 同事务 outbox 派生 projection + schedule
 *   副作用（恰好一个 active schedule）的纯函数计划；
 * - `commitEpisode`：编排（固定顺序锁 → 锁内读快照 → 单次 CAS → 失败归因 →
 *   按 disposition 分发）；写操作全部经可注入 `CommitPort`，重试/断线/Worker
 *   crash 靠 commitKey 幂等 + 同一事务原子性 + canonical-events 幂等键兜底，
 *   不重复 result 或 schedule 副作用。
 *
 * @ailearn/shared 目前没有 EpisodeCommitDispositionV1 契约导出，按交付要求
 * 在本模块本地声明并注明「收口迁移至 @ailearn/shared/episode-commit-contracts」。
 */

import { createHash } from "node:crypto";
import { TrustClass } from "@ailearn/shared";
import {
  RubricSessionResult,
  type AuthorizedAction,
  type EpisodeTrustDecision,
  type FormalPlanKind,
  type ReducerResult,
  type RubricAssessment,
  type ScheduleSideEffect,
} from "./trust-service.ts";
import {
  type LearningEpisodeStatus,
  type LearningSessionOrigin,
  type OfficialSchedulingDecisionV1,
} from "./session-service.ts";
import {
  computeProjectionHash,
  stableStringify,
  type CanonicalEventAppendInput,
  type CanonicalEventAppendResult,
  type CanonicalEventPayload,
  type CanonicalEventType,
  type CanonicalFactInsert,
  type WorkspaceUserScope,
} from "./canonical-events.ts";

// ─── EpisodeCommitDispositionV1（本地契约，收口迁移至 @ailearn/shared）──────

export const EpisodeCommitDisposition = {
  CANONICAL_MASTERY: "canonical_mastery",
  CANONICAL_UNABLE: "canonical_unable",
  CANONICAL_FACET_OBSERVATION: "canonical_facet_observation",
  PRACTICE_OR_DIAGNOSTIC: "practice_or_diagnostic",
  OPERATIONAL_ONLY: "operational_only",
} as const;
export type EpisodeCommitDisposition =
  (typeof EpisodeCommitDisposition)[keyof typeof EpisodeCommitDisposition];

export const EPISODE_COMMIT_CONTRACT_VERSION = "episode-commit-v1" as const;
export const COMMIT_KEY_PREFIX = "epc:" as const;

/** 失败归因（§4.3：任一 CAS 失败整体回滚为 stale/cancelled/blocked）。 */
export type CommitAttribution = "stale" | "cancelled" | "blocked";

// ─── 固定锁序（§4.3）───────────────────────────────────────────────────────

export const CommitLockStep = {
  RUNTIME_CONTROL: "runtime_control",
  LEARNING_EPISODE: "learning_episode",
  AUTHORITATIVE_TARGET_GUARD: "authoritative_target_guard",
  KEYPOINT_SCHEDULE_GUARD: "keypoint_schedule_guard",
  INPUT_SCHEDULE: "input_schedule",
} as const;
export type CommitLockStep = (typeof CommitLockStep)[keyof typeof CommitLockStep];

/**
 * §4.3 固定锁序：runtime-control → learning_episode → authoritative
 * target/version guard → keyPoint schedule guard → input schedule（consume 时）。
 * 前四步对所有 COMMIT 必需；input schedule 仅在 consume_pending 时锁定
 * （create_initial / record_only / no_effect 没有输入 schedule 可锁）。
 */
export const COMMIT_LOCK_ORDER: readonly CommitLockStep[] = [
  CommitLockStep.RUNTIME_CONTROL,
  CommitLockStep.LEARNING_EPISODE,
  CommitLockStep.AUTHORITATIVE_TARGET_GUARD,
  CommitLockStep.KEYPOINT_SCHEDULE_GUARD,
  CommitLockStep.INPUT_SCHEDULE,
] as const;

export interface CommitLockPlan {
  /** 本 Episode 实际锁定步骤（保持 §4.3 顺序；consume_pending 才含 input schedule）。 */
  steps: readonly CommitLockStep[];
  includesInputSchedule: boolean;
}

/** 由预冻结授权决定锁计划（纯函数）：consume_pending 才锁 input schedule。 */
export function buildCommitLockPlan(
  authorizedAction: AuthorizedAction,
): CommitLockPlan {
  if (authorizedAction === "consume_pending") {
    return { steps: COMMIT_LOCK_ORDER, includesInputSchedule: true };
  }
  return {
    steps: COMMIT_LOCK_ORDER.slice(0, 4),
    includesInputSchedule: false,
  };
}

// ─── 单次 CAS（§4.3 六条件 + create/consume 独特性）────────────────────────

export type CasFailureCode =
  | "runtime_epoch_mismatch"
  | "episode_epoch_changed"
  | "episode_not_active"
  | "episode_cancelled"
  | "episode_stale"
  | "content_revision_mismatch"
  | "content_fingerprint_mismatch"
  | "scheduling_decision_hash_mismatch"
  | "kill_active"
  | "active_pending_exists"
  | "generation_not_active"
  | "input_schedule_missing";

/** 锁内读到的 CAS 快照（port 从数据库锁行读，测试用内存实现）。 */
export interface CommitGuardSnapshot {
  currentRuntimeEpoch: number;
  currentEpisodeEpoch: number;
  episodeStatus: LearningEpisodeStatus;
  currentContentRevision: string | null;
  currentContentFingerprint: string;
  currentSchedulingDecisionHash: string;
  kill: boolean;
  /** create_initial 校验：keyPoint 下是否已存在 active pending schedule。 */
  activePendingScheduleExists: boolean;
  /** consume_pending 校验：input schedule 是否仍 active（pending）。 */
  inputScheduleActive: boolean;
  currentInputScheduleGeneration: number | null;
}

export interface CommitCasInput {
  runtimeEpochSnapshot: number;
  currentRuntimeEpoch: number;
  episodeEpochAtPrepare: number;
  currentEpisodeEpoch: number;
  episodeStatus: LearningEpisodeStatus;
  contentRevisionAtPrepare: string | null;
  currentContentRevision: string | null;
  contentFingerprintAtPrepare: string;
  currentContentFingerprint: string;
  schedulingDecisionHashAtPrepare: string;
  currentSchedulingDecisionHash: string;
  kill: boolean;
  authorizedAction: AuthorizedAction;
  /** create_initial：须为 false（不存在 active pending）。 */
  activePendingScheduleExists: boolean;
  /** consume_pending：input schedule 须 active 且 generation 精确匹配。 */
  inputScheduleActive: boolean;
  inputScheduleGenerationAtPrepare: number | null;
  currentInputScheduleGeneration: number | null;
}

export interface CommitCasResult {
  ok: boolean;
  failures: readonly CasFailureCode[];
  /** ok=false 时的整体归因（stale > cancelled > blocked）。 */
  attribution: CommitAttribution | null;
}

/** 归因优先级：stale 最高，其次 cancelled，其余 blocked。 */
const ATTRIBUTION_RANK: Record<CommitAttribution, number> = {
  stale: 3,
  cancelled: 2,
  blocked: 1,
};

/**
 * 单次 CAS 校验（纯函数）。逐项检查全部 §4.3 条件并返回全部失败（便于诊断），
 * 整体归因取最高优先级失败：
 * - stale：episode_stale / content revision / content fingerprint 失配；
 * - cancelled：episode_cancelled；
 * - blocked：runtime epoch、episode epoch、非 active、scheduling hash、
 *   kill、active pending 存在、generation 失配、input schedule 缺失。
 */
export function evaluateCommitCas(input: CommitCasInput): CommitCasResult {
  const failures: CasFailureCode[] = [];
  const attributionFor: Record<CasFailureCode, CommitAttribution> = {
    runtime_epoch_mismatch: "blocked",
    episode_epoch_changed: "blocked",
    episode_not_active: "blocked",
    episode_cancelled: "cancelled",
    episode_stale: "stale",
    content_revision_mismatch: "stale",
    content_fingerprint_mismatch: "stale",
    scheduling_decision_hash_mismatch: "blocked",
    kill_active: "blocked",
    active_pending_exists: "blocked",
    generation_not_active: "blocked",
    input_schedule_missing: "blocked",
  };

  // 1. runtimeEpoch = snapshot
  if (input.currentRuntimeEpoch !== input.runtimeEpochSnapshot) {
    failures.push("runtime_epoch_mismatch");
  }
  // 2. episodeEpoch 未变
  if (input.currentEpisodeEpoch !== input.episodeEpochAtPrepare) {
    failures.push("episode_epoch_changed");
  }
  // 3. Episode = active && !cancelled && !stale
  if (input.episodeStatus === "cancelled") failures.push("episode_cancelled");
  else if (input.episodeStatus === "stale") failures.push("episode_stale");
  else if (input.episodeStatus !== "active") failures.push("episode_not_active");
  // 4. current content revision / fingerprint 匹配
  if (input.currentContentRevision !== input.contentRevisionAtPrepare) {
    failures.push("content_revision_mismatch");
  }
  if (input.currentContentFingerprint !== input.contentFingerprintAtPrepare) {
    failures.push("content_fingerprint_mismatch");
  }
  // 5. scheduling decision hash 匹配
  if (input.currentSchedulingDecisionHash !== input.schedulingDecisionHashAtPrepare) {
    failures.push("scheduling_decision_hash_mismatch");
  }
  // 6. kill = false
  if (input.kill) failures.push("kill_active");

  // create_initial 独特性：不存在 active pending
  if (input.authorizedAction === "create_initial" && input.activePendingScheduleExists) {
    failures.push("active_pending_exists");
  }
  // consume_pending 独特性：input schedule 仍 active 且 generation 精确匹配
  if (input.authorizedAction === "consume_pending") {
    if (!input.inputScheduleActive) failures.push("input_schedule_missing");
    else if (
      input.inputScheduleGenerationAtPrepare !== input.currentInputScheduleGeneration
    ) {
      failures.push("generation_not_active");
    }
  }

  if (failures.length === 0) {
    return { ok: true, failures: [], attribution: null };
  }
  let attribution: CommitAttribution = "blocked";
  for (const failure of failures) {
    const a = attributionFor[failure];
    if (ATTRIBUTION_RANK[a] > ATTRIBUTION_RANK[attribution]) attribution = a;
  }
  return { ok: false, failures, attribution };
}

// ─── Disposition 推导（01-2 §8.6 六步优先级互斥纯函数）────────────────────

export interface DeriveCommitDispositionInput {
  /** CAS 失败整体归因；非 null 时直接 operational_only（优先级 1）。 */
  casAttribution: CommitAttribution | null;
  providerFailure: boolean;
  notAssessable: boolean;
  /** 缺 required artifact（含 facet-to-mastery-policy-v1 allowed=false /
   *   incomplete silent bundle / 未锁答案）→ operational_only。 */
  missingRequiredArtifact: boolean;
  assisted: boolean;
  /** formalPlan.kind === "practice" */
  practicePlan: boolean;
  /** effectiveClass === diagnostic_only */
  diagnosticTrust: boolean;
  userDeclaredUnable: boolean;
  authorizedAction: AuthorizedAction;
  effectiveTrustClass: TrustClass;
  assessableTrustedPointResult: boolean;
  /** facet-to-mastery-policy-v1 的 allowed 结果（mastery/facet 双保险）。 */
  policyAllowed: boolean;
  /** reducer 可评估（result ∈ pass|partial|fail，非 not_assessable）。 */
  reducerAssessable: boolean;
}

export interface DerivedDisposition {
  disposition: EpisodeCommitDisposition;
  /** 唯一允许的 schedule 副作用；"none" = 0 写。 */
  scheduleSideEffect: ScheduleSideEffect;
  /** 命中第 6 步 fail closed（contract invariant violation）。 */
  contractInvariantViolation: boolean;
  reasonCodes: string[];
}

const CREATE_CONSUME: readonly AuthorizedAction[] = ["create_initial", "consume_pending"];

/** create_initial/consume_pending → 对应 schedule 副作用；其余 → none。 */
function authorizedActionToSideEffect(action: AuthorizedAction): ScheduleSideEffect {
  return action === "create_initial" || action === "consume_pending" ? action : "none";
}

/**
 * §8.6 Disposition 优先级（互斥，只返回一个值）：
 * 1. stale/cancel/kill/provider failure/not-assessable/缺 required artifact → operational_only；
 * 2. assisted、practice plan、diagnostic trust 或 authorizedAction=no_effect → practice_or_diagnostic；
 * 3. user_declared_unable + authorizedAction∈{create_initial,consume_pending} → canonical_unable，否则归 practice；
 * 4. assessable mastery_eligible + authorizedAction∈{create_initial,consume_pending} → canonical_mastery；
 * 5. assessable trusted point results + authorizedAction=record_only → canonical_facet_observation；
 * 6. 其余 fail closed → operational_only + contract invariant violation。
 * 纯函数：相同冻结输入恒同输出（同事件重放 → 相同 disposition）。
 */
export function deriveEpisodeCommitDisposition(
  input: DeriveCommitDispositionInput,
): DerivedDisposition {
  const reasonCodes: string[] = [];
  const isCreateConsume = CREATE_CONSUME.includes(input.authorizedAction);

  // 1. operational_only
  if (
    input.casAttribution !== null ||
    input.providerFailure ||
    input.notAssessable ||
    input.missingRequiredArtifact
  ) {
    reasonCodes.push("priority1_operational_only");
    if (input.casAttribution === "stale") reasonCodes.push("cas_stale");
    if (input.casAttribution === "cancelled") reasonCodes.push("cas_cancelled");
    if (input.casAttribution === "blocked") reasonCodes.push("cas_blocked");
    if (input.providerFailure) reasonCodes.push("provider_failure");
    if (input.notAssessable) reasonCodes.push("not_assessable");
    if (input.missingRequiredArtifact) reasonCodes.push("missing_required_artifact");
    return {
      disposition: EpisodeCommitDisposition.OPERATIONAL_ONLY,
      scheduleSideEffect: "none",
      contractInvariantViolation: false,
      reasonCodes,
    };
  }

  // 2. practice_or_diagnostic
  if (
    input.assisted ||
    input.practicePlan ||
    input.diagnosticTrust ||
    input.authorizedAction === "no_effect"
  ) {
    reasonCodes.push("priority2_practice_or_diagnostic");
    if (input.assisted) reasonCodes.push("assisted");
    if (input.practicePlan) reasonCodes.push("practice_plan");
    if (input.diagnosticTrust) reasonCodes.push("diagnostic_trust");
    if (input.authorizedAction === "no_effect") reasonCodes.push("authorized_no_effect");
    return {
      disposition: EpisodeCommitDisposition.PRACTICE_OR_DIAGNOSTIC,
      scheduleSideEffect: "none",
      contractInvariantViolation: false,
      reasonCodes,
    };
  }

  // 3. canonical_unable（仅 create_initial/consume_pending）
  if (input.userDeclaredUnable) {
    if (isCreateConsume) {
      reasonCodes.push("priority3_canonical_unable");
      return {
        disposition: EpisodeCommitDisposition.CANONICAL_UNABLE,
        scheduleSideEffect: authorizedActionToSideEffect(input.authorizedAction),
        contractInvariantViolation: false,
        reasonCodes,
      };
    }
    reasonCodes.push("priority3_unable_downgraded_to_practice");
    return {
      disposition: EpisodeCommitDisposition.PRACTICE_OR_DIAGNOSTIC,
      scheduleSideEffect: "none",
      contractInvariantViolation: false,
      reasonCodes,
    };
  }

  // 4. canonical_mastery
  if (
    input.effectiveTrustClass === TrustClass.MASTERY_ELIGIBLE &&
    input.reducerAssessable &&
    input.policyAllowed &&
    isCreateConsume
  ) {
    reasonCodes.push("priority4_canonical_mastery");
    return {
      disposition: EpisodeCommitDisposition.CANONICAL_MASTERY,
      scheduleSideEffect: authorizedActionToSideEffect(input.authorizedAction),
      contractInvariantViolation: false,
      reasonCodes,
    };
  }

  // 5. canonical_facet_observation
  if (
    input.assessableTrustedPointResult &&
    input.authorizedAction === "record_only" &&
    input.policyAllowed
  ) {
    reasonCodes.push("priority5_canonical_facet_observation");
    return {
      disposition: EpisodeCommitDisposition.CANONICAL_FACET_OBSERVATION,
      scheduleSideEffect: "none",
      contractInvariantViolation: false,
      reasonCodes,
    };
  }

  // 6. fail closed（contract invariant violation）
  reasonCodes.push("priority6_fail_closed_invariant_violation");
  return {
    disposition: EpisodeCommitDisposition.OPERATIONAL_ONLY,
    scheduleSideEffect: "none",
    contractInvariantViolation: true,
    reasonCodes,
  };
}

// ─── reducer → 现有 canonical outcome 映射（domain adapter，纯函数）────────

/**
 * rubric-session-reducer-v2 四态 → validation_events.outcome 枚举
 * （pass → preliminary_understanding，partial → unclear_expression，
 *  fail → misunderstanding，not_assessable → unknown）。
 */
export function mapReducerToValidationOutcome(result: RubricSessionResult): string {
  switch (result) {
    case RubricSessionResult.PASS:
      return "preliminary_understanding";
    case RubricSessionResult.PARTIAL:
      return "unclear_expression";
    case RubricSessionResult.FAIL:
      return "misunderstanding";
    case RubricSessionResult.NOT_ASSESSABLE:
      return "unknown";
  }
}

/** reducer 四态 → review_attempts.outcome（ReviewOutcome 子集）。 */
export function mapReducerToReviewOutcome(result: RubricSessionResult): string {
  switch (result) {
    case RubricSessionResult.PASS:
      return "correct";
    case RubricSessionResult.PARTIAL:
      return "partial";
    case RubricSessionResult.FAIL:
      return "incorrect";
    case RubricSessionResult.NOT_ASSESSABLE:
      return "later";
  }
}

/** reducer 四态 → scheduleReasonCode / understandingEffect（unable 独立处理）。 */
export function mapReducerToScheduleReason(result: RubricSessionResult): string {
  switch (result) {
    case RubricSessionResult.PASS:
      return "correct_advance";
    case RubricSessionResult.PARTIAL:
      return "partial_advance";
    case RubricSessionResult.FAIL:
      return "incorrect_reset";
    case RubricSessionResult.NOT_ASSESSABLE:
      return "not_assessable";
  }
}

export function mapReducerToUnderstandingEffect(result: RubricSessionResult): string {
  switch (result) {
    case RubricSessionResult.PASS:
      return "upgrade";
    case RubricSessionResult.PARTIAL:
      return "unchanged";
    case RubricSessionResult.FAIL:
      return "downgrade";
    case RubricSessionResult.NOT_ASSESSABLE:
      return "unchanged";
  }
}

// ─── 确定性 hash 原语（与 trust-service 同模式，非链式调用）────────────────

function sha256Hex(data: string): string {
  const hash = createHash("sha256");
  const update = hash.update.bind(hash);
  update(data, "utf8");
  return hash.digest("hex");
}

// ─── commitKey（幂等键）───────────────────────────────────────────────────

/**
 * 派生 commitKey（纯函数）：`epc:<disposition>:<hash>`。hash 覆盖 episodeEpoch
 * 与 schedulingDecisionHash → 同一事件重放可复现；disposition 编码使重试幂等
 * 命中时无需重跑 CAS 也能还原原 disposition。
 */
export function deriveCommitKey(input: {
  episodeId: string;
  disposition: EpisodeCommitDisposition;
  episodeEpoch: number;
  schedulingDecisionHash: string;
}): string {
  const hash = sha256Hex(
    stableStringify({
      episodeId: input.episodeId,
      episodeEpoch: input.episodeEpoch,
      schedulingDecisionHash: input.schedulingDecisionHash,
    }),
  );
  return `${COMMIT_KEY_PREFIX}${input.disposition}:${hash}`;
}

export interface ParsedCommitKey {
  valid: boolean;
  disposition: EpisodeCommitDisposition | null;
}

/** 解析 commitKey（幂等命中时还原 disposition；不合法 fail closed 为 operational）。 */
export function parseCommitKey(key: string): ParsedCommitKey {
  const prefix = `${COMMIT_KEY_PREFIX}`;
  if (!key.startsWith(prefix)) return { valid: false, disposition: null };
  const rest = key.slice(prefix.length);
  const sep = rest.indexOf(":");
  if (sep <= 0 || sep >= rest.length - 1) return { valid: false, disposition: null };
  const disposition = rest.slice(0, sep) as EpisodeCommitDisposition;
  const values: string[] = Object.values(EpisodeCommitDisposition);
  if (!values.includes(disposition)) return { valid: false, disposition: null };
  return { valid: true, disposition };
}

/** disposition → 允许的唯一 schedule 副作用（纯函数）。 */
export function dispositionToScheduleSideEffect(
  disposition: EpisodeCommitDisposition,
): ScheduleSideEffect {
  switch (disposition) {
    case EpisodeCommitDisposition.CANONICAL_MASTERY:
    case EpisodeCommitDisposition.CANONICAL_UNABLE:
      return "create_initial"; // 占位；精确值来自授权（见 DerivedDisposition）
    default:
      return "none";
  }
}

// ─── 写输入形状（CommitPort 参数）──────────────────────────────────────────

export interface OperationalOnlyWriteInput extends WorkspaceUserScope {
  episodeId: string;
  keyPointId: string;
  attribution: CommitAttribution;
  casFailures: readonly CasFailureCode[];
  reasonCodes: string[];
  now: Date;
}

export interface ScheduleSideEffectInput extends WorkspaceUserScope {
  episodeId: string;
  keyPointId: string;
  cardId: string;
  authorizedAction: AuthorizedAction;
  inputScheduleId?: string;
  inputScheduleGeneration?: number;
  intervalDays: number;
  nextReviewAt: Date;
  policyVersion: string;
  policyEpoch: number;
  reasonCode: string;
  supersedesScheduleId?: string;
  validationEventId?: string;
  reviewAttemptId?: string;
  /** 幂等键（review 用 idempotencyKey；schedule 写靠唯一约束兜底）。 */
  idempotencyKey: string;
  now: Date;
}

export interface ScheduleSideEffectResult {
  /** create_initial：新 initial schedule id；consume_pending：successor schedule id。 */
  scheduleId: string | null;
  activeScheduleCount: number;
  idempotent: boolean;
}

export interface PracticeEventWriteInput extends WorkspaceUserScope {
  episodeId: string;
  keyPointId: string;
  eventType: "practice" | "diagnostic";
  summary: Record<string, string>;
  now: Date;
}

export interface FacetObservationWriteInput extends WorkspaceUserScope {
  episodeId: string;
  keyPointId: string;
  cardId: string;
  assessments: readonly RubricAssessment[];
  idempotencyKey: string;
  /** 同事务 outbox 安全摘要 payload（facet/map projection 派生源）。 */
  outboxPayload: CanonicalEventPayload;
  now: Date;
}

export interface CommitPort {
  /** 按固定顺序锁定 steps（实现不得跳步/重排；测试记录顺序供断言）。 */
  lockSteps(
    steps: readonly CommitLockStep[],
    scope: WorkspaceUserScope,
    episodeId: string,
  ): Promise<void>;
  /** 锁内读取 CAS 快照（同一事务）。 */
  loadCommitGuard(
    scope: WorkspaceUserScope,
    episodeId: string,
  ): Promise<CommitGuardSnapshot>;
  /** operational_only 终态 + 低敏审计；0 学习副作用。 */
  writeOperationalOnly(input: OperationalOnlyWriteInput): Promise<void>;
  /** 同事务写现有 canonical fact + outbox（appendCanonicalEvent 语义）。 */
  appendCanonicalEvent(input: CanonicalEventAppendInput): Promise<CanonicalEventAppendResult>;
  /** schedule 副作用：create_initial / consume_pending → 恰好一个 active schedule。 */
  applyScheduleSideEffect(input: ScheduleSideEffectInput): Promise<ScheduleSideEffectResult>;
  /** practice/diagnostic event（learning session 落点；0 canonical/0 schedule）。 */
  writePracticeEvent(input: PracticeEventWriteInput): Promise<void>;
  /** facet canonical fact：validation_point_assessments + 同事务 outbox。 */
  writeFacetObservation(input: FacetObservationWriteInput): Promise<void>;
  getCommitKey(scope: WorkspaceUserScope, episodeId: string): Promise<string | null>;
  /**
   * 写入幂等键。实现必须在同一事务内（与副作用原子），并对 episodeId 施加
   * 唯一约束；若冲突（已存在 commitKey）应抛错/返回失败 → 整体回滚，
   * 确保重试/并发绝不重复 result 或 schedule 副作用（security_review MEDIUM #1）。
   */
  setCommitKey(scope: WorkspaceUserScope, episodeId: string, commitKey: string): Promise<void>;
}

// ─── 副作用计划（纯函数：disposition → 唯一事实落点 + outbox + schedule）────

export interface EpisodeCommitView {
  episodeId: string;
  keyPointId: string;
  cardId: string;
  origin: LearningSessionOrigin;
  /** episodeTargetFingerprint（内容指纹，也是 sourceFingerprint）。 */
  episodeTargetFingerprint: string;
  formalPlanKind: FormalPlanKind;
  schedulingDecision: OfficialSchedulingDecisionV1;
}

export interface PlanSideEffectsInput extends WorkspaceUserScope {
  disposition: EpisodeCommitDisposition;
  scheduleSideEffect: ScheduleSideEffect;
  episode: EpisodeCommitView;
  effectiveTrustClass: TrustClass;
  reducerResult: ReducerResult | null;
  trustDecision: EpisodeTrustDecision | null;
  assessments: readonly RubricAssessment[];
  /** question/userAnswer 原文只进权威表；由 commit 端口在真实实现从锁定 artifact 填充。 */
  artifactText: { question: string; userAnswer: string } | null;
  commitKey: string;
  /** 调度输出（official scheduler 冻结；本任务由调用方提供，06-5 落实）。 */
  scheduleOutput: {
    intervalDays: number;
    nextReviewAt: Date;
    policyVersion: string;
    policyEpoch: number;
  };
  now: string;
}

export interface CommitSideEffectPlan {
  disposition: EpisodeCommitDisposition;
  scheduleSideEffect: ScheduleSideEffect;
  /** 现有一致事实写入（validation/review/understanding + outbox）；null 表示无 canonical 写。 */
  canonicalEvent: CanonicalEventAppendInput | null;
  facetWriteInput: FacetObservationWriteInput | null;
  practiceEventInput: PracticeEventWriteInput | null;
  scheduleSideEffectInput: ScheduleSideEffectInput | null;
  operationalWriteInput: OperationalOnlyWriteInput | null;
  /** 单事件投影贡献 hash（确定性；同 payload 恒同）。 */
  projectionHash: string | null;
  commitKey: string;
  /** 第 6 步 fail closed 标记。 */
  invariantViolation: boolean;
}

/** outbox 安全摘要（facetSummaries 只含 opaque id/verdict/confidence，无原文）。 */
function buildFacetSummaries(assessments: readonly RubricAssessment[]) {
  return assessments.map((a) => ({
    rubricItemId: a.rubricItemId,
    keyPointId: undefined,
    verdict: a.verdict,
    confidence: Math.round(a.confidence),
  }));
}

/**
 * 由 disposition 推导唯一事实落点（纯函数）：
 * - canonical_mastery：review origin → review.attempt，否则 validation.event；
 *   review origin 同时写 review attempt/outcome；create/consume → 恰一 active schedule；
 * - canonical_unable：understanding.event（现有 unable domain outcome）+ schedule；
 * - canonical_facet_observation：writeFacetObservation（validation_point_assessments +
 *   同事务 outbox 派生 facet/map projection）；0 overall outcome / 0 review / 0 schedule；
 * - practice_or_diagnostic：learning session practice/diagnostic event；
 * - operational_only：低敏审计，0 学习副作用。
 * 正式结果优先落入现有 canonical facts，outbox 只派生 projection —— 不建第二套真相。
 */
export function planCommitSideEffects(
  input: PlanSideEffectsInput,
): CommitSideEffectPlan {
  const { disposition, episode } = input;
  const decision = episode.schedulingDecision;
  const scope: WorkspaceUserScope = { workspaceId: input.workspaceId, userId: input.userId };
  const reducer = input.reducerResult;
  const assessments = input.assessments ?? [];
  const now = input.now;

  const baseOutbox: CanonicalEventPayload = {
    keyPointId: episode.keyPointId,
    episodeId: episode.episodeId,
    sourceFingerprint: episode.episodeTargetFingerprint,
    idempotencyKey: input.commitKey,
    policyVersion: EPISODE_COMMIT_CONTRACT_VERSION,
    reducerVersion: reducer?.reducerVersion ?? "rubric-session-reducer-v2",
    occurredAt: now,
  };

  let canonicalEvent: CanonicalEventAppendInput | null = null;
  let facetWriteInput: FacetObservationWriteInput | null = null;
  let practiceEventInput: PracticeEventWriteInput | null = null;
  let scheduleSideEffectInput: ScheduleSideEffectInput | null = null;
  let operationalWriteInput: OperationalOnlyWriteInput | null = null;
  // 不变量：canonical_mastery/canonical_unable 必须带 schedule 授权；
  // 若 disposition 需要 schedule 但授权为 none → contract invariant violation。
  const invariantViolation =
    (disposition === EpisodeCommitDisposition.CANONICAL_MASTERY ||
      disposition === EpisodeCommitDisposition.CANONICAL_UNABLE) &&
    input.scheduleSideEffect === "none";

  const scheduleInput = (): ScheduleSideEffectInput => ({
    ...scope,
    episodeId: episode.episodeId,
    keyPointId: episode.keyPointId,
    cardId: episode.cardId,
    authorizedAction: decision.authorizedAction,
    inputScheduleId: decision.inputScheduleId,
    inputScheduleGeneration: decision.inputScheduleGeneration,
    intervalDays: input.scheduleOutput.intervalDays,
    nextReviewAt: input.scheduleOutput.nextReviewAt,
    policyVersion: input.scheduleOutput.policyVersion,
    policyEpoch: input.scheduleOutput.policyEpoch,
    reasonCode: input.scheduleSideEffect === "consume_pending"
      ? mapReducerToScheduleReason(reducer?.result ?? RubricSessionResult.NOT_ASSESSABLE)
      : "create_initial",
    supersedesScheduleId: decision.inputScheduleId,
    idempotencyKey: input.commitKey,
    now: new Date(now),
  });

  const eventTypeFor = (): CanonicalEventType =>
    episode.origin === "review" ? "review.attempt" : "validation.event";

  switch (disposition) {
    case EpisodeCommitDisposition.CANONICAL_MASTERY: {
      const confidence = Math.round((reducer?.weightedCoverage ?? 0) * 100);
      const eventType = eventTypeFor();
      if (eventType === "review.attempt") {
        const fact: CanonicalFactInsert = {
          domain: "review",
          row: {
            reviewScheduleId: decision.inputScheduleId ?? "",
            subjectType: "keyPoint",
            subjectId: episode.keyPointId,
            idempotencyKey: input.commitKey,
            keyPointId: episode.keyPointId,
            answerType: "episode_review",
            answerText: input.artifactText?.userAnswer ?? null,
            outcome: reducer ? mapReducerToReviewOutcome(reducer.result) : null,
            confidence,
            scheduleAfterIntervalDays: input.scheduleOutput.intervalDays,
            scheduleReasonCode: reducer
              ? mapReducerToScheduleReason(reducer.result)
              : null,
            understandingEffect: reducer
              ? mapReducerToUnderstandingEffect(reducer.result)
              : null,
            nextReviewAt: input.scheduleOutput.nextReviewAt,
            status: "completed",
            completedAt: new Date(now),
          },
        };
        canonicalEvent = {
          ...scope,
          eventType,
          payload: {
            ...baseOutbox,
            action: "reviewed",
            reviewScheduleId: decision.inputScheduleId,
            reviewAttemptId: undefined,
            validationEventId: undefined,
            outcomeSummary: reducer?.result,
            confidence,
            intervalDays: input.scheduleOutput.intervalDays,
            nextReviewAt: input.scheduleOutput.nextReviewAt.toISOString(),
            facetSummaries: buildFacetSummaries(assessments),
          },
          canonicalFact: fact,
        };
      } else {
        const fact: CanonicalFactInsert = {
          domain: "validation",
          row: {
            cardId: episode.cardId,
            keyPointId: episode.keyPointId,
            artifactId: null,
            question: input.artifactText?.question ?? "",
            questionType: "episode_teachback",
            userAnswer: input.artifactText?.userAnswer ?? "",
            outcome: reducer
              ? mapReducerToValidationOutcome(reducer.result)
              : "unknown",
            confidence,
            rubricVersion: "rubric-session-reducer-v2",
            reducerVersion: reducer?.reducerVersion ?? "rubric-session-reducer-v2",
            sourceFingerprint: episode.episodeTargetFingerprint,
            sourceStatus: "active",
          },
        };
        canonicalEvent = {
          ...scope,
          eventType,
          payload: {
            ...baseOutbox,
            action: "validated",
            outcomeSummary: reducer?.result,
            confidence,
            facetSummaries: buildFacetSummaries(assessments),
          },
          canonicalFact: fact,
        };
      }
      if (input.scheduleSideEffect !== "none") {
        scheduleSideEffectInput = scheduleInput();
      }
      break;
    }

    case EpisodeCommitDisposition.CANONICAL_UNABLE: {
      // 现有 unable domain outcome：understanding.event（不写"已掌握"）。
      const fact: CanonicalFactInsert = {
        domain: "understanding",
        row: {
          subjectType: "keyPoint",
          subjectId: episode.keyPointId,
          eventType: "unable",
          payload: { action: "unable", episodeId: episode.episodeId },
        },
      };
      canonicalEvent = {
        ...scope,
        eventType: "understanding.event",
        payload: {
          ...baseOutbox,
          action: "unable",
          subjectType: "keyPoint",
          subjectId: episode.keyPointId,
        },
        canonicalFact: fact,
      };
      if (input.scheduleSideEffect !== "none") {
        scheduleSideEffectInput = {
          ...scheduleInput(),
          reasonCode: "unable_reset",
        };
      }
      break;
    }

    case EpisodeCommitDisposition.CANONICAL_FACET_OBSERVATION: {
      // 唯一 canonical facet fact = validation_point_assessments + 同事务 outbox。
      facetWriteInput = {
        ...scope,
        episodeId: episode.episodeId,
        keyPointId: episode.keyPointId,
        cardId: episode.cardId,
        assessments,
        idempotencyKey: input.commitKey,
        outboxPayload: {
          ...baseOutbox,
          action: "facet_observed",
          facetSummaries: buildFacetSummaries(assessments),
        },
        now: new Date(now),
      };
      break;
    }

    case EpisodeCommitDisposition.PRACTICE_OR_DIAGNOSTIC: {
      const isDiagnostic = input.effectiveTrustClass === TrustClass.DIAGNOSTIC_ONLY;
      practiceEventInput = {
        ...scope,
        episodeId: episode.episodeId,
        keyPointId: episode.keyPointId,
        eventType: isDiagnostic ? "diagnostic" : "practice",
        summary: {
          disposition: EpisodeCommitDisposition.PRACTICE_OR_DIAGNOSTIC,
          sourceFingerprint: episode.episodeTargetFingerprint,
          commitKey: input.commitKey,
        },
        now: new Date(now),
      };
      break;
    }

    case EpisodeCommitDisposition.OPERATIONAL_ONLY: {
      operationalWriteInput = {
        ...scope,
        episodeId: episode.episodeId,
        keyPointId: episode.keyPointId,
        attribution: "blocked",
        casFailures: [],
        reasonCodes: [EpisodeCommitDisposition.OPERATIONAL_ONLY],
        now: new Date(now),
      };
      break;
    }
  }

  // projectionHash：与 canonical-events.computeProjectionHash 一致（确定性）。
  let projectionHash: string | null = null;
  if (canonicalEvent !== null) {
    projectionHash = computeProjectionHash({
      ...scope,
      eventType: canonicalEvent.eventType,
      payload: canonicalEvent.payload,
    });
  } else if (facetWriteInput !== null) {
    projectionHash = computeProjectionHash({
      ...scope,
      eventType: "validation.event",
      payload: facetWriteInput.outboxPayload,
    });
  }

  return {
    disposition,
    scheduleSideEffect: input.scheduleSideEffect,
    canonicalEvent,
    facetWriteInput,
    practiceEventInput,
    scheduleSideEffectInput,
    operationalWriteInput,
    projectionHash,
    commitKey: input.commitKey,
    invariantViolation,
  };
}

// ─── commitEpisode 编排（固定锁序 → CAS → 归因 → 分发；写经 CommitPort）────

export interface EpisodeCommitInput extends WorkspaceUserScope {
  episode: EpisodeCommitView & {
    contentRevisionAtPrepare: string | null;
    contentFingerprintAtPrepare: string;
    runtimeEpochSnapshot: number;
    episodeEpoch: number;
    status: LearningEpisodeStatus;
    planHash: string;
    commitKey: string | null;
  };
  /** 服务端签发并校验的 EpisodeTrustDecision.effectiveClass。 */
  effectiveTrustClass: TrustClass;
  reducerResult: ReducerResult | null;
  /** facet-to-mastery-policy-v1 allowed 结果。 */
  policyAllowed: boolean;
  providerFailure: boolean;
  notAssessable: boolean;
  missingRequiredArtifact: boolean;
  assisted: boolean;
  diagnosticTrust: boolean;
  userDeclaredUnable: boolean;
  assessableTrustedPointResult: boolean;
  trustDecision: EpisodeTrustDecision | null;
  assessments: readonly RubricAssessment[];
  artifactText: { question: string; userAnswer: string } | null;
  scheduleOutput: {
    intervalDays: number;
    nextReviewAt: Date;
    policyVersion: string;
    policyEpoch: number;
  };
  now: Date;
}

export interface CommitEpisodeResult {
  ok: boolean;
  idempotent: boolean;
  disposition: EpisodeCommitDisposition;
  scheduleSideEffect: ScheduleSideEffect;
  attribution: CommitAttribution | null;
  casFailures: readonly CasFailureCode[];
  commitKey: string;
  reasonCodes: string[];
  projectionHash: string | null;
  contractInvariantViolation: boolean;
}

/**
 * COMMIT 事务编排：
 * 1. 幂等检查（commitKey 已存在 → 已提交过，不重复任何副作用，返回原 disposition）；
 * 2. 按 §4.3 固定顺序锁（buildCommitLockPlan）；
 * 3. 锁内读 CAS 快照 → evaluateCommitCas（单次 CAS）；
 * 4. deriveEpisodeCommitDisposition（互斥纯函数）；
 * 5. CAS 失败 → writeOperationalOnly（stale/cancelled/blocked 归因，0 学习副作用）
 *    + 写 commitKey（防止重试重复审计）；
 * 6. CAS 通过 → planCommitSideEffects → 按 disposition 写唯一事实落点 +
 *    schedule 副作用（恰一 active schedule）+ 同事务 outbox 派生 projection，
 *    最后写 commitKey（同一事务，Worker crash 整体回滚，重试不重复副作用）。
 *
 * 独立 Episode 不回滚：commitEpisode 单 Episode 幂等；多 Episode 由调用方逐
 * 个调用（任一 Episode 失败不影响其它已 commit Episode）。
 */
export async function commitEpisode(
  input: EpisodeCommitInput,
  port: CommitPort,
): Promise<CommitEpisodeResult> {
  const scope: WorkspaceUserScope = { workspaceId: input.workspaceId, userId: input.userId };
  const episode = input.episode;
  const decision = episode.schedulingDecision;
  const authorizedAction = decision.authorizedAction;
  const lockPlan = buildCommitLockPlan(authorizedAction);
  const nowIso = input.now.toISOString();
  const baseReasonCodes = [...decision.reasonCodes];

  // 1. 固定顺序锁（security_review MEDIUM #1 修复：幂等检查必须在锁内执行，
  //    避免 TOCTOU——并发重试同时读 null 双双进入事务）。
  await port.lockSteps(lockPlan.steps, scope, episode.episodeId);

  // 2. 幂等（锁内）：已提交过（事务已成功且副作用已持久化）→ 只还原 disposition。
  const existingKey = await port.getCommitKey(scope, episode.episodeId);
  if (existingKey !== null) {
    const parsed = parseCommitKey(existingKey);
    const disposition = parsed.valid
      ? parsed.disposition!
      : EpisodeCommitDisposition.OPERATIONAL_ONLY;
    return {
      ok: true,
      idempotent: true,
      disposition,
      scheduleSideEffect: dispositionToScheduleSideEffect(disposition),
      attribution: null,
      casFailures: [],
      commitKey: existingKey,
      reasonCodes: [...baseReasonCodes, "idempotent_replay"],
      projectionHash: null,
      contractInvariantViolation: false,
    };
  }

  // 3. 锁内读快照 + 单次 CAS。
  const snapshot = await port.loadCommitGuard(scope, episode.episodeId);
  const casInput: CommitCasInput = {
    runtimeEpochSnapshot: episode.runtimeEpochSnapshot,
    currentRuntimeEpoch: snapshot.currentRuntimeEpoch,
    episodeEpochAtPrepare: episode.episodeEpoch,
    currentEpisodeEpoch: snapshot.currentEpisodeEpoch,
    episodeStatus: snapshot.episodeStatus,
    contentRevisionAtPrepare: episode.contentRevisionAtPrepare,
    currentContentRevision: snapshot.currentContentRevision,
    contentFingerprintAtPrepare: episode.contentFingerprintAtPrepare,
    currentContentFingerprint: snapshot.currentContentFingerprint,
    schedulingDecisionHashAtPrepare: decision.decisionHash,
    currentSchedulingDecisionHash: snapshot.currentSchedulingDecisionHash,
    kill: snapshot.kill,
    authorizedAction,
    activePendingScheduleExists: snapshot.activePendingScheduleExists,
    inputScheduleActive: snapshot.inputScheduleActive,
    inputScheduleGenerationAtPrepare: decision.inputScheduleGeneration ?? null,
    currentInputScheduleGeneration: snapshot.currentInputScheduleGeneration,
  };
  const cas = evaluateCommitCas(casInput);

  // 4. disposition（互斥纯函数）。
  const derived = deriveEpisodeCommitDisposition({
    casAttribution: cas.attribution,
    providerFailure: input.providerFailure,
    notAssessable: input.notAssessable,
    missingRequiredArtifact: input.missingRequiredArtifact,
    assisted: input.assisted,
    practicePlan: episode.formalPlanKind === "practice",
    diagnosticTrust: input.diagnosticTrust,
    userDeclaredUnable: input.userDeclaredUnable,
    authorizedAction,
    effectiveTrustClass: input.effectiveTrustClass,
    assessableTrustedPointResult: input.assessableTrustedPointResult,
    policyAllowed: input.policyAllowed,
    reducerAssessable:
      input.reducerResult !== null &&
      input.reducerResult.result !== RubricSessionResult.NOT_ASSESSABLE,
  });
  const commitKey = deriveCommitKey({
    episodeId: episode.episodeId,
    disposition: derived.disposition,
    episodeEpoch: episode.episodeEpoch,
    schedulingDecisionHash: decision.decisionHash,
  });

  // 5. CAS 失败 → operational_only（整体归因），0 学习副作用。
  if (!cas.ok) {
    const write: OperationalOnlyWriteInput = {
      ...scope,
      episodeId: episode.episodeId,
      keyPointId: episode.keyPointId,
      attribution: cas.attribution ?? "blocked",
      casFailures: cas.failures,
      reasonCodes: derived.reasonCodes,
      now: new Date(nowIso),
    };
    await port.writeOperationalOnly(write);
    await port.setCommitKey(scope, episode.episodeId, commitKey);
    return {
      ok: false,
      idempotent: false,
      disposition: derived.disposition,
      scheduleSideEffect: "none",
      attribution: cas.attribution,
      casFailures: cas.failures,
      commitKey,
      reasonCodes: derived.reasonCodes,
      projectionHash: null,
      contractInvariantViolation: derived.contractInvariantViolation,
    };
  }

  // 6. 计划 + 分发（写操作全部经 port；真实实现同一事务，crash 整体回滚）。
  const plan = planCommitSideEffects({
    ...scope,
    disposition: derived.disposition,
    scheduleSideEffect: derived.scheduleSideEffect,
    episode,
    effectiveTrustClass: input.effectiveTrustClass,
    reducerResult: input.reducerResult,
    trustDecision: input.trustDecision,
    assessments: input.assessments,
    artifactText: input.artifactText,
    commitKey,
    scheduleOutput: input.scheduleOutput,
    now: nowIso,
  });

  switch (plan.disposition) {
    case EpisodeCommitDisposition.CANONICAL_MASTERY:
    case EpisodeCommitDisposition.CANONICAL_UNABLE:
      if (plan.canonicalEvent !== null) {
        await port.appendCanonicalEvent(plan.canonicalEvent);
      }
      if (plan.scheduleSideEffectInput !== null) {
        await port.applyScheduleSideEffect(plan.scheduleSideEffectInput);
      }
      break;
    case EpisodeCommitDisposition.CANONICAL_FACET_OBSERVATION:
      if (plan.facetWriteInput !== null) {
        await port.writeFacetObservation(plan.facetWriteInput);
      }
      break;
    case EpisodeCommitDisposition.PRACTICE_OR_DIAGNOSTIC:
      if (plan.practiceEventInput !== null) {
        await port.writePracticeEvent(plan.practiceEventInput);
      }
      break;
    case EpisodeCommitDisposition.OPERATIONAL_ONLY:
      if (plan.operationalWriteInput !== null) {
        await port.writeOperationalOnly(plan.operationalWriteInput);
      }
      break;
  }

  await port.setCommitKey(scope, episode.episodeId, plan.commitKey);

  return {
    ok: true,
    idempotent: false,
    disposition: plan.disposition,
    scheduleSideEffect: plan.scheduleSideEffect,
    attribution: null,
    casFailures: [],
    commitKey: plan.commitKey,
    reasonCodes: derived.reasonCodes,
    projectionHash: plan.projectionHash,
    contractInvariantViolation: plan.invariantViolation,
  };
}
