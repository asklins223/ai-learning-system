/**
 * note/service.ts DB 依赖函数补充测试
 *
 * 通过 mock executor 测试 createNote / listNotes / getNoteWithVersion /
 * updateNote / deleteNote / listNoteVersions 的核心业务逻辑分支，
 * 覆盖级联删除、搜索索引投影、乐观并发冲突等路径。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createNote,
  listNotes,
  getNoteWithVersion,
  updateNote,
  deleteNote,
  restoreDeletedNote,
  listNoteVersions,
  RevisionConflictError,
  computeContentHash,
  restoreNoteVersion,
} from "../modules/note/service.ts";

// ─── Mock helpers ───────────────────────────────────────────────────────

/**
 * 创建一个 chainable thenable 对象。
 * 支持任意方法链（.where().orderBy().limit() 等），await 时返回 value。
 */
function chainable<T>(value: T): any {
  const obj: any = {
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject),
    catch: (fn: any) => Promise.resolve(value).catch(fn),
    finally: (fn: any) => Promise.resolve(value).finally(fn),
  };
  return new Proxy(obj, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === Symbol.toPrimitive) return () => String(value);
      return () => chainable(value);
    },
  });
}

interface MockConfig {
  // insert().values().returning() 结果队列
  insertReturning?: any[][];
  // select().from().where()... 结果队列
  selectResult?: any[][];
  // query.{table}.findFirst 结果（单个值或队列）
  notesFindFirst?: any;
  notesFindFirstQueue?: any[];
  noteVersionsFindFirst?: any;
  noteVersionsFindFirstQueue?: any[];
  noteVersionsFindMany?: any[];
  noteBlocksFindMany?: any[];
  // count query
  countResult?: number;
  // 是否在 upsertSearchDocument 中抛错
  searchUpsertError?: boolean;
}

function createMockExecutor(config: MockConfig = {}): any {
  let insertIdx = 0;
  let selectIdx = 0;
  let notesFindFirstIdx = 0;
  let noteVersionsFindFirstIdx = 0;

  const insertReturning = config.insertReturning ?? [];
  const selectResult = config.selectResult ?? [];
  const notesFindFirstQueue = config.notesFindFirstQueue ?? (config.notesFindFirst !== undefined ? [config.notesFindFirst] : [undefined]);
  const noteVersionsFindFirstQueue = config.noteVersionsFindFirstQueue ?? (config.noteVersionsFindFirst !== undefined ? [config.noteVersionsFindFirst] : [undefined]);

  // Track all insert calls for verifying search index sync etc.
  const insertCalls: Array<{ table: any; data: any }> = [];

  const mock: any = {
    _insertCalls: insertCalls,
    insert: (table: any) => ({
      values: (data: any) => {
        insertCalls.push({ table, data });
        return {
          returning: () => chainable(insertReturning[insertIdx++] ?? []),
          onConflictDoUpdate: () => chainable(undefined),
          onConflictDoNothing: () => chainable(undefined),
          then: (resolve: any, reject: any) => Promise.resolve(undefined).then(resolve, reject),
        };
      },
    }),
    update: (_table: any) => ({
      set: (_data: any) => ({
        where: () => chainable(undefined),
      }),
    }),
    delete: (_table: any) => ({
      where: () => chainable(undefined),
    }),
    select: (_fields: any) => ({
      from: (_table: any) => chainable(selectResult[selectIdx++] ?? []),
    }),
    query: {
      notes: {
        findFirst: async () => notesFindFirstQueue[notesFindFirstIdx++],
        findMany: async () => [],
      },
      noteVersions: {
        findFirst: async () => noteVersionsFindFirstQueue[noteVersionsFindFirstIdx++],
        findMany: async () => config.noteVersionsFindMany ?? [],
      },
      noteBlocks: {
        findMany: async () => config.noteBlocksFindMany ?? [],
      },
      // 正文的事实源已经是 Y.Doc（批次 4.1/4.3），自动保存也要先读快照再补齐。
      // 这里一律报"没有快照"，让 loadNoteDoc 走上方的 noteBlocks 补齐路：这些用例
      // 测的是 updateNote 的分支与回执，快照本身由 note-document-state-postgres 集测覆盖。
      noteDocumentStates: {
        findFirst: async () => undefined,
      },
    },
    transaction: async (fn: (tx: any) => Promise<any>) => {
      if (config.searchUpsertError) {
        // For upsertSearchDocument, return a savepoint that throws
        const savepoint: any = {
          insert: (_table: any) => ({
            values: (_data: any) => ({
              onConflictDoUpdate: () => {
                throw new Error("search index upsert failed");
              },
            }),
          }),
          delete: (_table: any) => ({
            where: () => chainable(undefined),
          }),
        };
        return fn(savepoint);
      }
      return fn(mock);
    },
    execute: async () => [],
  };

  return mock;
}

const WS_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";
const NOTE_ID = "00000000-0000-0000-0000-000000000003";
const VERSION_ID = "00000000-0000-0000-0000-000000000004";

// ─── createNote ────────────────────────────────────────────────────────

