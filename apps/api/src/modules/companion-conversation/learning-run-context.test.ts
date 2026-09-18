import assert from "node:assert/strict";
import test from "node:test";
import {
  contextRevisionForCompanionLearningRun,
  isCompanionLearningRunTutorEligible,
  type CompanionLearningRunContextRow,
} from "./learning-run-context.ts";

const base: CompanionLearningRunContextRow = {
  runId: "123e4567-e89b-12d3-a456-426614174000",
  snapshotId: "223e4567-e89b-12d3-a456-426614174000",
  snapshotHash: "a".repeat(64),
  contractSnapshotHash: "a".repeat(64),
  taskId: "323e4567-e89b-12d3-a456-426614174000",
  phase: "active",
  runRevision: 4,
  runtimeEpoch: 2,
  taskStatus: "active",
  taskRevision: 1,
  publishedTargetEligibility: "eligible",
};

test("LearningRun Tutor context：revision 绑定冻结 snapshot 和当前 task", () => {
  const revision = contextRevisionForCompanionLearningRun(base);
  assert.match(revision, /^[0-9a-f]{64}$/);
  assert.notEqual(
    revision,
    contextRevisionForCompanionLearningRun({ ...base, taskRevision: 2 }),
  );
  assert.notEqual(
    revision,
    contextRevisionForCompanionLearningRun({ ...base, snapshotHash: "b".repeat(64) }),
  );
});

test("LearningRun Tutor context：仅当前活跃 task 且冻结闭包一致时可授权", () => {
  assert.equal(isCompanionLearningRunTutorEligible(base), true);
  assert.equal(isCompanionLearningRunTutorEligible({ ...base, phase: "assessing" }), false);
  assert.equal(isCompanionLearningRunTutorEligible({ ...base, taskStatus: "answered" }), false);
  assert.equal(isCompanionLearningRunTutorEligible({ ...base, contractSnapshotHash: "b".repeat(64) }), false);
  assert.equal(isCompanionLearningRunTutorEligible({ ...base, publishedTargetEligibility: "blocked" }), false);
  assert.equal(isCompanionLearningRunTutorEligible({ ...base, publishedTargetEligibility: null }), false);
});
