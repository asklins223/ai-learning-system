import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserRoutePath } from "./desktop-pet-adapter";

const CARD_ID = "11111111-1111-4111-8111-111111111111";
const KEY_POINT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";

describe("desktop pet browser route handoff", () => {
  it("uses the conversationId parameter consumed by the archive route", () => {
    assert.equal(
      browserRoutePath({ kind: "conversation", conversationId: CONVERSATION_ID }),
      `/companion/conversations?conversationId=${CONVERSATION_ID}`,
    );
  });

  it("uses the targetNodeId parameter consumed by the understanding graph", () => {
    assert.equal(
      browserRoutePath({ kind: "star_map", keyPointId: KEY_POINT_ID }),
      `/graph?targetNodeId=${KEY_POINT_ID}`,
    );
  });

  it("preserves the full learning session scope with the page parameter names", () => {
    assert.equal(
      browserRoutePath({
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
