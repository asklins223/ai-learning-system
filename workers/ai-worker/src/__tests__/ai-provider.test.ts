/**
 * ai-provider.ts 单元测试
 *
 * 覆盖 createProvider 函数的所有分支。
 * resolveProviderSelection 依赖数据库，不在此测试。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createProvider, type AIProviderRuntimeConfig } from "../lib/ai-provider.ts";
import { MockProvider } from "../lib/providers/mock.ts";

// ─── createProvider ──────────────────────────────────────────────────────

test("createProvider: mock 返回 MockProvider 实例", () => {
  const provider = createProvider("mock");
  assert.ok(provider instanceof MockProvider);
  assert.equal(provider.id, "mock");
});

test("createProvider: mock 大写也返回 MockProvider", () => {
  const provider = createProvider("MOCK");
  assert.ok(provider instanceof MockProvider);
});

test("createProvider: dashscope 使用显式配置返回 provider 实例", () => {
  const provider = createProvider("dashscope", {
    apiKey: "test-key-for-unit-test",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  });
  assert.ok(provider);
  assert.equal(typeof provider.chatCompletion, "function");
  assert.equal(typeof provider.executeAgentTurn, "function");
});

test("createProvider: dashscope 带配置正确传递", () => {
  const config: AIProviderRuntimeConfig = {
    apiKey: "test-key",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-turbo",
  };
  const provider = createProvider("dashscope", config);
  assert.ok(provider);
});

test("createProvider: openai_compatible 缺少 apiKey 抛错", () => {
  assert.throws(
    () => createProvider("openai_compatible", { baseUrl: "https://api.example.com", model: "gpt-4" }),
    /configured|apiKey/i,
  );
});

test("createProvider: openai_compatible 缺少 baseUrl 抛错", () => {
  assert.throws(
    () => createProvider("openai_compatible", { apiKey: "key", model: "gpt-4" }),
    /configured|baseUrl/i,
  );
});

test("createProvider: openai_compatible 缺少 model 抛错", () => {
  assert.throws(
    () => createProvider("openai_compatible", { apiKey: "key", baseUrl: "https://api.example.com" }),
    /configured|model/i,
  );
});

test("createProvider: openai_compatible 使用完整显式配置", () => {
  const provider = createProvider("openai_compatible", {
    apiKey: "config-key",
    baseUrl: "https://config.example.com/v1",
    model: "config-model",
    visionModel: "config-vision",
  });
  assert.equal(provider.modelId, "config-model");
  assert.equal(provider.visionModelId, "config-vision");
});

test("createProvider: openai_compatible 完整配置返回 provider 实例", () => {
  const provider = createProvider("openai_compatible", {
    apiKey: "test-key",
    baseUrl: "https://api.example.com",
    model: "gpt-4",
  });
  assert.ok(provider);
  assert.equal(typeof provider.chatCompletion, "function");
  assert.equal(typeof provider.executeAgentTurn, "function");
});

test("createProvider: 未知 provider 抛错", () => {
  assert.throws(
    () => createProvider("unknown-provider"),
    /unknown provider/,
  );
});

test("createProvider: 空字符串抛错", () => {
  assert.throws(
    () => createProvider(""),
    /unknown provider/,
  );
});

test("createProvider: 大写 provider 名称正常处理", () => {
  const provider = createProvider("DASHSCOPE", {
    apiKey: "test-key-for-unit-test",
    model: "qwen-plus",
  });
  assert.ok(provider);
});

test("createProvider: 返回的 provider 有 id/modelId/promptVersion 属性", () => {
  const provider = createProvider("mock");
  assert.equal(typeof provider.id, "string");
  assert.equal(typeof provider.modelId, "string");
  assert.equal(typeof provider.promptVersion, "string");
});
