import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PENDING_JOBS_PER_WORKSPACE, SourceStatus } from "@ailearn/shared";
import { jobs } from "../db/schema/job.ts";
import { noteBlocks, notes, noteVersions, sources } from "../db/schema/note.ts";
import { computeContentHash } from "../modules/note/service.ts";
import {
  createNoteFromSource,
  createSource,
  deleteSource,
  getSource,
  listNotesBySource,
  listSources,
  listSourceStatuses,
  updateSource,
} from "../modules/source/service.ts";
import { encodeCursor } from "../lib/pagination.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";

function updateChain(onSet?: (value: unknown) => void): any {
  return {
    set: (value: unknown) => {
      onSet?.(value);
      return { where: async () => undefined };
    },
  };
}

describe("source creation and reads", () => {
  it("creates a URL source and queues URL fetching in the same executor", async () => {
    const inserted: Array<{ table: unknown; value: any }> = [];
    const source = {
      id: "source-1",
      workspaceId: WORKSPACE_ID,
      type: "url",
      title: "Docs",
      status: SourceStatus.DRAFT,
    };
    const executor = {
      execute: async () => undefined,
      // where() 返回 awaitable（SELECT 行集）且带 limit()（journey-service 等
      // 需要完整链）；无 active Journey 时零开销路径返回空集。
      select: () => ({
        from: () => ({
          where: () => Object.assign(async () => [], { limit: async () => [] }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (value: any) => {
          inserted.push({ table, value });
          if (table === sources) return { returning: async () => [source] };
          return Promise.resolve();
        },
      }),
      query: {
        sources: { findFirst: async () => source },
        sourceSegments: { findMany: async () => [] },
      },
    } as any;

    const result = await createSource(executor, WORKSPACE_ID, USER_ID, {
      type: "url",
      title: "Docs",
      url: "https://example.test/docs",
      metadata: { language: "en" },
    });

    assert.deepEqual(result, { source, segments: [] });
    assert.equal(inserted[0]!.table, sources);
    assert.deepEqual(inserted[0]!.value.metadata, {
      language: "en",
      url: "https://example.test/docs",
      typeSource: "manual",
    });
    assert.equal(inserted[1]!.table, jobs);
    assert.deepEqual(inserted[1]!.value.payload, {
      sourceId: "source-1",
      fetchUrlContent: true,
      userId: USER_ID,
    });
  });

  it("rejects source creation when the pending-job quota is full", async () => {
    const executor = {
      execute: async () => undefined,
      select: () => ({
        from: () => ({
          where: async () => [{ count: MAX_PENDING_JOBS_PER_WORKSPACE }],
        }),
      }),
    } as any;

    await assert.rejects(
      createSource(executor, WORKSPACE_ID, USER_ID, {
        type: "text",
        title: "Text",
        content: "body",
      }),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 429);
        assert.match(error.message, /pending jobs/);
        return true;
      },
    );
  });

  it("stores inline content and queues parsing without URL fetching", async () => {
    const inserted: any[] = [];
    const source = { id: "source-inline", type: "text", title: "Inline" };
    const executor = {
      execute: async () => undefined,
      select: () => ({
        from: () => ({
          where: () => Object.assign(async () => [], { limit: async () => [] }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (value: any) => {
          inserted.push(value);
          return table === sources
            ? { returning: async () => [source] }
            : Promise.resolve();
        },
      }),
      query: {
        sources: { findFirst: async () => source },
        sourceSegments: { findMany: async () => [] },
      },
    } as any;

    await createSource(executor, WORKSPACE_ID, USER_ID, {
      type: "text",
      title: "Inline",
      content: "inline body",
    });

    assert.equal(inserted[0]!.metadata.rawContent, "inline body");
    assert.deepEqual(inserted[1]!.payload, { sourceId: "source-inline", userId: USER_ID });
  });

  it("gets a source with ordered segments and returns null when absent", async () => {
    const source = { id: "source-1", title: "Source" };
    const segments = [{ id: "segment-1", ordinal: 0, text: "body" }];
    const found = await getSource({
      query: {
        sources: { findFirst: async () => source },
        sourceSegments: { findMany: async () => segments },
      },
    } as any, "source-1", WORKSPACE_ID);
    assert.deepEqual(found, { source, segments });

    const missing = await getSource({
      query: { sources: { findFirst: async () => undefined } },
    } as any, "missing", WORKSPACE_ID);
    assert.equal(missing, null);
  });
});

describe("source listing", () => {
  it("applies cursor pagination, batches note counts, and reports total", async () => {
    const rows = [
      { id: "00000000-0000-4000-8000-000000000010", title: "One", cursorTimestamp: "2026-07-20T00:00:02.123456Z" },
      { id: "00000000-0000-4000-8000-000000000009", title: "Two", cursorTimestamp: "2026-07-20T00:00:01.123456Z" },
      { id: "00000000-0000-4000-8000-000000000008", title: "Three", cursorTimestamp: "2026-07-20T00:00:00.123456Z" },
    ];
    const executor = {
      query: { sources: { findMany: async () => rows } },
      select: () => ({
        from: (table: unknown) => table === notes
          ? {
              where: () => ({
                groupBy: async () => [{ sourceId: rows[0]!.id, count: 3 }],
              }),
            }
          : { where: async () => [{ count: 7 }] },
      }),
    } as any;

    const result = await listSources(executor, WORKSPACE_ID, {
      status: SourceStatus.READY,
      cursor: encodeCursor("2026-07-21T00:00:00.000001Z", "00000000-0000-4000-8000-000000000011"),
      limit: 2,
    });

    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items.map((item: any) => item.noteCount), [3, 0]);
    assert.equal(result.total, 7);
    assert.ok(result.nextCursor);
  });

  it("returns an empty page without issuing a note-count query", async () => {
    let noteCountQueries = 0;
    const executor = {
      query: { sources: { findMany: async () => [] } },
      select: () => ({
        from: (table: unknown) => {
          if (table === notes) noteCountQueries += 1;
          return { where: async () => [{ count: 0 }] };
        },
      }),
    } as any;

    const result = await listSources(executor, WORKSPACE_ID, { cursor: "invalid", limit: 0 });

    assert.deepEqual(result, { items: [], nextCursor: null, total: 0 });
    assert.equal(noteCountQueries, 0);
  });

  it("fails closed if a database row lacks its lossless cursor timestamp", async () => {
    const executor = {
      query: { sources: { findMany: async () => [{ id: "source-1", title: "Broken" }] } },
    } as any;

    await assert.rejects(
      listSources(executor, WORKSPACE_ID, { limit: 1 }),
      /source cursor timestamp is missing/,
    );
  });

  it("short-circuits empty status polling and returns selected statuses otherwise", async () => {
    let selected = 0;
    const executor = {
      select: () => {
        selected += 1;
        return { from: () => ({ where: async () => [{ id: "source-1", status: SourceStatus.READY }] }) };
      },
    } as any;

    assert.deepEqual(await listSourceStatuses(executor, WORKSPACE_ID, []), []);
    assert.deepEqual(await listSourceStatuses(executor, WORKSPACE_ID, ["source-1"]), [
      { id: "source-1", status: SourceStatus.READY },
    ]);
    assert.equal(selected, 1);
  });
});

describe("source updates and deletion", () => {
  it("merges metadata, updates the title, and returns refreshed detail", async () => {
    const source = { id: "source-1", title: "Old", metadata: { retained: true } };
    const refreshed = { ...source, title: "New", metadata: { retained: true, added: 1 } };
    let updates: any;
    // F13（round-4）：updateSource 改为 `select(...).for("update")` 锁定读——
    // 该测试 mock 相应补 `select` 链（返回 base source 供 metadata 合并）；
    // getSource 仍走 `query.sources.findFirst`（返回 refreshed）。
    const executor = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({ for: async () => [source] }),
          }),
        }),
      }),
      query: {
        sources: { findFirst: async () => refreshed },
        sourceSegments: { findMany: async () => [{ id: "segment-1" }] },
      },
      update: () => updateChain((value) => { updates = value; }),
    } as any;

    const result = await updateSource(executor, "source-1", WORKSPACE_ID, {
      title: "New",
      metadata: { added: 1 },
    });

    assert.equal(updates.title, "New");
    assert.deepEqual(updates.metadata, { retained: true, added: 1 });
    assert.deepEqual(result, { source: refreshed, segments: [{ id: "segment-1" }] });
  });

  it("returns null when updating or deleting a missing source", async () => {
    const executor = {
      // F13：updateSource 现用 select(...).for("update") 读；缺失时 select 返回空。
      select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [] }) }) }) }),
      query: { sources: { findFirst: async () => undefined } },
    } as any;
    assert.equal(await updateSource(executor, "missing", WORKSPACE_ID, {}), null);
    assert.equal(await deleteSource(executor, "missing", WORKSPACE_ID), null);
  });

  it("archives the source and removes its search projection", async () => {
    let archived: any;
    let searchDeletes = 0;
    const executor = {
      query: { sources: { findFirst: async () => ({ id: "source-1" }) } },
      update: () => updateChain((value) => { archived = value; }),
      transaction: async (run: (tx: any) => Promise<void>) => run({
        delete: () => ({ where: async () => { searchDeletes += 1; } }),
      }),
    } as any;

    assert.deepEqual(await deleteSource(executor, "source-1", WORKSPACE_ID), { ok: true });
    assert.equal(archived.status, SourceStatus.ARCHIVED);
    assert.equal(searchDeletes, 1);
  });

  it("keeps deletion successful when best-effort projection cleanup fails", async () => {
    const executor = {
      query: { sources: { findFirst: async () => ({ id: "source-1" }) } },
      update: () => updateChain(),
      transaction: async () => { throw new Error("index offline"); },
    } as any;

    assert.deepEqual(await deleteSource(executor, "source-1", WORKSPACE_ID), { ok: true });
  });
});

