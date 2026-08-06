/**
 * MockProvider 单元测试
 *
 * 覆盖 evaluateValidation 的所有逻辑分支：
 * - abort signal 提前终止
 * - 不同 overlap 阈值返回不同 outcome
 *
 * R5: Business methods removed from provider; tests now use
 * evaluateValidationViaChat helper from business-ai-ops.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MockProvider } from "../lib/providers/mock.ts";
import { evaluateValidationViaChat } from "../lib/business-ai-ops.ts";

const provider = new MockProvider();


// ─── evaluateValidation ─────────────────────────────────────────────────────

test("evaluateValidation: abort signal 已终止时抛异常（R-007）", async () => {
  const signal = new AbortController();
  signal.abort();

  await assert.rejects(
    evaluateValidationViaChat(provider, {
      claim: "test claim",
      quote: "test quote",
      question: "test question",
      questionType: "test",
      userAnswer: "answer",
    }, signal.signal),
    /aborted/,
  );
});

test("evaluateValidation: overlap > 0.6 返回 preliminary_understanding", async () => {
  const result = await evaluateValidationViaChat(provider, {
    question: "test",
    questionType: "test",
    claim: "测试声明内容",
    quote: "测试声明内容 有更多文字",
    userAnswer: "测试声明内容 有更多文字 类似的答案", // 使用完全相同的 quote
  });

  assert.equal(result.output.outcome, "preliminary_understanding");
  assert.equal(result.output.confidence, 0.9);
  assert.ok(result.output.feedback.includes("回答与原文一致"));
  assert.equal(result.output.covered_points.length, 1);
  assert.equal(result.output.missing_points.length, 0);
  assert.equal(result.output.misunderstandings.length, 0);
});

test("evaluateValidation: overlap > 0.3 且 <= 0.6 返回 unclear_expression", async () => {
  const result = await evaluateValidationViaChat(provider, {
    question: "test",
    questionType: "test",
    claim: "长句子的声明内容用于测试 overlap 计算",
    quote: "长句子的声明内容用于测试 overlap 计算",
    userAnswer: "长句子的声明内容 overlap 测试 部分命中其他", // 部分命中
  });

  assert.equal(result.output.outcome, "unclear_expression");
  assert.equal(result.output.confidence, 0.6);
  assert.ok(result.output.feedback.includes("部分要点命中"));
  assert.equal(result.output.missing_points.length, 1);
});

test("evaluateValidation: overlap > 0.05 且 <= 0.3 返回 unclear_expression (低 confidence)", async () => {
  const result = await evaluateValidationViaChat(provider, {
    question: "test",
    questionType: "test",
    claim: "test",
    quote: "word1 word2 word3 word4 word5 word6 word7 word8",
    userAnswer: "word1 word2 other", // 命中：word1, word2（2/8=0.25）
  });

  // overlap 0.25 在 0.05-0.3 之间，应该返回 unclear_expression
  assert.equal(result.output.outcome, "unclear_expression");
  assert.equal(result.output.confidence, 0.4);
  assert.ok(result.output.feedback.includes("与原文相关性较弱"));
});

test("evaluateValidation: overlap <= 0.05 返回 misunderstanding", async () => {
  const result = await evaluateValidationViaChat(provider, {
    question: "test",
    questionType: "test",
    claim: "完全不相关的内容声明",
    quote: "完全不同的文本内容",
    userAnswer: "完全无关的答案",
  });

  assert.equal(result.output.outcome, "misunderstanding");
  assert.equal(result.output.confidence, 0.7);
  assert.ok(result.output.feedback.includes("未命中原文要点"));
  assert.equal(result.output.misunderstandings.length, 1);
  assert.ok(result.output.evidence_refs.length > 0);
});

test("evaluateValidation: claim 截断至 40 字符用于 covered_points", async () => {
  const longClaim = "a".repeat(100);
  const result = await evaluateValidationViaChat(provider, {
    question: "test",
    questionType: "test",
    claim: longClaim,
    quote: "quote text",
    userAnswer: "unrelated",
  });

  assert.ok(result.output.misunderstandings.length > 0);
  assert.ok(result.output.misunderstandings[0].length <= 40);
});

test("evaluateValidation: quote 截断至 60 字符用于 evidence_refs", async () => {
  const longQuote = "b".repeat(200);
  const result = await evaluateValidationViaChat(provider, {
    question: "test",
    questionType: "test",
    claim: "claim",
    quote: longQuote,
    userAnswer: "unrelated",
  });

  assert.ok(result.output.evidence_refs.length > 0);
  assert.ok(result.output.evidence_refs[0].length <= 60);
});

test("evaluateValidation: 空 quote 时 overlap 计算不崩溃", async () => {
  const result = await evaluateValidationViaChat(provider, {
    question: "test",
    questionType: "test",
    claim: "claim",
    quote: "",
    userAnswer: "answer",
  });

  assert.ok(result); // 应正常返回而不崩溃
  assert.ok(["unclear_expression", "misunderstanding"].includes(result.output.outcome));
});
