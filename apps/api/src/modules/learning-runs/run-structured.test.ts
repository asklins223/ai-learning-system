/**
 * run-structured 生成器与确定性评估单测（P4 practice 首发路径）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessStructuredBundlePayload,
  assessStructuredPayload,
  generateChoiceTask,
  generateMatchingTask,
  generateOrderingTask,
  generateRelationTask,
  generateRepairTask,
  generateStructuredBundleTask,
  generateTrueFalseTask,
  splitClaimIntoTokens,
} from "./run-structured.ts";

const target = {
  keyPointId: "kp-1",
  claim: "遗忘曲线表明复习间隔决定长期记忆，主动回忆比重复阅读更有效。",
  quote: "间隔重复能显著降低遗忘率。",
};

// 客观题夹具：作者产出的练习件（选项 + 正确项 + 命题），字段形状对齐方案 §4。
const choiceInput = {
  options: [
    { unitId: "u1", text: "主动回忆比重复阅读更能延长保持" },
    { unitId: "u2", text: "重复阅读比重复提取更能延长保持" },
    { unitId: "u3", text: "复习间隔对长期记忆没有影响" },
  ],
  correctUnitId: "u1",
};

const trueFalseInput = {
  proposition: "间隔越长的复习对长期记忆一定越好。",
  expected: false,
};

const matchingInput = {
  pairs: [
    { leftId: "l1", leftText: "提", rightId: "r1", rightText: "提起灭火器" },
    { leftId: "l2", leftText: "拔", rightId: "r2", rightText: "拔掉保险销" },
    { leftId: "l3", leftText: "握", rightId: "r3", rightText: "握住喷管" },
  ],
};

/** 合法练习件素材却返回 null 就是实现的问题；显式抛错让类型收窄。 */
function requireTask<T>(task: T | null): T {
  if (!task) throw new Error("合法练习件素材不应返回 null");
  return task;
}

test("splitClaimIntoTokens：按标点切句，短 claim 回退短语切分", () => {
  const tokens = splitClaimIntoTokens(target.claim);
  assert.ok(tokens.length >= 2);
  assert.ok(tokens.length <= 6);
  assert.ok(tokens.every((t) => t.length > 0));
  // 短 claim 回退
  const short = splitClaimIntoTokens("遗忘曲线");
  assert.ok(short.length === 1);
});

test("generateOrderingTask：public 乱序不泄答案，solution 含正确顺序", () => {
  const task = generateOrderingTask(target);
  const correct = task.solution.correctTokenIds;
  const publicIds = task.interaction.publicTokenIds;
  assert.equal(publicIds.length, correct.length);
  // public 是乱序（确定性 shuffle；允许恰好相同的情况仅当 token 数 1——这里 ≥2 且乱序）。
  assert.ok(new Set(publicIds).size === publicIds.length);
  // labels 覆盖全部 token。
  for (const id of publicIds) {
    assert.ok(typeof task.publicTokenLabels[id] === "string");
  }
  // solution 的 rubric target 存在。
  assert.equal(task.solution.rubricTargetIds.length, 1);
  // 泄题防护：乱序 token 的 hash 排名使 public 顺序与正确顺序不同的概率高——
  // 用确定性断言：shuffle 后顺序等于正确顺序的情况要求 hash 单调，验证不总是相同。
  const shuffledSame = publicIds.every((id, index) => id === correct[index]);
  assert.ok(!shuffledSame || correct.length <= 2);
});

test("generateRelationTask：正确边 quote supports claim，节点含 labels", () => {
  const task = generateRelationTask(target);
  assert.equal(task.solution.requiredEdges.length, 1);
  assert.equal(task.solution.requiredEdges[0].fromNodeId, "node:quote");
  assert.equal(task.solution.requiredEdges[0].toNodeId, "node:claim");
  assert.equal(task.solution.requiredEdges[0].edgeKind, "supports");
  assert.ok(task.interaction.allowedEdgeKinds.includes("supports"));
  assert.ok(task.publicNodeLabels["node:claim"].length > 0);
});

test("generateRepairTask：挖最长词 + 干扰项，solution 签名为 replace:el:correct（哈希 id）", () => {
  const task = generateRepairTask(target);
  assert.equal(task.interaction.allowedOperationKinds.length, 1);
  assert.equal(task.interaction.allowedOperationKinds[0], "replace");
  assert.ok(task.interaction.replacementOptionIds.length >= 2);
  const accepted = task.solution.acceptedOperationSignatures[0];
  assert.match(accepted, /^replace:el:blank:opt:[0-9a-f]{10}$/);
  // 正确选项 label 是 claim 中的词；选项 id 是哈希派生（不泄露位置）。
  const correctOptionId = accepted.split(":").slice(3).join(":");
  assert.ok(target.claim.includes(task.replacementOptionLabels[correctOptionId]));
});

