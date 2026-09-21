import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExtractMessages,
  isVolatileStatisticMemory,
  memoryExtractOutputSchema,
  parseMemoryExtractJson,
} from "./companion-memory-extractor.ts";

test("isVolatileStatisticMemory：拦『现在这一份』统计，不拦用户说过的带数字偏好", () => {
  // 实机被写进 learning_context 的那条（里面的 23 分钟本来就是编的）。
  assert.equal(isVolatileStatisticMemory("截至当前，用户本周累计学习时长为23分钟，拥有10张活跃卡片和9篇笔记。"), true);
  assert.equal(isVolatileStatisticMemory("用户今天学了 45 分钟。"), true);
  // 稳定偏好：带数字但不是"当下这份统计"。
  assert.equal(isVolatileStatisticMemory("每天只能挤出四十分钟学习，希望练习节奏短一点"), false);
  assert.equal(isVolatileStatisticMemory("用户偏好短节奏学习，每次练习约10分钟，每天总计约40分钟，中间需休息。"), false);
  assert.equal(isVolatileStatisticMemory("下个月要考日语N3"), false);
});

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

// ─── schema 宽容度（§9.11：88 次解析失败的主因是契约没告诉模型、又卡得死）──
// 模型自然输出的是"最小可用形状"，schema 必须接住它。

test("schema：省略 version 字段可解析（以前 z.literal(1) 必填 → 整单失败）", () => {
  const out = memoryExtractOutputSchema.safeParse({
    candidates: [{ kind: "goal", content: "下个月考日语N3", confidence: 0.9 }],
  });
  assert.equal(out.success, true, JSON.stringify(out.success ? {} : out.error.issues));
  if (out.success) {
    assert.equal(out.data.version, 1, "version 应回填默认 1");
    assert.equal(out.data.candidates[0].importance, 0.5, "importance 有默认");
    assert.equal(out.data.candidates[0].scope, "workspace", "scope 有默认");
    assert.deepEqual(out.data.candidates[0].linkedEntityIds, []);
  }
});

test("schema：超过 3 条时截断保留前 3 条，而不是判整单失败", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    kind: "preference", content: `偏好 ${i}`, confidence: 0.8,
  }));
  const out = memoryExtractOutputSchema.safeParse({ candidates: many });
  assert.equal(out.success, true);
  if (out.success) assert.equal(out.data.candidates.length, 3);
});

test("schema：confidence 仍必填——它是置信度闸的输入，给默认值等于替模型表态", () => {
  const out = memoryExtractOutputSchema.safeParse({
    candidates: [{ kind: "goal", content: "没有置信度的条目" }],
  });
  assert.equal(out.success, false);
});

test("schema：kind 非法枚举仍被拒（宽容只针对缺省，不针对错值）", () => {
  const out = memoryExtractOutputSchema.safeParse({
    candidates: [{ kind: "secret", content: "不该被接受", confidence: 0.9 }],
  });
  assert.equal(out.success, false);
});

test("prompt 必须把 JSON 形状与枚举写给模型（契约不能只在代码里）", () => {
  const messages = buildExtractMessages({ userText: "u", assistantText: "a", recent: [] });
  const system = messages[0].content;
  assert.ok(system.includes('"candidates"'), "prompt 未给出 JSON 形状");
  for (const kind of ["goal", "preference", "learning_context", "interaction_note", "episodic"]) {
    assert.ok(system.includes(kind), `prompt 未列出枚举 ${kind}`);
  }
  assert.ok(system.includes("confidence"), "prompt 未说明 confidence");
});
