/**
 * official-scheduler.ts（阶段 06 / W5，任务 06-5：official scheduler 与 FSRS shadow，§9）
 *
 * 唯一 official scheduler：versioned discrete policy（discrete-v2）作为当前 official。
 * FSRS 保持独立 shadow —— 本模块**不读取、不引用**任何 FSRS 状态；FSRS 决策不得进入
 * 候选、排序、推荐理由或用户文案（§16.1 硬指标：「FSRS shadow 进入候选/排序/推荐理由/
 * 文案 = 0」）。
 *
 * 职责（06-w5 任务 06-5）：
 * - formal eligibility：`resolveFormalEligibility`（initial_validation / scheduled_review /
 *   repair_revalidation / ad_hoc_transfer / practice，fail closed）；
 * - early-review authorization：`authorizeEarlyReview`（提前复习必须用户显式请求、无
 *   unassisted 冷却阻挡、无近期失败；单纯从 Card/Star 选择目标只改 prioritySource，本身
 *   不授予 early review，01-2 §5.2）；
 * - typed scheduling authorization：`issueTypedAuthorization`（create_initial /
 *   consume_pending / record_only / no_effect，01-2 §5.2）；
 * - due window：`computeDueWindow`（effective start 含 unassisted cooldown；
 *   not_due / due / overdue）；
 * - successor schedule：`computeSuccessorSchedule`（commit 阶段按 discrete-v2 policy 计算；
 *   record_only / no_effect 一律 0 schedule 副作用，01-2 §8.5）；
 * - memory state：interval / understandingEffect / storedIntervalDays（来自 discrete-v2）；
 * - policy reason：`reasonCodes`（进入 `OfficialSchedulingDecisionV1.reasonCodes`）；
 * - FSRS shadow 隔离：`assertFSRSShadowNoInfluence`（结构隔离断言）与
 *   `resolveFSRSPromotionStatus`（Agent 上线不自动授权 FSRS 转正）。
 *
 * 全部为纯函数：不读时钟、不改状态、不调外部服务。DB 写入由调用方在 commit 事务中
 * 执行（disposition/episode-commit），本模块只签发决策引用。
 */

import {
  calculateDiscreteV2Schedule,
  effectiveReviewStart,
  DISCRETE_V2_POLICY_VERSION,
  type DiscreteV2Outcome,
  type DiscreteV2UnderstandingEffect,
} from "@ailearn/shared";
import {
  buildSchedulingDecision,
  type OfficialSchedulingDecisionV1,
} from "./session-service.ts";

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** 唯一 official scheduler 标识（同一时间只能有一个，§9） */
export const OFFICIAL_SCHEDULER_ID = "official-scheduler-v1" as const;
/** official policy = versioned discrete policy（discrete-v2） */
export const OFFICIAL_POLICY_VERSION = DISCRETE_V2_POLICY_VERSION as typeof DISCRETE_V2_POLICY_VERSION;
/** official policy epoch（内容/语义变更时递增，进入 schedulingDecision.policyEpoch） */
export const OFFICIAL_POLICY_EPOCH = 1;
/** due window 默认提前量（小时）：到期前多少小时内视为「已进入 due window」；默认 0（保守，不提前） */
export const OFFICIAL_DUE_WINDOW_LOOKAHEAD_HOURS = 0;
/** due window 默认宽限期（小时）：到期后多少小时内仍视为 due，超过则 overdue */
export const OFFICIAL_OVERDUE_GRACE_HOURS = 24;

// ─── 类型 ──────────────────────────────────────────────────────────────────

export type OfficialEntryKind =
  | "initial"        // 首次验证（无 active pending）
  | "review_entry"   // 复习入口（scheduled review / early review）
  | "repair"         // 修补后重验
  | "ad_hoc"         // 主动迁移/自由验证（record_only）
  | "practice";      // 明确练习路径（no_effect）

export type OfficialEligibilityKind =
  | "initial_validation"
  | "scheduled_review"
  | "repair_revalidation"
  | "ad_hoc_transfer"
  | "practice";

export type OfficialAuthorizedAction =
  | "create_initial"
  | "consume_pending"
  | "record_only"
  | "no_effect";

