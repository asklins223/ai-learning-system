/**
 * 拓扑快照 TTL 缓存单测（AI-perf #4，2026-09-15 审计）。
 *
 * 背景：`GET /v3/understanding/topology` 此前每次都重建整份快照（15 个串行
 * await / 16 条语句）之后才比较 If-None-Match —— 304 也要付全额 DB 代价。
 * 新增的进程内 TTL 缓存让命中路径完全不开事务。
 *
 * 本测试只覆盖缓存的**纯内存语义**（不触 DB）：
 * - TTL=0 关闭缓存
 * - 命中返回同一对象
 * - 过期后不再命中
 * - 键含 workspaceId + userId（不跨用户/跨租户命中）
 * - 超过上限时淘汰最早条目（内存有界）
 * - 非法 TTL 回退默认值
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { UnderstandingTopologySnapshotV3 } from "@ailearn/shared";
import {
  readTopologySnapshotCache,
  resetTopologySnapshotCacheForTests,
  resolveTopologySnapshotCacheTtlMs,
  writeTopologySnapshotCache,
} from "../modules/understanding-v3/topology-repository.ts";

const originalTtl = process.env.TOPOLOGY_SNAPSHOT_CACHE_MS;

function setTtl(value: string | undefined): void {
  if (value === undefined) delete process.env.TOPOLOGY_SNAPSHOT_CACHE_MS;
  else process.env.TOPOLOGY_SNAPSHOT_CACHE_MS = value;
}

/** 缓存只用 topologyRevision 做断言，其余字段与缓存逻辑无关。 */
function snapshotOf(revision: string): UnderstandingTopologySnapshotV3 {
  return { version: 3, workspaceId: "w", topologyRevision: revision } as unknown as UnderstandingTopologySnapshotV3;
}

const WS = "11111111-1111-1111-1111-111111111111";
const WS_OTHER = "44444444-4444-4444-4444-444444444444";
const USER_A = "22222222-2222-2222-2222-222222222222";
const USER_B = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  resetTopologySnapshotCacheForTests();
});

afterEach(() => {
  resetTopologySnapshotCacheForTests();
  setTtl(originalTtl);
});

describe("topology snapshot TTL cache", () => {
  it("TTL=0 时关闭缓存：write 不落、read 恒 null", () => {
    setTtl("0");
    writeTopologySnapshotCache({ workspaceId: WS, userId: USER_A }, snapshotOf("v3-a"));
    assert.equal(readTopologySnapshotCache({ workspaceId: WS, userId: USER_A }), null);
  });

  it("write 后 read 命中同一对象（同一 revision → ETag 304 可达）", () => {
    setTtl("10000");
    const snapshot = snapshotOf("v3-a");
    writeTopologySnapshotCache({ workspaceId: WS, userId: USER_A }, snapshot);
    assert.equal(readTopologySnapshotCache({ workspaceId: WS, userId: USER_A }), snapshot);
  });

  it("过期后不再命中", async () => {
    setTtl("1");
    writeTopologySnapshotCache({ workspaceId: WS, userId: USER_A }, snapshotOf("v3-a"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(readTopologySnapshotCache({ workspaceId: WS, userId: USER_A }), null);
  });

  it("缓存键含 userId 与 workspaceId：不跨用户、不跨租户命中", () => {
    setTtl("10000");
    writeTopologySnapshotCache({ workspaceId: WS, userId: USER_A }, snapshotOf("v3-a"));
    assert.equal(readTopologySnapshotCache({ workspaceId: WS, userId: USER_B }), null);
    assert.equal(readTopologySnapshotCache({ workspaceId: WS_OTHER, userId: USER_A }), null);
    assert.ok(readTopologySnapshotCache({ workspaceId: WS, userId: USER_A }));
  });

  it("超过 64 条上限时淘汰最早插入的条目（内存有界）", () => {
    setTtl("10000");
    const ctxOf = (index: number) => ({
      workspaceId: "55555555-5555-5555-5555-555555555555",
      userId: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    });
    for (let i = 0; i < 64; i += 1) {
      writeTopologySnapshotCache(ctxOf(i), snapshotOf(`v3-${i}`));
    }
    assert.ok(readTopologySnapshotCache(ctxOf(0)), "未超限时最早的一条仍在");
    // 第 65 条触发淘汰。
    writeTopologySnapshotCache(ctxOf(64), snapshotOf("v3-64"));
    assert.equal(readTopologySnapshotCache(ctxOf(0)), null, "最早的一条应已被淘汰");
    assert.ok(readTopologySnapshotCache(ctxOf(64)), "最新写入的一条必须仍在");
  });

  it("TTL 解析：空/非法/负数回退 10s，0 表示关闭", () => {
    setTtl("abc");
    assert.equal(resolveTopologySnapshotCacheTtlMs(), 10_000);
    setTtl(undefined);
    assert.equal(resolveTopologySnapshotCacheTtlMs(), 10_000);
    setTtl("-5");
    assert.equal(resolveTopologySnapshotCacheTtlMs(), 10_000);
    setTtl("0");
    assert.equal(resolveTopologySnapshotCacheTtlMs(), 0);
    setTtl("2500");
    assert.equal(resolveTopologySnapshotCacheTtlMs(), 2_500);
  });
});
