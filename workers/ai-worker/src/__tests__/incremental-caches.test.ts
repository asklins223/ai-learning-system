import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryArtifactCache } from "../agent/unit-artifact-cache.ts";
import {
  computeBundleCacheKey,
  computeCandidateCacheKey,
  computeCriticCacheKey,
  claimHash,
  getBundleExtraction,
  putBundleExtraction,
  getCandidate,
  putCandidate,
  getCriticVerdict,
  putCriticVerdict,
} from "../agent/incremental-caches.ts";

test("P5-1: bundle cache key 稳定且内容变化失效", () => {
  const base = { workspaceId: "w1", bundleId: "b1", bundleContentHash: "h1", modelVersion: "m1", promptVersion: "p1" };
  assert.equal(computeBundleCacheKey(base), computeBundleCacheKey(base));
  assert.notEqual(computeBundleCacheKey(base), computeBundleCacheKey({ ...base, bundleContentHash: "h2" }), "内容 hash 变化 → key 变化(版本变化失效)");
  assert.notEqual(computeBundleCacheKey(base), computeBundleCacheKey({ ...base, bundleId: "b2" }));
});

test("P5-1/2/3: key 不含 runId——跨 run 相同内容/相同 claim 命中(跨版本复用)", () => {
  const bundleKeyA = computeBundleCacheKey({ workspaceId: "w1", bundleId: "b1", bundleContentHash: "h1", modelVersion: "m1", promptVersion: "p1" });
  const bundleKeyB = computeBundleCacheKey({ workspaceId: "w1", bundleId: "b1", bundleContentHash: "h1", modelVersion: "m1", promptVersion: "p1" });
  assert.equal(bundleKeyA, bundleKeyB, "跨 run 相同 bundle 内容 → 同一 key(命中重放)");

  const candA = computeCandidateCacheKey({ workspaceId: "w1", evidenceContentHash: "e1", modelVersion: "m1", promptVersion: "p1" });
  const candB = computeCandidateCacheKey({ workspaceId: "w1", evidenceContentHash: "e1", modelVersion: "m1", promptVersion: "p1" });
  assert.equal(candA, candB, "跨 run 相同源证据 → 同一 key");

  const criticA = computeCriticCacheKey({ workspaceId: "w1", claimHash: claimHash("同一条 claim"), criticMode: "light", promptVersion: "p1" });
  const criticB = computeCriticCacheKey({ workspaceId: "w1", claimHash: claimHash("同一条 claim"), criticMode: "light", promptVersion: "p1" });
  assert.equal(criticA, criticB, "跨 run 同 claim → 同一 key(旧 verdict 复用)");

  // 跨 workspace 仍隔离
  assert.notEqual(criticA, computeCriticCacheKey({ workspaceId: "w2", claimHash: claimHash("同一条 claim"), criticMode: "light", promptVersion: "p1" }));

  // 配置维度语义:promptVersion 变化 → key 变化(升级提示词正确失效)
  assert.notEqual(criticA, computeCriticCacheKey({ workspaceId: "w1", claimHash: claimHash("同一条 claim"), criticMode: "light", promptVersion: "p2" }));
  assert.notEqual(bundleKeyA, computeBundleCacheKey({ workspaceId: "w1", bundleId: "b1", bundleContentHash: "h1", modelVersion: "m2", promptVersion: "p1" }), "modelVersion 升级失效");
});

test("P5-1: 命中重放 + 写入", () => {
  const cache = createMemoryArtifactCache();
  const key = computeBundleCacheKey({ workspaceId: "w1", bundleId: "b1", bundleContentHash: "h1", modelVersion: "m1", promptVersion: "p1" });
  assert.equal(getBundleExtraction(cache, key), undefined, "冷启动无命中");
  putBundleExtraction(cache, key, { candidates: ["c1"] }, "m1", "p1");
  assert.deepEqual(getBundleExtraction(cache, key), { candidates: ["c1"] });
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().writes, 1);
});

test("P5-2: candidate 同源同内容命中,源变化失效", () => {
  const cache = createMemoryArtifactCache();
  const k1 = computeCandidateCacheKey({ workspaceId: "w1", evidenceContentHash: "e1", modelVersion: "m1", promptVersion: "p1" });
  const k2 = computeCandidateCacheKey({ workspaceId: "w1", evidenceContentHash: "e2", modelVersion: "m1", promptVersion: "p1" });
  putCandidate(cache, k1, { claim: "c1" }, "m1", "p1");
  assert.deepEqual(getCandidate(cache, k1), { claim: "c1" }, "同源同内容命中");
  assert.equal(getCandidate(cache, k2), undefined, "源内容变化失效");
});

test("P5-3: critic verdict 按 claim 哈希命中,同 Claim 不重复审查", () => {
  const cache = createMemoryArtifactCache();
  const claim = "监督学习需要带标签的数据";
  const k = computeCriticCacheKey({ workspaceId: "w1", claimHash: claimHash(claim), criticMode: "light", promptVersion: "p1" });
  putCriticVerdict(cache, k, { verdict: "supported", severity: "ok" }, "m1", "p1");
  assert.deepEqual(getCriticVerdict(cache, k), { verdict: "supported", severity: "ok" });

  // 不同 mode 不串(key 含 criticMode)
  const kFull = computeCriticCacheKey({ workspaceId: "w1", claimHash: claimHash(claim), criticMode: "full", promptVersion: "p1" });
  assert.notEqual(k, kFull);
  assert.equal(getCriticVerdict(cache, kFull), undefined);
});

test("claimHash 规范化:空白差异不影响命中", () => {
  assert.equal(claimHash("监督学习  需要 数据"), claimHash("监督学习 需要 数据"));
  assert.notEqual(claimHash("监督学习"), claimHash("无监督学习"));
});

test("claimHash 超长拒绝(security MEDIUM 加固)", () => {
  assert.throws(() => claimHash("x".repeat(4097)), /claim 过长/);
  assert.equal(claimHash("x".repeat(4096)).length, 64);
});

test("createMemoryArtifactCache(maxSize) FIFO 驱逐(security MEDIUM 加固)", () => {
  const cache = createMemoryArtifactCache(2);
  cache.put({ cacheKey: "k1", artifact: 1, cachedAt: Date.now(), modelVersion: "m", promptVersion: "p", unitKind: "u" });
  cache.put({ cacheKey: "k2", artifact: 2, cachedAt: Date.now(), modelVersion: "m", promptVersion: "p", unitKind: "u" });
  cache.put({ cacheKey: "k3", artifact: 3, cachedAt: Date.now(), modelVersion: "m", promptVersion: "p", unitKind: "u" });
  assert.equal(cache.stats().size, 2, "超过 maxSize 后保持容量");
  assert.equal(cache.get("k1"), undefined, "最旧条目被驱逐");
  assert.ok(cache.get("k2"), "较新条目保留");
  assert.ok(cache.get("k3"));
});