describe("note/service createNote", () => {
  it("创建带标题和 blocks 的笔记", async () => {
    const blocks: NoteBlock[] = [
      { ordinal: 0, type: "heading", content: "标题" },
      { ordinal: 1, type: "paragraph", content: "内容" },
    ];
    const mock = createMockExecutor({
      insertReturning: [
        [{ id: NOTE_ID, title: "手动标题", titleSource: "manual", createdBy: USER_ID }],
        [{ id: VERSION_ID, versionNo: 1 }],
      ],
      notesFindFirst: { id: NOTE_ID, title: "手动标题", titleSource: "manual", currentVersionId: VERSION_ID, workspaceId: WS_ID },
      noteVersionsFindFirst: { id: VERSION_ID, versionNo: 1, contentJson: { blocks } },
      noteBlocksFindMany: blocks.map((b, i) => ({ ...b, ordinal: i, versionId: VERSION_ID })),
    });

    const result = await createNote(mock, WS_ID, USER_ID, {
      title: "手动标题",
      blocks,
    });

    assert.ok(result);
    assert.equal(result!.note.id, NOTE_ID);
    assert.equal(result!.note.title, "手动标题");
  });

  it("自动提取标题当未提供 title", async () => {
    const blocks: NoteBlock[] = [
      { ordinal: 0, type: "heading", content: "## 自动标题" },
    ];
    const mock = createMockExecutor({
      insertReturning: [
        [{ id: NOTE_ID, title: "自动标题", titleSource: "auto", createdBy: USER_ID }],
        [{ id: VERSION_ID, versionNo: 1 }],
      ],
      notesFindFirst: { id: NOTE_ID, title: "自动标题", titleSource: "auto", currentVersionId: VERSION_ID, workspaceId: WS_ID },
      noteVersionsFindFirst: { id: VERSION_ID, versionNo: 1 },
      noteBlocksFindMany: [{ type: "heading", content: "自动标题", ordinal: 0, versionId: VERSION_ID }],
    });

    const result = await createNote(mock, WS_ID, USER_ID, {
      title: "",
      blocks,
    });

    assert.ok(result);
    assert.equal(result!.note.titleSource, "auto");
  });

  it("空 blocks 时也能创建笔记", async () => {
    const mock = createMockExecutor({
      insertReturning: [
        [{ id: NOTE_ID, title: "无标题笔记", titleSource: "auto", createdBy: USER_ID }],
        [{ id: VERSION_ID, versionNo: 1 }],
      ],
      notesFindFirst: { id: NOTE_ID, title: "无标题笔记", titleSource: "auto", currentVersionId: VERSION_ID, workspaceId: WS_ID },
      noteVersionsFindFirst: { id: VERSION_ID, versionNo: 1 },
      noteBlocksFindMany: [],
    });

    const result = await createNote(mock, WS_ID, USER_ID, {
      title: "",
      blocks: [],
    });

    assert.ok(result);
    assert.equal(result!.note.title, "无标题笔记");
  });

  it("搜索索引投影失败时不影响笔记创建", async () => {
    const mock = createMockExecutor({
      insertReturning: [
        [{ id: NOTE_ID, title: "测试", titleSource: "manual", createdBy: USER_ID }],
        [{ id: VERSION_ID, versionNo: 1 }],
      ],
      notesFindFirst: { id: NOTE_ID, title: "测试", titleSource: "manual", currentVersionId: VERSION_ID, workspaceId: WS_ID },
      noteVersionsFindFirst: { id: VERSION_ID, versionNo: 1 },
      noteBlocksFindMany: [{ type: "paragraph", content: "内容", ordinal: 0, versionId: VERSION_ID }],
      searchUpsertError: true,
    });

    // 不应该抛错
    const result = await createNote(mock, WS_ID, USER_ID, {
      title: "测试",
      blocks: [{ type: "paragraph", content: "内容" }],
    });

    assert.ok(result, "搜索索引失败不应影响笔记创建");
  });
});

// ─── getNoteWithVersion ────────────────────────────────────────────────

describe("note/service getNoteWithVersion", () => {
  it("笔记不存在时返回 null", async () => {
    const mock = createMockExecutor({
      notesFindFirst: undefined,
    });

    const result = await getNoteWithVersion(mock, NOTE_ID, WS_ID);
    assert.equal(result, null);
  });

  it("笔记无 currentVersionId 时返回 null", async () => {
    const mock = createMockExecutor({
      notesFindFirst: { id: NOTE_ID, currentVersionId: null, workspaceId: WS_ID },
    });

    const result = await getNoteWithVersion(mock, NOTE_ID, WS_ID);
    assert.equal(result, null);
  });

  it("版本不存在时返回 null", async () => {
    const mock = createMockExecutor({
      notesFindFirst: { id: NOTE_ID, currentVersionId: VERSION_ID, workspaceId: WS_ID },
      noteVersionsFindFirst: undefined,
    });

    const result = await getNoteWithVersion(mock, NOTE_ID, WS_ID);
    assert.equal(result, null);
  });

  it("正常返回笔记、版本和 blocks", async () => {
    const blocks: NoteBlock[] = [
      { ordinal: 0, type: "heading", content: "标题" },
      { ordinal: 1, type: "paragraph", content: "段落" },
    ];
    const mock = createMockExecutor({
      notesFindFirst: { id: NOTE_ID, currentVersionId: VERSION_ID, workspaceId: WS_ID, title: "测试" },
      noteVersionsFindFirst: { id: VERSION_ID, versionNo: 1 },
      noteBlocksFindMany: blocks,
    });

    const result = await getNoteWithVersion(mock, NOTE_ID, WS_ID);
    assert.ok(result);
    assert.equal(result!.note.id, NOTE_ID);
    assert.equal(result!.version.id, VERSION_ID);
    assert.equal(result!.blocks.length, 2);
  });
});

// ─── listNotes ─────────────────────────────────────────────────────────

