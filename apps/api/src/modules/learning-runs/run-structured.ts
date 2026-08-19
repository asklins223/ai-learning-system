/**
 * P4 确定性结构题生成器（文档 16 §7.3/§12.6，V1 practice 首发路径）。
 *
 * ordering / relation / repair 三类交互从 canonical 输入（claim/quote）确定性
 * 生成：public payload（不泄答案）+ private solution（correctTokenIds/
 * requiredEdges/acceptedOperationSignatures，只存 private 表）+ hash 闭包。
 *
 * §7.7 首发上限：三类 family 无 qualification 数据 → purpose=practice、
 * templateTrustCeiling=practice_only；确定性评估只产 verdicts 供学习反馈，
 * 绝不产 canonical/schedule。
 */

import { sha256Hex } from "@ailearn/shared/content-hash";
import type { RelationEdgeKindV1 } from "@ailearn/shared";
import type {
  CanonicalAnswerV2,
  ObjectiveRelationV2,
} from "@ailearn/shared/card-generation-v2-contracts";

export interface StructuredTargetInput {
  keyPointId: string;
  claim: string;
  quote: string;
}

// ─── ordering ────────────────────────────────────────────────────────────

export interface OrderingPayload {
  interaction: { kind: "ordering"; publicTokenIds: string[] };
  /** token id → 文本（public：renderer 展示用）。 */
  publicTokenLabels: Record<string, string>;
  solution: { kind: "ordering"; correctTokenIds: string[]; rubricTargetIds: string[] };
}

