/**
 * 主动策略 Policy Engine（文档 16 §10.2 纯函数部分）。
 *
 * 确定性策略批准主动提示；模型只负责在批准后生成表达。账号可用状态与
 * 介入强度是两个独立枚举。本模块只做判定（不读模型输出）。
 */

export type CompanionAvailabilityV1 = "online" | "dnd" | "offline";
export type CompanionInterventionLevelV1 = "quiet" | "moderate" | "active";

export interface ProactivePolicyInput {
  availability: CompanionAvailabilityV1;
  interventionLevel: CompanionInterventionLevelV1;
  /** 用户是否正在正式作答/录音（formal_answer）。 */
  formalAnswerInProgress: boolean;
  /** 距上次同 dedupeKey 展示的毫秒数（无记录为 null）。 */
  msSinceLastShown: number | null;
  /** 该 dedupeKey 在冷却窗口内已展示次数。 */
  recentShownCount: number;
  /** 同用户今日主动提示总数。 */
  dailyShownTotal: number;
  /** 提示是否已过期（now > expiresAt）。 */
  expired: boolean;
  now: number;
}

export interface ProactivePolicyDecision {
  allow: boolean;
  reasonCode:
    | "allowed"
    | "dnd"
    | "offline"
    | "quiet_budget_exhausted"
    | "formal_answer_in_progress"
    | "cooldown"
    | "dedupe_recent"
    | "expired";
}

export const POLICY_LIMITS = {
  /** quiet 级别单日主动提示上限（方案 16 §10.2：0 条；首邀与可恢复故障例外由调用方处理）。 */
  quietDailyLimit: 0,
  /** moderate 级别单日主动提示上限（每日最多 3 条）。 */
  moderateDailyLimit: 3,
  /** active 级别单日主动提示上限（每日最多 6 条）。 */
  activeDailyLimit: 6,
  /** moderate 最少间隔（30 分钟）。 */
  moderateCooldownMs: 30 * 60 * 1000,
  /** active 最少间隔（15 分钟）。 */
  activeCooldownMs: 15 * 60 * 1000,
  /** 冷却窗口内同 key 最大展示次数。 */
  dedupeWindowLimit: 2,
} as const;

/** 确定性主动策略（§10.2 的允许边界；不读模型输出）。 */
export function evaluateProactivePolicy(input: ProactivePolicyInput): ProactivePolicyDecision {
  if (input.availability === "dnd") return { allow: false, reasonCode: "dnd" };
  if (input.availability === "offline") return { allow: false, reasonCode: "offline" };
  if (input.formalAnswerInProgress) return { allow: false, reasonCode: "formal_answer_in_progress" };
  if (input.expired) return { allow: false, reasonCode: "expired" };
  const dailyLimit = input.interventionLevel === "quiet"
    ? POLICY_LIMITS.quietDailyLimit
    : input.interventionLevel === "active"
      ? POLICY_LIMITS.activeDailyLimit
      : POLICY_LIMITS.moderateDailyLimit;
  if (input.dailyShownTotal >= dailyLimit) {
    return { allow: false, reasonCode: "quiet_budget_exhausted" };
  }
  const cooldownMs = input.interventionLevel === "active"
    ? POLICY_LIMITS.activeCooldownMs
    : POLICY_LIMITS.moderateCooldownMs;
  if (
    input.msSinceLastShown !== null
    && input.msSinceLastShown < cooldownMs
  ) {
    return { allow: false, reasonCode: "cooldown" };
  }
  if (input.recentShownCount >= POLICY_LIMITS.dedupeWindowLimit) {
    return { allow: false, reasonCode: "dedupe_recent" };
  }
  return { allow: true, reasonCode: "allowed" };
}

// ─── 展示反馈进生成（念头管线切片①，2026-09-18 落地） ────────────────────
// 设计（outputs/ai-伴星能力与主动性设计汇总 §四·反馈回路）：被回应→强化、
// 被忽略→降权。最小闭环：最近窗口内真正送达过用户的主动提示里，被 dismiss
// 的占到多数 → 本轮沉默（大多数念头默默过期）。
export const DISMISSAL_FEEDBACK = {
  /** 参与反馈判定的最近送达条数。 */
  windowSize: 3,
  /** 该窗口内 dismiss 数达到阈值即抑制本轮。 */
  dismissLimit: 2,
} as const;

/**
 * 输入为最近若干条「已送达用户」的 delivery 状态（最新在前，只收
 * displayed/acted/dismissed——未读的 queued/delivered 不构成反馈）。
 */
export function evaluateDismissalFeedback(states: readonly string[]): { suppress: boolean } {
  const recent = states.slice(0, DISMISSAL_FEEDBACK.windowSize);
  const dismissed = recent.filter((state) => state === "dismissed").length;
  return { suppress: dismissed >= DISMISSAL_FEEDBACK.dismissLimit };
}