test("generateChoiceTask：正确项只活在私有 solution，public 载荷带不出去", () => {
  const task = requireTask(generateChoiceTask(choiceInput));
  // 正确项 id 当然是 public 选项之一（学生要点它）；要保证的是**分辨不出**它是正确项：
  // 载荷里只有 kind 与选项 id 列表，没有任何指向对错的字段，且每个选项都同样有标签。
  assert.deepEqual(Object.keys(task.interaction).sort(), ["kind", "publicOptionIds"]);
  assert.equal(task.interaction.publicOptionIds.includes(task.solution.correctOptionId), true);
  for (const id of task.interaction.publicOptionIds) {
    assert.ok(task.publicOptionLabels[id], `选项 ${id} 缺少标签`);
  }
  assert.match(task.solution.correctOptionId, /^opt:[0-9a-f]{10}$/);
  assert.deepEqual(
    [...task.interaction.publicOptionIds].sort(),
    [...task.interaction.publicOptionIds],
    "选项序列按内容哈希定序：与作者书写顺序无关",
  );
  // option id 由内容哈希派生：不含 unitId，也不编码位置。
  for (const id of task.interaction.publicOptionIds) {
    assert.match(id, /^opt:[0-9a-f]{10}$/);
    assert.equal(/u\d/.test(id), false);
  }
  // 作者把正确项写在第一个还是最后一个，public 序列都必须一样 ——
  // 否则"选项顺序"本身就把答案泄出去了。
  assert.deepEqual(
    requireTask(generateChoiceTask({
      ...choiceInput,
      options: [...choiceInput.options].reverse(),
    })).interaction.publicOptionIds,
    task.interaction.publicOptionIds,
  );
});

test("assessStructuredPayload：choice 命中 covered、错选 missing，且理由不漏答案", () => {
  const task = requireTask(generateChoiceTask(choiceInput));
  const correctLabel = task.publicOptionLabels[task.solution.correctOptionId];
  const wrongOptionId = task.interaction.publicOptionIds.find(
    (id) => id !== task.solution.correctOptionId,
  )!;

  assert.equal(
    assessStructuredPayload("choice", { selectedOptionId: task.solution.correctOptionId }, task.solution).verdict,
    "covered",
  );
  const missed = assessStructuredPayload("choice", { selectedOptionId: wrongOptionId }, task.solution);
  assert.equal(missed.verdict, "missing");
  // 判分理由会原样送到客户端：它一旦提到正确选项，就等于绕开「答案只主动查看才给」的记账。
  assert.equal(missed.userFacingReason.includes(correctLabel), false);
  assert.equal(missed.userFacingReason.includes(task.solution.correctOptionId), false);
  assert.equal(
    assessStructuredPayload("choice", {}, task.solution).verdict,
    "not_assessable",
  );
});

test("assessStructuredPayload：true_false 判对/判错，理由不倒出该判什么", () => {
  const task = generateTrueFalseTask(trueFalseInput);
  assert.equal(task.interaction.kind, "true_false");
  // 注意不能用 "JSON 里不含 true/false 字样" 来表达防泄题 —— kind 字面量
  // `true_false` 自己就同时含这两个词（第一版断言就是这么写错的）。
  // 真正的合同是：public 只有命题本身，判定只活在私有 solution。
  assert.deepEqual(Object.keys(task.interaction).sort(), ["kind", "proposition"]);
  assert.equal(task.interaction.proposition, trueFalseInput.proposition.trim());

  assert.equal(
    assessStructuredPayload("true_false", { answer: task.solution.expected }, task.solution).verdict,
    "covered",
  );
  const wrong = assessStructuredPayload(
    "true_false", { answer: !task.solution.expected }, task.solution,
  );
  assert.equal(wrong.verdict, "missing");
  assert.equal(
    assessStructuredPayload("true_false", {}, task.solution).verdict,
    "not_assessable",
  );
});