/** claim 切句 → 乱序 token（确定性 shuffle：按 sha256 排名）。 */
export function splitClaimIntoTokens(claim: string, maxTokens = 6): string[] {
  const parts = claim
    .split(/[，。；！？,.!?;:\n]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // 去重：相同片段只出现一次（重复 token 会因哈希 id 碰撞导致提交死锁）。
  const unique = [...new Set(parts)];
  const tokens = unique.slice(0, maxTokens);
  if (tokens.length < 2) {
    // 短 claim：按短语切分（每 8 字一段）。
    const chunks: string[] = [];
    for (let i = 0; i < claim.length; i += 8) {
      const chunk = claim.slice(i, i + 8).trim();
      if (chunk.length > 0 && !chunks.includes(chunk)) chunks.push(chunk);
    }
    return chunks.slice(0, maxTokens);
  }
  return tokens;
}

export function generateOrderingTask(input: StructuredTargetInput): OrderingPayload {
  const correctTokens = splitClaimIntoTokens(input.claim);
  // 泄题防护（§12.1）：token id 用内容哈希派生，不编码原文位置；shuffle 后
  // 无法从 id 还原正确顺序。
  const tokenIds = correctTokens.map((token) => `tok:${sha256Hex(token).slice(0, 10)}`);
  // 确定性乱序：按 token id 哈希升序（稳定、可重放）。
  const shuffled = [...tokenIds].sort((a, b) =>
    sha256Hex(a).localeCompare(sha256Hex(b)));
  const labels: Record<string, string> = {};
  correctTokens.forEach((token, index) => {
    labels[tokenIds[index]] = token;
  });
  const rubricTargetId = `rubric:ordering:${sha256Hex(correctTokens.join("|")).slice(0, 12)}`;
  return {
    interaction: { kind: "ordering", publicTokenIds: shuffled },
    publicTokenLabels: labels,
    solution: {
      kind: "ordering",
      correctTokenIds: tokenIds,
      rubricTargetIds: [rubricTargetId],
    },
  };
}

// ─── relation ────────────────────────────────────────────────────────────

export interface RelationPayload {
  interaction: {
    kind: "relation_canvas";
    publicNodeIds: string[];
    allowedEdgeKinds: RelationEdgeKindV1[];
  };
  publicNodeLabels: Record<string, string>;
  solution: {
    kind: "relation";
    requiredEdges: Array<{ fromNodeId: string; toNodeId: string; edgeKind: RelationEdgeKindV1 }>;
    forbiddenEdges: Array<{ fromNodeId: string; toNodeId: string; edgeKind: RelationEdgeKindV1 }>;
    rubricTargetIds: string[];
  };
}

export function generateRelationTask(input: StructuredTargetInput): RelationPayload {
  const claimNodeId = "node:claim";
  const quoteNodeId = "node:quote";
  const allowedEdgeKinds: RelationEdgeKindV1[] = ["supports", "causes", "part_of", "contrasts_with", "precedes", "depends_on"];
  // 确定性正确边：quote 支撑 claim（evidence 语义）。
  const requiredEdges = [{ fromNodeId: quoteNodeId, toNodeId: claimNodeId, edgeKind: "supports" as const }];
  const rubricTargetId = `rubric:relation:${sha256Hex(`${input.claim}|${input.quote}`).slice(0, 12)}`;
  return {
    interaction: {
      kind: "relation_canvas",
      publicNodeIds: [claimNodeId, quoteNodeId],
      allowedEdgeKinds,
    },
    publicNodeLabels: {
      [claimNodeId]: input.claim.slice(0, 60),
      [quoteNodeId]: input.quote.slice(0, 60),
    },
    solution: {
      kind: "relation",
      requiredEdges,
      forbiddenEdges: [],
      rubricTargetIds: [rubricTargetId],
    },
  };
}

// ─── repair ──────────────────────────────────────────────────────────────

export interface RepairPayload {
  interaction: {
    kind: "repair";
    publicElementIds: string[];
    allowedOperationKinds: Array<"move" | "replace" | "remove" | "insert">;
    replacementOptionIds: string[];
  };
  publicElementLabels: Record<string, string>;
  replacementOptionLabels: Record<string, string>;
  solution: {
    kind: "repair";
    acceptedOperationSignatures: string[];
    rubricTargetIds: string[];
  };
}

/** 抽取 claim 中最长词（可替换词）与干扰词。 */
function extractWords(text: string): string[] {
  const words = text.split(/[\s，。；：！？、,.!?;:]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
  return [...new Set(words)];
}

export function generateRepairTask(input: StructuredTargetInput): RepairPayload {
  const words = extractWords(input.claim);
  if (words.length < 2) {
    // 词不足：fallback 用整句一半作为"元素"。
    return generateRepairFallback(input);
  }
  const sortedByLength = [...words].sort((a, b) => b.length - a.length);
  const targetWord = sortedByLength[0];
  const others = sortedByLength.filter((w) => w !== targetWord);
  const distractors = others.slice(0, 2);
  const elementId = "el:blank";
  const correctOptionId = `opt:${sha256Hex(targetWord).slice(0, 10)}`;
  const distractorOptionIds = distractors.map((w) => `opt:${sha256Hex(w).slice(0, 10)}`);
  // 泄题防护（§12.1）：选项 id 用内容哈希派生 + 确定性乱序（正确项不恒排第一）。
  const replacementOptionIds = [correctOptionId, ...distractorOptionIds]
    .sort((a, b) => sha256Hex(a).localeCompare(sha256Hex(b)));
  const labels: Record<string, string> = {
    [elementId]: input.claim.replace(targetWord, "________"),
  };
  const optionLabels: Record<string, string> = {
    [correctOptionId]: targetWord,
  };
  distractorOptionIds.forEach((id, index) => {
    optionLabels[id] = distractors[index];
  });
  const rubricTargetId = `rubric:repair:${sha256Hex(targetWord).slice(0, 12)}`;
  return {
    interaction: {
      kind: "repair",
      publicElementIds: [elementId],
      allowedOperationKinds: ["replace"],
      replacementOptionIds,
    },
    publicElementLabels: labels,
    replacementOptionLabels: optionLabels,
    solution: {
      kind: "repair",
      acceptedOperationSignatures: [`replace:${elementId}:${correctOptionId}`],
      rubricTargetIds: [rubricTargetId],
    },
  };
}

function generateRepairFallback(input: StructuredTargetInput): RepairPayload {
  const elementId = "el:blank";
  const correctOptionId = `opt:${sha256Hex(input.claim).slice(0, 10)}`;
  // 中性干扰项（fallback 场景 claim 无法提取干扰词；保持选项 ≥2）。
  const neutralOptionId = "opt:neutral";
  const replacementOptionIds = [correctOptionId, neutralOptionId]
    .sort((a, b) => sha256Hex(a).localeCompare(sha256Hex(b)));
  const label = input.claim.slice(0, 12) + "…";
  const rubricTargetId = `rubric:repair:${sha256Hex(input.claim).slice(0, 12)}`;
  return {
    interaction: {
      kind: "repair",
      publicElementIds: [elementId],
      allowedOperationKinds: ["replace"],
      replacementOptionIds,
    },
    publicElementLabels: { [elementId]: input.claim },
    replacementOptionLabels: {
      [correctOptionId]: label,
      [neutralOptionId]: "无法确定",
    },
    solution: {
      kind: "repair",
      acceptedOperationSignatures: [`replace:${elementId}:${correctOptionId}`],
      rubricTargetIds: [rubricTargetId],
    },
  };
}

// ─── 组合生成器 ──────────────────────────────────────────────────────────

export type StructuredTaskPayload = OrderingPayload | RelationPayload | RepairPayload;

export type StructuredTaskKind = "ordering" | "relation" | "repair";

export function generateStructuredTask(
  kind: StructuredTaskKind,
  input: StructuredTargetInput,
): StructuredTaskPayload {
  switch (kind) {
    case "ordering": return generateOrderingTask(input);
    case "relation": return generateRelationTask(input);
    case "repair": return generateRepairTask(input);
  }
}

/** 确定性评估：private solution 对比（covered/partial/missing）。 */
export function assessStructuredPayload(
  kind: StructuredTaskKind,
  payload: Record<string, unknown>,
  solution: Record<string, unknown>,
): { verdict: "covered" | "partial" | "missing" | "not_assessable"; userFacingReason: string } {
  if (kind === "ordering") {
    const ordered = (payload.orderedTokenIds ?? []) as string[];
    const correct = (solution.correctTokenIds ?? []) as string[];
    if (!Array.isArray(ordered) || ordered.length === 0) {
      return { verdict: "not_assessable", userFacingReason: "没有提交排序结果" };
    }
    if (ordered.length === correct.length && ordered.every((id, index) => id === correct[index])) {
      return { verdict: "covered", userFacingReason: "顺序完全正确" };
    }
    // 位置正确计数（集合命中不说明位置；提交侧 allowlist 已保证无重复/同长度）。
    const matched = ordered.reduce((count, id, index) => count + (id === correct[index] ? 1 : 0), 0);
    return {
      verdict: matched >= Math.ceil(correct.length / 2) ? "partial" : "missing",
      userFacingReason: `${matched}/${correct.length} 个位置正确`,
    };
  }
  if (kind === "relation") {
    const edges = (payload.edges ?? []) as Array<{ fromNodeId: string; toNodeId: string; edgeKind: string }>;
    const required = (solution.requiredEdges ?? []) as Array<{ fromNodeId: string; toNodeId: string; edgeKind: string }>;
    if (!Array.isArray(edges) || edges.length === 0) {
      return { verdict: "not_assessable", userFacingReason: "没有提交关系" };
    }
    const matched = required.filter((r) =>
      edges.some((e) => e.fromNodeId === r.fromNodeId && e.toNodeId === r.toNodeId && e.edgeKind === r.edgeKind),
    ).length;
    if (matched === required.length && required.length > 0) {
      return { verdict: "covered", userFacingReason: "关系判断正确" };
    }
    return { verdict: matched > 0 ? "partial" : "missing", userFacingReason: `${matched}/${required.length} 条关系正确` };
  }
  if (kind === "repair") {
    const operations = (payload.operations ?? []) as Array<{ op: string; elementId: string; replacementOptionId?: string }>;
    const accepted = (solution.acceptedOperationSignatures ?? []) as string[];
    if (!Array.isArray(operations) || operations.length === 0) {
      return { verdict: "not_assessable", userFacingReason: "没有提交修复操作" };
    }
    const signatures = operations.map((op) => `${op.op}:${op.elementId}:${op.replacementOptionId ?? ""}`);
    const matched = signatures.filter((sig) => accepted.includes(sig)).length;
    if (matched === accepted.length && accepted.length > 0) {
      return { verdict: "covered", userFacingReason: "修复正确" };
    }
    return { verdict: matched > 0 ? "partial" : "missing", userFacingReason: `${matched}/${accepted.length} 个操作正确` };
  }
  return { verdict: "not_assessable", userFacingReason: "未知题型" };
}

// ─── V2：从 CanonicalAnswerV2 显式结构生成结构题（§16.5）─────────────────

/**
 * §16.5：禁止继续用标点/固定字符数/claim 切片生成排序/关系题。结构题只能
 * 来自 CanonicalAnswerV2 的显式结构（ordered_steps/mapping/comparison）与
 * ObjectiveRelationV2 的稳定 unitId。distractor 只取自证据支持的实体/经
 * 确定性校验；判断不足则不生成结构题（返回 null，Planner 换其他 interaction）。
 */

/** §16.5 ordered_steps → ordering：steps 本体即正确答案序列。 */
export function generateOrderingFromAnswerSteps(
  steps: Array<{ unitId: string; text: string }>,
): OrderingPayload | null {
  if (steps.length < 2) return null;
  const tokenIds = steps.map((s) => `unit:${sha256Hex(s.unitId).slice(0, 12)}`);
  // 泄漏防护：publicTokenIds 用哈希派生，不编码原文位置。
  const shuffled = [...tokenIds].sort((a, b) => sha256Hex(a).localeCompare(sha256Hex(b)));
  const labels: Record<string, string> = {};
  steps.forEach((s, index) => {
    labels[tokenIds[index]] = s.text;
  });
  const rubricTargetId = `rubric:ordering:${sha256Hex(steps.map((s) => s.unitId).join("|")).slice(0, 12)}`;
  return {
    interaction: { kind: "ordering", publicTokenIds: shuffled },
    publicTokenLabels: labels,
    solution: {
      kind: "ordering",
      correctTokenIds: tokenIds,
      rubricTargetIds: [rubricTargetId],
    },
  };
}

/** §16.5 mapping → ordering：按 right 侧稳定排序，把 left 提示做成可排序 token。 */
export function generateOrderingFromAnswerMapping(
  pairs: Array<{ unitId: string; left: string; right: string }>,
): OrderingPayload | null {
  if (pairs.length < 2) return null;
  const byLeft = [...pairs].sort((a, b) => a.unitId.localeCompare(b.unitId));
  const tokenIds = byLeft.map((p) => `map:${sha256Hex(p.unitId).slice(0, 12)}`);
  const shuffled = [...tokenIds].sort((a, b) => sha256Hex(a).localeCompare(sha256Hex(b)));
  const labels: Record<string, string> = {};
  byLeft.forEach((p, index) => {
    labels[tokenIds[index]] = p.left;
  });
  const rubricTargetId = `rubric:ordering:${sha256Hex(byLeft.map((p) => p.unitId).join("|")).slice(0, 12)}`;
  return {
    interaction: { kind: "ordering", publicTokenIds: shuffled },
    publicTokenLabels: labels,
    solution: {
      kind: "ordering",
      correctTokenIds: tokenIds,
      rubricTargetIds: [rubricTargetId],
    },
  };
}

/** §16.5 comparison → relation_canvas：行维度为节点，"contrasts_with" 表达对比。 */
export function generateRelationFromAnswerComparison(
  comparison: { columns: string[]; rows: Array<{ unitId: string; dimension: string; values: string[] }> },
): RelationPayload | null {
  if (comparison.columns.length < 2 || comparison.rows.length < 2) return null;
  const nodeIds = comparison.rows.map((r) => `dim:${sha256Hex(r.unitId).slice(0, 12)}`);
  const labels: Record<string, string> = {};
  comparison.rows.forEach((r, index) => {
    labels[nodeIds[index]] = r.dimension;
  });
  const requiredEdges = [{
    fromNodeId: nodeIds[0],
    toNodeId: nodeIds[1],
    edgeKind: "contrasts_with" as const,
  }];
  const rubricTargetId = `rubric:relation:${sha256Hex(comparison.rows.map((r) => r.unitId).join("|")).slice(0, 12)}`;
  return {
    interaction: {
      kind: "relation_canvas",
      publicNodeIds: nodeIds,
      allowedEdgeKinds: ["supports", "contrasts_with", "causes", "depends_on"],
    },
    publicNodeLabels: labels,
    solution: {
      kind: "relation",
      requiredEdges,
      forbiddenEdges: [],
      rubricTargetIds: [rubricTargetId],
    },
  };
}

/**
 * §16.5 relation（rubric relations/evidence 实体关系）→ relation_canvas：
 * 只使用 ObjectiveRelationV2 中稳定 unitId 声明的关系，不伪造。
 */
export function generateRelationFromObjectiveRelations(
  relations: ObjectiveRelationV2[],
  maxNodes = 8,
): RelationPayload | null {
  const nodes = new Set<string>();
  const edges: Array<{ fromNodeId: string; toNodeId: string; edgeKind: RelationEdgeKindV1 }> = [];
  const relationKindToEdge: Record<ObjectiveRelationV2["kind"], RelationEdgeKindV1> = {
    before: "precedes",
    depends_on: "depends_on",
    causes: "causes",
    contrasts_with: "contrasts_with",
  };
  for (const rel of relations) {
    if (nodes.size >= maxNodes) break;
    const from = `unit:${sha256Hex(rel.fromAnswerUnitId).slice(0, 12)}`;
    const to = `unit:${sha256Hex(rel.toAnswerUnitId).slice(0, 12)}`;
    nodes.add(from);
    nodes.add(to);
    edges.push({ fromNodeId: from, toNodeId: to, edgeKind: relationKindToEdge[rel.kind] });
  }
  if (nodes.size < 2 || edges.length === 0) return null;
  const rubricTargetId = `rubric:relation:${sha256Hex(relations.map((r) => r.relationId).join("|")).slice(0, 12)}`;
  return {
    interaction: {
      kind: "relation_canvas",
      publicNodeIds: [...nodes],
      allowedEdgeKinds: ["supports", "contrasts_with", "causes", "precedes", "depends_on"],
    },
    publicNodeLabels: {},
    solution: {
      kind: "relation",
      requiredEdges: edges,
      forbiddenEdges: [],
      rubricTargetIds: [rubricTargetId],
    },
  };
}

/**
 * §16.5 从 CanonicalAnswerV2 显式结构生成结构题；判断不足返回 null
 * （Planner 换 interaction，绝不为 UI 丰富度伪造片段/关系）。
 */
export function generateStructuredFromSnapshot(
  canonicalAnswer: CanonicalAnswerV2,
  relations: ObjectiveRelationV2[],
): Extract<StructuredTaskPayload, { interaction: { kind: "ordering" } }> | Extract<StructuredTaskPayload, { interaction: { kind: "relation_canvas" } }> | null {
  switch (canonicalAnswer.kind) {
    case "ordered_steps":
      return generateOrderingFromAnswerSteps(canonicalAnswer.steps);
    case "mapping":
      return generateOrderingFromAnswerMapping(canonicalAnswer.pairs);
    case "comparison":
      return generateRelationFromAnswerComparison(canonicalAnswer);
    case "text":
    case "bullets":
    case "formula":
    case "code":
      // 无足够显式结构 → 尝试 relation（rubric/evidence 实体关系）。
      return generateRelationFromObjectiveRelations(relations);
  }
}

// ─── structured_bundle（§5.3/§7.3/§12.6，V1 practice 首发）───────────────

export interface StructuredBundlePart {
  partId: string;
  interaction:
    | { kind: "ordering"; publicTokenIds: string[] }
    | { kind: "relation_canvas"; publicNodeIds: string[]; allowedEdgeKinds: RelationEdgeKindV1[] }
    | { kind: "repair"; publicElementIds: string[]; allowedOperationKinds: Array<"move" | "replace" | "remove" | "insert">; replacementOptionIds: string[] };
  partTrustCeiling: "practice_only";
  qualificationProfileHash: null;
}

export interface StructuredBundlePayload {
  interaction: { kind: "structured_bundle"; parts: [StructuredBundlePart, StructuredBundlePart] };
  /** partId → label 映射（renderer 展示用；不含答案）。 */
  labels: Record<string, Record<string, string>>;
  solution: {
    kind: "structured_bundle";
    partSolutionRefs: [string, string];
    /** V1 内嵌单 part solution（评估 worker 需要；refs 供未来独立 solution 存储）。 */
    partSolutions: [Record<string, unknown>, Record<string, unknown>];
    bundleQualificationId: string;
    rubricTargetIds: string[];
  };
}

/** bundle 生成：ordering（步骤顺序）+ relation（引用支撑）双 part，同一 claim。 */
export function generateStructuredBundleTask(input: StructuredTargetInput): StructuredBundlePayload {
  const ordering = generateOrderingTask(input);
  const relation = generateRelationTask(input);
  const partA: StructuredBundlePart = {
    partId: "part:1",
    interaction: { kind: "ordering", publicTokenIds: ordering.interaction.publicTokenIds },
    partTrustCeiling: "practice_only",
    qualificationProfileHash: null,
  };
  const partB: StructuredBundlePart = {
    partId: "part:2",
    interaction: {
      kind: "relation_canvas",
      publicNodeIds: relation.interaction.publicNodeIds,
      allowedEdgeKinds: relation.interaction.allowedEdgeKinds,
    },
    partTrustCeiling: "practice_only",
    qualificationProfileHash: null,
  };
  return {
    interaction: { kind: "structured_bundle", parts: [partA, partB] },
    labels: {
      [partA.partId]: ordering.publicTokenLabels,
      [partB.partId]: relation.publicNodeLabels,
    },
    solution: {
      kind: "structured_bundle",
      partSolutionRefs: [
        sha256Hex(`part:solution:1:${JSON.stringify(ordering.solution)}`).slice(0, 24),
        sha256Hex(`part:solution:2:${JSON.stringify(relation.solution)}`).slice(0, 24),
      ],
      partSolutions: [ordering.solution as unknown as Record<string, unknown>, relation.solution as unknown as Record<string, unknown>],
      // V1 无批准 qualification：bundleQualificationId 为空（§12.6：缺批准
      // 的 bundle 绝不能绕过 §7.7 上限——ceiling 恒 practice_only）。
      bundleQualificationId: "",
      rubricTargetIds: [...ordering.solution.rubricTargetIds, ...relation.solution.rubricTargetIds],
    },
  };
}

/** bundle 确定性评估：逐 part verdict，取最低（covered > partial > missing）。 */
export function assessStructuredBundlePayload(
  payload: Record<string, unknown>,
  solution: Record<string, unknown>,
): { verdict: "covered" | "partial" | "missing" | "not_assessable"; userFacingReason: string } {
  const partAnswers = (payload.partAnswers ?? []) as Array<{ kind?: string; partId?: string }>;
  const partSolutions = (solution.partSolutions ?? []) as Record<string, unknown>[];
  if (!Array.isArray(partAnswers) || partAnswers.length === 0) {
    return { verdict: "not_assessable", userFacingReason: "没有提交任何部分" };
  }
  const verdicts: string[] = [];
  const details: string[] = [];
  for (let index = 0; index < partAnswers.length; index += 1) {
    const answer = partAnswers[index] as Record<string, unknown>;
    const partSolution = partSolutions[index] ?? {};
    const kind = answer.kind;
    if (kind !== "ordering" && kind !== "relation" && kind !== "repair") {
      return { verdict: "not_assessable", userFacingReason: "部分作答类型无法识别" };
    }
    const single = assessStructuredPayload(kind as "ordering" | "relation" | "repair", answer, partSolution);
    verdicts.push(single.verdict);
    details.push(`${index + 1}:${single.verdict}`);
  }
  if (verdicts.includes("not_assessable")) {
    return { verdict: "not_assessable", userFacingReason: `部分作答不可评估（${details.join("，")}）` };
  }
  if (verdicts.every((v) => v === "covered")) {
    return { verdict: "covered", userFacingReason: `两部分都正确（${details.join("，")}）` };
  }
  if (verdicts.every((v) => v === "missing")) {
    return { verdict: "missing", userFacingReason: `两部分都未答对（${details.join("，")}）` };
  }
  return { verdict: "partial", userFacingReason: `部分答对（${details.join("，")}）` };
}
