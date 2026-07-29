import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ArtifactStatus, CardStatus, ReviewStatus } from "@ailearn/shared";
import { db } from "../db/client.ts";
import { aiArtifacts } from "../db/schema/ai.ts";
import { learningCards } from "../db/schema/card.ts";
import { evidences, reviewSchedules, validationEvents } from "../db/schema/evidence.ts";
import { searchDocuments } from "../db/schema/search.ts";
import { encodeCursor } from "../lib/pagination.ts";
import {
  acceptCard,
  dismissCard,
  getCardWithDetail,
  listCards,
  regenerateCard,
} from "../modules/card/service.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const mutableDb = db as any;
const original = {
  select: mutableDb.select,
  transaction: mutableDb.transaction,
  learningCardsFindFirst: mutableDb.query.learningCards.findFirst,
  learningCardsFindMany: mutableDb.query.learningCards.findMany,
  cardKeyPointsFindMany: mutableDb.query.cardKeyPoints.findMany,
  noteVersionsFindFirst: mutableDb.query.noteVersions.findFirst,
  notesFindFirst: mutableDb.query.notes.findFirst,
  evidenceOverridesFindMany: mutableDb.query.evidenceOverrides.findMany,
};

after(() => {
  mutableDb.select = original.select;
  mutableDb.transaction = original.transaction;
  mutableDb.query.learningCards.findFirst = original.learningCardsFindFirst;
  mutableDb.query.learningCards.findMany = original.learningCardsFindMany;
  mutableDb.query.cardKeyPoints.findMany = original.cardKeyPointsFindMany;
  mutableDb.query.noteVersions.findFirst = original.noteVersionsFindFirst;
  mutableDb.query.notes.findFirst = original.notesFindFirst;
  mutableDb.query.evidenceOverrides.findMany = original.evidenceOverridesFindMany;
});

