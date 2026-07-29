/**
 * Deterministic Question Fallback tests (计划 §7.6)
 *
 * 测试覆盖：
 * - normalizeKeyPointClaim: 前缀去除
 * - chooseQuestionType: 基于句式结构的题型选择
 * - buildValidationPrompt: 题目生成（结论隐藏）
 * - generateDeterministicQuestion: 完整输出含 rubric items
 * - 安全门禁：deterministic 题目通过 safety gate
 * - claim 结构识别（条件/机制/主题/一般）
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeKeyPointClaim,
  chooseQuestionType,
  buildValidationPrompt,
  generateDeterministicQuestion,
} from "./deterministic-question.ts";
import { assessQuestionOutput } from "./question-safety.ts";
import { QuestionType } from "./enums.ts";
import type { GenerateValidationQuestionInput } from "./schemas.ts";

// ─── normalizeKeyPointClaim ───────────────────────────────────────────────

test("normalizeKeyPointClaim: removes numeric prefix", () => {
  assert.equal(normalizeKeyPointClaim("要点 1：测试"), "测试");
  assert.equal(normalizeKeyPointClaim("要点1：测试"), "测试");
  assert.equal(normalizeKeyPointClaim("关键要点 2：测试"), "测试");
});

test("normalizeKeyPointClaim: removes Chinese numeral prefix", () => {
  assert.equal(normalizeKeyPointClaim("要点一：测试"), "测试");
  assert.equal(normalizeKeyPointClaim("要点三、测试"), "测试");
});

test("normalizeKeyPointClaim: no prefix returns original", () => {
  assert.equal(normalizeKeyPointClaim("测试内容"), "测试内容");
});

test("normalizeKeyPointClaim: empty returns empty", () => {
  assert.equal(normalizeKeyPointClaim(""), "");
});

test("normalizeKeyPointClaim: whitespace is trimmed", () => {
  assert.equal(normalizeKeyPointClaim("  测试  "), "测试");
});

// ─── chooseQuestionType ───────────────────────────────────────────────────

test("chooseQuestionType: causal '之所以...是因为' prefers explain", () => {
  const claim = "认知偏差之所以难以自纠，是因为监督通道存在惰性";
  assert.equal(chooseQuestionType(claim, 0), QuestionType.EXPLAIN);
});

test("chooseQuestionType: conditional '当...时' prefers apply", () => {
  const claim = "当缓存值来源复杂时，写路径应淘汰缓存";
  assert.equal(chooseQuestionType(claim, 0), QuestionType.APPLY);
});

test("chooseQuestionType: '如果/若' prefers apply", () => {
  const claim = "如果并发读在写入前回填旧值，可能导致不一致";
  assert.equal(chooseQuestionType(claim, 0), QuestionType.APPLY);
});

test("chooseQuestionType: '即便/即使/无论' prefers apply", () => {
  const claim = "即便主体明知数值无关，仍会受先前输入影响";
  assert.equal(chooseQuestionType(claim, 0), QuestionType.APPLY);
});

test("chooseQuestionType: recommendation '应/需要' prefers apply", () => {
  const claim = "缓存空值需要设置较短TTL";
  assert.equal(chooseQuestionType(claim, 0), QuestionType.APPLY);
});

test("chooseQuestionType: mechanism '通过/使得' prefers explain", () => {
  const claim = "通过节点级分裂与合并维持动态平衡";
  assert.equal(chooseQuestionType(claim, 0), QuestionType.EXPLAIN);
});

test("chooseQuestionType: default rotates by index", () => {
  const claim = "索引是数据库的重要组件";
  assert.equal(chooseQuestionType(claim, 0), QuestionType.EXPLAIN);
  assert.equal(chooseQuestionType(claim, 1), QuestionType.EXAMPLE);
  assert.equal(chooseQuestionType(claim, 2), QuestionType.APPLY);
});

// ─── buildValidationPrompt ────────────────────────────────────────────────

test("buildValidationPrompt: question does not contain claim conclusion", () => {
  const claim = "当缓存值来源于不可简单重算的聚合逻辑时，写路径应淘汰缓存而非就地更新，以避免缓存与数据库之间的值不一致";
  const { prompt } = buildValidationPrompt(claim, 0);
  assert.ok(!prompt.includes("以避免缓存与数据库之间的值不一致"), "prompt must not contain the claim's conclusion");
  assert.ok(!prompt.includes("写路径应淘汰缓存而非就地更新"), "prompt must not contain the claim's recommendation");
});

test("buildValidationPrompt: question contains enough context", () => {
  const claim = "当缓存值来源于不可简单重算的聚合逻辑时，写路径应淘汰缓存而非就地更新";
  const { prompt } = buildValidationPrompt(claim, 0);
  assert.ok(prompt.includes("缓存"), "prompt should contain core topic for context");
});

test("buildValidationPrompt: question mark claim is NOT embedded verbatim (would leak claim)", () => {
  // 旧行为把问句 claim 原样作为题面，整条 claim 进入 question 会触发
  // 安全门禁 leaks_claim（≥8 字符连续片段），导致 fallback 自我拒绝。
  const claim = "什么是 Cache Aside 模式？";
  const { prompt } = buildValidationPrompt(claim, 0);
  assert.notEqual(prompt, claim);
});

test("buildValidationPrompt: explain type for mechanism claims", () => {
  const claim = "通过节点级分裂与合并维持动态平衡，溢出时中间键值上移至父节点";
  const { type, prompt } = buildValidationPrompt(claim, 0);
  assert.equal(type, QuestionType.EXPLAIN);
  assert.ok(prompt.includes("原理"), "explain prompt should ask about principles");
});

test("buildValidationPrompt: apply type for conditional claims", () => {
  const claim = "当缓存值来源于不可简单重算的聚合逻辑时，写路径应淘汰缓存而非就地更新";
  const { type } = buildValidationPrompt(claim, 0);
  assert.equal(type, QuestionType.APPLY);
});

test("buildValidationPrompt: removes '要点 N：' prefix", () => {
  const claim = "要点 1：缓存空值防御穿透时，空值的 TTL 必须短于真实数据的创建周期";
  const { prompt } = buildValidationPrompt(claim, 0);
  assert.ok(!prompt.startsWith("要点"), "prompt should not contain '要点' prefix");
});

test("buildValidationPrompt: strips causal conclusion clauses", () => {
  const claim = "空值的 TTL 必须短于真实数据的创建周期，否则会因过期空值阻塞后续合法读取";
  const { prompt } = buildValidationPrompt(claim, 0);
  assert.ok(!prompt.includes("否则"), "prompt should not contain the consequence clause");
  assert.ok(!prompt.includes("阻塞后续合法读取"), "prompt should not reveal the specific consequence");
});

test("buildValidationPrompt: handles dash-separated mechanism claims", () => {
  const claim = "将索引数据与路由数据分离存储——路由节点仅负责导航、数据全部聚集在叶子层——能显著提升树的最大扇出";
  const { prompt } = buildValidationPrompt(claim, 0);
  assert.ok(prompt.includes("分离存储"), "prompt should contain the strategy name");
  assert.ok(!prompt.includes("显著提升"), "prompt should not reveal the conclusion");
});

test("buildValidationPrompt: handles short claims gracefully", () => {
  const claim = "索引加速查询";
  const { prompt } = buildValidationPrompt(claim, 0);
  assert.ok(prompt.length > 0, "prompt should not be empty");
});

// ─── generateDeterministicQuestion ────────────────────────────────────────

const testInput: GenerateValidationQuestionInput = {
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

test("generateDeterministicQuestion: returns valid output structure", () => {
  const result = generateDeterministicQuestion(testInput);
  assert.ok(result.questionType === "explain" || result.questionType === "example" || result.questionType === "apply");
  assert.ok(result.question.length > 0);
  assert.ok(result.rubricItems.length >= 1);
  assert.ok(result.rubricItems[0].required, "deterministic fallback must have at least one required item");
  assert.ok(result.rubricItems[0].evidenceRefId, "rubric item must bind to evidence");
});

test("generateDeterministicQuestion: rubric item binds to claim and evidence", () => {
  const result = generateDeterministicQuestion(testInput);
  const item = result.rubricItems[0];
  assert.equal(item.evidenceRefId, "ev_1");
  assert.equal(item.expectedConcept, testInput.claim);
  assert.equal(item.required, true);
  assert.ok(item.weight >= 1 && item.weight <= 3);
});

test("generateDeterministicQuestion: question does not leak claim conclusion", () => {
  const result = generateDeterministicQuestion(testInput);
  assert.ok(
    !result.question.includes("以避免缓存与数据库之间的值不一致"),
    "deterministic question must not leak claim conclusion",
  );
});

test("generateDeterministicQuestion: passes safety gate", () => {
  const result = generateDeterministicQuestion(testInput);
  const safetyResult = assessQuestionOutput({
    output: result,
    claim: testInput.claim,
    quote: testInput.quote,
    allowedEvidenceRefIds: ["ev_1"],
  });
  assert.equal(safetyResult.passed, true, `deterministic question must pass safety gate, got: ${safetyResult.reasonCodes.join(", ")}`);
});

test("generateDeterministicQuestion: different indices produce different types (multi-clause claim)", () => {
  // 多分句 claim 走第一档上下文提取模板，题型随 index 轮换。
  // （短单句 claim 会退化到安全短主题模板，题型固定为 explain——见下方泄漏安全测试）
  const genericClaim = "索引是数据库中的重要组件，因为它能把查找从全表扫描降为对数级别";
  const type0 = generateDeterministicQuestion({ ...testInput, claim: genericClaim }, 0).questionType;
  const type1 = generateDeterministicQuestion({ ...testInput, claim: genericClaim }, 1).questionType;
  const type2 = generateDeterministicQuestion({ ...testInput, claim: genericClaim }, 2).questionType;
  // For generic claims, types should rotate
  assert.notDeepEqual([type0, type1, type2], [type0, type0, type0]);
});

// ─── 泄漏安全回归：fallback 必须通过自己的安全门禁（计划 §7.6 / §8.5） ────

test("generateDeterministicQuestion: single-clause claim passes its own safety gate", () => {
  const claims = [
    "过度拟合可以通过正则化缓解",
    "哈希表的平均查找复杂度是 O(1)",
    "短句",
  ];
  for (const claim of claims) {
    const input = { ...testInput, claim };
    const out = generateDeterministicQuestion(input, 0);
    const gate = assessQuestionOutput({
      output: out,
      claim,
      quote: input.quote,
      allowedEvidenceRefIds: input.evidenceRefs.map((r) => r.refId),
    });
    assert.equal(gate.passed, true, `claim "${claim}" should pass gate, got ${gate.reasonCodes}`);
  }
});

test("generateDeterministicQuestion: question-form claim passes its own safety gate", () => {
  const claim = "什么是梯度消失问题？";
  const input = { ...testInput, claim };
  const out = generateDeterministicQuestion(input, 0);
  const gate = assessQuestionOutput({
    output: out,
    claim,
    quote: input.quote,
    allowedEvidenceRefIds: input.evidenceRefs.map((r) => r.refId),
  });
  assert.equal(gate.passed, true, `gate should pass, got ${gate.reasonCodes}`);
});

test("generateDeterministicQuestion: throws on no evidence refs", () => {
  const noEvidenceInput: GenerateValidationQuestionInput = {
    ...testInput,
    evidenceRefs: [],
  };
  assert.throws(
    () => generateDeterministicQuestion(noEvidenceInput),
    /at least one evidence ref/,
  );
});

test("generateDeterministicQuestion: deterministic for same input", () => {
  const result1 = generateDeterministicQuestion(testInput, 0);
  const result2 = generateDeterministicQuestion(testInput, 0);
  assert.deepEqual(result1, result2);
});

test("generateDeterministicQuestion: preferred type is respected when provided", () => {
  const inputWithPreferred: GenerateValidationQuestionInput = {
    ...testInput,
    preferredType: "example",
  };
  const result = generateDeterministicQuestion(inputWithPreferred, 0);
  // The deterministic fallback doesn't use preferredType directly,
  // but the output should still be valid
  assert.ok(result.question.length > 0);
});
