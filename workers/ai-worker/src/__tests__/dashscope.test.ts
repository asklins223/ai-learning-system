/**
 * DashScope provider 工厂测试。
 *
 * DashScope 是 OpenAICompatibleProvider 的 preset：能力实例通过
 * provider 注册表工厂创建（createProvider / createEmbeddingProvider），
 * 传输层复用 OpenAICompatibleProvider（其 SSE/错误/abort 行为由
 * openai-compatible-*.test.ts 覆盖）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider, createEmbeddingProvider } from "../lib/ai-provider.ts";

test("createProvider: dashscope 使用默认 preset 配置", () => {
  const provider = createProvider("dashscope", { apiKey: "test-key" });
  assert.equal(provider.id, "dashscope");
  assert.equal(provider.modelId, "qwen-plus");
  assert.equal(provider.visionModelId, "qwen3-vl-plus");
  assert.equal(provider.promptVersion, "v6-dashscope");
  assert.equal(typeof provider.chatCompletion, "function");
  assert.equal(typeof provider.executeAgentTurn, "function");
});

test("createProvider: dashscope 使用显式 model/baseUrl", () => {
  const provider = createProvider("dashscope", {
    apiKey: "test-key",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-max",
  });
  assert.equal(provider.modelId, "qwen-max");
});

test("createProvider: dashscope 缺少 apiKey 抛错", () => {
  assert.throws(
    () => createProvider("dashscope", {}),
    /not configured for agent_turn/,
  );
});

test("createEmbeddingProvider: dashscope embedding 工厂使用配置的 model 作为 embedding 模型", async () => {
  const provider = await createEmbeddingProvider({
    embeddingProviderName: "dashscope",
    embeddingProviderConfig: {
      apiKey: "test-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "text-embedding-v3",
    },
  });
  assert.ok(provider);
  assert.equal(provider.id, "dashscope");
  assert.equal(provider.embeddingModelId, "text-embedding-v3");
  assert.equal(typeof provider.embed, "function");
});
