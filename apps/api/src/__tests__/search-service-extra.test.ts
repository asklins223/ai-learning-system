import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  decodeSearchCursor,
  detectSearchDrift,
  reindexWorkspaceSearch,
  search,
} from "../modules/search/service.ts";
import { notes } from "@ailearn/shared/db-schema/note";
import { desktopSearchPageSchema } from "@ailearn/shared/desktop-surface-contracts";
import {
  learningObjectiveRevisionsV2,
  learningObjectiveOriginsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
// 搜索的判据是查看者，所以每个调用点都要传一个（批次 4.5）。
const VIEWER_ID = "00000000-0000-4000-8000-000000000002";

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
              indexed_at: "2026-07-20T01:02:03.000Z",
              metadata: null,
            },
            {
              object_type: "objective",
              object_id: "objective-1",
              title: "An objective",
              body: "Needle objective body",
              indexed_at: "2026-07-20T01:02:02.000Z",
              metadata: { objectiveId: "objective-1", lifecycle: "active" },
            },
            {
              object_type: "source",
              object_id: "source-1",
              title: "A source",
              body: null,
              indexed_at: "2026-07-20T01:02:01.000Z",
              metadata: null,
            },
            {
              object_type: "other",
              object_id: "other-1",
              title: null,
              body: "Needle and Needle",
              indexed_at: "2026-07-20T01:01:59.000Z",
              metadata: null,
            },
          ];
        }
        return [{ count: "9" }];
      },
    } as any;

    const result = await search(executor, WORKSPACE_ID, "Needle", { userId: VIEWER_ID,
      type: "note",
      limit: 999,
    });

    assert.equal(calls.length, 2);
    const compiledSql = calls
      .map((statement) => new PgDialect().sqlToQuery(statement as SQL).sql)
      .join("\n");
    assert.match(compiledSql, /FROM search_documents AS search_document/);
    // 路由层只接受当前搜索实体类型。
    assert.equal(result.total, 9);
    // 只剩一页：多取的那一行不存在，所以没有下一页游标。
    assert.equal(result.nextCursor, null);
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
    // "匹配 N 处" counts real occurrences in title + body, not a hardcoded 1.
    assert.equal(result.items[3]!.matchCount, 2);
  });

  it("formats the index timestamp as ISO-8601 so the desktop contract accepts the page", async () => {
    const calls: unknown[] = [];
    const executor = {
      execute: async (statement: unknown) => {
        calls.push(statement);
        // The pg driver hands raw SQL timestamptz back as text; the query itself
        // now formats it, so this is what a real row carries.
        return calls.length === 1
          ? [{
              object_type: "note",
              object_id: "00000000-0000-4000-8000-000000000002",
              title: "A note",
              body: "Needle",
              indexed_at: "2026-08-22T07:22:05.460Z",
              metadata: null,
            }]
          : [{ count: "1" }];
      },
    } as any;

    const result = await search(executor, WORKSPACE_ID, "Needle", { userId: VIEWER_ID });

    const compiledSql = calls
      .map((statement) => new PgDialect().sqlToQuery(statement as SQL).sql)
      .join("\n");
    // The raw driver text (`2026-08-22 07:22:05.46+00`) fails isoTimestamp and
    // makes the main process treat the whole app as a broken contract.
    assert.match(compiledSql, /to_char\(.*AT TIME ZONE 'UTC'/);
    assert.doesNotMatch(compiledSql, /SELECT d\.object_type, d\.object_id, d\.title, d\.body, d\.indexed_at/);

    const parsed = desktopSearchPageSchema.safeParse(result);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
  });

  it("returns no continuation when the final page exhausts the total", async () => {
    let call = 0;
    const executor = {
      execute: async () => (++call === 1 ? [] : [{ count: "4" }]),
    } as any;

    const result = await search(executor, WORKSPACE_ID, "%_\\", { userId: VIEWER_ID });

    assert.deepEqual(result, { items: [], total: 4, nextCursor: null });
  });

  it("pages with a keyset cursor instead of an offset", async () => {
    const pageQueries: unknown[] = [];
    const executor = {
      execute: async (statement: unknown) => {
        const compiled = new PgDialect().sqlToQuery(statement as SQL).sql;
        // count 查询没有 search_documents 的 CTE，据此区分两种读。
        if (!compiled.includes("WITH matching AS")) return [{ count: "3" }];
        pageQueries.push(statement);
        return pageQueries.length === 1
          ? [
              // limit=2 时服务端多取一行用于判断"还有下一页"。
              { object_type: "note", object_id: "n-3", title: null, body: "Needle", indexed_at: "2026-07-20T03:00:00.000Z", metadata: null },
              { object_type: "note", object_id: "n-2", title: null, body: "Needle", indexed_at: "2026-07-20T02:00:00.000Z", metadata: null },
              { object_type: "note", object_id: "n-1", title: null, body: "Needle", indexed_at: "2026-07-20T01:00:00.000Z", metadata: null },
            ]
          : [
              { object_type: "note", object_id: "n-1", title: null, body: "Needle", indexed_at: "2026-07-20T01:00:00.000Z", metadata: null },
            ];
      },
    } as any;

    const first = await search(executor, WORKSPACE_ID, "Needle", { userId: VIEWER_ID, limit: 2 });

    assert.deepEqual(first.items.map((item) => item.objectId), ["n-3", "n-2"]);
    assert.ok(first.nextCursor, "还有下一页时必须给出游标");
    // 游标指向最后一行的排序键，而不是一个会被后续写入挪动的偏移量。
    assert.deepEqual(decodeSearchCursor(first.nextCursor!), {
      page: 1,
      indexedAt: "2026-07-20T02:00:00.000Z",
      dedupKey: "note:n-2",
    });

    const second = await search(executor, WORKSPACE_ID, "Needle", { userId: VIEWER_ID,
      limit: 2,
      cursor: decodeSearchCursor(first.nextCursor!)!,
    });

    assert.deepEqual(second.items.map((item) => item.objectId), ["n-1"]);
    assert.equal(second.nextCursor, null);
    // 第二页查询必须携带上一页最后一行的排序键，而不是 OFFSET。
    const secondSql = new PgDialect().sqlToQuery(pageQueries[1] as SQL);
    assert.match(secondSql.sql, /search_document\.indexed_at </);
    assert.match(secondSql.sql, /search_document\.indexed_at =/);
    assert.deepEqual(secondSql.params.slice(-3, -1), ["2026-07-20T02:00:00.000Z", "note:n-2"]);
    assert.doesNotMatch(secondSql.sql, /OFFSET/);
  });

  it("rejects a tampered cursor instead of guessing a page", () => {
    assert.equal(decodeSearchCursor("not-base64-json"), null);
    assert.equal(decodeSearchCursor(Buffer.from(JSON.stringify({ v: 2, page: 0, indexedAt: "x", dedupKey: "y" })).toString("base64url")), null);
    assert.equal(decodeSearchCursor(Buffer.from(JSON.stringify({ v: 1, page: -1, indexedAt: "2026-01-01T00:00:00.000Z", dedupKey: "y" })).toString("base64url")), null);
    assert.equal(decodeSearchCursor(Buffer.from(JSON.stringify({ v: 1, page: 0, indexedAt: "nope", dedupKey: "y" })).toString("base64url")), null);
  });

  it("never repeats a cursor for an empty page", async () => {
    let call = 0;
    const executor = {
      // total 声称还有 9 条，但本页一行都没有（投影刚被重建/删除）。
      execute: async () => (++call === 1 ? [] : [{ count: "9" }]),
    } as any;

    const result = await search(executor, WORKSPACE_ID, "Needle", { userId: VIEWER_ID, limit: 24 });

    assert.deepEqual(result.items, []);
    assert.equal(result.nextCursor, null);
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
      indexed: { note: 1, source: 2, objective: 1 },
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
      indexed: { note: 0, source: 0, objective: 0 },
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
      indexed: { note: 0, source: 0, objective: 0 },
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
              case 2:
                return [
                  { objectId: "source-stale", title: "Old source" },
                  { objectId: "source-ghost", title: "Ghost source" },
                ];
              default:
                // 审计 F15：目标这一表也从这里读第二遍（索引侧）。
                return [
                  { objectId: "objective-stale", title: "Old objective label" },
                  { objectId: "objective-ghost", title: "Ghost objective" },
                ];
            }
          },
        },
        // 目标标题要与写入侧同一句（`objectiveSearchTitle`），所以检测侧要读当前修订。
        learningObjectivesV2: {
          findMany: async () => [
            { objectiveId: "objective-stale", currentObjectiveRevisionId: "revision-stale" },
            { objectiveId: "objective-missing", currentObjectiveRevisionId: "revision-missing" },
          ],
        },
      },
      select: () => ({
        from: () => ({
          where: async () => [
            { objectiveId: "objective-stale", conceptLabel: "Current objective label", publicSummary: "" },
          ],
        }),
      }),
    } as any;

    const result = await detectSearchDrift(executor, WORKSPACE_ID);

    assert.equal(indexedQuery, 3);
    // Drift 对比当前纳入索引的 note / source / objective 三张业务表。
    assert.deepEqual(result.expected, { note: 2, source: 2, objective: 2 });
    assert.deepEqual(result.actual, { note: 2, source: 2, objective: 2 });
    assert.deepEqual(result.ghosts, [
      { objectType: "note", objectId: "note-ghost" },
      { objectType: "source", objectId: "source-ghost" },
      { objectType: "objective", objectId: "objective-ghost" },
    ]);
    assert.deepEqual(result.missing, [
      { objectType: "note", objectId: "note-missing" },
      { objectType: "source", objectId: "source-missing" },
      { objectType: "objective", objectId: "objective-missing" },
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
        objectType: "objective",
        objectId: "objective-stale",
        indexedTitle: "Old objective label",
        actualTitle: "Current objective label",
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
        learningObjectivesV2: { findMany: async () => [] },
        noteBlocks: { findMany: async () => { forbiddenQueries += 1; return []; } },
        searchDocuments: {
          findMany: async () => {
            indexedQuery += 1;
            return [];
          },
        },
      },
      select: () => ({ from: () => ({ where: async () => [] }) }),
    } as any;

    const result = await detectSearchDrift(executor, WORKSPACE_ID);

    assert.equal(indexedQuery, 3);
    assert.equal(forbiddenQueries, 0);
    assert.deepEqual(result, {
      expected: { note: 0, source: 0, objective: 0 },
      actual: { note: 0, source: 0, objective: 0 },
      ghosts: [],
      missing: [],
      staleTitles: [],
      staleBodies: [],
      hasDrift: false,
      capped: { note: false, source: false, objective: false },
    });
  });
});
