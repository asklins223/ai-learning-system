import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreWorkspace } from "../modules/export/service.ts";
import { notes, noteVersions } from "../db/schema/note.ts";
import { learningCards } from "../db/schema/card.ts";
import { validationEvents } from "../db/schema/evidence.ts";
import { aiArtifacts } from "../db/schema/ai.ts";

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
          return {
            async onConflictDoNothing() {},
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
});
