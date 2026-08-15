import assert from "node:assert/strict";
import test from "node:test";
import type { CharacterPresentationStateV1 } from "@ailearn/shared";
import {
  LIVE2D_INVITE_ONCE_CUE,
  LIVE2D_MOTION_FOR_PRESENTATION,
  motionForLive2DPresentation,
} from "./live2d-motion-map";

test("hidden maps to null (live surface hidden)", () => {
  assert.equal(motionForLive2DPresentation("hidden"), null);
});

test("idle/listen/speak use the looping Idle group", () => {
  assert.deepEqual(motionForLive2DPresentation("idle"), { group: "Idle", index: 0 });
  assert.deepEqual(motionForLive2DPresentation("listen"), { group: "Idle", index: 0 });
  assert.deepEqual(motionForLive2DPresentation("speak"), { group: "Idle", index: 0 });
});

test("invite uses the single-shot invite cue", () => {
  assert.deepEqual(motionForLive2DPresentation("invite"), { group: "", index: 0 });
  assert.deepEqual(LIVE2D_INVITE_ONCE_CUE, { group: "", index: 0 });
});

test("all eleven presentations have a defined mapping", () => {
  const states: CharacterPresentationStateV1[] = [
    "hidden", "idle", "invite", "listen", "think", "analyze",
    "speak", "navigate", "encourage", "celebrate", "uncertain",
  ];
  for (const state of states) {
    assert.ok(state in LIVE2D_MOTION_FOR_PRESENTATION, `missing mapping: ${state}`);
  }
  // Distinct non-idle cues are preserved (state → different motion).
  const think = motionForLive2DPresentation("think");
  const navigate = motionForLive2DPresentation("navigate");
  const celebrate = motionForLive2DPresentation("celebrate");
  assert.notDeepEqual(think, navigate);
  assert.notDeepEqual(navigate, celebrate);
});
