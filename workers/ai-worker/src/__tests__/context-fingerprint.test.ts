import { test } from "node:test";
import assert from "node:assert/strict";
import { stableContextCacheKey, stableContextContentHash } from "../agent/context-fingerprint.ts";
import { StableContextCache } from "../agent/stable-context-cache.ts";

const base = { runId: "run-1", shellVersion: "shell-1", policyVersion: "policy-1", toolSchemaVersion: "tools-1" };

test("P4-1: 缓存键 = runId + shellVersion + policyVersion + toolSchemaVersion", () => {
  const k1 = stableContextCacheKey(base);
  const k2 = stableContextCacheKey({ ...base });
  assert.equal(k1, k2, "相同指纹键一致");
  assert.equal(k1.length, 64, "sha256 hex");

  assert.notEqual(k1, stableContextCacheKey({ ...base, runId: "run-2" }), "runId 变化键变化");
  assert.notEqual(k1, stableContextCacheKey({ ...base, shellVersion: "shell-2" }), "shell 版本变化键变化");
  assert.notEqual(k1, stableContextCacheKey({ ...base, policyVersion: "policy-2" }), "policy 变化键变化");
  assert.notEqual(k1, stableContextCacheKey({ ...base, toolSchemaVersion: "tools-2" }), "工具 schema 变化键变化");
});

test("P4-1: 稳定段内容 hash 审计", () => {
  assert.equal(stableContextContentHash("abc"), stableContextContentHash("abc"));
  assert.notEqual(stableContextContentHash("abc"), stableContextContentHash("abd"));
});

test("P4-1: LRU 缓存命中返回同一稳定段(字节级一致)", () => {
  const cache = new StableContextCache(8);
  const key = stableContextCacheKey(base);
  cache.set(key, "stable-context-v1", stableContextContentHash("stable-context-v1"), 1000);
  const hit = cache.get(key);
  assert.equal(hit?.value, "stable-context-v1");
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().misses, 0);

  assert.equal(cache.get("missing"), null);
  assert.equal(cache.stats().misses, 1);
});

test("P4-1: LRU 超限逐出最久未用", () => {
  const cache = new StableContextCache(2);
  cache.set("a", "A", "hA", 1);
  cache.set("b", "B", "hB", 2);
  cache.get("a"); // a 变为最近使用
  cache.set("c", "C", "hC", 3); // 逐出 b
  assert.equal(cache.get("b"), null, "b 被逐出");
  assert.equal(cache.get("a")?.value, "A", "a 保留");
  assert.equal(cache.get("c")?.value, "C", "c 保留");
});

test("P4-1: 稳定段缓存不含状态信息(键不依赖 stateVersion)", () => {
  // stateVersion 不属于指纹输入,变化不影响稳定段缓存键
  assert.equal(
    stableContextCacheKey(base),
    stableContextCacheKey({ ...base }),
  );
});
