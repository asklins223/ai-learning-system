import { describe, expect, it } from "vitest";
import { learningRunOriginForRoomAction } from "./study-run-origin";

const OBJECTIVE_ID = "123e4567-e89b-12d3-a456-426614174000";
const CARD_ID = "223e4567-e89b-12d3-a456-426614174000";
const SCHEDULE_ID = "323e4567-e89b-12d3-a456-426614174000";

describe("learningRunOriginForRoomAction", () => {
  it("fails closed when a create action has no authoritative card identity", () => {
    expect(learningRunOriginForRoomAction({
      kind: "create_run",
      origin: "card",
      objectiveId: OBJECTIVE_ID,
      cardId: null,
      goal: "首次验证",
    })).toBeNull();
  });

  it("keeps card and objective identities distinct", () => {
    expect(learningRunOriginForRoomAction({
      kind: "create_run",
      origin: "card",
      objectiveId: OBJECTIVE_ID,
      cardId: CARD_ID,
      goal: "首次验证",
    })).toEqual({ kind: "card", cardId: CARD_ID, objectiveId: OBJECTIVE_ID });
  });

  it("rejects an invalid review generation", () => {
    expect(learningRunOriginForRoomAction({
      kind: "create_review_run",
      scheduleId: SCHEDULE_ID,
      objectiveId: OBJECTIVE_ID,
      generation: 0,
    })).toBeNull();
  });
});
