import { describe, expect, it } from "vitest";
import type { LearningObjectivePrimaryActionV3, ObjectivePersonalStateV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import type { LearningRunResultV2 } from "@ailearn/shared/learning-run-v2-contracts";
import { learningRunFeedback, objectiveQuestRegion, runModePresentation } from "./objective-quest-presentation";

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
});
