/**
 * B2-5: Provider Prompt Cache 契约测试
 *
 * 验证 cache hit/miss 两条路径的端到端契约：
 * 1. readUsage 正确解析 OpenAI 和 DashScope 两种 cache 字段格式
 * 2. shouldUsePromptCache 遵循 feature flag 和 provider 白名单
 * 3. AgentSession.recordProviderCall 累积 cache token 统计
 * 4. OpenAICompatibleProvider 在启用时添加 enable_cache 标记
 *
 * 计划 §2.5 验收标准：
 * "provider 契约测试扩展 cache 字段并 mock 命中/未命中两条路径"
 */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { readUsage } from "../lib/providers/json-response.ts";
import { shouldUsePromptCache, isPromptCacheEnabled, getPromptCacheProviders } from "@ailearn/shared";
import { AgentSession } from "../agent/session.ts";
import { OpenAICompatibleProvider } from "../lib/providers/openai-compatible.ts";
import type { PublicJsonRequester, PublicJsonResponse } from "@ailearn/shared/public-json-http";

// ─── 1. readUsage: cache hit 路径 ─────────────────────────────────────────

test("B2-5 readUsage: OpenAI convention — prompt_tokens_details.cached_tokens 解析成功", () => {
  const response = {
    id: "chatcmpl-abc123",
    usage: {
      total_tokens: 1000,
      prompt_tokens: 800,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 500 },
    },
  };
  const usage = readUsage(response);
  assert.ok(usage !== null);
  assert.equal(usage.totalTokens, 1000);
  assert.equal(usage.promptTokens, 800);
  assert.equal(usage.completionTokens, 200);
  assert.equal(usage.cacheHitTokens, 500);
  assert.equal(usage.cacheMissTokens, null);
});

test("B2-5 readUsage: DashScope convention — prompt_cache_hit_tokens + prompt_cache_miss_tokens 解析成功", () => {
  const response = {
    request_id: "req-dashscope-001",
    usage: {
      total_tokens: 1200,
      prompt_tokens: 900,
      completion_tokens: 300,
      prompt_cache_hit_tokens: 600,
      prompt_cache_miss_tokens: 300,
    },
  };
  const usage = readUsage(response);
  assert.ok(usage !== null);
  assert.equal(usage.totalTokens, 1200);
  assert.equal(usage.cacheHitTokens, 600);
  assert.equal(usage.cacheMissTokens, 300);
});

test("B2-5 readUsage: OpenAI convention 优先于 DashScope convention（同时存在时）", () => {
  const response = {
    id: "chatcmpl-test",
    usage: {
      total_tokens: 500,
      prompt_tokens: 400,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 200 },
      prompt_cache_hit_tokens: 999, // 应该被忽略
      prompt_cache_miss_tokens: 50,
    },
  };
  const usage = readUsage(response);
  assert.ok(usage !== null);
  assert.equal(usage.cacheHitTokens, 200); // OpenAI convention 优先
  assert.equal(usage.cacheMissTokens, 50); // miss 从 DashScope convention 解析
});

// ─── 2. readUsage: cache miss 路径（无 cache 字段）────────────────────────

test("B2-5 readUsage: 无 cache 字段时 cacheHitTokens 和 cacheMissTokens 为 null", () => {
  const response = {
    id: "chatcmpl-no-cache",
    usage: {
      total_tokens: 300,
      prompt_tokens: 200,
      completion_tokens: 100,
    },
  };
  const usage = readUsage(response);
  assert.ok(usage !== null);
  assert.equal(usage.totalTokens, 300);
  assert.equal(usage.cacheHitTokens, null);
  assert.equal(usage.cacheMissTokens, null);
});

test("B2-5 readUsage: 无 usage 对象时返回 null", () => {
  const response = { id: "chatcmpl-no-usage" };
  const usage = readUsage(response);
  assert.equal(usage, null);
});

test("B2-5 readUsage: cache 字段为非安全整数时静默降级为 null", () => {
  const response = {
    id: "chatcmpl-bad-cache",
    usage: {
      total_tokens: 100,
      prompt_tokens: 50,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: "not-a-number" },
      prompt_cache_hit_tokens: -10, // 负数不被接受
      prompt_cache_miss_tokens: 3.5, // 浮点不被接受
    },
  };
  const usage = readUsage(response);
  assert.ok(usage !== null);
  assert.equal(usage.cacheHitTokens, null);
  assert.equal(usage.cacheMissTokens, null);
});

