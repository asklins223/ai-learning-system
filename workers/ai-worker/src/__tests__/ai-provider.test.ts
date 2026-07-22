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

test("createProvider: dashscope 无配置但在有环境变量时返回 provider 实例", () => {
  const oldKey = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = "test-key-for-unit-test";
  try {
    const provider = createProvider("dashscope");
    assert.ok(provider);
    assert.equal(typeof provider.generateCard, "function");
    assert.equal(typeof provider.evaluateValidation, "function");
  } finally {
    if (oldKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = oldKey;
  }
});

test("createProvider: qwen 作为 dashscope 别名", () => {
  const oldKey = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = "test-key-for-unit-test";
  try {
    const provider = createProvider("qwen");
    assert.ok(provider);
  } finally {
    if (oldKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = oldKey;
  }
});

test("createProvider: dashscope 带配置正确传递", () => {
  const config: AIProviderRuntimeConfig = {
    apiKey: "test-key",
    baseUrl: "https://dashscope.aliyuncs.com",
    model: "qwen-turbo",
  };
  const provider = createProvider("dashscope", config);
  assert.ok(provider);
});

test("createProvider: openai_compatible 缺少 apiKey 抛错", () => {
  assert.throws(
    () => createProvider("openai_compatible", { baseUrl: "https://api.example.com", model: "gpt-4" }),
    /apiKey/,
  );
});

test("createProvider: openai_compatible 缺少 baseUrl 抛错", () => {
  assert.throws(
    () => createProvider("openai_compatible", { apiKey: "key", model: "gpt-4" }),
    /baseUrl/,
  );
});

test("createProvider: openai_compatible 缺少 model 抛错", () => {
  assert.throws(
    () => createProvider("openai_compatible", { apiKey: "key", baseUrl: "https://api.example.com" }),
    /model/,
  );
});

test("createProvider: openai_compatible 完整配置返回 provider 实例", () => {
  const provider = createProvider("openai_compatible", {
    apiKey: "test-key",
    baseUrl: "https://api.example.com",
    model: "gpt-4",
  });
  assert.ok(provider);
  assert.equal(typeof provider.generateCard, "function");
  assert.equal(typeof provider.evaluateValidation, "function");
});

test("createProvider: 未知 provider 抛错", () => {
  assert.throws(
    () => createProvider("unknown-provider"),
    /not implemented/,
  );
});

test("createProvider: 空字符串抛错", () => {
  assert.throws(
    () => createProvider(""),
    /not implemented/,
  );
});

test("createProvider: 大写 provider 名称正常处理", () => {
  const oldKey = process.env.DASHSCOPE_API_KEY;
  process.env.DASHSCOPE_API_KEY = "test-key-for-unit-test";
  try {
    const provider = createProvider("DASHSCOPE");
    assert.ok(provider);
  } finally {
    if (oldKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = oldKey;
  }
});

test("createProvider: 返回的 provider 有 id/modelId/promptVersion 属性", () => {
  const provider = createProvider("mock");
  assert.equal(typeof provider.id, "string");
  assert.equal(typeof provider.modelId, "string");
  assert.equal(typeof provider.promptVersion, "string");
});