test("generateMatchingTask：public 只给两列，连线关系留在私有解里", () => {
  const task = requireTask(generateMatchingTask(matchingInput));
  assert.deepEqual(Object.keys(task.interaction).sort(), [
    "kind", "publicLabels", "publicLeftIds", "publicRightIds",
  ]);
  // 两列各自按内容哈希定序：列内顺序与配对关系无关，所以"第 i 个对第 i 个"
  // 这种一眼看穿的排布不会出现（作者按 pairs 顺序写也一样）。
  assert.deepEqual(
    [...task.interaction.publicLeftIds].sort(),
    task.interaction.publicLeftIds,
  );
  assert.deepEqual(
    [...task.interaction.publicRightIds].sort(),
    task.interaction.publicRightIds,
  );
  for (const pair of task.solution.correctPairs) {
    assert.ok(task.interaction.publicLeftIds.includes(pair.leftId));
    assert.ok(task.interaction.publicRightIds.includes(pair.rightId));
  }
});

test("assessStructuredPayload：matching 全对 covered、部分 partial、错配不涨", () => {
  const task = requireTask(generateMatchingTask(matchingInput));
  assert.equal(
    assessStructuredPayload("matching", { assignments: task.solution.correctPairs }, task.solution).verdict,
    "covered",
  );
  const swapped = task.solution.correctPairs.map((pair, index) => ({
    leftId: pair.leftId,
    rightId: task.solution.correctPairs[(index + 1) % task.solution.correctPairs.length].rightId,
  }));
  const partial = assessStructuredPayload("matching", { assignments: swapped }, task.solution);
  assert.ok(["partial", "missing"].includes(partial.verdict));
  assert.equal(
    assessStructuredPayload("matching", { assignments: [] }, task.solution).verdict,
    "not_assessable",
  );
});

test("assessStructuredPayload：ordering 全对/部分/空", () => {
  const task = generateOrderingTask(target);
  const correct = task.solution.correctTokenIds;
  assert.deepEqual(
    assessStructuredPayload("ordering", { orderedTokenIds: correct }, task.solution),
    { verdict: "covered", userFacingReason: "顺序完全正确" },
  );
  const partial = [...correct].reverse();
  const partialResult = assessStructuredPayload("ordering", { orderedTokenIds: partial }, task.solution);
  assert.ok(["partial", "missing"].includes(partialResult.verdict));
  assert.deepEqual(
    assessStructuredPayload("ordering", { orderedTokenIds: [] }, task.solution).verdict,
    "not_assessable",
  );
});

test("assessStructuredPayload：relation 匹配/错误", () => {
  const task = generateRelationTask(target);
  assert.equal(
    assessStructuredPayload("relation", { edges: task.solution.requiredEdges }, task.solution).verdict,
    "covered",
  );
  assert.equal(
    assessStructuredPayload("relation", { edges: [{ fromNodeId: "node:quote", toNodeId: "node:claim", edgeKind: "causes" }] }, task.solution).verdict,
    "missing",
  );
});

test("assessStructuredPayload：relation 不得靠穷举全部组合作弊", () => {
  const task = generateRelationTask(target);
  const nodes = task.interaction.publicNodeIds;
  // 2 节点 × 6 种 edge kind = 12 种组合，提交上限 16 —— 全量提交必然包含 required。
  const exhaustive = nodes.flatMap((from) =>
    nodes.filter((to) => to !== from).flatMap((to) =>
      task.interaction.allowedEdgeKinds.map((edgeKind) => ({ fromNodeId: from, toNodeId: to, edgeKind }))));
  const required = task.solution.requiredEdges[0];
  assert.ok(
    exhaustive.some((e) => e.fromNodeId === required.fromNodeId && e.toNodeId === required.toNodeId && e.edgeKind === required.edgeKind),
    "穷举集合必须覆盖 required（前提校验）",
  );
  assert.equal(assessStructuredPayload("relation", { edges: exhaustive }, task.solution).verdict, "partial");
  // 正确边 + 一条多余边：不得判 covered。
  assert.equal(
    assessStructuredPayload("relation", {
      edges: [...task.solution.requiredEdges, { fromNodeId: "node:claim", toNodeId: "node:quote", edgeKind: "precedes" }],
    }, task.solution).verdict,
    "partial",
  );
  // 重复提交同一条正确边同样不算正确。
  assert.equal(
    assessStructuredPayload("relation", {
      edges: [required, { ...required }],
    }, task.solution).verdict,
    "partial",
  );
});