export type OfficialPrioritySource =
  | "official_due"
  | "official_overdue"
  | "canonical_gap"
  | "user_selected";

/** 入口解析出来的优先级来源（01-2 §5.2：用户从 Card/Star 主动选择 → user_selected） */
export type OfficialPrioritySourceRequest =
  | "user_selected"
  | "official_due"
  | "canonical_gap";

export type OfficialReasonCode =
  | "no_canonical"
  | "not_due"
  | "not_within_due_window"
  | "no_pending_schedule"
  | "active_pending_exists"
  | "create_initial"
  | "consume_pending"
  | "record_only"
  | "no_effect"
  | "early_review"
  | "early_review_not_requested"
  | "early_review_cooldown"
  | "early_review_recent_failure"
  | "repair_revalidation"
  | "ad_hoc_transfer"
  | "practice_only"
  | "user_selected_target"
  | "canonical_gap_target"
  | "official_schedule_due"
  | "official_schedule_overdue"
  | "eligibility_unavailable_fallback"
  | "no_schedule_effect"
  | "discrete_v2_policy";

// ─── Formal eligibility ────────────────────────────────────────────────────

export interface EligibilityInput {
  entryKind: OfficialEntryKind;
  /** 有 active canonical 内容（无 canonical 的源不构成合法候选，03-2） */
  hasCanonical: boolean;
  /** 存在 active pending schedule（create_initial 要求不存在，01-2 §5.2） */
  hasActivePending: boolean;
  /** pending 已进入 due window 或已 overdue */
  pendingDue: boolean;
  /** early review 已授权（提前复习） */
  earlyReviewAuthorized: boolean;
}

export interface EligibilityVerdict {
  eligible: boolean;
  eligibilityKind: OfficialEligibilityKind | null;
  reasonCodes: string[];
}

/**
 * Formal eligibility（§9）：判定该入口/状态能进入哪种 formal Episode。
 * fail closed：无 canonical → 不可用；create_initial 只允许不存在 active pending 的
 * 首次验证；scheduled_review 必须 pending 已到期或 early review 已授权。
 */
export function resolveFormalEligibility(input: EligibilityInput): EligibilityVerdict {
  if (!input.hasCanonical) {
    return { eligible: false, eligibilityKind: null, reasonCodes: ["no_canonical"] };
  }

  switch (input.entryKind) {
    case "practice":
      return { eligible: true, eligibilityKind: "practice", reasonCodes: ["practice_only"] };
    case "ad_hoc":
      return { eligible: true, eligibilityKind: "ad_hoc_transfer", reasonCodes: ["ad_hoc_transfer"] };
    case "repair":
      return {
        eligible: true,
        eligibilityKind: "repair_revalidation",
        reasonCodes: ["repair_revalidation"],
      };
    case "initial":
      if (input.hasActivePending) {
        return {
          eligible: false,
          eligibilityKind: null,
          reasonCodes: ["active_pending_exists"],
        };
      }
      return {
        eligible: true,
        eligibilityKind: "initial_validation",
        reasonCodes: ["create_initial"],
      };
    case "review_entry":
      if (!input.hasActivePending) {
        return { eligible: false, eligibilityKind: null, reasonCodes: ["no_pending_schedule"] };
      }
      if (input.pendingDue || input.earlyReviewAuthorized) {
        return {
          eligible: true,
          eligibilityKind: "scheduled_review",
          reasonCodes: ["consume_pending"],
        };
      }
      return {
        eligible: false,
        eligibilityKind: null,
        reasonCodes: ["not_due", "not_within_due_window"],
      };
  }
}

// ─── Due window ────────────────────────────────────────────────────────────

export type DueWindowStatus = "not_due" | "due" | "overdue";

export interface DueWindowInput {
  nextReviewAt: Date | null;
  /** unassisted 冷却结束时间（assisted 暴露后生效）；null = 无冷却 */
  unassistedEligibleAfter?: Date | null;
  now: Date;
  /** due window 提前量（小时）；默认 OFFICIAL_DUE_WINDOW_LOOKAHEAD_HOURS */
  lookaheadHours?: number;
  /** 到期宽限期（小时）；默认 OFFICIAL_OVERDUE_GRACE_HOURS */
  overdueGraceHours?: number;
}

