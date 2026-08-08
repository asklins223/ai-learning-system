/**
 * 任务 06-3：EpisodeCommitDisposition 推导与分派（纯函数）。
 *
 * 冻结语义来源：01-2 §8.5（EpisodeCommitDispositionV1 矩阵）与 §8.6（disposition 优先级）。
 *
 * 五类 disposition：
 * - `canonical_mastery`：写现有 validation event（review origin 同时写 review
 *   attempt/outcome），create/consume 后恰好一个 active schedule，同 generation
 *   exactly-once；
 * - `canonical_unable`：用户明确 unable 时按冻结 unable policy 恰好一个 active
 *   schedule，不写"已掌握"；
 * - `canonical_facet_observation`：写扩展后的 `validation_point_assessments` 作为
 *   唯一 canonical facet fact + outbox；0 overall outcome、0 review attempt、
 *   0 schedule；
 * - `practice_or_diagnostic`：写 learning session practice/diagnostic event；
 *   0 canonical projection、0 schedule；
 * - `operational_only`：not-assessable / provider failure / stale / cancel → retryable
 *   或 terminal operational state 与低敏审计；0 学习副作用。
 *
 * 本模块只做互斥纯函数推导与分派（facts + schedule 副作用描述 + 幂等键），
 * 不触碰数据库；实际落库由 06-2 Episode COMMIT 集成层注入端口执行。任何组合
 * 只能命中一个 disposition，未命中分支一律 fail closed 为 operational_only 并
 * 标记 contract invariant violation（01-2 §8.6 第 6 步）。
 */

import { TrustClass, ValidationOutcome } from "@ailearn/shared";
import type {
  AuthorizedAction,
  EpisodeTrustDecision,
  FormalPlanKind,
  ReducerResult,
  RubricSessionResult,
  ScheduleSideEffect,
} from "./trust-service.ts";
import type {
  EpisodeFormalPlan,
  LearningSessionOrigin,
  OfficialSchedulingDecisionV1,
} from "./session-service.ts";

// ─── 五类 kind（供测试断言全覆盖与互斥）───────────────────────────────────

export const EPISODE_DISPOSITION_KINDS = [
  "canonical_mastery",
  "canonical_unable",
  "canonical_facet_observation",
  "practice_or_diagnostic",
  "operational_only",
] as const;

export type EpisodeDispositionKind = (typeof EPISODE_DISPOSITION_KINDS)[number];

// ─── 输入：Episode COMMIT 前的冻结视角 ────────────────────────────────────

export interface EpisodeCommitDispositionInput {
  contract: {
    episodeId: string;
    keyPointId: string;
    /** 入口（01-2 §5：origin=review 时写 review attempt/outcome） */
    origin: LearningSessionOrigin;
    formalPlan: EpisodeFormalPlan;
    /** 预冻结调度授权（01-2 §5.2 OfficialSchedulingDecisionV1） */
    schedulingDecision: OfficialSchedulingDecisionV1;
  };
  assessment: {
    /** 完整 Episode：全部 required Scene 完成并锁定 */
    episodeComplete: boolean;
    /** rubric-session-reducer-v2 输出；null = 从未成功评估 */
    reducerResult: ReducerResult | null;
    /** 服务端签发的 EpisodeTrustDecision；null = 从未签发 */
    trustDecision: EpisodeTrustDecision | null;
    /** 用户明确声明 unable（assessmentSource=user_declared_unable） */
    userDeclaredUnable: boolean;
    /** 缺 required artifact（任何 required Scene 无锁定 Artifact） */
    requiredArtifactsComplete: boolean;
    /** 获得内容辅助（assistance 降级为 practice_only） */
    assisted: boolean;
  };
  operational: {
    /** episodeTargetFingerprint / contentExposureKey / content 失配 */
    stale: boolean;
    /** 会话或 Episode 被取消 */
    cancelled: boolean;
    /** hard kill（runtime kill 已触发） */
    killed: boolean;
    /** Provider/ASR/Critic 失败导致不可评估 */
    providerFailure: boolean;
    /** structured_mastery_bundle 未完成（只保留 support artifact） */
    incompleteSilentBundle: boolean;
  };
}

// ─── 事实落点描述（不触库；供 06-2 集成层映射）────────────────────────────