describe("note/service listNotes", () => {
  it("返回笔记列表和分页信息", async () => {
    const now = new Date();
    const notes = [
      { id: "note-1", title: "笔记1", titleSource: "manual" as const, createdAt: now, updatedAt: now, currentVersionId: "v1", workspaceId: WS_ID, createdBy: USER_ID },
      { id: "note-2", title: "笔记2", titleSource: "auto" as const, createdAt: now, updatedAt: now, currentVersionId: "v2", workspaceId: WS_ID, createdBy: USER_ID },
    ];
    const mock = createMockExecutor({
      selectResult: [notes, [{ count: 2 }]],
    });

    const result = await listNotes(mock, WS_ID, { limit: 10 });

    assert.equal(result.items.length, 2);
    assert.equal(result.total, 2);
    assert.equal(result.nextCursor, null);
    assert.equal(result.items[0]?.currentVersionId, "v1");
  });

  it("列表带上正文首图，一版只取 ordinal 最小的那块", async () => {
    // 复盘 #17：以前列表什么都不带，"哪篇笔记里有图"只能挨篇点开。
    const now = new Date();
    const notes = [
      { id: "note-1", title: "有图", titleSource: "manual" as const, createdAt: now, updatedAt: now, currentVersionId: "v1", workspaceId: WS_ID, createdBy: USER_ID },
      { id: "note-2", title: "没图", titleSource: "manual" as const, createdAt: now, updatedAt: now, currentVersionId: "v2", workspaceId: WS_ID, createdBy: USER_ID },
    ];
    // mock 的 select 队列按调用顺序取值：笔记行 → count → 图片块（服务端已按
    // version_id, ordinal 排好，所以这里就按"每版第一块在前"给）。
    const mock = createMockExecutor({
      selectResult: [
        notes,
        [{ count: 2 }],
        [
          { versionId: "v1", content: "![装置](/api/uploads/a.png)" },
          { versionId: "v1", content: "![第二张](/api/uploads/b.png)" },
        ],
      ],
    });

    const result = await listNotes(mock, WS_ID, { limit: 10 });

    assert.equal(result.items[0]?.firstImageBlock, "![装置](/api/uploads/a.png)");
    assert.equal(result.items[1]?.firstImageBlock, null, "没有图片块的要显式回 null");
  });

  it("结果数等于 limit 时不猜测存在下一页", async () => {
    const now = new Date();
    const notes = Array.from({ length: 3 }, (_, i) => ({
      id: `note-${i + 1}`,
      title: `笔记${i + 1}`,
      titleSource: "manual" as const,
      createdAt: now,
      updatedAt: now,
      cursorTimestamp: now.toISOString(),
      currentVersionId: `v${i + 1}`,
      workspaceId: WS_ID,
      createdBy: USER_ID,
    }));
    const mock = createMockExecutor({
      selectResult: [notes, [{ count: 10 }]],
    });

    const result = await listNotes(mock, WS_ID, { limit: 3 });

    assert.equal(result.items.length, 3);
    assert.equal(result.total, 10);
    assert.equal(result.nextCursor, null);
  });

  it("结果数超过 limit 时生成 nextCursor", async () => {
    const now = new Date();
    const notes = Array.from({ length: 4 }, (_, i) => ({
      id: `note-${i + 1}`,
      title: `笔记${i + 1}`,
      titleSource: "manual" as const,
      createdAt: now,
      updatedAt: now,
      cursorTimestamp: now.toISOString(),
      currentVersionId: `v${i + 1}`,
      workspaceId: WS_ID,
      createdBy: USER_ID,
    }));
    const mock = createMockExecutor({
      selectResult: [notes, [{ count: 10 }]],
    });

    const result = await listNotes(mock, WS_ID, { limit: 3 });

    assert.equal(result.items.length, 3);
    assert.equal(result.total, 10);
    assert.ok(result.nextCursor, "应有 nextCursor");
  });

  it("limit 被 clamp 到 1-100 范围", async () => {
    const mock = createMockExecutor({
      selectResult: [[], [{ count: 0 }]],
    });

    // limit=0 → clamp 到 1
    const r1 = await listNotes(mock, WS_ID, { limit: 0 });
    assert.equal(r1.items.length, 0);

    // limit=200 → clamp 到 100
    const r2 = await listNotes(mock, WS_ID, { limit: 200 });
    assert.equal(r2.items.length, 0);
  });

  it("使用默认 limit=100", async () => {
    const mock = createMockExecutor({
      selectResult: [[], [{ count: 0 }]],
    });

    const result = await listNotes(mock, WS_ID);
    assert.equal(result.items.length, 0);
    assert.equal(result.total, 0);
  });
});

// ─── updateNote ────────────────────────────────────────────────────────

describe("note/service updateNote", () => {
  it("笔记不存在时返回 null", async () => {
    const mock = createMockExecutor({
      selectResult: [[]], // FOR UPDATE returns empty
    });

    const result = await updateNote(mock, NOTE_ID, WS_ID, USER_ID, {
      title: "新标题",
      baseVersionId: VERSION_ID,
      isAutosave: false,
    });

    assert.equal(result, null);
  });

  it("baseVersionId 不匹配时抛 RevisionConflictError", async () => {
    const mock = createMockExecutor({
      selectResult: [[{
        id: NOTE_ID,
        currentVersionId: "different-version",
        title: "旧标题",
        titleSource: "manual",
        workspaceId: WS_ID,
      }]],
    });

    await assert.rejects(
      () => updateNote(mock, NOTE_ID, WS_ID, USER_ID, {
        title: "新标题",
        baseVersionId: VERSION_ID,
        isAutosave: false,
      }),
      (err: unknown) => err instanceof RevisionConflictError,
    );
  });

  it("只更新标题（不更新 blocks）", async () => {
    const nextVersionId = "00000000-0000-0000-0000-000000000007";
    const currentVersion = {
      id: VERSION_ID,
      noteId: NOTE_ID,
      versionNo: 1,
      contentJson: {
        blocks: [{ type: "paragraph", content: "内容" }],
        importId: "import-1",
      },
      contentHash: "original-content-hash",
    };
    const mock = createMockExecutor({
      selectResult: [[{
        id: NOTE_ID,
        currentVersionId: VERSION_ID,
        title: "旧标题",
        titleSource: "auto",
        workspaceId: WS_ID,
      }]],
      notesFindFirst: { id: NOTE_ID, currentVersionId: nextVersionId, title: "新标题", titleSource: "manual", workspaceId: WS_ID },
      noteVersionsFindFirstQueue: [
        currentVersion,
        currentVersion,
        { ...currentVersion, id: nextVersionId, versionNo: 2 },
      ],
      noteBlocksFindMany: [{
        type: "paragraph",
        content: "内容",
        ordinal: 0,
        sourceRef: { sourceId: "source-1", segmentId: "segment-1" },
      }],
      insertReturning: [[{ id: nextVersionId, noteId: NOTE_ID, versionNo: 2 }]],
    });

    const result = await updateNote(mock, NOTE_ID, WS_ID, USER_ID, {
      title: "新标题",
      baseVersionId: VERSION_ID,
      isAutosave: false,
    });

    assert.ok(result);
    assert.equal(result!.note.title, "新标题");
    assert.equal(result!.version.id, nextVersionId);
    const versionInsert = mock._insertCalls.find(
      (call: { data: unknown }) =>
        !Array.isArray(call.data) &&
        typeof call.data === "object" &&
        call.data !== null &&
        "contentHash" in call.data,
    );
    assert.deepEqual(versionInsert?.data.contentJson, currentVersion.contentJson);
    assert.equal(versionInsert?.data.contentHash, currentVersion.contentHash);
    // 证据链不丢这件事，现在要看的是**返回的块**，不是"有没有一次数组 INSERT"。
    // 行由文档投影而来（批次 4.1/4.3），而这个假 `noteBlocks.findMany` 不看 where
    // 条件、把上一版的行当成新版的行返回，于是投影正确地判断"无需重写"、一次 INSERT
    // 都不发——按 INSERT 断言就等于在测夹具的瞎。真正"新版本初始为空、必须写入整篇"
    // 由 note-document-state-postgres 集测在真库上覆盖。
    assert.deepEqual(
      (result!.blocks as Array<{ sourceRef?: unknown }>)[0]?.sourceRef,
      { sourceId: "source-1", segmentId: "segment-1" },
      "只改标题就把块级来源引用丢了",
    );
  });

  it("更新 blocks 时创建新版本", async () => {
    const newBlocks: NoteBlock[] = [
      { ordinal: 0, type: "heading", content: "新标题" },
      { ordinal: 1, type: "paragraph", content: "新内容" },
    ];
    const NEW_VERSION_ID = "00000000-0000-0000-0000-000000000005";

    const mock = createMockExecutor({
      insertReturning: [
        [{ id: NEW_VERSION_ID, versionNo: 2 }],
      ],
      selectResult: [[{
        id: NOTE_ID,
        currentVersionId: VERSION_ID,
        title: "旧标题",
        titleSource: "manual",
        workspaceId: WS_ID,
      }]],
      noteVersionsFindFirstQueue: [
        null, // content-hash lookup: no match
        { id: VERSION_ID, versionNo: 1 }, // latest version (in create-new-version branch)
        { id: NEW_VERSION_ID, versionNo: 2 }, // final read
      ],
      notesFindFirst: { id: NOTE_ID, currentVersionId: NEW_VERSION_ID, title: "新标题", titleSource: "manual", workspaceId: WS_ID },
      noteBlocksFindMany: newBlocks.map((b, i) => ({ ...b, ordinal: i, versionId: NEW_VERSION_ID })),
    });

    const result = await updateNote(mock, NOTE_ID, WS_ID, USER_ID, {
      blocks: newBlocks,
      baseVersionId: VERSION_ID,
      isAutosave: false,
    });

    assert.ok(result);
    assert.equal(result!.version.id, NEW_VERSION_ID);
  });

});