export interface DueWindowResult {
  status: DueWindowStatus;
  /** effective due（含 unassisted cooldown 下限）；无 schedule 时为 null */
  dueAt: Date | null;
  isDue: boolean;
  isOverdue: boolean;
  reasonCodes: string[];
}

/**
 * Due window（§9）：Review effective start = max(next_review_at, unassisted_eligible_after)
 * （scheduling-policy-v2 §9.4）。now < dueAt - lookahead → not_due；进入 due window 或
 * 宽限期内 → due；超过 dueAt + grace → overdue。
 */
export function computeDueWindow(input: DueWindowInput): DueWindowResult {
  const lookaheadHours = input.lookaheadHours ?? OFFICIAL_DUE_WINDOW_LOOKAHEAD_HOURS;
  const graceHours = input.overdueGraceHours ?? OFFICIAL_OVERDUE_GRACE_HOURS;
  if (input.nextReviewAt === null || !Number.isFinite(input.nextReviewAt.getTime())) {
    return { status: "not_due", dueAt: null, isDue: false, isOverdue: false, reasonCodes: ["no_pending_schedule"] };
  }
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new TypeError("official-scheduler: now 必须是有效 Date");
  }
  const dueAt = effectiveReviewStart(input.nextReviewAt, input.unassistedEligibleAfter ?? null);
  const nowMs = input.now.getTime();
  const dueMs = dueAt.getTime();
  const hourMs = 60 * 60 * 1_000;

  if (nowMs < dueMs - lookaheadHours * hourMs) {
    return { status: "not_due", dueAt, isDue: false, isOverdue: false, reasonCodes: ["not_within_due_window"] };
  }
  if (nowMs > dueMs + graceHours * hourMs) {
    return { status: "overdue", dueAt, isDue: true, isOverdue: true, reasonCodes: ["official_schedule_overdue"] };
  }
  return { status: "due", dueAt, isDue: true, isOverdue: false, reasonCodes: ["official_schedule_due"] };
}

// ─── Early-review authorization ────────────────────────────────────────────

export interface EarlyReviewInput {
  now: Date;
  nextReviewAt: Date | null;
  unassistedEligibleAfter?: Date | null;
  /** 用户显式请求提前复习。注意：从 Card/Star 主动选择目标只改 prioritySource，
   *  本身不授予 early review（01-2 §5.2）。 */
  userRequestedEarlyReview: boolean;
  /** 近期失败次数（incorrect/unable 等），> 0 时禁止提前复习 */
  recentFailureCount: number;
  hasActivePending: boolean;
}

export interface EarlyReviewVerdict {
  authorized: boolean;
  reasonCodes: string[];
}

/**
 * Early-review authorization（§9）：official scheduler 判定提前复习是否合法。
 * 要求：存在 active pending、用户显式请求、unassisted 冷却已过、近期无失败。
 */
export function authorizeEarlyReview(input: EarlyReviewInput): EarlyReviewVerdict {
  if (input.nextReviewAt === null || !input.hasActivePending) {
    return { authorized: false, reasonCodes: ["no_pending_schedule"] };
  }
  if (!input.userRequestedEarlyReview) {
    return { authorized: false, reasonCodes: ["early_review_not_requested"] };
  }
  if (input.unassistedEligibleAfter && input.now.getTime() < input.unassistedEligibleAfter.getTime()) {
    return { authorized: false, reasonCodes: ["early_review_cooldown"] };
  }
  if (input.recentFailureCount > 0) {
    return { authorized: false, reasonCodes: ["early_review_recent_failure"] };
  }
  return { authorized: true, reasonCodes: ["early_review", "user_selected_target"] };
}

// ─── Typed scheduling authorization ────────────────────────────────────────

