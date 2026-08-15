/**
 * 方案 20 C35 — publishedTargetEligibility legacy_unreviewed 分支单测（R35）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePublishedTargetEligibility } from "../modules/card-generation-v2/target-snapshot-adapter.ts";

describe("computePublishedTargetEligibility（C35 legacy_unreviewed）", () => {
  it("eligible when active + usable + no reveal + not legacy-unreviewed", () => {
    assert.equal(computePublishedTargetEligibility({
      lifecycleActive: true,
      evidenceUsable: true,
      sameCueRecentlyRevealed: false,
      legacyUnreviewed: false,
    }), "eligible");
  });

  it("practice_only when legacy-unreviewed (no fabricated V2 eligibility)", () => {
    assert.equal(computePublishedTargetEligibility({
      lifecycleActive: true,
      evidenceUsable: true,
      sameCueRecentlyRevealed: false,
      legacyUnreviewed: true,
    }), "practice_only");
  });

  it("practice_only when same cue recently revealed", () => {
    assert.equal(computePublishedTargetEligibility({
      lifecycleActive: true,
      evidenceUsable: true,
      sameCueRecentlyRevealed: true,
      legacyUnreviewed: false,
    }), "practice_only");
  });

  it("blocked takes precedence over legacy-unreviewed", () => {
    assert.equal(computePublishedTargetEligibility({
      lifecycleActive: false,
      evidenceUsable: true,
      sameCueRecentlyRevealed: false,
      legacyUnreviewed: true,
    }), "blocked");
    assert.equal(computePublishedTargetEligibility({
      lifecycleActive: true,
      evidenceUsable: false,
      sameCueRecentlyRevealed: false,
      legacyUnreviewed: true,
    }), "blocked");
  });
});
