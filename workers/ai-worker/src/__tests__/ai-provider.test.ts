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
    assert.equal(typeof provider.chatCompletion, "function");
    assert.equal(typeof provider.executeAgentTurn, "function");
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

// Clear OPENAI_COMPAT_* env vars so tests are deterministic regardless of
// the host environment.
const compatEnvKeys = [
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_BASE_URL",
  "OPENAI_COMPAT_MODEL",
  "OPENAI_COMPAT_VISION_MODEL",
] as const;

test("createProvider: openai_compatible 缺少 apiKey 抛错", () => {
  const saved = compatEnvKeys.map((k) => process.env[k]);
  compatEnvKeys.forEach((k) => delete process.env[k]);
  try {
    assert.throws(
      () => createProvider("openai_compatible", { baseUrl: "https://api.example.com", model: "gpt-4" }),
      /apiKey/,
    );
  } finally {
    compatEnvKeys.forEach((k, i) => {
      if (saved[i] !== undefined) (process.env as Record<string, string>)[k] = saved[i]!;
    });
  }
});

test("createProvider: openai_compatible 缺少 baseUrl 抛错", () => {
  const saved = compatEnvKeys.map((k) => process.env[k]);
  compatEnvKeys.forEach((k) => delete process.env[k]);
  try {
    assert.throws(
      () => createProvider("openai_compatible", { apiKey: "key", model: "gpt-4" }),
      /baseUrl/,
    );
  } finally {
    compatEnvKeys.forEach((k, i) => {
      if (saved[i] !== undefined) (process.env as Record<string, string>)[k] = saved[i]!;
    });
  }
});

test("createProvider: openai_compatible 缺少 model 抛错", () => {
  const saved = compatEnvKeys.map((k) => process.env[k]);
  compatEnvKeys.forEach((k) => delete process.env[k]);
  try {
    assert.throws(
      () => createProvider("openai_compatible", { apiKey: "key", baseUrl: "https://api.example.com" }),
      /model/,
    );
  } finally {
    compatEnvKeys.forEach((k, i) => {
      if (saved[i] !== undefined) (process.env as Record<string, string>)[k] = saved[i]!;
    });
  }
});

test("createProvider: openai_compatible 从环境变量回退创建实例", () => {
  const saved = compatEnvKeys.map((k) => process.env[k]);
  process.env.OPENAI_COMPAT_API_KEY = "env-key";
  process.env.OPENAI_COMPAT_BASE_URL = "https://api.example.com/v1";
  process.env.OPENAI_COMPAT_MODEL = "gpt-4";
  delete process.env.OPENAI_COMPAT_VISION_MODEL;
  try {
    const provider = createProvider("openai_compatible");
    assert.ok(provider);
    assert.equal(provider.id, "openai_compatible");
    assert.equal(provider.modelId, "gpt-4");
    assert.equal(provider.visionModelId, "gpt-4");
  } finally {
    compatEnvKeys.forEach((k, i) => {
      if (saved[i] !== undefined) (process.env as Record<string, string>)[k] = saved[i]!;
      else delete process.env[k];
    });
  }
});

test("createProvider: openai_compatible 配置优先于环境变量", () => {
  const saved = compatEnvKeys.map((k) => process.env[k]);
  process.env.OPENAI_COMPAT_API_KEY = "env-key";
  process.env.OPENAI_COMPAT_BASE_URL = "https://env.example.com/v1";
  process.env.OPENAI_COMPAT_MODEL = "env-model";
  try {
    const provider = createProvider("openai_compatible", {
      apiKey: "config-key",
      baseUrl: "https://config.example.com/v1",
      model: "config-model",
      visionModel: "config-vision",
    });
    assert.equal(provider.modelId, "config-model");
    assert.equal(provider.visionModelId, "config-vision");
  } finally {
    compatEnvKeys.forEach((k, i) => {
      if (saved[i] !== undefined) (process.env as Record<string, string>)[k] = saved[i]!;
      else delete process.env[k];
    });
  }
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
