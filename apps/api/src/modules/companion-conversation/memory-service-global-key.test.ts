/**
 * global 记忆的跨空间身份（`global_key`）写入端用例（doc 34 L9）。
 *
 * 为什么这一位不能留 NULL：0268 那两支同步触发器的 `WHEN` 条件是
 * `OLD.global_key IS NOT NULL OR NEW.global_key IS NOT NULL`，而 0267 的
 * "加入/重新加入空间时补铺"也只挑 `global_key IS NOT NULL` 的行。
 * 于是没有 key 的 global 记忆：改内容别处不跟、删了别处还在、新空间永远补不到——
 * 而 `PRODUCT.md:52` 写的是"在一处说过『我习惯晚上学习』，在另一个空间她同样记得"。
 *
 * 这里不连数据库：断言的是**交给 insert/update 的那一份载荷**，
 * 因为它才是"这一位有没有写上"的唯一现场。真实扩散由
 * `companion-memory-cross-space.integration.ts` 对着库验。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApiTransaction } from "../../db/client.ts";
import { upsertMemory, type MemoryScope } from "./memory-service.ts";

type CapturedCall =
  | { op: "insert"; values: Record<string, unknown> }
  | { op: "update"; set: Record<string, unknown> };

/** 一条看起来完整的库内行（`toContract` 读得到它需要的每一位）。 */
function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    userId: "33333333-3333-4333-8333-333333333333",
    kind: "preference",
    content: "习惯晚上学习",
    sourceEventId: null,
    sourceSessionId: null,
    userStated: true,
    userConfirmed: true,
    candidate: false,
    importance: 0.8,
    confidence: 0.9,
    scope: "workspace",
    pinned: false,
    archivedAt: null,
    dismissedAt: null,
    conflictGroup: null,
    embeddingStatus: "none",
    sourceType: "user_stated",
    globalKey: null,
    createdAt: new Date("2026-09-22T00:00:00.000Z"),
    updatedAt: new Date("2026-09-22T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * 链式查询替身：`select` 按队列给行，`insert`/`update` 把载荷记下来。
 * `execute`（冲突检测那条裸 SQL）一律回"没有相似记忆"，让用例只盯 key 这一件事。
 */
function fakeExecutor(selectQueues: Array<Array<Record<string, unknown>>>) {
  const calls: CapturedCall[] = [];
  let selectIndex = 0;
  // 插入的载荷要当成"回读到的那一行"还回去：`upsertMemory` 写完立刻用
  // `inserted[0].id` 去做冲突检测，替身若回空数组就是在替自己造假绿现场。
  let lastInserted: Record<string, unknown> | null = null;
  let lastSet: Record<string, unknown> | null = null;

  const chain = (terminal: () => unknown) => {
    const target: Record<string, unknown> = {};
    for (const step of ["from", "where", "orderBy", "values", "set", "returning", "limit"]) {
      target[step] = (...args: unknown[]) => {
        if (step === "values") {
          lastInserted = args[0] as Record<string, unknown>;
          calls.push({ op: "insert", values: lastInserted });
        }
        if (step === "set") {
          lastSet = { ...(lastSet ?? {}), ...(args[0] as Record<string, unknown>) };
          calls.push({ op: "update", set: lastSet });
        }
        return target;
      };
    }
    target.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(terminal()).then(resolve);
    return target;
  };

  const fake = {
    calls,
    select: () => {
      const rows = selectQueues[selectIndex++] ?? [];
      return chain(() => rows);
    },
    insert: () => chain(() => (lastInserted ? [lastInserted] : [])),
    // 更新之后服务会回读那一行：把刚设进去的字段并回最近的行，模拟"库里现在长这样"。
    update: () => chain(() => {
      const base = selectQueues[Math.max(selectIndex - 1, 0)]?.[0] ?? {};
      return [{ ...base, ...(lastSet ?? {}) }];
    }),
    execute: async () => [],
    delete: () => chain(() => []),
  };
  // 交给服务的那一半按 `ApiTransaction` 看，测试这一半还要看得见 `calls`。
  return fake as unknown as ApiTransaction & { calls: CapturedCall[] };
}

const SCOPE: MemoryScope = {
  workspaceId: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
};

function insertedValues(calls: CapturedCall[]): Record<string, unknown> {
  const call = calls.find((c) => c.op === "insert");
  if (!call || call.op !== "insert") throw new Error("没有走到插入：这一条 global 记忆根本没落笔");
  return call.values;
}

describe("global 记忆的 global_key 写入端", () => {
  it("新建一条 global 记忆：源行认领自己的 id 作为跨空间身份", async () => {
    const db = fakeExecutor([[]]);
    await upsertMemory(db, SCOPE, {
      kind: "preference",
      content: "习惯晚上学习",
      userStated: true,
      candidate: false,
      scope: "global",
    });

    const values = insertedValues(db.calls);
    assert.equal(typeof values.id, "string", "id 必须先生成，否则写不出与它同值的 key");
    assert.equal(values.globalKey, values.id, "源行的 key 就是它自己的 id（与 fanout 同一句话）");
  });

  it("新建一条 workspace 记忆：key 留 NULL，不参与跨空间同步", async () => {
    const db = fakeExecutor([[]]);
    await upsertMemory(db, SCOPE, {
      kind: "episodic",
      content: "今天跑完了一趟微旅程",
      scope: "workspace",
    });

    assert.equal(insertedValues(db.calls).globalKey, null);
  });

  it("没有 key 的既有记忆被改成 global：更新时补认领，不能继续留 NULL", async () => {
    const row = memoryRow({ id: "44444444-4444-4444-8444-444444444444", scope: "workspace" });
    const db = fakeExecutor([[row], [row]]);
    await upsertMemory(db, SCOPE, {
      kind: "preference",
      content: "习惯晚上学习",
      sourceEventId: "event-1",
      scope: "global",
    });

    const update = db.calls.find((c) => c.op === "update");
    assert.ok(update && update.op === "update", "命中同来源事件时应走更新而不是再插一条");
    assert.equal(update.set.globalKey, row.id, "改成 global 却没写 key，这条记忆哪里都去不了");
  });

  it("纠正一条带 key 的记忆：新行必须继承旧 key（换新 key 等于和副本脱钩）", async () => {
    const oldKey = "55555555-5555-4555-8555-555555555555";
    const oldRow = memoryRow({
      id: "66666666-6666-4666-8666-666666666666",
      scope: "global",
      globalKey: oldKey,
      sourceEventId: "event-1",
    });
    // 队列顺序就是 correctMemory 的读库顺序：
    // ① getMemory 取旧行 ② 取旧行那一位的 key ③ 删除后回读 ④ upsert 里"同来源事件是否已存在"
    const db = fakeExecutor([[oldRow], [{ globalKey: oldKey }], [], []]);
    const { correctMemory } = await import("./memory-service.ts");

    await correctMemory(db, SCOPE, oldRow.id as string, {
      content: "习惯晚上学习，但周末是上午",
    });

    const inserted = insertedValues(db.calls);
    assert.equal(inserted.globalKey, oldKey, "纠正后换了 key，其他空间那几份副本就再也对不上了");
    assert.notEqual(inserted.id, oldKey, "新行用自己的 id（继承的是身份，不是复用主键）");
  });
});
