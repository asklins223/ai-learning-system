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

  it("uses the learning-session parameters consumed by the page", () => {
    assert.equal(
      currentMainRoute({
        kind: "learning_session",
        cardId: CARD_ID,
        keyPointId: KEY_POINT_ID,
        sessionId: SESSION_ID,
        origin: "review",
      }),
      `/cards/${CARD_ID}/companion?keyPoint=${KEY_POINT_ID}&session=${SESSION_ID}&origin=review`,
    );
  });
});
