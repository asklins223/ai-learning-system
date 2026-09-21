import { describe, expect, it } from "vitest";
import {
  objectivePersonalStateV3Schema,
  type LearningObjectivePrimaryActionV3,
} from "@ailearn/shared/learning-objective-surface-contracts";
import {
  formatObjectiveDateTime,
  formatObjectiveState,
  objectiveStateHint,
  objectiveProgressChips,
  objectiveStateNeedsAttention,
  objectiveStateTone,
  primaryActionDescription,
  primaryActionLabel,
} from "./objective-state-copy";

const CARD_START = {
  version: 2,
  originV2: { kind: "card", cardId: "00000000-0000-4000-8000-000000000004", objectiveId: "00000000-0000-4000-8000-000000000001" },
  goal: "stabilize",
  requestedTimeBudgetSeconds: 180,
  responsePreference: "adaptive",
} as const;

describe("理解目标状态文案", () => {
  it("服务端状态枚举里每一个值都有人话说法，不露原始 token", () => {
    for (const state of objectivePersonalStateV3Schema.options) {
      const label = formatObjectiveState(state);
      expect(label, `state=${state} 没有文案`).not.toBe(state);
      expect(label).not.toMatch(/[a-z_]/);
      expect(objectiveStateHint(state).length, `state=${state} 没有说明`).toBeGreaterThan(0);
      expect(objectiveStateTone(state)).not.toBeNull();
    }
  });

  it("认不出的状态原样显示，不编造", () => {
    expect(formatObjectiveState("quantum_flux")).toBe("quantum_flux");
    expect(objectiveStateHint("quantum_flux")).toBe("");
    expect(objectiveStateTone("quantum_flux")).toBe("neutral");
  });

  it("「还没正式答过」不再写成谁都看不懂的「待验证」", () => {
    expect(formatObjectiveState("unvalidated")).toBe("还没正式答过");
    expect(objectiveStateNeedsAttention("unvalidated")).toBe(true);
    // 它不属于 tone 的 attention，却正是最需要被数进「要处理」的一类。
    expect(objectiveStateTone("unvalidated")).toBe("neutral");
  });

  it("每个动作的说明都回答「现在能做什么、什么时候能正式算」", () => {
    const actions: LearningObjectivePrimaryActionV3[] = [
      { kind: "resume_run", runId: "00000000-0000-4000-8000-000000000009", objectiveId: CARD_START.originV2.objectiveId },
      {
        kind: "practice_only",
        objectiveId: CARD_START.originV2.objectiveId,
        reasonCodes: ["exposed"],
        label: "带着参考答案练一下",
        start: CARD_START,
        formalValidationNotBefore: "2026-09-21T14:30:00.000Z",
      },
      {
        kind: "practice_only",
        objectiveId: CARD_START.originV2.objectiveId,
        reasonCodes: ["exposed"],
        label: "带着参考答案练一下",
        start: CARD_START,
        formalValidationNotBefore: null,
      },
      {
        kind: "wait_for_initial_validation",
        reminderId: "00000000-0000-4000-8000-000000000008",
        qualificationNotBefore: "2026-09-21T14:30:00.000Z",
      },
    ];
    const [resume, practicing, practicingOpenEnded, waiting] = actions;

    expect(primaryActionLabel(resume)).toBe("继续作答");
    // 冷却中的练习必须带上时间点；没有冷却时不许凭空造一个。
    // 时间点按本地时区渲染，所以钉"月日 + 时:分"的形状，不钉具体读数。
    expect(primaryActionDescription(practicing)).toMatch(/\d+月\d+日 \d{2}:\d{2}/);
    expect(primaryActionDescription(practicing)).not.toContain("2026-09-21T");
    expect(primaryActionDescription(practicingOpenEnded)).not.toMatch(/\d+月\d+日/);
    expect(primaryActionDescription(waiting)).toMatch(/\d+月\d+日 \d{2}:\d{2}/);
    for (const action of actions) {
      expect(primaryActionDescription(action)).not.toMatch(/practice_only|qualification|reminderId|服务端/);
    }
  });

  it("复习时间按「还有几天 / 已到期几天」说，不写成回顾", () => {
    const base = { practiceTrailCount: 1, lastCanonicalAt: null, initialValidation: null, validationNotBefore: null };
    const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    const reviewChip = (days: number) => objectiveProgressChips({ ...base, reviewDueAt: inDays(days) })
      .find((chip) => chip.startsWith("复习")) ?? "";
    expect(reviewChip(5)).toBe("复习 5 天后");
    // 实测过：「复习 11 天前」会被读成"11 天前复习过"。
    expect(reviewChip(-11)).toBe("复习已到期 11 天");
    expect(reviewChip(400)).toMatch(/^复习 \d+月\d+日$/);
  });

  it("时间点读不出来时也不给一个空白", () => {
    expect(formatObjectiveDateTime("not-a-date")).toBe("时间未定");
    expect(formatObjectiveDateTime(null)).toBe("时间未定");
  });

  it("日期写法由本模块定死，不跟 ICU 版本走", () => {
    // vitest 的 Node 与 Electron 的 full-icu 对 zh-CN `month:"numeric"` 给出的
    // 分别是「9/21」和「9月21日」——等待终点不能随环境变。
    const local = new Date(2026, 8, 21, 9, 5);
    expect(formatObjectiveDateTime(local.toISOString())).toBe("9月21日 09:05");
  });
});
