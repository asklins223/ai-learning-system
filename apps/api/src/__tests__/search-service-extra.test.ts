import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  detectSearchDrift,
  reindexWorkspaceSearch,
  search,
} from "../modules/search/service.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

describe("search service", () => {
  it("maps, highlights, links, and paginates deduplicated search rows", async () => {
    const calls: unknown[] = [];
    const executor = {
      execute: async (statement: unknown) => {
        calls.push(statement);
        if (calls.length === 1) {
          return [
            {
              object_type: "note",
              object_id: "note-1",
              title: "A note",
              body: `${"x".repeat(55)}Needle${"y".repeat(55)}`,
              indexed_at: new Date("2026-07-20T01:02:03.000Z"),
              metadata: null,
              match_count: "1",
            },
            {
              object_type: "card",
              object_id: "card-1",
              title: "A card",
              body: "Needle card body",
              indexed_at: "2026-07-20T01:02:02.000Z",
              metadata: null,
              match_count: "0",
            },
            {
              object_type: "card_set",
              object_id: "set-1",
              title: "A card set",
              body: "Needle set body",
              indexed_at: "2026-07-20T01:02:01.500Z",
              metadata: { cardSetId: "set-1" },
              match_count: "1",
            },
            {
              object_type: "source",
              object_id: "source-1",
              title: "A source",
              body: null,
              indexed_at: "2026-07-20T01:02:01.000Z",
              metadata: null,
              match_count: "1",
            },
            {
              object_type: "evidence",
              object_id: "evidence-1",
              title: null,
              body: "no matching text",
              indexed_at: "2026-07-20T01:02:00.000Z",
              metadata: { cardId: "card-2" },
              match_count: "3",
            },
            {
              object_type: "other",
              object_id: "other-1",
              title: null,
              body: "Needle",
              indexed_at: "2026-07-20T01:01:59.000Z",
              metadata: null,
              match_count: "not-a-number",
            },
          ];
        }
        return [{ count: "9" }];
      },
    } as any;

    const result = await search(executor, WORKSPACE_ID, "Needle", {
      type: "note",
      limit: 999,
      offset: -7,
    });

    assert.equal(calls.length, 2);
    const compiledSql = calls
      .map((statement) => new PgDialect().sqlToQuery(statement as SQL).sql)
      .join("\n");
    assert.match(compiledSql, /FROM search_documents AS search_document/);
    assert.match(compiledSql, /search_document\.object_type = 'card_set'/);
    assert.match(compiledSql, /consumer_card\.card_set_id IS NULL/);
    assert.match(compiledSql, /parent_set\.status = 'active'/);
    assert.match(compiledSql, /FROM evidences AS consumer_evidence/);
    assert.equal(result.total, 9);
    assert.equal(result.nextOffset, 6);
    assert.deepEqual(result.items.map((item) => item.href), [
      "/notes/note-1",
      "/cards/card-1",
      "/card-sets/set-1",
      "/sources/source-1",
      "/cards/card-2",
      "",
    ]);
    assert.match(result.items[0]!.snippet, /^…/);
    assert.match(result.items[0]!.snippet, /«Needle»/);
    assert.match(result.items[0]!.snippet, /…$/);
    assert.equal(result.items[0]!.indexedAt, "2026-07-20T01:02:03.000Z");
    assert.equal(result.items[1]!.matchCount, 1);
    assert.equal(result.items[4]!.matchCount, 3);
    assert.equal(result.items[5]!.matchCount, 1);
    assert.equal(result.items[2]!.cardSetId, "set-1");
  });

  it("returns no continuation when the final page exhausts the total", async () => {
    let call = 0;
    const executor = {
      execute: async () => (++call === 1 ? [] : [{ count: "4" }]),
    } as any;

    const result = await search(executor, WORKSPACE_ID, "%_\\", { offset: 4 });

    assert.deepEqual(result, { items: [], total: 4, nextOffset: null });
  });
});

