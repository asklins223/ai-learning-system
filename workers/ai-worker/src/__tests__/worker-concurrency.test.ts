/**
 * QUEUE_CONCURRENCY 解析（设计 P1-13，2026-09-15 审计）。
 *
 * 该解析此前在 queue.ts 与 db.ts 各有一份逐字拷贝（db.ts 的注释却声称"永不漂移"）。
 * 现在两侧共用 lib/worker-concurrency.ts，本测试锁住解析语义，防止再次分叉。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_QUEUE_CONCURRENCY,
  INTERACTIVE_RESERVE_SLOTS,
  MAX_QUEUE_CONCURRENCY,
  computeClaimLimits,
  parseQueueConcurrency,
} from "../lib/worker-concurrency.ts";
import { QUEUE_CONCURRENCY } from "../queue.ts";

describe("parseQueueConcurrency", () => {
  it("未配置时回退默认", () => {
    assert.equal(parseQueueConcurrency(undefined), DEFAULT_QUEUE_CONCURRENCY);
    assert.equal(parseQueueConcurrency(""), DEFAULT_QUEUE_CONCURRENCY);
  });

  it("非法值回退默认：NaN / 小数 / 0 / 负数", () => {
    // 小数不能作为 SQL LIMIT 或并发槽位数；NaN 会让可用槽位恒为 0（worker 停摆）。
    assert.equal(parseQueueConcurrency("abc"), DEFAULT_QUEUE_CONCURRENCY);
    assert.equal(parseQueueConcurrency("2.5"), DEFAULT_QUEUE_CONCURRENCY);
    assert.equal(parseQueueConcurrency("0"), DEFAULT_QUEUE_CONCURRENCY);
    assert.equal(parseQueueConcurrency("-4"), DEFAULT_QUEUE_CONCURRENCY);
  });

  it("合法值生效，并夹取到上限", () => {
    assert.equal(parseQueueConcurrency("1"), 1);
    assert.equal(parseQueueConcurrency("8"), 8);
    assert.equal(parseQueueConcurrency("999"), MAX_QUEUE_CONCURRENCY);
    assert.equal(parseQueueConcurrency(String(MAX_QUEUE_CONCURRENCY)), MAX_QUEUE_CONCURRENCY);
  });

  it("queue.ts 导出的 QUEUE_CONCURRENCY 走同一解析器（不再有第二份实现）", () => {
    assert.equal(QUEUE_CONCURRENCY, parseQueueConcurrency(process.env.QUEUE_CONCURRENCY));
  });
});

describe("computeClaimLimits（交互车道保留）", () => {
  const C = DEFAULT_QUEUE_CONCURRENCY;

  it("空闲：后台拿不满，留一个槽给交互", () => {
    const limits = computeClaimLimits({ concurrency: C, inflightTotal: 0, inflightBackground: 0 });
    assert.equal(limits.interactiveLimit, C);
    assert.equal(limits.backgroundLimit, C - INTERACTIVE_RESERVE_SLOTS);
  });

  it("后台已占满非保留区：最后一个空槽只对交互开放", () => {
    const backgroundInflight = C - INTERACTIVE_RESERVE_SLOTS;
    const limits = computeClaimLimits({
      concurrency: C,
      inflightTotal: backgroundInflight,
      inflightBackground: backgroundInflight,
    });
    assert.equal(limits.interactiveLimit, INTERACTIVE_RESERVE_SLOTS);
    assert.equal(limits.backgroundLimit, 0);
  });

  it("交互在跑但后台未占满：后台仍可领非保留区", () => {
    const limits = computeClaimLimits({ concurrency: C, inflightTotal: 1, inflightBackground: 0 });
    assert.equal(limits.interactiveLimit, C - 1);
    assert.equal(limits.backgroundLimit, C - INTERACTIVE_RESERVE_SLOTS);
  });

  it("满负载：两类名额都是 0（不再认领）", () => {
    const limits = computeClaimLimits({ concurrency: C, inflightTotal: C, inflightBackground: C });
    assert.equal(limits.interactiveLimit, 0);
    assert.equal(limits.backgroundLimit, 0);
  });

  it("并发 1 的小部署不保留（保留会让后台永久停摆）", () => {
    const limits = computeClaimLimits({ concurrency: 1, inflightTotal: 0, inflightBackground: 0 });
    assert.equal(limits.interactiveLimit, 1);
    assert.equal(limits.backgroundLimit, 1);
  });

  it("后台名额夹取到空闲槽位（剩余槽位少于后台额度时）", () => {
    const limits = computeClaimLimits({ concurrency: C, inflightTotal: C - 1, inflightBackground: 0 });
    assert.equal(limits.interactiveLimit, 1);
    assert.equal(limits.backgroundLimit, 1);
  });
});
