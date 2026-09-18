/**
 * 共享 OpenAI 端点解析函数测试
 *
 * 覆盖 resolveOpenAIChatCompletionsUrl（@ailearn/shared/ai-endpoints）——
 * worker 的 OpenAICompatibleProvider 与 DashScope preset 都使用它。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOpenAIChatCompletionsUrl } from "@ailearn/shared/ai-endpoints";

// ─── resolveOpenAIChatCompletionsUrl ─────────────────────────────────────

test("resolveOpenAIChatCompletionsUrl: 基础 URL 自动添加 /chat/completions", () => {
  const result = resolveOpenAIChatCompletionsUrl("https://api.openai.com/v1");
  assert.equal(result, "https://api.openai.com/v1/chat/completions");
});

test("resolveOpenAIChatCompletionsUrl: 已包含 /chat/completions 时不重复添加", () => {
  const result = resolveOpenAIChatCompletionsUrl("https://api.openai.com/v1/chat/completions");
  assert.equal(result, "https://api.openai.com/v1/chat/completions");
});

test("resolveOpenAIChatCompletionsUrl: 末尾斜杠被规范化", () => {
  const result = resolveOpenAIChatCompletionsUrl("https://api.openai.com/v1/");
  assert.equal(result, "https://api.openai.com/v1/chat/completions");
});

test("resolveOpenAIChatCompletionsUrl: 其他域名也正确处理", () => {
  const result = resolveOpenAIChatCompletionsUrl("https://api.deepseek.com/v1");
  assert.equal(result, "https://api.deepseek.com/v1/chat/completions");
});

test("resolveOpenAIChatCompletionsUrl: 无路径的 baseURL", () => {
  const result = resolveOpenAIChatCompletionsUrl("https://api.example.com");
  assert.equal(result, "https://api.example.com/chat/completions");
});