test("B2-5 readUsage: cache 字段为 0 时正确解析（0 是有效值）", () => {
  const response = {
    id: "chatcmpl-zero-cache",
    usage: {
      total_tokens: 100,
      prompt_tokens: 50,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 0,
    },
  };
  const usage = readUsage(response);
  assert.ok(usage !== null);
  assert.equal(usage.cacheHitTokens, 0);
  assert.equal(usage.cacheMissTokens, 0);
});

// ─── 3. shouldUsePromptCache: feature flag + 白名单 ───────────────────────

const ENV_BACKUP: Record<string, string | undefined> = {};

beforeEach(() => {
  // 备份并清理所有 cache 相关 env
  for (const key of ["PROMPT_CACHE_ENABLED", "PROMPT_CACHE_PROVIDERS"]) {
    ENV_BACKUP[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  // 恢复 env
  for (const [key, value] of Object.entries(ENV_BACKUP)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("B2-5 shouldUsePromptCache: flag 关闭时始终返回 false", () => {
  assert.equal(isPromptCacheEnabled(), false);
  assert.equal(shouldUsePromptCache("dashscope"), false);
  assert.equal(shouldUsePromptCache("openai_compatible"), false);
});

test("B2-5 shouldUsePromptCache: flag 开启但 provider 不在白名单时返回 false", () => {
  process.env.PROMPT_CACHE_ENABLED = "true";
  // 默认白名单只有 dashscope
  assert.equal(isPromptCacheEnabled(), true);
  assert.equal(shouldUsePromptCache("openai_compatible"), false);
  assert.equal(shouldUsePromptCache("mock"), false);
});

test("B2-5 shouldUsePromptCache: flag 开启且 provider 在默认白名单中返回 true", () => {
  process.env.PROMPT_CACHE_ENABLED = "true";
  // 默认白名单: dashscope
  assert.equal(shouldUsePromptCache("dashscope"), true);
  // 大小写不敏感
  assert.equal(shouldUsePromptCache("DashScope"), true);
  assert.equal(shouldUsePromptCache("DASHSCOPE"), true);
});

test("B2-5 shouldUsePromptCache: 自定义白名单 PROMPT_CACHE_PROVIDERS", () => {
  process.env.PROMPT_CACHE_ENABLED = "true";
  process.env.PROMPT_CACHE_PROVIDERS = "dashscope,openai_compatible,siliconflow";
  const providers = getPromptCacheProviders();
  assert.equal(providers.size, 3);
  assert.equal(providers.has("dashscope"), true);
  assert.equal(providers.has("openai_compatible"), true);
  assert.equal(providers.has("siliconflow"), true);
  assert.equal(shouldUsePromptCache("siliconflow"), true);
});

test("B2-5 shouldUsePromptCache: PROMPT_CACHE_PROVIDERS 空字符串回退到默认 dashscope", () => {
  process.env.PROMPT_CACHE_ENABLED = "true";
  process.env.PROMPT_CACHE_PROVIDERS = "";
  assert.equal(getPromptCacheProviders().size, 1);
  assert.equal(shouldUsePromptCache("dashscope"), true);
});

test("B2-5 shouldUsePromptCache: PROMPT_CACHE_PROVIDERS 只有逗号和空格时回退到默认", () => {
  process.env.PROMPT_CACHE_ENABLED = "true";
  process.env.PROMPT_CACHE_PROVIDERS = "  ,  , ";
  assert.equal(getPromptCacheProviders().size, 1);
  assert.equal(shouldUsePromptCache("dashscope"), true);
});

// ─── 4. AgentSession.recordProviderCall: cache token 累积 ─────────────────

function makeSession(): AgentSession {
  return new AgentSession({
    unitId: "test-unit",
    runId: "test-run",
    role: "generation_supervisor",
    turnNo: 0,
    attemptNo: 0,
    status: "running",
    waitingForTaskIds: [],
    completedTaskIds: [],
    lastProviderRequestId: null,
    cumulativeUsage: null,
    cursor: {},
  });
}

test("B2-5 AgentSession: recordProviderCall 累积 cacheHitTokens 和 cacheMissTokens", () => {
  const session = makeSession();
  // 第一次调用：cache miss
  session.recordProviderCall(
    { totalTokens: 1000, promptTokens: 800, completionTokens: 200, cacheHitTokens: 0, cacheMissTokens: 800, requestId: "req-1" },
    "req-1",
  );
  let usage = session.getState().cumulativeUsage;
  assert.ok(usage !== null);
  assert.equal(usage.cacheHitTokens, 0);
  assert.equal(usage.cacheMissTokens, 800);

  // 第二次调用：cache hit
  session.recordProviderCall(
    { totalTokens: 600, promptTokens: 400, completionTokens: 200, cacheHitTokens: 350, cacheMissTokens: 50, requestId: "req-2" },
    "req-2",
  );
  usage = session.getState().cumulativeUsage;
  assert.ok(usage !== null);
  assert.equal(usage.totalTokens, 1600);
  assert.equal(usage.promptTokens, 1200);
  assert.equal(usage.completionTokens, 400);
  assert.equal(usage.cacheHitTokens, 350);
  assert.equal(usage.cacheMissTokens, 850);
});

test("B2-5 AgentSession: recordProviderCall cache 字段缺失时累积为 0（向后兼容）", () => {
  const session = makeSession();
  // 旧版 provider 不返回 cache 字段
  session.recordProviderCall(
    { totalTokens: 500, promptTokens: 300, completionTokens: 200, requestId: "req-old" },
    "req-old",
  );
  const usage = session.getState().cumulativeUsage;
  assert.ok(usage !== null);
  assert.equal(usage.cacheHitTokens, 0);
  assert.equal(usage.cacheMissTokens, 0);
});

test("B2-5 AgentSession: fromDbRow 恢复持久化的 cache token 数据", () => {
  const session = AgentSession.fromDbRow({
    id: "unit-restore",
    runId: "run-restore",
    inputManifest: { agentRole: "generation_supervisor" },
    cursorJson: { turnNo: 3 },
    usageJson: {
      totalTokens: 2000,
      promptTokens: 1500,
      completionTokens: 500,
      cacheHitTokens: 800,
      cacheMissTokens: 700,
      requestId: "req-persisted",
    },
    attempts: 1,
    status: "running",
  });
  const usage = session.getState().cumulativeUsage;
  assert.ok(usage !== null);
  assert.equal(usage.cacheHitTokens, 800);
  assert.equal(usage.cacheMissTokens, 700);
});

test("B2-5 AgentSession: fromDbRow 恢复旧版数据（无 cache 字段）向后兼容", () => {
  const session = AgentSession.fromDbRow({
    id: "unit-old",
    runId: "run-old",
    inputManifest: { agentRole: "generation_supervisor" },
    cursorJson: { turnNo: 1 },
    usageJson: {
      totalTokens: 500,
      promptTokens: 300,
      completionTokens: 200,
      requestId: "req-old",
    },
    attempts: 1,
    status: "running",
  });
  const usage = session.getState().cumulativeUsage;
  assert.ok(usage !== null);
  assert.equal(usage.cacheHitTokens, 0);
  assert.equal(usage.cacheMissTokens, 0);
});

test("B2-5 AgentSession: toUsageJson 导出 cache 字段供持久化", () => {
  const session = makeSession();
  session.recordProviderCall(
    { totalTokens: 1000, promptTokens: 800, completionTokens: 200, cacheHitTokens: 500, cacheMissTokens: 300, requestId: "req-1" },
    "req-1",
  );
  const json = session.toUsageJson();
  assert.equal(json.cacheHitTokens, 500);
  assert.equal(json.cacheMissTokens, 300);
  assert.equal(json.totalTokens, 1000);
});

// ─── 5. OpenAICompatibleProvider: enable_cache 标记注入 ───────────────────

function mockRequester(response: PublicJsonResponse): PublicJsonRequester {
  return async () => response;
}

test("B2-5 Provider: flag 关闭时不添加 enable_cache 到请求体", async () => {
  let requestedBody: unknown;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "qwen-plus",
    request: async (_url, _headers, body) => {
      requestedBody = body;
      return {
        status: 200,
        statusText: "OK",
        body: {
          choices: [{ message: { content: '{"action":"done"}', tool_calls: undefined }, finish_reason: "stop" }],
          usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 },
        },
      };
    },
  });

  // flag 关闭（默认状态）
  await provider.executeAgentTurn({
    role: "generation_supervisor",
    systemPrompt: "test system prompt",
    messages: [],
    tools: [],
    temperature: 0,
    maxTokens: 4096,
  });

  const body = requestedBody as Record<string, unknown>;
  assert.equal(body.enable_cache, undefined);
});

test("B2-5 Provider: flag 开启且 dashscope 在白名单时添加 enable_cache", async () => {
  process.env.PROMPT_CACHE_ENABLED = "true";
  // dashscope 在默认白名单中

  let requestedBody: unknown;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://dashscope.api.com/v1",
    model: "qwen-plus",
    providerId: "dashscope",
    request: async (_url, _headers, body) => {
      requestedBody = body;
      return {
        status: 200,
        statusText: "OK",
        body: {
          choices: [{ message: { content: '{"action":"done"}', tool_calls: undefined }, finish_reason: "stop" }],
          usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 3 },
        },
      };
    },
  });

  await provider.executeAgentTurn({
    role: "generation_supervisor",
    systemPrompt: "test system prompt",
    messages: [],
    tools: [],
    temperature: 0,
    maxTokens: 4096,
  });

  const body = requestedBody as Record<string, unknown>;
  assert.equal(body.enable_cache, true);
});

