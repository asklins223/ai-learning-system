/**
 * 任务 06-4：并发竞态与回滚防护（纯函数 + 端口）。
 *
 * 冻结语义来源：01-2 §7.6（同锁域竞态）与 §7.7（stale、取消与 Episode 提交）。
 *
 * 覆盖：
 * 1. 同一 pending schedule 不能同时被旧 question-first submission 与新 Episode
 *    消费；数据库唯一约束（review_schedules_pending_unique_idx）与 target-level
 *    idempotency 为最终兜底（evaluatePendingSingleConsumer + 端口）；
 * 2. legacy reveal → new Episode lock、new reveal → legacy submit、
 *    Scene/Rubric/policy rollover 三组共享 contentExposureKey 竞态正确
 *    （evaluateContentExposureRace）；
 * 3. first artifact lock 后 rubric/target/evidence 不能改变；Key Point/Evidence/
 *    Rubric/Scene policy 任一内容失配 → stale，无正式副作用
 *    （evaluateFrozenContentIntegrity）；
 * 4. cancel 终止当前和未开始 Episode；已 commit 保留；partial commit 状态明确
 *    （evaluateCancelSemantics）；
 * 5. 所有 turn/tool/Critic 结果落库前重新比较 contract 的 runtimeEpochSnapshot +
 *    episodeEpoch（recompareEpochBeforePersist）；
 * 6. hard kill 后迟到响应只记低敏审计摘要（evaluateLateResponseAfterHardKill）；
 * 7. 断线恢复只读取 event/contract/artifact，不重复 Provider 调用和业务副作用
 *    （buildDisconnectRecoveryPlan）。
 *
 * 本模块只做纯函数判定与端口 shape 声明，不触碰数据库。
 */

import { computeContentExposureKey, buildGuardLockKey } from "./exposure-service.ts";

// ─── 1. pending schedule 单消费者 ─────────────────────────────────────────

export type PendingScheduleStatus = "pending" | "completed" | "cancelled" | "superseded";

export interface PendingScheduleRead {
  scheduleId: string;
  keyPointId: string;
  generation: number;
  status: PendingScheduleStatus;
}

export interface PendingScheduleConsumeCheck {
  /** 预冻结授权绑定的精确输入 schedule（01-2 §5.2 consume_pending） */
  requestedScheduleId: string;
  requestedGeneration: number;
  /** 数据库当前该 (workspace,user,keyPoint) 的全部 pending 行 */
  pendingSchedules: PendingScheduleRead[];
  /** review_schedules_pending_unique_idx 是否生效（每 key point 最多一条 pending） */
  uniqueIndexGuaranteesAtMostOnePending: boolean;
  /** target-level idempotency：该 key point 的 commit 账本已存在本 generation 消费记录 */
  idempotencyAlreadyConsumed: boolean;
  /** 是否存在竞争消费者（旧 question-first submission 或新 Episode 已持有） */
  competingConsumerActive: boolean;
}

export type PendingSingleConsumerReason =
  | "no_pending_schedule"
  | "schedule_not_found"
  | "schedule_not_pending"
  | "generation_mismatch"
  | "duplicate_consumer"
  | "idempotency_already_consumed"
  | "pending_unique_invariant_violated";

export type PendingSingleConsumerVerdict =
  | { allowed: true; consumeToken: { scheduleId: string; generation: number } }
  | { allowed: false; reason: PendingSingleConsumerReason };

/**
 * 同一 pending schedule 只能被一个消费者消费（纯函数判定）。
 * 数据库唯一约束（pending_unique_idx）与 target-level idempotency 是最终兜底：
 * - 唯一约束失效且出现多个 pending → fail closed；
 * - idempotency 账本已有记录 → 绝不重复消费；
 * - 竞争消费者已持有 → 拒绝（duplicate_consumer）。
 */
