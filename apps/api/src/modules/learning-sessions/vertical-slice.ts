/**
 * 任务 06-1：单 Key Point 可信纵切编排（§9.1 / 06-w5 任务 06-1）。
 *
 * 在一个 Key Point 上打通 voice 与 profile-eligible silent bundle 的
 * `stabilize/clarify` 完整闭环：
 *
 * stabilize（重新看看）：
 * - 语音回忆（voice recall）或 structured-proof-v1（silent bundle）；
 * - 只有 official `create_initial/consume_pending` 的完整 mastery Episode
 *   才创建/消费 schedule，且恰好留下一个 active schedule；
 * - 语音路径覆盖全部 required rubric/facets 时签发 `mastery_eligible`；
 * - silent bundle 满足 §7.4 全部条件（structured-proof-v1 资格 + 等价 Gate +
 *   联合覆盖全部 required rubric + 无 blocked Scene）时归一 canonical outcome。
 *
 * clarify（再弄清一点）：
 * - 独立诊断 → 结果 → 引导练习；
 * - 提示前的完整正式 Episode 可提交（formal）；
 * - 提示后的操作全为 practice（practice_only，0 canonical/0 schedule）。
 *
 * 全部核心校验与状态机为纯函数；编排经可注入 `VerticalSliceRepository`
 * 与注入的 `CommitExecutor`（真实实现为 episode-commit.commitEpisode 绑事务
 * 端口），写路径始终落在现有 canonical facts + outbox 派生 projection，
 * 不建立第二套真相。
 */

import { TrustClass } from "@ailearn/shared";
import {
  RubricSessionResult,
  type AuthorizedAction,
  type FormalPlanKind,
  type ReducerResult,
  type RubricAssessment,
  type ScheduleSideEffect,
} from "./trust-service.ts";
import {
  mapReducerToValidationOutcome,
  EpisodeCommitDisposition,
  type CommitEpisodeResult,
  type EpisodeCommitInput,
} from "./episode-commit.ts";
import type {
  EpisodeRow,
  LearningEpisodeStatus,
  OfficialSchedulingDecisionV1,
} from "./session-service.ts";

// ─── 基础类型 ─────────────────────────────────────────────────────────────

export type VerticalSliceIntent = "stabilize" | "clarify";
export type StabilizeModality = "voice" | "structured_proof";

// ─── stabilize 状态机（纯函数）────────────────────────────────────────────

export const StabilizeStep = {
  /** 语音回忆收集 / bundle 结构 Scene 运行（预冻结、无中途反馈）。 */
  COLLECTING: "collecting",
  /** rubric 覆盖 / bundle 完整性校验。 */
  VERIFYING: "verifying",
  /** 签发 EpisodeTrustDecision / 归一 canonical outcome。 */
  ISSUING: "issuing",
  /** COMMIT（create_initial/consume_pending → 恰一 active schedule）。 */
  COMMITTING: "committing",
  DONE: "done",
} as const;
export type StabilizeStep = (typeof StabilizeStep)[keyof typeof StabilizeStep];

export const StabilizeAction = {
  START: "start",
  ARTIFACTS_COLLECTED: "artifacts_collected",
  VERIFY_PASSED: "verify_passed",
  /** 覆盖不足/不完整 → 仅 support artifact，0 正式副作用。 */
  VERIFY_FAILED: "verify_failed",
  TRUST_ISSUED: "trust_issued",
  COMMIT_SUCCEEDED: "commit_succeeded",
  /** commit 失败/归因 operational → 无学习副作用。 */
  COMMIT_FAILED: "commit_failed",
  MARK_STALE: "mark_stale",
  CANCEL: "cancel",
} as const;
export type StabilizeAction = (typeof StabilizeAction)[keyof typeof StabilizeAction];

/** stabilize/clarify 终态（含取消/失效/仅 support artifact）。 */
export type VerticalSliceStatus =
  | "running"
  | "committed"
  | "support_only"
  | "failed"
  | "stale"
  | "cancelled";

export interface VerticalSliceState {
  intent: VerticalSliceIntent;
  episodeId: string;
  keyPointId: string;
  modality?: StabilizeModality;
  step: StabilizeStep | ClarifyStep;
  status: VerticalSliceStatus;
  scheduleSideEffect: ScheduleSideEffect;
  reasonCodes: string[];
}

const STABILIZE_TRANSITIONS: Record<
  StabilizeStep,
  Partial<Record<StabilizeAction, { step: StabilizeStep; status: VerticalSliceStatus }>>
