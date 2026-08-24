import assert from "node:assert/strict";
import test from "node:test";
import {
  formalAssessmentGuardV1Schema,
  formalAssessmentGuardStateSchema,
} from "./index.ts";

const runId = "00000000-0000-4000-8000-000000000001";

test("FormalAssessmentGuardV1 freezes main-only states and keys", () => {
  assert.deepEqual(formalAssessmentGuardV1Schema.parse({
    version: 1,
    runId,
    runtimeEpoch: 4,
    state: "active",
    reason: "assessment_active",
  }), {
    version: 1,
    runId,
    runtimeEpoch: 4,
    state: "active",
    reason: "assessment_active",
  });
  assert.deepEqual(formalAssessmentGuardStateSchema.options, [
    "fail_closed_silent",
    "inactive",
    "armed",
    "active",
    "releasing",
  ]);
});

test("FormalAssessmentGuardV1 rejects V2/public or unknown payload fields", () => {
  assert.equal(formalAssessmentGuardV1Schema.safeParse({
    version: 2,
    runId,
    runtimeEpoch: 4,
    state: "active",
    reason: "assessment_active",
  }).success, false);
  assert.equal(formalAssessmentGuardV1Schema.safeParse({
    version: 1,
    runId,
    runtimeEpoch: 4,
    state: "active",
    reason: "assessment_active",
    prompt: "secret",
  }).success, false);
});

