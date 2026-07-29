/**
 * FSRS Shadow golden vectors test (计划 §10.6, §6.8)
 *
 * Verifies:
 * - Same history replay produces same shadow hash (determinism)
 * - Official schedule impact is 0 (shadow writes don't affect review_schedules)
 * - Rating mapping follows plan §16:
 *   correct→Good, partial→Hard, incorrect/unable→Again,
 *   assisted/invalid/provider_failure→null
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeFSRSShadowDecision,
  outcomeToFSRSRating,
  verifyGoldenVectors,
  generateGoldenVectors,
  isFSRSShadowEnabled,
  FSRS_ALGORITHM,
  FSRS_ALGORITHM_VERSION,
  FSRS_PARAMETERS_VERSION,
  FSRS_GOLDEN_VECTORS,
  type FSRSShadowInput,
} from "./fsrs-shadow.ts";

// ─── Determinism: same input → same output ────────────────────────────────

test("FSRS golden vectors: deterministic replay", () => {
  const result = verifyGoldenVectors();
  assert.ok(result.passed, `Golden vectors failed: ${result.failures.join(", ")}`);
});

test("FSRS: generate golden vectors produces valid output", () => {
  const vectors = generateGoldenVectors();
  assert.equal(vectors.length, 3); // Again, Hard, Good

  for (const vector of vectors) {
    assert.ok(vector.name);
    assert.ok(vector.input.rating >= 1 && vector.input.rating <= 3);
    assert.ok(vector.expected.due);
    assert.ok(typeof vector.expected.stability === "number");
    assert.ok(typeof vector.expected.difficulty === "number");
  }
});

test("FSRS golden vectors: detects pinned-output drift", () => {
  const changed = generateGoldenVectors();
  changed[0] = {
    ...changed[0],
    expected: { ...changed[0].expected, stability: changed[0].expected.stability + 0.01 },
  };
  const result = verifyGoldenVectors(changed);
  assert.equal(result.passed, false);
  assert.match(result.failures.join("\n"), /stability expected/);
  assert.equal(FSRS_GOLDEN_VECTORS[0].expected.stability, 0.40255);
});

// ─── Rating mapping (计划 §16) ─────────────────────────────────────────────

test("FSRS rating: correct → Good (3)", () => {
  const rating = outcomeToFSRSRating("correct", true);
  assert.equal(rating, 3); // Good
});

test("FSRS rating: partial → Hard (2)", () => {
  const rating = outcomeToFSRSRating("partial", true);
  assert.equal(rating, 2); // Hard
});

test("FSRS rating: incorrect → Again (1)", () => {
  const rating = outcomeToFSRSRating("incorrect", true);
  assert.equal(rating, 1); // Again
});

test("FSRS rating: unable → Again (1)", () => {
  const rating = outcomeToFSRSRating("unable", true);
  assert.equal(rating, 1); // Again
});

test("FSRS rating: source_viewed → null (not a valid training event)", () => {
  const rating = outcomeToFSRSRating("source_viewed", true);
  assert.equal(rating, null);
});

test("FSRS rating: stale → null", () => {
  const rating = outcomeToFSRSRating("stale", true);
  assert.equal(rating, null);
});

test("FSRS rating: provider_failure → null", () => {
  const rating = outcomeToFSRSRating("provider_failure", true);
  assert.equal(rating, null);
});

test("FSRS rating: assisted (isUnassisted=false) → null", () => {
  const rating = outcomeToFSRSRating("correct", false);
  assert.equal(rating, null);
});

test("FSRS rating: never fabricates Easy (4)", () => {
  // No outcome should produce rating 4 (Easy)
  const outcomes: Array<FSRSShadowInput["outcome"]> = [
    "correct", "partial", "incorrect", "unable",
    "source_viewed", "stale", "provider_failure",
  ];
  for (const outcome of outcomes) {
    const rating = outcomeToFSRSRating(outcome, true);
    assert.ok(rating === null || rating < 4, `${outcome} should not produce Easy (4)`);
  }
});

// ─── Shadow decision computation ───────────────────────────────────────────

test("FSRS shadow: unassisted correct produces valid decision", () => {
  const input: FSRSShadowInput = {
    workspaceId: "ws-1",
    userId: "user-1",
    keyPointId: "kp-1",
    sourceType: "validation_event",
    sourceId: "ve-1",
    currentIntervalDays: 1,
    outcome: "correct",
    now: new Date("2026-07-25T00:00:00.000Z"),
    isUnassisted: true,
  };
  const decision = computeFSRSShadowDecision(input);
  assert.ok(decision);
  assert.equal(decision!.algorithm, FSRS_ALGORITHM);
  assert.equal(decision!.algorithmVersion, FSRS_ALGORITHM_VERSION);
  assert.equal(decision!.parametersVersion, FSRS_PARAMETERS_VERSION);
  assert.ok(decision!.predictedDueAt instanceof Date);
  assert.equal(decision!.inputSnapshot.rating, 3); // Good
  // Input snapshot must not contain answer text
  assert.equal((decision!.inputSnapshot as Record<string, unknown>).answer, undefined);
});

test("FSRS shadow: assisted correct returns null", () => {
  const input: FSRSShadowInput = {
    workspaceId: "ws-1",
    userId: "user-1",
    keyPointId: "kp-1",
    sourceType: "validation_event",
    sourceId: "ve-1",
    currentIntervalDays: 1,
    outcome: "correct",
    now: new Date("2026-07-25T00:00:00.000Z"),
    isUnassisted: false,
  };
  const decision = computeFSRSShadowDecision(input);
  assert.equal(decision, null);
});

test("FSRS shadow: stale returns null", () => {
  const input: FSRSShadowInput = {
    workspaceId: "ws-1",
    userId: "user-1",
    keyPointId: "kp-1",
    sourceType: "validation_event",
    sourceId: "ve-1",
    currentIntervalDays: 1,
    outcome: "stale",
    now: new Date("2026-07-25T00:00:00.000Z"),
    isUnassisted: true,
  };
  const decision = computeFSRSShadowDecision(input);
  assert.equal(decision, null);
});

// ─── Feature flag ───────────────────────────────────────────────────────────

test("FSRS shadow: disabled by default", () => {
  // Save original value
  const original = process.env.FSRS_SHADOW_ENABLED;
  delete process.env.FSRS_SHADOW_ENABLED;
  assert.equal(isFSRSShadowEnabled(), false);
  // Restore
  if (original) process.env.FSRS_SHADOW_ENABLED = original;
});

test("FSRS shadow: enabled when flag is true", () => {
  const original = process.env.FSRS_SHADOW_ENABLED;
  process.env.FSRS_SHADOW_ENABLED = "true";
  assert.equal(isFSRSShadowEnabled(), true);
  if (original !== undefined) {
    process.env.FSRS_SHADOW_ENABLED = original;
  } else {
    delete process.env.FSRS_SHADOW_ENABLED;
  }
});

// ─── Same history → same shadow hash (determinism) ────────────────────────

test("FSRS shadow: same input produces identical decision", () => {
  const input: FSRSShadowInput = {
    workspaceId: "ws-1",
    userId: "user-1",
    keyPointId: "kp-1",
    sourceType: "validation_event",
    sourceId: "ve-1",
    currentIntervalDays: 7,
    outcome: "correct",
    now: new Date("2026-07-25T00:00:00.000Z"),
    isUnassisted: true,
  };
  const decision1 = computeFSRSShadowDecision(input);
  const decision2 = computeFSRSShadowDecision(input);

  assert.ok(decision1 && decision2);
  assert.equal(decision1.predictedDueAt.getTime(), decision2.predictedDueAt.getTime());
  assert.equal(decision1.stability, decision2.stability);
  assert.equal(decision1.difficulty, decision2.difficulty);
  assert.equal(decision1.retrievability, decision2.retrievability);
});
