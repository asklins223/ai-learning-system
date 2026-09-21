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
  const publicNodeLabels: Record<string, string> = {};
  const claimLabel = input.claim.trim().slice(0, 60);
  const quoteLabel = input.quote.trim().slice(0, 60);
  if (claimLabel) publicNodeLabels[claimNodeId] = claimLabel;
  if (quoteLabel) publicNodeLabels[quoteNodeId] = quoteLabel;
  return {
    interaction: {
      kind: "relation_canvas",
      publicNodeIds: [claimNodeId, quoteNodeId],
      allowedEdgeKinds,
    },
    publicNodeLabels,
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

// ─── 客观题：single_choice / true_false（练习与诊断通道）──────────────────

/**
 * 2026-09-21 客观题方案 §3：选择题/判断题的**素材来自作者产出的练习件**
 * （`objectiveDraft.practiceItem`，见 docs/plans/objective-card-items-2026-09-21.md），
 * 不从标点或定长切片里造 —— 那是 §16.5 明令禁止的老路。
 *
 * 泄题防护沿用 ordering 的姿态：option id 由**选项文本**的哈希派生，
 * public 序列按 id 升序，因此与作者书写顺序无关（正确项写在第一位也漏不出去），
 * 而 correctOptionId / expected 只存在于私有 solution。
 */
export interface ChoiceTaskInput {
  options: Array<{ unitId?: string; text: string }>;
  correctUnitId: string;
  /** 判分目标 id；缺省时按选项内容派生（与 ordering 同规则）。 */
  rubricTargetId?: string;
}

export interface ChoicePayload {
  interaction: { kind: "single_choice"; publicOptionIds: string[] };
  /** option id → 文本（public：renderer 展示用，不含对错）。 */
  publicOptionLabels: Record<string, string>;
  solution: { kind: "choice"; correctOptionId: string; rubricTargetIds: string[] };
}

export interface TrueFalseTaskInput {
  proposition: string;
  expected: boolean;
  rubricTargetId?: string;
}

export interface TrueFalsePayload {
  interaction: { kind: "true_false"; proposition: string };
  solution: { kind: "true_false"; expected: boolean; rubricTargetIds: string[] };
}

function choiceOptionId(text: string): string {
  return `opt:${sha256Hex(text.trim()).slice(0, 10)}`;
}

/**
 * 选择题构造。返回 null 而不是硬造一道题的情形：正确项在选项里找不到、
 * 去重后不足两项（两项以下没有"选择"可言，且二选一时猜对率 50%，
 * 判分没有信息量）。
 */
export function generateChoiceTask(input: ChoiceTaskInput): ChoicePayload | null {
  const byText = new Map<string, string>();
  for (const option of input.options) {
    const text = option.text.trim();
    if (!text) continue;
    if (!byText.has(text)) byText.set(text, option.unitId ?? text);
  }
  const correctText = input.options
    .find((option) => (option.unitId ?? option.text.trim()) === input.correctUnitId)
    ?.text.trim();
  if (!correctText || !byText.has(correctText)) return null;
  const texts = [...byText.keys()];
  if (texts.length < 2) return null;

  const ids = texts.map(choiceOptionId);
  const labels: Record<string, string> = {};
  texts.forEach((text, index) => { labels[ids[index]] = text; });
  const publicOptionIds = [...ids].sort();
  const correctOptionId = choiceOptionId(correctText);
  return {
    interaction: { kind: "single_choice", publicOptionIds },
    publicOptionLabels: labels,
    solution: {
      kind: "choice",
      correctOptionId,
      rubricTargetIds: [
        input.rubricTargetId
          ?? `rubric:choice:${sha256Hex(texts.join("|")).slice(0, 12)}`,
      ],
    },
  };
}

export function generateTrueFalseTask(input: TrueFalseTaskInput): TrueFalsePayload {
  const proposition = input.proposition.trim();
  return {
    interaction: { kind: "true_false", proposition },
    solution: {
      kind: "true_false",
      expected: input.expected,
      rubricTargetIds: [
        input.rubricTargetId ?? `rubric:true_false:${sha256Hex(proposition).slice(0, 12)}`,
      ],
    },
  };
}

export interface MatchingTaskInput {
  pairs: Array<{
    leftId: string;
    leftText: string;
    rightId: string;
    rightText: string;
  }>;
  rubricTargetId?: string;
}

export interface MatchingPayload {
  interaction: {
    kind: "matching";
    publicLeftIds: string[];
    publicRightIds: string[];
    publicLabels: Record<string, string>;
  };
  solution: {
    kind: "matching";
    correctPairs: Array<{ leftId: string; rightId: string }>;
    rubricTargetIds: string[];
  };
}

/**
 * 配对题构造。两列的 id 都由**该端文本**哈希派生，因此列内顺序与配对关系无关
 * （作者按 pairs 顺序写、正确项总在第 0 列位，也不会把答案排成"第 i 个对第 i 个"）。
 * 去重后两侧数量不等或不足两项 → null（不硬造）。
 */
export function generateMatchingTask(input: MatchingTaskInput): MatchingPayload | null {
  const lefts = new Map<string, string>();
  const rights = new Map<string, string>();
  const pairs: Array<{ leftId: string; rightId: string }> = [];
  for (const pair of input.pairs) {
    const leftText = pair.leftText.trim();
    const rightText = pair.rightText.trim();
    if (!leftText || !rightText) continue;
    const leftId = choiceOptionId(leftText);
    const rightId = choiceOptionId(rightText);
    if (lefts.has(leftId) || rights.has(rightId)) continue;
    lefts.set(leftId, leftText);
    rights.set(rightId, rightText);
    pairs.push({ leftId, rightId });
  }
  if (pairs.length < 2) return null;
  const labels: Record<string, string> = { ...Object.fromEntries(lefts), ...Object.fromEntries(rights) };
  return {
    interaction: {
      kind: "matching",
      publicLeftIds: [...lefts.keys()].sort(),
      publicRightIds: [...rights.keys()].sort(),
      publicLabels: labels,
    },
    solution: {
      kind: "matching",
      correctPairs: pairs,
      rubricTargetIds: [
        input.rubricTargetId
          ?? `rubric:matching:${sha256Hex(pairs.map((p) => `${p.leftId}>${p.rightId}`).join("|")).slice(0, 12)}`,
      ],
    },
  };
}

/**
 * 排序题（作者产出的单元序列 → ordering）。与 generateOrderingTask 的区别：
 * 那个从 claim 文本切片（§16.5 已禁止用于 V2 结构题），这里直接吃作者写好的
 * 单元文本与正确顺序，id 仍由内容哈希派生，所以 public 顺序不泄露答案位置。
 */
export function generateOrderingFromUnits(
  units: Array<{ unitId?: string; text: string }>,
  correctUnitOrder: string[],
): OrderingPayload | null {
  const byId = new Map<string, string>();
  for (const unit of units) {
    const text = unit.text.trim();
    if (!text) continue;
    const id = choiceOptionId(text);
    if (!byId.has(id)) byId.set(id, text);
  }
  const correctIds = correctUnitOrder
    .map((unitId) => units.find((unit) => (unit.unitId ?? unit.text.trim()) === unitId)?.text.trim())
    .filter((text): text is string => Boolean(text))
    .map(choiceOptionId);
  if (correctIds.length < 2 || byId.size !== correctIds.length) return null;
  if (new Set(correctIds).size !== correctIds.length) return null;
  const labels: Record<string, string> = Object.fromEntries(byId);
  return {
    interaction: { kind: "ordering", publicTokenIds: [...byId.keys()].sort() },
    publicTokenLabels: labels,
    solution: {
      kind: "ordering",
      correctTokenIds: correctIds,
      rubricTargetIds: [`rubric:ordering:${sha256Hex(correctIds.join("|")).slice(0, 12)}`],
    },
  };
}

// ─── 组合生成器 ──────────────────────────────────────────────────────────

export type StructuredTaskPayload =
  | OrderingPayload | RelationPayload | RepairPayload | ChoicePayload | TrueFalsePayload | MatchingPayload;

export type StructuredTaskKind =
  "ordering" | "relation" | "repair" | "choice" | "true_false" | "matching";

/**
 * 哪些提交载荷走确定性判分（`deterministic_structured`）。
 *
 * 这张表同时是路由的唯一真相：再加一种交互时漏了这里，作答就会被丢给
 * assessment_critic —— 花钱、且把"点了一个选项"当成一段自由文本去判
 * （2026-09-21 第一版就踩到了：新种类没进路由表）。
 */
const DETERMINISTIC_PAYLOAD_KINDS = new Set([
  "ordering", "relation", "repair", "structured_bundle", "choice", "true_false", "matching",
]);

export function isDeterministicStructuredPayload(payloadKind: string): boolean {
  return DETERMINISTIC_PAYLOAD_KINDS.has(payloadKind);
}

export function generateStructuredTask(
  kind: StructuredTaskKind,
  input: StructuredTargetInput,
): StructuredTaskPayload {
  switch (kind) {
    case "ordering": return generateOrderingTask(input);
    case "relation": return generateRelationTask(input);
    case "repair": return generateRepairTask(input);
    // 客观题需要作者产出的选项/命题素材，不能只凭 claim+quote 造：
    // 走到这里说明调用方拿错了入口，应当用 generateChoiceTask/generateTrueFalseTask。
    case "choice":
    case "true_false":
    case "matching":
      throw new Error(`${kind} 需要练习件素材，请走对应的 generate*Task`);
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
    const edgeKey = (e: { fromNodeId: string; toNodeId: string; edgeKind: string }) =>
      `${e.fromNodeId}|${e.toNodeId}|${e.edgeKind}`;
    const requiredKeys = new Set(required.map(edgeKey));
    const submittedKeys = new Set(edges.map(edgeKey));
    const matched = [...requiredKeys].filter((key) => submittedKeys.has(key)).length;
    // M9（2026-08-24 审查）：反穷举。此前只统计 required 命中、不罚多余边，
    // 而本题只有 2 个节点 × 6 种 edge kind = 12 种组合（提交上限 16 条），
    // 全量提交必然 covered。covered 要求提交集合恰好等于 required（与 ordering
    // 的等长要求同姿态）：多余边、重复边一律不算正确。
    const invalid = edges.filter((e) => !requiredKeys.has(edgeKey(e))).length;
    const duplicated = edges.length - submittedKeys.size;
    const exact = requiredKeys.size > 0
      && matched === requiredKeys.size
      && invalid === 0
      && duplicated === 0
      && edges.length === requiredKeys.size;
    if (exact) {
      return { verdict: "covered", userFacingReason: "关系判断正确" };
    }
    const noise = invalid + duplicated;
    return {
      verdict: matched > 0 ? "partial" : "missing",
      userFacingReason: noise > 0
        ? `${matched}/${requiredKeys.size} 条关系正确，另有 ${noise} 条多余或重复`
        : `${matched}/${requiredKeys.size} 条关系正确`,
    };
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
  if (kind === "choice") {
    const selected = payload.selectedOptionId as string | undefined;
    const correct = solution.correctOptionId as string | undefined;
    if (!selected) {
      return { verdict: "not_assessable", userFacingReason: "没有提交选择" };
    }
    if (!correct) {
      return { verdict: "not_assessable", userFacingReason: "这道题没有可比对的正确项" };
    }
    // 理由串会原样送到客户端：它一旦提到正确选项的文本，就等于绕开
    // 「答案只在你主动查看时才下发并记账」那条曝光规则，所以只报结果。
    return selected === correct
      ? { verdict: "covered", userFacingReason: "选择正确" }
      : { verdict: "missing", userFacingReason: "这个选择不对" };
  }
  if (kind === "true_false") {
    const answer = payload.answer;
    const expected = solution.expected;
    if (typeof answer !== "boolean" || typeof expected !== "boolean") {
      return { verdict: "not_assessable", userFacingReason: "没有提交判断" };
    }
    return answer === expected
      ? { verdict: "covered", userFacingReason: "判断正确" }
      : { verdict: "missing", userFacingReason: "这个判断不对" };
  }
  if (kind === "matching") {
    const assignments = (payload.assignments ?? []) as Array<{ leftId: string; rightId: string }>;
    const correct = (solution.correctPairs ?? []) as Array<{ leftId: string; rightId: string }>;
    if (!Array.isArray(assignments) || assignments.length === 0) {
      return { verdict: "not_assessable", userFacingReason: "没有提交配对" };
    }
    const key = (pair: { leftId: string; rightId: string }) => `${pair.leftId}|${pair.rightId}`;
    const correctKeys = new Set(correct.map(key));
    const submittedKeys = new Set(assignments.map(key));
    const matched = [...correctKeys].filter((k) => submittedKeys.has(k)).length;
    // 与 relation 同一姿态的反穷举：一个左端只能配一个右端，多交/重复交的边
    // 不涨分，且 covered 要求提交集合恰好等于正确集合。
    const noise = assignments.length - submittedKeys.size
      + [...submittedKeys].filter((k) => !correctKeys.has(k)).length;
    const lefts = new Set(assignments.map((a) => a.leftId));
    if (lefts.size !== assignments.length) {
      return { verdict: "partial", userFacingReason: "有左端配了多条，只算一次" };
    }
    if (matched === correctKeys.size && noise === 0 && assignments.length === correctKeys.size) {
      return { verdict: "covered", userFacingReason: `全部 ${correctKeys.size} 对都配对了` };
    }
    return {
      verdict: matched > 0 ? "partial" : "missing",
      userFacingReason: `${matched}/${correctKeys.size} 对正确`,
    };
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