export function evaluatePendingSingleConsumer(
  input: PendingScheduleConsumeCheck,
): PendingSingleConsumerVerdict {
  if (input.idempotencyAlreadyConsumed) {
    return { allowed: false, reason: "idempotency_already_consumed" };
  }
  if (input.competingConsumerActive) {
    return { allowed: false, reason: "duplicate_consumer" };
  }
  if (input.pendingSchedules.length === 0) {
    return { allowed: false, reason: "no_pending_schedule" };
  }
  if (
    input.pendingSchedules.length > 1 &&
    !input.uniqueIndexGuaranteesAtMostOnePending
  ) {
    // 唯一约束失效 → 数据库层面兜底被绕过，fail closed。
    return { allowed: false, reason: "pending_unique_invariant_violated" };
  }
  const target = input.pendingSchedules.find(
    (s) => s.scheduleId === input.requestedScheduleId,
  );
  if (!target) {
    return { allowed: false, reason: "schedule_not_found" };
  }
  if (target.status !== "pending") {
    return { allowed: false, reason: "schedule_not_pending" };
  }
  if (target.generation !== input.requestedGeneration) {
    return { allowed: false, reason: "generation_mismatch" };
  }
  return {
    allowed: true,
    consumeToken: { scheduleId: target.scheduleId, generation: target.generation },
  };
}

// ─── 2. contentExposureKey 三组竞态（01-2 §7.6）───────────────────────────

export type ExposureRaceKind =
  | "legacy_reveal_then_new_episode_lock"
  | "new_reveal_then_legacy_submit"
  | "scene_rubric_policy_rollover";

export interface ExposureLegacyEntryState {
  /** legacy question-first 入口是否已 reveal */
  revealed: boolean;
  /** legacy 入口是否已 submit */
  submitted: boolean;
  /** legacy 是否已触发 assistance（内容辅助） */
  assistanceActivated: boolean;
}

export interface ExposureNewEpisodeState {
  /** 新 Episode 是否已 lock（已锁 artifact 冻结 pre-exposure snapshot） */
  locked: boolean;
  /** 新 Episode 是否已 reveal */
  revealed: boolean;
  /** lock 时是否冻结了 pre-exposure snapshot */
  preExposureSnapshotFrozen: boolean;
}

export interface ExposureRolloverState {
  /** Scene/Rubric/policy rollover 是否已发生（policy epoch 失配） */
  detected: boolean;
  /** lock 时的 policy epoch */
  lockedPolicyEpoch: number;
  /** 当前 policy epoch */
  currentPolicyEpoch: number;
}

export interface ExposureRaceContext {
  contentExposureKey: string;
  legacyEntry: ExposureLegacyEntryState;
  newEpisode: ExposureNewEpisodeState;
  rollover: ExposureRolloverState;
}

export type ExposureRaceVerdict =
  | {
      /** lock 先赢（01-2 §7.6）：已锁 artifact 冻结，之后 reveal 不追溯污染 */
      state: "lock_wins";
      reason: string;
      newEpisodeLockAllowed: true;
      legacyRevealAfterLockRecordsExposureOnly: true;
    }
  | {
      /** assistance 先赢：reveal 已发生，之后 lock 必须看到 practice-only */
      state: "assistance_wins";
      reason: string;
      lockSeesPracticeOnly: true;
    }
  | {
      /** 新 Episode 已 reveal，legacy submit 必须被阻止 */
      state: "legacy_submit_blocked";
      reason: string;
      legacySubmitBlocked: true;
    }
  | {
      /** Scene/Rubric/policy rollover：新 lock 被阻止（已锁 artifact 冻结保留） */
      state: "rollover_blocks_lock";
      reason: string;
      newEpisodeLockAllowed: false;
    }
  | { state: "consistent"; reason: string };

