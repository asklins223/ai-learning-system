/**
 * Unit tests for client-side feature flags (计划 §12.2)
 *
 * Verifies that feature-flags.ts correctly reads NEXT_PUBLIC_ environment
 * variables and fails closed unless a feature is explicitly enabled.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isAgentActivityStreamEnabled,
  isCompanionPetV1Enabled,
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
  describe("isAgentActivityStreamEnabled", () => {
    it("defaults to false when NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED is unset", () => {
      withEnv({ NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED: undefined }, () => {
        assert.equal(isAgentActivityStreamEnabled(), false);
      });
    });

    it("returns false when set to 'false'", () => {
      withEnv({ NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED: "false" }, () => {
        assert.equal(isAgentActivityStreamEnabled(), false);
      });
    });

    it("returns true when set to 'true'", () => {
      withEnv({ NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED: "true" }, () => {
        assert.equal(isAgentActivityStreamEnabled(), true);
      });
    });

    it("does not enable the feature for an invalid value", () => {
      withEnv({ NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED: "1" }, () => {
        assert.equal(isAgentActivityStreamEnabled(), false);
      });
    });
  });

  describe("Fail-closed invariant (计划 §12.2)", () => {
    it("all v0.6 features default to disabled", () => {
      withEnv(
        {
          NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED: undefined,
        },
        () => {
          assert.equal(isAgentActivityStreamEnabled(), false);
        },
      );
    });

    it("all v0.6 features require an explicit true value", () => {
      withEnv(
        {
          NEXT_PUBLIC_AGENT_ACTIVITY_STREAM_ENABLED: "true",
        },
        () => {
          assert.equal(isAgentActivityStreamEnabled(), true);
        },
      );
    });

    describe("isCompanionPetV1Enabled (P1 desktop pet, 方案 13 §13.1)", () => {
      it("defaults to false when unset (fail-closed)", () => {
        withEnv({ NEXT_PUBLIC_COMPANION_PET_ENABLED: undefined }, () => {
          assert.equal(isCompanionPetV1Enabled(), false);
        });
      });
      it("requires an explicit true", () => {
        withEnv({ NEXT_PUBLIC_COMPANION_PET_ENABLED: "false" }, () => {
          assert.equal(isCompanionPetV1Enabled(), false);
        });
        withEnv({ NEXT_PUBLIC_COMPANION_PET_ENABLED: "1" }, () => {
          assert.equal(isCompanionPetV1Enabled(), false);
        });
      });
      it("enabled only for the exact true value", () => {
        withEnv({ NEXT_PUBLIC_COMPANION_PET_ENABLED: "true" }, () => {
          assert.equal(isCompanionPetV1Enabled(), true);
        });
      });
    });
  });
});
