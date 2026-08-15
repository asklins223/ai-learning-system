/**
 * 方案 20 C2：Learnability Planner（§8）。
 *
 * 职责（§8.1–8.4）：
 * - Source Normalizer / Knowledge Atom 决策；
 * - note-adaptive `no_cards | card_plan`；
 * - marginal learning value、existing Objective dedup；
 * - micro 与 complex bounded pipeline；
 * - 删除模型自报预算和数量下限。
 *
 * 硬约束（§8.5 / §10.5）：
 * - `recommendedCardCount >= 0`；
 * - `activationHardMax <= request hard cap` 且 ≤ 服务端 policy cap；
 * - `no_cards_recommended` 是成功结果；
 * - Planner 允许 0 卡且不调用 Author；
 * - model 无权扩大 server hard max；
 * - Planner 与 Author 不能合并成一次可自行扩预算的调用。
 *
 * 本模块是纯逻辑模块（不直接调用模型），由 worker V2 handler 驱动。
 * 模型调用由调用方注入 provider，本模块负责：
 * 1. 从 sealed source 提取 Knowledge Atoms；
 * 2. 评估每个 Atom 的 learnability / importance / confidence；
 * 3. 合并/去重与 existing Objective 比对；
 * 4. 输出 CardPlanV2（含 no_cards 或 author_candidates）。
 */

import { randomUUID } from "node:crypto";
import type {
  CardPlanV2,
  AtomDecisionV2,
  PlannedObjectiveV2,
  PlannedExistingLifecycleActionV2,
  NoCardReasonCodeV2,
  GenerationSemanticSpecV2,
  GenerationInputSnapshotV2,
  KnowledgeFormV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import {
  computeCardPlanHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";

// ─── 服务端 Policy Cap ───────────────────────────────────────────────────

/** §8.5: 服务端 hard cap，任何 Planner 输出不得超过此值。 */
export const SERVER_POLICY_MAX_CARDS = 20;

/** §10.2: micro-note 判定阈值 */
export const MICRO_NOTE_CHAR_THRESHOLD = 500;
export const MICRO_NOTE_BLOCK_THRESHOLD = 3;

// ─── Knowledge Atom 提取 ─────────────────────────────────────────────────

/**
 * §8.2: Source Normalizer 输出 — 从 NoteVersion blocks 提取的 Knowledge Atom。
 *
 * 在实际实现中，此步骤由确定性 normalizer + 模型 extraction 完成。
 * 本函数是纯逻辑的 deterministic pre-extraction，
 * 模型 enhancement 由调用方在 extractWithModel 中注入。
 */
export interface SourceBlockInput {
  blockId: string;
  type: string;
  content: string;
  ordinal: number;
}

export interface ExtractedKnowledgeAtom {
  atomId: string;
  proposition: string;
  evidenceRefIds: string[];
  sourceSectionKeys: string[];
  importanceBps: number;
  learnabilityBps: number;
  confidenceBps: number;
  /** 模型或确定性提取的 knowledge form hint */
  knowledgeFormHint: KnowledgeFormV2;
}

/**
 * 确定性 Atom 提取：将 blocks 按段落/句子分割为候选 atoms。
 * 不调用模型——纯规则。
 */
export function extractAtomsDeterministic(blocks: SourceBlockInput[]): ExtractedKnowledgeAtom[] {
  const atoms: ExtractedKnowledgeAtom[] = [];
  for (const block of blocks) {
    const sentences = splitIntoSentences(block.content);
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i].trim();
      if (sentence.length < 10) continue;
      if (isOperationalOrTemporary(sentence)) continue;

      atoms.push({
        atomId: `atom-${block.blockId}-${i}`,
        proposition: sentence,
        evidenceRefIds: [],
        sourceSectionKeys: [block.blockId],
        importanceBps: estimateImportance(sentence),
        learnabilityBps: estimateLearnability(sentence),
        confidenceBps: 9_000, // 确定性提取 confidence 偏低
        knowledgeFormHint: inferKnowledgeForm(sentence),
      });
    }
  }
  return atoms;
}

/**
 * 模型增强 Atom 提取接口。
 * 调用方注入 provider 调用，本模块不直接实现。
 */
export interface AtomExtractionProvider {
  extractAtoms(
    blocks: SourceBlockInput[],
    semanticSpec: GenerationSemanticSpecV2,
  ): Promise<ExtractedKnowledgeAtom[]>;
}

// ─── Planner 核心逻辑 ────────────────────────────────────────────────────

