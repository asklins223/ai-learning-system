import { describe, expect, it } from "vitest";
import { dispatchLearningRunDemoIntent } from "./LearningRunRedrawLab";

describe("LearningRunRedrawLab intent routing", () => {
  it("finish_checkpoint 不会成为无响应操作", () => {
    expect(dispatchLearningRunDemoIntent(
      { kind: "finish_checkpoint" },
      { scenarioId: "review-voice", frameIndex: 1, checkpointKind: "not_assessable" },
    )).toMatchObject({ scenarioId: "result-semantics" });
  });

  it("request_hint 先进入 active practice，而不是提前显示完成结果", () => {
    expect(dispatchLearningRunDemoIntent(
      { kind: "request_hint", level: 1 },
      { scenarioId: "card-text", frameIndex: 1 },
    )).toEqual({ scenarioId: "card-text", frameIndex: 2 });
  });
});