describe("card detail and listing", () => {
  it("returns a card with ordered key points or null when missing", async () => {
    mutableDb.query.learningCards.findFirst = async () => ({ id: "card-1", schemaJson: { title: "Card" } });
    mutableDb.query.cardKeyPoints.findMany = async () => [{ id: "kp-1", ordinal: 0 }];
    assert.deepEqual(await getCardWithDetail("card-1", WORKSPACE_ID), {
      card: { id: "card-1", schemaJson: { title: "Card" } },
      keyPoints: [{ id: "kp-1", ordinal: 0 }],
    });

    mutableDb.query.learningCards.findFirst = async () => undefined;
    assert.equal(await getCardWithDetail("missing", WORKSPACE_ID), null);
  });

  it("paginates cards and aggregates user-scoped evidence, validation, and review state", async () => {
    const rows = [
      { id: "00000000-0000-4000-8000-000000000010", schemaJson: { title: "One" }, cursorTimestamp: "2026-07-20T00:00:02.123456Z" },
      { id: "00000000-0000-4000-8000-000000000009", schemaJson: { title: "Two" }, cursorTimestamp: "2026-07-20T00:00:01.123456Z" },
      { id: "00000000-0000-4000-8000-000000000008", schemaJson: { title: "Three" }, cursorTimestamp: "2026-07-20T00:00:00.123456Z" },
    ];
    mutableDb.query.learningCards.findMany = async () => rows;
    mutableDb.query.evidenceOverrides.findMany = async () => [
      { evidenceId: "ev-hard", override: "confirmed" },
      { evidenceId: "ev-soft", override: "downgraded" },
      { evidenceId: "ev-rejected", override: "rejected" },
    ];
    mutableDb.select = () => ({
      from: (table: unknown) => {
        if (table === learningCards) return { where: async () => [{ count: 9 }] };
        if (table === evidences) {
          return {
            innerJoin: () => ({
              where: async () => [
                { id: "ev-hard", cardId: rows[0]!.id, alignment: "soft", userOverride: null },
                { id: "ev-soft", cardId: rows[0]!.id, alignment: "aligned", userOverride: null },
                { id: "ev-rejected", cardId: rows[0]!.id, alignment: "aligned", userOverride: null },
                { id: "ev-native", cardId: rows[1]!.id, alignment: "aligned", userOverride: null },
              ],
            }),
          };
        }
        if (table === validationEvents) {
          return {
            where: () => ({
              groupBy: async () => [{ cardId: rows[0]!.id, count: "4" }],
            }),
          };
        }
        if (table === reviewSchedules) {
          return {
            innerJoin: () => ({
              where: () => ({
                orderBy: async () => [
                  { cardId: rows[0]!.id, reviewStatus: ReviewStatus.PENDING, nextReviewAt: new Date("2026-07-21T00:00:00Z") },
                  { cardId: rows[0]!.id, reviewStatus: ReviewStatus.PENDING, nextReviewAt: new Date("2026-07-22T00:00:00Z") },
                ],
              }),
            }),
          };
        }
        throw new Error("unexpected listCards table");
      },
    });

    const result = await listCards(WORKSPACE_ID, {
      cursor: encodeCursor("2026-07-21T00:00:00.000001Z", "00000000-0000-4000-8000-000000000011"),
      limit: 2,
    }, USER_ID);

    assert.equal(result.items.length, 2);
    assert.equal(result.items[0]!.evidenceHardCount, 1);
    assert.equal(result.items[0]!.evidenceSoftCount, 1);
    assert.equal(result.items[0]!.evidenceTotalCount, 2);
    assert.equal(result.items[0]!.validationCount, 4);
    assert.equal(result.items[0]!.reviewStatus, ReviewStatus.PENDING);
    assert.equal(result.items[1]!.evidenceHardCount, 1);
    assert.equal(result.total, 9);
    assert.ok(result.nextCursor);
  });

  it("uses legacy overrides without a user and returns the final page", async () => {
    const row = {
      id: "00000000-0000-4000-8000-000000000010",
      schemaJson: { title: "Legacy" },
      cursorTimestamp: "2026-07-20T00:00:00.123456Z",
    };
    mutableDb.query.learningCards.findMany = async () => [row];
    mutableDb.select = () => ({
      from: (table: unknown) => {
        if (table === learningCards) return { where: async () => [{ count: 1 }] };
        if (table === evidences) {
          return {
            innerJoin: () => ({
              where: async () => [
                { id: "ev-soft", cardId: row.id, alignment: "aligned", userOverride: "downgraded" },
                { id: "ev-rejected", cardId: row.id, alignment: "aligned", userOverride: "rejected" },
              ],
            }),
          };
        }
        if (table === validationEvents) return { where: () => ({ groupBy: async () => [] }) };
        if (table === reviewSchedules) {
          return { innerJoin: () => ({ where: () => ({ orderBy: async () => [] }) }) };
        }
        throw new Error("unexpected listCards table");
      },
    });

    const result = await listCards(WORKSPACE_ID, { cursor: "invalid" });

    assert.equal(result.items[0]!.evidenceSoftCount, 1);
    assert.equal(result.items[0]!.evidenceTotalCount, 1);
    assert.equal(result.items[0]!.validationCount, 0);
    assert.equal(result.items[0]!.reviewStatus, null);
    assert.equal(result.nextCursor, null);
  });

  it("returns an empty page after the count and rejects lossy cursor rows", async () => {
    mutableDb.query.learningCards.findMany = async () => [];
    mutableDb.select = () => ({ from: () => ({ where: async () => [{ count: 0 }] }) });
    assert.deepEqual(await listCards(WORKSPACE_ID), { items: [], nextCursor: null, total: 0 });

    mutableDb.query.learningCards.findMany = async () => [{ id: "card-broken" }];
    await assert.rejects(listCards(WORKSPACE_ID, { limit: 1 }), /card cursor timestamp is missing/);
  });
});

function installRegenerationReads(config: {
  card?: any;
  version?: any;
  note?: any;
}): void {
  mutableDb.query.learningCards.findFirst = async () => config.card;
  mutableDb.query.noteVersions.findFirst = async () => config.version;
  mutableDb.query.notes.findFirst = async () => config.note;
}

function generationDependencies(jobId: string, runId: string) {
  return {
    createRun: async (
      context: { workspaceId: string; userId: string },
      input: { noteVersionId: string; idempotencyKey: string; oldCardId?: string },
    ) => {
      assert.deepEqual(context, { workspaceId: WORKSPACE_ID, userId: USER_ID });
      assert.equal(input.oldCardId, "card-1");
      assert.match(input.idempotencyKey, /^legacy-regenerate:/);
      return {
        runId,
        status: "queued",
        sourceSnapshot: {
          noteVersionId: input.noteVersionId,
          versionNo: 1,
          contentHash: "hash",
        },
        canContinueEditing: true as const,
      };
    },
    getCompatibility: async () => ({
      state: "generating" as const,
      cardId: "card-1",
      jobId,
      generatedVersionId: null,
      runId,
    }),
  };
}