/** validation_events.outcome 值（ValidationOutcome 枚举） */
export type ValidationOutcomeCode =
  | typeof ValidationOutcome.PRELIMINARY_UNDERSTANDING
  | typeof ValidationOutcome.UNCLEAR_EXPRESSION
  | typeof ValidationOutcome.MISUNDERSTANDING
  | typeof ValidationOutcome.UNKNOWN;

export type ReviewAttemptOutcomeCode = "correct" | "partial" | "incorrect" | "unable";

/** 低敏审计（不含用户内容的摘要） */
export type OperationalAuditKind =
  | "stale"
  | "cancelled"
  | "killed"
  | "provider_failure"
  | "not_assessable"
  | "missing_required_artifact"
  | "incomplete_silent_bundle"
  | "contract_invariant_violation";

export type OperationalKind = "retryable" | "terminal";

export type DispositionFact =
  | {
      type: "validation_event";
      /** 映射后的现有 validation outcome（canonical_mastery / canonical_unable） */
      outcome: ValidationOutcomeCode;
      /** unable 时不写"已掌握"（mastered=false） */
      mastered: boolean;
    }
  | {
      type: "review_attempt";
      outcome: ReviewAttemptOutcomeCode;
      skipReason: string | null;
    }
  | {
      /** validation_point_assessments：唯一 canonical facet fact */
      type: "point_assessments";
      assessmentCount: number;
    }
  | {
      /** learning session practice/diagnostic event（0 canonical projection） */
      type: "practice_event";
      eventKind: "practice" | "diagnostic";
    }
  | {
      /** incomplete silent bundle 的已完成 Scene 只保留为 support artifact */
      type: "support_artifact_only";
    }
  | {
      type: "operational_audit";
      operationalKind: OperationalKind;
      auditKind: OperationalAuditKind;
    };

/** outbox 投影动作（低敏摘要；facet.observation 为 02-9 的扩展事件类型） */
export type OutboxAction =
  | { eventType: "validation.event"; action: "validated" | "misunderstood" }
  | { eventType: "review.attempt"; action: "reviewed" }
  | { eventType: "facet.observation"; action: "facet_observed" };

// ─── 判定结果（discriminated union，五类互斥）─────────────────────────────

export interface EpisodeCommitDisposition {
  kind: EpisodeDispositionKind;
  /** 命中的原因码（可审计） */
  reasonCodes: string[];
  /** policy 层允许的唯一 schedule 副作用；"none" = 0 写 */
  scheduleSideEffect: ScheduleSideEffect;
  /** create/consume 后必须恰好一个 active schedule 的意图 */
  requireExactlyOneActiveSchedule: boolean;
  /** consume_pending 最多消费一次 */
  consumeAtMostOnce: boolean;
  /** 同 generation exactly-once 的幂等键（06-2 集成层按此幂等） */
  idempotencyKey: string;
  /** 事实落点（0..n；operational_only 学习副作用恒为空） */
  facts: DispositionFact[];
  /** outbox 投影动作 */
  outboxActions: OutboxAction[];
  /** 理论上不可能的组合命中（01-2 §8.6 第 6 步 fail closed 标记） */
  invariantViolation: boolean;
}

// ─── reducer → 现有 canonical outcome 映射（01-2 §8.4）────────────────────

/** rubric-session-reducer-v2 四态 → validation_events.outcome 枚举 */
export function mapReducerResultToValidationOutcome(
  result: RubricSessionResult,
): ValidationOutcomeCode {
  switch (result) {
    case "pass":
      return ValidationOutcome.PRELIMINARY_UNDERSTANDING;
    case "partial":
      return ValidationOutcome.UNCLEAR_EXPRESSION;
    case "fail":
      return ValidationOutcome.MISUNDERSTANDING;
    case "not_assessable":
      // operational_only 路径不会走到这里；防御性 fail closed。
      return ValidationOutcome.UNKNOWN;
  }
}

/** rubric-session-reducer-v2 四态 → review_attempts.outcome（review origin） */
export function mapReducerResultToReviewAttemptOutcome(
  result: RubricSessionResult,
): Exclude<ReviewAttemptOutcomeCode, "unable"> {
  switch (result) {
    case "pass":
      return "correct";
    case "partial":
      return "partial";
    case "fail":
      return "incorrect";
    case "not_assessable":
      return "incorrect"; // not_assessable 不进 mastery；防御性值
  }
}

// ─── 优先级判定（01-2 §8.6）───────────────────────────────────────────────