// ─── deleteNote ────────────────────────────────────────────────────────

describe("note/service deleteNote", () => {
  it("笔记不存在时返回 null", async () => {
    const mock = createMockExecutor({
      // CONC-01: FOR UPDATE 返回空数组
      selectResult: [[]],
    });

    const result = await deleteNote(mock, NOTE_ID, WS_ID);
    assert.equal(result, null);
  });

  it("CONC-03: 软删除笔记 — 设置 deleted_at，返回 { ok: true }，不返回 imageObjectKeys", async () => {
    const mock = createMockExecutor({
      // CONC-01: 第一个 selectResult 是 FOR UPDATE 查询返回的 note 行
      selectResult: [
        [{ id: NOTE_ID, currentVersionId: VERSION_ID, workspaceId: WS_ID, deletedAt: null }],
      ],
    });

    const result = await deleteNote(mock, NOTE_ID, WS_ID);
    assert.equal(result?.ok, true);
    // CONC-03: 软删除不返回 imageObjectKeys（物理删除时才清理对象存储）
    assert.equal(result && "imageObjectKeys" in result, false);
  });

  it("CONC-03: 已软删除的笔记再次删除返回 null", async () => {
    const mock = createMockExecutor({
      // FOR UPDATE 查询使用 isNull(deletedAt) 过滤，已删除的笔记不会被选中
      selectResult: [[]],
    });

    const result = await deleteNote(mock, NOTE_ID, WS_ID);
    assert.equal(result, null);
  });
});

// ─── CONC-03: restoreDeletedNote ───────────────────────────────────────

describe("note/service restoreDeletedNote (CONC-03)", () => {
  it("恢复不存在的笔记返回 null", async () => {
    const mock = createMockExecutor({
      selectResult: [[]],
    });

    const result = await restoreDeletedNote(mock, NOTE_ID, WS_ID);
    assert.equal(result, null);
  });

  it("恢复未软删除的笔记抛出 NoteNotDeletedError", async () => {
    const mock = createMockExecutor({
      selectResult: [
        [{ id: NOTE_ID, currentVersionId: VERSION_ID, workspaceId: WS_ID, deletedAt: null }],
      ],
    });

    await assert.rejects(
      () => restoreDeletedNote(mock, NOTE_ID, WS_ID),
      (err: unknown) => err instanceof Error && err.constructor.name === "NoteNotDeletedError",
    );
  });

  it("正常恢复软删除的笔记", async () => {
    const mock = createMockExecutor({
      selectResult: [
        [{ id: NOTE_ID, currentVersionId: VERSION_ID, workspaceId: WS_ID, deletedAt: new Date(), title: "测试笔记", titleSource: "auto" }],
      ],
      noteVersionsFindFirst: { id: VERSION_ID, noteId: NOTE_ID, versionNo: 1, contentJson: { blocks: [] }, contentHash: "hash", createdBy: USER_ID, createdAt: new Date() },
      noteBlocksFindMany: [],
    });

    const result = await restoreDeletedNote(mock, NOTE_ID, WS_ID);
    assert.ok(result);
    assert.equal(result!.note.id, NOTE_ID);
  });
});

// ─── CONC-01: deleteNote FOR UPDATE 锁验证 ─────────────────────────────

// ─── note/service CONC-10（已删除） ─────────────────────────────────────
// 删除理由：这两个用例断言 deleteNote/restoreDeletedNote 会取消/恢复以
// cardId 为 subjectId 的 V1 review_schedules 计划（ReviewStatus.CANCELLED,
// updatedAt: deletedAt 与 eq(reviewSchedules.updatedAt, note.deletedAt)）。
// V2 迁移后 review_schedules 不再有 cardId/keyPointId 列，V1 卡片复习计划
// 已随 learning_cards/card_key_points 表删除而退役（见 note/service.ts 的
// "V1 退役"注释），deleteNote/restoreDeletedNote 不再取消/恢复 V1 复习计划。
// 属只测已删 V1 行为的用例，予以删除。