test("B2-5 Provider: flag 开启但 provider 不在白名单时不添加 enable_cache", async () => {
  process.env.PROMPT_CACHE_ENABLED = "true";
  // 默认白名单只有 dashscope，openai_compatible 不在其中

  let requestedBody: unknown;
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    // providerId 默认为 "openai_compatible"
    request: async (_url, _headers, body) => {
      requestedBody = body;
      return {
        status: 200,
        statusText: "OK",
        body: {
          choices: [{ message: { content: '{"action":"done"}', tool_calls: undefined }, finish_reason: "stop" }],
          usage: { total_tokens: 10, prompt_tokens: 5, completion_tokens: 5 },
        },
      };
    },
  });

  await provider.executeAgentTurn({
    role: "generation_supervisor",
    systemPrompt: "test system prompt",
    messages: [],
    tools: [],
    temperature: 0,
    maxTokens: 4096,
  });

  const body = requestedBody as Record<string, unknown>;
  assert.equal(body.enable_cache, undefined);
});

// ─── 6. Provider: cache hit/miss usage 回传路径 ───────────────────────────

test("B2-5 Provider: executeAgentTurn 返回的 usage 包含 cacheHitTokens", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "qwen-plus",
    request: mockRequester({
      status: 200,
      statusText: "OK",
      body: {
        id: "chatcmpl-cache-test",
        choices: [{ message: { content: '{"action":"done"}' }, finish_reason: "stop" }],
        usage: {
          total_tokens: 1000,
          prompt_tokens: 800,
          completion_tokens: 200,
          prompt_tokens_details: { cached_tokens: 600 },
        },
      },
    }),
  });

  const result = await provider.executeAgentTurn({
    role: "generation_supervisor",
    systemPrompt: "test system prompt",
    messages: [],
    tools: [],
    temperature: 0,
    maxTokens: 4096,
  });

  assert.ok(result.usage !== null && result.usage !== undefined);
  assert.equal(result.usage.cacheHitTokens, 600);
  assert.equal(result.usage.cacheMissTokens, null);
});

test("B2-5 Provider: executeAgentTurn 返回的 usage 在无 cache 字段时 cacheHitTokens 为 null", async () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4",
    request: mockRequester({
      status: 200,
      statusText: "OK",
      body: {
        id: "chatcmpl-no-cache-test",
        choices: [{ message: { content: '{"action":"done"}' }, finish_reason: "stop" }],
        usage: {
          total_tokens: 500,
          prompt_tokens: 300,
          completion_tokens: 200,
        },
      },
    }),
  });

  const result = await provider.executeAgentTurn({
    role: "generation_supervisor",
    systemPrompt: "test system prompt",
    messages: [],
    tools: [],
    temperature: 0,
    maxTokens: 4096,
  });

  assert.ok(result.usage !== null && result.usage !== undefined);
  assert.equal(result.usage.cacheHitTokens, null);
  assert.equal(result.usage.cacheMissTokens, null);
});