> = {
  collecting: {
    [StabilizeAction.START]: { step: StabilizeStep.COLLECTING, status: "running" },
    [StabilizeAction.ARTIFACTS_COLLECTED]: { step: StabilizeStep.VERIFYING, status: "running" },
    [StabilizeAction.MARK_STALE]: { step: StabilizeStep.DONE, status: "stale" },
    [StabilizeAction.CANCEL]: { step: StabilizeStep.DONE, status: "cancelled" },
  },
  verifying: {
    [StabilizeAction.VERIFY_PASSED]: { step: StabilizeStep.ISSUING, status: "running" },
    [StabilizeAction.VERIFY_FAILED]: { step: StabilizeStep.DONE, status: "support_only" },
    [StabilizeAction.MARK_STALE]: { step: StabilizeStep.DONE, status: "stale" },
    [StabilizeAction.CANCEL]: { step: StabilizeStep.DONE, status: "cancelled" },
  },
  issuing: {
    [StabilizeAction.TRUST_ISSUED]: { step: StabilizeStep.COMMITTING, status: "running" },
    [StabilizeAction.MARK_STALE]: { step: StabilizeStep.DONE, status: "stale" },
    [StabilizeAction.CANCEL]: { step: StabilizeStep.DONE, status: "cancelled" },
  },
  committing: {
    [StabilizeAction.COMMIT_SUCCEEDED]: { step: StabilizeStep.DONE, status: "committed" },
    [StabilizeAction.COMMIT_FAILED]: { step: StabilizeStep.DONE, status: "failed" },
    [StabilizeAction.MARK_STALE]: { step: StabilizeStep.DONE, status: "stale" },
    [StabilizeAction.CANCEL]: { step: StabilizeStep.DONE, status: "cancelled" },
  },
  done: {},
};

/**
 * stabilize 状态机转移（纯函数）。非法动作 allowed=false（不抛错）；
 * 内容校验（rubric 覆盖 / bundle 完整性）由调用方先完成再发对应 action。
 */
export function transitionStabilize(
  state: VerticalSliceState,
  action: StabilizeAction,
): { state: VerticalSliceState; allowed: boolean; reason: string | null } {
  if (state.intent !== "stabilize") {
    return { state: { ...state }, allowed: false, reason: `intent=${state.intent} 不是 stabilize` };
  }
  const next = STABILIZE_TRANSITIONS[state.step as StabilizeStep]?.[action];
  if (next === undefined) {
    return {
      state: { ...state },
      allowed: false,
      reason: `stabilize action '${action}' 不允许从 '${state.step}' 转移`,
    };
  }
  return {
    state: {
      ...state,
      step: next.step,
      status: next.status,
      reasonCodes:
        action === StabilizeAction.MARK_STALE
          ? [...state.reasonCodes, "stabilize_stale"]
          : action === StabilizeAction.CANCEL
            ? [...state.reasonCodes, "stabilize_cancelled"]
            : state.reasonCodes,
    },
    allowed: true,
    reason: `stabilize ${state.step} → ${next.step} (${next.status})`,
  };
}

// ─── clarify 状态机（纯函数）──────────────────────────────────────────────

export const ClarifyStep = {
  /** 独立诊断（无提示）。 */
  INDEPENDENT_DIAGNOSIS: "independent_diagnosis",
  /** 结果呈现。 */
  RESULT_PRESENTED: "result_presented",
  /** 引导练习（提示后 → 全部 practice）。 */
  GUIDED_PRACTICE: "guided_practice",
  DONE: "done",
} as const;
export type ClarifyStep = (typeof ClarifyStep)[keyof typeof ClarifyStep];

export const ClarifyAction = {
  START: "start",
  DIAGNOSIS_COMPLETE: "diagnosis_complete",
  RESULT_PRESENTED: "result_presented",
  /** 内容性提示/示例/排除项已给出 → 此后全部 practice-only。 */
  HINT_GIVEN: "hint_given",
  /** 提交 Episode（提示前 formal，提示后 practice）。 */
  SUBMIT_EPISODE: "submit_episode",
  MARK_STALE: "mark_stale",
  CANCEL: "cancel",
} as const;
export type ClarifyAction = (typeof ClarifyAction)[keyof typeof ClarifyAction];

const CLARIFY_TRANSITIONS: Record<
  Exclude<ClarifyStep, "done">,
  Partial<Record<ClarifyAction, { step: ClarifyStep; status: VerticalSliceStatus }>>
> = {
  independent_diagnosis: {
    [ClarifyAction.START]: { step: ClarifyStep.INDEPENDENT_DIAGNOSIS, status: "running" },
    [ClarifyAction.DIAGNOSIS_COMPLETE]: { step: ClarifyStep.RESULT_PRESENTED, status: "running" },
    [ClarifyAction.MARK_STALE]: { step: ClarifyStep.DONE, status: "stale" },
    [ClarifyAction.CANCEL]: { step: ClarifyStep.DONE, status: "cancelled" },
  },
  result_presented: {
    [ClarifyAction.HINT_GIVEN]: { step: ClarifyStep.GUIDED_PRACTICE, status: "running" },
    [ClarifyAction.SUBMIT_EPISODE]: { step: ClarifyStep.DONE, status: "committed" },
    [ClarifyAction.MARK_STALE]: { step: ClarifyStep.DONE, status: "stale" },
    [ClarifyAction.CANCEL]: { step: ClarifyStep.DONE, status: "cancelled" },
  },
  guided_practice: {
    [ClarifyAction.SUBMIT_EPISODE]: { step: ClarifyStep.DONE, status: "committed" },
    [ClarifyAction.MARK_STALE]: { step: ClarifyStep.DONE, status: "stale" },
    [ClarifyAction.CANCEL]: { step: ClarifyStep.DONE, status: "cancelled" },
  },
};

