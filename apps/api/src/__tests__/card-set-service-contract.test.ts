import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, describe, it } from "node:test";
import { ArtifactStatus } from "@ailearn/shared";
import { db } from "../db/client.ts";
import { aiArtifacts } from "../db/schema/ai.ts";
import {
  learningCards,
  learningCardSets,
} from "../db/schema/card.ts";
import {
  acceptCardSet,
  CardSetServiceError,
  getCardSetWithDetail,
  listCardSetCards,
  listCardSets,
  regenerateCardSet,
} from "../modules/card-set/service.ts";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const SET_ID = "10000000-0000-4000-8000-000000000003";
const NOTE_VERSION_ID = "10000000-0000-4000-8000-000000000004";
const CARD_1_ID = "10000000-0000-4000-8000-000000000011";
const CARD_2_ID = "10000000-0000-4000-8000-000000000012";
const CARD_3_ID = "10000000-0000-4000-8000-000000000013";

const routesSource = readFileSync(
  new URL("../modules/card-set/routes.ts", import.meta.url),
  "utf8",
);
const serviceSource = readFileSync(
  new URL("../modules/card-set/service.ts", import.meta.url),
  "utf8",
);
const generationServiceSource = readFileSync(
  new URL("../modules/card-generation/service.ts", import.meta.url),
  "utf8",
);

const mutableDb = db as any;
const original = {
  select: mutableDb.select,
  transaction: mutableDb.transaction,
  cardSetsFindFirst: mutableDb.query.learningCardSets.findFirst,
  cardSetsFindMany: mutableDb.query.learningCardSets.findMany,
  cardsFindMany: mutableDb.query.learningCards.findMany,
  keyPointsFindMany: mutableDb.query.cardKeyPoints.findMany,
  notesFindFirst: mutableDb.query.notes.findFirst,
};

beforeEach(() => {
  mutableDb.select = original.select;
  mutableDb.query.learningCardSets.findFirst = original.cardSetsFindFirst;
  mutableDb.query.learningCardSets.findMany = original.cardSetsFindMany;
  mutableDb.query.learningCards.findMany = original.cardsFindMany;
  mutableDb.query.cardKeyPoints.findMany = original.keyPointsFindMany;
  mutableDb.query.notes.findFirst = original.notesFindFirst;
  mutableDb.transaction = async (callback: (tx: any) => Promise<unknown>) =>
    callback({
      query: mutableDb.query,
      select: (...args: unknown[]) => mutableDb.select(...args),
      execute: async () => [{
        workspace_id: WORKSPACE_ID,
        user_id: USER_ID,
      }],
    });
});

after(() => {
  mutableDb.select = original.select;
  mutableDb.transaction = original.transaction;
  mutableDb.query.learningCardSets.findFirst = original.cardSetsFindFirst;
  mutableDb.query.learningCardSets.findMany = original.cardSetsFindMany;
  mutableDb.query.learningCards.findMany = original.cardsFindMany;
  mutableDb.query.cardKeyPoints.findMany = original.keyPointsFindMany;
  mutableDb.query.notes.findFirst = original.notesFindFirst;
});

