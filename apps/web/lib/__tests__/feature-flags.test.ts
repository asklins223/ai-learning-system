/**
 * Unit tests for client-side feature flags (计划 §12.2)
 *
 * Verifies that feature-flags.ts correctly reads NEXT_PUBLIC_ environment
 * variables and fails closed unless a feature is explicitly enabled.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isQuestionFirstUIEnabled,
  isAIQuestionEnabled,
  isCardGenerationV2Enabled,
  isRubricEvaluationEnabled,
} from "../feature-flags.ts";

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

describe("Client-side feature flags", () => {
  describe("isQuestionFirstUIEnabled", () => {
    it("defaults to false when NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED is unset", () => {
      withEnv({ NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED: undefined }, () => {
        assert.equal(isQuestionFirstUIEnabled(), false);
      });
    });

    it("returns false when set to 'false'", () => {
      withEnv({ NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED: "false" }, () => {
        assert.equal(isQuestionFirstUIEnabled(), false);
      });
    });

    it("returns true when set to 'true'", () => {
      withEnv({ NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED: "true" }, () => {
        assert.equal(isQuestionFirstUIEnabled(), true);
      });
    });

    it("does not enable the feature for an invalid value", () => {
      withEnv({ NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED: "1" }, () => {
        assert.equal(isQuestionFirstUIEnabled(), false);
      });
    });
  });

  describe("isAIQuestionEnabled", () => {
    it("defaults to false when NEXT_PUBLIC_AI_QUESTION_V1_ENABLED is unset", () => {
      withEnv({ NEXT_PUBLIC_AI_QUESTION_V1_ENABLED: undefined }, () => {
        assert.equal(isAIQuestionEnabled(), false);
      });
    });

    it("returns false when set to 'false'", () => {
      withEnv({ NEXT_PUBLIC_AI_QUESTION_V1_ENABLED: "false" }, () => {
        assert.equal(isAIQuestionEnabled(), false);
      });
    });
  });

  describe("isRubricEvaluationEnabled", () => {
    it("defaults to false when NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED is unset", () => {
      withEnv({ NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED: undefined }, () => {
        assert.equal(isRubricEvaluationEnabled(), false);
      });
    });

    it("returns false when set to 'false'", () => {
      withEnv({ NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED: "false" }, () => {
        assert.equal(isRubricEvaluationEnabled(), false);
      });
    });
  });

  describe("isCardGenerationV2Enabled", () => {
    it("defaults to enabled after the M6 rollout", () => {
      withEnv({ NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED: undefined }, () => {
        assert.equal(isCardGenerationV2Enabled(), true);
      });
    });

    it("supports the explicit false rollback switch", () => {
      withEnv({ NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED: "false" }, () => {
        assert.equal(isCardGenerationV2Enabled(), false);
      });
    });

    it("rejects invalid non-empty values", () => {
      withEnv({ NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED: "1" }, () => {
        assert.equal(isCardGenerationV2Enabled(), false);
      });
    });
  });

  describe("Fail-closed invariant (计划 §12.2)", () => {
    it("all v0.6 features default to disabled", () => {
      withEnv(
        {
          NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED: undefined,
          NEXT_PUBLIC_AI_QUESTION_V1_ENABLED: undefined,
          NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED: undefined,
        },
        () => {
          assert.equal(isQuestionFirstUIEnabled(), false);
          assert.equal(isAIQuestionEnabled(), false);
          assert.equal(isRubricEvaluationEnabled(), false);
        },
      );
    });

    it("all v0.6 features require an explicit true value", () => {
      withEnv(
        {
          NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED: "true",
          NEXT_PUBLIC_AI_QUESTION_V1_ENABLED: "true",
          NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED: "true",
        },
        () => {
          assert.equal(isQuestionFirstUIEnabled(), true);
          assert.equal(isAIQuestionEnabled(), true);
          assert.equal(isRubricEvaluationEnabled(), true);
        },
      );
    });
  });
});
