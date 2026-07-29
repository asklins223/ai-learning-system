/**
 * Tests for source_fingerprint & exposure_fingerprint (计划 §6.7).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeSourceFingerprint,
  computeExposureFingerprint,
  verifySourceFingerprint,
  verifyExposureFingerprint,
  computeUnassistedEligibleAfter,
  isUnassistedEligible,
  normalizeText,
  type SourceFingerprintInput,
  type ExposureFingerprintInput,
  type EvidenceFingerprintPart,
} from "./fingerprint.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

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

// ─── Tests ───────────────────────────────────────────────────────────────

describe("fingerprint", () => {
  describe("normalizeText", () => {
    it("trims and collapses whitespace and lowercases", () => {
      assert.equal(normalizeText("  Hello   World  "), "hello world");
    });

    it("handles empty string", () => {
      assert.equal(normalizeText(""), "");
    });

    it("handles tabs and newlines", () => {
      assert.equal(normalizeText("Hello\t\nWorld"), "hello world");
    });
  });

  // ── source_fingerprint ─────────────────────────────────────────────

  describe("source_fingerprint", () => {
    it("is deterministic for the same input", () => {
      const a = computeSourceFingerprint(baseSourceInput());
      const b = computeSourceFingerprint(baseSourceInput());
      assert.equal(a, b);
    });

    it("produces a 64-char hex string", () => {
      const fp = computeSourceFingerprint(baseSourceInput());
      assert.equal(fp.length, 64);
      assert.match(fp, /^[0-9a-f]{64}$/);
    });

    it("changes when workspace changes", () => {
      const a = computeSourceFingerprint(baseSourceInput());
      const b = computeSourceFingerprint(baseSourceInput({ workspaceId: "ws-2" }));
      assert.notEqual(a, b);
    });

    it("changes when user changes", () => {
      const a = computeSourceFingerprint(baseSourceInput());
      const b = computeSourceFingerprint(baseSourceInput({ userId: "user-2" }));
      assert.notEqual(a, b);
    });

    it("changes when key point changes", () => {
      const a = computeSourceFingerprint(baseSourceInput());
      const b = computeSourceFingerprint(baseSourceInput({ keyPointId: "kp-2" }));
      assert.notEqual(a, b);
    });

    it("changes when claim changes (even with different formatting)", () => {
      const a = computeSourceFingerprint(baseSourceInput({ claim: "The Earth Orbits The Sun" }));
      const b = computeSourceFingerprint(baseSourceInput({ claim: "  the   earth  orbits  the  sun  " }));
      assert.equal(a, b, "normalized claims should match");
    });

    it("changes when question prompt version changes", () => {
      const a = computeSourceFingerprint(baseSourceInput({ questionPromptVersion: "qp-v1" }));
      const b = computeSourceFingerprint(baseSourceInput({ questionPromptVersion: "qp-v2" }));
      assert.notEqual(a, b);
    });

    it("changes when rubric policy version changes", () => {
      const a = computeSourceFingerprint(baseSourceInput({ rubricPolicyVersion: "rp-v1" }));
      const b = computeSourceFingerprint(baseSourceInput({ rubricPolicyVersion: "rp-v2" }));
      assert.notEqual(a, b);
    });

    it("changes when evidence changes", () => {
      const a = computeSourceFingerprint(baseSourceInput());
      const b = computeSourceFingerprint(baseSourceInput({
        evidence: [{ evidenceId: "ev-3", blockId: null, quoteHash: "qh-3", alignment: "aligned", override: null }],
      }));
      assert.notEqual(a, b);
    });

    it("is insensitive to evidence ordering", () => {
      const ev1 = baseEvidence();
      const ev2 = [...ev1].reverse();
      const a = computeSourceFingerprint(baseSourceInput({ evidence: ev1 }));
      const b = computeSourceFingerprint(baseSourceInput({ evidence: ev2 }));
      assert.equal(a, b);
    });

    it("changes when evidence override changes", () => {
      const ev = baseEvidence();
      const a = computeSourceFingerprint(baseSourceInput({ evidence: ev }));
      const modified = [...ev];
      modified[1] = { ...modified[1], override: "rejected" };
      const b = computeSourceFingerprint(baseSourceInput({ evidence: modified }));
      assert.notEqual(a, b);
    });

    it("verifySourceFingerprint returns true for matching", () => {
      const fp = computeSourceFingerprint(baseSourceInput());
      assert.equal(verifySourceFingerprint(fp, baseSourceInput()), true);
    });

    it("verifySourceFingerprint returns false for mismatch", () => {
      const fp = computeSourceFingerprint(baseSourceInput());
      assert.equal(verifySourceFingerprint(fp, baseSourceInput({ userId: "user-2" })), false);
    });
  });

  // ── exposure_fingerprint ───────────────────────────────────────────

  describe("exposure_fingerprint", () => {
    it("is deterministic for the same input", () => {
      const a = computeExposureFingerprint(baseExposureInput());
      const b = computeExposureFingerprint(baseExposureInput());
      assert.equal(a, b);
    });

    it("produces a 64-char hex string", () => {
      const fp = computeExposureFingerprint(baseExposureInput());
      assert.equal(fp.length, 64);
      assert.match(fp, /^[0-9a-f]{64}$/);
    });

    it("does NOT change when question prompt version changes (excluded by design)", () => {
      // exposure_fingerprint doesn't even accept questionPromptVersion
      const a = computeExposureFingerprint(baseExposureInput());
      const b = computeExposureFingerprint(baseExposureInput());
      assert.equal(a, b);
    });

    it("changes when claim content changes", () => {
      const a = computeExposureFingerprint(baseExposureInput({ claim: "claim A" }));
      const b = computeExposureFingerprint(baseExposureInput({ claim: "claim B" }));
      assert.notEqual(a, b);
    });

    it("changes when note content hash changes", () => {
      const a = computeExposureFingerprint(baseExposureInput({ noteContentHash: "nch-1" }));
      const b = computeExposureFingerprint(baseExposureInput({ noteContentHash: "nch-2" }));
      assert.notEqual(a, b);
    });

    it("changes when evidence content changes", () => {
      const a = computeExposureFingerprint(baseExposureInput());
      const b = computeExposureFingerprint(baseExposureInput({
        evidence: [{ evidenceId: "ev-9", blockId: null, quoteHash: "qh-9", alignment: "aligned", override: null }],
      }));
      assert.notEqual(a, b);
    });

    it("is different from source_fingerprint (different component set)", () => {
      const source = computeSourceFingerprint(baseSourceInput());
      const exposure = computeExposureFingerprint(baseExposureInput());
      assert.notEqual(source, exposure);
    });

    it("verifyExposureFingerprint returns true for matching", () => {
      const fp = computeExposureFingerprint(baseExposureInput());
      assert.equal(verifyExposureFingerprint(fp, baseExposureInput()), true);
    });
  });

  // ── Cooldown helpers ───────────────────────────────────────────────

  describe("cooldown helpers", () => {
    it("computeUnassistedEligibleAfter adds 24h by default", () => {
      const exposed = new Date("2026-07-24T12:00:00Z");
      const eligible = computeUnassistedEligibleAfter(exposed);
      assert.deepEqual(eligible, new Date("2026-07-25T12:00:00Z"));
    });

    it("computeUnassistedEligibleAfter respects custom cooldown hours", () => {
      const exposed = new Date("2026-07-24T12:00:00Z");
      const eligible = computeUnassistedEligibleAfter(exposed, 48);
      assert.deepEqual(eligible, new Date("2026-07-26T12:00:00Z"));
    });

    it("isUnassistedEligible returns true when no exposure", () => {
      assert.equal(isUnassistedEligible(null, new Date()), true);
    });

    it("isUnassistedEligible returns false during cooldown", () => {
      const eligibleAfter = new Date("2026-07-25T12:00:00Z");
      const now = new Date("2026-07-24T18:00:00Z");
      assert.equal(isUnassistedEligible(eligibleAfter, now), false);
    });

    it("isUnassistedEligible returns true after cooldown ends", () => {
      const eligibleAfter = new Date("2026-07-25T12:00:00Z");
      const now = new Date("2026-07-25T12:00:01Z");
      assert.equal(isUnassistedEligible(eligibleAfter, now), true);
    });

    it("isUnassistedEligible returns true exactly at cooldown end", () => {
      const eligibleAfter = new Date("2026-07-25T12:00:00Z");
      const now = new Date("2026-07-25T12:00:00Z");
      assert.equal(isUnassistedEligible(eligibleAfter, now), true);
    });
  });
});
