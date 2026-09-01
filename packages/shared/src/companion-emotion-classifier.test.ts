import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCompanionReplyEmotion } from "./companion-emotion-classifier";

test("happy：恭喜/成功/鼓励类回复", () => {
  const r = classifyCompanionReplyEmotion("恭喜你！这次复习通过啦，继续保持节奏～");
  assert.equal(r.emotion, "happy");
  assert.ok(r.intensity >= 0.3 && r.intensity <= 0.9, `intensity in range, got ${r.intensity}`);
  assert.ok(r.matched.length >= 2, "matches multiple keywords");
});

test("happy：多个命中词提升强度且 clamp 上限", () => {
  const text = "恭喜！太棒了！你成功了，真棒，继续保持，开心！".repeat(4);
  const r = classifyCompanionReplyEmotion(text);
  assert.equal(r.emotion, "happy");
  assert.ok(r.intensity <= 0.9, "clamped at 0.9");
});

test("surprised：惊讶类回复（避开 happy 命中词）", () => {
  const r = classifyCompanionReplyEmotion("哇，真是出乎意料！");
  assert.equal(r.emotion, "surprised");
});

test("curious：探索/提问类回复", () => {
  const r = classifyCompanionReplyEmotion("我很好奇，你是怎么理解这个概念的呢？");
  assert.equal(r.emotion, "curious");
});

test("concerned：关怀类回复", () => {
  const r = classifyCompanionReplyEmotion("没关系，慢慢来，别给自己太大压力。");
  assert.equal(r.emotion, "concerned");
});

test("否定前缀抵消：不开心/没通过 不触发 happy", () => {
  assert.equal(classifyCompanionReplyEmotion("最近有点不开心。").emotion, "neutral");
  assert.equal(classifyCompanionReplyEmotion("这次没通过。").emotion, "neutral");
});

test("否定前缀抵消（2026-08-25 回归）：间隔否定不误判 happy", () => {
  // "没有进步"、"不太棒"、"未达成"——否定词与关键词之间至多隔一个衬字。
  assert.equal(classifyCompanionReplyEmotion("这学期没有进步。").emotion, "neutral");
  assert.equal(classifyCompanionReplyEmotion("成绩并不太棒。").emotion, "neutral");
  assert.equal(classifyCompanionReplyEmotion("这次任务并未达成。").emotion, "neutral");
});

test("未命中回落 neutral/0.30（03 合同 §5.2 兜底值）", () => {
  const r = classifyCompanionReplyEmotion("今天的复习安排就是这样。");
  assert.deepEqual(r, { emotion: "neutral", intensity: 0.3, matched: [] });
});

test("空文本回落 neutral", () => {
  assert.equal(classifyCompanionReplyEmotion("").emotion, "neutral");
});

test("规则顺序即优先级：同时含 happy 与 curious 词时取 happy", () => {
  const r = classifyCompanionReplyEmotion("太棒了！我也很好奇你是怎么做到的。");
  assert.equal(r.emotion, "happy");
});

test("NFC 归一化：全角/半角混排仍可命中", () => {
  const r = classifyCompanionReplyEmotion("恭喜你！恭喜你！");
  assert.equal(r.emotion, "happy");
  assert.equal(r.matched.filter((k) => k === "恭喜").length, 2, "counts every occurrence");
});