/**
 * 三组共享 contentExposureKey 竞态判定（纯函数，01-2 §7.6）：
 * - 组 1 legacy reveal → new Episode lock：assistance 先赢 → lock 必须看到
 *   practice-only（事务提交后才允许返回任何内容）；
 * - 组 2 new reveal → legacy submit：新 Episode 已 reveal 后，legacy submit 必须
 *   被阻止（不能把已暴露内容的答案当作正式结果）；
 * - 组 3 Scene/Rubric/policy rollover：policy epoch 失配 → 新 lock 被阻止，
 *   已锁 artifact 冻结保留但不得以新 policy 提交；
 * - lock 先赢：已锁 artifact 冻结 pre-exposure snapshot，之后 legacy reveal 只写
 *   exposure/cooldown，不追溯污染已锁 artifact。
 */
export function evaluateContentExposureRace(
  context: ExposureRaceContext,
): ExposureRaceVerdict {
  if (context.contentExposureKey.trim() === "") {
    return {
      state: "rollover_blocks_lock",
      reason: "contentExposureKey 为空（fail closed）",
      newEpisodeLockAllowed: false,
    };
  }

  // 组 3：Scene/Rubric/policy rollover 优先于 lock 胜负（内容失配 → stale）。
  if (context.rollover.detected) {
    if (!context.newEpisode.locked) {
      return {
        state: "rollover_blocks_lock",
        reason: `policy epoch 失配（locked=${context.rollover.lockedPolicyEpoch}, current=${context.rollover.currentPolicyEpoch}）：新 lock 被阻止`,
        newEpisodeLockAllowed: false,
      };
    }
    // 已锁 artifact 冻结保留，但不影响后续判定（commit 阶段由 stale 兜底）。
  }

  // lock 先赢：新 Episode 已锁且冻结 pre-exposure snapshot。
  if (context.newEpisode.locked && context.newEpisode.preExposureSnapshotFrozen) {
    return {
      state: "lock_wins",
      reason: "lock 先赢：已锁 artifact 冻结 pre-exposure snapshot，之后 reveal 只写 exposure/cooldown 不追溯污染",
      newEpisodeLockAllowed: true,
      legacyRevealAfterLockRecordsExposureOnly: true,
    };
  }

  // 组 1：legacy reveal → new Episode lock 必须看到 practice-only。
  if (
    (context.legacyEntry.revealed || context.legacyEntry.assistanceActivated) &&
    !context.newEpisode.locked
  ) {
    return {
      state: "assistance_wins",
      reason: "assistance/reveal 先赢：之后 lock 必须看到 practice-only（不能切换入口重置 exposure）",
      lockSeesPracticeOnly: true,
    };
  }

  // 组 2：new reveal → legacy submit 被阻止。
  if (context.newEpisode.revealed && !context.legacyEntry.submitted) {
    return {
      state: "legacy_submit_blocked",
      reason: "新 Episode 已 reveal：legacy submit 必须被阻止（读写同一 learning_unit_exposure aggregate 与 guard）",
      legacySubmitBlocked: true,
    };
  }

  return { state: "consistent", reason: "无竞态冲突" };
}

// ─── 3. lock 后冻结内容完整性（01-2 §7.7）────────────────────────────────

export interface FrozenRubricTargetRef {
  id: string;
  expectedTargetHash: string;
  evidenceRefIds: string[];
}

export interface FrozenContentSnapshot {
  /** lock 时冻结的 episodeTargetFingerprint */
  episodeTargetFingerprint: string;
  contentExposureKey: string;
  rubricTargets: FrozenRubricTargetRef[];
  /** evidenceId → content hash（lock 时冻结） */
  evidenceHashes: Record<string, string>;
  scenePolicyVersion: string;
  rubricPolicyVersion: string;
  assistancePolicyVersion: string;
}

export interface CurrentContentState {
  episodeTargetFingerprint: string;
  contentExposureKey: string;
  publishedContentRevision: number | string;
  rubricTargets: FrozenRubricTargetRef[];
  evidenceHashes: Record<string, string>;
  scenePolicyVersion: string;
  rubricPolicyVersion: string;
  assistancePolicyVersion: string;
}

