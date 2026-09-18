/**
 * search-index.ts 单元测试
 *
 * 通过注入 mock database 测试真实函数逻辑：
 * 1. upsertSearchDocument 成功路径返回 true
 * 2. upsertSearchDocument 失败时返回 false（F-025: 不中断主流程）
 * 3. upsertSearchDocument 正确处理 null title/body
 * 4. upsertSearchDocument 正确处理缺失 metadata（使用空对象）
 * 5. deleteSearchDocument 成功时不抛异常
 * 6. deleteSearchDocument 失败时不抛异常（F-025: 不中断主流程）
 * 7. 验证 insert/delete 调用时传入的参数正确
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { upsertSearchDocument, deleteSearchDocument } from "../lib/search-index.ts";

type SearchDatabase = Parameters<typeof upsertSearchDocument>[1];

// ─── Mock 工厂 ────────────────────────────────────────────────────────────

function createSuccessMockDb(): {
  db: SearchDatabase;
  insertCalls: Record<string, unknown>[];
  deleteCalls: Record<string, unknown>[];
} {
  const insertCalls: Record<string, unknown>[] = [];
  const deleteCalls: Record<string, unknown>[] = [];

  const db = {
    insert() {
      return {
        values(values: Record<string, unknown>) {
          insertCalls.push(values);
          return {
            onConflictDoUpdate() {
              return Promise.resolve();
            },
          };
        },
      };
    },
    delete() {
      return {
        where() {
          deleteCalls.push({ called: true });
          return Promise.resolve();
        },
      };
    },
  } as unknown as SearchDatabase;

  return { db, insertCalls, deleteCalls };
}

function createFailingMockDb(error: Error): SearchDatabase {
  const db = {
    insert() {
      return {
        values() {
          return {
            onConflictDoUpdate() {
              return Promise.reject(error);
            },
          };
        },
      };
    },
    delete() {
      return {
        where() {
          return Promise.reject(error);
        },
      };
    },
  } as unknown as SearchDatabase;
  return db;
}

// ─── upsertSearchDocument 测试 ────────────────────────────────────────────

test("upsertSearchDocument 成功时返回 true", async () => {
  const { db } = createSuccessMockDb();
  const result = await upsertSearchDocument(
    {
      workspaceId: "ws-1",
      objectType: "note",
      objectId: "obj-1",
      title: "Test Title",
      body: "Test body content",
      metadata: { tag: "test" },
    },
    db,
  );
  assert.equal(result, true);
});

test("upsertSearchDocument 对 null title/body 正确处理", async () => {
  const { db, insertCalls } = createSuccessMockDb();
  await upsertSearchDocument(
    {
      workspaceId: "ws-1",
      objectType: "note",
      objectId: "obj-1",
      title: null,
      body: null,
    },
    db,
  );
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0].title, null);
  assert.equal(insertCalls[0].body, null);
});

test("upsertSearchDocument 对缺失 metadata 使用空对象", async () => {
  const { db, insertCalls } = createSuccessMockDb();
  await upsertSearchDocument(
    {
      workspaceId: "ws-1",
      objectType: "note",
      objectId: "obj-2",
      title: "Title",
      body: "Body",
    },
    db,
  );
  assert.equal(insertCalls.length, 1);
  assert.deepEqual(insertCalls[0].metadata, {});
});

test("upsertSearchDocument 正确传递所有参数到 insert", async () => {
  const { db, insertCalls } = createSuccessMockDb();
  await upsertSearchDocument(
    {
      workspaceId: "ws-99",
      objectType: "source",
      objectId: "src-1",
      title: "来源标题",
      body: "来源正文",
      metadata: { sourceType: "url" },
    },
    db,
  );
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0].workspaceId, "ws-99");
  assert.equal(insertCalls[0].objectType, "source");
  assert.equal(insertCalls[0].objectId, "src-1");
  assert.equal(insertCalls[0].title, "来源标题");
  assert.equal(insertCalls[0].body, "来源正文");
  assert.deepEqual(insertCalls[0].metadata, { sourceType: "url" });
  assert.ok(insertCalls[0].indexedAt instanceof Date);
});

test("upsertSearchDocument 失败时返回 false 而非抛异常（F-025）", async () => {
  const failingDb = createFailingMockDb(new Error("ECONNREFUSED"));
  const result = await upsertSearchDocument(
    {
      workspaceId: "ws-1",
      objectType: "note",
      objectId: "obj-1",
      title: "Title",
      body: "Body",
    },
    failingDb,
  );
  assert.equal(result, false);
});

test("upsertSearchDocument 对所有 objectType 类型都能正常工作", async () => {
  const { db } = createSuccessMockDb();
  for (const objectType of ["note", "source"] as const) {
    const result = await upsertSearchDocument(
      {
        workspaceId: "ws-1",
        objectType,
        objectId: `obj-${objectType}`,
        title: `Title for ${objectType}`,
        body: `Body for ${objectType}`,
      },
      db,
    );
    assert.equal(result, true, `objectType=${objectType} 应返回 true`);
  }
});

test("upsertSearchDocument 空字符串 title/body 正确传递", async () => {
  const { db, insertCalls } = createSuccessMockDb();
  await upsertSearchDocument(
    {
      workspaceId: "ws-1",
      objectType: "note",
      objectId: "obj-1",
      title: "",
      body: "",
    },
    db,
  );
  // 空字符串不是 null，应直接传递
  assert.equal(insertCalls[0].title, "");
  assert.equal(insertCalls[0].body, "");
});

// ─── deleteSearchDocument 测试 ────────────────────────────────────────────

test("deleteSearchDocument 成功时正常返回 void", async () => {
  const { db, deleteCalls } = createSuccessMockDb();
  await deleteSearchDocument("ws-1", "note", "obj-1", db);
  assert.equal(deleteCalls.length, 1);
});

test("deleteSearchDocument 失败时不抛异常（F-025）", async () => {
  const failingDb = createFailingMockDb(new Error("connection lost"));
  // Should not throw
  await deleteSearchDocument("ws-1", "note", "obj-1", failingDb);
  assert.ok(true);
});

test("deleteSearchDocument 对不同 objectType 都能正常工作", async () => {
  const { db } = createSuccessMockDb();
  for (const objectType of ["note", "source"] as const) {
    await deleteSearchDocument("ws-1", objectType, `obj-${objectType}`, db);
  }
  assert.ok(true);
});

// ─── F-025 契约验证 ───────────────────────────────────────────────────────

test("F-025: upsertSearchDocument 的错误处理逻辑确保索引失败不影响业务事务", async () => {
  const operations: string[] = [];

  const businessOp = async () => {
    operations.push("business-start");
    operations.push("business-commit");
    return true;
  };

  const failingDb = createFailingMockDb(new Error("index failed"));
  const indexOp = async () => {
    return upsertSearchDocument(
      {
        workspaceId: "ws-1",
        objectType: "note",
        objectId: "obj-1",
        title: "T",
        body: "B",
      },
      failingDb,
    );
  };

  const businessResult = await businessOp();
  const indexResult = await indexOp();

  assert.equal(businessResult, true);
  assert.equal(indexResult, false);
  assert.deepEqual(operations, [
    "business-start",
    "business-commit",
  ]);
});

test("F-025: deleteSearchDocument 的错误处理逻辑确保索引删除失败不影响业务事务", async () => {
  const operations: string[] = [];

  const businessOp = async () => {
    operations.push("business-start");
    operations.push("business-commit");
    return true;
  };

  const failingDb = createFailingMockDb(new Error("delete failed"));
  const indexOp = async () => {
    await deleteSearchDocument("ws-1", "note", "obj-1", failingDb);
    operations.push("delete-completed-no-throw");
  };

  const businessResult = await businessOp();
  await indexOp();

  assert.equal(businessResult, true);
  assert.deepEqual(operations, [
    "business-start",
    "business-commit",
    "delete-completed-no-throw",
  ]);
});