function isAuthorizedScheduling(
  action: AuthorizedAction,
): action is "create_initial" | "consume_pending" {
  return action === "create_initial" || action === "consume_pending";
}

/**
 * §8.6 优先级 1：stale/cancel/kill/provider failure/not-assessable/缺 required
 * artifact → operational_only；incomplete silent bundle 在此结束（只保留 support
 * artifact，绝不因 record_only 落入 facet canonical fact）。
 *
 * user_declared_unable 是独立用户事实（现有 unable 路径不依赖评估：no AI call），
 * 因此在用户声明 unable 时跳过 reducer/trust/not-assessable/required-artifact 检查，
 * 交给优先级 3（canonical_unable）或 practice/diagnostic 处理；但仍被
 * stale/cancel/kill/bundle/provider failure 拦截（操作层事实优先）。
 */
function isOperationalOnly(input: EpisodeCommitDispositionInput): boolean {
  const op = input.operational;
  if (
    op.stale || op.cancelled || op.killed ||
    op.incompleteSilentBundle || op.providerFailure
  ) {
    return true;
  }
  if (input.assessment.userDeclaredUnable) return false;
  const a = input.assessment;
  if (!a.requiredArtifactsComplete) return true;
  if (a.reducerResult === null || a.trustDecision === null) return true;
  if (a.reducerResult.result === "not_assessable") return true;
  if (a.trustDecision.effectiveClass === TrustClass.NOT_ASSESSABLE) return true;
  return false;
}

/**
 * §8.6 优先级 2：assisted、practice plan、diagnostic trust 或 authorizedAction=
 * no_effect → practice_or_diagnostic。
 */
function isPracticeOrDiagnostic(input: EpisodeCommitDispositionInput): boolean {
  const a = input.assessment;
  const sd = input.contract.schedulingDecision;
  if (a.assisted) return true;
  if (input.contract.formalPlan.kind === "practice") return true;
  if (sd.authorizedAction === "no_effect") return true;
  const trust = a.trustDecision?.effectiveClass;
  return (
    trust === TrustClass.PRACTICE_ONLY || trust === TrustClass.DIAGNOSTIC_ONLY
  );
}

/** §8.6 优先级 4 条件：mastery_eligible + 调度授权。 */
function isCanonicalMastery(input: EpisodeCommitDispositionInput): boolean {
  return (
    input.assessment.trustDecision?.effectiveClass === TrustClass.MASTERY_ELIGIBLE &&
    isAuthorizedScheduling(input.contract.schedulingDecision.authorizedAction) &&
    input.assessment.episodeComplete &&
    input.assessment.reducerResult !== null &&
    input.assessment.reducerResult.result !== "not_assessable"
  );
}

/** §8.6 优先级 5 条件：assessable trusted point + record_only（仅 facet_only plan）。 */
function isCanonicalFacetObservation(input: EpisodeCommitDispositionInput): boolean {
  const sd = input.contract.schedulingDecision;
  if (sd.authorizedAction !== "record_only") return false;
  if (input.contract.formalPlan.kind !== "facet_only") return false;
  if (!input.assessment.episodeComplete) return false;
  const trust = input.assessment.trustDecision?.effectiveClass;
  return (
    trust === TrustClass.FACET_ELIGIBLE || trust === TrustClass.MASTERY_ELIGIBLE
  );
}

/** 契约不变量（预冻结授权组合非法 → fail closed）。 */
function contractInvariantViolation(input: EpisodeCommitDispositionInput): string | null {
  const sd = input.contract.schedulingDecision;
  if (sd.authorizedAction === "consume_pending" && !sd.inputScheduleId) {
    return "consume_pending_without_input_schedule";
  }
  if (sd.authorizedAction === "consume_pending" && sd.inputScheduleGeneration === undefined) {
    return "consume_pending_without_input_generation";
  }
  // 01-2 §5.2：facet_only 必须配 record_only，practice 必须配 no_effect。
  if (sd.authorizedAction === "record_only" && input.contract.formalPlan.kind !== "facet_only") {
    return "record_only_without_facet_only_plan";
  }
  if (sd.authorizedAction === "no_effect" && input.contract.formalPlan.kind !== "practice") {
    return "no_effect_without_practice_plan";
  }
  if (sd.authorizedAction === "create_initial" && input.contract.formalPlan.kind === "practice") {
    return "create_initial_with_practice_plan";
  }
  if (sd.authorizedAction === "consume_pending" && input.contract.formalPlan.kind === "practice") {
    return "consume_pending_with_practice_plan";
  }
  return null;
}

