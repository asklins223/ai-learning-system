import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExtractMessages, memoryExtractOutputSchema } from "./companion-memory-extractor.ts";

test("memory extract messages: 包含 system 提示与拼接对话", () => {
  const messages = buildExtractMessages({
    userText: "我喜欢语音讲解",
    assistantText: "好呀，以后多用语音。",
    recent: [{ role: "user", text: "今天学光合作用" }],
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /记忆整理器/);
  assert.match(messages[1].content, /我喜欢语音讲解/);
});

test("memory extract schema: 合法候选通过，低置信仍可解析", () => {
  const parsed = memoryExtractOutputSchema.safeParse({
    version: 1,
    candidates: [
      { kind: "preference", content: "喜欢语音讲解", importance: 0.7, confidence: 0.8, scope: "workspace", linkedEntityIds: [] },
    ],
  });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.candidates[0].kind, "preference");
});