/** clarify 状态机转移（纯函数）。 */
export function transitionClarify(
  state: VerticalSliceState,
  action: ClarifyAction,
): { state: VerticalSliceState; allowed: boolean; reason: string | null } {
  if (state.intent !== "clarify") {
    return { state: { ...state }, allowed: false, reason: `intent=${state.intent} 不是 clarify` };
  }
  const next =
    CLARIFY_TRANSITIONS[state.step as Exclude<ClarifyStep, "done">]?.[action];
  if (next === undefined) {
    return {
      state: { ...state },
      allowed: false,
      reason: `clarify action '${action}' 不允许从 '${state.step}' 转移`,
    };
  }
  return {
    state: {
      ...state,
      step: next.step,
      status: next.status,
      reasonCodes:
        action === ClarifyAction.HINT_GIVEN
          ? [...state.reasonCodes, "hint_given_practice_only"]
          : state.reasonCodes,
    },
    allowed: true,
    reason: `clarify ${state.step} → ${next.step} (${next.status})`,
  };
}

// ─── 1. voice 路径：rubric/facet 覆盖校验（纯函数）─────────────────────────

export interface RubricTargetView {
  rubricItemId: string;
  required: boolean;
  /** 能力切面（recall/explain/apply/boundary/procedure/relate）。 */
  facet: string;
}

export interface VoiceRecallEvaluationInput {
  rubricTargets: readonly RubricTargetView[];
  assessments: readonly RubricAssessment[];
}

export interface VoiceRecallEvaluation {
  /** 全部 required rubric item 均有 covered verdict。 */
  allRequiredCovered: boolean;
  missingRequiredRubricItemIds: string[];
  /** 加权覆盖（与 reducer 一致的 weightedCoverage）。 */
  coverage: number;
  /** 覆盖全部 required rubric/facets → 可签发 mastery_eligible。 */
  masteryEligible: boolean;
  /** 未全覆盖时最高 facet_eligible（可观察 facet，不升级 mastery）。 */
  maxTrustClass: TrustClass;
  reasonCodes: string[];
}

/**
 * Voice Teach-back 覆盖校验（§8.3 R4 / 任务 06-1）：
 * 只有覆盖全部 required rubric/facets 时才可签发 mastery_eligible；
 * 未全覆盖 → 最高 facet_eligible，不消费/完成/延长 schedule。
 */
export function evaluateVoiceRecall(
  input: VoiceRecallEvaluationInput,
): VoiceRecallEvaluation {
  const missingRequiredRubricItemIds: string[] = [];
  let coveredWeight = 0;
  let partialWeight = 0;
  let totalWeight = 0;
  for (const target of input.rubricTargets) {
    const assessment = input.assessments.find(
      (a) => a.rubricItemId === target.rubricItemId,
    );
    const weight = target.required ? 2 : 1;
    totalWeight += weight;
    if (assessment?.verdict === "covered") coveredWeight += weight;
    else if (assessment?.verdict === "partial") partialWeight += weight;
    if (target.required && assessment?.verdict !== "covered") {
      missingRequiredRubricItemIds.push(target.rubricItemId);
    }
  }
  const coverage = totalWeight > 0 ? (coveredWeight + 0.5 * partialWeight) / totalWeight : 0;
  const allRequiredCovered = missingRequiredRubricItemIds.length === 0;
  const reasonCodes: string[] = [];
  if (allRequiredCovered) {
    reasonCodes.push("voice_all_required_rubric_covered");
  } else {
    reasonCodes.push("voice_required_rubric_missing");
  }
  return {
    allRequiredCovered,
    missingRequiredRubricItemIds,
    coverage,
    masteryEligible: allRequiredCovered,
    maxTrustClass: allRequiredCovered ? TrustClass.MASTERY_ELIGIBLE : TrustClass.FACET_ELIGIBLE,
    reasonCodes,
  };
}

// ─── 2. silent bundle 评估（§7.4 / §8.3，纯函数）───────────────────────────

export interface SilentBundleEvaluationInput {
  /** required Scene 总数（structured_mastery_bundle）。 */
  requiredSceneCount: number;
  completedRequiredSceneCount: number;
  /** 任一 required Scene 未完成/stale/assisted/not_assessable/未通过。 */
  anyRequiredSceneBlocked: boolean;
  /** structured-proof-v1 资格（≥2 预冻结互补场景 + Gold Gate）。 */
  structuredProofEligible: boolean;
  /** 跨模态等价 Gate（false-upgrade/false-downgrade）。 */
  equivalenceGatePassed: boolean;
  /** bundle 联合覆盖全部 required rubric/facets。 */
  allRequiredFacetsCovered: boolean;
  /** rubric-session-reducer-v2 输出。 */
  reducerResult: ReducerResult;
}

export interface SilentBundleEvaluation {
  /** 全部 required Scene 完成且无 blocked。 */
  bundleComplete: boolean;
  /** 满足 §7.4 全部条件 → 归一 canonical outcome 并允许 mastery。 */
  masteryEligible: boolean;
  /** 归一 canonical outcome（现有 validation_events.outcome 枚举，纯函数映射）。 */
  canonicalOutcome: string;
  reasonCodes: string[];
}

