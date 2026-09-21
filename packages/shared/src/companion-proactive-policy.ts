/**
 * 主动策略 Policy Engine（文档 16 §10.2 纯函数部分）。
 *
 * 确定性策略批准主动提示；模型只负责在批准后生成表达。账号可用状态与
 * 介入强度是两个独立枚举。本模块只做判定（不读模型输出）。
 *
 * 放在 shared 而不是 api 的模块里，因为**判定主动输出额度的是两个进程**：
 * API 的 proactive-hook，和 worker 的念头管线（companion-thought.ts）。
 * 以前两边各有一份预算（api 3/6、worker 固定 2），quiet 档在 api 侧结构性为 0，
 * 在 worker 侧却照样能送——同一个"安静一点"得到两套结果。预算必须只有一个来源。
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
    | "daily_budget_exhausted"
    | "formal_answer_in_progress"
    | "cooldown"
    | "dedupe_recent"
    | "expired";
}

export const POLICY_LIMITS = {
  /**
   * quiet 级别单日主动提示上限。**曾经是 0**（方案 16 §10.2 写"安静=不主动"）。
   *
   * 0 不是"安静"，是"关掉"：用户设成安静之后，主动提醒这件事在结构上永远不会发生，
   * 于是"她从不主动提醒"（抱怨 #8）在安静档下不是 bug 而是必然——而界面上并没有
   * "关闭主动提醒"这个开关，只有一档写着"安静"。安静应该是**少而轻**，所以是 1：
   * 一天最多一条，且必须是真值得开口的内容（预算之外仍受冷却/去重/反馈降权约束）。
   * 真要完全关闭，用账号级 `globalEnabled`（界面上有）。
   */
  quietDailyLimit: 1,
  /** moderate 级别单日主动提示上限。 */
  moderateDailyLimit: 3,
  /** active 级别单日主动提示上限。 */
  activeDailyLimit: 6,
  /** moderate 最少间隔（30 分钟）。 */
  moderateCooldownMs: 30 * 60 * 1000,
  /** active 最少间隔（15 分钟）。 */
  activeCooldownMs: 15 * 60 * 1000,
  /** 冷却窗口内同 key 最大展示次数。 */
  dedupeWindowLimit: 2,
} as const;

/**
 * 单日主动提示额度。**唯一的映射处**：API 的 proactive-hook 与 worker 的念头管线
 * 都从这里取值，否则同一个"安静一点"在两条链路上得到两个预算。
 */
export function proactiveDailyLimit(level: CompanionInterventionLevelV1): number {
  if (level === "quiet") return POLICY_LIMITS.quietDailyLimit;
  if (level === "active") return POLICY_LIMITS.activeDailyLimit;
  return POLICY_LIMITS.moderateDailyLimit;
}

/** 确定性主动策略（§10.2 的允许边界；不读模型输出）。 */
export function evaluateProactivePolicy(input: ProactivePolicyInput): ProactivePolicyDecision {
  if (input.availability === "dnd") return { allow: false, reasonCode: "dnd" };
  if (input.availability === "offline") return { allow: false, reasonCode: "offline" };
  if (input.formalAnswerInProgress) return { allow: false, reasonCode: "formal_answer_in_progress" };
  if (input.expired) return { allow: false, reasonCode: "expired" };
  const dailyLimit = proactiveDailyLimit(input.interventionLevel);
  if (input.dailyShownTotal >= dailyLimit) {
    return { allow: false, reasonCode: "daily_budget_exhausted" };
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

// ─── 静默时段（唯一的实现）────────────────────────────────────────────────
//
// 这里原来有两份拷贝：api 的 `proactive-hook.isWithinQuietHours` 与 worker 的
// `companion-thought.isWithinQuietHoursLocal`。**它们已经分叉了**，而且是往危险的方向：
//   - api 那份的注释写着"时区解析失败时 fail closed 抑制（宁可少打扰）"，代码却是
//     `catch { return false }`——false 意思是"**不在**静默时段"，于是配置一坏就照发；
//     `parseClock` 遇到 `"25:00"` 也返回 null → 同样放行；
//   - worker 那份两个分支都返回 true（抑制）。
// 结果是同一个坏配置：API 路径会半夜吵人，念头路径会整天沉默。两份都留在代码里，
// 就永远没人能说出"她到底会不会在 23:30 开口"。
//
// 统一后的语义：任何解析不出可信钟面值的情况，一律**按静默处理**（不打扰）。
// 真要收提醒，把静默时段清空即可，那是显式动作。

export interface CompanionQuietHours {
  readonly startLocal: string;
  readonly endLocal: string;
  readonly timezone: string;
}

const QUIET_HOURS_FORMATTER_MAX = 32;
const quietHoursFormatterCache = new Map<string, Intl.DateTimeFormat>();

function quietHoursFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = quietHoursFormatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (quietHoursFormatterCache.size >= QUIET_HOURS_FORMATTER_MAX) {
    quietHoursFormatterCache.delete(quietHoursFormatterCache.keys().next().value as string);
  }
  quietHoursFormatterCache.set(timezone, formatter);
  return formatter;
}

/** "HH:MM" → 分钟；不接受 24:00 之外的越界值（24:00 归一为 00:00）。 */
function parseClockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59) return null;
  if (hour === 24) return minute === 0 ? 0 : null;
  if (hour > 23) return null;
  return hour * 60 + minute;
}

/**
 * 静默时段判定（方案 16 §10.2）：HH:MM（startLocal/endLocal）+ IANA 时区，
 * 按**本地钟面**比较，`start > end` 视为跨午夜环绕，`start === end` 视为全时段静默。
 */
export function isWithinQuietHours(quietHours: CompanionQuietHours, now: Date): boolean {
  try {
    const parts = quietHoursFormatter(quietHours.timezone).formatToParts(now);
    // en-US + hour12:false 在午夜可能给出 "24"；不 %24 会算出 1440 分，跨午夜分支判错。
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "") % 24;
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "");
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return true;
    const current = hour * 60 + minute;
    const start = parseClockMinutes(quietHours.startLocal);
    const end = parseClockMinutes(quietHours.endLocal);
    if (start === null || end === null) return true;
    if (start === end) return true;
    if (start < end) return current >= start && current < end;
    return current >= start || current < end;
  } catch {
    return true;
  }
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
