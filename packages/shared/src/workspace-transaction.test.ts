import assert from "node:assert/strict";
import { test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  assertOutsideWorkspaceTransaction,
  ExternalCallInsideTransactionError,
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

// ── 外部调用边界那道检查（D5 §5.2 第二件）────────────────────────────────

test("外部调用边界：事务外放行，事务内拒绝并记一条开发错误", async () => {
  const scope = makeScope<string>(false);
  const context = scope.normalize({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  const { queryable } = makeQueryable();
  const active: ActiveWorkspaceTransaction<string, WorkspaceContextQueryable> = {
    context, transaction: queryable, open: true,
  };
  const reported: string[] = [];
  const check = (activeTransaction: unknown) => assertOutsideWorkspaceTransaction({
    boundary: "AI 模型调用", caller: "workspace-transaction.test", activeTransaction,
    reportDevelopmentError: (message) => reported.push(message),
  });

  // 没有活动事务：一个字都不记、不抛。
  check(scope.current());
  assert.deepEqual(reported, []);

  await scope.run(active, async () => {
    assert.throws(() => check(scope.current()), ExternalCallInsideTransactionError);
    assert.equal(reported.length, 1);
    // 开发错误必须自带"是谁、在哪、该改成什么"，否则日志里那条等同于"你错了"。
    assert.match(reported[0], /AI 模型调用/);
    assert.match(reported[0], /workspace-transaction\.test/);
    assert.match(reported[0], /短事务准备/);
  });

  // 事务作用域退出之后放行（同一条检查在两个时点给出不同答案，才算它在读作用域）。
  reported.length = 0;
  assert.doesNotThrow(() => check(scope.current()));
  assert.deepEqual(reported, []);
});

test("隐式外层事务也要被拒：判据不是「这段代码里有没有 transaction 字样」", async () => {
  const scope = makeScope<string>(false);
  const context = scope.normalize({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  const { queryable } = makeQueryable();
  const active: ActiveWorkspaceTransaction<string, WorkspaceContextQueryable> = {
    context, transaction: queryable, open: true,
  };

  // 三层深：最外面开了事务，中间只是普通 await，最里面那个函数根本不知道
  // 自己在事务里——今天那两处"事务内调模型"就是这个形状（D5 §5.1）。
  async function leafSendsExternalCall(): Promise<void> {
    assertOutsideWorkspaceTransaction({
      boundary: "转写", caller: "深层函数（未接收 tx 参数）", activeTransaction: scope.current(),
    });
  }
  async function middleLayer(): Promise<void> {
    await leafSendsExternalCall();
  }

  await scope.run(active, async () => {
    await assert.rejects(() => middleLayer(), ExternalCallInsideTransactionError);
  });
  // 事务之外同一个深层函数正常放行——"被拒"来自作用域，不是来自函数本身。
  await assert.doesNotReject(() => middleLayer());
});