export interface PlannerInput {
  runId: string;
  workspaceId: string;
  inputSnapshot: GenerationInputSnapshotV2;
  semanticSpec: GenerationSemanticSpecV2;
  blocks: SourceBlockInput[];
  /**
   * §14.2（R36）：sourceScope 内被 seal 剔除的非文本模态 block
   *（image/code/diagram/formula/table）。region evidence 未实现时这些来源
   * 无法可靠制卡，planner 必须显式提示而不是回退为无来源文本猜测。
   */
  unsupportedSourceBlocks?: SourceBlockInput[];
  /** 已有的 active objectives（用于 dedup） */
  existingObjectives: ExistingObjectiveRef[];
  /** 客户端 hardMaxCards（如有） */
  clientHardMaxCards?: number;
  /** 注入的模型提取器（可选；不注入则只用确定性提取） */
  extractionProvider?: AtomExtractionProvider;
}

export interface ExistingObjectiveRef {
  objectiveId: string;
  semanticTargetFingerprint: string;
  objectiveStatement: string;
  publicSummary: string;
}

export interface PlannerResult {
  plan: CardPlanV2;
  atoms: ExtractedKnowledgeAtom[];
}

/**
 * §8.3–8.5: 执行 Learnability Planning。
 *
 * 步骤：
 * 1. 提取 Knowledge Atoms（确定性 + 模型可选）
 * 2. 评估 marginal learning value
 * 3. 与 existing objectives 去重
 * 4. 决定 no_cards 或 author_candidates
 * 5. 冻结 CardPlanV2（含 planHash）
 */
export async function executePlanner(input: PlannerInput): Promise<PlannerResult> {
  // Step 1: Extract atoms
  let atoms: ExtractedKnowledgeAtom[];
  if (input.extractionProvider) {
    atoms = await input.extractionProvider.extractAtoms(input.blocks, input.semanticSpec);
  } else {
    atoms = extractAtomsDeterministic(input.blocks);
  }

  // Step 2: Filter trivial/unreliable atoms
  const learnableAtoms = atoms.filter((a) => {
    return a.learnabilityBps >= 3_000 && a.confidenceBps >= 3_000 && a.importanceBps >= 2_000;
  });

  // Step 3: Dedup against existing objectives + in-note duplicates
  const atomDecisions: AtomDecisionV2[] = [];
  const objectivesToCreate: ExtractedKnowledgeAtom[] = [];
  // C04（§28）：篇内重复段落/句子只保留一个目标——规范化（去空白）后相同即判重复，
  // 后续副本记 omit_duplicate，避免"重复两次相同段落 → 卡数翻倍"。
  const seenPropositions = new Set<string>();

  for (const atom of learnableAtoms) {
    const existingMatch = findMatchingExistingObjective(atom, input.existingObjectives);
    if (existingMatch) {
      atomDecisions.push({
        atomId: atom.atomId,
        decision: "covered_by_existing_objective",
        existingLearningObjectiveId: existingMatch.objectiveId,
      });
      continue;
    }
    const normalized = atom.proposition.replace(/\s+/g, "");
    if (seenPropositions.has(normalized)) {
      atomDecisions.push({ atomId: atom.atomId, decision: "omit_duplicate" });
      continue;
    }
    seenPropositions.add(normalized);
    const objectiveLocalId = `obj-${atom.atomId}`;
    objectivesToCreate.push(atom);
    atomDecisions.push({
      atomId: atom.atomId,
      decision: "create_objective",
      objectiveLocalId,
    });
  }

  // Mark filtered atoms as omitted
  for (const atom of atoms) {
    if (!learnableAtoms.includes(atom)) {
      const reason = atom.learnabilityBps < 3_000
        ? "omit_not_learnable"
        : atom.confidenceBps < 3_000
          ? "omit_unreliable"
          : atom.importanceBps < 2_000
            ? "omit_trivial"
            : "omit_duplicate";
      atomDecisions.push({ atomId: atom.atomId, decision: reason });
    }
  }

  // Step 4: Determine no_cards vs author_candidates
  const isMicroNote = isMicroNoteCheck(input.blocks);
  const maxCards = computeActivationHardMax(
    input.clientHardMaxCards,
    isMicroNote,
    objectivesToCreate.length,
  );

  let result: CardPlanV2["result"];

  if (objectivesToCreate.length === 0) {
    // §8.3: no_cards_recommended
    const reasonCodes = determineNoCardReasons(
      learnableAtoms, atoms, input.existingObjectives,
      input.unsupportedSourceBlocks,
    );
    result = {
      kind: "no_cards_recommended",
      reasonCodes,
    };
  } else {
    // §8.4: author_candidates
    const plannedObjectives = objectivesToCreate.map((atom, idx) =>
      createPlannedObjective(atom, idx),
    );
    const existingActions: PlannedExistingLifecycleActionV2[] = [];

    result = {
      kind: "author_candidates",
      recommendedCardCount: plannedObjectives.length,
      activationHardMax: maxCards,
      objectives: plannedObjectives,
      existingActions,
    };
  }

  // Step 5: Freeze CardPlan
  const planRevisionId = randomUUID();
  const planWithoutHash: Omit<CardPlanV2, "planHash"> = {
    version: 2,
    planRevisionId,
    runId: input.runId,
    inputSnapshotHash: input.inputSnapshot.inputSnapshotHash,
    cardContentEpoch: input.inputSnapshot.cardContentEpoch,
    planVersion: 1,
    previousPlanRevisionId: null,
    result,
    atomDecisions,
  };
  const planHash = computeCardPlanHashV2(planWithoutHash);
  const plan: CardPlanV2 = { ...planWithoutHash, planHash };

  return { plan, atoms };
}

