import assert from "node:assert/strict";
import { test } from "node:test";
import {
  effectiveEvidenceAlignment,
  isEffectiveHardEvidence,
} from "./effective-evidence.ts";

test("effective evidence: only effective aligned evidence is hard", () => {
  assert.equal(isEffectiveHardEvidence("aligned", null), true);
  assert.equal(isEffectiveHardEvidence("soft", null), false);
  assert.equal(isEffectiveHardEvidence("unaligned", null), false);
  assert.equal(isEffectiveHardEvidence("stale_alignment", null), false);
  assert.equal(isEffectiveHardEvidence("unknown", null), false);
});

test("effective evidence: override semantics are fail closed", () => {
  assert.equal(effectiveEvidenceAlignment("soft", null, "confirmed"), "aligned");
  assert.equal(effectiveEvidenceAlignment("aligned", null, "downgraded"), "soft");
  assert.equal(effectiveEvidenceAlignment("aligned", null, "rejected"), null);
});

test("effective evidence: user override takes precedence over legacy override", () => {
  assert.equal(effectiveEvidenceAlignment("aligned", "rejected", "confirmed"), "aligned");
  assert.equal(effectiveEvidenceAlignment("aligned", "confirmed", "rejected"), null);
});