/**
 * silent bundle（structured-proof-v1）评估（§8.3 R5/R6/R7）：
 * - bundle 完整（全部 required Scene 完成、无 blocked）且 structuredProofEligible
 *   且 equivalenceGatePassed 且联合覆盖全部 required rubric 且 reducer 可评估
 *   → masteryEligible，归一 canonical outcome；
 * - 任一 required Scene 未完成/stale/assisted/not-assessable/未通过 → 不能消费
 *   input schedule（bundle 不完整，最高 facet_eligible）；
 * - 等价 Gate 通过前所有结构 Scene 最高只为 facet_eligible。
 */
export function evaluateSilentBundle(
  input: SilentBundleEvaluationInput,
): SilentBundleEvaluation {
  const reasonCodes: string[] = [];
  const bundleComplete =
    input.completedRequiredSceneCount >= input.requiredSceneCount &&
    !input.anyRequiredSceneBlocked;
  if (!bundleComplete) {
    reasonCodes.push(
      input.anyRequiredSceneBlocked
        ? "silent_required_scene_blocked"
        : "silent_bundle_incomplete",
    );
  }
  if (!input.structuredProofEligible) reasonCodes.push("silent_not_structured_proof_eligible");
  if (!input.equivalenceGatePassed) reasonCodes.push("silent_equivalence_gate_not_passed");
  if (!input.allRequiredFacetsCovered) reasonCodes.push("silent_required_facets_not_covered");

  const reducerAssessable =
    input.reducerResult.result !== RubricSessionResult.NOT_ASSESSABLE;
  if (!reducerAssessable) reasonCodes.push("silent_reducer_not_assessable");

  const masteryEligible =
    bundleComplete &&
    input.structuredProofEligible &&
    input.equivalenceGatePassed &&
    input.allRequiredFacetsCovered &&
    reducerAssessable;

  return {
    bundleComplete,
    masteryEligible,
    canonicalOutcome: mapReducerToValidationOutcome(input.reducerResult.result),
    reasonCodes,
  };
}

// ─── 3. mastery_eligible 签发（服务端，纯函数）─────────────────────────────

export interface MasteryEligibilityInput {
  modality: StabilizeModality;
  voice: VoiceRecallEvaluation | null;
  silent: SilentBundleEvaluation | null;
  /** content assistance 已激活 → practice_only，0 升级。 */
  assisted: boolean;
  /** integrity 失败（hash 失配 / 非 locked / 缺 private solution）→ not_assessable。 */
  integrityFailure: boolean;
}

export interface MasteryEligibilityVerdict {
  effectiveClass: TrustClass;
  reasonCodes: string[];
}

/**
 * 服务端签发 mastery_eligible（纯函数）：
 * - assisted/integrityFailure → not_assessable（fail closed，无正式副作用）；
 * - voice：覆盖全部 required rubric/facets → mastery_eligible，否则 facet_eligible；
 * - structured_proof：§7.4 全部条件 → mastery_eligible，否则最高 facet_eligible。
 */
export function resolveMasteryEligibility(
  input: MasteryEligibilityInput,
): MasteryEligibilityVerdict {
  const reasonCodes: string[] = [];
  if (input.assisted) reasonCodes.push("assisted_practice_only");
  if (input.integrityFailure) reasonCodes.push("integrity_failure_not_assessable");
  if (input.assisted || input.integrityFailure) {
    return { effectiveClass: TrustClass.NOT_ASSESSABLE, reasonCodes };
  }
  if (input.modality === "voice") {
    if (input.voice === null) {
      return {
        effectiveClass: TrustClass.NOT_ASSESSABLE,
        reasonCodes: [...reasonCodes, "voice_evaluation_missing"],
      };
    }
    return {
      effectiveClass: input.voice.maxTrustClass,
      reasonCodes: [...reasonCodes, ...input.voice.reasonCodes],
    };
  }
  if (input.silent === null) {
    return {
      effectiveClass: TrustClass.NOT_ASSESSABLE,
      reasonCodes: [...reasonCodes, "silent_evaluation_missing"],
    };
  }
  return {
    effectiveClass: input.silent.masteryEligible
      ? TrustClass.MASTERY_ELIGIBLE
      : TrustClass.FACET_ELIGIBLE,
    reasonCodes: [...reasonCodes, ...input.silent.reasonCodes],
  };
}

// ─── 4. schedule 副作用授权（§9.1，纯函数）─────────────────────────────────

export interface StabilizeScheduleInput {
  authorizedAction: AuthorizedAction;
  planKind: FormalPlanKind;
  episodeComplete: boolean;
  masteryEligible: boolean;
  anyRequiredSceneBlocked: boolean;
}

/**
 * 只有 official `create_initial/consume_pending` 的完整 mastery Episode
 * 才创建/消费 schedule；其余（record_only/no_effect/未完成/未 mastery/
 * bundle blocked）一律 0 写。返回的副作用即 official scheduler 的唯一写路径。
 */
export function resolveStabilizeScheduleSideEffect(
  input: StabilizeScheduleInput,
): ScheduleSideEffect {
  const isMasteryKind =
    input.planKind === "voice_mastery" ||
    input.planKind === "structured_mastery_bundle";
  if (!isMasteryKind) return "none";
  if (input.authorizedAction !== "create_initial" && input.authorizedAction !== "consume_pending") {
    return "none";
  }
  if (!input.episodeComplete) return "none";
  if (!input.masteryEligible) return "none";
  if (input.anyRequiredSceneBlocked) return "none";
  return input.authorizedAction;
}

