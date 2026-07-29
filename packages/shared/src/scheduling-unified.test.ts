/**
 * Unit tests for unified scheduling dispatcher (计划 §10.6, §12.2)
 *
 * Verifies that calculateSchedule correctly delegates to explicitly enabled
 * discrete-v2 or the fail-closed discrete-v1 default.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateSchedule,
  DISCRETE_V1_POLICY_VERSION,
  DISCRETE_V1_INTERVAL_TIERS,
  type UnifiedScheduleInput,
} from "./scheduling-unified.ts";
import { DISCRETE_V2_POLICY_VERSION } from "./scheduling-policy-v2.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-25T12:00:00Z");
const MS_PER_HOUR = 60 * 60 * 1000;

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const originals: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    originals[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

// ─── discrete-v2 (default) tests ─────────────────────────────────────────

test("discrete-v2 (explicit): correct advances interval", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v2" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 1, outcome: "correct" }));
    assert.equal(result.policyVersion, DISCRETE_V2_POLICY_VERSION);
    assert.equal(result.shouldMutateSchedule, true);
    assert.equal(result.afterIntervalDays, 3); // 1 → 3
    assert.equal(result.understandingEffect, "upgrade");
  });
});

test("discrete-v2 (explicit): partial does NOT advance (key v0.6 fix)", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v2" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 3, outcome: "partial" }));
    assert.equal(result.policyVersion, DISCRETE_V2_POLICY_VERSION);
    assert.equal(result.shouldMutateSchedule, true);
    assert.equal(result.afterIntervalDays, 3); // stays at 3 (partial_hold)
    assert.equal(result.reasonCode, "partial_hold");
    assert.equal(result.understandingEffect, "unchanged");
  });
});

test("discrete-v2 (explicit): source_viewed does NOT advance", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v2" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 7, outcome: "source_viewed" }));
    assert.equal(result.shouldMutateSchedule, true);
    assert.equal(result.afterIntervalDays, 7); // stays at 7
    assert.equal(result.understandingEffect, "unchanged");
  });
});

test("discrete-v2 (explicit): stale does not mutate schedule", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v2" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 7, outcome: "stale" }));
    assert.equal(result.shouldMutateSchedule, false);
  });
});

test("discrete-v2 (explicit): provider_failure does not mutate schedule", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v2" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 7, outcome: "provider_failure" }));
    assert.equal(result.shouldMutateSchedule, false);
  });
});

// ─── discrete-v1 tests ───────────────────────────────────────────────────

test("discrete-v1: correct advances interval", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v1" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 1, outcome: "correct" }));
    assert.equal(result.policyVersion, DISCRETE_V1_POLICY_VERSION);
    assert.equal(result.shouldMutateSchedule, true);
    assert.equal(result.afterIntervalDays, 3); // 1 → 3
    assert.equal(result.understandingEffect, "upgrade");
  });
});

test("discrete-v1: partial DOES advance (v0.5 bug behavior)", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v1" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 3, outcome: "partial" }));
    assert.equal(result.policyVersion, DISCRETE_V1_POLICY_VERSION);
    assert.equal(result.shouldMutateSchedule, true);
    assert.equal(result.afterIntervalDays, 7); // 3 → 7 (partial advances in v1!)
    assert.equal(result.understandingEffect, "upgrade");
  });
});

test("discrete-v1: source_viewed holds interval (assisted must never advance, 计划 §4.1-4)", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v1" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 1, outcome: "source_viewed" }));
    assert.equal(result.policyVersion, DISCRETE_V1_POLICY_VERSION);
    assert.equal(result.shouldMutateSchedule, true);
    assert.equal(result.afterIntervalDays, 1); // interval must NOT increase
    assert.equal(result.understandingEffect, "unchanged");
    assert.equal(result.reasonCode, "assisted_hold");
  });
});

test("discrete-v1: source_viewed respects unassisted_eligible_after floor", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v1" }, () => {
    const now = new Date("2026-07-26T00:00:00Z");
    const eligible = new Date("2026-07-28T12:00:00Z"); // later than now+1d
    const result = calculateSchedule(makeInput({
      currentIntervalDays: 7,
      outcome: "source_viewed",
      now,
      unassistedEligibleAfter: eligible,
    }));
    assert.equal(result.afterIntervalDays, 7);
    assert.equal(result.nextReviewAt.getTime(), eligible.getTime());
    assert.equal(result.understandingEffect, "unchanged");
  });
});

test("discrete-v1: stale does not mutate schedule", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v1" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 7, outcome: "stale" }));
    assert.equal(result.policyVersion, DISCRETE_V1_POLICY_VERSION);
    assert.equal(result.shouldMutateSchedule, false);
  });
});

test("discrete-v1: provider_failure does not mutate schedule", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v1" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 7, outcome: "provider_failure" }));
    assert.equal(result.policyVersion, DISCRETE_V1_POLICY_VERSION);
    assert.equal(result.shouldMutateSchedule, false);
  });
});

test("discrete-v1: incorrect resets to 1 day", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v1" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 30, outcome: "incorrect" }));
    assert.equal(result.policyVersion, DISCRETE_V1_POLICY_VERSION);
    assert.equal(result.afterIntervalDays, 1);
    assert.equal(result.understandingEffect, "downgrade");
    assert.equal(result.reasonCode, "incorrect_reset");
  });
});

test("discrete-v1: unable resets to 1 day", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v1" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 30, outcome: "unable" }));
    assert.equal(result.policyVersion, DISCRETE_V1_POLICY_VERSION);
    assert.equal(result.afterIntervalDays, 1);
    assert.equal(result.understandingEffect, "downgrade");
  });
});

test("discrete-v1: later delays 12 hours, keeps interval", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v1" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 7, outcome: "later" }));
    assert.equal(result.policyVersion, DISCRETE_V1_POLICY_VERSION);
    assert.equal(result.afterIntervalDays, 7); // unchanged
    assert.equal(result.shouldMutateSchedule, true);
    // nextReviewAt should be ~12 hours from now
    const expected = new Date(NOW.getTime() + 12 * MS_PER_HOUR);
    assert.equal(result.nextReviewAt.getTime(), expected.getTime());
  });
});

test("discrete-v1: interval caps at 60", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v1" }, () => {
    const result = calculateSchedule(makeInput({ currentIntervalDays: 60, outcome: "correct" }));
    assert.equal(result.afterIntervalDays, 60); // capped
    assert.equal(result.reasonCode, "correct_interval_cap");
  });
});

// ─── Key behavioral difference: partial in v1 vs v2 ──────────────────────

test("Key difference: partial advances in v1 but not in v2", () => {
  // v1: partial advances
  const v1Result = withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v1" }, () =>
    calculateSchedule(makeInput({ currentIntervalDays: 3, outcome: "partial" })),
  );
  assert.equal(v1Result.afterIntervalDays, 7, "v1: partial should advance 3→7");
  assert.equal(v1Result.understandingEffect, "upgrade");

  // v2: partial does NOT advance
  const v2Result = withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v2" }, () =>
    calculateSchedule(makeInput({ currentIntervalDays: 3, outcome: "partial" })),
  );
  assert.equal(v2Result.afterIntervalDays, 3, "v2: partial should NOT advance (stays at 3)");
  assert.equal(v2Result.understandingEffect, "unchanged");
});

// ─── Guard checks (both versions) ────────────────────────────────────────

test("Both versions: correct without valid question → no upgrade", () => {
  for (const version of ["discrete-v1", "discrete-v2", undefined] as const) {
    const result = withEnv(
      { SCHEDULER_POLICY_VERSION: version },
      () => calculateSchedule(makeInput({
        currentIntervalDays: 1,
        outcome: "correct",
        hasValidServerQuestion: false,
      })),
    );
    assert.equal(result.understandingEffect, "unchanged", `version=${version ?? "default"}`);
    assert.equal(result.shouldMutateSchedule, true, `version=${version ?? "default"}`);
  }
});

test("Both versions: correct without hard evidence → no upgrade", () => {
  for (const version of ["discrete-v1", "discrete-v2", undefined] as const) {
    const result = withEnv(
      { SCHEDULER_POLICY_VERSION: version },
      () => calculateSchedule(makeInput({
        currentIntervalDays: 1,
        outcome: "correct",
        hasHardEvidence: false,
      })),
    );
    assert.equal(result.understandingEffect, "unchanged", `version=${version ?? "default"}`);
  }
});

// ─── V1 interval tiers ───────────────────────────────────────────────────

test("V1 interval tiers match expected [1,3,7,14,30,60]", () => {
  assert.deepEqual([...DISCRETE_V1_INTERVAL_TIERS], [1, 3, 7, 14, 30, 60]);
});
