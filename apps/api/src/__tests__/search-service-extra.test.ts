import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  detectSearchDrift,
  reindexWorkspaceSearch,
  search,
} from "../modules/search/service.ts";
import { notes } from "../db/schema/note.ts";
import {
  learningObjectiveRevisionsV2,
  learningObjectiveOriginsV2,
} from "../db/schema/card-generation-v2.ts";

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
              object_type: "objective",
              object_id: "objective-1",
              title: "An objective",
              body: "Needle objective body",
              indexed_at: "2026-07-20T01:02:02.000Z",
              metadata: { objectiveId: "objective-1", lifecycle: "active" },
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
    // V2: 只消费 non-V1 类型——card/card_set/evidence 均被排除，objective 通过。
    assert.match(compiledSql, /search_document\.object_type NOT IN \('card', 'card_set', 'evidence'\)/);
    assert.equal(result.total, 9);
    assert.equal(result.nextCursor, 4);
    assert.deepEqual(result.items.map((item) => item.href), [
      "/notes/note-1",
      "/learning-objectives/objective-1",
      "/sources/source-1",
      "",
    ]);
    assert.match(result.items[0]!.snippet, /^…/);
    assert.match(result.items[0]!.snippet, /«Needle»/);
    assert.match(result.items[0]!.snippet, /…$/);
    assert.equal(result.items[0]!.indexedAt, "2026-07-20T01:02:03.000Z");
    assert.equal(result.items[1]!.objectType, "objective");
    assert.equal(result.items[1]!.matchCount, 1);
    assert.equal(result.items[3]!.matchCount, 1);
  });

  it("returns no continuation when the final page exhausts the total", async () => {
    let call = 0;
    const executor = {
      execute: async () => (++call === 1 ? [] : [{ count: "4" }]),
    } as any;

    const result = await search(executor, WORKSPACE_ID, "%_\\", { offset: 4 });

    assert.deepEqual(result, { items: [], total: 4, nextCursor: null });
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
        learningObjectivesV2: {
          findMany: async () => [
            { objectiveId: "objective-1", currentObjectiveRevisionId: "rev-1", lifecycle: "active" },
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
      },
      // Plan 23 CS-03：objective 投影需要读取 revision/origin/来源笔记标题。
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === learningObjectiveRevisionsV2) {
              return [
                {
                  objectiveRevisionId: "rev-1",
                  objectiveId: "objective-1",
                  conceptLabel: "Obj label",
                  publicSummary: "Obj summary",
                },
              ];
            }
            if (table === learningObjectiveOriginsV2) {
              return [{ objectiveId: "objective-1", noteId: "note-1" }];
            }
            if (table === notes) {
              return [{ id: "note-1", title: "One" }];
            }
            return [];
          },
        }),
      }),
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
      indexed: { note: 1, source: 2, cardSet: 0, card: 0, evidence: 0, objective: 1 },
      errors: 0,
      capped: false,
    });
    assert.equal(reconciled, 1);
    // PERF: 逐实体类型流式插入（note/source/objective 各一批，每批上限 500）。
    assert.equal(insertedBatches.length, 3);
    const documents = insertedBatches.flat();
    assert.equal(documents.length, 4);
    assert.equal(documents.find((doc) => doc.objectId === "note-1")?.body, "first\nsecond");
    assert.equal(documents.find((doc) => doc.objectId === "source-1")?.body, "segment one\nsegment two");
    assert.equal(
      documents.find((doc) => doc.objectId === "source-2")?.body,
      "origin body\nraw body\nhttps://example.test",
    );
    const objectiveDoc = documents.find((doc) => doc.objectType === "objective");
    assert.equal(objectiveDoc.objectId, "objective-1");
    assert.equal(objectiveDoc.title, "Obj label");
    assert.equal(objectiveDoc.body, "Obj summary\nOne");
    assert.deepEqual(objectiveDoc.metadata, {
      objectiveId: "objective-1",
      lifecycle: "active",
    });
  });

  it("handles an empty workspace without child queries or inserts", async () => {
    let childQueries = 0;
    let inserts = 0;
    const executor = {
      query: {
        notes: { findMany: async () => [] },
        sources: { findMany: async () => [] },
        learningObjectivesV2: { findMany: async () => [] },
        noteBlocks: { findMany: async () => { childQueries += 1; return []; } },
        sourceSegments: { findMany: async () => { childQueries += 1; return []; } },
      },
      select: () => ({ from: () => ({ where: async () => [] }) }),
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
      indexed: { note: 0, source: 0, cardSet: 0, card: 0, evidence: 0, objective: 0 },
      errors: 0,
      capped: false,
    });
    assert.equal(childQueries, 0);
    assert.equal(inserts, 0);
  });

  it("reports rollback semantics when replacement fails", async () => {
    const executor = {
      query: {
        notes: { findMany: async () => [] },
        sources: { findMany: async () => [] },
        learningObjectivesV2: { findMany: async () => [] },
        noteBlocks: { findMany: async () => [] },
        sourceSegments: { findMany: async () => [] },
      },
      select: () => ({ from: () => ({ where: async () => [] }) }),
      transaction: async () => {
        throw new Error("database unavailable");
      },
    } as any;

    const result = await reindexWorkspaceSearch(executor, WORKSPACE_ID);

    assert.deepEqual(result, {
      deleted: 0,
      indexed: { note: 0, source: 0, cardSet: 0, card: 0, evidence: 0, objective: 0 },
      errors: 1,
      capped: false,
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
              default:
                return [
                  { objectId: "source-stale", title: "Old source" },
                  { objectId: "source-ghost", title: "Ghost source" },
                ];
            }
          },
        },
      },
    } as any;

    const result = await detectSearchDrift(executor, WORKSPACE_ID);

    assert.equal(indexedQuery, 2);
    // V2：drift 只对比 note / source（card/card_set/evidence 已下线）。
    assert.deepEqual(result.expected, {
      note: 2,
      source: 2,
      cardSet: 0,
      card: 0,
      evidence: 0,
    });
    assert.deepEqual(result.actual, {
      note: 2,
      source: 2,
      cardSet: 0,
      card: 0,
      evidence: 0,
    });
    assert.deepEqual(result.ghosts, [
      { objectType: "note", objectId: "note-ghost" },
      { objectType: "source", objectId: "source-ghost" },
    ]);
    assert.deepEqual(result.missing, [
      { objectType: "note", objectId: "note-missing" },
      { objectType: "source", objectId: "source-missing" },
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
    ]);
    assert.deepEqual(result.staleBodies, [{ objectType: "note", objectId: "note-stale" }]);
    assert.equal(result.hasDrift, true);
  });

  it("returns a clean result and skips block hydration for empty domains", async () => {
    let forbiddenQueries = 0;
    let indexedQuery = 0;
    const executor = {
      query: {
        notes: { findMany: async () => [] },
        sources: { findMany: async () => [] },
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

    assert.equal(indexedQuery, 2);
    assert.equal(forbiddenQueries, 0);
    assert.deepEqual(result, {
      expected: { note: 0, source: 0, cardSet: 0, card: 0, evidence: 0 },
      actual: { note: 0, source: 0, cardSet: 0, card: 0, evidence: 0 },
      ghosts: [],
      missing: [],
      staleTitles: [],
      staleBodies: [],
      hasDrift: false,
      capped: { note: false, source: false, cardSet: false, card: false, evidence: false },
    });
  });
});