export type ContentMismatchKind =
  | "key_point_content"
  | "evidence"
  | "rubric"
  | "scene_policy"
  | "assistance_policy";

export type FrozenContentIntegrityVerdict =
  | { ok: true }
  | { ok: false; stale: true; mismatch: ContentMismatchKind; sideEffects: "none" };

function hashesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, i) => bKeys[i] === k && a[k] === b[k]);
}

function rubricTargetsEqual(a: FrozenRubricTargetRef[], b: FrozenRubricTargetRef[]): boolean {
  if (a.length !== b.length) return false;
  const sort = (xs: FrozenRubricTargetRef[]) =>
    [...xs].sort((x, y) => x.id.localeCompare(y.id));
  const sa = sort(a);
  const sb = sort(b);
  return sa.every((t, i) => {
    const u = sb[i]!;
    if (t.id !== u.id || t.expectedTargetHash !== u.expectedTargetHash) return false;
    if (t.evidenceRefIds.length !== u.evidenceRefIds.length) return false;
    return [...t.evidenceRefIds].sort().every((r, j) => [...u.evidenceRefIds].sort()[j] === r);
  });
}

/**
 * first artifact lock 后 rubric/target/evidence 不可变（纯函数）。
 * Key Point / Evidence / Rubric / Scene policy 任一内容失配 → stale，无正式副作用。
 * fingerprint 与 contentExposureKey 为 canonical serialization（§7.7），
 * 先按组成部分细粒度比较以给出可审计 mismatch。
 */
export function evaluateFrozenContentIntegrity(
  frozen: FrozenContentSnapshot,
  current: CurrentContentState,
): FrozenContentIntegrityVerdict {
  if (frozen.assistancePolicyVersion !== current.assistancePolicyVersion) {
    return { ok: false, stale: true, mismatch: "assistance_policy", sideEffects: "none" };
  }
  if (frozen.scenePolicyVersion !== current.scenePolicyVersion) {
    return { ok: false, stale: true, mismatch: "scene_policy", sideEffects: "none" };
  }
  if (frozen.rubricPolicyVersion !== current.rubricPolicyVersion) {
    return { ok: false, stale: true, mismatch: "rubric", sideEffects: "none" };
  }
  if (!rubricTargetsEqual(frozen.rubricTargets, current.rubricTargets)) {
    return { ok: false, stale: true, mismatch: "rubric", sideEffects: "none" };
  }
  if (!hashesEqual(frozen.evidenceHashes, current.evidenceHashes)) {
    return { ok: false, stale: true, mismatch: "evidence", sideEffects: "none" };
  }
  if (
    frozen.episodeTargetFingerprint !== current.episodeTargetFingerprint ||
    frozen.contentExposureKey !== current.contentExposureKey
  ) {
    // 组成部分全部匹配但指纹失配 → 卡/claim/published revision 内容变化。
    return { ok: false, stale: true, mismatch: "key_point_content", sideEffects: "none" };
  }
  void current.publishedContentRevision;
  return { ok: true };
}

// ─── 4. cancel 语义（01-2 §7.7）──────────────────────────────────────────

export type EpisodeLifecycleStatus = "draft" | "active" | "completed" | "stale" | "cancelled";
export type EpisodeCommitState = "committed" | "partial_commit" | "not_committed";

export interface CancelTarget {
  episodeId: string;
  status: EpisodeLifecycleStatus;
  commitState: EpisodeCommitState;
}

export interface CancelSemanticsVerdict {
  /** 被终止（当前与未开始）：draft/active 且未 commit → 零副作用 */
  terminated: string[];
  /** 保留：已 commit 的 Episode（completed + committed） */
  preserved: string[];
  /** partial commit 状态明确：不静默回滚，明确标记 partial */
  partialCommitMarked: string[];
  /** 已 stale/cancelled：保持原状 */
  alreadyTerminal: string[];
}