// ─── 5. clarify 提交资格（§9.1，纯函数）────────────────────────────────────

export interface ClarifyCommittabilityInput {
  step: ClarifyStep;
  /** 内容性提示/示例已给出（提示后 → 全为 practice）。 */
  contentAssisted: boolean;
  /** 诊断/练习流程完整（可评估、无未完成步骤）。 */
  episodeComplete: boolean;
  /** 正式答案已锁定。 */
  artifactsLocked: boolean;
}

export interface ClarifyCommittabilityVerdict {
  committable: boolean;
  /** true = 提示前的完整正式 Episode（formal）；false = practice_only。 */
  formal: boolean;
  reason: string;
}

/**
 * clarify 提交资格（§9.1）：
 * - 提示前（step ∈ independent_diagnosis|result_presented && !contentAssisted）
 *   + 完整 + 已锁 → 完整正式 Episode 可提交（formal）；
 * - 提示后（guided_practice 或 contentAssisted）→ 可提交但全为 practice_only
 *   （0 canonical projection / 0 schedule / 0 review attempt）；
 * - 未完成 → 不可提交。
 */
export function resolveClarifyCommittability(
  input: ClarifyCommittabilityInput,
): ClarifyCommittabilityVerdict {
  const hinted =
    input.step === ClarifyStep.GUIDED_PRACTICE || input.contentAssisted;
  if (!input.episodeComplete || !input.artifactsLocked) {
    return {
      committable: false,
      formal: false,
      reason: "clarify_episode_incomplete",
    };
  }
  if (hinted) {
    return {
      committable: true,
      formal: false,
      reason: "hint_given_practice_only",
    };
  }
  return {
    committable: true,
    formal: true,
    reason: "pre_hint_formal_episode_committable",
  };
}

// ─── 6. 恰好一个 active schedule 断言（纯函数）─────────────────────────────

export interface ActivePendingScheduleView {
  scheduleId: string;
  generation: number;
  status: string;
}

export interface SingleActiveScheduleAssertion {
  ok: boolean;
  activeCount: number;
  reason: string | null;
}

/**
 * create/consume 后恰好留下一个 active schedule（§9.1）。0 或 >1 均不通过；
 * DB 层 (workspace,user,keyPoint) pending 唯一索引是最终兜底。
 */
export function assertSingleActiveSchedule(
  schedules: readonly ActivePendingScheduleView[],
): SingleActiveScheduleAssertion {
  const active = schedules.filter((s) => s.status === "pending");
  if (active.length === 1) {
    return { ok: true, activeCount: 1, reason: null };
  }
  return {
    ok: false,
    activeCount: active.length,
    reason:
      active.length === 0
        ? "no_active_pending_schedule"
        : `multiple_active_pending_schedules:${active.length}`,
  };
}

// ─── 可注入 repository / commit 端口 ───────────────────────────────────────

export interface LockedArtifactView {
  artifactId: string;
  status: "locked" | "draft" | "stale" | "superseded" | "redacted";
  effectiveTrustClass: TrustClass;
  fingerprintMatch: boolean;
  contentAssisted: boolean;
}

/** 单 Key Point 纵切的只读数据源（测试用内存实现；真实实现包装事务）。 */
export interface VerticalSliceRepository {
  findEpisode(
    workspaceId: string,
    userId: string,
    episodeId: string,
  ): Promise<EpisodeRow | null>;
  listLockedArtifacts(
    workspaceId: string,
    userId: string,
    episodeId: string,
  ): Promise<LockedArtifactView[]>;
  listRubricAssessments(
    workspaceId: string,
    userId: string,
    episodeId: string,
  ): Promise<RubricAssessment[]>;
  listActivePendingSchedules(
    workspaceId: string,
    userId: string,
    keyPointId: string,
  ): Promise<ActivePendingScheduleView[]>;
}

/** 注入的 COMMIT 执行器（真实为 episode-commit.commitEpisode 绑事务端口）。 */
export type CommitExecutor = (input: EpisodeCommitInput) => Promise<CommitEpisodeResult>;

/**
 * M3：commit 应用成功的可注入回调（proactive 触发点）。默认 no-op；
 * 生产绑定 fireCompanionTrigger("committed_change_display")。只在
 * commitResult.ok 且非 operational_only 时调用——绝不伪造 commit 事件。
 */
export type OnCommitApplied = (ctx: {
  workspaceId: string;
  userId: string;
  cardId: string;
  disposition: string;
}) => void;

// ─── 编排（voice / silent 两条主路径）──────────────────────────────────────