// ─── Helper functions ────────────────────────────────────────────────────

function splitIntoSentences(text: string): string[] {
  // 中文句号、英文句号、问号、感叹号分割
  return text.split(/[。.!！?？\n]+/).filter((s) => s.trim().length > 0);
}

function isOperationalOrTemporary(sentence: string): boolean {
  const operationalPatterns = [
    /^(TODO|FIXME|NOTE|WARNING)/i,
    /^(待办|注意|警告)/,
    /^#{1,6}\s/, // markdown headers
    // C03：临时待办/日程/购物清单（明天/下周/记得/买…/开会/交…）
    /^(明天|今天|后天|下周|本周|周一|周二|周三|周四|周五|周六|周日|今晚|上午|下午|晚上)/,
    // R33：去掉裸 `买`/`交` 子串——误伤内容句（"交换""交易""买卖"等
    // 科学/经济学内容被整体过滤 → 0 卡）；保留完整短语模式。
    /(记得|别忘了|提醒我|去买|买点|买些|买东西|开会|会议|截止|截止日期)/,
  ];
  const trimmed = sentence.trim();
  return operationalPatterns.some((p) => p.test(trimmed));
}

function estimateImportance(sentence: string): number {
  // 简单启发式：长度、关键词、定义性语句
  if (sentence.includes("定义") || sentence.includes("是指") || sentence.includes("是")) return 8_000;
  if (sentence.includes("因为") || sentence.includes("所以") || sentence.includes("导致")) return 7_000;
  if (sentence.includes("步骤") || sentence.includes("过程") || sentence.includes("方法")) return 7_000;
  if (sentence.includes("比较") || sentence.includes("区别") || sentence.includes("对比")) return 7_000;
  if (sentence.length > 100) return 6_000;
  return 5_000;
}

function estimateLearnability(sentence: string): number {
  // 启发式：可检索性、可判分性
  if (sentence.includes("定义") || sentence.includes("是指")) return 9_000;
  if (sentence.includes("步骤") || sentence.includes("过程")) return 8_000;
  if (sentence.includes("因为") || sentence.includes("所以")) return 8_000;
  if (sentence.includes("比较") || sentence.includes("区别")) return 7_000;
  if (sentence.length < 20) return 4_000;
  if (sentence.length > 200) return 5_000;
  return 6_000;
}

function inferKnowledgeForm(sentence: string): KnowledgeFormV2 {
  if (sentence.includes("定义") || sentence.includes("是指")) return "definition";
  if (sentence.includes("因为") || sentence.includes("导致")) return "causal_model";
  if (sentence.includes("比较") || sentence.includes("区别")) return "comparison";
  if (sentence.includes("步骤") || sentence.includes("过程")) return "procedure";
  if (sentence.includes("边界") || sentence.includes("不适用")) return "boundary";
  if (sentence.includes("应用") || sentence.includes("使用")) return "application_rule";
  if (sentence.match(/[A-Z]+:/) || sentence.includes("关系")) return "relationship";
  return "fact";
}

