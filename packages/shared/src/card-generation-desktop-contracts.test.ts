import assert from "node:assert/strict";
import test from "node:test";
import {
  cardGenerationRunServerViewV2Schema,
  cardGenerationRunSnapshotV1Schema,
  cardGenerationActiveSummaryListV1Schema,
  cardGenerationRecoveryProjectionV1Schema,
  cardGenerationExposureEligibilityV1Schema,
  cardGenerationCandidateV1Schema,
  desktopCreateCardGenerationRunRequestV2Schema,
} from "./card-generation-desktop-contracts.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

test("desktop Card Generation accepts only whole-note start", () => {
  const request = {
    version: 2 as const,
    noteVersionId: VERSION_ID,
    sourceScope: { kind: "whole_note" as const },
    learningGoal: "understand" as const,
    detailThreshold: "balanced" as const,
    quantity: { kind: "adaptive" as const },
    preferredStrategies: [],
    clientRequestId: "desktop-command-1",
  };
  assert.equal(desktopCreateCardGenerationRunRequestV2Schema.safeParse(request).success, true);
  assert.equal(desktopCreateCardGenerationRunRequestV2Schema.safeParse({ ...request, sourceScope: { kind: "section", sectionKey: "x" } }).success, false);
});

test("main-only run view projects without hashes", () => {
  const server = cardGenerationRunServerViewV2Schema.parse({
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status: "planning",
    cardContentEpoch: 1,
    sourceSnapshotHash: "a".repeat(64),
    semanticSpecHash: "b".repeat(64),
    inputSnapshotHash: "c".repeat(64),
    generationFingerprint: "d".repeat(64),
    currentPlanVersion: 0,
    reviewDraftRevision: 1,
    sourceOutdated: false,
    recovery: null,
    error: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:01.000Z",
  });
  const publicView = cardGenerationRunSnapshotV1Schema.parse({
    version: 1,
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status: "planning",
    cardContentEpoch: 1,
    currentPlanVersion: 0,
    reviewDraftRevision: 1,
    sourceOutdated: false,
    recovery: null,
    sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID },
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  });
  assert.equal("sourceSnapshotHash" in publicView, false);
});

test("Owner recovery summary is strict and carries only a safe navigation target", () => {
  const summary = cardGenerationActiveSummaryListV1Schema.parse({
    version: 1,
    items: [{
      version: 1,
      runId: RUN_ID,
      noteId: NOTE_ID,
      noteVersionId: VERSION_ID,
      status: "review_ready",
      currentPlanVersion: 1,
      reviewDraftRevision: 2,
      updatedAt: "2026-08-23T00:00:01.000Z",
      recovery: null,
      route: { kind: "note.cardGeneration", cardGenerationRunId: RUN_ID },
    }],
  });
  assert.equal(summary.items[0]?.route.cardGenerationRunId, RUN_ID);
  assert.throws(() => cardGenerationActiveSummaryListV1Schema.parse({
    ...summary,
    items: [{ ...summary.items[0], sourceSnapshotHash: "a".repeat(64) }],
  }));
});

test("recovery projection is strict, source-bound, and never grants cancel_run", () => {
  const recovery = cardGenerationRecoveryProjectionV1Schema.parse({
    version: 1,
    publicReasonCode: "quality_gate_failed",
    retryability: "resync_required",
    allowedActions: [
      { kind: "refresh_status", runId: RUN_ID },
      { kind: "return_note", route: "note.detail", sourceRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
    ],
  });
  assert.deepEqual(recovery.allowedActions.map((action) => action.kind), ["refresh_status", "return_note"]);
  assert.equal("cancel_run" in recovery.allowedActions, false);
  assert.throws(() => cardGenerationRecoveryProjectionV1Schema.parse({
    ...recovery,
    retryability: "new_run_allowed",
  }));
  assert.throws(() => cardGenerationRecoveryProjectionV1Schema.parse({
    ...recovery,
    allowedActions: [{ kind: "start_new_generation", route: "note.cardGeneration" }],
  }));
});

test("exposure eligibility is strict and exposes only public policy state", () => {
  const projection = cardGenerationExposureEligibilityV1Schema.parse({
    version: 1,
    runId: RUN_ID,
    candidateId: "44444444-4444-4444-8444-444444444444",
    candidateRevisionId: "55555555-5555-4555-8555-555555555555",
    revision: 1,
    exposureStatus: "exposed",
    initialValidationPolicyEffect: "wait_for_initial_validation",
    lastExposedAt: "2026-08-23T00:00:02.000Z",
  });
  assert.equal(projection.exposureStatus, "exposed");
  assert.throws(() => cardGenerationExposureEligibilityV1Schema.parse({
    ...projection,
    canonicalAnswer: "must-not-cross-boundary",
  }));
});

test("failed candidates may omit an activation binding plan without becoming a server error", () => {
  const candidate = cardGenerationCandidateV1Schema.parse({
    version: 1,
    candidateId: "44444444-4444-4444-8444-444444444444",
    candidateRevisionId: "55555555-5555-4555-8555-555555555555",
    revision: 2,
    runId: RUN_ID,
    planRevisionId: "66666666-6666-4666-8666-666666666666",
    planVersion: 1,
    planObjectiveLocalId: "objective-1",
    recommendation: { recommended: true, reasonCodes: ["quality_gate_failed"] },
    objective: { statement: "公开目标", publicSummary: "公开摘要", knowledgeForm: "fact" },
    front: { cue: "提示", prompt: "公开问题" },
    strategy: "recall",
    transformationKind: "retrieval_definition",
    estimatedReviewSeconds: 30,
    evidenceSetHash: "a".repeat(64),
    candidateEvidenceBindingPlanHash: null,
    candidateRevisionHash: "b".repeat(64),
    qualityState: "failed",
    reviewDecision: "undecided",
    publishState: "unpublished",
    isReviewReady: false,
  });
  assert.equal(candidate.candidateEvidenceBindingPlanHash, null);
  assert.equal(candidate.isReviewReady, false);
});
