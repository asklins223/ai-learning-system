/**
 * Review attempt formatting utilities (LOOP-01/02).
 *
 * Pure functions extracted from ReviewAttemptHistory component for testability.
 * These cover relative time, schedule change, and label lookups for attempt
 * outcomes, reason codes, and answer types.
 */

export type AttemptOutcome = "correct" | "partial" | "incorrect" | "unable";
export type OutcomeTone = "success" | "warning" | "danger" | "muted";

export interface OutcomeMeta {
  label: string;
  tone: OutcomeTone;
}

export const OUTCOME_LABELS: Record<string, OutcomeMeta> = {
  correct: { label: "掌握", tone: "success" },
  partial: { label: "部分掌握", tone: "warning" },
  incorrect: { label: "未掌握", tone: "danger" },
  unable: { label: "无法判断", tone: "muted" },
};

export const REASON_CODE_LABELS: Record<string, string> = {
  correct_advance: "回答正确，复习间隔已延长",
  correct_interval_cap: "回答正确，已达到最长复习间隔",
  partial_advance: "部分掌握，复习间隔已延长一档",
  partial_interval_cap: "部分掌握，已保持最长复习间隔",
  incorrect_reset: "本轮未掌握，下次从短间隔重新巩固",
  unable_reset: "本轮无法判断，下次从短间隔重新确认",
  later_short_deferral: "已稍后处理，短暂推迟本轮复习",
  question_invalid: "验证问题不可用，本轮暂不提升间隔",
  evidence_insufficient: "关键点证据不足，本轮暂不提升间隔",
  // 兼容早期 v0.5 记录，避免历史数据回退为原始英文代码。
  correct_full: "全部正确，间隔延长",
  correct_recover: "纠正后正确，恢复间隔",
  partial_shorten: "部分正确，缩短间隔",
  unable_later: "无法判断，推迟复习",
  later_postpone: "主动推迟",
  initial: "首次安排",
  scheduled: "按计划到期",
};

export const UNDERSTANDING_EFFECT_LABELS: Record<string, string> = {
  upgrade: "理解状态已提升",
  downgrade: "理解状态已标记为需要继续巩固",
  unchanged: "理解状态保持不变",
};

export const ANSWER_TYPE_LABELS: Record<string, string> = {
  recall: "回忆",
  free_text: "自由作答",
  self_grade: "自评",
};

/**
 * Format an ISO timestamp as a relative time string in Chinese.
 * Returns empty string for null/invalid input.
 *
 * Examples: "刚刚", "3 分钟前", "2 小时后", "5 天前", "2 个月后", "1 年前"
 */
export function formatRelativeTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = Date.now();
  const diff = date.getTime() - now;
  const isFuture = diff > 0;
  const absoluteDiff = Math.abs(diff);
  const suffix = isFuture ? "后" : "前";

  if (absoluteDiff < 60_000) return isFuture ? "不到 1 分钟后" : "刚刚";

  const minutes = Math.floor(absoluteDiff / 60_000);
  if (minutes < 60) return `${minutes} 分钟${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${suffix}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天${suffix}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月${suffix}`;
  return `${Math.floor(months / 12)} 年${suffix}`;
}

/**
 * Format a schedule interval change for display.
 *
 * @param before - interval in days before the attempt (null = first schedule)
 * @param after - interval in days after the attempt (null = unscheduled)
 * @returns human-readable change description
 */
export function formatScheduleChange(
  before: number | null,
  after: number | null,
): string {
  if (before === null && after === null) return "—";
  if (before === null) return `首次安排 · ${after} 天后`;
  if (after === null) return `${before} 天 → 未安排`;
  if (before === after) return `维持 ${after} 天`;
  if (after > before) return `${before} 天 → ${after} 天（延长）`;
  return `${before} 天 → ${after} 天（缩短）`;
}

/**
 * Look up outcome metadata by outcome string.
 * Returns null for unknown/null outcomes.
 */
export function getOutcomeMeta(outcome: string | null | undefined): OutcomeMeta | null {
  if (!outcome) return null;
  return OUTCOME_LABELS[outcome] ?? null;
}

/**
 * Look up reason code label by code string.
 * Returns the original code if unknown, null if input is null/undefined.
 */
export function getReasonCodeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return REASON_CODE_LABELS[code] ?? code;
}

/**
 * Look up answer type label by type string.
 * Returns the original type if unknown, null if input is null/undefined.
 */
export function getAnswerTypeLabel(type: string | null | undefined): string | null {
  if (!type) return null;
  return ANSWER_TYPE_LABELS[type] ?? type;
}

/**
 * Look up the user-facing effect of an attempt on the understanding state.
 * Returns the original value for forward-compatible unknown effects.
 */
export function getUnderstandingEffectLabel(
  effect: string | null | undefined,
): string | null {
  if (!effect) return null;
  return UNDERSTANDING_EFFECT_LABELS[effect] ?? effect;
}