// ─── 幂等键（同 generation exactly-once 的端口契约）────────────────────────

function idempotencyKeyFor(input: EpisodeCommitDispositionInput): string {
  const sd = input.contract.schedulingDecision;
  const episodeId = input.contract.episodeId;
  switch (sd.authorizedAction) {
    case "consume_pending":
      return `commit:consume:${episodeId}:${sd.inputScheduleId}:${sd.inputScheduleGeneration}`;
    case "create_initial":
      return `commit:create:${episodeId}:${input.contract.keyPointId}`;
    case "record_only":
      return `commit:facet:${episodeId}`;
    case "no_effect":
      return `commit:practice:${episodeId}`;
  }
}

// ─── 构造器 ───────────────────────────────────────────────────────────────

function baseDisposition(
  input: EpisodeCommitDispositionInput,
  kind: EpisodeDispositionKind,
  reasonCodes: string[],
  scheduleSideEffect: ScheduleSideEffect,
  consumeAtMostOnce: boolean,
  facts: DispositionFact[],
  outboxActions: OutboxAction[],
  invariantViolation: boolean,
): EpisodeCommitDisposition {
  return {
    kind,
    reasonCodes,
    scheduleSideEffect,
    requireExactlyOneActiveSchedule:
      scheduleSideEffect === "create_initial" || scheduleSideEffect === "consume_pending",
    consumeAtMostOnce,
    idempotencyKey: invariantViolation
      ? `commit:operational:${input.contract.episodeId}`
      : idempotencyKeyFor(input),
    facts,
    outboxActions,
    invariantViolation,
  };
}

function buildMastery(input: EpisodeCommitDispositionInput): EpisodeCommitDisposition {
  const sd = input.contract.schedulingDecision;
  const result = input.assessment.reducerResult!;
  const action = sd.authorizedAction as "create_initial" | "consume_pending";
  const outcome = mapReducerResultToValidationOutcome(result.result);
  const reviewOutcome = mapReducerResultToReviewAttemptOutcome(result.result);

  const facts: DispositionFact[] = [
    { type: "validation_event", outcome, mastered: true },
  ];
  const outbox: OutboxAction[] = [
    {
      eventType: "validation.event",
      action: outcome === ValidationOutcome.MISUNDERSTANDING ? "misunderstood" : "validated",
    },
  ];
  if (input.contract.origin === "review") {
    facts.push({ type: "review_attempt", outcome: reviewOutcome, skipReason: null });
    outbox.push({ eventType: "review.attempt", action: "reviewed" });
  }
  return baseDisposition(
    input,
    "canonical_mastery",
    [
      "mastery_eligible",
      `authorized_action:${action}`,
      result.result,
      ...(input.contract.origin === "review" ? ["review_origin_writes_attempt"] : []),
    ],
    action,
    action === "consume_pending",
    facts,
    outbox,
    false,
  );
}

function buildUnable(input: EpisodeCommitDispositionInput): EpisodeCommitDisposition {
  const sd = input.contract.schedulingDecision;
  const action = sd.authorizedAction as "create_initial" | "consume_pending";
  const facts: DispositionFact[] = [
    {
      type: "validation_event",
      outcome: ValidationOutcome.UNKNOWN,
      mastered: false,
    },
  ];
  if (input.contract.origin === "review") {
    facts.push({ type: "review_attempt", outcome: "unable", skipReason: "unable" });
  }
  return baseDisposition(
    input,
    "canonical_unable",
    [
      "user_declared_unable",
      `unable_policy_authorized_action:${action}`,
      "not_mastered",
    ],
    action,
    action === "consume_pending",
    facts,
    [],
    false,
  );
}

function buildFacet(input: EpisodeCommitDispositionInput): EpisodeCommitDisposition {
  return baseDisposition(
    input,
    "canonical_facet_observation",
    ["record_only_facet_observation", "no_overall_outcome", "no_review_attempt", "no_schedule_side_effect"],
    "none",
    false,
    [
      {
        type: "point_assessments",
        assessmentCount: input.assessment.trustDecision?.sourceArtifactIds.length ?? 1,
      },
    ],
    [{ eventType: "facet.observation", action: "facet_observed" }],
    false,
  );
}