describe("search projection rebuild", () => {
  it("hydrates all searchable entities and replaces the projection atomically", async () => {
    const insertedBatches: any[][] = [];
    let reconciled = 0;
    const executor = {
      query: {
        notes: {
          findMany: async () => [
            { id: "note-1", title: "One", currentVersionId: "version-1" },
            { id: "note-empty", title: "Empty", currentVersionId: null },
          ],
        },
        sources: {
          findMany: async () => [
            {
              id: "source-1",
              title: "Segmented",
              type: "text",
              origin: "origin ignored",
              metadata: null,
            },
            {
              id: "source-2",
              title: "Fallback",
              type: "url",
              origin: "origin body",
              metadata: { rawContent: "raw body", url: "https://example.test" },
            },
          ],
        },
        learningCardSets: {
          findMany: async () => [{
            id: "set-1",
            noteId: "note-1",
            noteVersionId: "version-1",
            title: "Set",
            summary: "Set summary",
          }],
        },
        learningCards: {
          findMany: async () => [
            {
              id: "card-1",
              noteVersionId: "version-1",
              cardSetId: "set-1",
              scope: "overview",
              ordinal: 0,
              schemaJson: { title: "Card", summary: "Summary" },
            },
          ],
        },
        noteBlocks: {
          findMany: async () => [
            { versionId: "version-1", content: "first" },
            { versionId: "version-1", content: "second" },
          ],
        },
        sourceSegments: {
          findMany: async () => [
            { sourceId: "source-1", text: "segment one" },
            { sourceId: "source-1", text: "segment two" },
          ],
        },
        cardKeyPoints: {
          findMany: async () => [
            { id: "key-point-1", cardId: "card-1", claim: "Claim" },
          ],
        },
        evidences: {
          findMany: async () => [
            {
              id: "evidence-1",
              keyPointId: "key-point-1",
              quoteText: "Quote",
              alignment: "aligned",
            },
          ],
        },
      },
      transaction: async (run: (tx: any) => Promise<void>) => run({
        delete: () => ({
          where: () => ({ returning: async () => [{ id: "old-1" }, { id: "old-2" }] }),
        }),
        insert: () => ({
          values: (values: any[]) => ({
            onConflictDoUpdate: async () => {
              insertedBatches.push(values);
            },
          }),
        }),
      }),
      // PERF-08：事务提交后的 ghost 清理通过外层 executor.execute 执行
      execute: async () => {
        reconciled += 1;
      },
    } as any;

    const result = await reindexWorkspaceSearch(executor, WORKSPACE_ID);

    assert.deepEqual(result, {
      deleted: 2,
      indexed: { note: 1, source: 2, cardSet: 1, card: 1, evidence: 1 },
      errors: 0,
    });
    assert.equal(reconciled, 1);
    assert.equal(insertedBatches.length, 1);
    const documents = insertedBatches.flat();
    assert.equal(documents.length, 6);
    assert.equal(documents.find((doc) => doc.objectId === "note-1")?.body, "first\nsecond");
    assert.equal(documents.find((doc) => doc.objectId === "source-1")?.body, "segment one\nsegment two");
    assert.equal(
      documents.find((doc) => doc.objectId === "source-2")?.body,
      "origin body\nraw body\nhttps://example.test",
    );
    assert.equal(documents.find((doc) => doc.objectId === "card-1")?.body, "Summary\nClaim");
    assert.deepEqual(documents.find((doc) => doc.objectId === "card-1")?.metadata, {
      noteVersionId: "version-1",
      cardSetId: "set-1",
      scope: "overview",
      ordinal: 0,
    });
    assert.equal(documents.find((doc) => doc.objectId === "set-1")?.objectType, "card_set");
    assert.deepEqual(documents.find((doc) => doc.objectId === "evidence-1")?.metadata, {
      keyPointId: "key-point-1",
      cardId: "card-1",
      cardSetId: "set-1",
      scope: "overview",
      ordinal: 0,
      alignment: "aligned",
    });
  });

  it("handles an empty workspace without child queries or inserts", async () => {
    let childQueries = 0;
    let inserts = 0;
    const executor = {
      query: {
        notes: { findMany: async () => [] },
        sources: { findMany: async () => [] },
        learningCardSets: { findMany: async () => [] },
        learningCards: { findMany: async () => [] },
        noteBlocks: { findMany: async () => { childQueries += 1; return []; } },
        sourceSegments: { findMany: async () => { childQueries += 1; return []; } },
        cardKeyPoints: { findMany: async () => { childQueries += 1; return []; } },
        evidences: { findMany: async () => { childQueries += 1; return []; } },
      },
      transaction: async (run: (tx: any) => Promise<void>) => run({
        delete: () => ({ where: () => ({ returning: async () => [] }) }),
        insert: () => { inserts += 1; return {}; },
      }),
      // PERF-08：事务提交后的 ghost 清理通过外层 executor.execute 执行
      execute: async () => undefined,
    } as any;

    const result = await reindexWorkspaceSearch(executor, WORKSPACE_ID);

    assert.deepEqual(result, {
      deleted: 0,
      indexed: { note: 0, source: 0, cardSet: 0, card: 0, evidence: 0 },
      errors: 0,
    });
    assert.equal(childQueries, 0);
    assert.equal(inserts, 0);
  });

  it("reports rollback semantics when replacement fails", async () => {
    const executor = {
      query: {
        notes: { findMany: async () => [] },
        sources: { findMany: async () => [] },
        learningCardSets: { findMany: async () => [] },
        learningCards: { findMany: async () => [] },
        noteBlocks: { findMany: async () => [] },
        sourceSegments: { findMany: async () => [] },
        cardKeyPoints: { findMany: async () => [] },
        evidences: { findMany: async () => [] },
      },
      transaction: async () => {
        throw new Error("database unavailable");
      },
    } as any;

    const result = await reindexWorkspaceSearch(executor, WORKSPACE_ID);

    assert.deepEqual(result, {
      deleted: 0,
      indexed: { note: 0, source: 0, cardSet: 0, card: 0, evidence: 0 },
      errors: 1,
    });
  });
});