export class VerticalSliceError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "VerticalSliceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** 完整 mastery plan 的冻结信息（stabilize 输入）。 */
export interface StabilizeMasteryPlan {
  planKind: FormalPlanKind;
  schedulingDecision: OfficialSchedulingDecisionV1;
  requiredSceneCount: number;
  completedRequiredSceneCount: number;
  /** 任一 required Scene 未完成/stale/assisted/not_assessable/未通过。 */
  anyRequiredSceneBlocked: boolean;
  /** structured-proof-v1 资格（≥2 预冻结互补场景 + Gold Gate）。 */
  structuredProofEligible: boolean;
  /** 跨模态等价 Gate（false-upgrade/false-downgrade）。 */
  equivalenceGatePassed: boolean;
  /** bundle 联合覆盖全部 required rubric/facets。 */
  allRequiredFacetsCovered: boolean;
}

export interface StabilizeEpisodeInput {
  workspaceId: string;
  userId: string;
  episodeId: string;
  cardId: string;
  modality: StabilizeModality;
  plan: StabilizeMasteryPlan;
  /** 运行时条件。 */
  assisted: boolean;
  integrityFailure: boolean;
  providerFailure: boolean;
  notAssessable: boolean;
  userDeclaredUnable: boolean;
  reducerResult: ReducerResult | null;
  now: Date;
}

export interface StabilizeEpisodeResult {
  state: VerticalSliceState;
  voice: VoiceRecallEvaluation | null;
  silent: SilentBundleEvaluation | null;
  mastery: MasteryEligibilityVerdict;
  scheduleSideEffect: ScheduleSideEffect;
  commit: CommitEpisodeResult | null;
  activeScheduleAssertion: SingleActiveScheduleAssertion | null;
}

function artifactEligibility(
  artifacts: readonly LockedArtifactView[],
): { allEligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (artifacts.length === 0) reasons.push("no_artifacts");
  for (const artifact of artifacts) {
    if (artifact.status !== "locked") reasons.push(`${artifact.artifactId}:not_locked`);
    if (!artifact.fingerprintMatch) reasons.push(`${artifact.artifactId}:stale_fingerprint`);
    if (artifact.contentAssisted) reasons.push(`${artifact.artifactId}:assisted`);
  }
  return { allEligible: reasons.length === 0, reasons };
}

/**
 * stabilize 主路径编排：
 * 1. 读 Episode 与已锁 artifacts / rubric assessments；
 * 2. voice：evaluateVoiceRecall（覆盖全部 required rubric/facets → mastery_eligible）；
 *    structured_proof：evaluateSilentBundle（§7.4 全部条件 → 归一 canonical outcome）；
 * 3. resolveMasteryEligibility 签发 effectiveClass；
 * 4. resolveStabilizeScheduleSideEffect：只有 official create_initial/consume_pending
 *    的完整 mastery Episode 才创建/消费 schedule；
 * 5. 可提交（mastery_eligible / unable 等）→ 注入的 CommitExecutor；
 * 6. commit 后断言恰好一个 active schedule。
 */