function findMatchingExistingObjective(
  atom: ExtractedKnowledgeAtom,
  existing: ExistingObjectiveRef[],
): ExistingObjectiveRef | null {
  const atomLower = atom.proposition.toLowerCase().slice(0, 200);
  for (const obj of existing) {
    const objLower = obj.objectiveStatement.toLowerCase().slice(0, 200);
    // Exact match
    if (atomLower === objLower) return obj;

    // Try word-level Jaccard (for Latin scripts with spaces)
    const atomWords = new Set(atomLower.split(/\s+/).filter((w) => w.length > 0));
    const objWords = new Set(objLower.split(/\s+/).filter((w) => w.length > 0));
    if (atomWords.size > 3) {
      const intersection = [...atomWords].filter((w) => objWords.has(w)).length;
      const union = new Set([...atomWords, ...objWords]).size;
      if (union > 0 && intersection / union > 0.7) return obj;
    }

    // Fallback: character bigram similarity (for CJK text without spaces)
    const atomBigrams = extractBigrams(atomLower);
    const objBigrams = extractBigrams(objLower);
    if (atomBigrams.size > 5) {
      const intersection = [...atomBigrams].filter((b) => objBigrams.has(b)).length;
      const union = new Set([...atomBigrams, ...objBigrams]).size;
      if (union > 0 && intersection / union > 0.7) return obj;
    }
  }
  return null;
}

function extractBigrams(text: string): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) {
    const bigram = text.slice(i, i + 2);
    if (bigram.trim().length === 2) bigrams.add(bigram);
  }
  return bigrams;
}

function isMicroNoteCheck(blocks: SourceBlockInput[]): boolean {
  const totalChars = blocks.reduce((sum, b) => sum + b.content.length, 0);
  return totalChars <= MICRO_NOTE_CHAR_THRESHOLD && blocks.length <= MICRO_NOTE_BLOCK_THRESHOLD;
}

function computeActivationHardMax(
  clientHardMax: number | undefined,
  isMicroNote: boolean,
  objectiveCount: number,
): number {
  // §8.5: server policy cap always applies
  const serverCap = SERVER_POLICY_MAX_CARDS;
  // micro-note: cap at 3
  const microCap = isMicroNote ? 3 : serverCap;
  // client cap
  const clientCap = clientHardMax ?? serverCap;
  // Final: min of all caps, but at least 0
  return Math.max(0, Math.min(serverCap, microCap, clientCap, objectiveCount));
}

function determineNoCardReasons(
  learnableAtoms: ExtractedKnowledgeAtom[],
  allAtoms: ExtractedKnowledgeAtom[],
  existing: ExistingObjectiveRef[],
  unsupportedBlocks?: SourceBlockInput[],
): NoCardReasonCodeV2[] {
  const reasons: NoCardReasonCodeV2[] = [];
  // §14.2（R36）：sourceScope 内存在非文本模态（image/code）且没有可 seal 的
  // 文本 evidence 时，必须显式提示"当前无法可靠制卡"，不得回退为无来源文本
  // 猜测（OCR/公式/代码解析只是提取层，仍须进入 Grounding Critic）。
  const unsupportedModalBlocks = (unsupportedBlocks ?? []).filter((b) =>
    ["image", "code", "diagram", "formula", "table"].includes(String(b.type ?? "").toLowerCase()),
  );
  if (unsupportedModalBlocks.length > 0 && allAtoms.length === 0) {
    reasons.push("unsupported_for_requested_goal");
  }
  if (allAtoms.length === 0 && reasons.length === 0) {
    reasons.push("no_learnable_objective");
  }
  if (learnableAtoms.length === 0 && allAtoms.length > 0) {
    reasons.push("no_pedagogically_useful_transformation");
  }
  if (learnableAtoms.length > 0 && existing.length > 0) {
    // All atoms matched existing
    const allMatched = learnableAtoms.every((a) =>
      findMatchingExistingObjective(a, existing),
    );
    if (allMatched) {
      reasons.push("already_covered_by_active_objectives");
    }
  }
  if (reasons.length === 0) {
    reasons.push("no_learnable_objective");
  }
  return reasons.slice(0, 8) as NoCardReasonCodeV2[];
}

function createPlannedObjective(
  atom: ExtractedKnowledgeAtom,
  index: number,
): PlannedObjectiveV2 {
  const objectiveLocalId = `obj-${atom.atomId}`;
  return {
    objectiveLocalId,
    objectiveStatement: atom.proposition.slice(0, 2000),
    priority: index === 0 ? "critical" : index < 3 ? "important" : "optional",
    knowledgeForm: atom.knowledgeFormHint,
    sourceAtomIds: [atom.atomId],
    reasonCodes: [`learnability-${atom.learnabilityBps}`, `importance-${atom.importanceBps}`],
    estimatedReviewCostSeconds: Math.min(300, Math.max(30, atom.proposition.length)),
    changeContext: { kind: "create_new" },
  };
}
