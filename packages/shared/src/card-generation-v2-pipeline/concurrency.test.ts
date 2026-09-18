/**
 * 阶段内有界并发（2026-09-17 性能改造）回归。
 *
 * 契约：**保序 + 有界 + 快速失败**。
 * - 保序是硬要求：author 的候选顺序决定 dedup 谁保留谁落选、事件顺序、落库顺序，
 *   并发化不得改变这些（否则质量裁决结果会随调度顺序漂移）。
 * - 有界是成本/配额要求：N=20 时不得一次性向 provider 发出 20 个请求。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_V2_STAGE_CONCURRENCY,
  MAX_V2_STAGE_CONCURRENCY,
  mapWithConcurrency,
  resolveV2StageConcurrency,
} from "./concurrency.ts";

test("保序：返回值下标与输入下标严格对应（完成顺序打乱也不影响）", async () => {
  const items = [40, 10, 30, 20, 5];
  const result = await mapWithConcurrency(items, 5, async (ms, index) => {
    await new Promise((r) => setTimeout(r, ms));
    return `item-${index}`;
  });
  assert.deepEqual(result, ["item-0", "item-1", "item-2", "item-3", "item-4"]);
});

test("有界：在途调用数永不超过 limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await mapWithConcurrency(items, 4, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return null;
  });
  assert.equal(peak, 4);
});

test("有界：limit 大于元素数时只开元素数个并发行", async () => {
  let peak = 0;
  let inFlight = 0;
  await mapWithConcurrency([1, 2], 16, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return null;
  });
  assert.equal(peak, 2);
});

test("快速失败：任一任务抛错则整体 reject，且不再启动新任务", async () => {
  const started: number[] = [];
  await assert.rejects(
    () => mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 2, async (_item, index) => {
      started.push(index);
      if (index === 1) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 10));
      return index;
    }),
    /boom/,
  );
  // 下标 0/1 先启动；1 抛错后不再补充新任务（其余在途任务允许跑完）。
  assert.ok(started.includes(0));
  assert.ok(started.includes(1));
  assert.ok(!started.includes(7), `不应启动尾部任务，实际启动：${started.join(",")}`);
});

test("空输入不启动任何任务", async () => {
  let called = 0;
  const result = await mapWithConcurrency([], 4, async () => {
    called += 1;
    return 1;
  });
  assert.deepEqual(result, []);
  assert.equal(called, 0);
});

test("配置解析：非法值回退默认，超上界被夹紧", () => {
  assert.equal(resolveV2StageConcurrency(undefined), DEFAULT_V2_STAGE_CONCURRENCY);
  assert.equal(resolveV2StageConcurrency("abc"), DEFAULT_V2_STAGE_CONCURRENCY);
  assert.equal(resolveV2StageConcurrency("0"), DEFAULT_V2_STAGE_CONCURRENCY);
  assert.equal(resolveV2StageConcurrency("-3"), DEFAULT_V2_STAGE_CONCURRENCY);
  assert.equal(resolveV2StageConcurrency("2.5"), DEFAULT_V2_STAGE_CONCURRENCY);
  assert.equal(resolveV2StageConcurrency("6"), 6);
  assert.equal(resolveV2StageConcurrency("9999"), MAX_V2_STAGE_CONCURRENCY);
});