export async function stabilizeEpisode(
  input: StabilizeEpisodeInput,
  repo: VerticalSliceRepository,
  commit: CommitExecutor,
  onCommitApplied?: OnCommitApplied,
): Promise<StabilizeEpisodeResult> {
  const episode = await repo.findEpisode(input.workspaceId, input.userId, input.episodeId);
  if (episode === null) {
    throw new VerticalSliceError("episode_not_found", 404, `Episode ${input.episodeId} 不存在`);
  }
  let state: VerticalSliceState = {
    intent: "stabilize",
    episodeId: episode.id,
    keyPointId: episode.keyPointId,
    modality: input.modality,
    step: StabilizeStep.COLLECTING,
    status: "running",
    scheduleSideEffect: "none",
    reasonCodes: [],
  };
  state = transitionStabilize(state, StabilizeAction.START).state;

  const artifacts = await repo.listLockedArtifacts(input.workspaceId, input.userId, episode.id);
  state = transitionStabilize(state, StabilizeAction.ARTIFACTS_COLLECTED).state;
  const eligibility = artifactEligibility(artifacts);
  if (!eligibility.allEligible) {
    // artifact 不合格（未锁定 / fingerprint 失配 / assisted）→ verifying 校验失败，
    // 只保留 support artifact，0 正式副作用。
    const failed = transitionStabilize(state, StabilizeAction.VERIFY_FAILED).state;
    return {
      state: { ...failed, reasonCodes: [...failed.reasonCodes, ...eligibility.reasons] },
      voice: null,
      silent: null,
      mastery: resolveMasteryEligibility({
        modality: input.modality,
        voice: null,
        silent: null,
        assisted: input.assisted,
        integrityFailure: input.integrityFailure,
      }),
      scheduleSideEffect: "none",
      commit: null,
      activeScheduleAssertion: null,
    };
  }

  const assessments = await repo.listRubricAssessments(input.workspaceId, input.userId, episode.id);
  const rubricTargets = (episode.rubricTargets ?? []) as unknown as RubricTargetView[];

  let voice: VoiceRecallEvaluation | null = null;
  let silent: SilentBundleEvaluation | null = null;
  let episodeComplete = true;
  if (input.modality === "voice") {
    voice = evaluateVoiceRecall({ rubricTargets, assessments });
  } else {
    silent = evaluateSilentBundle({
      requiredSceneCount: input.plan.requiredSceneCount,
      completedRequiredSceneCount: input.plan.completedRequiredSceneCount,
      anyRequiredSceneBlocked: input.plan.anyRequiredSceneBlocked,
      structuredProofEligible: input.plan.structuredProofEligible,
      equivalenceGatePassed: input.plan.equivalenceGatePassed,
      allRequiredFacetsCovered: input.plan.allRequiredFacetsCovered,
      reducerResult: input.reducerResult ?? emptyReducer(),
    });
    episodeComplete = silent.bundleComplete;
  }

  state = transitionStabilize(state, StabilizeAction.VERIFY_PASSED).state;
  const mastery = resolveMasteryEligibility({
    modality: input.modality,
    voice,
    silent,
    assisted: input.assisted,
    integrityFailure: input.integrityFailure,
  });
  state = transitionStabilize(state, StabilizeAction.TRUST_ISSUED).state;

  const scheduleSideEffect = resolveStabilizeScheduleSideEffect({
    authorizedAction: input.plan.schedulingDecision.authorizedAction,
    planKind: input.plan.planKind,
    episodeComplete,
    masteryEligible: mastery.effectiveClass === TrustClass.MASTERY_ELIGIBLE,
    anyRequiredSceneBlocked: input.plan.anyRequiredSceneBlocked,
  });

  const committable =
    mastery.effectiveClass !== TrustClass.NOT_ASSESSABLE &&
    !input.providerFailure &&
    !input.notAssessable &&
    // incomplete silent bundle 在第 1 步结束，只保留 support artifact，
    // 绝不因 record_only 落入 facet canonical fact（§8.6）。
    (input.modality !== "structured_proof" || episodeComplete);

  if (!committable) {
    const failed = transitionStabilize(state, StabilizeAction.COMMIT_FAILED).state;
    return {
      state: failed,
      voice,
      silent,
      mastery,
      scheduleSideEffect: "none",
      commit: null,
      activeScheduleAssertion: null,
    };
  }

  const commitResult = await commit(
    buildEpisodeCommitInput(episode, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      cardId: input.cardId,
      effectiveClass: mastery.effectiveClass,
      scheduleSideEffect,
      committedDisposition: null,
      providerFailure: input.providerFailure,
      notAssessable: input.notAssessable,
      userDeclaredUnable: input.userDeclaredUnable,
      reducerResult: input.reducerResult,
      assessments,
      now: input.now,
    }),
  );
  state = transitionStabilize(
    state,
    commitResult.ok ? StabilizeAction.COMMIT_SUCCEEDED : StabilizeAction.COMMIT_FAILED,
  ).state;

  // M3：commit 应用成功才触发 proactive（onCommitApplied 可注入；默认 no-op）。
  if (commitResult.ok && commitResult.disposition !== EpisodeCommitDisposition.OPERATIONAL_ONLY) {
    onCommitApplied?.({
      workspaceId: input.workspaceId,
      userId: input.userId,
      cardId: input.cardId,
      disposition: commitResult.disposition,
    });
  }

  let activeScheduleAssertion: SingleActiveScheduleAssertion | null = null;
  if (commitResult.ok && scheduleSideEffect !== "none") {
    const schedules = await repo.listActivePendingSchedules(
      input.workspaceId,
      input.userId,
      episode.keyPointId,
    );
    activeScheduleAssertion = assertSingleActiveSchedule(schedules);
  }

  return {
    state: {
      ...state,
      scheduleSideEffect,
      reasonCodes: [...state.reasonCodes, ...mastery.reasonCodes],
    },
    voice,
    silent,
    mastery,
    scheduleSideEffect,
    commit: commitResult,
    activeScheduleAssertion,
  };
}

function emptyReducer(): ReducerResult {
  return {
    result: RubricSessionResult.NOT_ASSESSABLE,
    weightedCoverage: 0,
    hasContradiction: false,
    allRequiredCovered: false,
    missingRequired: true,
    notAssessableRequired: false,
    reducerVersion: "rubric-session-reducer-v2",
    invariantViolation: false,
    reasonCodes: ["all_items_unassessed"],
  };
}

export interface ClarifyEpisodeInput {
  workspaceId: string;
  userId: string;
  episodeId: string;
  cardId: string;
  /** 当前 clarify 阶段（由状态机驱动）。 */
  step: ClarifyStep;
  contentAssisted: boolean;
  artifactsLocked: boolean;
  episodeComplete: boolean;
  effectiveTrustClass: TrustClass;
  reducerResult: ReducerResult | null;
  providerFailure: boolean;
  now: Date;
}

export interface ClarifyEpisodeResult {
  state: VerticalSliceState;
  committability: ClarifyCommittabilityVerdict;
  commit: CommitEpisodeResult | null;
}

/**
 * clarify 主路径编排（§9.1）：独立诊断 → 结果 → 引导练习。
 * - 提示前完整正式 Episode 可提交（formal）；
 * - 提示后全为 practice_only（0 canonical / 0 schedule / 0 review attempt）。
 * 提交时按 committability.formal 决定 effectiveClass：
 * formal → 用户原始 trust；practice_only → practice_only（服务端强制降级，
 * 绝不因 record_only 落入 facet canonical fact）。
 */
