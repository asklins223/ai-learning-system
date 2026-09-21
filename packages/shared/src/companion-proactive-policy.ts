/**
 * 主动策略 Policy Engine（文档 16 §10.2 纯函数部分）。
 *
 * 确定性策略批准主动提示；模型只负责在批准后生成表达。账号可用状态与
 * 介入强度是两个独立枚举。本模块只做判定（不读模型输出）。
 *
 * 放在 shared 而不是 api 的模块里，因为**判定主动节奏的是两个进程**：
 * API 的 proactive-hook，和 worker 的念头管线（companion-thought.ts）。
 * 以前两边各有一份预算（api 3/6、worker 固定 2），quiet 档在 api 侧结构性为 0，
 * 在 worker 侧却照样能送——同一个"安静一点"得到两套结果。节奏必须只有一个来源。
 *
 * 2026-09-21 的口径改动：**"一天 N 条"这个控件被删掉**，只留"按偏好定间隔"，
 * 并把推送分成 routine / triggered 两类——触发式（用户先约好的提醒、
 * 他正在等的学习完成）不进任何频率限制。理由见 PROACTIVE_CADENCE_MS 的注释。
 */

export type CompanionAvailabilityV1 = "online" | "dnd" | "offline";
export type CompanionInterventionLevelV1 = "quiet" | "moderate" | "active";

/**
 * 两种主动输出，只有一种是"频率"的对象：
 *
 * - **routine** 她自己想开口（到期复习、连续天数、冷启动、模型念头）。这类才有
 *   "多久说一次"的问题，节奏由 `intervention_level` 决定。
 * - **triggered** 用户先要过的（0238 的到点提醒）或正在等的（学习运行完成）。
 *   这类**不进任何频率限制**：一条 09:00 的提醒如果被"她今天话说多了"压掉，
 *   用户得到的是"提醒不准"，而不是"她很有分寸"。
 */
export type ProactivePushKind = "routine" | "triggered";

export interface ProactivePolicyInput {
  availability: CompanionAvailabilityV1;
  interventionLevel: CompanionInterventionLevelV1;
  /** 用户是否正在正式作答/录音（formal_answer）。 */
  formalAnswerInProgress: boolean;
  /** 距上次同 dedupeKey 展示的毫秒数（无记录为 null）。 */
  msSinceLastShown: number | null;
  /** 该 dedupeKey 在冷却窗口内已展示次数。 */
  recentShownCount: number;
  /** 提示是否已过期（now > expiresAt）。 */
  expired: boolean;
  /** 这次推送是哪一类；缺省按 routine（宁可少说，不可吞掉用户约好的东西）。 */
  kind?: ProactivePushKind;
  now: number;
}

export interface ProactivePolicyDecision {
  allow: boolean;
  reasonCode:
    | "allowed"
    | "dnd"
    | "offline"
    | "formal_answer_in_progress"
    | "cooldown"
    | "dedupe_recent"
    | "expired";
}

export const POLICY_LIMITS = {
  /** 冷却窗口内同 key 最大展示次数。 */
  dedupeWindowLimit: 2,
} as const;

/**
 * 例行主动的最小间隔——**唯一的映射处**（用户 2026-09-21 的口径：
 * "不要给我限制，按用户偏好设置推送频率即可"）。
 *
 * 这里以前是三个"单日额度"（quiet 1 / moderate 3 / active 6）。额度是错的控件：
 * 它不回答"什么时候说"，只回答"说到几条就闭嘴"，于是三档的体感差别是
 * "一天三条 vs 一天六条"，而不是"话多话少"。更糟的是它**会整天静音**——
 * 实测 2026-09-21 13:20 那三条被从没展示过的僵尸念头占满，她连续 21 小时没出声，
 * 而所有上游健康检查都是绿的（§9.58）。
 *
 * 间隔才是"少而轻 vs 多而密"：安静档 3 小时一次（醒着的时间一天约 4–5 次机会），
 * 适度 90 分钟，活跃 30 分钟。上限由"有没有值得说的话"决定（候选去重、
 * 同一件事一天只提一次、每次调度最多送一条），不是由计数器决定。
 */
export const PROACTIVE_CADENCE_MS: Readonly<Record<CompanionInterventionLevelV1, number>> =
  Object.freeze({
    quiet: 3 * 60 * 60 * 1000,
    moderate: 90 * 60 * 1000,
    active: 30 * 60 * 1000,
  });

export function proactiveCadenceMs(level: CompanionInterventionLevelV1): number {
  return PROACTIVE_CADENCE_MS[level];
}

/**
 * 例行主动的间隔判定。API 的 proactive-hook 与 worker 的念头管线**共用这一条**：
 * 两边各写一份时，同一个"安静一点"在两条链路上会得到两个节奏（§9.58 之前就是这样，
 * 一边 3/6 一边固定 2）。
 */
export function routineCadenceBlocked(input: {
  interventionLevel: CompanionInterventionLevelV1;
  /** 距上一次例行主动开口的毫秒数；从没开过口为 null。 */
  msSinceLastCue: number | null;
}): boolean {
  return input.msSinceLastCue !== null
    && input.msSinceLastCue < proactiveCadenceMs(input.interventionLevel);
}

/**
 * 触发式推送的判定（学习运行完成、到点提醒……用户先要过或正在等的东西）。
 *
 * 单独开一个入口而不是给 `evaluateProactivePolicy` 传一堆"反正不看"的字段：
 * 它要回答的只有"现在能不能给这个人看"，间隔/作答/静默时段/去重都不属于它。
 * 设备明确不在（dnd/offline）仍然挡——气泡进收件箱，人回来照样看得见。
 */
export function evaluateTriggeredPush(input: {
  availability: CompanionAvailabilityV1;
  expired: boolean;
}): ProactivePolicyDecision {
  if (input.availability === "dnd") return { allow: false, reasonCode: "dnd" };
  if (input.availability === "offline") return { allow: false, reasonCode: "offline" };
  if (input.expired) return { allow: false, reasonCode: "expired" };
  return { allow: true, reasonCode: "allowed" };
}

/** 确定性主动策略（§10.2 的允许边界；不读模型输出）。 */
export function evaluateProactivePolicy(input: ProactivePolicyInput): ProactivePolicyDecision {
  if ((input.kind ?? "routine") === "triggered") {
    return evaluateTriggeredPush({ availability: input.availability, expired: input.expired });
  }
  if (input.availability === "dnd") return { allow: false, reasonCode: "dnd" };
  if (input.availability === "offline") return { allow: false, reasonCode: "offline" };
  if (input.expired) return { allow: false, reasonCode: "expired" };
  if (input.formalAnswerInProgress) return { allow: false, reasonCode: "formal_answer_in_progress" };
  if (routineCadenceBlocked({
    interventionLevel: input.interventionLevel,
    msSinceLastCue: input.msSinceLastShown,
  })) {
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
