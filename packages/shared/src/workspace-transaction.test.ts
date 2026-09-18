import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  WorkspaceTransactionScope,
  type ActiveWorkspaceTransaction,
  type WorkspaceContextQueryable,
} from "./workspace-transaction.ts";

const WORKSPACE_ID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const USER_ID = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";

class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

const dialect = new PgDialect();

function makeScope<TUserId extends string | null>(allowNullUserId: boolean) {
  return new WorkspaceTransactionScope<TUserId, WorkspaceContextQueryable>({
    label: "workspace",
    allowNullUserId,
    createError: (message) => new ScopeError(message),
  });
}

/** 捕获真正绑定到 SQL 语句上的参数（而非字符串化后的语句）。 */
function makeQueryable(
  echo: (params: readonly unknown[]) => readonly unknown[] = (params) => [
    { workspace_id: params[0], user_id: params[1] ?? null },
  ],
) {
  const seen: { text: string; params: readonly unknown[] }[] = [];
  const queryable: WorkspaceContextQueryable = {
    async execute(query: SQL) {
      const { sql: text, params } = dialect.sqlToQuery(query);
      seen.push({ text, params });
      return echo(params);
    },
  };
  return { queryable, seen };
}

test("normalize canonicalizes UUIDs and echoes the actor policy", () => {
  const apiScope = makeScope<string>(false);
  assert.deepEqual(
    apiScope.normalize({ workspaceId: ` ${WORKSPACE_ID} `, userId: USER_ID }),
    { workspaceId: WORKSPACE_ID.toLowerCase(), userId: USER_ID.toLowerCase() },
  );

  const workerScope = makeScope<string | null>(true);
  assert.deepEqual(
    workerScope.normalize({ workspaceId: WORKSPACE_ID, userId: null }),
    { workspaceId: WORKSPACE_ID.toLowerCase(), userId: null },
  );
});

test("normalize fails closed on malformed or disallowed contexts", () => {
  const apiScope = makeScope<string>(false);
  assert.throws(
    () => apiScope.normalize({ workspaceId: "not-a-uuid", userId: USER_ID }),
    ScopeError,
  );
  assert.throws(() => apiScope.normalize({ workspaceId: WORKSPACE_ID, userId: "" }), ScopeError);
  // API 侧不允许无 actor 的工作。
  assert.throws(
    () => apiScope.normalize({ workspaceId: WORKSPACE_ID, userId: null as never }),
    ScopeError,
  );
  assert.throws(
    () => apiScope.normalize(null as never),
    /transaction context is required/,
  );

  const workerScope = makeScope<string | null>(true);
  assert.throws(
    () => workerScope.normalize({ workspaceId: WORKSPACE_ID, userId: 7 as never }),
    ScopeError,
  );
});

test("assertCompatible refuses nested tenant or actor changes", () => {
  const scope = makeScope<string>(false);
  const active = scope.normalize({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  assert.doesNotThrow(() => scope.assertCompatible(active, { ...active }));
  assert.throws(
    () => scope.assertCompatible(active, { ...active, workspaceId: USER_ID }),
    /cannot change workspace or user context/,
  );
  assert.throws(
    () => scope.assertCompatible(active, { ...active, userId: WORKSPACE_ID }),
    /cannot change workspace or user context/,
  );
});

test("applyContext binds NULL (never an empty string) for an absent worker actor", async () => {
  const scope = makeScope<string | null>(true);
  const { queryable, seen } = makeQueryable();

  const applied = await scope.applyContext(queryable, { workspaceId: WORKSPACE_ID, userId: null });
  assert.deepEqual(applied, { workspaceId: WORKSPACE_ID.toLowerCase(), userId: null });
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.text, /set_config/);
  assert.deepEqual(seen[0]!.params, [WORKSPACE_ID.toLowerCase(), null]);
  // 空串会命中 `user_id = ''::uuid` 的计划期常量转换并抛
  // invalid input syntax for type uuid —— 必须确认绑定的是 null。
  assert.notEqual(seen[0]!.params[1], "");
});

test("applyContext rejects a database that echoes back different context", async () => {
  const scope = makeScope<string>(false);
  const { queryable } = makeQueryable(() => [
    { workspace_id: USER_ID, user_id: USER_ID },
  ]);
  await assert.rejects(
    () => scope.applyContext(queryable, { workspaceId: WORKSPACE_ID, userId: USER_ID }),
    /database rejected workspace transaction context/,
  );
});

test("requireActive reuses a live transaction and fails closed once it closes", async () => {
  const scope = makeScope<string>(false);
  const context = scope.normalize({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  const { queryable } = makeQueryable();
  const active: ActiveWorkspaceTransaction<string, WorkspaceContextQueryable> = {
    context,
    transaction: queryable,
    open: true,
  };

  assert.equal(scope.current(), undefined);
  assert.equal(scope.requireActive(context), undefined);

  await scope.run(active, async () => {
    assert.equal(scope.current(), active);
    assert.equal(scope.requireActive(context), active);
    // 同一上下文可以嵌套复用。
    await assert.doesNotReject(() =>
      scope.applyContext(scope.requireActive(context)!.transaction, context)
    );
    // 换租户必须立刻失败，而不是让查询跑在错误的 RLS 上下文里。
    await assert.rejects(
      () =>
        scope.applyContext(scope.requireActive(context)!.transaction, {
          workspaceId: USER_ID,
          userId: USER_ID,
        }),
      /cannot change workspace or user context/,
    );
    // 事务体结束后逃逸的闭包不得再借用该上下文。
    active.open = false;
    assert.equal(scope.current(), active);
    assert.throws(() => scope.requireActive(context), /is no longer active/);
  });

  // 离开 ALS 作用域后没有活跃事务，requireActive 不再报"已关闭"而是直接放行给
  // 调用方新开事务。
  assert.equal(scope.requireActive(context), undefined);
});

test("two scopes keep independent async-local stores", async () => {
  const first = makeScope<string>(false);
  const second = makeScope<string | null>(true);
  const context = first.normalize({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  const { queryable } = makeQueryable();
  const active: ActiveWorkspaceTransaction<string, WorkspaceContextQueryable> = {
    context,
    transaction: queryable,
    open: true,
  };

  await first.run(active, async () => {
    assert.equal(first.current(), active);
    assert.equal(second.current(), undefined);
  });
});