describe("source to note conversion", () => {
  it("returns null/not-ready/no-segments without writing", async () => {
    assert.equal(await createNoteFromSource({
      query: { sources: { findFirst: async () => undefined } },
    } as any, "missing", WORKSPACE_ID, USER_ID), null);

    assert.deepEqual(await createNoteFromSource({
      query: { sources: { findFirst: async () => ({ status: SourceStatus.PROCESSING }) } },
    } as any, "source-1", WORKSPACE_ID, USER_ID), { error: "source_not_ready" });

    assert.deepEqual(await createNoteFromSource({
      query: {
        sources: { findFirst: async () => ({ status: SourceStatus.READY }) },
        sourceSegments: { findMany: async () => [] },
      },
    } as any, "source-1", WORKSPACE_ID, USER_ID), { error: "no_segments" });
  });

  it("detects an existing note with identical converted content", async () => {
    const contentHash = computeContentHash({
      blocks: [{ type: "paragraph", content: "same body" }],
    });
    const executor = {
      query: {
        sources: {
          findFirst: async () => ({
            id: "source-1",
            type: "text",
            title: "Source",
            status: SourceStatus.READY,
          }),
        },
        sourceSegments: {
          findMany: async () => [{
            id: "segment-1",
            text: "same body",
            segmentType: "paragraph",
            charStart: 0,
            charEnd: 9,
          }],
        },
      },
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: async () => [{ noteId: "note-existing", noteTitle: "Existing", versionHash: contentHash }],
          }),
        }),
      }),
    } as any;

    assert.deepEqual(await createNoteFromSource(executor, "source-1", WORKSPACE_ID, USER_ID), {
      error: "duplicate_content",
      existingNoteId: "note-existing",
      existingNoteTitle: "Existing",
    });
  });

  it("creates note/version/blocks and updates the search projection", async () => {
    const inserted: Array<{ table: unknown; value: any }> = [];
    const updated: Array<{ table: unknown; value: any }> = [];
    let indexed: any;
    const source = {
      id: "source-1",
      type: "markdown",
      title: "Source title",
      status: SourceStatus.READY,
    };
    const executor = {
      query: {
        sources: { findFirst: async () => source },
        sourceSegments: {
          findMany: async () => [
            { id: "segment-1", text: "Heading", segmentType: "heading", charStart: 0, charEnd: 7 },
            { id: "segment-2", text: "Paragraph", segmentType: "paragraph", charStart: 8, charEnd: 17 },
          ],
        },
      },
      insert: (table: unknown) => ({
        values: (value: any) => {
          inserted.push({ table, value });
          if (table === notes) return { returning: async () => [{ id: "note-1", title: source.title }] };
          if (table === noteVersions) return { returning: async () => [{ id: "version-1" }] };
          return Promise.resolve();
        },
      }),
      update: (table: unknown) => ({
        set: (value: any) => {
          updated.push({ table, value });
          return { where: async () => undefined };
        },
      }),
      transaction: async (run: (tx: any) => Promise<void>) => run({
        insert: () => ({
          values: (value: any) => {
            indexed = value;
            return { onConflictDoUpdate: async () => undefined };
          },
        }),
      }),
    } as any;

    const result = await createNoteFromSource(
      executor,
      "source-1",
      WORKSPACE_ID,
      USER_ID,
      { force: true },
    );

    assert.deepEqual(result, {
      note: { id: "note-1", title: "Source title" },
      version: { id: "version-1" },
    });
    assert.equal(inserted.some((entry) => entry.table === noteBlocks), true);
    assert.equal(updated[0]!.table, notes);
    assert.equal(updated[0]!.value.currentVersionId, "version-1");
    assert.equal(indexed.objectType, "note");
    assert.equal(indexed.body, "Heading\nParagraph");
  });

  it("still creates the note when best-effort search upsert fails", async () => {
    const executor = {
      query: {
        sources: {
          findFirst: async () => ({
            id: "source-1",
            type: "text",
            title: "Source",
            status: SourceStatus.READY,
          }),
        },
        sourceSegments: {
          findMany: async () => [{ id: "segment-1", text: "Body", segmentType: null, charStart: 0, charEnd: 4 }],
        },
      },
      insert: (table: unknown) => ({
        values: () => {
          if (table === notes) return { returning: async () => [{ id: "note-1", title: "Source" }] };
          if (table === noteVersions) return { returning: async () => [{ id: "version-1" }] };
          return Promise.resolve();
        },
      }),
      update: () => updateChain(),
      transaction: async () => { throw new Error("index offline"); },
    } as any;

    const result = await createNoteFromSource(executor, "source-1", WORKSPACE_ID, USER_ID, { force: true });

    assert.equal((result as any).note.id, "note-1");
  });

  it("lists non-deleted notes for an existing source", async () => {
    const expected = [{ id: "note-1", title: "Note" }];
    const executor = {
      query: { sources: { findFirst: async () => ({ id: "source-1" }) } },
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => expected }) }),
        }),
      }),
    } as any;
    assert.deepEqual(await listNotesBySource(executor, "source-1", WORKSPACE_ID), expected);

    assert.equal(await listNotesBySource({
      query: { sources: { findFirst: async () => undefined } },
    } as any, "missing", WORKSPACE_ID), null);
  });
});