function buildPractice(input: EpisodeCommitDispositionInput): EpisodeCommitDisposition {
  const trust = input.assessment.trustDecision?.effectiveClass;
  const eventKind: "practice" | "diagnostic" =
    trust === TrustClass.DIAGNOSTIC_ONLY ? "diagnostic" : "practice";
  return baseDisposition(
    input,
    "practice_or_diagnostic",
    [
      eventKind === "diagnostic" ? "diagnostic_trust" : "practice_only",
      "no_canonical_projection",
      "no_schedule_side_effect",
    ],
    "none",
    false,
    [{ type: "practice_event", eventKind }],
    [],
    false,
  );
}

function operationalAuditKind(input: EpisodeCommitDispositionInput): OperationalAuditKind {
  const op = input.operational;
  if (op.stale) return "stale";
  if (op.cancelled) return "cancelled";
  if (op.killed) return "killed";
  if (op.providerFailure) return "provider_failure";
  if (op.incompleteSilentBundle) return "incomplete_silent_bundle";
  const a = input.assessment;
  if (!a.requiredArtifactsComplete) return "missing_required_artifact";
  if (a.reducerResult === null || a.reducerResult.result === "not_assessable") return "not_assessable";
  if (a.trustDecision === null || a.trustDecision.effectiveClass === TrustClass.NOT_ASSESSABLE) {
    return "not_assessable";
  }
  return "not_assessable";
}

function operationalKindFor(auditKind: OperationalAuditKind): OperationalKind {
  switch (auditKind) {
    case "stale":
    case "cancelled":
    case "killed":
    case "incomplete_silent_bundle":
      return "terminal";
    case "provider_failure":
    case "not_assessable":
    case "missing_required_artifact":
      return "retryable";
    case "contract_invariant_violation":
      return "terminal";
  }
}

function buildOperational(
  input: EpisodeCommitDispositionInput,
  auditKind: OperationalAuditKind,
  invariantViolation: boolean,
): EpisodeCommitDisposition {
  const facts: DispositionFact[] = [
    { type: "operational_audit", operationalKind: operationalKindFor(auditKind), auditKind },
  ];
  if (input.operational.incompleteSilentBundle) {
    // 01-2 §8.6：incomplete bundle 在第 1 步结束，只保留 support artifact。
    facts.push({ type: "support_artifact_only" });
  }
  return baseDisposition(
    input,
    "operational_only",
    [auditKind, "zero_learning_side_effects"],
    "none",
    false,
    facts,
    [],
    invariantViolation,
  );
}

// ─── 主判定（互斥，无未命中分支）──────────────────────────────────────────

/**
 * 推导唯一 EpisodeCommitDisposition（01-2 §8.6 优先级链 1..6）。
 *
 * 互斥性保证：isOperationalOnly → isPracticeOrDiagnostic → isCanonicalUnable →
 * isCanonicalMastery → isCanonicalFacetObservation 顺序判定；每条分支 return 后
 * 不可能落入其他分支；最终 else 无条件 fail closed 为 operational_only。
 */
export function deriveEpisodeCommitDisposition(
  input: EpisodeCommitDispositionInput,
): EpisodeCommitDisposition {
  // 契约不变量非法组合 → fail closed（01-2 §8.6 第 6 步）。
  const invariant = contractInvariantViolation(input);
  if (invariant !== null) {
    return buildOperational(input, "contract_invariant_violation", true);
  }

  if (isOperationalOnly(input)) {
    return buildOperational(input, operationalAuditKind(input), false);
  }

  if (isPracticeOrDiagnostic(input)) {
    return buildPractice(input);
  }

  // §8.6 优先级 3：user_declared_unable 是强信号——
  // 有 create/consume 调度授权 → canonical_unable（恰好一个 active schedule）；
  // 否则归入 practice/diagnostic，绝不落 facet/mastery。
  if (input.assessment.userDeclaredUnable) {
    if (isAuthorizedScheduling(input.contract.schedulingDecision.authorizedAction)) {
      return buildUnable(input);
    }
    return buildPractice(input);
  }

  if (isCanonicalMastery(input)) {
    return buildMastery(input);
  }

  if (isCanonicalFacetObservation(input)) {
    return buildFacet(input);
  }

  // 其余组合 fail closed（01-2 §8.6 第 6 步）：记录 contract invariant violation。
  return buildOperational(input, "contract_invariant_violation", true);
}

