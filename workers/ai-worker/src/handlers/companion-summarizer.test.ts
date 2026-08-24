import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummarizerMessages, conversationSummaryOutputSchema } from "./companion-summarizer.ts";

test("summarizer messages: 包含系统提示与对话正文", () => {
  const messages = buildSummarizerMessages("用户：你好\n桌宠：你好呀");
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /会话摘要器/);
  assert.match(messages[1].content, /你好呀/);
});

test("summarizer schema: 合法摘要通过，缺字段拒绝", () => {
  const ok = conversationSummaryOutputSchema.safeParse({
    title: "光合作用复习",
    topics: ["光合作用"],
    userGoals: ["掌握光合作用"],
    keyEvents: ["完成复习"],
    userPreferences: ["喜欢语音"],
    followUps: ["对比细胞呼吸"],
    emotionalState: "positive",
  });
  assert.equal(ok.success, true);
  const bad = conversationSummaryOutputSchema.safeParse({ topics: [] });
  assert.equal(bad.success, false);
});

test("summarizer prompt: 要求只输出 JSON（json_object 模式配套）", () => {
  const messages = buildSummarizerMessages("用户：你好");
  assert.match(messages[0].content, /只输出 JSON/);
});

// 2026-08-24：summarizer 复用 memory-extractor 的容错解析——
// ```json fence 包裹与前后赘述不再丢摘要。
import { parseMemoryExtractJson } from "./companion-memory-extractor.ts";

test("summarizer 解析链: fence 包裹的摘要 JSON 可容错解析", () => {
  const raw = '```json\n{"title":"测试","topics":[],"userGoals":[],"keyEvents":[],"userPreferences":[],"followUps":[],"emotionalState":"neutral"}\n```';
  const parsed = conversationSummaryOutputSchema.parse(parseMemoryExtractJson(raw));
  assert.equal(parsed.title, "测试");
});

