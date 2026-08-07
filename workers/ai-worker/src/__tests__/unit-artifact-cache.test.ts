/**
 * P2-7：Unit Artifact Cache 单元测试。
 *
 * 覆盖:内容寻址 cacheKey(inputHash+模型+Prompt+kind)、命中重放、
 * force 重算(clear)、审计统计、key 稳定性(同输入同 key)。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeArtifactCacheKey,
  createMemoryArtifactCache,
  type ArtifactCacheEntry,
} from "../agent/unit-artifact-cache.ts";

const BASE = {
  inputHash: "input-hash-1",
  modelVersion: "model-v1",
  promptVersion: "prompt-v1",
  unitKind: "fast_extract",
};

test("cacheKey 内容寻址:同输入同 key,任一分量变化 → 不同 key", () => {
  const k1 = computeArtifactCacheKey(BASE);
  const k2 = computeArtifactCacheKey(BASE);
  assert.equal(k1, k2, "同输入应稳定同 key");
  assert.equal(k1.length, 64, "SHA-256 hex");

  assert.notEqual(computeArtifactCacheKey({ ...BASE, inputHash: "x" }), k1);
  assert.notEqual(computeArtifactCacheKey({ ...BASE, modelVersion: "model-v2" }), k1);
  assert.notEqual(computeArtifactCacheKey({ ...BASE, promptVersion: "prompt-v2" }), k1);
  assert.notEqual(computeArtifactCacheKey({ ...BASE, unitKind: "fast_compose" }), k1);
});

test("命中重放 + 写入审计统计", () => {
  const cache = createMemoryArtifactCache();
  const key = computeArtifactCacheKey(BASE);
  const entry: ArtifactCacheEntry = {
    cacheKey: key,
    artifact: { cards: [] },
    cachedAt: Date.now(),
    modelVersion: BASE.modelVersion,
    promptVersion: BASE.promptVersion,
    unitKind: BASE.unitKind,
  };
  cache.put(entry);
  assert.equal(cache.get(key)?.artifact, entry.artifact, "命中重放同一 artifact");
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().writes, 1);
  assert.equal(cache.stats().size, 1);
});

test("未命中返回 undefined;clear(key) 定向失效(force 重算路径)", () => {
  const cache = createMemoryArtifactCache();
  const key = computeArtifactCacheKey(BASE);
  const entry: ArtifactCacheEntry = {
    cacheKey: key,
    artifact: { cards: [] },
    cachedAt: Date.now(),
    modelVersion: BASE.modelVersion,
    promptVersion: BASE.promptVersion,
    unitKind: BASE.unitKind,
  };
  assert.equal(cache.get(key), undefined, "未写入不命中");
  cache.put(entry);
  cache.clear(key);
  assert.equal(cache.get(key), undefined, "定向失效后不命中(force 重算可用)");
});

test("clear() 全清", () => {
  const cache = createMemoryArtifactCache();
  const entry: ArtifactCacheEntry = {
    cacheKey: computeArtifactCacheKey(BASE),
    artifact: { a: 1 },
    cachedAt: Date.now(),
    modelVersion: "m",
    promptVersion: "p",
    unitKind: BASE.unitKind,
  };
  cache.put(entry);
  cache.clear();
  assert.equal(cache.stats().size, 0);
});
