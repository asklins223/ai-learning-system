import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateReviewSchedule,
  normalizeReviewIntervalDays,
  REVIEW_INTERVAL_TIERS,
  REVIEW_LATER_DELAY_HOURS,
  ReviewSchedulingPolicyError,
  type ReviewOutcome,
  type ReviewSchedulingInput,
  type ReviewSchedulingPolicyErrorCode,
} from "../modules/review/scheduling-policy.ts";

const NOW = new Date("2026-07-18T08:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function input(overrides: Partial<ReviewSchedulingInput> = {}): ReviewSchedulingInput {
  return {
    currentIntervalDays: 1,
    outcome: "correct",
    hasValidServerQuestion: true,
    hasHardEvidence: true,
    now: NOW,
    ...overrides,
  };
}

function assertPolicyError(run: () => unknown, code: ReviewSchedulingPolicyErrorCode): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ReviewSchedulingPolicyError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

describe("review scheduling policy", () => {
  it("publishes the ADR-0004 interval tiers", () => {
    assert.deepEqual(REVIEW_INTERVAL_TIERS, [1, 3, 7, 14, 30, 60]);
    assert.equal(Object.isFrozen(REVIEW_INTERVAL_TIERS), true);
  });

  it("advances correct outcomes exactly one tier with an explainable result", () => {
    const expected = [3, 7, 14, 30, 60] as const;

    for (const [index, currentIntervalDays] of REVIEW_INTERVAL_TIERS.slice(0, -1).entries()) {
      const result = calculateReviewSchedule(input({ currentIntervalDays, outcome: "correct" }));

      assert.deepEqual(result, {
        storedIntervalDays: currentIntervalDays,
        beforeIntervalDays: currentIntervalDays,
        afterIntervalDays: expected[index],
        nextReviewAt: new Date(NOW.getTime() + expected[index] * DAY_MS),
        reasonCode: "correct_advance",
        understandingEffect: "upgrade",
      });
    }
  });

  it("caps correct outcomes at 60 days without hiding the cap", () => {
    assert.deepEqual(calculateReviewSchedule(input({ currentIntervalDays: 60, outcome: "correct" })), {
      storedIntervalDays: 60,
      beforeIntervalDays: 60,
      afterIntervalDays: 60,
      nextReviewAt: new Date(NOW.getTime() + 60 * DAY_MS),
      reasonCode: "correct_interval_cap",
      understandingEffect: "upgrade",
    });
  });

  it("advances partial outcomes by at most one tier", () => {
    const expected = [3, 7, 14, 30, 60, 60] as const;

    for (const [index, currentIntervalDays] of REVIEW_INTERVAL_TIERS.entries()) {
      const result = calculateReviewSchedule(input({ currentIntervalDays, outcome: "partial" }));

      assert.equal(result.beforeIntervalDays, currentIntervalDays);
      assert.equal(result.afterIntervalDays, expected[index]);
      assert.equal(result.nextReviewAt.getTime(), NOW.getTime() + expected[index] * DAY_MS);
      assert.equal(result.reasonCode, currentIntervalDays === 60 ? "partial_interval_cap" : "partial_advance");
      assert.equal(result.understandingEffect, "upgrade");
    }
  });

  for (const outcome of ["incorrect", "unable"] as const) {
    it(`resets every ${outcome} outcome to one day`, () => {
      for (const currentIntervalDays of REVIEW_INTERVAL_TIERS) {
        assert.deepEqual(calculateReviewSchedule(input({ currentIntervalDays, outcome })), {
          storedIntervalDays: currentIntervalDays,
          beforeIntervalDays: currentIntervalDays,
          afterIntervalDays: 1,
          nextReviewAt: new Date(NOW.getTime() + DAY_MS),
          reasonCode: `${outcome}_reset`,
          understandingEffect: "downgrade",
        });
      }
    });
  }

  it("keeps the tier for later and uses an explicit short deferral", () => {
    assert.ok(REVIEW_LATER_DELAY_HOURS < 24);

    for (const currentIntervalDays of REVIEW_INTERVAL_TIERS) {
      assert.deepEqual(calculateReviewSchedule(input({ currentIntervalDays, outcome: "later" })), {
        storedIntervalDays: currentIntervalDays,
        beforeIntervalDays: currentIntervalDays,
        afterIntervalDays: currentIntervalDays,
        nextReviewAt: new Date(NOW.getTime() + REVIEW_LATER_DELAY_HOURS * 60 * 60 * 1_000),
        reasonCode: "later_short_deferral",
        understandingEffect: "unchanged",
      });
    }
  });

  it("blocks correct and partial upgrades when hard evidence is absent", () => {
    for (const outcome of ["correct", "partial"] as const) {
      for (const currentIntervalDays of REVIEW_INTERVAL_TIERS) {
        assert.deepEqual(
          calculateReviewSchedule(input({ currentIntervalDays, outcome, hasHardEvidence: false })),
          {
            storedIntervalDays: currentIntervalDays,
            beforeIntervalDays: currentIntervalDays,
            afterIntervalDays: currentIntervalDays,
            nextReviewAt: new Date(NOW.getTime() + currentIntervalDays * DAY_MS),
            reasonCode: "evidence_insufficient",
            understandingEffect: "unchanged",
          },
        );
      }
    }
  });

  it("blocks upgrades when the current server-side question is missing or stale", () => {
    for (const outcome of ["correct", "partial"] as const) {
      const result = calculateReviewSchedule(input({
        currentIntervalDays: 7,
        outcome,
        hasValidServerQuestion: false,
      }));
      assert.deepEqual(result, {
        storedIntervalDays: 7,
        beforeIntervalDays: 7,
        afterIntervalDays: 7,
        nextReviewAt: new Date(NOW.getTime() + 7 * DAY_MS),
        reasonCode: "question_invalid",
        understandingEffect: "unchanged",
      });
    }
  });

  it("normalizes representative v0.4 intervals without shortening them", () => {
    const legacyMappings = new Map([
      [0, 1],
      [2, 3],
      [4, 7],
      [6, 7],
      [8, 14],
      [12, 14],
      [16, 30],
      [24, 30],
    ] as const);

    for (const [storedIntervalDays, canonicalIntervalDays] of legacyMappings) {
      assert.equal(normalizeReviewIntervalDays(storedIntervalDays), canonicalIntervalDays);
      const result = calculateReviewSchedule(input({
        currentIntervalDays: storedIntervalDays,
        outcome: "later",
      }));
      assert.equal(result.storedIntervalDays, storedIntervalDays);
      assert.equal(result.beforeIntervalDays, canonicalIntervalDays);
      assert.equal(result.afterIntervalDays, canonicalIntervalDays);
    }
  });

  it("does not let the evidence gate replace non-upgrading outcome rules", () => {
    assert.equal(
      calculateReviewSchedule(input({ currentIntervalDays: 30, outcome: "incorrect", hasHardEvidence: false }))
        .reasonCode,
      "incorrect_reset",
    );
    assert.equal(
      calculateReviewSchedule(input({ currentIntervalDays: 30, outcome: "unable", hasHardEvidence: false }))
        .reasonCode,
      "unable_reset",
    );
    assert.equal(
      calculateReviewSchedule(input({ currentIntervalDays: 30, outcome: "later", hasHardEvidence: false }))
        .reasonCode,
      "later_short_deferral",
    );
  });

  it("fails closed for values outside the discrete interval tiers", () => {
    for (const currentIntervalDays of [-1, 1.5, 61, Number.NaN, Number.POSITIVE_INFINITY]) {
      assertPolicyError(() => calculateReviewSchedule(input({ currentIntervalDays })), "invalid_interval");
    }
  });

  it("fails closed for an invalid input object or server-question signal", () => {
    assertPolicyError(
      () => calculateReviewSchedule(null as unknown as ReviewSchedulingInput),
      "invalid_input",
    );
    assertPolicyError(
      () => calculateReviewSchedule(input({ hasValidServerQuestion: "yes" as unknown as boolean })),
      "invalid_question",
    );
  });

  it("fails closed for unknown outcomes", () => {
    for (const outcome of ["", "reviewed", "CORRECT", null, 1]) {
      assertPolicyError(
        () => calculateReviewSchedule(input({ outcome: outcome as ReviewOutcome })),
        "invalid_outcome",
      );
    }
  });

  it("fails closed for invalid or overflowing times", () => {
    for (const now of [new Date(Number.NaN), "2026-07-18" as unknown as Date, null as unknown as Date]) {
      assertPolicyError(() => calculateReviewSchedule(input({ now })), "invalid_time");
    }

    assertPolicyError(
      () => calculateReviewSchedule(input({ currentIntervalDays: 60, now: new Date(8.64e15) })),
      "invalid_time",
    );
  });

  it("fails closed for a non-boolean evidence signal", () => {
    assertPolicyError(
      () => calculateReviewSchedule(input({ hasHardEvidence: "yes" as unknown as boolean })),
      "invalid_evidence",
    );
  });

  it("is deterministic and does not mutate the supplied time", () => {
    const now = new Date(NOW);
    const timestampBefore = now.getTime();
    const first = calculateReviewSchedule(input({ now, currentIntervalDays: 7, outcome: "partial" }));
    const second = calculateReviewSchedule(input({ now, currentIntervalDays: 7, outcome: "partial" }));

    assert.deepEqual(first, second);
    assert.notEqual(first.nextReviewAt, second.nextReviewAt);
    assert.equal(now.getTime(), timestampBefore);
  });
});
