/**
 * siliconflow.ts 测试
 *
 * 通过 mock requester 测试 SiliconFlowProvider：
 * - embed(): 成功解析 1024 维向量 / 非 2xx 返回 null / 解析失败返回 null / 抛错返回 null
 * - rerank(): 成功解析结果 / 非 2xx 抛错 / 空 documents 返回空数组
 * - reranker.ts: rerankEvidenceCandidates 正常重排 / provider null 降级 / provider 抛错降级 / 候选不足降级
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SiliconFlowProvider } from "../lib/providers/siliconflow.ts";
import { rerankEvidenceCandidates } from "../agent/reranker.ts";
import type { PublicJsonRequester, PublicJsonResponse } from "@ailearn/shared/public-json-http";

function mockRequester(response: PublicJsonResponse): PublicJsonRequester {
  return async () => response;
}

function failingRequester(error: Error): PublicJsonRequester {
  return async () => { throw error; };
}

function makeEmbeddingResponse(): PublicJsonResponse {
  // 1024 维全 0.5 向量
  const embedding = new Array(1024).fill(0.5);
  return {
    status: 200,
    statusText: "OK",
    body: {
      object: "list",
      model: "BAAI/bge-m3",
      data: [{ object: "embedding", embedding, index: 0 }],
      usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
    },
  };
}

function makeRerankResponse(): PublicJsonResponse {
  return {
    status: 200,
    statusText: "OK",
    body: {
      id: "rerank-test",
      results: [
        { index: 2, document: { text: "暗反应在叶绿体基质中进行" }, relevance_score: 0.845 },
        { index: 0, document: { text: "光反应在类囊体膜上进行" }, relevance_score: 0.34 },
      ],
      meta: { tokens: { input_tokens: 61, output_tokens: 0, image_tokens: 0 } },
    },
  };
}

const providerOptions = {
  apiKey: "test-siliconflow-key",
  baseUrl: "https://api.siliconflow.cn/v1",
  embeddingModel: "BAAI/bge-m3",
  rerankModel: "BAAI/bge-reranker-v2-m3",
};

// ─── embed() ────────────────────────────────────────────────────────────────

test("SiliconFlowProvider.embed 成功解析 1024 维向量", async () => {
  const provider = new SiliconFlowProvider({
    ...providerOptions,
    request: mockRequester(makeEmbeddingResponse()),
  });
  const vec = await provider.embed("光合作用");
  assert.ok(vec, "embed 应返回向量");
  assert.equal(vec.length, 1024);
  assert.equal(vec[0], 0.5);
});

test("SiliconFlowProvider.embed 非 2xx 返回 null", async () => {
  const provider = new SiliconFlowProvider({
    ...providerOptions,
    request: mockRequester({ status: 429, statusText: "Rate Limit", body: {} }),
  });
  const vec = await provider.embed("test");
  assert.equal(vec, null);
});

test("SiliconFlowProvider.embed 解析失败（无 embedding 字段）返回 null", async () => {
  const provider = new SiliconFlowProvider({
    ...providerOptions,
    request: mockRequester({ status: 200, statusText: "OK", body: { data: [] } }),
  });
  const vec = await provider.embed("test");
  assert.equal(vec, null);
});

test("SiliconFlowProvider.embed 请求抛错返回 null", async () => {
  const provider = new SiliconFlowProvider({
    ...providerOptions,
    request: failingRequester(new Error("network error")),
  });
  const vec = await provider.embed("test");
  assert.equal(vec, null);
});

test("SiliconFlowProvider.embed 发送正确的请求体", async () => {
  let captured: { url: string; body: unknown } | null = null;
  const capturingRequester: PublicJsonRequester = async (url, _headers, body) => {
    captured = { url, body };
    return makeEmbeddingResponse();
  };
  const provider = new SiliconFlowProvider({
    ...providerOptions,
    request: capturingRequester,
  });
  await provider.embed("光合作用过程");
  const c = captured as { url: string; body: unknown } | null;
  assert.ok(c, "应发送请求");
  assert.ok(c.url.endsWith("/v1/embeddings"), `URL 应为 embeddings 端点: ${c.url}`);
  const body = c.body as Record<string, unknown>;
  assert.equal(body.model, "BAAI/bge-m3");
  assert.deepEqual(body.input, ["光合作用过程"]);
  assert.equal(body.encoding_format, "float");
});

// ─── rerank() ───────────────────────────────────────────────────────────────

test("SiliconFlowProvider.rerank 成功解析并按 score 排序", async () => {
  const provider = new SiliconFlowProvider({
    ...providerOptions,
    request: mockRequester(makeRerankResponse()),
  });
  const results = await provider.rerank({
    query: "光合作用发生在哪里",
    documents: ["光反应在类囊体膜上进行", "中间文档", "暗反应在叶绿体基质中进行"],
    topN: 2,
  });
  assert.equal(results.length, 2);
  assert.equal(results[0]!.index, 2);
  assert.equal(results[0]!.relevanceScore, 0.845);
  assert.equal(results[1]!.index, 0);
});

test("SiliconFlowProvider.rerank 非 2xx 抛错", async () => {
  const provider = new SiliconFlowProvider({
    ...providerOptions,
    request: mockRequester({ status: 500, statusText: "Internal Server Error", body: {} }),
  });
  await assert.rejects(
    provider.rerank({ query: "q", documents: ["a", "b"] }),
    /HTTP 500/,
  );
});

test("SiliconFlowProvider.rerank 空 documents 返回空数组", async () => {
  const provider = new SiliconFlowProvider({
    ...providerOptions,
    request: mockRequester(makeRerankResponse()),
  });
  const results = await provider.rerank({ query: "q", documents: [] });
  assert.deepEqual(results, []);
});

// ─── rerankEvidenceCandidates 服务层 ───────────────────────────────────────

test("rerankEvidenceCandidates 正常重排", async () => {
  const provider = {
    rerank: async () => [
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.3 },
    ],
  };
  const output = await rerankEvidenceCandidates({
    query: "光合作用",
    candidates: [
      { evidenceRefId: "e1", text: "文档一" },
      { evidenceRefId: "e2", text: "文档二" },
    ],
    topN: 2,
    provider,
  });
  assert.equal(output.degraded, false);
  assert.deepEqual(output.reranked, ["e2", "e1"]);
});

test("rerankEvidenceCandidates provider 为 null 降级到原序", async () => {
  const output = await rerankEvidenceCandidates({
    query: "光合作用",
    candidates: [
      { evidenceRefId: "e1", text: "文档一" },
      { evidenceRefId: "e2", text: "文档二" },
    ],
    topN: 2,
    provider: null,
  });
  assert.equal(output.degraded, true);
  assert.deepEqual(output.reranked, ["e1", "e2"]);
  assert.equal(output.degradationReason, "rerank_provider_unavailable");
});

test("rerankEvidenceCandidates provider 抛错降级到原序", async () => {
  const provider = {
    rerank: async () => { throw new Error("rerank failed"); },
  };
  const output = await rerankEvidenceCandidates({
    query: "光合作用",
    candidates: [
      { evidenceRefId: "e1", text: "文档一" },
      { evidenceRefId: "e2", text: "文档二" },
    ],
    topN: 2,
    provider,
  });
  assert.equal(output.degraded, true);
  assert.deepEqual(output.reranked, ["e1", "e2"]);
  assert.equal(output.degradationReason, "rerank_failed");
});

test("rerankEvidenceCandidates 候选不足降级", async () => {
  const provider = {
    rerank: async () => [{ index: 0, relevanceScore: 1 }],
  };
  const output = await rerankEvidenceCandidates({
    query: "光合作用",
    candidates: [{ evidenceRefId: "e1", text: "文档一" }],
    topN: 1,
    provider,
  });
  assert.equal(output.degraded, true);
  assert.deepEqual(output.reranked, ["e1"]);
});

test("rerankEvidenceCandidates 未返回的候选补到尾部不丢", async () => {
  const provider = {
    rerank: async () => [{ index: 2, relevanceScore: 0.8 }],
  };
  const output = await rerankEvidenceCandidates({
    query: "q",
    candidates: [
      { evidenceRefId: "e1", text: "一" },
      { evidenceRefId: "e2", text: "二" },
      { evidenceRefId: "e3", text: "三" },
    ],
    topN: 3,
    provider,
  });
  assert.equal(output.degraded, false);
  // e3 排第一，e1/e2 按原序补到尾部
  assert.deepEqual(output.reranked, ["e3", "e1", "e2"]);
});
