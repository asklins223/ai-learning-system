import { describe, expect, it } from "vitest";
import {
  COMPANION_INTERVENTION_OPTIONS,
  COMPANION_PRESENCE_OPTIONS,
  DEFAULT_QUIET_HOURS,
  companionAccountDisabled,
  companionInterventionHint,
  quietHoursPatch,
  quietHoursWithBoundary,
} from "./companion-account-presence";
import { companionAccountStateV1Schema } from "@ailearn/shared/companion-shell-contracts";
import { PROACTIVE_CADENCE_MS } from "@ailearn/shared/companion-proactive-policy";

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

  it("改一端边界保留另一端与时区；不成立的改动画面上给原因，不悄悄吞掉", () => {
    const current = { startLocal: "22:00", endLocal: "07:00", timezone: "Asia/Shanghai" };
    expect(quietHoursWithBoundary(current, "startLocal", "23:30")).toEqual({
      ok: true,
      value: { startLocal: "23:30", endLocal: "07:00", timezone: "Asia/Shanghai" },
    });
    expect(quietHoursWithBoundary(current, "endLocal", "06:15")).toEqual({
      ok: true,
      value: { startLocal: "22:00", endLocal: "06:15", timezone: "Asia/Shanghai" },
    });
    // 跨零点仍然合法：默认那一条本身就是 22:00 → 次日 07:00。
    expect(quietHoursWithBoundary(current, "startLocal", "06:30").ok).toBe(true);

    // 清空：旧写法回 `null`，界面上于是"什么都没发生"，受控值还把旧时间弹回去。
    const cleared = quietHoursWithBoundary(current, "endLocal", "   ");
    expect(cleared.ok).toBe(false);
    expect(cleared.ok === false && cleared.reason).toContain("都要填");

    // 两端相等在服务端那一侧是**合法值**，含义是"一整天都不说话"
    // （`companion-proactive-policy.ts:244`，那里还有测试把它钉成合同）。
    // 所以拦在界面上并说清后果，而不是让用户以为自己只是设了一个零长的窗口。
    const same = quietHoursWithBoundary(current, "endLocal", "22:00");
    expect(same.ok).toBe(false);
    expect(same.ok === false && same.reason).toContain("一整天");
  });

  it("未登录/加载中/读取失败都不算账号级关闭", () => {
    expect(companionAccountDisabled(null)).toBe(false);
    expect(companionAccountDisabled(accountState())).toBe(false);
    expect(companionAccountDisabled(accountState({ globalEnabled: false }))).toBe(true);
  });
});

/**
 * 「主动介入」和人格页的「活跃度」是三档同名的两个设置（安静/适中·适度/活跃），
 * 用户看界面分不出它们管的不是一回事——而 §9.61 刚把前者的语义从"一天几条"
 * 改成"最小间隔"。所以这一档必须自己把话说清，且**数字从服务端那份映射里取**：
 * 界面里重写一遍小时数，就是第五次出现"同一个安静一点得到两个答案"。
 */
describe("「主动介入」的说明文案", () => {
  it("三档各说各的间隔", () => {
    expect(companionInterventionHint("quiet")).toContain("3 小时");
    expect(companionInterventionHint("moderate")).toContain("1 小时 30 分");
    expect(companionInterventionHint("active")).toContain("30 分钟");
  });

  it("说清这是「主动开口的间隔」，并交代两个边界", () => {
    const hint = companionInterventionHint("moderate");
    // ① 与人格页的「活跃度」（说话长短）区分开；② 到点提醒不受这一档管。
    expect(hint).toContain("人格");
    expect(hint).toContain("提醒");
  });

  it("文案里的数字与 PROACTIVE_CADENCE_MS 一致（改了映射，文案跟着走）", () => {
    for (const [level] of COMPANION_INTERVENTION_OPTIONS) {
      const rendered = companionInterventionHint(level).match(/约(.+?)一次/)?.[1]?.trim();
      expect(rendered, `第 ${level} 档没渲染出间隔`).toBeTruthy();
      const hours = Number(rendered?.match(/(\d+) 小时/)?.[1] ?? 0);
      const minutes = Number(rendered?.match(/(\d+) 分/)?.[1] ?? 0);
      expect(hours * 60 + minutes).toBe(PROACTIVE_CADENCE_MS[level] / 60_000);
    }
  });
});
