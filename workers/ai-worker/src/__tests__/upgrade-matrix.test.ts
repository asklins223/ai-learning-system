import { test } from "node:test";
import assert from "node:assert/strict";
import { decideUpgrade, verifyUpgradeMatrixPrerequisites } from "../agent/upgrade-matrix.ts";

const base = {
  escalateGapsRemain: false,
  coverageComplete: true,
  survivingCoverage: 0.9,
  coverageThreshold: 0.7,
  contextUtilization: 0.5,
  contextThreshold: 0.85,
  hasComplexHardIssue: false,
  currentMode: "adaptive_planned_v1" as const,
};

test("no escalation when everything healthy", () => {
  const d = decideUpgrade(base);
  assert.equal(d.escalate, false);
  assert.deepEqual(d.reason, []);
});

test("escalate on replan-remaining escalate gaps", () => {
  const d = decideUpgrade({ ...base, escalateGapsRemain: true });
  assert.equal(d.escalate, true);
  assert.ok(d.reason[0].includes("escalate"));
});

test("escalate on coverage below threshold", () => {
  const d = decideUpgrade({ ...base, survivingCoverage: 0.6 });
  assert.equal(d.escalate, true);
  assert.ok(d.reason.some((r) => r.includes("coverage")));
});

test("escalate on context shortage", () => {
  const d = decideUpgrade({ ...base, contextUtilization: 0.9 });
  assert.equal(d.escalate, true);
  assert.ok(d.reason.some((r) => r.includes("上下文")));
});

test("escalate on complex hard issue", () => {
  const d = decideUpgrade({ ...base, hasComplexHardIssue: true });
  assert.equal(d.escalate, true);
  assert.ok(d.reason.some((r) => r.includes("Hard_Issue")));
});

test("multiple reasons aggregated", () => {
  const d = decideUpgrade({ ...base, escalateGapsRemain: true, survivingCoverage: 0.5, hasComplexHardIssue: true });
  assert.equal(d.reason.length, 3);
});

test("升级矩阵前置四项验证", () => {
  const ok = verifyUpgradeMatrixPrerequisites({
    reusableArtifacts: true,
    gapDetectionCatchesFastLeftovers: true,
    repairNotReset: true,
    costStacking: true,
  });
  assert.deepEqual(ok, []);

  const bad = verifyUpgradeMatrixPrerequisites({
    reusableArtifacts: false,
    gapDetectionCatchesFastLeftovers: false,
    repairNotReset: true,
    costStacking: false,
  });
  assert.deepEqual(bad.map((v) => v.code).sort(), ["cost_stacking", "gap_detection_fast_leftovers", "reusable_artifacts"]);
});
