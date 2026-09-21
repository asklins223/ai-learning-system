import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  derivePracticeItemFromCanonicalAnswer,
  practiceItemCrossRefError,
} from "./card-generation-v2-contracts.ts";

/**
 * v23 D6：作者没交练习件时的**零模型派生**。
 * 这里守的是两条边界：有内在结构才派生（不派生 = 不编造），以及派生结果
 * 必须过交叉校验（否则进判分器就是一道永远判不对的题）。
 */
describe("derivePracticeItemFromCanonicalAnswer", () => {
  it("ordered_steps → 排序题，顺序与单元全部沿用作者写下的内容", () => {
    const item = derivePracticeItemFromCanonicalAnswer({
      kind: "ordered_steps",
      steps: [
        { unitId: "s1", text: "提起灭火器" },
        { unitId: "s2", text: "拔掉保险销" },
        { unitId: "s3", text: "握住喷管对准根部" },
      ],
    } as never);
    assert.ok(item);
    assert.equal(item.kind, "ordering");
    assert.deepEqual(
      item.kind === "ordering" ? item.correctUnitOrder : [],
      ["s1", "s2", "s3"],
    );
    assert.equal(practiceItemCrossRefError(item), null);
  });

  it("mapping → 配对题，左右两端沿用作者的对应关系", () => {
    const item = derivePracticeItemFromCanonicalAnswer({
      kind: "mapping",
      pairs: [
        { unitId: "m1", left: "提", right: "提起灭火器" },
        { unitId: "m2", left: "拔", right: "拔掉保险销" },
      ],
    } as never);
    assert.ok(item);
    assert.equal(item.kind, "matching");
    assert.equal(practiceItemCrossRefError(item), null);
  });

  it("text / bullets 这类没有内在次序的答案不派生（派生就得编干扰项）", () => {
    assert.equal(
      derivePracticeItemFromCanonicalAnswer({
        kind: "bullets",
        items: [
          { unitId: "b1", text: "要点一" },
          { unitId: "b2", text: "要点二" },
        ],
      } as never),
      undefined,
    );
    assert.equal(
      derivePracticeItemFromCanonicalAnswer({
        kind: "text",
        unit: { unitId: "t1", text: "一条定义" },
      } as never),
      undefined,
    );
  });

  it("只有一步 / 只有一对也派生不出来（没有可重排的空间）", () => {
    assert.equal(
      derivePracticeItemFromCanonicalAnswer({
        kind: "ordered_steps",
        steps: [{ unitId: "s1", text: "唯一一步" }],
      } as never),
      undefined,
    );
  });
});
