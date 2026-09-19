import type {
  CompanionAccountPatch,
  CompanionAccountStateV1,
} from "@ailearn/shared/companion-shell-contracts";

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

/**
 * 助理权限档位（2026-09-19 权限分级对齐原设计）。
 *
 * - read_only：只允许读类工具；
 * - guided：写类/有影响的动作每次都要用户确认（现状行为）；
 * - full：用户预授权——除 irreversible 底线外不再逐步确认，路由直接自动跳转，
 *   自动设置/自动填充类工具直接执行。
 */
export const COMPANION_AGENT_PERMISSION_OPTIONS = [
  ["read_only", "只读"],
  ["guided", "分步确认"],
  ["full", "自动执行"],
] as const;

/** 默认静默时段：夜间 22:00 → 次日 07:00，与设置中心的口径一致。 */
export const DEFAULT_QUIET_HOURS = Object.freeze({
  startLocal: "22:00",
  endLocal: "07:00",
});

export type QuietHoursBoundary = "startLocal" | "endLocal";

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
 * 改一端边界时保留另一端与时区。空值（输入框被清空）不产生改动，
 * 避免把半成品时间写进账号状态。
 */
export function quietHoursWithBoundary(
  current: NonNullable<CompanionAccountPatch["quietHours"]>,
  boundary: QuietHoursBoundary,
  value: string,
): NonNullable<CompanionAccountPatch["quietHours"]> | null {
  const next = value.trim();
  if (!next) return null;
  return { ...current, [boundary]: next };
}

/**
 * 账号级关闭：只有读到真实状态且 `globalEnabled === false` 才算。
 * 未登录、加载中或读取失败都不隐藏形象——不能用"读不到"冒充"用户关掉了"。
 */
export function companionAccountDisabled(state: CompanionAccountStateV1 | null): boolean {
  return state !== null && !state.globalEnabled;
}
