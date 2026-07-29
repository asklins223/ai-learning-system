/**
 * Table-driven tests for discrete-v2 scheduling policy.
 * Verifies the key fix: partial does NOT advance.
 * Also tests source_viewed, stale, provider_failure, and unassisted cooldown.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateDiscreteV2Schedule,
  effectiveReviewStart,
  DISCRETE_V2_INTERVAL_TIERS,
  DISCRETE_V2_LATER_DELAY_HOURS,
  DISCRETE_V2_POLICY_VERSION,
  DiscreteV2PolicyError,
  type DiscreteV2Input,
} from "./scheduling-policy-v2.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-24T12:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const MS_PER_HOUR = 60 * 60 * 1_000;

function baseInput(overrides: Partial<DiscreteV2Input> = {}): DiscreteV2Input {
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

function daysAfterNow(days: number): Date {
  return new Date(NOW.getTime() + days * MS_PER_DAY);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("discrete-v2 scheduling policy", () => {
  describe("constants", () => {
    it("uses the same tiers as v1", () => {
      assert.deepEqual([...DISCRETE_V2_INTERVAL_TIERS], [1, 3, 7, 14, 30, 60]);
    });

    it("uses 12h for later delay", () => {
      assert.equal(DISCRETE_V2_LATER_DELAY_HOURS, 12);
    });

    it("exports the correct policy version", () => {
      assert.equal(DISCRETE_V2_POLICY_VERSION, "discrete-v2");
    });
  });

  // ── correct: advances to next tier ─────────────────────────────────

  describe("correct outcome", () => {
    const tiers = [...DISCRETE_V2_INTERVAL_TIERS];

    for (let i = 0; i < tiers.length; i++) {
      const before = tiers[i];
      const after = tiers[Math.min(i + 1, tiers.length - 1)];
      const isCap = before === after;

      it(`interval ${before} → ${after} (${isCap ? "cap" : "advance"})`, () => {
        const r = calculateDiscreteV2Schedule(baseInput({
          currentIntervalDays: before,
          outcome: "correct",
        }));
        assert.equal(r.beforeIntervalDays, before);
        assert.equal(r.afterIntervalDays, after);
        assert.equal(r.understandingEffect, "upgrade");
        assert.equal(r.reasonCode, isCap ? "correct_interval_cap" : "correct_advance");
        assert.equal(r.shouldMutateSchedule, true);
        assert.equal(r.policyVersion, "discrete-v2");
      });
    }
  });

  // ── partial: KEY FIX — does NOT advance ────────────────────────────

  describe("partial outcome (KEY FIX: does not advance)", () => {
    for (const interval of DISCRETE_V2_INTERVAL_TIERS) {
      it(`interval ${interval} stays at ${interval} (NOT ${interval === 60 ? 60 : DISCRETE_V2_INTERVAL_TIERS[DISCRETE_V2_INTERVAL_TIERS.indexOf(interval) + 1]})`, () => {
        const r = calculateDiscreteV2Schedule(baseInput({
          currentIntervalDays: interval,
          outcome: "partial",
        }));
        assert.equal(r.beforeIntervalDays, interval);
        assert.equal(r.afterIntervalDays, interval); // stays same!
        assert.equal(r.understandingEffect, "unchanged"); // NOT upgrade
        assert.equal(r.reasonCode, "partial_hold");
        assert.equal(r.shouldMutateSchedule, true);
      });
    }

    it("partial due date = now + interval (no advance)", () => {
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 7,
        outcome: "partial",
      }));
      assert.deepEqual(r.nextReviewAt, daysAfterNow(7));
    });
  });

  // ── incorrect: reset to 1 day ──────────────────────────────────────

  describe("incorrect outcome", () => {
    for (const interval of DISCRETE_V2_INTERVAL_TIERS) {
      it(`interval ${interval} → 1 (reset)`, () => {
        const r = calculateDiscreteV2Schedule(baseInput({
          currentIntervalDays: interval,
          outcome: "incorrect",
        }));
        assert.equal(r.afterIntervalDays, 1);
        assert.equal(r.understandingEffect, "downgrade");
        assert.equal(r.reasonCode, "incorrect_reset");
      });
    }
  });

  // ── unable: reset to 1 day ─────────────────────────────────────────

  describe("unable outcome", () => {
    it("resets to 1 day", () => {
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 30,
        outcome: "unable",
      }));
      assert.equal(r.afterIntervalDays, 1);
      assert.equal(r.understandingEffect, "downgrade");
      assert.equal(r.reasonCode, "unable_reset");
    });
  });

  // ── source_viewed: no advance, cooldown gate ───────────────────────

  describe("source_viewed outcome (v0.6 new)", () => {
    it("does not advance interval", () => {
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 14,
        outcome: "source_viewed",
      }));
      assert.equal(r.afterIntervalDays, 14);
      assert.equal(r.understandingEffect, "unchanged");
      assert.equal(r.reasonCode, "source_viewed_hold");
    });

    it("due = now + 1 day when no exposure", () => {
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 14,
        outcome: "source_viewed",
        unassistedEligibleAfter: null,
      }));
      assert.deepEqual(r.nextReviewAt, daysAfterNow(1));
    });

    it("due = unassistedEligibleAfter when cooldown is later than now+1d", () => {
      const cooldownEnd = daysAfterNow(2);
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 14,
        outcome: "source_viewed",
        unassistedEligibleAfter: cooldownEnd,
      }));
      assert.deepEqual(r.nextReviewAt, cooldownEnd);
    });

    it("due = now + 1 day when cooldown is earlier", () => {
      const cooldownEnd = new Date(NOW.getTime() + 6 * MS_PER_HOUR); // 6h later
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 14,
        outcome: "source_viewed",
        unassistedEligibleAfter: cooldownEnd,
      }));
      assert.deepEqual(r.nextReviewAt, daysAfterNow(1));
    });
  });

  // ── later: delay 12h, no interval change ───────────────────────────

  describe("later outcome", () => {
    it("delays 12 hours and keeps interval", () => {
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 7,
        outcome: "later",
      }));
      assert.equal(r.afterIntervalDays, 7);
      assert.equal(r.understandingEffect, "unchanged");
      assert.equal(r.reasonCode, "later_short_deferral");
      const expected = new Date(NOW.getTime() + 12 * MS_PER_HOUR);
      assert.deepEqual(r.nextReviewAt, expected);
    });

    it("does NOT apply cooldown gate (effectiveReviewStart handles it)", () => {
      const cooldownEnd = daysAfterNow(10);
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 7,
        outcome: "later",
        unassistedEligibleAfter: cooldownEnd,
      }));
      // nextReviewAt should be now + 12h, NOT cooldownEnd
      const expected = new Date(NOW.getTime() + 12 * MS_PER_HOUR);
      assert.deepEqual(r.nextReviewAt, expected);
      // But effectiveReviewStart would gate the actual start
      const effectiveStart = effectiveReviewStart(r.nextReviewAt, cooldownEnd);
      assert.deepEqual(effectiveStart, cooldownEnd);
    });
  });

  // ── stale: no schedule mutation ────────────────────────────────────

  describe("stale outcome (v0.6 new)", () => {
    it("shouldMutateSchedule = false", () => {
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 14,
        outcome: "stale",
      }));
      assert.equal(r.shouldMutateSchedule, false);
      assert.equal(r.understandingEffect, "unchanged");
      assert.equal(r.reasonCode, "stale_no_change");
    });

    it("interval unchanged", () => {
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 30,
        outcome: "stale",
      }));
      assert.equal(r.afterIntervalDays, 30);
      assert.equal(r.beforeIntervalDays, 30);
    });
  });

  // ── provider_failure: no schedule mutation ─────────────────────────

  describe("provider_failure outcome (v0.6 new)", () => {
    it("shouldMutateSchedule = false", () => {
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 7,
        outcome: "provider_failure",
      }));
      assert.equal(r.shouldMutateSchedule, false);
      assert.equal(r.reasonCode, "provider_failure_no_change");
    });
  });

  // ── Guard: question/evidence validity ──────────────────────────────

  describe("question/evidence guards", () => {
    it("correct without valid question → question_invalid", () => {
      const r = calculateDiscreteV2Schedule(baseInput({
        outcome: "correct",
        hasValidServerQuestion: false,
      }));
      assert.equal(r.reasonCode, "question_invalid");
      assert.equal(r.understandingEffect, "unchanged");
      assert.equal(r.afterIntervalDays, r.beforeIntervalDays);
    });

    it("partial without hard evidence → evidence_insufficient", () => {
      const r = calculateDiscreteV2Schedule(baseInput({
        outcome: "partial",
        hasHardEvidence: false,
      }));
      assert.equal(r.reasonCode, "evidence_insufficient");
      assert.equal(r.understandingEffect, "unchanged");
    });

    it("incorrect without question still resets (guards only apply to upgrade-eligible)", () => {
      const r = calculateDiscreteV2Schedule(baseInput({
        outcome: "incorrect",
        hasValidServerQuestion: false,
        hasHardEvidence: false,
      }));
      assert.equal(r.reasonCode, "incorrect_reset");
      assert.equal(r.afterIntervalDays, 1);
    });
  });

  // ── Unassisted cooldown affects incorrect/unable ──────────────────

  describe("unassisted cooldown on incorrect/unable", () => {
    it("incorrect respects cooldown when later than now+1d", () => {
      const cooldownEnd = daysAfterNow(3);
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 30,
        outcome: "incorrect",
        unassistedEligibleAfter: cooldownEnd,
      }));
      assert.deepEqual(r.nextReviewAt, cooldownEnd);
      assert.equal(r.afterIntervalDays, 1);
    });

    it("unable respects cooldown when later than now+1d", () => {
      const cooldownEnd = daysAfterNow(5);
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 14,
        outcome: "unable",
        unassistedEligibleAfter: cooldownEnd,
      }));
      assert.deepEqual(r.nextReviewAt, cooldownEnd);
    });

    it("correct does NOT apply cooldown (upgrade trusts the answer)", () => {
      const cooldownEnd = daysAfterNow(10);
      const r = calculateDiscreteV2Schedule(baseInput({
        currentIntervalDays: 1,
        outcome: "correct",
        unassistedEligibleAfter: cooldownEnd,
      }));
      // correct advances to 3 days, cooldown at 10 days should NOT apply
      assert.deepEqual(r.nextReviewAt, daysAfterNow(3));
    });
  });

  // ── effectiveReviewStart helper ────────────────────────────────────

  describe("effectiveReviewStart", () => {
    it("returns nextReviewAt when no exposure", () => {
      const due = daysAfterNow(7);
      assert.deepEqual(effectiveReviewStart(due, null), due);
    });

    it("returns nextReviewAt when cooldown is earlier", () => {
      const due = daysAfterNow(7);
      const cooldown = daysAfterNow(3);
      assert.deepEqual(effectiveReviewStart(due, cooldown), due);
    });

    it("returns cooldown when later than nextReviewAt", () => {
      const due = daysAfterNow(3);
      const cooldown = daysAfterNow(7);
      assert.deepEqual(effectiveReviewStart(due, cooldown), cooldown);
    });
  });

  // ── Error cases ────────────────────────────────────────────────────

  describe("error cases", () => {
    it("invalid input object", () => {
      assert.throws(
        () => calculateDiscreteV2Schedule(null as unknown as DiscreteV2Input),
        (e: unknown) => e instanceof DiscreteV2PolicyError && e.code === "invalid_input",
      );
    });

    it("invalid outcome", () => {
      assert.throws(
        () => calculateDiscreteV2Schedule(baseInput({ outcome: "invalid" as never })),
        (e: unknown) => e instanceof DiscreteV2PolicyError && e.code === "invalid_outcome",
      );
    });

    it("invalid interval (negative)", () => {
      assert.throws(
        () => calculateDiscreteV2Schedule(baseInput({ currentIntervalDays: -1 })),
        (e: unknown) => e instanceof DiscreteV2PolicyError && e.code === "invalid_interval",
      );
    });

    it("invalid interval (> 60)", () => {
      assert.throws(
        () => calculateDiscreteV2Schedule(baseInput({ currentIntervalDays: 100 })),
        (e: unknown) => e instanceof DiscreteV2PolicyError && e.code === "invalid_interval",
      );
    });

    it("invalid time (Infinity)", () => {
      assert.throws(
        () => calculateDiscreteV2Schedule(baseInput({ now: new Date(Infinity) })),
        (e: unknown) => e instanceof DiscreteV2PolicyError && e.code === "invalid_time",
      );
    });
  });

  // ── All outcomes table ─────────────────────────────────────────────

  describe("all outcomes table (interval=7, no cooldown)", () => {
    const outcomes: Array<[string, DiscreteV2Input["outcome"], number, string, string, boolean]> = [
      // [label, outcome, afterInterval, reasonCode, understandingEffect, shouldMutate]
      ["correct",   "correct",         14, "correct_advance",      "upgrade",    true],
      ["partial",   "partial",          7, "partial_hold",         "unchanged",  true],
      ["incorrect", "incorrect",        1, "incorrect_reset",      "downgrade",  true],
      ["unable",    "unable",           1, "unable_reset",         "downgrade",  true],
      ["source_viewed", "source_viewed", 7, "source_viewed_hold",  "unchanged",  true],
      ["later",     "later",            7, "later_short_deferral", "unchanged",  true],
      ["stale",     "stale",            7, "stale_no_change",      "unchanged",  false],
      ["provider_failure", "provider_failure", 7, "provider_failure_no_change", "unchanged", false],
    ];

    for (const [label, outcome, after, reason, effect, shouldMutate] of outcomes) {
      it(`${label} → interval=${after}, reason=${reason}, effect=${effect}, mutate=${shouldMutate}`, () => {
        const r = calculateDiscreteV2Schedule(baseInput({
          currentIntervalDays: 7,
          outcome,
        }));
        assert.equal(r.afterIntervalDays, after, `afterIntervalDays mismatch for ${label}`);
        assert.equal(r.reasonCode, reason, `reasonCode mismatch for ${label}`);
        assert.equal(r.understandingEffect, effect, `understandingEffect mismatch for ${label}`);
        assert.equal(r.shouldMutateSchedule, shouldMutate, `shouldMutateSchedule mismatch for ${label}`);
        assert.equal(r.policyVersion, "discrete-v2");
      });
    }
  });
});