// ─── 分派副作用签名（供集成层/测试断言 0 副作用不变量）────────────────────

export interface DispositionSideEffectSignature {
  /** 是否写 canonical validation/review/understanding 事实（含 outbox projection） */
  canonicalProjection: boolean;
  /** 是否写 review_attempt */
  reviewAttempt: boolean;
  /** 是否写 overall validation outcome */
  overallOutcome: boolean;
  /** 是否写 validation_point_assessments（facet） */
  pointAssessments: boolean;
  /** schedule 副作用 */
  scheduleSideEffect: ScheduleSideEffect;
  /** 是否有任何 canonical 学习副作用 */
  learningSideEffects: boolean;
}

/**
 * 从 disposition 推导副作用签名（单一事实来源）。
 * - canonical_facet_observation：0 overall outcome、0 review attempt、0 schedule；
 * - practice_or_diagnostic：0 canonical projection、0 schedule；
 * - operational_only：0 学习副作用。
 */
export function deriveSideEffectSignature(
  disposition: EpisodeCommitDisposition,
): DispositionSideEffectSignature {
  const reviewAttempt = disposition.facts.some((f) => f.type === "review_attempt");
  const overallOutcome = disposition.facts.some(
    (f) => f.type === "validation_event" && f.mastered,
  );
  const pointAssessments = disposition.facts.some((f) => f.type === "point_assessments");
  const canonicalProjection =
    disposition.outboxActions.length > 0 || reviewAttempt || overallOutcome;
  const learningSideEffects =
    canonicalProjection || pointAssessments ||
    disposition.scheduleSideEffect !== "none";
  return {
    canonicalProjection,
    reviewAttempt,
    overallOutcome,
    pointAssessments,
    scheduleSideEffect: disposition.scheduleSideEffect,
    learningSideEffects,
  };
}

// ─── 端口：副作用执行契约（06-2 集成层注入）───────────────────────────────

export interface ScheduleCommitPort {
  /** create_initial：恰好一个 initial schedule（无 active pending 前置校验） */
  createInitial(options: {
    workspaceId: string;
    userId: string;
    keyPointId: string;
    decisionRef: string;
    policyEpoch: number;
    idempotencyKey: string;
  }): Promise<{ created: boolean; scheduleId: string | null }>;
  /** consume_pending：恰好一个 successor（精确 generation 校验 + 唯一消费） */
  consumePending(options: {
    workspaceId: string;
    userId: string;
    keyPointId: string;
    inputScheduleId: string;
    inputScheduleGeneration: number;
    decisionRef: string;
    policyEpoch: number;
    idempotencyKey: string;
  }): Promise<{ consumed: boolean; successorScheduleId: string | null }>;
}

/** 副作用分派：由 disposition 推导需要执行的端口调用（纯函数描述）。 */
export type ScheduleCommitRequest =
  | { action: "create_initial"; keyPointId: string; idempotencyKey: string }
  | {
      action: "consume_pending";
      keyPointId: string;
      inputScheduleId: string;
      inputScheduleGeneration: number;
      idempotencyKey: string;
    }
  | { action: "none" };

/**
 * 从 disposition 推导 schedule 副作用请求（纯函数）。
 * 除 canonical_mastery / canonical_unable 且授权为 create/consume 外一律 "none"。
 */
export function planScheduleCommit(
  disposition: EpisodeCommitDisposition,
  input: EpisodeCommitDispositionInput,
): ScheduleCommitRequest {
  if (disposition.scheduleSideEffect === "none") return { action: "none" };
  const sd = input.contract.schedulingDecision;
  if (disposition.scheduleSideEffect === "consume_pending") {
    return {
      action: "consume_pending",
      keyPointId: input.contract.keyPointId,
      inputScheduleId: sd.inputScheduleId!,
      inputScheduleGeneration: sd.inputScheduleGeneration!,
      idempotencyKey: disposition.idempotencyKey,
    };
  }
  return {
    action: "create_initial",
    keyPointId: input.contract.keyPointId,
    idempotencyKey: disposition.idempotencyKey,
  };
}

/** 供端口/集成层引用的类型（避免直接依赖 FormalPlanKind 造成语义漂移）。 */
export type { FormalPlanKind, AuthorizedAction, ScheduleSideEffect };
