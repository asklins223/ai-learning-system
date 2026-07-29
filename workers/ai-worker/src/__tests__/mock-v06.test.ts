/**
 * MockProvider v0.6 method tests
 *
 * Tests generateValidationQuestion and evaluateRubric methods
 * added in v0.6 (计划 §7.1, §7.2).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MockProvider } from "../lib/providers/mock.ts";
import { generateValidationQuestionOutputSchema, evaluateRubricOutputSchema } from "@ailearn/shared";
import { assessQuestionOutput } from "@ailearn/shared";
import type { GenerateValidationQuestionInput, EvaluateRubricInput } from "@ailearn/shared";

const provider = new MockProvider();

const validInput: GenerateValidationQuestionInput = {
  claim: "当缓存值来源于不可简单重算的聚合逻辑时，写路径应淘汰缓存而非就地更新，以避免缓存与数据库之间的值不一致",
  quote: "删除缓存通常比更新缓存更稳妥，因为缓存值可能由复杂查询或聚合计算得到。",
  evidenceRefs: [
    {
      refId: "ev_1",
      quoteText: "删除缓存通常比更新缓存更稳妥，因为缓存值可能由复杂查询或聚合计算得到。",
      alignment: "aligned",
    },
  ],
};

// ─── generateValidationQuestion ───────────────────────────────────────────

test("MockProvider.generateValidationQuestion: returns valid output", async () => {
  const result = await provider.generateValidationQuestion(validInput);
  const parsed = generateValidationQuestionOutputSchema.safeParse(result);
  assert.ok(parsed.success, "output should pass schema validation");
});

test("MockProvider.generateValidationQuestion: has questionType", async () => {
  const result = await provider.generateValidationQuestion(validInput);
  assert.ok(["explain", "example", "apply"].includes(result.questionType));
});

test("MockProvider.generateValidationQuestion: has question text", async () => {
  const result = await provider.generateValidationQuestion(validInput);
  assert.ok(result.question.length > 0);
});

test("MockProvider.generateValidationQuestion: has 2-5 rubric items", async () => {
  const result = await provider.generateValidationQuestion(validInput);
  assert.ok(result.rubricItems.length >= 2, "should have at least 2 rubric items");
  assert.ok(result.rubricItems.length <= 5, "should have at most 5 rubric items");
});

test("MockProvider.generateValidationQuestion: at least one required item", async () => {
  const result = await provider.generateValidationQuestion(validInput);
  const hasRequired = result.rubricItems.some((item) => item.required);
  assert.ok(hasRequired, "should have at least one required rubric item");
});

test("MockProvider.generateValidationQuestion: all evidenceRefIds from allowlist", async () => {
  const result = await provider.generateValidationQuestion(validInput);
  for (const item of result.rubricItems) {
    assert.equal(item.evidenceRefId, "ev_1");
  }
});

test("MockProvider.generateValidationQuestion: keys are unique", async () => {
  const result = await provider.generateValidationQuestion(validInput);
  const keys = result.rubricItems.map((item) => item.key);
  const uniqueKeys = new Set(keys);
  assert.equal(keys.length, uniqueKeys.size, "all keys should be unique");
});

test("MockProvider.generateValidationQuestion: weights are 1-3", async () => {
  const result = await provider.generateValidationQuestion(validInput);
  for (const item of result.rubricItems) {
    assert.ok(item.weight >= 1 && item.weight <= 3, `weight should be 1-3, got ${item.weight}`);
  }
});

test("MockProvider.generateValidationQuestion: respects preferredType", async () => {
  const input: GenerateValidationQuestionInput = {
    ...validInput,
    preferredType: "example",
  };
  const result = await provider.generateValidationQuestion(input);
  assert.equal(result.questionType, "example");
});

test("MockProvider.generateValidationQuestion: throws on no evidence refs", async () => {
  const input: GenerateValidationQuestionInput = {
    ...validInput,
    evidenceRefs: [],
  };
  await assert.rejects(
    () => provider.generateValidationQuestion(input),
    /at least one evidence ref/,
  );
});

test("MockProvider.generateValidationQuestion: abort signal throws", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => provider.generateValidationQuestion(validInput, controller.signal),
    /aborted/,
  );
});

test("MockProvider.generateValidationQuestion: output passes safety gate", async () => {
  const result = await provider.generateValidationQuestion(validInput);
  const safetyResult = assessQuestionOutput({
    output: result,
    claim: validInput.claim,
    quote: validInput.quote,
    allowedEvidenceRefIds: ["ev_1"],
  });
  // Mock output should pass the safety gate
  assert.ok(safetyResult.passed, `mock output should pass safety gate, got: ${safetyResult.reasonCodes.join(", ")}`);
});

// ─── evaluateRubric ───────────────────────────────────────────────────────

const validRubricInput: EvaluateRubricInput = {
  question: "请解释缓存策略的选择原则",
  questionType: "explain",
  userAnswer: "当缓存数据来源复杂时应该淘汰缓存而不是更新，这样可以避免不一致",
  rubricItems: [
    {
      rubricItemId: "rp_1",
      criterion: "回答识别出缓存值来源复杂这一前提条件",
      weight: 3,
      required: true,
    },
    {
      rubricItemId: "rp_2",
      criterion: "回答指出应淘汰缓存而非就地更新",
      weight: 3,
      required: true,
    },
  ],
};

test("MockProvider.evaluateRubric: returns valid output", async () => {
  const result = await provider.evaluateRubric(validRubricInput);
  const parsed = evaluateRubricOutputSchema.safeParse(result);
  assert.ok(parsed.success, "output should pass schema validation");
});

test("MockProvider.evaluateRubric: itemResults match input items", async () => {
  const result = await provider.evaluateRubric(validRubricInput);
  assert.equal(result.itemResults.length, validRubricInput.rubricItems.length);
  const inputIds = new Set(validRubricInput.rubricItems.map((item) => item.rubricItemId));
  for (const itemResult of result.itemResults) {
    assert.ok(inputIds.has(itemResult.rubricItemId), `rubricItemId ${itemResult.rubricItemId} should be in input`);
  }
});

test("MockProvider.evaluateRubric: verdicts are valid", async () => {
  const result = await provider.evaluateRubric(validRubricInput);
  const validVerdicts = ["covered", "partial", "missing", "contradicted", "not_assessable"];
  for (const item of result.itemResults) {
    assert.ok(validVerdicts.includes(item.verdict), `verdict should be valid, got ${item.verdict}`);
  }
});

test("MockProvider.evaluateRubric: confidence is 0-1", async () => {
  const result = await provider.evaluateRubric(validRubricInput);
  for (const item of result.itemResults) {
    assert.ok(item.confidence >= 0 && item.confidence <= 1);
  }
});

test("MockProvider.evaluateRubric: has feedback", async () => {
  const result = await provider.evaluateRubric(validRubricInput);
  assert.ok(result.feedback.length > 0);
});

test("MockProvider.evaluateRubric: abort signal throws", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => provider.evaluateRubric(validRubricInput, controller.signal),
    /aborted/,
  );
});

test("MockProvider.evaluateRubric: high overlap answer gets covered verdicts", async () => {
  const input: EvaluateRubricInput = {
    ...validRubricInput,
    userAnswer: "缓存策略选择原则是当缓存值来源复杂时淘汰缓存而非更新，这样可以避免缓存与数据库之间的值不一致",
  };
  const result = await provider.evaluateRubric(input);
  const hasCovered = result.itemResults.some((item) => item.verdict === "covered");
  assert.ok(hasCovered, "high overlap answer should get at least one covered verdict");
});

test("MockProvider.evaluateRubric: empty answer gets not_assessable", async () => {
  const input: EvaluateRubricInput = {
    ...validRubricInput,
    userAnswer: "不",
  };
  const result = await provider.evaluateRubric(input);
  const hasNotAssessable = result.itemResults.some((item) => item.verdict === "not_assessable");
  assert.ok(hasNotAssessable, "very short answer should get not_assessable");
});