describe("note/service deleteNote concurrency (CONC-01)", () => {
  it("deleteNote 应使用 SELECT ... FOR UPDATE 锁定 note 行", async () => {
    // 通过源码检查确保 deleteNote 使用了 FOR UPDATE 行锁，
    // 防止与 updateNote / restoreNoteVersion 并发时产生丢数据窗口。
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const servicePath = resolve(
      import.meta.dirname,
      "../modules/note/service.ts",
    );
    const source = readFileSync(servicePath, "utf-8");

    // 提取 deleteNote 函数体
    const deleteStart = source.indexOf("export async function deleteNote(");
    assert.ok(deleteStart !== -1, "应找到 deleteNote 函数定义");
    // 下一个 export async function 作为结束标记
    const nextExport = source.indexOf("export async function", deleteStart + 1);
    const deleteSection = nextExport !== -1
      ? source.slice(deleteStart, nextExport)
      : source.slice(deleteStart);

    assert.ok(
      deleteSection.includes('.for("update")'),
      "deleteNote 应使用 SELECT ... FOR UPDATE 锁定 note 行，" +
        "防止与 updateNote / restoreNoteVersion 并发时丢数据",
    );
  });

  it("deleteNote 不应使用无锁的 findFirst 读取 note 行", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const servicePath = resolve(
      import.meta.dirname,
      "../modules/note/service.ts",
    );
    const source = readFileSync(servicePath, "utf-8");

    const deleteStart = source.indexOf("export async function deleteNote(");
    assert.ok(deleteStart !== -1, "应找到 deleteNote 函数定义");
    const nextExport = source.indexOf("export async function", deleteStart + 1);
    const deleteSection = nextExport !== -1
      ? source.slice(deleteStart, nextExport)
      : source.slice(deleteStart);

    // deleteNote 函数体内不应出现 notes.findFirst（无锁查询）
    // 排除注释中的提及
    const codeLines = deleteSection
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"));
    const codeBody = codeLines.join("\n");
    assert.ok(
      !codeBody.includes("executor.query.notes.findFirst"),
      "deleteNote 不应使用无锁的 findFirst 读取 note 行",
    );
  });
});

// ─── listNoteVersions ──────────────────────────────────────────────────

describe("note/service listNoteVersions", () => {
  it("笔记不存在时返回 null", async () => {
    const mock = createMockExecutor({
      notesFindFirst: undefined,
    });

    const result = await listNoteVersions(mock, NOTE_ID, WS_ID);
    assert.equal(result, null);
  });

  it("返回版本列表", async () => {
    const versions = [
      { id: "v2", noteId: NOTE_ID, versionNo: 2, createdBy: USER_ID, createdAt: new Date() },
      { id: "v1", noteId: NOTE_ID, versionNo: 1, createdBy: USER_ID, createdAt: new Date() },
    ];
    const mock = createMockExecutor({
      notesFindFirst: { id: NOTE_ID, currentVersionId: "v2", workspaceId: WS_ID },
      noteVersionsFindMany: versions,
    });

    const result = await listNoteVersions(mock, NOTE_ID, WS_ID);
    assert.ok(result);
    assert.equal(result!.length, 2);
    assert.equal(result![0].versionNo, 2);
    assert.equal(result![1].versionNo, 1);
  });

  it("无版本时返回空数组", async () => {
    const mock = createMockExecutor({
      notesFindFirst: { id: NOTE_ID, currentVersionId: VERSION_ID, workspaceId: WS_ID },
      noteVersionsFindMany: [],
    });

    const result = await listNoteVersions(mock, NOTE_ID, WS_ID);
    assert.ok(result);
    assert.equal(result!.length, 0);
  });
});

// ─── computeContentHash ──────────────────────────────────────────────────

import type { NoteBlock } from "../modules/note/schema.ts";

describe("note/service computeContentHash", () => {
  it("相同内容产生相同哈希", () => {
    const hash1 = computeContentHash({ blocks: [{ type: "paragraph", content: "hello" }] });
    const hash2 = computeContentHash({ blocks: [{ type: "paragraph", content: "hello" }] });
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 32); // MD5 hex = 32 chars
  });

  it("不同内容产生不同哈希", () => {
    const hash1 = computeContentHash({ blocks: [{ type: "paragraph", content: "hello" }] });
    const hash2 = computeContentHash({ blocks: [{ type: "paragraph", content: "world" }] });
    assert.notEqual(hash1, hash2);
  });

  it("空对象产生有效哈希", () => {
    const hash = computeContentHash({});
    assert.equal(hash.length, 32);
  });
});

// ─── updateNote content-hash dedup & in-place update ─────────────────────

