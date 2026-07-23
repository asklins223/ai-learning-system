import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreWorkspace } from "../modules/export/service.ts";
import { notes, noteVersions } from "../db/schema/note.ts";
import { learningCards } from "../db/schema/card.ts";
import { validationEvents, reviewSchedules, reviewAttempts } from "../db/schema/evidence.ts";
import { aiArtifacts } from "../db/schema/ai.ts";
import { onboardingStates } from "../db/schema/identity.ts";

type RestoreDatabase = NonNullable<Parameters<typeof restoreWorkspace>[3]>;
type Operation = {
  kind: "insert" | "update";
  table: unknown;
  values: Record<string, unknown>;
};

function createRecordingDatabase(operations: Operation[]): RestoreDatabase {
  const tx = {
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          operations.push({ kind: "insert" as const, table, values });
          const returning = () => Promise.resolve([values]);
          const onConflict = () => ({
            returning,
            then: (resolve: any) => Promise.resolve(undefined).then(resolve),
          });
          return {
            returning,
            onConflictDoNothing: onConflict,
            then: (resolve: any) => Promise.resolve(undefined).then(resolve),
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            async where() {
              operations.push({ kind: "update" as const, table, values });
            },
          };
        },
      };
    },
  };

  return {
    query: {
      notes: {
        async findMany() {
          return [];
        },
      },
      sources: { async findMany() { return []; } },
      learningCards: { async findMany() { return []; } },
      jobs: { async findMany() { return []; } },
      aiArtifacts: { async findMany() { return []; } },
    },
    async transaction(callback: (transaction: typeof tx) => Promise<unknown>) {
      return callback(tx);
    },
  } as unknown as RestoreDatabase;
}

