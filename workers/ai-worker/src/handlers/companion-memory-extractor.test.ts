import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExtractMessages,
  memoryExtractOutputSchema,
  parseMemoryExtractJson,
} from "./companion-memory-extractor.ts";

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

test("parseMemoryExtractJson: 纯 JSON 原样解析", () => {
  const out = parseMemoryExtractJson('{"version":1,"candidates":[]}');
  assert.deepEqual(out, { version: 1, candidates: [] });
});

test("parseMemoryExtractJson: ```json fence 包裹可剥离解析", () => {
  const out = parseMemoryExtractJson('```json\n{"version":1,"candidates":[{"kind":"preference","content":"喜欢安静","importance":0.6,"confidence":0.9,"scope":"workspace","linkedEntityIds":[]}]}\n```');
  assert.equal((out as { candidates: unknown[] }).candidates.length, 1);
});

test("parseMemoryExtractJson: 前后赘述提取首个 JSON 片段", () => {
  const out = parseMemoryExtractJson('好的，这是提取结果：{"version":1,"candidates":[]} 希望对你有帮助');
  assert.deepEqual(out, { version: 1, candidates: [] });
});

test("parseMemoryExtractJson: 全形态失败抛 SyntaxError", () => {
  assert.throws(() => parseMemoryExtractJson("完全不是 JSON"), SyntaxError);
});