test("assessStructuredPayload：repair 签名匹配/错误", () => {
  const task = generateRepairTask(target);
  const accepted = task.solution.acceptedOperationSignatures[0];
  // 签名格式：op:elementId:optionId（elementId 为 el:blank、optionId 为哈希 id，均含冒号）。
  const match = accepted.match(/^(replace):(el:blank):(opt:[0-9a-f]{10})$/);
  assert.ok(match, `signature shape: ${accepted}`);
  const correctOptionId = match[3];
  assert.equal(
    assessStructuredPayload("repair", {
      operations: [{ op: "replace", elementId: "el:blank", replacementOptionId: correctOptionId }],
    }, task.solution).verdict,
    "covered",
  );
  const wrongOptionId = task.interaction.replacementOptionIds.find((id) => id !== correctOptionId);
  assert.ok(wrongOptionId, "distractor option present");
  assert.equal(
    assessStructuredPayload("repair", {
      operations: [{ op: "replace", elementId: "el:blank", replacementOptionId: wrongOptionId }],
    }, task.solution).verdict,
    "missing",
  );
});

test("§5.3/§7.3 structured_bundle：双 part 生成 + 提交形状完整", () => {
  const bundle = generateStructuredBundleTask({
    keyPointId: "kp-1",
    claim: "遗忘曲线表明复习间隔决定长期记忆",
    quote: "间隔重复能显著降低遗忘率。",
  });
  assert.equal(bundle.interaction.kind, "structured_bundle");
  assert.equal(bundle.interaction.parts.length, 2);
  assert.equal(bundle.interaction.parts[0].interaction.kind, "ordering");
  assert.equal(bundle.interaction.parts[1].interaction.kind, "relation_canvas");
  assert.equal(bundle.interaction.parts[0].partTrustCeiling, "practice_only");
  // labels 覆盖两个 part 的全部公开 id。
  for (const part of bundle.interaction.parts) {
    const labels = bundle.labels[part.partId] ?? {};
    const partInteraction = part.interaction as
      | { kind: "ordering"; publicTokenIds: string[] }
      | { kind: "relation_canvas"; publicNodeIds: string[] }
      | { kind: "repair"; publicElementIds: string[] };
    const ids = partInteraction.kind === "ordering"
      ? partInteraction.publicTokenIds
      : partInteraction.kind === "relation_canvas"
        ? partInteraction.publicNodeIds
        : partInteraction.publicElementIds;
    for (const id of ids) {
      assert.ok(labels[id], `part ${part.partId} 的 id ${id} 必须有 label`);
    }
  }
  // solution：两个 part solution 内嵌 + 空 qualification（V1 无批准）。
  assert.equal(bundle.solution.partSolutions.length, 2);
  assert.equal(bundle.solution.bundleQualificationId, "");
  assert.ok(bundle.solution.rubricTargetIds.length >= 2);
});

test("§12.3 bundle 评估：全对 covered、半对 partial、空 part not_assessable", () => {
  const bundle = generateStructuredBundleTask({
    keyPointId: "kp-1",
    claim: "遗忘曲线表明复习间隔决定长期记忆",
    quote: "间隔重复能显著降低遗忘率。",
  });
  const [solutionA] = bundle.solution.partSolutions as [Record<string, unknown>, Record<string, unknown>];
  const partB = bundle.interaction.parts[1].interaction as unknown as { kind: "relation_canvas"; publicNodeIds: string[]; allowedEdgeKinds: string[] };
  const requiredA = (solutionA.correctTokenIds ?? []) as string[];

  // 全对。
  const covered = assessStructuredBundlePayload({
    kind: "structured_bundle",
    partAnswers: [
      { kind: "ordering", partId: "part:1", orderedTokenIds: requiredA, interactionRefs: [] },
      { kind: "relation", partId: "part:2", edges: [{ fromNodeId: partB.publicNodeIds[1], toNodeId: partB.publicNodeIds[0], edgeKind: "supports" }], interactionRefs: [] },
    ],
  }, bundle.solution);
  assert.equal(covered.verdict, "covered");

  // part2 错 → partial。
  const partial = assessStructuredBundlePayload({
    kind: "structured_bundle",
    partAnswers: [
      { kind: "ordering", partId: "part:1", orderedTokenIds: requiredA, interactionRefs: [] },
      { kind: "relation", partId: "part:2", edges: [{ fromNodeId: partB.publicNodeIds[0], toNodeId: partB.publicNodeIds[1], edgeKind: "contrasts_with" }], interactionRefs: [] },
    ],
  }, bundle.solution);
  assert.equal(partial.verdict, "partial");

  // 空 partAnswers → not_assessable。
  const empty = assessStructuredBundlePayload({ kind: "structured_bundle", partAnswers: [] }, bundle.solution);
  assert.equal(empty.verdict, "not_assessable");
});
