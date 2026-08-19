/**
 * Unit tests for unified scheduling dispatcher (计划 §10.6, §12.2)
 *
 * discrete-v2 is now always active. The v1 fallback path has been retired.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateSchedule,
  type UnifiedScheduleInput,
} from "./scheduling-unified.ts";
import { DISCRETE_V2_POLICY_VERSION } from "./scheduling-policy-v2.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-25T12:00:00Z");
const MS_PER_HOUR = 60 * 60 * 1000;

function makeInput(overrides: Partial<UnifiedScheduleInput> = {}): UnifiedScheduleInput {
  return {
    currentIntervalDays: 1,
    outcome: "correct",
    hasValidServerQuestion: true,
    hasHardEvidence: true,
    now: NOW,
    unassistedEligibleAfter: null,
    ...overrides,
  };
}

// ─── discrete-v2 tests ───────────────────────────────────────────────────

test("correct advances interval", () => {
  const result = calculateSchedule(makeInput({ currentIntervalDays: 1, outcome: "correct" }));
  assert.equal(result.policyVersion, DISCRETE_V2_POLICY_VERSION);
  assert.equal(result.shouldMutateSchedule, true);
  assert.equal(result.afterIntervalDays, 3); // 1 → 3
  assert.equal(result.understandingEffect, "upgrade");
});

test("partial does NOT advance (key v0.6 fix)", () => {
  const result = calculateSchedule(makeInput({ currentIntervalDays: 3, outcome: "partial" }));
  assert.equal(result.policyVersion, DISCRETE_V2_POLICY_VERSION);
  assert.equal(result.shouldMutateSchedule, true);
  assert.equal(result.afterIntervalDays, 3); // stays at 3 (partial_hold)
  assert.equal(result.reasonCode, "partial_hold");
  assert.equal(result.understandingEffect, "unchanged");
});

test("source_viewed does NOT advance", () => {
  const result = calculateSchedule(makeInput({ currentIntervalDays: 7, outcome: "source_viewed" }));
  assert.equal(result.shouldMutateSchedule, true);
  assert.equal(result.afterIntervalDays, 7); // stays at 7
  assert.equal(result.understandingEffect, "unchanged");
});

test("stale does not mutate schedule", () => {
  const result = calculateSchedule(makeInput({ currentIntervalDays: 7, outcome: "stale" }));
  assert.equal(result.shouldMutateSchedule, false);
});

test("provider_failure does not mutate schedule", () => {
  const result = calculateSchedule(makeInput({ currentIntervalDays: 7, outcome: "provider_failure" }));
  assert.equal(result.shouldMutateSchedule, false);
});

test("incorrect resets to 1 day", () => {
  const result = calculateSchedule(makeInput({ currentIntervalDays: 30, outcome: "incorrect" }));
  assert.equal(result.afterIntervalDays, 1);
  assert.equal(result.understandingEffect, "downgrade");
  assert.equal(result.reasonCode, "incorrect_reset");
});

test("unable resets to 1 day", () => {
  const result = calculateSchedule(makeInput({ currentIntervalDays: 30, outcome: "unable" }));
  assert.equal(result.afterIntervalDays, 1);
  assert.equal(result.understandingEffect, "downgrade");
});

test("later delays 12 hours, keeps interval", () => {
  const result = calculateSchedule(makeInput({ currentIntervalDays: 7, outcome: "later" }));
  assert.equal(result.afterIntervalDays, 7); // unchanged
  assert.equal(result.shouldMutateSchedule, true);
  const expected = new Date(NOW.getTime() + 12 * MS_PER_HOUR);
  assert.equal(result.nextReviewAt.getTime(), expected.getTime());
});

test("interval caps at 60", () => {
  const result = calculateSchedule(makeInput({ currentIntervalDays: 60, outcome: "correct" }));
  assert.equal(result.afterIntervalDays, 60); // capped
  assert.equal(result.reasonCode, "correct_interval_cap");
});

// ─── Guard checks ────────────────────────────────────────────────────────

test("correct without valid question → no upgrade", () => {
  const result = calculateSchedule(makeInput({
    currentIntervalDays: 1,
    outcome: "correct",
    hasValidServerQuestion: false,
  }));
  assert.equal(result.understandingEffect, "unchanged");
  assert.equal(result.shouldMutateSchedule, true);
});

test("correct without hard evidence → no upgrade", () => {
  const result = calculateSchedule(makeInput({
    currentIntervalDays: 1,
    outcome: "correct",
    hasHardEvidence: false,
  }));
  assert.equal(result.understandingEffect, "unchanged");
});