/**
 * cancel 终止当前和未开始 Episode；已 commit 保留；partial commit 状态明确
 * （纯函数，01-2 §7.7 / 03-2 验收）。
 */
export function evaluateCancelSemantics(episodes: CancelTarget[]): CancelSemanticsVerdict {
  const verdict: CancelSemanticsVerdict = {
    terminated: [],
    preserved: [],
    partialCommitMarked: [],
    alreadyTerminal: [],
  };
  for (const ep of episodes) {
    if (ep.commitState === "committed") {
      verdict.preserved.push(ep.episodeId);
      continue;
    }
    if (ep.commitState === "partial_commit") {
      // 部分副作用已落库：不回滚已写事实，明确标记 partial（不假装完全 commit）。
      verdict.partialCommitMarked.push(ep.episodeId);
      if (ep.status === "active" || ep.status === "draft") {
        verdict.terminated.push(ep.episodeId);
      }
      continue;
    }
    if (ep.status === "completed") {
      // completed 但未 commit（异常状态）→ 防御：不静默回滚，标记 partial。
      verdict.partialCommitMarked.push(ep.episodeId);
      continue;
    }
    if (ep.status === "stale" || ep.status === "cancelled") {
      verdict.alreadyTerminal.push(ep.episodeId);
      continue;
    }
    // draft / active 且未 commit → 终止（零副作用）。
    verdict.terminated.push(ep.episodeId);
  }
  return verdict;
}

// ─── 5. epoch 重比较（01-2 §7.7 / 03-6）──────────────────────────────────

export interface EpochRecompareInput {
  contractRuntimeEpoch: number;
  contractEpisodeEpoch: number;
  currentRuntimeEpoch: number | null;
  currentEpisodeEpoch: number | null;
}

export type EpochRecompareVerdict =
  | { ok: true }
  | { ok: false; code: "epoch_missing" | "epoch_mismatch" };

/**
 * 所有 turn/tool/Critic 结果落库前重新比较 contract 的 runtimeEpochSnapshot +
 * episodeEpoch（纯函数）。当前值缺失（null）→ fail closed 为 epoch_missing。
 */
export function recompareEpochBeforePersist(
  input: EpochRecompareInput,
): EpochRecompareVerdict {
  if (
    input.currentRuntimeEpoch === null ||
    input.currentEpisodeEpoch === null
  ) {
    return { ok: false, code: "epoch_missing" };
  }
  if (
    input.currentRuntimeEpoch !== input.contractRuntimeEpoch ||
    input.currentEpisodeEpoch !== input.contractEpisodeEpoch
  ) {
    return { ok: false, code: "epoch_mismatch" };
  }
  return { ok: true };
}

// ─── 6. hard kill 后迟到响应（01-2 §7.7）─────────────────────────────────

export type LateResponseKind = "provider" | "asr" | "critic" | "turn" | "tool";

export interface LateResponseInput {
  /** hard kill 是否已触发 */
  killFired: boolean;
  responseKind: LateResponseKind;
  contractEpoch: { runtimeEpoch: number; episodeEpoch: number };
  currentEpoch: { runtimeEpoch: number | null; episodeEpoch: number | null };
  /** 响应是否含用户内容（transcript/answer/理由） */
  containsUserContent: boolean;
}

export type LateResponseVerdict =
  | {
      handled: "low_sensitivity_audit";
      /** 只记不含用户内容的审计摘要（content-free） */
      auditSummary: { responseKind: LateResponseKind; epochMismatch: boolean };
      writeProbe: false;
      writeArtifact: false;
      writeAssessment: false;
      canRestoreTrust: false;
    }
  | { handled: "persist"; reason: string }
  | { handled: "discard"; reason: string };