test("restore inserts FK parents before restoring note/card/validation references", async () => {
  const operations: Operation[] = [];
  const workspaceId = "10000000-0000-4000-8000-000000000001";
  const userId = "20000000-0000-4000-8000-000000000001";
  const noteId = "30000000-0000-4000-8000-000000000001";
  const versionId = "40000000-0000-4000-8000-000000000001";
  const artifactId = "50000000-0000-4000-8000-000000000001";
  const cardId = "60000000-0000-4000-8000-000000000001";

  const result = await restoreWorkspace(
    workspaceId,
    {
      workspace: { id: "source-workspace" },
      exportManifest: { version: "2.0" },
      users: [{ id: userId, email: "restored@example.test", role: "member" }],
      notes: [{
        id: noteId,
        title: "Restored note",
        titleSource: "manual",
        currentVersionId: versionId,
        sourceId: null,
        createdBy: userId,
      }],
      noteVersions: [{
        id: versionId,
        noteId,
        versionNo: 1,
        contentJson: { blocks: [] },
        createdBy: userId,
      }],
      aiArtifacts: [{
        id: artifactId,
        type: "learning_card",
        inputRefs: { noteVersionId: versionId },
        output: {},
        modelId: "mock-v1",
        promptVersion: "v1",
        status: "ready",
      }],
      learningCards: [{
        id: cardId,
        noteVersionId: versionId,
        status: "active",
        schemaJson: { title: "Card", summary: "Summary" },
        artifactId,
      }],
      validationEvents: [{
        id: "70000000-0000-4000-8000-000000000001",
        userId,
        cardId,
        artifactId,
        question: "Question?",
        questionType: "explain",
        userAnswer: "Answer",
        outcome: "preliminary_understanding",
        confidence: 80,
        jobId: "80000000-0000-4000-8000-000000000001",
      }],
      reviewSchedules: [{
        id: "90000000-0000-4000-8000-000000000001",
        userId,
        subjectType: "card",
        subjectId: cardId,
        validationEventId: null,
        status: "pending",
        nextReviewAt: "2026-07-18T00:00:00.000Z",
        intervalDays: 1,
      }],
      reviewAttempts: [{
        id: "a0000000-0000-4000-8000-000000000001",
        userId,
        reviewScheduleId: "90000000-0000-4000-8000-000000000001",
        subjectType: "card",
        subjectId: cardId,
        validationEventId: null,
        validationQuestionId: null,
        keyPointId: null,
        evidenceId: null,
        noteVersionId: null,
        answerType: "recall",
        answerText: "recalled answer",
        outcome: "correct",
        confidence: 90,
        skipReason: null,
        scheduleBeforeIntervalDays: 1,
        scheduleAfterIntervalDays: 3,
        scheduleReasonCode: "correct_advance",
        understandingEffect: "upgrade",
        nextReviewAt: "2026-07-21T00:00:00.000Z",
        idempotencyKey: "attempt-1",
        status: "completed",
        startedAt: "2026-07-18T00:00:00.000Z",
        completedAt: "2026-07-18T00:01:00.000Z",
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:01:00.000Z",
      }],
      onboardingStates: [{
        id: "b0000000-0000-4000-8000-000000000001",
        userId,
        version: "v1",
        steps: { createFirstCard: true, completeFirstReview: false },
        status: "in_progress",
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:05:00.000Z",
      }],
    },
    false,
    createRecordingDatabase(operations),
  );

  assert.equal(result.success, true);

  const noteInsertIndex = operations.findIndex(
    (operation) => operation.kind === "insert" && operation.table === notes,
  );
  const versionInsertIndex = operations.findIndex(
    (operation) => operation.kind === "insert" && operation.table === noteVersions,
  );
  const noteUpdateIndex = operations.findIndex(
    (operation) => operation.kind === "update" && operation.table === notes,
  );
  const artifactInsertIndex = operations.findIndex(
    (operation) => operation.kind === "insert" && operation.table === aiArtifacts,
  );
  const cardInsertIndex = operations.findIndex(
    (operation) => operation.kind === "insert" && operation.table === learningCards,
  );
  const validationInsertIndex = operations.findIndex(
    (operation) => operation.kind === "insert" && operation.table === validationEvents,
  );

  assert.ok(noteInsertIndex >= 0);
  assert.equal(operations[noteInsertIndex].values.currentVersionId, null);
  assert.ok(versionInsertIndex > noteInsertIndex);
  assert.ok(noteUpdateIndex > versionInsertIndex);
  assert.equal(operations[noteUpdateIndex].values.currentVersionId, versionId);

  assert.ok(artifactInsertIndex >= 0);
  assert.ok(cardInsertIndex > artifactInsertIndex);
  assert.ok(validationInsertIndex > artifactInsertIndex);
  assert.equal(operations[validationInsertIndex].values.jobId, null);

  // LOOP-01/02: review_attempts must be inserted after review_schedules (FK).
  const scheduleInsertIndex = operations.findIndex(
    (operation) => operation.kind === "insert" && operation.table === reviewSchedules,
  );
  const attemptInsertIndex = operations.findIndex(
    (operation) => operation.kind === "insert" && operation.table === reviewAttempts,
  );
  assert.ok(scheduleInsertIndex >= 0, "review_schedules should be inserted");
  assert.ok(attemptInsertIndex >= 0, "review_attempts should be inserted");
  assert.ok(
    attemptInsertIndex > scheduleInsertIndex,
    "review_attempts must be inserted after review_schedules (FK ordering)",
  );
  assert.equal(operations[attemptInsertIndex].values.answerText, "recalled answer");
  assert.equal(operations[attemptInsertIndex].values.status, "completed");

  // SEC-02/ALPHA-01: onboarding_states should be inserted and preserve
  // the steps payload. The restore service creates an auto onboarding_state
  // (status "pending") when restoring users, then inserts the exported
  // onboarding_states. We must find the one from the export data.
  const onboardingInsertIndex = operations.findIndex(
    (operation) =>
      operation.kind === "insert" &&
      operation.table === onboardingStates &&
      operation.values.status === "in_progress",
  );
  assert.ok(onboardingInsertIndex >= 0, "onboarding_states from export data should be inserted");
  assert.equal(operations[onboardingInsertIndex].values.status, "in_progress");
  assert.deepEqual(operations[onboardingInsertIndex].values.steps, {
    createFirstCard: true,
    completeFirstReview: false,
  });
});
