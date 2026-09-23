import { describe, expect, it } from "vitest";
import type { LearningObjectivePrimaryActionV3, ObjectivePersonalStateV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import type { LearningRunResultV2 } from "@ailearn/shared/learning-run-v2-contracts";
import { companionResultFeedbackAllowed, learningDiscoveryCard, learningRunFeedback, objectiveQuestRegion, runModePresentation } from "./objective-quest-presentation";

describe("理解远征展示模型", () => {
  it("把全部个人状态映射到三片真实地貌", () => {
    const states: ObjectivePersonalStateV3[] = [
      "unvalidated", "learning", "stable", "fragile", "needs_repair",
      "due_review", "scheduled", "archived", "superseded", "outdated",
    ];
    expect(Object.fromEntries(states.map((state) => [state, objectiveQuestRegion(state)]))).toEqual({
      unvalidated: "ready",
      learning: "active",
      stable: "mastered",
      fragile: "ready",
      needs_repair: "ready",
      due_review: "ready",
      scheduled: "active",
      archived: "active",
      superseded: "active",
      outdated: "ready",
    });
  });

  it("只把服务端签发的练习动作标成练习关", () => {
    const action = {
      kind: "practice_only",
      objectiveId: "00000000-0000-4000-8000-000000000001",
      reasonCodes: ["exposed"],
      label: "练习",
      start: {
        version: 2,
        originV2: { kind: "card", cardId: "00000000-0000-4000-8000-000000000002", objectiveId: "00000000-0000-4000-8000-000000000001" },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 180,
        responsePreference: "adaptive",
      },
      formalValidationNotBefore: null,
    } satisfies LearningObjectivePrimaryActionV3;
    expect(runModePresentation(action)).toMatchObject({ mode: "practice", label: "练习关" });
  });

  it("成功结果只复述真实 facet，不编造成就", () => {
    const result = {
      outcome: "demonstrated",
      demonstratedFacets: ["explain", "apply"],
      gapFacets: [],
    } as unknown as LearningRunResultV2;
    expect(learningRunFeedback(result)).toMatchObject({
      tone: "success",
      achievement: "解释、应用",
      gap: "没有留下新的理解缺口。",
    });
  });

  it("练习结果从逐条评分提取做对项，不只显示练习完成", () => {
    const result = {
      outcome: "practice_completed",
      demonstratedFacets: [],
      gapFacets: ["boundary"],
      assessment: {
        rubricResults: [
          { facet: "explain", verdict: "covered", userFacingReason: "已经说明了因果链。" },
          { facet: "boundary", verdict: "missing", userFacingReason: "还没说明边界。" },
        ],
      },
    } as unknown as LearningRunResultV2;
    expect(learningRunFeedback(result)).toMatchObject({
      achievement: "已经说明了因果链。",
      gap: "还没说明边界。",
      strengths: ["已经说明了因果链。"],
      improvements: ["还没说明边界。"],
    });
  });

  it("练习没有评分时明确说无法判断对错，不把完成冒充答对", () => {
    const result = {
      outcome: "practice_completed",
      demonstratedFacets: [],
      gapFacets: [],
      assessment: undefined,
    } as unknown as LearningRunResultV2;
    expect(learningRunFeedback(result).achievement).toContain("暂时不能判断对错");
  });

  it.each([
    ["partial", "progress", "已经证明了一部分"],
    ["needs_repair", "progress", "找到下一处要修补的地方"],
    ["declared_unable", "neutral", "承认暂时不会也是有效的学习判断"],
    ["skipped", "neutral", "这一关先放回路线里"],
    ["not_assessable", "neutral", "这次还没有形成可评估的证据"],
  ] as const)("%s 的首层反馈说明真实结果", (outcome, tone, headline) => {
    const result = { outcome, demonstratedFacets: [], gapFacets: [] } as unknown as LearningRunResultV2;
    expect(learningRunFeedback(result)).toMatchObject({ tone, headline });
  });

  it("发现卡的惊喜样式稳定，内容只来自本轮评分证据", () => {
    const result = {
      outcome: "practice_completed",
      demonstratedFacets: [],
      gapFacets: [],
      assessment: {
        rubricResults: [{ facet: "explain", verdict: "covered", userFacingReason: "因果关系已经说清。" }],
      },
    } as unknown as LearningRunResultV2;
    const first = learningDiscoveryCard(result, "run:result");
    expect(learningDiscoveryCard(result, "run:result")).toEqual(first);
    expect(first).toMatchObject({ title: "你把“为什么”讲清了", detail: "因果关系已经说清。" });
  });

  it("总静音、安静风格、空间静默和关闭玩笑都会抑制伴星庆祝", () => {
    const base = { masterMuted: false, temporarilyHidden: false, activeness: "moderate" as const, proactiveMuted: false, allowPlayful: true };
    expect(companionResultFeedbackAllowed(base)).toBe(true);
    expect(companionResultFeedbackAllowed({ ...base, masterMuted: true })).toBe(false);
    expect(companionResultFeedbackAllowed({ ...base, activeness: "quiet" })).toBe(false);
    expect(companionResultFeedbackAllowed({ ...base, proactiveMuted: true })).toBe(false);
    expect(companionResultFeedbackAllowed({ ...base, allowPlayful: false })).toBe(false);
    expect(companionResultFeedbackAllowed({ ...base, activeness: null })).toBe(false);
  });

  it("没有评分项、掌握 facet 或缺口时不伪造发现卡", () => {
    const result = {
      outcome: "skipped",
      demonstratedFacets: [],
      gapFacets: [],
      assessment: undefined,
    } as unknown as LearningRunResultV2;
    expect(learningDiscoveryCard(result, "run:skipped")).toBeNull();
  });
});