export interface AuthorizationInput {
  eligibility: EligibilityVerdict;
  due: DueWindowResult;
  earlyReview: EarlyReviewVerdict;
  /** 存在 active pending schedule（consume_pending 的绑定前提） */
  hasActivePending: boolean;
  /** 绑定 input schedule（consume_pending 必须绑定精确 id + generation，01-2 §5.2） */
  boundScheduleId?: string;
  boundScheduleGeneration?: number;
  /** 入口解析来源（01-2 §5.2：用户明确选择目标 → user_selected） */
  prioritySourceRequest: OfficialPrioritySourceRequest;
}

export interface AuthorizationVerdict {
  authorizedAction: OfficialAuthorizedAction;
  prioritySource: OfficialPrioritySource;
  bindScheduleId?: string;
  bindGeneration?: number;
  reasonCodes: string[];
}

/**
 * Typed scheduling authorization（§9 / 01-2 §5.2）：签发 official 的事前最大授权。
 * fail closed：任何不可用/非法组合回落 `record_only`（0 schedule 副作用）。
 * consume_pending 必须绑定 input schedule + generation。
 */
export function issueTypedAuthorization(input: AuthorizationInput): AuthorizationVerdict {
  if (!input.eligibility.eligible || input.eligibility.eligibilityKind === null) {
    return {
      authorizedAction: "record_only",
      prioritySource: "canonical_gap",
      reasonCodes: ["eligibility_unavailable_fallback", "record_only"],
    };
  }

  switch (input.eligibility.eligibilityKind) {
    case "practice":
      return {
        authorizedAction: "no_effect",
        prioritySource: "canonical_gap",
        reasonCodes: ["no_effect", "practice_only"],
      };
    case "ad_hoc_transfer":
      return {
        authorizedAction: "record_only",
        prioritySource:
          input.prioritySourceRequest === "user_selected" ? "user_selected" : "canonical_gap",
        reasonCodes: ["record_only", "ad_hoc_transfer"],
      };
    case "initial_validation": {
      const userSelected = input.prioritySourceRequest === "user_selected";
      return {
        authorizedAction: "create_initial",
        prioritySource: userSelected ? "user_selected" : "canonical_gap",
        reasonCodes: [
          "create_initial",
          userSelected ? "user_selected_target" : "canonical_gap_target",
        ],
      };
    }
    case "scheduled_review":
    case "repair_revalidation": {
      if (
        input.boundScheduleId === undefined ||
        input.boundScheduleGeneration === undefined ||
        !input.hasActivePending
      ) {
        // fail closed：consume_pending 必须绑定精确 input schedule + generation
        //（01-2 §5.2；security_review MEDIUM #2：缺 generation 与缺 id 同样降级
        // record_only，绝不静默默认 0 签发 consume_pending）
        return {
          authorizedAction: "record_only",
          prioritySource: "canonical_gap",
          reasonCodes: ["eligibility_unavailable_fallback", "record_only"],
        };
      }
      const overdue = input.due.isOverdue;
      return {
        authorizedAction: "consume_pending",
        prioritySource: overdue ? "official_overdue" : "official_due",
        bindScheduleId: input.boundScheduleId,
        bindGeneration: input.boundScheduleGeneration,
        reasonCodes: [
          "consume_pending",
          overdue ? "official_schedule_overdue" : "official_schedule_due",
        ],
      };
    }
  }
}

// ─── Successor schedule（commit 阶段）──────────────────────────────────────

export interface SuccessorScheduleInput {
  /** 预冻结的 typed scheduling authorization（record_only / no_effect 0 schedule 副作用） */
  authorizedAction: OfficialAuthorizedAction;
  /** 当前正式 interval days（discrete-v2 memory state 输入） */
  currentIntervalDays: number;
  outcome: DiscreteV2Outcome;
  hasValidServerQuestion: boolean;
  hasHardEvidence: boolean;
  now: Date;
  unassistedEligibleAfter?: Date | null;
}

export interface SuccessorSchedule {
  /** 提交前正式 interval（memory state） */
  beforeIntervalDays: number;
  /** 提交后正式 interval（successor memory state） */
  afterIntervalDays: number;
  nextReviewAt: Date;
  understandingEffect: DiscreteV2UnderstandingEffect;
  reasonCode: string;
  policyVersion: string;
  policyEpoch: number;
  /** false = 不写 schedule（stale / provider_failure，01-2 §8.5 无副作用） */
  shouldMutateSchedule: boolean;
}

