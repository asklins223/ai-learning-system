import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANION_REFERENCE_ASSET_BY_STATE,
  COMPANION_REFERENCE_ASSET_MANIFEST,
  COMPANION_REFERENCE_ASSET_STATUS,
  companionReferenceAssetForState,
} from "./companion-reference-assets";
import { COMPANION_VISUAL_STATES } from "./companion-visual-state";

test("owner reference asset mapping is fail-closed for hidden state", () => {
  for (const state of COMPANION_VISUAL_STATES) {
    if (state === "exit_or_hidden") {
      assert.equal(companionReferenceAssetForState(state), null);
      continue;
    }
    assert.match(COMPANION_REFERENCE_ASSET_BY_STATE[state], /^\/images\/companion\/reference\/.+\.png$/);
  }
});

test("owner reference manifest records the supplied source and transparent canvas", () => {
  assert.equal(COMPANION_REFERENCE_ASSET_MANIFEST.canvas.alpha, true);
  assert.equal(COMPANION_REFERENCE_ASSET_MANIFEST.sourcePath, "/docs/image/learning-companion-character-action-reference.png");
  assert.match(COMPANION_REFERENCE_ASSET_MANIFEST.sourceSha256, /^[a-f0-9]{64}$/);
});

test("asset status makes reused and suppressed states explicit", () => {
  assert.equal(COMPANION_REFERENCE_ASSET_STATUS.explain, "reused");
  assert.equal(COMPANION_REFERENCE_ASSET_STATUS.assessment_handoff, "reused");
  assert.equal(COMPANION_REFERENCE_ASSET_STATUS.exit_or_hidden, "suppressed");
  assert.deepEqual(
    COMPANION_REFERENCE_ASSET_MANIFEST.stateStatus,
    COMPANION_REFERENCE_ASSET_STATUS,
  );
});
