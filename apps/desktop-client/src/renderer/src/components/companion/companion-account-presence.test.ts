import { describe, expect, it } from "vitest";
import {
  COMPANION_INTERVENTION_OPTIONS,
  COMPANION_PRESENCE_OPTIONS,
  DEFAULT_QUIET_HOURS,
  companionAccountDisabled,
  quietHoursPatch,
  quietHoursWithBoundary,
} from "./companion-account-presence";
import { companionAccountStateV1Schema } from "@ailearn/shared/companion-shell-contracts";

const accountState = (overrides: { globalEnabled?: boolean } = {}) => companionAccountStateV1Schema.parse({
  revision: 4,
  epoch: 1,
  globalEnabled: overrides.globalEnabled ?? true,
});

describe("账号级 presence 选项（2026-09-16 裁决 3）", () => {
  it("只暴露契约允许的在线状态与介入强度取值", () => {
    expect(COMPANION_PRESENCE_OPTIONS.map(([value]) => value)).toEqual(["online", "dnd", "offline"]);
    expect(COMPANION_INTERVENTION_OPTIONS.map(([value]) => value)).toEqual(["quiet", "moderate", "active"]);
  });

  it("开启静默时段用设备时区与默认夜间区间，关闭时显式提交 null", () => {
    expect(quietHoursPatch(false, "Asia/Shanghai")).toBeNull();
    expect(quietHoursPatch(true, "Asia/Shanghai")).toEqual({
      startLocal: DEFAULT_QUIET_HOURS.startLocal,
      endLocal: DEFAULT_QUIET_HOURS.endLocal,
      timezone: "Asia/Shanghai",
    });
  });

  it("改一端边界时保留另一端与时区，空输入不产生半成品写入", () => {
    const current = { startLocal: "22:00", endLocal: "07:00", timezone: "Asia/Shanghai" };
    expect(quietHoursWithBoundary(current, "startLocal", "23:30")).toEqual({
      startLocal: "23:30",
      endLocal: "07:00",
      timezone: "Asia/Shanghai",
    });
    expect(quietHoursWithBoundary(current, "endLocal", "06:15")).toEqual({
      startLocal: "22:00",
      endLocal: "06:15",
      timezone: "Asia/Shanghai",
    });
    expect(quietHoursWithBoundary(current, "endLocal", "   ")).toBeNull();
  });

  it("未登录/加载中/读取失败都不算账号级关闭", () => {
    expect(companionAccountDisabled(null)).toBe(false);
    expect(companionAccountDisabled(accountState())).toBe(false);
    expect(companionAccountDisabled(accountState({ globalEnabled: false }))).toBe(true);
  });
});