export interface SuccessorScheduleResult {
  /** null = 0 schedule 副作用（record_only / no_effect） */
  successor: SuccessorSchedule | null;
  /** create_initial / consume_pending 且 policy 判定应写 → true */
  scheduleAffected: boolean;
  reasonCodes: string[];
}

/**
 * Successor schedule（§9）：只有 official policy 签发的 create_initial / consume_pending
 * 才可能产生 successor；record_only / no_effect 一律 0 schedule 副作用（01-2 §8.5）。
 * 计算委托 versioned discrete policy（discrete-v2），并追加 policyEpoch 与 reason。
 */
export function computeSuccessorSchedule(
  input: SuccessorScheduleInput,
): SuccessorScheduleResult {
  if (input.authorizedAction !== "create_initial" && input.authorizedAction !== "consume_pending") {
    return {
      successor: null,
      scheduleAffected: false,
      reasonCodes: ["no_schedule_effect"],
    };
  }

  const decision = calculateDiscreteV2Schedule({
    currentIntervalDays: input.currentIntervalDays,
    outcome: input.outcome,
    hasValidServerQuestion: input.hasValidServerQuestion,
    hasHardEvidence: input.hasHardEvidence,
    now: input.now,
    unassistedEligibleAfter: input.unassistedEligibleAfter ?? null,
  });

  const successor: SuccessorSchedule = {
    beforeIntervalDays: decision.beforeIntervalDays,
    afterIntervalDays: decision.afterIntervalDays,
    nextReviewAt: decision.nextReviewAt,
    understandingEffect: decision.understandingEffect,
    reasonCode: decision.reasonCode,
    policyVersion: decision.policyVersion,
    policyEpoch: OFFICIAL_POLICY_EPOCH,
    shouldMutateSchedule: decision.shouldMutateSchedule,
  };
  return {
    successor,
    scheduleAffected: decision.shouldMutateSchedule,
    reasonCodes: [decision.reasonCode, "discrete_v2_policy"],
  };
}

// ─── 组合：official decision（PREPARE 阶段冻结）────────────────────────────

export interface OfficialDecisionInput {
  entryKind: OfficialEntryKind;
  hasCanonical: boolean;
  hasActivePending: boolean;
  boundScheduleId?: string;
  boundScheduleGeneration?: number;
  now: Date;
  nextReviewAt: Date | null;
  unassistedEligibleAfter?: Date | null;
  userRequestedEarlyReview: boolean;
  recentFailureCount: number;
  prioritySourceRequest: OfficialPrioritySourceRequest;
  dueWindowOverrides?: { lookaheadHours?: number; overdueGraceHours?: number };
}

export interface OfficialDecisionResult {
  eligible: boolean;
  eligibilityKind: OfficialEligibilityKind | null;
  dueWindow: DueWindowResult;
  earlyReview: EarlyReviewVerdict;
  /** 预冻结的 typed scheduling decision（persist 到 Episode plan，
   *  01-2 §5.2 / 06-5：decisionRef/hash/authorizedAction/prioritySource/policyEpoch） */
  schedulingDecision: OfficialSchedulingDecisionV1;
  reasonCodes: string[];
}

/**
 * 组合入口：给定入口/调度状态，产出 PREPARE 阶段可冻结的 official decision。
 * 输入中**不含任何 FSRS 状态** —— FSRS shadow 在类型层面与 official 决策隔离。
 */
