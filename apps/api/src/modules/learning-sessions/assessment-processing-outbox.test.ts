import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessmentInputFromOutboxJob,
  processAssessmentOutboxJob,
  type AssessmentOutboxJob,
  type AssessmentProcessingOutboxRepository,
} from "./assessment-processing-outbox.ts";

const job: AssessmentOutboxJob = {
  id: "job-1",
  workspaceId: "workspace-1",
  userId: "user-1",
  sessionId: "session-1",
  episodeId: "episode-1",
  artifactId: "artifact-1",
  commandType: "assessment_requested",
  idempotencyKey: "assessment:session-1:episode-1:artifact-1",
  attempts: 1,
  leaseOwner: "worker-1",
};

function outboxSpy() {
  const calls: string[] = [];
  const outbox: AssessmentProcessingOutboxRepository = {
    enqueueAssessment: async () => undefined,
    claimNext: async () => null,
    markProcessed: async () => { calls.push("processed"); },
    release: async () => { calls.push("released"); },
  };
  return { calls, outbox };
}

test("assessmentInputFromOutboxJob only carries scoped identifiers", () => {
  assert.deepEqual(assessmentInputFromOutboxJob(job), {
    workspaceId: "workspace-1",
    userId: "user-1",
    sessionId: "session-1",
    episodeId: "episode-1",
    artifactId: "artifact-1",
  });
});

test("worker success marks the leased job processed", async () => {
  const { calls, outbox } = outboxSpy();
  const assessment = {
    findLockedArtifact: async () => null,
    findEpisodeRubricTargets: async () => null,
    writeAssessment: async () => undefined,
  };
  const result = await processAssessmentOutboxJob(
    job,
    { assessment, outbox },
    new Date("2026-08-09T00:00:00Z"),
    async () => ({}) as never,
  );
  assert.equal(result, "processed");
  assert.deepEqual(calls, ["processed"]);
});

test("worker failure releases the job for retry", async () => {
  const { calls, outbox } = outboxSpy();
  const assessment = {
    findLockedArtifact: async () => null,
    findEpisodeRubricTargets: async () => null,
    writeAssessment: async () => undefined,
  };
  const result = await processAssessmentOutboxJob(
    job,
    { assessment, outbox },
    new Date("2026-08-09T00:00:00Z"),
    async () => { throw new Error("critic unavailable"); },
  );
  assert.equal(result, "released");
  assert.deepEqual(calls, ["released"]);
});

