/**
 * run-structured 生成器与确定性评估单测（P4 practice 首发路径）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessStructuredBundlePayload,
  assessStructuredPayload,
  generateOrderingTask,
  generateRelationTask,
  generateRepairTask,
  generateStructuredBundleTask,
  splitClaimIntoTokens,
} from "./run-structured.ts";

const target = {
  keyPointId: "kp-1",
  claim: "遗忘曲线表明复习间隔决定长期记忆，主动回忆比重复阅读更有效。",
  quote: "间隔重复能显著降低遗忘率。",
};

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
