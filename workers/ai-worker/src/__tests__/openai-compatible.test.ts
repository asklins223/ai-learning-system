/**
 * openai-compatible.ts 纯函数测试
 *
 * 覆盖 resolveChatCompletionsUrl
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveChatCompletionsUrl } from "../lib/providers/openai-compatible.ts";

// ─── resolveChatCompletionsUrl ───────────────────────────────────────────

test("resolveChatCompletionsUrl: 基础 URL 自动添加 /chat/completions", () => {
  const result = resolveChatCompletionsUrl("https://api.openai.com/v1");
  assert.equal(result, "https://api.openai.com/v1/chat/completions");
});

test("resolveChatCompletionsUrl: 已包含 /chat/completions 时不重复添加", () => {
  const result = resolveChatCompletionsUrl("https://api.openai.com/v1/chat/completions");
  assert.equal(result, "https://api.openai.com/v1/chat/completions");
});

test("resolveChatCompletionsUrl: 末尾斜杠被规范化", () => {
  const result = resolveChatCompletionsUrl("https://api.openai.com/v1/");
  assert.equal(result, "https://api.openai.com/v1/chat/completions");
});

test("resolveChatCompletionsUrl: 其他域名也正确处理", () => {
  const result = resolveChatCompletionsUrl("https://api.deepseek.com/v1");
  assert.equal(result, "https://api.deepseek.com/v1/chat/completions");
});

test("resolveChatCompletionsUrl: 无路径的 baseURL", () => {
  const result = resolveChatCompletionsUrl("https://api.example.com");
  assert.equal(result, "https://api.example.com/chat/completions");
});
