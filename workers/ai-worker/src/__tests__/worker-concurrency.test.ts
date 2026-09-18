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
  MAX_QUEUE_CONCURRENCY,
  parseQueueConcurrency,
} from "../lib/worker-concurrency.ts";
import { QUEUE_CONCURRENCY } from "../queue.ts";

describe("parseQueueConcurrency", () => {
  it("未配置时回退默认（3）", () => {
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
