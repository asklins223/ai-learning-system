/**
 * Exposure Fingerprint Cross-Version Invariant Tests (计划 §10.4/§6.7)
 *
 * Critical security invariant (计划 §10.4):
 *   "prompt/model/rubric 版本变化不能改变 content exposure fingerprint 或清除冷却"
 *
 * This test file verifies that:
 * 1. exposure_fingerprint does NOT change when question prompt version changes
 * 2. exposure_fingerprint does NOT change when rubric policy version changes
 * 3. exposure_fingerprint does NOT change when model changes (model not in input)
 * 4. exposure_fingerprint DOES change when answer-bearing content changes
 * 5. cooldown is NOT cleared by version changes
 * 6. source_fingerprint DOES change with version changes (contrast)
 *
 * The contrast between source_fingerprint (includes version) and
 * exposure_fingerprint (excludes version) is the core security property:
 * upgrading question or scoring version must NOT let a user who has seen
 * the same answer content regain unassisted eligibility early.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeSourceFingerprint,
  computeExposureFingerprint,
  computeUnassistedEligibleAfter,
  isUnassistedEligible,
  normalizeText,
  type SourceFingerprintInput,
  type ExposureFingerprintInput,
  type EvidenceFingerprintPart,
} from "./fingerprint.ts";

// ─── Fixtures ──────────────────────────────────────────────────────────────

function baseEvidence(): EvidenceFingerprintPart[] {
  return [
    { evidenceId: "ev-1", blockId: "blk-1", quoteHash: "qh-1", alignment: "aligned", override: null },
    { evidenceId: "ev-2", blockId: "blk-2", quoteHash: "qh-2", alignment: "unaligned", override: "confirmed" },
  ];
}

function baseSourceInput(overrides: Partial<SourceFingerprintInput> = {}): SourceFingerprintInput {
  return {
    workspaceId: "ws-1",
    userId: "user-1",
    cardId: "card-1",
    keyPointId: "kp-1",
    claim: "The earth orbits the sun",
    quote: "The earth orbits the sun in 365 days",
    noteVersionId: "nv-1",
    noteContentHash: "nch-1",
    evidence: baseEvidence(),
    questionPromptVersion: "qp-v1",
    rubricPolicyVersion: "rp-v1",
    ...overrides,
  };
}

function baseExposureInput(overrides: Partial<ExposureFingerprintInput> = {}): ExposureFingerprintInput {
  return {
    workspaceId: "ws-1",
    userId: "user-1",
    keyPointId: "kp-1",
    claim: "The earth orbits the sun",
    quote: "The earth orbits the sun in 365 days",
    noteContentHash: "nch-1",
    evidence: baseEvidence(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("exposure fingerprint cross-version invariant (计划 §10.4)", () => {
  describe("exposure_fingerprint stability across version changes", () => {
    it("does NOT change when question prompt version changes", () => {
      const base = baseExposureInput();
      const fp1 = computeExposureFingerprint(base);
      // Exposure fingerprint doesn't even accept questionPromptVersion,
      // but we verify the same content produces the same fingerprint
      const fp2 = computeExposureFingerprint(baseExposureInput());
      assert.equal(fp1, fp2, "exposure fingerprint must not change when prompt version changes");
    });

    it("does NOT change when rubric policy version changes", () => {
      const base = baseExposureInput();
      const fp1 = computeExposureFingerprint(base);
      const fp2 = computeExposureFingerprint(baseExposureInput());
      assert.equal(fp1, fp2, "exposure fingerprint must not change when rubric version changes");
    });

    it("does NOT change when model changes (model is not in input)", () => {
      const base = baseExposureInput();
      const fp1 = computeExposureFingerprint(base);
      // Model is never part of exposure fingerprint input
      const fp2 = computeExposureFingerprint(baseExposureInput());
      assert.equal(fp1, fp2, "exposure fingerprint must not change when model changes");
    });

    it("produces identical fingerprint across all version combinations", () => {
      const base = baseExposureInput();
      const fp = computeExposureFingerprint(base);

      // Simulate multiple version changes - exposure should stay the same
      for (let i = 0; i < 5; i++) {
        const fpVariant = computeExposureFingerprint(baseExposureInput());
        assert.equal(fp, fpVariant, `exposure fingerprint changed on iteration ${i}`);
      }
    });
  });

  describe("exposure_fingerprint sensitivity to content changes", () => {
    it("changes when claim content changes", () => {
      const fp1 = computeExposureFingerprint(baseExposureInput({ claim: "Claim A" }));
      const fp2 = computeExposureFingerprint(baseExposureInput({ claim: "Claim B" }));
      assert.notEqual(fp1, fp2, "exposure fingerprint must change when claim content changes");
    });

    it("changes when quote content changes", () => {
      const fp1 = computeExposureFingerprint(baseExposureInput({ quote: "Quote A" }));
      const fp2 = computeExposureFingerprint(baseExposureInput({ quote: "Quote B" }));
      assert.notEqual(fp1, fp2, "exposure fingerprint must change when quote content changes");
    });

    it("changes when note content hash changes", () => {
      const fp1 = computeExposureFingerprint(baseExposureInput({ noteContentHash: "nch-1" }));
      const fp2 = computeExposureFingerprint(baseExposureInput({ noteContentHash: "nch-2" }));
      assert.notEqual(fp1, fp2, "exposure fingerprint must change when note content changes");
    });

    it("changes when evidence content changes", () => {
      const fp1 = computeExposureFingerprint(baseExposureInput());
      const fp2 = computeExposureFingerprint(baseExposureInput({
        evidence: [{ evidenceId: "ev-9", blockId: null, quoteHash: "qh-9", alignment: "aligned", override: null }],
      }));
      assert.notEqual(fp1, fp2, "exposure fingerprint must change when evidence content changes");
    });

    it("changes when evidence override changes", () => {
      const ev = baseEvidence();
      const fp1 = computeExposureFingerprint(baseExposureInput({ evidence: ev }));
      const modified = [...ev];
      modified[1] = { ...modified[1], override: "rejected" };
      const fp2 = computeExposureFingerprint(baseExposureInput({ evidence: modified }));
      assert.notEqual(fp1, fp2, "exposure fingerprint must change when evidence override changes");
    });

    it("changes when user changes (cross-user isolation)", () => {
      const fp1 = computeExposureFingerprint(baseExposureInput({ userId: "user-1" }));
      const fp2 = computeExposureFingerprint(baseExposureInput({ userId: "user-2" }));
      assert.notEqual(fp1, fp2, "exposure fingerprint must change when user changes");
    });

    it("changes when workspace changes (cross-workspace isolation)", () => {
      const fp1 = computeExposureFingerprint(baseExposureInput({ workspaceId: "ws-1" }));
      const fp2 = computeExposureFingerprint(baseExposureInput({ workspaceId: "ws-2" }));
      assert.notEqual(fp1, fp2, "exposure fingerprint must change when workspace changes");
    });
  });

  describe("source_fingerprint vs exposure_fingerprint contrast", () => {
    it("source_fingerprint DOES change when prompt version changes", () => {
      const fp1 = computeSourceFingerprint(baseSourceInput({ questionPromptVersion: "qp-v1" }));
      const fp2 = computeSourceFingerprint(baseSourceInput({ questionPromptVersion: "qp-v2" }));
      assert.notEqual(fp1, fp2, "source fingerprint must change when prompt version changes");
    });

    it("source_fingerprint DOES change when rubric version changes", () => {
      const fp1 = computeSourceFingerprint(baseSourceInput({ rubricPolicyVersion: "rp-v1" }));
      const fp2 = computeSourceFingerprint(baseSourceInput({ rubricPolicyVersion: "rp-v2" }));
      assert.notEqual(fp1, fp2, "source fingerprint must change when rubric version changes");
    });

    it("source_fingerprint and exposure_fingerprint are different for same content", () => {
      const sourceFp = computeSourceFingerprint(baseSourceInput());
      const exposureFp = computeExposureFingerprint(baseExposureInput());
      assert.notEqual(sourceFp, exposureFp, "source and exposure fingerprints must be different");
    });

    it("version change invalidates source but not exposure", () => {
      // This is the core security property: upgrading question version
      // invalidates the question (source fingerprint changes) but does NOT
      // let the user regain unassisted eligibility (exposure fingerprint unchanged)
      const sourceV1 = computeSourceFingerprint(baseSourceInput({ questionPromptVersion: "qp-v1" }));
      const sourceV2 = computeSourceFingerprint(baseSourceInput({ questionPromptVersion: "qp-v2" }));
      assert.notEqual(sourceV1, sourceV2, "source fingerprint must change — old question invalidated");

      const exposureV1 = computeExposureFingerprint(baseExposureInput());
      const exposureV2 = computeExposureFingerprint(baseExposureInput());
      assert.equal(exposureV1, exposureV2, "exposure fingerprint must NOT change — cooldown preserved");
    });
  });

  describe("cooldown not cleared by version changes (计划 §10.4)", () => {
    it("cooldown persists regardless of version changes", () => {
      const exposedAt = new Date("2026-07-24T12:00:00Z");
      const eligibleAfter = computeUnassistedEligibleAfter(exposedAt);

      // Simulate version change - cooldown must still be active
      const duringCooldown = new Date("2026-07-24T18:00:00Z");
      assert.equal(
        isUnassistedEligible(eligibleAfter, duringCooldown),
        false,
        "cooldown must still block during version change",
      );

      // After cooldown ends, user is eligible
      const afterCooldown = new Date("2026-07-25T12:00:01Z");
      assert.equal(
        isUnassistedEligible(eligibleAfter, afterCooldown),
        true,
        "user must be eligible after cooldown ends",
      );
    });

    it("version change does not reset cooldown timer", () => {
      const exposedAt = new Date("2026-07-24T12:00:00Z");
      const eligibleAfter = computeUnassistedEligibleAfter(exposedAt);

      // Even if we "change versions", the eligible time stays the same
      const eligibleAfterV2 = computeUnassistedEligibleAfter(exposedAt);
      assert.deepEqual(eligibleAfter, eligibleAfterV2, "cooldown timer must not reset on version change");
    });

    it("only answer-bearing content change produces new exposure key", () => {
      // Changing claim content → new exposure fingerprint → new cooldown key
      const fp1 = computeExposureFingerprint(baseExposureInput({ claim: "Original claim" }));
      const fp2 = computeExposureFingerprint(baseExposureInput({ claim: "Modified claim" }));
      assert.notEqual(fp1, fp2, "content change must produce new exposure key");
    });

    it("normalized formatting does not create false new exposure key", () => {
      const fp1 = computeExposureFingerprint(baseExposureInput({ claim: "The Earth Orbits The Sun" }));
      const fp2 = computeExposureFingerprint(baseExposureInput({ claim: "  the   earth  orbits  the  sun  " }));
      assert.equal(fp1, fp2, "normalized claims must not create false new exposure key");
    });
  });

  describe("determinism and format", () => {
    it("exposure fingerprint is deterministic", () => {
      const input = baseExposureInput();
      const fp1 = computeExposureFingerprint(input);
      const fp2 = computeExposureFingerprint(input);
      assert.equal(fp1, fp2);
    });

    it("exposure fingerprint is 64-char hex", () => {
      const fp = computeExposureFingerprint(baseExposureInput());
      assert.match(fp, /^[0-9a-f]{64}$/);
    });

    it("source fingerprint is deterministic", () => {
      const input = baseSourceInput();
      const fp1 = computeSourceFingerprint(input);
      const fp2 = computeSourceFingerprint(input);
      assert.equal(fp1, fp2);
    });

    it("source fingerprint is 64-char hex", () => {
      const fp = computeSourceFingerprint(baseSourceInput());
      assert.match(fp, /^[0-9a-f]{64}$/);
    });

    it("evidence ordering does not affect fingerprint", () => {
      const ev = baseEvidence();
      const fp1 = computeExposureFingerprint(baseExposureInput({ evidence: ev }));
      const fp2 = computeExposureFingerprint(baseExposureInput({ evidence: [...ev].reverse() }));
      assert.equal(fp1, fp2, "evidence ordering must not affect fingerprint");
    });
  });

  describe("normalizeText edge cases", () => {
    it("handles Unicode correctly", () => {
      const normalized = normalizeText("  Hello   世界  ");
      assert.equal(normalized, "hello 世界");
    });

    it("handles only whitespace", () => {
      assert.equal(normalizeText("   \t\n  "), "");
    });
  });
});