export function deriveOfficialDecision(input: OfficialDecisionInput): OfficialDecisionResult {
  const dueWindow = computeDueWindow({
    nextReviewAt: input.nextReviewAt,
    unassistedEligibleAfter: input.unassistedEligibleAfter,
    now: input.now,
    ...input.dueWindowOverrides,
  });

  const earlyReview = authorizeEarlyReview({
    now: input.now,
    nextReviewAt: input.nextReviewAt,
    unassistedEligibleAfter: input.unassistedEligibleAfter,
    userRequestedEarlyReview: input.userRequestedEarlyReview,
    recentFailureCount: input.recentFailureCount,
    hasActivePending: input.hasActivePending,
  });

  const eligibility = resolveFormalEligibility({
    entryKind: input.entryKind,
    hasCanonical: input.hasCanonical,
    hasActivePending: input.hasActivePending,
    pendingDue: dueWindow.isDue,
    earlyReviewAuthorized: earlyReview.authorized,
  });

  const authorization = issueTypedAuthorization({
    eligibility,
    due: dueWindow,
    earlyReview,
    hasActivePending: input.hasActivePending,
    boundScheduleId: input.boundScheduleId,
    boundScheduleGeneration: input.boundScheduleGeneration,
    prioritySourceRequest: input.prioritySourceRequest,
  });

  const schedulingDecision = buildSchedulingDecision({
    authorizedAction: authorization.authorizedAction,
    inputScheduleId: authorization.bindScheduleId,
    inputScheduleGeneration: authorization.bindGeneration,
    prioritySource: authorization.prioritySource,
    policyVersion: OFFICIAL_POLICY_VERSION,
    policyEpoch: OFFICIAL_POLICY_EPOCH,
    reasonCodes: authorization.reasonCodes,
  });

  return {
    eligible: eligibility.eligible,
    eligibilityKind: eligibility.eligibilityKind,
    dueWindow,
    earlyReview,
    schedulingDecision,
    reasonCodes: [...new Set([...eligibility.reasonCodes, ...authorization.reasonCodes])],
  };
}

// ─── FSRS shadow 隔离（§9 / §16.1）─────────────────────────────────────────

export interface IsolationAssertion {
  isolated: true;
  checkedFields: string[];
}

const OFFICIAL_DECISION_FIELDS = Object.freeze([
  "decisionRef",
  "decisionHash",
  "authorizedAction",
  "inputScheduleId",
  "inputScheduleGeneration",
  "prioritySource",
  "policyVersion",
  "policyEpoch",
  "reasonCodes",
] as const);

/**
 * FSRS shadow 隔离断言（§16.1：「FSRS shadow 进入候选、排序、推荐理由或用户文案 = 0」）。
 *
 * - official decision 只含冻结字段（OFFICIAL_DECISION_FIELDS），出现任何未知字段即失败；
 * - shadowDecision 的字段名不得与 official decision 字段重合（结构隔离：shadow 的任何
 *   字段都不会泄漏进 official decision）。
 *
 * 抛错即表示隔离被破坏；返回 `{ isolated: true }` 表示通过。
 */
export function assertFSRSShadowNoInfluence(
  officialDecision: OfficialSchedulingDecisionV1,
  shadowDecision: unknown,
): IsolationAssertion {
  const decisionKeys = Object.keys(officialDecision);
  for (const key of decisionKeys) {
    if (!(OFFICIAL_DECISION_FIELDS as readonly string[]).includes(key)) {
      throw new Error(
        `official decision 包含未知字段 "${key}"（FSRS shadow 不得进入 official 决策）`,
      );
    }
  }
  if (shadowDecision !== undefined && shadowDecision !== null) {
    const shadowKeys = Object.keys(shadowDecision as Record<string, unknown>);
    for (const key of shadowKeys) {
      if (decisionKeys.includes(key)) {
        throw new Error(`FSRS shadow 字段 "${key}" 泄漏进 official decision`);
      }
    }
  }
  return { isolated: true, checkedFields: [...decisionKeys] };
}

export type FSRSPromotionStatus = "shadow_only";

/**
 * FSRS 转正状态（§9）：FSRS 只有完成连续 stability/difficulty 状态、校准、工作量和
 * 回放 Gate 后才能转正（feature-flagged 正式接管）。**Agent 上线不自动授权转正**：
 * agentOnline 参数被显式忽略，返回值恒为 "shadow_only"。
 */
export function resolveFSRSPromotionStatus(agentOnline: boolean): FSRSPromotionStatus {
  // Agent 在线状态不影响 FSRS 转正：转正只由独立 Gate 判定（§9）。
  void agentOnline;
  return "shadow_only";
}
