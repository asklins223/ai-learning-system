import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearningRunPublicV1 } from "@ailearn/shared";
import { buildLearningRunAllowedActionsV2 } from "./run-action-availability.ts";

const baseView = (phase: LearningRunPublicV1["phase"]): LearningRunPublicV1 => ({
  version: 1,
  runId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  assistantSessionId: null,
  origin: { kind: "card", cardId: "00000000-0000-4000-8000-000000000004", keyPointId: "00000000-0000-4000-8000-000000000005" },
  returnTarget: { kind: "card", cardId: "00000000-0000-4000-8000-000000000004", keyPointId: "00000000-0000-4000-8000-000000000005" },
  target: { kind: "key_point", keyPointId: "00000000-0000-4000-8000-000000000005", fingerprint: "target-fingerprint" },
  projectionBaselineCheckpoint: null,
  goal: "stabilize",
  schedulePolicySummary: { kind: "no_schedule_effect", reasonCode: "practice" },
  phase,
  timeBudgetSeconds: 120,
  plannedActiveSeconds: 120,
  activeSecondsUsed: 0,
  planningClosesAtActiveSecond: 150,
  activeTaskId: null,
  taskSummaries: [],
  activeTask: null,
  activeAssessment: null,
  checkpoint: null,
  failure: null,
  projectionStatus: "not_requested",
  revision: 1,
  runtimeEpoch: 0,
  eventCursor: 0,
  result: null,
});

const kinds = (view: LearningRunPublicV1): string[] => buildLearningRunAllowedActionsV2(view).map((action) => action.kind);

test("projects every lifecycle phase to an exact, fail-closed action set", () => {
  assert.deepEqual(kinds(baseView("preparing")), ["end"]);
  assert.deepEqual(kinds(baseView("active")), ["pause", "skip_run", "end"]);
  assert.deepEqual(kinds(baseView("paused")), ["resume", "end"]);
  assert.deepEqual(kinds(baseView("assessing")), ["end"]);
  assert.deepEqual(kinds(baseView("committing")), ["end"]);
  assert.deepEqual(kinds(baseView("completed")), []);
  assert.deepEqual(kinds(baseView("ended")), []);
  assert.deepEqual(kinds(baseView("skipped")), []);
  assert.deepEqual(kinds(baseView("cancelled")), []);
  assert.deepEqual(kinds(baseView("stale")), []);
});

test("projects checkpoint and recoverable-error branches only from server proof", () => {
  const partial = baseView("checkpoint");
  partial.checkpoint = { kind: "partial", allowedFollowupIds: ["supplement:1"] };
  assert.deepEqual(kinds(partial), ["finish_current_evidence", "activate_followup", "end"]);

  const notAssessable = baseView("checkpoint");
  notAssessable.checkpoint = { kind: "not_assessable", allowedFollowupIds: [] };
  assert.deepEqual(kinds(notAssessable), ["finish_without_commit", "end"]);

  const prepareFailure = baseView("recoverable_error");
  prepareFailure.failure = { stage: "prepare", code: "planner_unavailable", retryable: true };
  assert.deepEqual(kinds(prepareFailure), ["retry_prepare", "end"]);

  const assessmentFailure = baseView("recoverable_error");
  assessmentFailure.failure = { stage: "assessment", code: "critic_unavailable", retryable: true };
  assessmentFailure.activeAssessment = {
    version: 1,
    assessmentId: "00000000-0000-4000-8000-000000000006",
    runId: assessmentFailure.runId,
    taskId: "00000000-0000-4000-8000-000000000008",
    artifactId: "00000000-0000-4000-8000-000000000007",
    source: "assessment_critic",
    status: "queued",
    rubricResults: [],
    trustClass: null,
    reportHash: null,
  };
  assert.deepEqual(kinds(assessmentFailure), ["retry_assessment", "end"]);

  // H1：tick 失败路径留下的三种未终态（queued/running/failed）都可重试。
  for (const status of ["queued", "running", "failed"] as const) {
    const retryable = baseView("recoverable_error");
    retryable.failure = { stage: "assessment", code: "assessment_timeout", retryable: true };
    retryable.activeAssessment = { ...assessmentFailure.activeAssessment!, status };
    assert.deepEqual(kinds(retryable), ["retry_assessment", "end"], `status=${status} 应可重试`);
  }

  // completed/not_assessable 的评估不可重试：不得宣告一个必然 409 的入口。
  for (const status of ["completed", "not_assessable"] as const) {
    const notRetryable = baseView("recoverable_error");
    notRetryable.failure = { stage: "assessment", code: "assessment_timeout", retryable: true };
    notRetryable.activeAssessment = { ...assessmentFailure.activeAssessment!, status };
    assert.deepEqual(kinds(notRetryable), ["end"], `status=${status} 不得宣告 retry_assessment`);
  }

  const commitFailure = baseView("recoverable_error");
  commitFailure.failure = { stage: "commit", code: "scheduler_unavailable", retryable: true };
  assert.deepEqual(kinds(commitFailure), ["retry_commit", "end"]);
});