export async function clarifyEpisode(
  input: ClarifyEpisodeInput,
  repo: VerticalSliceRepository,
  commit: CommitExecutor,
  onCommitApplied?: OnCommitApplied,
): Promise<ClarifyEpisodeResult> {
  const episode = await repo.findEpisode(input.workspaceId, input.userId, input.episodeId);
  if (episode === null) {
    throw new VerticalSliceError("episode_not_found", 404, `Episode ${input.episodeId} 不存在`);
  }
  const state: VerticalSliceState = {
    intent: "clarify",
    episodeId: episode.id,
    keyPointId: episode.keyPointId,
    step: input.step,
    status: input.step === ClarifyStep.DONE ? "committed" : "running",
    scheduleSideEffect: "none",
    reasonCodes: [],
  };

  const committability = resolveClarifyCommittability({
    step: input.step,
    contentAssisted: input.contentAssisted,
    episodeComplete: input.episodeComplete,
    artifactsLocked: input.artifactsLocked,
  });
  if (!committability.committable) {
    return { state, committability, commit: null };
  }

  // 提示后 → practice_only（服务端强制）。
  const effectiveClass = committability.formal
    ? input.effectiveTrustClass
    : TrustClass.PRACTICE_ONLY;

  const commitResult = await commit(
    buildEpisodeCommitInput(episode, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      cardId: input.cardId,
      effectiveClass,
      scheduleSideEffect: "none",
      committedDisposition: committability.formal ? null : "practice_or_diagnostic",
      providerFailure: input.providerFailure,
      notAssessable: false,
      userDeclaredUnable: false,
      reducerResult: input.reducerResult,
      assessments: [],
      now: input.now,
    }),
  );

  // M3：commit 应用成功才触发 proactive（onCommitApplied 可注入；默认 no-op）。
  if (commitResult.ok && commitResult.disposition !== EpisodeCommitDisposition.OPERATIONAL_ONLY) {
    onCommitApplied?.({
      workspaceId: input.workspaceId,
      userId: input.userId,
      cardId: input.cardId,
      disposition: commitResult.disposition,
    });
  }

  return {
    state: {
      ...state,
      status: commitResult.ok ? "committed" : "failed",
      reasonCodes: [
        ...state.reasonCodes,
        committability.formal ? "clarify_formal_submitted" : "clarify_practice_only",
      ],
    },
    committability,
    commit: commitResult,
  };
}

// ─── EpisodeCommitInput 构造（纯函数）──────────────────────────────────────

interface BuildCommitContext {
  workspaceId: string;
  userId: string;
  cardId: string;
  effectiveClass: TrustClass;
  scheduleSideEffect: ScheduleSideEffect;
  /** 非 null 表示强制按该 disposition 提交（如 clarify practice_only）。 */
  committedDisposition: "practice_or_diagnostic" | null;
  providerFailure: boolean;
  notAssessable: boolean;
  userDeclaredUnable: boolean;
  reducerResult: ReducerResult | null;
  assessments: readonly RubricAssessment[];
  now: Date;
}

/**
 * 由 EpisodeRow + 运行时评估构造 EpisodeCommitInput（纯函数）。
 * contentRevision 未单独冻结（Episode 只有 fingerprint）→ null；CAS 的
 * content 匹配以 episodeTargetFingerprint 为准。practice_only 提交强制
 * formalPlanKind="practice"（→ derive 第 2 步归 practice_or_diagnostic，
 * 绝不落入 canonical facet/mastery）。
 */
export function buildEpisodeCommitInput(
  episode: EpisodeRow,
  context: BuildCommitContext,
): EpisodeCommitInput {
  const decision = episode.schedulingDecision;
  const practiceForced = context.committedDisposition === "practice_or_diagnostic";
  const formalPlanKind: FormalPlanKind = practiceForced
    ? "practice"
    : episode.formalPlan.kind;

  return {
    workspaceId: context.workspaceId,
    userId: context.userId,
    episode: {
      episodeId: episode.id,
      keyPointId: episode.keyPointId,
      cardId: context.cardId,
      origin: episode.origin,
      episodeTargetFingerprint: episode.episodeTargetFingerprint,
      formalPlanKind,
      schedulingDecision: decision,
      contentRevisionAtPrepare: null,
      contentFingerprintAtPrepare: episode.episodeTargetFingerprint,
      runtimeEpochSnapshot: episode.runtimeEpochSnapshot,
      episodeEpoch: episode.episodeEpoch,
      status: episode.status as LearningEpisodeStatus,
      planHash: episode.planHash,
      commitKey: episode.commitKey,
    },
    effectiveTrustClass: context.effectiveClass,
    reducerResult: context.reducerResult,
    policyAllowed: practiceForced ? false : true,
    providerFailure: context.providerFailure,
    notAssessable: context.notAssessable,
    missingRequiredArtifact: false,
    assisted: false,
    diagnosticTrust: false,
    userDeclaredUnable: context.userDeclaredUnable,
    assessableTrustedPointResult: true,
    trustDecision: null,
    assessments: context.assessments,
    artifactText: { question: "", userAnswer: "" },
    scheduleOutput: {
      intervalDays: 1,
      nextReviewAt: new Date(context.now.getTime() + 24 * 60 * 60 * 1000),
      policyVersion: decision.policyVersion,
      policyEpoch: decision.policyEpoch,
    },
    now: context.now,
  };
}