describe("search projection drift", () => {
  it("finds ghosts, missing rows, stale titles, and stale note bodies", async () => {
    let indexedQuery = 0;
    const executor = {
      query: {
        notes: {
          findMany: async () => [
            { id: "note-stale", title: "Current note", currentVersionId: "version-stale" },
            { id: "note-missing", title: "Missing note", currentVersionId: "version-missing" },
            { id: "note-unpublished", title: "Draft", currentVersionId: null },
          ],
        },
        sources: {
          findMany: async () => [
            { id: "source-stale", title: "Current source" },
            { id: "source-missing", title: "Missing source" },
          ],
        },
        learningCardSets: {
          findMany: async () => [
            { id: "set-stale", title: "Current set" },
            { id: "set-missing", title: "Missing set" },
          ],
        },
        learningCards: {
          findMany: async () => [
            { id: "card-stale", schemaJson: { title: "Current card" } },
            { id: "card-missing", schemaJson: {} },
          ],
        },
        cardKeyPoints: {
          findMany: async () => [{ id: "key-point-1" }],
        },
        evidences: {
          findMany: async () => [{ id: "evidence-present" }, { id: "evidence-missing" }],
        },
        noteBlocks: {
          findMany: async () => [
            { versionId: "version-stale", content: "current body" },
            { versionId: "version-missing", content: "not indexed" },
          ],
        },
        searchDocuments: {
          findMany: async () => {
            indexedQuery += 1;
            switch (indexedQuery) {
              case 1:
                return [
                  { objectId: "note-stale", title: "Old note", body: "old body" },
                  { objectId: "note-ghost", title: "Ghost", body: "ghost" },
                ];
              case 2:
                return [
                  { objectId: "source-stale", title: "Old source" },
                  { objectId: "source-ghost", title: "Ghost source" },
                ];
              case 3:
                return [
                  { objectId: "set-stale", title: "Old set" },
                  { objectId: "set-ghost", title: "Ghost set" },
                ];
              case 4:
                return [
                  { objectId: "card-stale", title: "Old card" },
                  { objectId: "card-ghost", title: "Ghost card" },
                ];
              default:
                return [
                  { objectId: "evidence-present" },
                  { objectId: "evidence-ghost" },
                ];
            }
          },
        },
      },
    } as any;

    const result = await detectSearchDrift(executor, WORKSPACE_ID);

    assert.deepEqual(result.expected, {
      note: 2,
      source: 2,
      cardSet: 2,
      card: 2,
      evidence: 2,
    });
    assert.deepEqual(result.actual, {
      note: 2,
      source: 2,
      cardSet: 2,
      card: 2,
      evidence: 2,
    });
    assert.deepEqual(result.ghosts, [
      { objectType: "note", objectId: "note-ghost" },
      { objectType: "source", objectId: "source-ghost" },
      { objectType: "card_set", objectId: "set-ghost" },
      { objectType: "card", objectId: "card-ghost" },
      { objectType: "evidence", objectId: "evidence-ghost" },
    ]);
    assert.deepEqual(result.missing, [
      { objectType: "note", objectId: "note-missing" },
      { objectType: "source", objectId: "source-missing" },
      { objectType: "card_set", objectId: "set-missing" },
      { objectType: "card", objectId: "card-missing" },
      { objectType: "evidence", objectId: "evidence-missing" },
    ]);
    assert.deepEqual(result.staleTitles, [
      {
        objectType: "note",
        objectId: "note-stale",
        indexedTitle: "Old note",
        actualTitle: "Current note",
      },
      {
        objectType: "source",
        objectId: "source-stale",
        indexedTitle: "Old source",
        actualTitle: "Current source",
      },
      {
        objectType: "card_set",
        objectId: "set-stale",
        indexedTitle: "Old set",
        actualTitle: "Current set",
      },
      {
        objectType: "card",
        objectId: "card-stale",
        indexedTitle: "Old card",
        actualTitle: "Current card",
      },
    ]);
    assert.deepEqual(result.staleBodies, [{ objectType: "note", objectId: "note-stale" }]);
    assert.equal(result.hasDrift, true);
  });

  it("returns a clean result and skips evidence/block hydration for empty domains", async () => {
    let forbiddenQueries = 0;
    let indexedQuery = 0;
    const executor = {
      query: {
        notes: { findMany: async () => [] },
        sources: { findMany: async () => [] },
        learningCardSets: { findMany: async () => [] },
        learningCards: { findMany: async () => [] },
        cardKeyPoints: { findMany: async () => { forbiddenQueries += 1; return []; } },
        evidences: { findMany: async () => { forbiddenQueries += 1; return []; } },
        noteBlocks: { findMany: async () => { forbiddenQueries += 1; return []; } },
        searchDocuments: {
          findMany: async () => {
            indexedQuery += 1;
            return [];
          },
        },
      },
    } as any;

    const result = await detectSearchDrift(executor, WORKSPACE_ID);

    assert.equal(indexedQuery, 5);
    assert.equal(forbiddenQueries, 0);
    assert.deepEqual(result, {
      expected: { note: 0, source: 0, cardSet: 0, card: 0, evidence: 0 },
      actual: { note: 0, source: 0, cardSet: 0, card: 0, evidence: 0 },
      ghosts: [],
      missing: [],
      staleTitles: [],
      staleBodies: [],
      hasDrift: false,
    });
  });
});
