import type {
  CompanionAccountPatch,
  CompanionAccountStateV1,
} from "@ailearn/shared/companion-shell-contracts";
import { PROACTIVE_CADENCE_MS } from "@ailearn/shared/companion-proactive-policy";

/**
 * 账号级 presence 的纯函数层（2026-09-16 裁决 3）。
 *
 * 这里只负责把面板上的选择翻译成 strict `CompanionAccountPatchV1` 的字段，
 * 不持有状态、不发请求：写入顺序、revision CAS 与冲突重取都在
 * CompanionPresence 里完成，便于单独验证每个选项的协议形状。
 */

export const COMPANION_PRESENCE_OPTIONS = [
  ["online", "在线"],
  ["dnd", "勿扰"],
  ["offline", "离线"],
] as const;

export const COMPANION_INTERVENTION_OPTIONS = [
  ["quiet", "安静"],
  ["moderate", "适中"],
  ["active", "活跃"],
] as const;

export type CompanionInterventionLevel = (typeof COMPANION_INTERVENTION_OPTIONS)[number][0];

/**
 * 「主动介入」这一档的人话说明。
 *
 * 为什么需要：人格页有个「活跃度」（安静/适度/活跃），这里有个「主动介入」
 * （安静/适中/活跃）——**三档同名，管的却不是一回事**（前者是说话长短，后者是
 * 多久主动开口一次），用户看界面分不出来。§9.61 把后者从"一天几条"改成"最小间隔"
 * 之后，这个差别更要写明白。
 *
 * 数字**从 `PROACTIVE_CADENCE_MS` 现算**，不在界面里重写一遍小时数——那正是
 * 这次删掉的那种病：同一个"安静一点"在两条链路上得到两个答案。
 */
export function companionInterventionHint(level: CompanionInterventionLevel): string {
  const minutes = Math.round(PROACTIVE_CADENCE_MS[level] / 60_000);
  const span = minutes % 60 === 0
    ? `${minutes / 60} 小时`
    : minutes > 60
      ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
      : `${minutes} 分钟`;
  return `她主动开口的最小间隔：约 ${span}一次。`
    + "说话长短在「人格」页的活跃度里调；到点的提醒不受这一档限制。";
}

/**
 * 助理权限档位（2026-09-19 权限分级对齐原设计）。
 *
 * - read_only：只允许读类工具；
 * - guided：写类/有影响的动作每次都要用户确认（现状行为）；
 * - full：用户预授权——除 irreversible 底线外不再逐步确认，路由直接自动跳转，
 *   自动设置/自动填充类工具直接执行。
 */
export const COMPANION_AGENT_PERMISSION_OPTIONS = [
  ["read_only", "仅可读取"],
  ["guided", "分步确认"],
  ["full", "自动执行"],
] as const;

/** 默认静默时段：夜间 22:00 → 次日 07:00，与设置中心的口径一致。 */
export const DEFAULT_QUIET_HOURS = Object.freeze({
  startLocal: "22:00",
  endLocal: "07:00",
});

export type QuietHoursBoundary = "startLocal" | "endLocal";

export type QuietHoursBoundaryResult =
  | { readonly ok: true; readonly value: NonNullable<CompanionAccountPatch["quietHours"]> }
  /** 不成立时给一句能直接摆在界面上的原因，而不是 `null` 让调用方静默什么都不做。 */
  | { readonly ok: false; readonly reason: string };

/**
 * 勾选/取消静默时段。开启时使用设备时区与默认夜间区间；关闭时显式提交
 * `null`（服务端把它读作"没有静默时段"），而不是省略字段。
 */
export function quietHoursPatch(
  enabled: boolean,
  timezone: string,
): NonNullable<CompanionAccountPatch["quietHours"]> | null {
  if (!enabled) return null;
  return {
    startLocal: DEFAULT_QUIET_HOURS.startLocal,
    endLocal: DEFAULT_QUIET_HOURS.endLocal,
    timezone,
  };
}

/**
 * 改一端边界时保留另一端与时区。
 *
 * 这里必须**给原因**而不是回一个 `null`：
 * - 输入框被清空时，回 `null` 的旧写法让界面什么都不做，而受控值把旧时间弹回去 ——
 *   用户以为"改了没生效"，其实是根本没提交（方案 35 D3）。
 * - 两端相等更不能悄悄放过：服务端把 `startLocal === endLocal` 判成**全天静默**
 *   （`companion-proactive-policy.ts:244`，且 `companion-proactive-policy.test.ts:187`
 *   把这条行为钉成了合同）。那是一个合法取值，但对用户来说等于"她再也不说话"，
 *   而界面上没有任何一处解释过。所以：不提交，并把原因说在界面上。
 */
export function quietHoursWithBoundary(
  current: NonNullable<CompanionAccountPatch["quietHours"]>,
  boundary: QuietHoursBoundary,
  value: string,
): QuietHoursBoundaryResult {
  const next = value.trim();
  if (!next) {
    return { ok: false, reason: "开始与结束两个时间都要填，空着她不知道你要哪一段。" };
  }
  const candidate = { ...current, [boundary]: next };
  if (candidate.startLocal === candidate.endLocal) {
    return { ok: false, reason: "两个时间写成同一个点，她会理解成一整天都不说话。" };
  }
  return { ok: true, value: candidate };
}

/**
 * 账号级关闭：只有读到真实状态且 `globalEnabled === false` 才算。
 * 未登录、加载中或读取失败都不隐藏形象——不能用"读不到"冒充"用户关掉了"。
 */
export function companionAccountDisabled(state: CompanionAccountStateV1 | null): boolean {
  return state !== null && !state.globalEnabled;
}
