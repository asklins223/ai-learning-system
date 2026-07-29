/**
 * Unit tests for server-side feature flags (计划 §12.2)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAIQuestionEnabled,
  isRubricEvaluationEnabled,
  getSchedulerPolicyVersion,
  isSchedulerPolicyV2,
  isCardRepairEnabled,
  isCardGenerationV2Enabled,
} from "./feature-flags.ts";
import { isFSRSShadowEnabled } from "./fsrs-shadow.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

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

// ─── AI_QUESTION_V1_ENABLED ──────────────────────────────────────────────

test("AI_QUESTION_V1_ENABLED: defaults to false when unset", () => {
  withEnv({ AI_QUESTION_V1_ENABLED: undefined }, () => {
    assert.equal(isAIQuestionEnabled(), false);
  });
});

test("AI_QUESTION_V1_ENABLED: false when set to 'false'", () => {
  withEnv({ AI_QUESTION_V1_ENABLED: "false" }, () => {
    assert.equal(isAIQuestionEnabled(), false);
  });
});

test("AI_QUESTION_V1_ENABLED: true when set to 'true'", () => {
  withEnv({ AI_QUESTION_V1_ENABLED: "true" }, () => {
    assert.equal(isAIQuestionEnabled(), true);
  });
});

test("AI_QUESTION_V1_ENABLED: false when set to any other value", () => {
  withEnv({ AI_QUESTION_V1_ENABLED: "yes" }, () => {
    assert.equal(isAIQuestionEnabled(), false);
  });
});

// ─── RUBRIC_EVALUATION_V1_ENABLED ────────────────────────────────────────

test("RUBRIC_EVALUATION_V1_ENABLED: defaults to false when unset", () => {
  withEnv({ RUBRIC_EVALUATION_V1_ENABLED: undefined }, () => {
    assert.equal(isRubricEvaluationEnabled(), false);
  });
});

test("RUBRIC_EVALUATION_V1_ENABLED: false when set to 'false'", () => {
  withEnv({ RUBRIC_EVALUATION_V1_ENABLED: "false" }, () => {
    assert.equal(isRubricEvaluationEnabled(), false);
  });
});

test("RUBRIC_EVALUATION_V1_ENABLED: true when set to 'true'", () => {
  withEnv({ RUBRIC_EVALUATION_V1_ENABLED: "true" }, () => {
    assert.equal(isRubricEvaluationEnabled(), true);
  });
});

// ─── SCHEDULER_POLICY_VERSION ────────────────────────────────────────────

test("SCHEDULER_POLICY_VERSION: defaults to 'discrete-v1' when unset", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: undefined }, () => {
    assert.equal(getSchedulerPolicyVersion(), "discrete-v1");
    assert.equal(isSchedulerPolicyV2(), false);
  });
});

test("SCHEDULER_POLICY_VERSION: 'discrete-v1' when set to 'discrete-v1'", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v1" }, () => {
    assert.equal(getSchedulerPolicyVersion(), "discrete-v1");
    assert.equal(isSchedulerPolicyV2(), false);
  });
});

test("SCHEDULER_POLICY_VERSION: 'discrete-v2' when set to 'discrete-v2'", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "discrete-v2" }, () => {
    assert.equal(getSchedulerPolicyVersion(), "discrete-v2");
    assert.equal(isSchedulerPolicyV2(), true);
  });
});

test("SCHEDULER_POLICY_VERSION: defaults to 'discrete-v1' for unknown values", () => {
  withEnv({ SCHEDULER_POLICY_VERSION: "unknown" }, () => {
    assert.equal(getSchedulerPolicyVersion(), "discrete-v1");
    assert.equal(isSchedulerPolicyV2(), false);
  });
});

// ─── CARD_REPAIR_V1_ENABLED ──────────────────────────────────────────────

test("CARD_REPAIR_V1_ENABLED: defaults to false when unset", () => {
  withEnv({ CARD_REPAIR_V1_ENABLED: undefined }, () => {
    assert.equal(isCardRepairEnabled(), false);
  });
});

test("CARD_REPAIR_V1_ENABLED: true when set to 'true'", () => {
  withEnv({ CARD_REPAIR_V1_ENABLED: "true" }, () => {
    assert.equal(isCardRepairEnabled(), true);
  });
});

test("CARD_REPAIR_V1_ENABLED: false when set to 'false'", () => {
  withEnv({ CARD_REPAIR_V1_ENABLED: "false" }, () => {
    assert.equal(isCardRepairEnabled(), false);
  });
});

test("CARD_GENERATION_V2_ENABLED: defaults off (fail-closed) with explicit true opt-in", () => {
  withEnv({ CARD_GENERATION_V2_ENABLED: undefined }, () => {
    assert.equal(isCardGenerationV2Enabled(), false);
  });
  withEnv({ CARD_GENERATION_V2_ENABLED: "1" }, () => {
    assert.equal(isCardGenerationV2Enabled(), false);
  });
  withEnv({ CARD_GENERATION_V2_ENABLED: "false" }, () => {
    assert.equal(isCardGenerationV2Enabled(), false);
  });
  withEnv({ CARD_GENERATION_V2_ENABLED: "true" }, () => {
    assert.equal(isCardGenerationV2Enabled(), true);
  });
});

// ─── FSRS_SHADOW_ENABLED (re-exported from fsrs-shadow.ts) ───────────────

test("FSRS_SHADOW_ENABLED: defaults to false when unset", () => {
  withEnv({ FSRS_SHADOW_ENABLED: undefined }, () => {
    assert.equal(isFSRSShadowEnabled(), false);
  });
});

test("FSRS_SHADOW_ENABLED: true when set to 'true'", () => {
  withEnv({ FSRS_SHADOW_ENABLED: "true" }, () => {
    assert.equal(isFSRSShadowEnabled(), true);
  });
});

// ─── Fail-closed invariant (计划 §12.2) ──────────────────────────────────

test("Default rollout: all v0.6 flags default off (fail-closed)", () => {
  withEnv(
    {
      AI_QUESTION_V1_ENABLED: undefined,
      RUBRIC_EVALUATION_V1_ENABLED: undefined,
      SCHEDULER_POLICY_VERSION: undefined,
      CARD_REPAIR_V1_ENABLED: undefined,
      CARD_GENERATION_V2_ENABLED: undefined,
      FSRS_SHADOW_ENABLED: undefined,
    },
    () => {
      assert.equal(isAIQuestionEnabled(), false);
      assert.equal(isRubricEvaluationEnabled(), false);
      assert.equal(isSchedulerPolicyV2(), false);
      assert.equal(isCardRepairEnabled(), false);
      assert.equal(isCardGenerationV2Enabled(), false);
      assert.equal(isFSRSShadowEnabled(), false);
    },
  );
});
