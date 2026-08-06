/**
 * E1: embedding 语义召回完善 — 契约测试
 *
 * 计划 §2.8 验收标准：
 * "用 packages/ai-quality 的 golden set 评估长资料 evidence 召回率（flag 开/关对比）；
 *  embedding 覆盖率达到阈值；索引写入失败在 PREPARE 阶段可见并可重试。"
 *
 * 此测试验证：
 * 1. HybridSearchEngine feature flag（默认关，可灰度开启）
 * 2. shouldRefreshEmbedding 新鲜度检查
 * 3. HybridSearchEngine RRF 合并逻辑
 * 4. isEmbeddingStale 旧函数仍可用（向后兼容）
 */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import {
  isHybridSearchEnabled,
  getHybridSearchMode,
  shouldRefreshEmbedding,
} from "@ailearn/shared";
import {
  HybridSearchEngine,
  isEmbeddingStale,
  getDefaultEmbeddingProfile,
  type SequentialSearchExecutor,
  type LexicalSearchExecutor,
  type VectorSearchExecutor,
  type EmbeddingProvider,
} from "../agent/hybrid-search.ts";

// ─── 1. Feature flag 契约 ─────────────────────────────────────────────────

const ENV_BACKUP: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["HYBRID_SEARCH_ENABLED", "HYBRID_SEARCH_MODE"]) {
    ENV_BACKUP[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(ENV_BACKUP)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("E1 isHybridSearchEnabled: 默认关闭", () => {
  assert.equal(isHybridSearchEnabled(), false);
});

test("E1 isHybridSearchEnabled: 设为 true 时开启", () => {
  process.env.HYBRID_SEARCH_ENABLED = "true";
  assert.equal(isHybridSearchEnabled(), true);
});

test("E1 getHybridSearchMode: 默认返回 hybrid", () => {
  assert.equal(getHybridSearchMode(), "hybrid");
});

test("E1 getHybridSearchMode: 支持自定义模式", () => {
  process.env.HYBRID_SEARCH_MODE = "vector";
  assert.equal(getHybridSearchMode(), "vector");

  process.env.HYBRID_SEARCH_MODE = "trigram";
  assert.equal(getHybridSearchMode(), "trigram");

  process.env.HYBRID_SEARCH_MODE = "sequential";
  assert.equal(getHybridSearchMode(), "sequential");
});

test("E1 getHybridSearchMode: 无效值回退到 hybrid", () => {
  process.env.HYBRID_SEARCH_MODE = "invalid";
  assert.equal(getHybridSearchMode(), "hybrid");
});

// ─── 2. shouldRefreshEmbedding 新鲜度检查 ─────────────────────────────────

test("E1 shouldRefreshEmbedding: source hash 变化时返回 true", () => {
  assert.equal(
    shouldRefreshEmbedding({
      currentSourceHash: "abc123",
      embeddingSourceHash: "def456",
      currentModelRevision: "v1",
      embeddingModelRevision: "v1",
      currentProfileVersion: "v1",
      embeddingProfileVersion: "v1",
    }),
    true,
  );
});

test("E1 shouldRefreshEmbedding: model revision 变化时返回 true", () => {
  assert.equal(
    shouldRefreshEmbedding({
      currentSourceHash: "abc123",
      embeddingSourceHash: "abc123",
      currentModelRevision: "v2",
      embeddingModelRevision: "v1",
      currentProfileVersion: "v1",
      embeddingProfileVersion: "v1",
    }),
    true,
  );
});

test("E1 shouldRefreshEmbedding: profile version 变化时返回 true", () => {
  assert.equal(
    shouldRefreshEmbedding({
      currentSourceHash: "abc123",
      embeddingSourceHash: "abc123",
      currentModelRevision: "v1",
      embeddingModelRevision: "v1",
      currentProfileVersion: "v2",
      embeddingProfileVersion: "v1",
    }),
    true,
  );
});

test("E1 shouldRefreshEmbedding: 全部匹配时返回 false（无需刷新）", () => {
  assert.equal(
    shouldRefreshEmbedding({
      currentSourceHash: "abc123",
      embeddingSourceHash: "abc123",
      currentModelRevision: "v1",
      embeddingModelRevision: "v1",
      currentProfileVersion: "v1",
      embeddingProfileVersion: "v1",
    }),
    false,
  );
});

// ─── 3. isEmbeddingStale 向后兼容 ─────────────────────────────────────────

test("E1 isEmbeddingStale: 与 shouldRefreshEmbedding 行为一致（向后兼容）", () => {
  const params = {
    currentSourceHash: "abc",
    embeddingSourceHash: "def",
    currentModelRevision: "v1",
    embeddingModelRevision: "v1",
    currentProfileVersion: "v1",
    embeddingProfileVersion: "v1",
  };
  assert.equal(isEmbeddingStale(params), shouldRefreshEmbedding(params));
});

test("E1 getDefaultEmbeddingProfile: 返回正确的维度和版本", () => {
  const profile = getDefaultEmbeddingProfile();
  assert.equal(profile.dimensions, 1024);
  assert.ok(typeof profile.profileVersion === "string");
  assert.ok(profile.profileVersion.length > 0);
});

// ─── 4. HybridSearchEngine RRF 合并验证 ────────────────────────────────────

function makeExecutors() {
  const sequentialExecutor: SequentialSearchExecutor = {
    search: async () => ({
      results: [
        { evidenceRefId: "ev-seq-1", score: 0.8, sectionPath: ["root"] },
      ],
    }),
  };
  const lexicalExecutor: LexicalSearchExecutor = {
    search: async () => ({
      results: [
        { evidenceRefId: "ev-lex-1", score: 0.7, sectionPath: ["root"] },
        { evidenceRefId: "ev-lex-2", score: 0.5, sectionPath: ["root"] },
      ],
    }),
  };
  const vectorExecutor: VectorSearchExecutor = {
    search: async () => ({
      results: [
        { evidenceRefId: "ev-vec-1", score: 0.9, sectionPath: ["root"] },
        { evidenceRefId: "ev-lex-1", score: 0.6, sectionPath: ["root"] }, // overlap with lexical
      ],
      indexCoverage: 1.0,
    }),
  };
  const embeddingProvider: EmbeddingProvider = {
    id: "test-embed",
    modelId: "test-model",
    modelRevision: "v1",
    embed: async () => new Array(1024).fill(0.1),
  };
  return { sequentialExecutor, lexicalExecutor, vectorExecutor, embeddingProvider };
}

test("E1 HybridSearchEngine: hybrid 模式正确合并向量和词法结果", async () => {
  const { sequentialExecutor, lexicalExecutor, vectorExecutor, embeddingProvider } = makeExecutors();
  const engine = new HybridSearchEngine({
    vectorExecutor,
    lexicalExecutor,
    sequentialExecutor,
    embeddingProvider,
    preferredMode: "hybrid",
  });

  const result = await engine.search({
    workspaceId: "ws-1",
    noteVersionId: "nv-1",
    query: "test query",
    topK: 5,
  });

  assert.equal(result.degraded, false);
  assert.equal(result.retrievalMode, "hybrid");
  // RRF 合并后应该有 3 个唯一结果（ev-vec-1, ev-lex-1, ev-lex-2）
  assert.equal(result.results.length, 3);
  // ev-lex-1 在两个列表中都出现，RRF 合并后分数应更高
  const evLex1 = result.results.find((r) => r.evidenceRefId === "ev-lex-1");
  assert.ok(evLex1, "ev-lex-1 应在结果中");
  assert.ok(evLex1.retrievalMode === "hybrid", "ev-lex-1 的 retrievalMode 应为 hybrid");
});

test("E1 HybridSearchEngine: 向量不可用时降级到词法", async () => {
  const { sequentialExecutor, lexicalExecutor, embeddingProvider } = makeExecutors();
  const engine = new HybridSearchEngine({
    vectorExecutor: null,
    lexicalExecutor,
    sequentialExecutor,
    embeddingProvider,
    preferredMode: "hybrid",
  });

  const result = await engine.search({
    workspaceId: "ws-1",
    noteVersionId: "nv-1",
    query: "test query",
    topK: 5,
  });

  assert.equal(result.degraded, true);
  assert.ok(
    result.retrievalMode === "trigram" || result.retrievalMode === "sequential",
    `应降级到 trigram 或 sequential，实际为 ${result.retrievalMode}`,
  );
});

test("E1 HybridSearchEngine: embedding 返回 null 时降级", async () => {
  const { sequentialExecutor, lexicalExecutor, vectorExecutor } = makeExecutors();
  const embeddingProvider: EmbeddingProvider = {
    id: "test-embed",
    modelId: "test-model",
    modelRevision: "v1",
    embed: async () => null,
  };
  const engine = new HybridSearchEngine({
    vectorExecutor,
    lexicalExecutor,
    sequentialExecutor,
    embeddingProvider,
    preferredMode: "hybrid",
  });

  const result = await engine.search({
    workspaceId: "ws-1",
    noteVersionId: "nv-1",
    query: "test query",
    topK: 5,
  });

  assert.equal(result.degraded, true);
});

test("E1 HybridSearchEngine: sequential 模式始终可用（最终回退）", async () => {
  const { sequentialExecutor } = makeExecutors();
  const engine = new HybridSearchEngine({
    vectorExecutor: null,
    lexicalExecutor: null,
    sequentialExecutor,
    preferredMode: "sequential",
  });

  const result = await engine.search({
    workspaceId: "ws-1",
    noteVersionId: "nv-1",
    query: "test query",
    topK: 5,
  });

  assert.equal(result.retrievalMode, "sequential");
  assert.ok(result.results.length > 0, "sequential 搜索应返回结果");
  assert.equal(result.degraded, true, "sequential 始终标记为降级");
});