describe("card regeneration", () => {
  it("returns null when card, version, or live note is missing", async () => {
    installRegenerationReads({});
    assert.equal(await regenerateCard("missing", WORKSPACE_ID, USER_ID), null);

    installRegenerationReads({ card: { id: "card-1", noteVersionId: "version-1" } });
    assert.equal(await regenerateCard("card-1", WORKSPACE_ID, USER_ID), null);

    installRegenerationReads({
      card: { id: "card-1", noteVersionId: "version-1" },
      version: { id: "version-1", noteId: "note-1" },
    });
    assert.equal(await regenerateCard("card-1", WORKSPACE_ID, USER_ID), null);
  });

  it("deduplicates regeneration on the same version", async () => {
    installRegenerationReads({
      card: { id: "card-1", noteVersionId: "version-1" },
      version: { id: "version-1", noteId: "note-1" },
      note: { id: "note-1", currentVersionId: null },
    });
    assert.deepEqual(await regenerateCard(
      "card-1",
      WORKSPACE_ID,
      USER_ID,
      generationDependencies("job-existing", "run-existing"),
    ), {
      jobId: "job-existing",
      runId: "run-existing",
      sameVersion: true,
    });
  });

  it("queues regeneration against the note's newer current version", async () => {
    installRegenerationReads({
      card: { id: "card-1", noteVersionId: "version-1" },
      version: { id: "version-1", noteId: "note-1" },
      note: { id: "note-1", currentVersionId: "version-2" },
    });
    assert.deepEqual(await regenerateCard(
      "card-1",
      WORKSPACE_ID,
      USER_ID,
      generationDependencies("job-new", "run-new"),
    ), {
      jobId: "job-new",
      runId: "run-new",
      sameVersion: false,
    });
  });
});

function writeTransaction(captured: Array<{ table: unknown; value: any }>): any {
  return async (run: (tx: any) => Promise<void>) => run({
    update: (table: unknown) => ({
      set: (value: any) => {
        captured.push({ table, value });
        return { where: async () => undefined };
      },
    }),
    select: () => ({ from: () => ({ where: () => [] }) }),
    delete: (table: unknown) => ({
      where: async () => { captured.push({ table, value: "deleted" }); },
    }),
  });
}

describe("card acceptance and dismissal", () => {
  it("returns null for missing cards", async () => {
    mutableDb.query.learningCards.findFirst = async () => undefined;
    assert.equal(await acceptCard("missing", WORKSPACE_ID), null);
    assert.equal(await dismissCard("missing", WORKSPACE_ID), null);
  });

  it("accepts the artifact and touches the card", async () => {
    const writes: Array<{ table: unknown; value: any }> = [];
    mutableDb.query.learningCards.findFirst = async () => ({ id: "card-1", artifactId: "artifact-1" });
    mutableDb.transaction = writeTransaction(writes);

    assert.deepEqual(await acceptCard("card-1", WORKSPACE_ID), { ok: true });
    assert.deepEqual(writes.map((write) => [write.table, write.value.status]), [
      [aiArtifacts, ArtifactStatus.ACCEPTED],
      [learningCards, undefined],
    ]);
  });

  it("accepts a card without an artifact", async () => {
    const writes: Array<{ table: unknown; value: any }> = [];
    mutableDb.query.learningCards.findFirst = async () => ({ id: "card-1", artifactId: null });
    mutableDb.transaction = writeTransaction(writes);

    assert.deepEqual(await acceptCard("card-1", WORKSPACE_ID), { ok: true });
    assert.deepEqual(writes.map((write) => write.table), [learningCards]);
  });

  it("dismisses artifact/card/reviews and removes card/evidence projections", async () => {
    const writes: Array<{ table: unknown; value: any }> = [];
    mutableDb.query.learningCards.findFirst = async () => ({ id: "card-1", artifactId: "artifact-1" });
    mutableDb.transaction = writeTransaction(writes);

    assert.deepEqual(await dismissCard("card-1", WORKSPACE_ID), { ok: true });
    assert.deepEqual(writes.map((write) => write.table), [
      aiArtifacts,
      learningCards,
      reviewSchedules,
      searchDocuments,
    ]);
    assert.equal(writes[0]!.value.status, ArtifactStatus.DISMISSED);
    assert.equal(writes[1]!.value.status, CardStatus.ARCHIVED);
    assert.equal(writes[2]!.value.status, ReviewStatus.CANCELLED);
  });
});
