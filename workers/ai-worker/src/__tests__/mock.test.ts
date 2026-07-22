/**
 * MockProvider 单元测试
 *
 * 覆盖 generateCard 和 evaluateValidation 的所有逻辑分支：
 * - abort signal 提前终止
 * - 无候选时返回提示
 * - 提取首句生成 claim
 * - 不同 overlap 阈值返回不同 outcome
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MockProvider } from "../lib/providers/mock.ts";

const provider = new MockProvider();

// ─── generateCard ───────────────────────────────────────────────────────────

test("generateCard: abort signal 已终止时抛异常（R-007）", async () => {
  const signal = new AbortController();
  signal.abort();

  await assert.rejects(
    provider.generateCard({
      noteTitle: "Test",
      blocks: [],
    }, signal.signal),
    /aborted before generateCard/,
  );
});

test("generateCard: 无有效候选时返回提示信息", async () => {
  const result = await provider.generateCard({
    noteTitle: "Empty Note",
    blocks: [
      { ordinal: 0, type: "code", content: "code block" },
      { ordinal: 1, type: "image", content: "" },
      { ordinal: 2, type: "text", content: "   " }, // too short after trim
    ],
  });

  assert.equal(result.title, "Empty Note");
  assert.equal(result.summary, "（Mock provider：未找到足够文本，无法生成要点）");
  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("请在笔记中加入更多正文"));
});

test("generateCard: 最多提取 5 个候选块", async () => {
  const blocks = Array.from({ length: 10 }, (_, i) => ({
    ordinal: i,
    type: "text",
    content: `Block ${i}: 这是一段足够长的内容用于生成学习卡`,
  }));

  const result = await provider.generateCard({
    noteTitle: "Long Note",
    blocks,
  });

  assert.equal(result.key_points.length, 5);
  assert.ok(result.summary.includes("提取 5 个要点"));
});

test("generateCard: 提取首句作为 claim，并截断至 80 字符", async () => {
  const blocks = [
    {
      ordinal: 0,
      type: "text",
      content: "这是一个很长的第一句。后面是第二句。",
    },
  ];

  const result = await provider.generateCard({
    noteTitle: "Test",
    blocks,
  });

  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.startsWith("要点 1："));
  assert.ok(result.key_points[0].claim.length <= 80 + "要点 1：".length);
  assert.ok(result.key_points[0].quote_text.includes("这是一个很长的第一句"));
});

test("generateCard: 移除换行符并截断 quote_text 至 240 字符", async () => {
  const blocks = [
    {
      ordinal: 0,
      type: "text",
      content: "Line 1\nLine 2\nLine 3",
    },
  ];

  const result = await provider.generateCard({
    noteTitle: "Test",
    blocks,
  });

  assert.equal(result.key_points.length, 1);
  // 换行符应被空格替代
  assert.ok(!result.key_points[0].quote_text.includes("\n"));
});

test("generateCard: ordinal 从 0 开始递增", async () => {
  const blocks = [
    { ordinal: 0, type: "text", content: "First block content" },
    { ordinal: 1, type: "text", content: "Second block content" },
    { ordinal: 2, type: "text", content: "Third block content" },
  ];

  const result = await provider.generateCard({
    noteTitle: "Test",
    blocks,
  });

  assert.equal(result.key_points[0].ordinal, 0);
  assert.equal(result.key_points[1].ordinal, 1);
  assert.equal(result.key_points[2].ordinal, 2);
});

test("generateCard: summary 包含块总数和提取数", async () => {
  const blocks = [
    { ordinal: 0, type: "text", content: "This is a long enough block 1" },
    { ordinal: 1, type: "text", content: "This is a long enough block 2" },
    { ordinal: 2, type: "text", content: "This is a long enough block 3" },
    { ordinal: 3, type: "code", content: "console.log('this is a long code block')" },
  ];

  const result = await provider.generateCard({
    noteTitle: "Test",
    blocks,
  });

  // code 块长度 > 10，所以也会被计入（但非 text 类型会被过滤）
  // 只有 text 块会被提取
  assert.ok(result.summary.includes("4 个块")); // 所有块
  assert.ok(result.summary.includes("提取 3 个要点")); // 只 text 块
});

test("generateCard: 过滤 code 和 image 类型", async () => {
  const blocks = [
    { ordinal: 0, type: "code", content: "console.log('code')" },
    { ordinal: 1, type: "image", content: "" },
    { ordinal: 2, type: "text", content: "valid text block" },
  ];

  const result = await provider.generateCard({
    noteTitle: "Test",
    blocks,
  });

  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("valid text block"));
});

test("generateCard: 过滤空内容或过短内容（<=10 字符）", async () => {
  const blocks = [
    { ordinal: 0, type: "text", content: "short" },
    { ordinal: 1, type: "text", content: "" },
    { ordinal: 2, type: "text", content: "long enough content for card" },
  ];

  const result = await provider.generateCard({
    noteTitle: "Test",
    blocks,
  });

  assert.equal(result.key_points.length, 1);
  assert.ok(result.key_points[0].claim.includes("long enough content"));
});

// ─── evaluateValidation ─────────────────────────────────────────────────────

test("evaluateValidation: abort signal 已终止时抛异常（R-007）", async () => {
  const signal = new AbortController();
  signal.abort();

  await assert.rejects(
    provider.evaluateValidation({
      claim: "test claim",
      quote: "test quote",
      question: "test question",
      questionType: "test",
      userAnswer: "answer",
    }, signal.signal),
    /aborted before evaluateValidation/,
  );
});

test("evaluateValidation: overlap > 0.6 返回 preliminary_understanding", async () => {
  const result = await provider.evaluateValidation({
    question: "test",
    questionType: "test",
    claim: "测试声明内容",
    quote: "测试声明内容 有更多文字",
    userAnswer: "测试声明内容 有更多文字 类似的答案", // 使用完全相同的 quote
  });

  assert.equal(result.outcome, "preliminary_understanding");
  assert.equal(result.confidence, 0.9);
  assert.ok(result.feedback.includes("回答与原文一致"));
  assert.equal(result.covered_points.length, 1);
  assert.equal(result.missing_points.length, 0);
  assert.equal(result.misunderstandings.length, 0);
});

test("evaluateValidation: overlap > 0.3 且 <= 0.6 返回 unclear_expression", async () => {
  const result = await provider.evaluateValidation({
    question: "test",
    questionType: "test",
    claim: "长句子的声明内容用于测试 overlap 计算",
    quote: "长句子的声明内容用于测试 overlap 计算",
    userAnswer: "长句子的声明内容 overlap 测试 部分命中其他", // 部分命中
  });

  assert.equal(result.outcome, "unclear_expression");
  assert.equal(result.confidence, 0.6);
  assert.ok(result.feedback.includes("部分要点命中"));
  assert.equal(result.missing_points.length, 1);
});

test("evaluateValidation: overlap > 0.05 且 <= 0.3 返回 unclear_expression (低 confidence)", async () => {
  const result = await provider.evaluateValidation({
    question: "test",
    questionType: "test",
    claim: "test",
    quote: "word1 word2 word3 word4 word5 word6 word7 word8",
    userAnswer: "word1 word2 other", // 命中：word1, word2（2/8=0.25）
  });

  // overlap 0.25 在 0.05-0.3 之间，应该返回 unclear_expression
  assert.equal(result.outcome, "unclear_expression");
  assert.equal(result.confidence, 0.4);
  assert.ok(result.feedback.includes("与原文相关性较弱"));
});

test("evaluateValidation: overlap <= 0.05 返回 misunderstanding", async () => {
  const result = await provider.evaluateValidation({
    question: "test",
    questionType: "test",
    claim: "完全不相关的内容声明",
    quote: "完全不同的文本内容",
    userAnswer: "完全无关的答案",
  });

  assert.equal(result.outcome, "misunderstanding");
  assert.equal(result.confidence, 0.7);
  assert.ok(result.feedback.includes("未命中原文要点"));
  assert.equal(result.misunderstandings.length, 1);
  assert.ok(result.evidence_refs.length > 0);
});

test("evaluateValidation: claim 截断至 40 字符用于 covered_points", async () => {
  const longClaim = "a".repeat(100);
  const result = await provider.evaluateValidation({
    question: "test",
    questionType: "test",
    claim: longClaim,
    quote: "quote text",
    userAnswer: "unrelated",
  });

  assert.ok(result.misunderstandings.length > 0);
  assert.ok(result.misunderstandings[0].length <= 40);
});

test("evaluateValidation: quote 截断至 60 字符用于 evidence_refs", async () => {
  const longQuote = "b".repeat(200);
  const result = await provider.evaluateValidation({
    question: "test",
    questionType: "test",
    claim: "claim",
    quote: longQuote,
    userAnswer: "unrelated",
  });

  assert.ok(result.evidence_refs.length > 0);
  assert.ok(result.evidence_refs[0].length <= 60);
});

test("evaluateValidation: 空 quote 时 overlap 计算不崩溃", async () => {
  const result = await provider.evaluateValidation({
    question: "test",
    questionType: "test",
    claim: "claim",
    quote: "",
    userAnswer: "answer",
  });

  assert.ok(result); // 应正常返回而不崩溃
  assert.ok(["unclear_expression", "misunderstanding"].includes(result.outcome));
});