describe("Card Set list, detail, and cursor pagination", () => {
  it("returns detail cards with key points grouped under the correct card", async () => {
    mutableDb.query.learningCardSets.findFirst = async () => ({
      id: SET_ID,
      status: "active",
      title: "Distributed systems",
    });
    mutableDb.query.learningCards.findMany = async () => [
      { id: CARD_1_ID, cardSetId: SET_ID, ordinal: 0, scope: "overview" },
      { id: CARD_2_ID, cardSetId: SET_ID, ordinal: 1, scope: "section" },
    ];
    mutableDb.query.cardKeyPoints.findMany = async () => [
      { id: "kp-2", cardId: CARD_2_ID, ordinal: 0 },
      { id: "kp-1", cardId: CARD_1_ID, ordinal: 0 },
    ];

    const result = await getCardSetWithDetail(SET_ID, WORKSPACE_ID, USER_ID);

    assert.equal(result?.cardSet.id, SET_ID);
    assert.deepEqual(result?.cards, [
      {
        card: { id: CARD_1_ID, cardSetId: SET_ID, ordinal: 0, scope: "overview" },
        keyPoints: [{ id: "kp-1", cardId: CARD_1_ID, ordinal: 0 }],
      },
      {
        card: { id: CARD_2_ID, cardSetId: SET_ID, ordinal: 1, scope: "section" },
        keyPoints: [{ id: "kp-2", cardId: CARD_2_ID, ordinal: 0 }],
      },
    ]);

    mutableDb.query.learningCardSets.findFirst = async () => undefined;
    assert.equal(
      await getCardSetWithDetail(SET_ID, WORKSPACE_ID, USER_ID),
      null,
    );
  });

  it("paginates GET /:id/cards by ordinal and id without returning the lookahead row", async () => {
    mutableDb.query.learningCardSets.findFirst = async () => ({ id: SET_ID });
    mutableDb.query.learningCards.findMany = async () => [
      { id: CARD_1_ID, cardSetId: SET_ID, ordinal: 0, scope: "overview" },
      { id: CARD_2_ID, cardSetId: SET_ID, ordinal: 1, scope: "section" },
      { id: CARD_3_ID, cardSetId: SET_ID, ordinal: 2, scope: "section" },
    ];
    mutableDb.query.cardKeyPoints.findMany = async () => [
      { id: "kp-1", cardId: CARD_1_ID, ordinal: 0 },
      { id: "kp-2", cardId: CARD_2_ID, ordinal: 0 },
    ];

    const result = await listCardSetCards(
      SET_ID,
      WORKSPACE_ID,
      USER_ID,
      { limit: 2 },
    );

    assert.equal(result?.cardSetId, SET_ID);
    assert.deepEqual(result?.items.map((item) => item.card.id), [
      CARD_1_ID,
      CARD_2_ID,
    ]);
    assert.equal(result?.items[0]?.keyPoints[0]?.id, "kp-1");
    assert.ok(result?.nextCursor);
    assert.equal(
      Buffer.from(result!.nextCursor!, "base64").toString("utf8"),
      `1:${CARD_2_ID}`,
    );

    await assert.rejects(
      listCardSetCards(
        SET_ID,
        WORKSPACE_ID,
        USER_ID,
        { cursor: "not-a-cursor" },
      ),
      (error: unknown) =>
        error instanceof CardSetServiceError
        && error.code === "invalid_cursor"
        && error.statusCode === 400,
    );
  });

  it("returns list item counts, overview pointer, total, and next cursor", async () => {
    const rows = [
      {
        id: SET_ID,
        status: "active",
        createdAt: new Date("2026-07-26T10:00:00.000Z"),
        cursorTimestamp: "2026-07-26T10:00:00.000000Z",
      },
      {
        id: "10000000-0000-4000-8000-000000000099",
        status: "superseded",
        createdAt: new Date("2026-07-25T10:00:00.000Z"),
        cursorTimestamp: "2026-07-25T10:00:00.000000Z",
      },
    ];
    mutableDb.query.learningCardSets.findMany = async () => rows;
    mutableDb.query.learningCards.findMany = async () => [
      { id: CARD_1_ID, cardSetId: SET_ID, ordinal: 0, scope: "overview", status: "active" },
      { id: CARD_2_ID, cardSetId: SET_ID, ordinal: 1, scope: "section", status: "active" },
    ];
    mutableDb.select = () => ({
      from: (table: unknown) => {
        assert.equal(table, learningCardSets);
        return { where: async () => [{ total: 7 }] };
      },
    });

    const result = await listCardSets(WORKSPACE_ID, USER_ID, { limit: 1 });

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.id, SET_ID);
    assert.equal(result.items[0]?.cardCount, 2);
    assert.equal(result.items[0]?.sectionCardCount, 1);
    assert.equal(result.items[0]?.overviewCardId, CARD_1_ID);
    assert.equal(result.total, 7);
    assert.ok(result.nextCursor);
  });
});

function installAcceptTransaction(input: {
  status: string;
  artifactIds?: Array<string | null>;
}): Array<{ table: unknown; values: unknown }> {
  const updates: Array<{ table: unknown; values: unknown }> = [];
  mutableDb.transaction = async (callback: (tx: any) => Promise<unknown>) =>
    callback({
      execute: async () => [{
        workspace_id: WORKSPACE_ID,
        user_id: USER_ID,
      }],
      select: () => ({
        from: (table: unknown) => {
          if (table === learningCardSets) {
            return {
              where: () => ({
                for: async () => [{ id: SET_ID, status: input.status }],
              }),
            };
          }
          if (table === learningCards) {
            return {
              where: async () => (input.artifactIds ?? []).map((artifactId) => ({
                artifactId,
              })),
            };
          }
          throw new Error("unexpected acceptCardSet table");
        },
      }),
      update: (table: unknown) => ({
        set: (values: unknown) => ({
          where: async () => {
            updates.push({ table, values });
          },
        }),
      }),
    });
  return updates;
}