/**
 * hard kill 后迟到 Provider/ASR/Critic 响应只记低敏审计摘要，不写
 * probe/artifact/assessment staging，也不能恢复为 trusted（纯函数）。
 * epoch 失配（非 kill）同样拒绝落库并记审计。
 */
export function evaluateLateResponseAfterHardKill(
  input: LateResponseInput,
): LateResponseVerdict {
  if (input.killFired) {
    return {
      handled: "low_sensitivity_audit",
      auditSummary: { responseKind: input.responseKind, epochMismatch: false },
      writeProbe: false,
      writeArtifact: false,
      writeAssessment: false,
      canRestoreTrust: false,
    };
  }
  const epoch = recompareEpochBeforePersist({
    contractRuntimeEpoch: input.contractEpoch.runtimeEpoch,
    contractEpisodeEpoch: input.contractEpoch.episodeEpoch,
    currentRuntimeEpoch: input.currentEpoch.runtimeEpoch,
    currentEpisodeEpoch: input.currentEpoch.episodeEpoch,
  });
  if (!epoch.ok) {
    return {
      handled: "low_sensitivity_audit",
      auditSummary: {
        responseKind: input.responseKind,
        epochMismatch: epoch.code === "epoch_mismatch",
      },
      writeProbe: false,
      writeArtifact: false,
      writeAssessment: false,
      canRestoreTrust: false,
    };
  }
  if (input.containsUserContent) {
    // 正常落库路径（critic/turn/tool 结果），epoch 匹配时允许持久化。
    return { handled: "persist", reason: "epoch 匹配且响应可落库" };
  }
  return { handled: "discard", reason: "空响应，无内容可落库" };
}

// ─── 7. 断线恢复（01-2 §7.7）─────────────────────────────────────────────

export interface OutstandingExternalCall {
  callId: string;
  kind: LateResponseKind;
  completed: boolean;
}

export interface DisconnectRecoveryInput {
  episodeStatus: EpisodeLifecycleStatus;
  /** event/contract/artifact 是否已持久化 */
  eventsPersisted: boolean;
  contractPersisted: boolean;
  artifactsPersisted: boolean;
  outstandingExternalCalls: OutstandingExternalCall[];
}

export type DisconnectRecoveryVerdict = {
  /** 恢复动作 */
  action: "resume_local" | "resume_readonly" | "terminate";
  reason: string;
  /** 恢复时是否重新发起 Provider 调用（断线恢复必须为 false） */
  reissueExternalCalls: boolean;
  /** 恢复时是否重复业务副作用（必须为 false） */
  repeatBusinessSideEffects: boolean;
  /** 允许读取的持久化事实 */
  readOnlySources: Array<"events" | "contract" | "artifacts">;
};

/**
 * 断线恢复只读取 event/contract/artifact，不重复 Provider 调用和业务副作用
 * （纯函数）。
 * - contract 未持久化 → 无法可信恢复，terminate（要求重新 PREPARE，不重放）；
 * - 终态（completed/stale/cancelled）→ resume_readonly；
 * - 进行中（draft/active）→ resume_local：从已落 contract/artifact 断点继续，
 *   未完成的外部调用不重复发起（依赖超时/审计，不重复业务副作用）。
 */
