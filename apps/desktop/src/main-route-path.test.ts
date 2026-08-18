import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentMainRoute } from "./main-route-path.ts";

const CARD_ID = "11111111-1111-4111-8111-111111111111";
const KEY_POINT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

describe("Pet to Main route handoff", () => {
  it("uses the graph target parameter consumed by the page", () => {
    assert.equal(
      currentMainRoute({ kind: "star_map", keyPointId: KEY_POINT_ID }),
      `/graph?targetNodeId=${KEY_POINT_ID}`,
    );
  });

  it("routes the legacy learning-session to the V2 learning card page", () => {
    assert.equal(
      currentMainRoute({
        kind: "learning_session",
        cardId: CARD_ID,
        keyPointId: KEY_POINT_ID,
        sessionId: SESSION_ID,
        origin: "review",
      }),
      `/learning-cards/${CARD_ID}`,
    );
  });
});
