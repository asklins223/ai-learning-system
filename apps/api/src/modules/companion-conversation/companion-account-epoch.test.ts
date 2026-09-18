/**
 * account epoch 读取的专门用例（此前该模块零覆盖）。
 *
 * 世代号是客户端拒绝「global off 之前的迟到事件」的唯一依据（合同 §5.2），
 * 读取端必须：无行 → 0、有行 → 精确数值、驱动层返回字符串时也要归一为 number。
 * 真实递增语义由 companion-account-epoch-postgres 集成测试覆盖。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCompanionAccountEpoch } from "./companion-account-epoch.ts";

function stubTx(rows: unknown[]): {
  tx: { execute(q: unknown): Promise<unknown> };
  queries: unknown[];
} {
  const queries: unknown[] = [];
  return {
    queries,
    tx: {
      execute(q: unknown) {
        queries.push(q);
        return Promise.resolve(rows);
      },
    },
  };
}

describe("getCompanionAccountEpoch", () => {
  it("无账号状态行 → 0（从未 global off 的用户世代恒 0）", async () => {
    const { tx } = stubTx([]);
    assert.equal(await getCompanionAccountEpoch(tx, "user-1"), 0);
  });

  it("驱动返回 bigint/int 文本时归一为 number", async () => {
    const { tx } = stubTx([{ epoch: "7" }]);
    const epoch = await getCompanionAccountEpoch(tx, "user-1");
    assert.equal(epoch, 7);
    assert.equal(typeof epoch, "number");
  });

  it("只发一条查询且带上 userId 参数", async () => {
    const { tx, queries } = stubTx([{ epoch: "0" }]);
    await getCompanionAccountEpoch(tx, "user-42");
    assert.equal(queries.length, 1, "不得额外查询（避免每事件多打一次库）");
    // drizzle sql 模板会保留参数值，确保 userId 真的进了查询而不是被漏掉。
    assert.equal(JSON.stringify(queries[0]).includes("user-42"), true);
  });

  it("epoch 为 0 的行与无行返回一致（都表示未撤销过）", async () => {
    const { tx } = stubTx([{ epoch: "0" }]);
    assert.equal(await getCompanionAccountEpoch(tx, "user-1"), 0);
  });
});
