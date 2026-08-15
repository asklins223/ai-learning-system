import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreWorkspace } from "../modules/export/service.ts";
import { notes, noteVersions } from "../db/schema/note.ts";
import { learningCards } from "../db/schema/card.ts";
import { validationEvents, reviewSchedules, reviewAttempts } from "../db/schema/evidence.ts";
import { aiArtifacts } from "../db/schema/ai.ts";
import { onboardingStates } from "../db/schema/identity.ts";
import {
  validationQuestionRubricItems,
  validationSubmissions,
  validationSubmissionJobs,
  validationActionCommands,
  validationAssistanceExposures,
  validationPointAssessments,
  schedulingShadowDecisions,
  validationQualitySignals,
} from "../db/schema/validation-v2.ts";

type RestoreDatabase = NonNullable<Parameters<typeof restoreWorkspace>[3]>;
type Operation = {
  kind: "insert" | "update";
  table: unknown;
  /** batchInsert 传入数组；单元素批次在 createRecordingDatabase 中解包为行。 */
  values: Record<string, unknown>;
};

function createRecordingDatabase(operations: Operation[]): RestoreDatabase {
  const tx = {
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown> | Record<string, unknown>[]) {
          // PERF-40 后 restoreTable 走 batchInsert，values 为数组；单元素批次
          // 解包为单行，保持断言按行字段访问的既有语义。
          const recorded = Array.isArray(values) && values.length === 1
            ? values[0]
            : values;
          operations.push({
            kind: "insert" as const,
            table,
            values: recorded as Record<string, unknown>,
          });
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

// N#8-2: restoreSchema 补报 8 张 v0.6 表后，含 v0.6 数据的 manifest 恢复应逐表恢复行。
// 用 recording 数据库验证 restoreTable 对每张 v0.6 表实际执行了对应行数的 insert。
test("N#8-2: restore 含 v0.6 数据的 manifest 恢复 8 张 v0.6 表行数", async () => {
  const operations: Operation[] = [];
  const workspaceId = "10000000-0000-4000-8000-00000000000f";
  const userId = "20000000-0000-4000-8000-00000000000f";
  const questionId = "c0000000-0000-4000-8000-000000000001";
  const cardId = "60000000-0000-4000-8000-00000000000f";
  const submissionIdA = "d0000000-0000-4000-8000-000000000001";
  const submissionIdB = "d0000000-0000-4000-8000-000000000002";
  const rubricIdA = "e0000000-0000-4000-8000-000000000001";
  const rubricIdB = "e0000000-0000-4000-8000-000000000002";
  const validationEventId = "a0000000-0000-4000-8000-00000000000e";

  const result = await restoreWorkspace(
    workspaceId,
    {
      workspace: { id: "source-workspace" },
      exportManifest: {
        version: "2.0",
        included: [
          "workspace",
          "validationQuestionRubricItems",
          "validationSubmissions",
          "validationSubmissionJobs",
          "validationActionCommands",
          "validationAssistanceExposures",
          "validationPointAssessments",
          "schedulingShadowDecisions",
          "validationQualitySignals",
        ],
      },
      validationQuestionRubricItems: [{
        id: rubricIdA, questionId, ordinal: 1, criterion: "c1",
        expectedConcept: "ec1", weight: 1, required: true,
      }, {
        id: rubricIdB, questionId, ordinal: 2, criterion: "c2",
        expectedConcept: "ec2", weight: 1, required: false,
      }],
      validationSubmissions: [{
        id: submissionIdA, userId, cardId, keyPointId: null, questionId,
        context: "ctx", reviewAttemptId: null, inputScheduleId: null,
        status: "submitted", startIdempotencyKey: "start-1",
      }, {
        id: submissionIdB, userId, cardId, keyPointId: null, questionId,
        context: "ctx2", reviewAttemptId: null, inputScheduleId: null,
        status: "submitted", startIdempotencyKey: "start-2",
      }],
      validationSubmissionJobs: [{
        id: "f1000000-0000-4000-8000-000000000001", submissionId: submissionIdA,
        phase: "generate", phaseOrdinal: 1, jobId: "f2000000-0000-4000-8000-000000000001",
      }],
      validationActionCommands: [{
        id: "f3000000-0000-4000-8000-000000000001", userId,
        submissionId: submissionIdA, action: "start", idempotencyKey: "cmd-1",
        requestHash: "hash-1", responseStatus: "applied",
      }],
      validationAssistanceExposures: [{
        id: "f4000000-0000-4000-8000-000000000001", userId,
        keyPointId: null, exposureFingerprint: "fp-1",
        lastExposureKind: "unassisted",
      }],
      validationPointAssessments: [{
        id: "f5000000-0000-4000-8000-000000000001", userId,
        submissionId: submissionIdA, rubricItemId: rubricIdA,
        verdict: "correct", assessmentSource: "ai",
      }, {
        id: "f5000000-0000-4000-8000-000000000002", userId,
        submissionId: submissionIdA, rubricItemId: rubricIdB,
        verdict: "correct", assessmentSource: "ai",
      }],
      schedulingShadowDecisions: [{
        id: "f6000000-0000-4000-8000-000000000001", userId,
        keyPointId: null, sourceType: "review", sourceId: cardId,
        algorithm: "sm2", algorithmVersion: "1", parametersVersion: "1",
      }],
      validationQualitySignals: [{
        id: "f7000000-0000-4000-8000-000000000001", userId,
        validationEventId, submissionId: submissionIdA,
        reason: "system",
      }],
    },
    false,
    createRecordingDatabase(operations),
  );

  assert.equal(result.success, true);

  const countInsertedFor = (table: unknown): number =>
    operations
      .filter((o) => o.kind === "insert" && o.table === table)
      .reduce((sum, o) => {
        // batchInsert 按 500 分批，values 可能是数组（多行一批）或单对象
        // （recording DB 对单元素批次解包为行对象）；按行计数。
        return sum + (Array.isArray(o.values) ? o.values.length : 1);
      }, 0);

  assert.equal(
    countInsertedFor(validationQuestionRubricItems),
    2,
    "restore should insert 2 validation_question_rubric_items",
  );
  assert.equal(
    countInsertedFor(validationSubmissions),
    2,
    "restore should insert 2 validation_submissions",
  );
  assert.equal(
    countInsertedFor(validationSubmissionJobs),
    1,
    "restore should insert 1 validation_submission_job",
  );
  assert.equal(
    countInsertedFor(validationActionCommands),
    1,
    "restore should insert 1 validation_action_command",
  );
  assert.equal(
    countInsertedFor(validationAssistanceExposures),
    1,
    "restore should insert 1 validation_assistance_exposure",
  );
  assert.equal(
    countInsertedFor(validationPointAssessments),
    2,
    "restore should insert 2 validation_point_assessments",
  );
  assert.equal(
    countInsertedFor(schedulingShadowDecisions),
    1,
    "restore should insert 1 scheduling_shadow_decision",
  );
  assert.equal(
    countInsertedFor(validationQualitySignals),
    1,
    "restore should insert 1 validation_quality_signal",
  );

  // results.counts 也应反映各表恢复行数
  assert.equal(result.counts?.validationQuestionRubricItems, 2);
  assert.equal(result.counts?.validationSubmissions, 2);
  assert.equal(result.counts?.validationSubmissionJobs, 1);
  assert.equal(result.counts?.validationActionCommands, 1);
  assert.equal(result.counts?.validationAssistanceExposures, 1);
  assert.equal(result.counts?.validationPointAssessments, 2);
  assert.equal(result.counts?.schedulingShadowDecisions, 1);
  assert.equal(result.counts?.validationQualitySignals, 1);
});