describe("Card Set actions and result contracts", () => {
  it("rejects partial_ready acceptance and accepts every artifact of an active set", async () => {
    installAcceptTransaction({ status: "partial_ready" });
    await assert.rejects(
      acceptCardSet(SET_ID, WORKSPACE_ID, USER_ID),
      (error: unknown) =>
        error instanceof CardSetServiceError
        && error.code === "card_set_not_acceptable"
        && error.statusCode === 409,
    );

    const updates = installAcceptTransaction({
      status: "active",
      artifactIds: ["artifact-1", null, "artifact-2"],
    });
    const result = await acceptCardSet(SET_ID, WORKSPACE_ID, USER_ID);

    assert.deepEqual(result, {
      cardSetId: SET_ID,
      acceptedArtifactCount: 2,
    });
    assert.deepEqual(updates, [{
      table: aiArtifacts,
      values: { status: ArtifactStatus.ACCEPTED },
    }]);
  });

  it("regenerate returns runId, compatibility jobId, and sameVersion", async () => {
    mutableDb.query.learningCardSets.findFirst = async () => ({
      id: SET_ID,
      noteId: "note-1",
      noteVersionId: NOTE_VERSION_ID,
    });
    mutableDb.query.notes.findFirst = async () => ({
      id: "note-1",
      currentVersionId: NOTE_VERSION_ID,
    });
    const result = await regenerateCardSet(
      SET_ID,
      WORKSPACE_ID,
      USER_ID,
      {
        createRun: async (context, input) => {
          assert.deepEqual(context, {
            workspaceId: WORKSPACE_ID,
            userId: USER_ID,
          });
          assert.equal(input.noteVersionId, NOTE_VERSION_ID);
          assert.match(input.idempotencyKey, /^card-set-regenerate:/);
          return {
            runId: "run-1",
            status: "queued",
            sourceSnapshot: {
              noteVersionId: NOTE_VERSION_ID,
              versionNo: 1,
              contentHash: "sealed-hash",
            },
            canContinueEditing: true as const,
          };
        },
        getCompatibility: async () => ({
          state: "generating" as const,
          cardId: CARD_1_ID,
          jobId: "job-1",
          generatedVersionId: null,
          runId: "run-1",
        }),
      },
    );

    assert.deepEqual(result, {
      runId: "run-1",
      jobId: "job-1",
      sameVersion: true,
    });
  });

  it("exposes list/detail/cards and owner-gated accept, dismiss, regenerate routes", () => {
    for (const path of [
      '"/card-sets"',
      '"/card-sets/:id"',
      '"/card-sets/:id/cards"',
      '"/card-sets/:id/accept"',
      '"/card-sets/:id/dismiss"',
      '"/card-sets/:id/regenerate"',
    ]) {
      assert.ok(routesSource.includes(path), `missing ${path}`);
    }
    assert.match(
      routesSource,
      /"\/card-sets\/:id\/cards"[\s\S]*?listCardSetCards/,
    );
    for (const action of ["accept", "dismiss", "regenerate"]) {
      const routeStart = routesSource.indexOf(`"/card-sets/:id/${action}"`);
      assert.ok(routeStart >= 0);
      assert.ok(
        routesSource
          .slice(routeStart, routeStart + 160)
          .includes("{ preHandler: [requireOwner] }"),
        `${action} must require the workspace owner`,
      );
    }
    assert.match(routesSource, /cursor: z\.string\(\)\.max\(200\)\.optional\(\)/);
    assert.match(
      routesSource,
      /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.optional\(\)/,
    );
  });

  it("dismiss supersedes all three review target forms and removes set/card/evidence search rows", () => {
    const dismissStart = serviceSource.indexOf("export async function dismissCardSet");
    const regenerateStart = serviceSource.indexOf(
      "type RegenerateCardSetDependencies",
      dismissStart,
    );
    assert.ok(dismissStart >= 0 && regenerateStart > dismissStart);
    const dismiss = serviceSource.slice(dismissStart, regenerateStart);

    assert.match(
      dismiss,
      /eq\(reviewSchedules\.subjectType, "card"\)[\s\S]*?inArray\(reviewSchedules\.subjectId, cardIds\)/,
    );
    assert.match(
      dismiss,
      /inArray\(reviewSchedules\.keyPointId, keyPointIds\)/,
    );
    assert.match(
      dismiss,
      /inArray\([\s\S]*?reviewSchedules\.validationEventId,[\s\S]*?validationEventIds[\s\S]*?eq\(reviewSchedules\.subjectType, "validation"\)[\s\S]*?inArray\(reviewSchedules\.subjectId, validationEventIds\)/,
    );
    assert.equal(
      (dismiss.match(/set\(\{ status: ReviewStatus\.SUPERSEDED/g) ?? []).length,
      3,
    );
    assert.match(dismiss, /\.delete\(searchDocuments\)/);
    for (const objectType of ["card_set", "card", "evidence"]) {
      assert.match(
        dismiss,
        new RegExp(`eq\\(searchDocuments\\.objectType, "${objectType}"\\)`),
      );
    }
    assert.match(
      dismiss,
      /return \{ cardSetId: cardSet\.id, status: "archived" as const \}/,
    );
  });

  it("generation result preserves both overview-card and card-set pointers", () => {
    assert.match(
      generationServiceSource,
      /result: \{ cardId: string \| null; cardSetId: string \| null \} \| null/,
    );
    assert.match(
      generationServiceSource,
      /\? \{ cardId: run\.resultCardId, cardSetId: run\.resultCardSetId \}/,
    );
  });
});