describe("note/service updateNote content-hash dedup", () => {
  it("内容匹配已有版本时直接指向该版本，不创建新版本", async () => {
    const existingVersion = {
      id: "existing-v1",
      noteId: NOTE_ID,
      versionNo: 1,
      contentHash: "abc123",
      contentJson: { blocks: [{ type: "paragraph", content: "same" }] },
    };
    const mock = createMockExecutor({
      selectResult: [[{
        id: NOTE_ID,
        currentVersionId: "old-v1",
        title: "Test",
        titleSource: "auto",
        workspaceId: WS_ID,
      }]],
      notesFindFirst: { id: NOTE_ID, currentVersionId: "old-v1", workspaceId: WS_ID, title: "Test", titleSource: "auto" },
      noteVersionsFindFirstQueue: [
        existingVersion, // content-hash lookup
        existingVersion, // final read
      ],
      noteBlocksFindMany: [{ type: "paragraph", content: "same", ordinal: 0 }],
    });

    const result = await updateNote(mock, NOTE_ID, WS_ID, USER_ID, {
      blocks: [{ type: "paragraph", content: "same" }],
      baseVersionId: "old-v1",
      isAutosave: true,
    });

    assert.ok(result);
    assert.equal(result!.version.id, "existing-v1");
  });

  it("哈希匹配但 contentJson 不一致（碰撞）时不复用，走原地更新或新建分支", async () => {
    // 场景：contentHash 匹配但 contentJson 实际内容不同（极低概率碰撞）
    // 二次验证应阻止错误复用，fallback 到 isAutosave 原地更新分支
    const hashCollisionVersion = {
      id: "collision-v1",
      noteId: NOTE_ID,
      versionNo: 1,
      contentHash: "abc123", // 与 computeContentHash({blocks:[{type:"paragraph",content:"updated"}]}) 相同（模拟碰撞）
      contentJson: { blocks: [{ type: "paragraph", content: "different content" }] }, // 实际内容不同
    };
    const mock = createMockExecutor({
      selectResult: [
        [{
          id: NOTE_ID,
          currentVersionId: VERSION_ID,
          title: "Test",
          titleSource: "auto",
          workspaceId: WS_ID,
        }],
        // canUpdateVersionInPlace 的 SELECT ... FOR UPDATE on note_versions
        [{ id: VERSION_ID }],
      ],
      notesFindFirst: { id: NOTE_ID, currentVersionId: VERSION_ID, workspaceId: WS_ID, title: "Test", titleSource: "auto" },
      noteVersionsFindFirstQueue: [
        hashCollisionVersion, // content-hash lookup: hash matches
        { id: VERSION_ID, noteId: NOTE_ID, versionNo: 1 }, // final read (after in-place update)
      ],
      noteBlocksFindMany: [{ type: "paragraph", content: "updated", ordinal: 0 }],
    });

    const result = await updateNote(mock, NOTE_ID, WS_ID, USER_ID, {
      blocks: [{ type: "paragraph", content: "updated" }],
      baseVersionId: VERSION_ID,
      isAutosave: true,
    });

    assert.ok(result);
    // 不应复用碰撞版本，应原地更新当前版本
    assert.equal(result!.version.id, VERSION_ID, "哈希碰撞时应 fallback 到原地更新，不复用碰撞版本");
  });

  it("内容匹配且 currentVersionId 已指向该版本时跳过冗余 UPDATE", async () => {
    // 场景：撤销后内容回到当前版本，content_hash 匹配且 currentVersionId 已正确
    const existingVersion = {
      id: "current-v1",
      noteId: NOTE_ID,
      versionNo: 1,
      contentHash: "abc123",
      contentJson: { blocks: [{ type: "paragraph", content: "same" }] },
    };
    const mock = createMockExecutor({
      selectResult: [[{
        id: NOTE_ID,
        currentVersionId: "current-v1",  // 已指向匹配版本
        title: "same",                   // 标题也已一致
        titleSource: "auto",
        workspaceId: WS_ID,
      }]],
      notesFindFirst: { id: NOTE_ID, currentVersionId: "current-v1", workspaceId: WS_ID, title: "same", titleSource: "auto" },
      noteVersionsFindFirstQueue: [
        existingVersion, // content-hash lookup
        existingVersion, // final read
      ],
      noteBlocksFindMany: [{ type: "paragraph", content: "same", ordinal: 0 }],
    });

    const result = await updateNote(mock, NOTE_ID, WS_ID, USER_ID, {
      blocks: [{ type: "paragraph", content: "same" }],
      baseVersionId: "current-v1",
      isAutosave: true,
    });

    assert.ok(result);
    assert.equal(result!.version.id, "current-v1");
    assert.equal(result!.note.title, "same");
  });

  it("手动标题变化即使正文相同也创建新版本令牌", async () => {
    const currentVersion = {
      id: VERSION_ID,
      noteId: NOTE_ID,
      versionNo: 1,
      contentHash: "same-content",
      contentJson: { blocks: [{ type: "paragraph", content: "same" }] },
    };
    const nextVersionId = "00000000-0000-0000-0000-000000000006";
    const mock = createMockExecutor({
      selectResult: [[{
        id: NOTE_ID,
        currentVersionId: VERSION_ID,
        title: "旧标题",
        titleSource: "manual",
        workspaceId: WS_ID,
      }]],
      notesFindFirst: {
        id: NOTE_ID,
        currentVersionId: nextVersionId,
        workspaceId: WS_ID,
        title: "新标题",
        titleSource: "manual",
      },
      noteVersionsFindFirstQueue: [
        currentVersion,
        currentVersion,
        { ...currentVersion, id: nextVersionId, versionNo: 2 },
      ],
      insertReturning: [[{ id: nextVersionId, noteId: NOTE_ID, versionNo: 2 }]],
      noteBlocksFindMany: [{ type: "paragraph", content: "same", ordinal: 0 }],
    });

    const result = await updateNote(mock, NOTE_ID, WS_ID, USER_ID, {
      title: "新标题",
      blocks: [{ type: "paragraph", content: "same" }],
      baseVersionId: VERSION_ID,
      isAutosave: true,
    });

    assert.ok(result);
    assert.equal(result!.version.id, nextVersionId);
    assert.equal(result!.version.versionNo, 2);
  });

  it("isAutosave + 无卡片引用时原地更新当前版本", async () => {
    const mock = createMockExecutor({
      selectResult: [
        [{
          id: NOTE_ID,
          currentVersionId: VERSION_ID,
          title: "Test",
          titleSource: "auto",
          workspaceId: WS_ID,
        }],
        // canUpdateVersionInPlace 的 SELECT ... FOR UPDATE on note_versions
        [{ id: VERSION_ID }],
      ],
      notesFindFirst: { id: NOTE_ID, currentVersionId: VERSION_ID, workspaceId: WS_ID, title: "Test", titleSource: "auto" },
      noteVersionsFindFirstQueue: [
        null, // content-hash lookup: no match
        { id: VERSION_ID, noteId: NOTE_ID, versionNo: 1 }, // final read
      ],
      noteBlocksFindMany: [{ type: "paragraph", content: "updated", ordinal: 0 }],
    });

    const result = await updateNote(mock, NOTE_ID, WS_ID, USER_ID, {
      blocks: [{ type: "paragraph", content: "updated" }],
      baseVersionId: VERSION_ID,
      isAutosave: true,
    });

    assert.ok(result);
    assert.equal(result!.version.id, VERSION_ID);
  });

  // ── V1 卡片引用检查（已删除）─────────────────────────────────────────
  // 删除理由：以下三个用例分别断言「有 active/superseded 卡引用时降级为创建
  // 新版本」「有 archived 卡引用时允许原地更新」，均依赖 canUpdateVersionInPlace
  // 检查 V1 learningCards（learningCardsFindFirst）。V2 迁移后 V1 卡表已删除，
  // V2 卡片经 objectiveId 关联、不直接引用 note_version，该检查已退役
  // （见 note/service.ts canUpdateVersionInPlace 的 "V1 退役" 注释），现仅保留
  // sealed 版本保护。属只测已删 V1 行为的用例，予以删除。

  it("isAutosave + 版本行不存在时（FOR UPDATE 返回空）降级为创建新版本", async () => {
    const mock = createMockExecutor({
      selectResult: [
        [{
          id: NOTE_ID,
          currentVersionId: VERSION_ID,
          title: "Test",
          titleSource: "auto",
          workspaceId: WS_ID,
        }],
        // canUpdateVersionInPlace 的 SELECT ... FOR UPDATE 返回空——版本已被删除
        [],
      ],
      notesFindFirst: { id: NOTE_ID, currentVersionId: VERSION_ID, workspaceId: WS_ID, title: "Test", titleSource: "auto" },
      noteVersionsFindFirstQueue: [
        null, // content-hash lookup: no match
        { id: VERSION_ID, versionNo: 1 }, // latest version (for fallback)
        { id: "new-v2", noteId: NOTE_ID, versionNo: 2 }, // final read
      ],
      insertReturning: [[{ id: "new-v2", noteId: NOTE_ID, versionNo: 2 }]],
      noteBlocksFindMany: [{ type: "paragraph", content: "updated", ordinal: 0 }],
    });

    const result = await updateNote(mock, NOTE_ID, WS_ID, USER_ID, {
      blocks: [{ type: "paragraph", content: "updated" }],
      baseVersionId: VERSION_ID,
      isAutosave: true,
    });

    assert.ok(result);
    assert.equal(result!.version.versionNo, 2, "版本行不存在时应降级为创建新版本");
  });

  it("显式保存（isAutosave=false）始终创建新版本", async () => {
    const mock = createMockExecutor({
      selectResult: [[{
        id: NOTE_ID,
        currentVersionId: VERSION_ID,
        title: "Test",
        titleSource: "auto",
        workspaceId: WS_ID,
      }]],
      notesFindFirst: { id: NOTE_ID, currentVersionId: VERSION_ID, workspaceId: WS_ID, title: "Test", titleSource: "auto" },
      noteVersionsFindFirstQueue: [
        null, // content-hash lookup: no match
        { id: VERSION_ID, versionNo: 1 }, // latest version
        { id: "new-v2", noteId: NOTE_ID, versionNo: 2 }, // final read
      ],
      insertReturning: [[{ id: "new-v2", noteId: NOTE_ID, versionNo: 2 }]],
      noteBlocksFindMany: [{ type: "paragraph", content: "explicit", ordinal: 0 }],
    });

    const result = await updateNote(mock, NOTE_ID, WS_ID, USER_ID, {
      blocks: [{ type: "paragraph", content: "explicit" }],
      baseVersionId: VERSION_ID,
      isAutosave: false,
    });

    assert.ok(result);
    assert.equal(result!.version.versionNo, 2);
  });
});