export function buildDisconnectRecoveryPlan(
  input: DisconnectRecoveryInput,
): DisconnectRecoveryVerdict {
  const readOnlySources = [
    ...(input.eventsPersisted ? (["events"] as const) : []),
    ...(input.contractPersisted ? (["contract"] as const) : []),
    ...(input.artifactsPersisted ? (["artifacts"] as const) : []),
  ];
  if (!input.contractPersisted) {
    return {
      action: "terminate",
      reason: "contract 未持久化：无法可信恢复，需重新 PREPARE",
      reissueExternalCalls: false,
      repeatBusinessSideEffects: false,
      readOnlySources,
    };
  }
  if (
    input.episodeStatus === "completed" ||
    input.episodeStatus === "stale" ||
    input.episodeStatus === "cancelled"
  ) {
    return {
      action: "resume_readonly",
      reason: `Episode 终态（${input.episodeStatus}）：只读回放，无任何重复副作用`,
      reissueExternalCalls: false,
      repeatBusinessSideEffects: false,
      readOnlySources,
    };
  }
  const anyOutstanding = input.outstandingExternalCalls.some((c) => !c.completed);
  return {
    action: "resume_local",
    reason: anyOutstanding
      ? "断点恢复进行中 Episode：未完成外部调用不重复发起（记审计，等超时）"
      : "断点恢复进行中 Episode：从已落 contract/artifact 继续",
    reissueExternalCalls: false,
    repeatBusinessSideEffects: false,
    readOnlySources,
  };
}

// ─── 竞态工具（复用 exposure-service 冻结公式，01-2 §7.6）────────────────

/** contentExposureKey 冻结公式（H(workspace,user,keyPoint,revision,claim,evidence)）。 */
export function deriveContentExposureKey(input: {
  workspaceId: string;
  userId: string;
  keyPointId: string;
  publishedContentRevision: number | string;
  normalizedClaimHash: string;
  sortedEvidenceContentHashes: readonly string[];
}): string {
  return computeContentExposureKey(input);
}

/** learning-unit guard 锁键（enter-practice/reveal 与 confirm-and-lock/submit 必须锁同一键）。 */
export function computeExposureLockKey(
  workspaceId: string,
  userId: string,
  contentExposureKey: string,
): string {
  return buildGuardLockKey(workspaceId, userId, contentExposureKey);
}

// ─── 端口（06-2 集成层注入）───────────────────────────────────────────────

/**
 * pending schedule 消费端口：数据库唯一约束 + target-level idempotency 为最终
 * 兜底（01-2 §7.7）。实现必须同事务执行「锁 pending → 校验 generation →
 * 置 completed → 写 successor」，唯一约束冲突/幂等命中时返回 consumed=false。
 */
export interface PendingScheduleConsumerPort {
  tryConsume(input: {
    workspaceId: string;
    userId: string;
    keyPointId: string;
    inputScheduleId: string;
    inputScheduleGeneration: number;
    idempotencyKey: string;
  }): Promise<{
    consumed: boolean;
    successorScheduleId: string | null;
    reason: string | null;
  }>;
}

/**
 * learning-unit exposure guard 端口：旧 question-first 与新 Episode 读写同一
 * (workspace,user,contentExposureKey) aggregate 和 guard，不能靠切换入口重置
 * （01-2 §7.6）。reveal 与 submit/lock 固定锁序并使用 user action nonce。
 */
export interface LearningUnitGuardPort {
  enterPractice(input: {
    workspaceId: string;
    userId: string;
    keyPointId: string;
    contentExposureKey: string;
    userActionNonce: string;
  }): Promise<{ ok: boolean; reason: string | null }>;
  reveal(input: {
    workspaceId: string;
    userId: string;
    keyPointId: string;
    contentExposureKey: string;
    userActionNonce: string;
  }): Promise<{ ok: boolean; reason: string | null }>;
  submit(input: {
    workspaceId: string;
    userId: string;
    keyPointId: string;
    contentExposureKey: string;
    userActionNonce: string;
  }): Promise<{ ok: boolean; reason: string | null }>;
}

/** 低敏审计端口：hard kill 迟到响应 / 断线恢复只记不含用户内容的审计摘要。 */
export interface LowSensitivityAuditPort {
  record(entry: {
    workspaceId: string;
    userId: string;
    episodeId: string;
    auditKind: "late_response_after_kill" | "late_response_epoch_mismatch" | "recovery_readonly" | "disconnect_recovery";
    responseKind?: LateResponseKind;
    /** 审计必须 content-free：不携带 transcript/answer/rationale */
    contentFree: true;
  }): Promise<void>;
}
