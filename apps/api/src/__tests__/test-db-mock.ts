/**
 * QUAL-20 修复：类型安全的 DB mock 工具。
 *
 * 替代测试中的 `db as any` 猴子补丁模式，提供类型安全的方法覆盖。
 *
 * 用法：
 * ```typescript
 * const mock = createDbMock();
 * mock.overrideQuery('learningCards', 'findMany', async () => fixture.cards);
 * mock.overrideTransaction(mock.createPassthroughTransaction(wsId, userId));
 * // ... 运行测试 ...
 * mock.restore();
 * ```
 *
 * 后续改进：迁移到依赖注入模式（将 db 作为参数传入 service 函数），
 * 或使用 vitest/sinon 等专业 mock 框架替代运行时猴子补丁。
 */

import { db } from "../db/client.ts";

/**
 * 创建类型安全的 DB mock，支持覆盖查询方法并在测试后恢复。
 * 避免使用 `db as any` 绕过类型系统。
 */
export function createDbMock() {
  // 保存原始方法的引用，用于恢复
  const originals = new Map<string, unknown>();
  // 标记是否已恢复
  let restored = false;

  /**
   * 覆盖 db.query[table][method] 的实现。
   * 类型安全：table 和 method 参数有类型约束。
   */
  function overrideQuery(
    table: keyof typeof db.query,
    method: "findMany" | "findFirst",
    impl: (...args: never[]) => unknown,
  ): void {
    if (restored) throw new Error("DbMock already restored");
    const key = `query.${table}.${method}`;
    const tableObj = db.query[table] as unknown as Record<string, unknown>;
    if (!originals.has(key)) {
      originals.set(key, tableObj[method]);
    }
    tableObj[method] = impl;
  }

/**
 * 创建一个 passthrough 事务 mock，使 withWorkspaceTransaction 内部的
 * db.transaction 调用直接在 mock tx 上运行。
 *
 * mock tx 提供：
 * - execute: 返回 workspace_id/user_id session 变量（setApiTransactionContext 需要）
 * - query/select/insert/update/delete: 委托到 db 的对应方法
 *   （可被 overrideQuery/overrideSelect 覆盖）
 *
 * 这是替代测试中 `passthroughTransaction()` 函数的类型安全版本。
 */
function createPassthroughTransaction(workspaceId: string, userId: string) {
  const mockExecute = async () => [{ workspace_id: workspaceId, user_id: userId }];
  // 委托到 db 的方法，使 overrideQuery 等覆盖生效
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    execute: mockExecute,
    query: db.query,
    select: db.select.bind(db),
    insert: db.insert.bind(db),
    update: db.update.bind(db),
    delete: db.delete.bind(db),
    transaction: async (fn: (innerTx: unknown) => Promise<unknown>) => fn(tx),
  };
  return async (run: (tx: any) => Promise<unknown>) => run(tx);
}

/**
 * 覆盖 db.transaction 的实现。
 */
function overrideTransaction(
  impl: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>,
): void {
  if (restored) throw new Error("DbMock already restored");
  if (!originals.has("transaction")) {
    originals.set("transaction", db.transaction);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).transaction = impl;
}

  /**
   * 覆盖 db.delete 的实现。
   */
  function overrideDelete(
    impl: (table: unknown) => unknown,
  ): void {
    if (restored) throw new Error("DbMock already restored");
    if (!originals.has("delete")) {
      originals.set("delete", db.delete);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).delete = impl;
  }

  /**
   * 覆盖 db.insert 的实现。
   */
  function overrideInsert(
    impl: (table: unknown) => unknown,
  ): void {
    if (restored) throw new Error("DbMock already restored");
    if (!originals.has("insert")) {
      originals.set("insert", db.insert);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).insert = impl;
  }

  /**
   * 覆盖 db.update 的实现。
   */
  function overrideUpdate(
    impl: (table: unknown) => unknown,
  ): void {
    if (restored) throw new Error("DbMock already restored");
    if (!originals.has("update")) {
      originals.set("update", db.update);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).update = impl;
  }

  /**
   * 覆盖 db.select 的实现。
   */
  function overrideSelect(
    impl: (...args: never[]) => unknown,
  ): void {
    if (restored) throw new Error("DbMock already restored");
    if (!originals.has("select")) {
      originals.set("select", db.select);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).select = impl;
  }

  /**
   * 恢复所有被覆盖的方法到原始实现。
   * 必须在测试 afterEach 中调用以避免测试间污染。
   */
  function restore(): void {
    if (restored) return;
    for (const [key, original] of originals) {
      if (key.startsWith("query.")) {
        const [, table, method] = key.split(".");
        const tableObj = db.query[table as keyof typeof db.query] as unknown as Record<string, unknown>;
        tableObj[method] = original;
      } else if (key === "transaction") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).transaction = original;
      } else if (key === "delete") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).delete = original;
      } else if (key === "insert") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).insert = original;
      } else if (key === "update") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).update = original;
      } else if (key === "select") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).select = original;
      }
    }
    originals.clear();
    restored = true;
  }

  return { overrideQuery, overrideTransaction, overrideDelete, overrideInsert, overrideUpdate, overrideSelect, restore, createPassthroughTransaction };
}