// ─── restoreNoteVersion ──────────────────────────────────────────────────

describe("note/service restoreNoteVersion", () => {
  it("笔记不存在时返回 null", async () => {
    const mock = createMockExecutor({
      selectResult: [[]], // noteRows empty
    });

    const result = await restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID);
    assert.equal(result, null);
  });

  it("目标版本不存在时返回 null", async () => {
    const mock = createMockExecutor({
      selectResult: [[{ id: NOTE_ID, currentVersionId: "other-v", workspaceId: WS_ID }]],
      noteVersionsFindFirstQueue: [null], // target version not found
    });

    const result = await restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID);
    assert.equal(result, null);
  });

  it("成功恢复到目标版本", async () => {
    const targetVersion = {
      id: VERSION_ID,
      noteId: NOTE_ID,
      versionNo: 1,
      contentHash: "hash1",
      contentJson: { blocks: [{ type: "paragraph", content: "old" }] },
    };
    const mock = createMockExecutor({
      selectResult: [[{ id: NOTE_ID, currentVersionId: "current-v", workspaceId: WS_ID, title: "Test" }]],
      noteVersionsFindFirstQueue: [targetVersion],
      noteBlocksFindMany: [{ type: "paragraph", content: "old", ordinal: 0 }],
    });

    const result = await restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID);

    assert.ok(result);
    assert.equal(result!.version.id, VERSION_ID);
    assert.equal(result!.note.currentVersionId, VERSION_ID);
    assert.equal(result!.blocks.length, 1);
    assert.equal((result!.blocks[0] as NoteBlock).content, "old");
  });

  it("成功恢复后同步搜索索引", async () => {
    const targetVersion = {
      id: VERSION_ID,
      noteId: NOTE_ID,
      versionNo: 1,
      contentHash: "hash1",
      contentJson: { blocks: [{ type: "paragraph", content: "old" }] },
    };
    const mock = createMockExecutor({
      selectResult: [[{ id: NOTE_ID, currentVersionId: "current-v", workspaceId: WS_ID, title: "Test" }]],
      noteVersionsFindFirstQueue: [targetVersion],
      noteBlocksFindMany: [{ type: "paragraph", content: "old", ordinal: 0 }],
    });

    const result = await restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID);

    assert.ok(result);
    // 恢复成功后应调用 upsertSearchDocument → insert into searchDocuments
    assert.ok(
      mock._insertCalls.length > 0,
      "恢复后应更新搜索索引",
    );
    const searchUpsert = mock._insertCalls.find(
      (c: any) => c.data?.objectType === "note" && c.data?.objectId === NOTE_ID,
    );
    assert.ok(searchUpsert, "搜索索引 upsert 应针对恢复的笔记");
  });

  it("笔记不存在时不更新搜索索引", async () => {
    const mock = createMockExecutor({
      selectResult: [[]], // noteRows empty
    });

    const result = await restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID);

    assert.equal(result, null);
    assert.equal(
      mock._insertCalls.length,
      0,
      "笔记不存在时不应更新搜索索引",
    );
  });

  it("目标版本不存在时不更新搜索索引", async () => {
    const mock = createMockExecutor({
      selectResult: [[{ id: NOTE_ID, currentVersionId: "other-v", workspaceId: WS_ID }]],
      noteVersionsFindFirstQueue: [null], // target version not found
    });

    const result = await restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID);

    assert.equal(result, null);
    assert.equal(
      mock._insertCalls.length,
      0,
      "目标版本不存在时不应更新搜索索引",
    );
  });

  it("auto 标题模式下恢复后从版本内容重新推导标题", async () => {
    // 笔记标题为"旧自动标题"，但恢复到的版本内容是"恢复后的标题"
    const targetVersion = {
      id: VERSION_ID,
      noteId: NOTE_ID,
      versionNo: 1,
      contentHash: "hash1",
      contentJson: { blocks: [{ type: "heading", content: "恢复后的标题" }] },
    };
    const mock = createMockExecutor({
      selectResult: [[{
        id: NOTE_ID,
        currentVersionId: "current-v",
        workspaceId: WS_ID,
        title: "旧自动标题",
        titleSource: "auto",
      }]],
      noteVersionsFindFirstQueue: [targetVersion],
      noteBlocksFindMany: [{ type: "heading", content: "恢复后的标题", ordinal: 0 }],
    });

    const result = await restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID);

    assert.ok(result);
    assert.equal(result!.note.title, "恢复后的标题", "auto 标题应从恢复后的版本内容重新推导");
    assert.equal(result!.note.currentVersionId, VERSION_ID);
  });

  it("manual 标题模式下恢复后保持用户设定的标题不变", async () => {
    const targetVersion = {
      id: VERSION_ID,
      noteId: NOTE_ID,
      versionNo: 1,
      contentHash: "hash1",
      contentJson: { blocks: [{ type: "heading", content: "版本内容标题" }] },
    };
    const mock = createMockExecutor({
      selectResult: [[{
        id: NOTE_ID,
        currentVersionId: "current-v",
        workspaceId: WS_ID,
        title: "用户手动标题",
        titleSource: "manual",
      }]],
      noteVersionsFindFirstQueue: [targetVersion],
      noteBlocksFindMany: [{ type: "heading", content: "版本内容标题", ordinal: 0 }],
    });

    const result = await restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID);

    assert.ok(result);
    assert.equal(result!.note.title, "用户手动标题", "manual 标题不应被覆盖");
  });

  it("恢复后返回的 note.updatedAt 为更新后的时间", async () => {
    const targetVersion = {
      id: VERSION_ID,
      noteId: NOTE_ID,
      versionNo: 1,
      contentHash: "hash1",
      contentJson: { blocks: [] },
    };
    const oldUpdatedAt = new Date("2020-01-01T00:00:00Z");
    const mock = createMockExecutor({
      selectResult: [[{
        id: NOTE_ID,
        currentVersionId: "current-v",
        workspaceId: WS_ID,
        title: "Test",
        titleSource: "manual",
        updatedAt: oldUpdatedAt,
      }]],
      noteVersionsFindFirstQueue: [targetVersion],
      noteBlocksFindMany: [],
    });

    const result = await restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID);

    assert.ok(result);
    assert.ok(
      result!.note.updatedAt instanceof Date,
      "updatedAt 应为 Date 实例",
    );
    assert.ok(
      result!.note.updatedAt > oldUpdatedAt,
      "返回的 updatedAt 应为更新后的时间，而非旧值",
    );
  });

  // ─── CONC-05: baseVersionId 乐观并发检查 ─────────────────────────────

  it("baseVersionId 与 currentVersionId 不匹配时抛出 RevisionConflictError", async () => {
    const mock = createMockExecutor({
      selectResult: [[{
        id: NOTE_ID,
        currentVersionId: "server-v2",
        workspaceId: WS_ID,
        title: "Test",
        titleSource: "manual",
      }]],
    });

    await assert.rejects(
      () => restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID, "client-v1"),
      (err: unknown) => {
        assert.ok(err instanceof RevisionConflictError);
        assert.equal((err as RevisionConflictError).currentVersionId, "server-v2");
        return true;
      },
      "baseVersionId 不匹配时应抛出 RevisionConflictError",
    );
  });

  it("baseVersionId 匹配时正常恢复", async () => {
    const targetVersion = {
      id: VERSION_ID,
      noteId: NOTE_ID,
      versionNo: 1,
      contentHash: "hash1",
      contentJson: { blocks: [{ type: "paragraph", content: "old" }] },
    };
    const mock = createMockExecutor({
      selectResult: [[{
        id: NOTE_ID,
        currentVersionId: "current-v",
        workspaceId: WS_ID,
        title: "Test",
        titleSource: "manual",
      }]],
      noteVersionsFindFirstQueue: [targetVersion],
      noteBlocksFindMany: [{ type: "paragraph", content: "old", ordinal: 0 }],
    });

    const result = await restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID, "current-v");

    assert.ok(result);
    assert.equal(result!.version.id, VERSION_ID);
  });

  // ─── 软删除笔记不可恢复 ─────────────────────────────────────────────

  it("软删除的笔记恢复版本时返回 null", async () => {
    // selectResult 为空数组模拟 WHERE deleted_at IS NULL 过滤后无匹配
    const mock = createMockExecutor({
      selectResult: [[]], // noteRows empty — 软删除笔记被过滤
    });

    const result = await restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID);

    assert.equal(result, null);
    assert.equal(
      mock._insertCalls.length,
      0,
      "软删除笔记恢复时不应更新搜索索引",
    );
  });

  it("软删除笔记恢复时不抛出异常，静默返回 null", async () => {
    const mock = createMockExecutor({
      selectResult: [[]],
    });

    // 不应抛出异常，而是返回 null
    const result = await restoreNoteVersion(mock, NOTE_ID, VERSION_ID, WS_ID, USER_ID, "some-base");
    assert.equal(result, null);
  });
});
