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
 *
 * 2026-08-24（AI 设计审查 §4.4 修复）：本文件自 apps/api/src/modules/card-generation-v2/
 * 下沉至 packages/shared（纯逻辑、无 DB/provider 依赖）。worker 与 api 作为平级
 * 消费者经 @ailearn/shared/card-generation-v2-pipeline 子路径引用，消除 worker
 * 该模块是 card-generation-v2 pipeline 的 canonical planner 实现。
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
  CardStrategyV2,
  PracticeItemFormV2,
} from "../card-generation-v2-contracts.ts";
import { CardStrategyValuesV2, practiceFormsForKnowledgeForm } from "../card-generation-v2-contracts.ts";
import type { TaskIntentV1 } from "../learning-run-contracts.ts";
import {
  computeCardPlanHashV2,
} from "../card-generation-v2-hashing.ts";

// ─── 服务端 Policy Cap ───────────────────────────────────────────────────

/** §8.5: 服务端 hard cap，任何 Planner 输出不得超过此值。 */
export const SERVER_POLICY_MAX_CARDS = 20;

/**
 * micro-note 的卡数上限（§8.6：micro-note → **1–2 张**，"禁止逐句拆卡"）。
 *
 * 2026-09-17（质量校准）：此前为 3，与 §8.6 的 1–2 不符；实测 26–46 字的极短笔记
 * 被拆成 3 张互相泄题、单张无法判分的碎片卡（gold corpus 对这类笔记标注为恰好 1 张）。
 * 该值同时是 planner 的目标预算与 deck gate 的 count 上限，因此在 planner 侧就被
 * 截断（超出部分记 `omit_over_budget`），不会走到 deck gate 硬失败。
 */
export const MICRO_NOTE_MAX_CARDS = 2;

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
 * 模型增强 Atom 提取的调用上下文（可选）。
 *
 * 2026-09-15（管线评审 M3）：此前 extractAtoms 只拿到 blocks + semanticSpec，
 * provider 无法把"可用证据 ID 清单"（planner system prompt 明确要求模型从该列表
 * 选择 evidenceRefIds）与"已有 active objectives"（规划期去重）交给模型——prompt
 * 指令与实现互相矛盾（provider 只能硬编码 evidenceRefIds: []、existingObjectives: []），
 * 去重退化为事后字符串近似匹配。
 *
 * `signal`：调用方的取消信号（租约丢失 / 管道预算耗尽），透传到 LLM 调用。
 */
export interface AtomExtractionContext {
  /** sealed evidence 清单（ID + quote hash），供模型引用。 */
  evidenceList?: Array<{ evidenceSnapshotId: string; quoteHash?: string | null }>;
  /** 已有 active objectives（规划期避免重复成卡）。 */
  existingObjectives?: Array<{ objectiveId: string; objectiveStatement: string; publicSummary: string }>;
  signal?: AbortSignal;
}

/**
 * 模型增强 Atom 提取接口。
 * 调用方注入 provider 调用，本模块不直接实现。
 */
export interface AtomExtractionProvider {
  extractAtoms(
    blocks: SourceBlockInput[],
    semanticSpec: GenerationSemanticSpecV2,
    context?: AtomExtractionContext,
  ): Promise<AtomExtractionOutput>;
}

/**
 * 模型侧 Atom 提取结果。
 *
 * 2026-09-18（零卡链路合同缺口修复）：此前接口只返回 `ExtractedKnowledgeAtom[]`，
 * 于是"这条笔记不值得制卡"这个**合法结论无处表达**——模型只能返回空数组，而空数组
 * 与"模型输出坏了"不可区分（provider 此前一律判协议错误并重试，重试耗尽即 failed）。
 * 结果：**零卡终态在真实 LLM 链路里根本无法到达**，而 prompt 却明确要求模型对
 * 玩笑/待办/无来源断言/矛盾内容"输出 0 个原子"。评测里 12 条零卡 fixture 全部走成
 * `needs_attention`（实测 22 次 planner 调用、0 次成功终态）。
 *
 * 为什么还需要 `noAtomsReasonCode`：零卡是成功的终态，但**理由**必须正确——
 * 合同要求 `reasonCodes` 落在冻结枚举内，且不同类别的期望码不同（待办/日程类
 * 期望 `source_is_temporary_or_operational`，玩笑/感想类期望 `no_learnable_objective`）。
 * 而确定性侧 `determineNoCardReasons` 只在 `allAtoms.length === 0` 时给出
 * `no_learnable_objective`，**永远推不出** `source_is_temporary_or_operational`
 * ——"为什么不成卡"只有模型知道，所以必须由模型显式声明。
 */
export interface AtomExtractionOutput {
  atoms: ExtractedKnowledgeAtom[];
  /**
   * 当 `atoms` 为空时，模型给出的"本条笔记不值得制卡"的**理由码**。
   * 省略 / 非法值 + 空数组 → 视为协议错误（fail-closed：不把"输出坏了"伪装成 0 卡）。
   */
  noAtomsReasonCode?: NoCardReasonCodeV2;
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
  /**
   * sealed evidence 清单（ID + quote hash）。M3：透传给提取器，使 planner 的
   * system prompt 里"evidenceRefIds 从可用证据 ID 列表中选择"真正可满足。
   */
  evidenceList?: Array<{ evidenceSnapshotId: string; quoteHash?: string | null }>;
  /** 调用方取消信号（租约丢失 / 管道预算耗尽），透传到 LLM 调用。 */
  signal?: AbortSignal;
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
  /** 模型显式声明的"无原子"理由（仅当模型返回空原子集时有值）。 */
  let modelNoAtomsReasonCode: NoCardReasonCodeV2 | undefined;
  if (input.extractionProvider) {
    const extracted = await input.extractionProvider.extractAtoms(input.blocks, input.semanticSpec, {
      evidenceList: input.evidenceList,
      existingObjectives: input.existingObjectives,
      signal: input.signal,
    });
    atoms = extracted.atoms;
    modelNoAtomsReasonCode = extracted.noAtomsReasonCode;
  } else {
    atoms = extractAtomsDeterministic(input.blocks);
  }

  // Step 2: Filter trivial/unreliable atoms
  const learnableAtoms = atoms.filter((a) => {
    return a.learnabilityBps >= 3_000 && a.confidenceBps >= 3_000 && a.importanceBps >= 2_000;
  });

  // Step 3: Dedup against existing objectives + in-note duplicates
  const atomDecisions: AtomDecisionV2[] = [];
  /** 通过去重、**尚未**受预算约束的候选目标池（authoring 顺序 = 原子顺序）。 */
  const objectivePool: ExtractedKnowledgeAtom[] = [];
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
    objectivePool.push(atom);
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
    objectivePool.length,
  );

  // §8.5 预算约束（2026-09-17 修复合同违约）：
  // `cardPlanV2Schema.superRefine` 要求 `recommendedCardCount ≤ activationHardMax`，
  // 而 `activationHardMax` 含 micro-note 上限与服务端/客户端上限，**可能小于**候选
  // 目标池大小。此前直接把整池写成 objectives + recommendedCardCount，产出的 plan
  // 违反自身 schema（handler 持久化时不复校验），author 又按"整池"出卡，最终 deck
  // gate 以 `count_out_of_plan` **硬失败**：内容全部通过 grounding+pedagogy 也交付
  // 不了，run 进 needs_attention（dev 实测 micro-bound-get-vs-post 即此路径）。
  // 现在在 planner 内就按预算截断（预算内择优：保留 authoring 顺序 = 原子顺序），
  // 被截断的原子显式记账 omit_over_budget，审计上能回答"为什么这个知识点没成卡"。
  const budgetedAtoms = objectivePool.slice(0, Math.max(0, maxCards));
  const budgetedAtomIds = new Set(budgetedAtoms.map((atom) => atom.atomId));
  for (const atom of objectivePool) {
    if (budgetedAtomIds.has(atom.atomId)) continue;
    atomDecisions.push({ atomId: atom.atomId, decision: "omit_over_budget" });
  }
  const objectivesToCreate = budgetedAtoms;
  for (const atom of objectivesToCreate) {
    atomDecisions.push({
      atomId: atom.atomId,
      decision: "create_objective",
      objectiveLocalId: `obj-${atom.atomId}`,
    });
  }

  let result: CardPlanV2["result"];

  if (objectivesToCreate.length === 0) {
    // §8.3: no_cards_recommended
    //
    // 2026-09-18：模型显式声明的理由码优先。确定性 `determineNoCardReasons` 只会
    // 推出"无可学目标"这一种理由（`source_is_temporary_or_operational` 等它推不出来），
    // 而合同要求零卡理由落在冻结枚举内且与内容类别相符（待办/日程 vs 玩笑/感想）。
    // 模型给出的码已由 provider 侧按枚举校验过，因此这里只做去重与上限收口。
    const reasonCodes = modelNoAtomsReasonCode
      ? [modelNoAtomsReasonCode]
      : determineNoCardReasons(
        learnableAtoms, atoms, input.existingObjectives,
        input.unsupportedSourceBlocks,
      );
    result = {
      kind: "no_cards_recommended",
      reasonCodes,
    };
  } else {
    // §8.4: author_candidates
    const allocations = allocateStrategies(
      objectivesToCreate.map((atom) => atom.knowledgeFormHint),
      input.semanticSpec.semanticRequest.preferredStrategies,
    );
    // D6：练习件配额与题型配额**独立**（策略是认知框架，模态是作答方式，两者正交）。
    const practiceAllocations = allocatePracticeForms(
      objectivesToCreate.map((atom) => atom.knowledgeFormHint),
    );
    const plannedObjectives = objectivesToCreate.map((atom, idx) =>
      createPlannedObjective(atom, idx, allocations[idx]!, practiceAllocations[idx]!),
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
  const microCap = isMicroNote ? MICRO_NOTE_MAX_CARDS : serverCap;
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
  strategy: StrategyAllocation,
  practice: PracticeFormAllocation,
): PlannedObjectiveV2 {
  const objectiveLocalId = `obj-${atom.atomId}`;
  const reasonCodes = [
    `learnability-${atom.learnabilityBps}`,
    `importance-${atom.importanceBps}`,
  ];
  if (strategy.reasonCode) reasonCodes.push(strategy.reasonCode);
  if (practice.reasonCode) reasonCodes.push(practice.reasonCode);
  return {
    objectiveLocalId,
    objectiveStatement: atom.proposition.slice(0, 2000),
    priority: index === 0 ? "critical" : index < 3 ? "important" : "optional",
    knowledgeForm: atom.knowledgeFormHint,
    strategy: strategy.strategy,
    practiceForm: practice.form,
    sourceAtomIds: [atom.atomId],
    reasonCodes,
    estimatedReviewCostSeconds: Math.min(300, Math.max(30, atom.proposition.length)),
    changeContext: { kind: "create_new" },
  };
}

// ─── 题型分配（§8.4）─────────────────────────────────────────────────────

/**
 * 每种知识形态可接受的题型，按教学适配度从高到低排列。
 *
 * 这是硬约束的另一半：用户勾的题型是**偏好**，不能把"因果模型"塞进填空题，
 * 但可以在同一形态的几个合理题型之间按偏好挑选。`fact`/`definition` 把
 * `cloze` 排在前面——此前映射表只有 `fact → recall`，`cloze` 在整个确定性
 * 链路上根本不可达（2026-09-20 实走：一批卡全是主观回忆题）。
 */
const STRATEGIES_FOR_KNOWLEDGE_FORM: Record<KnowledgeFormV2, readonly CardStrategyV2[]> = {
  fact: ["cloze", "recall"],
  definition: ["recall", "cloze"],
  relationship: ["compare", "why", "recall"],
  comparison: ["compare", "boundary"],
  sequence: ["sequence", "cloze"],
  procedure: ["sequence", "recall"],
  causal_model: ["why", "recall"],
  boundary: ["boundary", "compare"],
  application_rule: ["application", "why"],
};

/** 该知识形态最自然的题型。 */
export function strategyForKnowledgeForm(form: KnowledgeFormV2): CardStrategyV2 {
  return STRATEGIES_FOR_KNOWLEDGE_FORM[form]?.[0] ?? "recall";
}

export interface StrategyAllocation {
  strategy: CardStrategyV2;
  /** 分配偏离了"最自然题型"或偏好无法完全满足时的可审计原因。 */
  reasonCode?: string;
}

/**
 * 在**整批**目标上分配题型。
 *
 * 三条规则，按优先级：
 * 1. 形态适配（`STRATEGIES_FOR_KNOWLEDGE_FORM`）是硬边界，不越界出题；
 * 2. 用户偏好 `preferredStrategies` 是一个**集合**（决定哪些题型可用），不是优先级；
 *    可用集合内一律按教学适配度取先。最自然题型被偏好排除、由同形态的次优题型顶上时
 *    记 `strategy_preference_applied`；偏好里没有任何一项与本卡形态适配时，该卡退回
 *    最自然题型（即偏好被形态边界否决）。
 * 3. 多样性上限：单一题型不超过 ⌈N/2⌉ 张，超出则取次优适配题型（记
 *    `strategy_diversity_capped`）。**例外**：用户只勾了一种题型时不设上限——
 *    明确的单一偏好就是要求，不是需要被"多样性"纠正的错误。
 *
 * 多样性必须在这里、按整批上下文决定，不能交给模型自觉——模型逐张出题时看不到
 * 其他卡，且提示里给什么示例就会照抄什么。
 */
export function allocateStrategies(
  forms: readonly KnowledgeFormV2[],
  preferredStrategies?: readonly CardStrategyV2[],
): StrategyAllocation[] {
  const total = forms.length;
  const preferred = [...new Set(preferredStrategies ?? [])];
  /** 一种题型最多占几张：只有确实有多种可选时才限流。 */
  const capPerStrategy = preferred.length === 1
    ? total
    : total >= 2 ? Math.ceil(total / 2) : total;
  const used = new Map<CardStrategyV2, number>();

  return forms.map((form) => {
    const compatible = STRATEGIES_FOR_KNOWLEDGE_FORM[form] ?? ["recall"];
    /**
     * 偏好是**集合**不是优先级——界面上是一排 chip，用户的点选顺序不构成排序意图
     * （默认值 `["recall","why"]` 若被当成优先级，会把 recall 顶到一切形态前面，
     * 正好复刻 2026-09-20 复盘的那个缺陷）。因此候选顺序一律按教学适配度排，
     * 偏好只决定"这一种形态上的哪些题型被允许"。
     */
    const ranked = preferred.length
      ? [
        ...compatible.filter((s) => preferred.includes(s)),
        ...compatible.filter((s) => !preferred.includes(s)),
      ]
      : [...compatible];
    const countOf = (strategy: CardStrategyV2) => used.get(strategy) ?? 0;
    const natural = compatible[0]!;
    const bestFit = ranked[0]!;
    const unlocked = countOf(bestFit) < capPerStrategy
      ? bestFit
      : ranked.find((s) => countOf(s) < capPerStrategy) ?? bestFit;
    used.set(unlocked, countOf(unlocked) + 1);

    if (unlocked !== bestFit) return { strategy: unlocked, reasonCode: "strategy_diversity_capped" };
    if (bestFit !== natural) return { strategy: unlocked, reasonCode: "strategy_preference_applied" };
    return { strategy: unlocked };
  });
}

/** D6：一张卡本轮要不要交练习件、交哪一种。 */
export interface PracticeFormAllocation {
  /** 必须交出的形状；null = 不强制（作者仍可自愿交，反推兜底也照旧）。 */
  form: PracticeItemFormV2 | null;
  reasonCode?: string;
}

/**
 * 整批的**客观练习件配额**（方案 D6）。
 *
 * 三条与 `allocateStrategies` 同源的理由：
 * 1. 配额是整批的事，不能交给 author 逐张决定——它看不到别的卡，也看不到这一批
 *    已经出了几道题；v24/v25 的实测就是这么从"一张都没有"走到"形状偏置"的。
 * 2. 下限取 ⌈N/2⌉：一批 N 张卡里至少一半带练习件，剩下的留给产出型框架
 *    （§2 的产品约束：客观题是练习件，不是卡的本体）。
 * 3. **模态铺开**：在同一形态允许的形状里取本批用得最少的那个，并列时取该形态的
 *    首选。`sequence` 只有 ordering、`application_rule` 只有 single_choice，
 *    这些形态不会被硬凑成别的形状——形态边界优先于铺开。
 *
 * 凑不满不强造（D4）：这里只决定"要求谁交"，作者给不出有证据的干扰项时照样交 null，
 * 缺额由下面的 `summarizePracticeQuotaV2` 结算（管道落一条
 * `card_generation.practice_quota_short` 事件），而不是伪造一道题。
 */
export function allocatePracticeForms(
  forms: readonly KnowledgeFormV2[],
): PracticeFormAllocation[] {
  const total = forms.length;
  // §49：小批不点名。库里 41% 的批次是 1–2 张（1 张的 175 个），旧口径 ⌈1/2⌉=1
  // 等于"整批只有一张卡还必须交一道选择题"——作者按 D4 老实写 null 时，
  // 那批会长期顶着一个不该存在的缺额。比例为 0 的代价是短笔记少一道练习件，
  // 而配额本来的目的（§2）是铺开供给，不是逼单张批次交差。
  const quota = total >= 3 ? Math.ceil(total / 2) : 0;
  const used = new Map<PracticeItemFormV2, number>();
  let required = 0;
  return forms.map((form) => {
    const allowed = practiceFormsForKnowledgeForm(form);
    if (allowed.length === 0 || required >= quota) return { form: null };
    required += 1;
    const pick = allowed.reduce(
      (best, candidate) => ((used.get(candidate) ?? 0) < (used.get(best) ?? 0) ? candidate : best),
      allowed[0]!,
    );
    used.set(pick, (used.get(pick) ?? 0) + 1);
    return { form: pick, reasonCode: "practice_quota_required" };
  });
}

/**
 * 作者对某个目标**实际交出**的东西：形状 + 选择题的宽度。
 *
 * 宽度必须是输入之一，否则"点名 single_choice 却只交两个选项"在结算里读起来
 * 与兑现完全一样——而两个选项没有干扰项可言，那正是点名这个形状要防的事
 * （§44 实测：两批里 2 道选择题有 1 道只有 2 个选项）。
 */
export interface DeliveredPracticeV2 {
  form: PracticeItemFormV2 | null;
  /** 仅对 `single_choice` / `matching` 有意义：选项数 / 配对数。缺省按 0 处理。 */
  optionCount?: number;
}

/** 一条被点名却没按形状交上的记录。 */
export interface PracticeQuotaMissV2 {
  objectiveLocalId: string;
  requiredForm: PracticeItemFormV2;
  /** 作者实际交出的形状；null = 什么都没交（或被门禁淘汰，映射里没有这个 id）。 */
  deliveredForm: PracticeItemFormV2 | null;
  /** 为什么没兑现——三种必须分得开，否则"没看见供给"又会换地方重演一次。 */
  missReason: "nothing_delivered" | "wrong_form" | "too_few_options";
}

export interface PracticeQuotaReportV2 {
  /** planner 点名的张数。 */
  requiredCount: number;
  /** 其中**形状对上且宽度达标**的张数。 */
  metCount: number;
  misses: PracticeQuotaMissV2[];
}

/**
 * D6 的另一半：配额点名之后，必须有人回答"到底交没交上"。
 *
 * 少了这一步，"这一批一道练习件都没有"和"配额被无声跳过"在数据上完全同形——
 * 那正是 v24 之前那个"可选字段没人填、供给与没看见分不开"的坑换个位置重演。
 * 判据是**形状对上才算兑现**：要求 `single_choice` 却交了 `ordering`，
 * 整批的模态铺开并没有发生，不能算数。
 *
 * 只算被点名的那些：作者自愿多交的不计入 `metCount`（它没有承担配额）。
 */
export function summarizePracticeQuotaV2(
  objectives: readonly { objectiveLocalId: string; practiceForm: PracticeItemFormV2 | null }[],
  deliveredByObjective: ReadonlyMap<string, DeliveredPracticeV2>,
): PracticeQuotaReportV2 {
  const misses: PracticeQuotaMissV2[] = [];
  let requiredCount = 0;
  for (const objective of objectives) {
    const required = objective.practiceForm;
    if (!required) continue;
    requiredCount += 1;
    const delivered = deliveredByObjective.get(objective.objectiveLocalId) ?? { form: null };
    const missReason = delivered.form === null
      ? "nothing_delivered" as const
      : delivered.form !== required
        ? "wrong_form" as const
        : isPracticeFormWideEnough(required, delivered.optionCount ?? 0)
          ? null
          : "too_few_options" as const;
    if (missReason) {
      misses.push({
        objectiveLocalId: objective.objectiveLocalId,
        requiredForm: required,
        deliveredForm: delivered.form,
        missReason,
      });
    }
  }
  return { requiredCount, metCount: requiredCount - misses.length, misses };
}

/**
 * 形状对了还要宽度够：选择题少于 3 个选项就没有干扰项可言（等于判断题换了个壳），
 * 配对题少于 2 对则没有"配"这件事。合同侧不能把这些下限抬进
 * `practiceItemV2Schema`——同一份 schema 也用于解析已落库的 revision，
 * 抬下限会当场打断现网卡（§46 实测有 1 张 active 的选择题正是 2 选项）。
 * 所以下限只在这里生效：不挡写入，只挡"算不算兑现配额"。
 */
function isPracticeFormWideEnough(
  form: PracticeItemFormV2,
  optionCount: number,
): boolean {
  if (form === "single_choice") return optionCount >= 3;
  if (form === "matching") return optionCount >= 2;
  return true;
}

/** 供 author 提示使用：全部题型枚举。 */
export const ALL_CARD_STRATEGIES: readonly CardStrategyV2[] = CardStrategyValuesV2;

/**
 * 题型 → 作答任务意图。
 *
 * learning-runs 构造作答通道时读的是 objective.preferredTaskIntents，**不是**
 * `presentation.strategy`（strategy 至今只用于卡片展示标签），因此必须由同一处
 * 决定两者，否则会出现"填空题面 + 解释类作答通道"的错位。
 */
const TASK_INTENTS_FOR_STRATEGY: Record<CardStrategyV2, readonly TaskIntentV1[]> = {
  recall: ["recall"],
  cloze: ["recall"],
  compare: ["relate", "paraphrase"],
  sequence: ["procedure"],
  why: ["explain"],
  boundary: ["boundary"],
  application: ["apply", "example"],
};

export function taskIntentsForStrategy(strategy: CardStrategyV2): readonly TaskIntentV1[] {
  return TASK_INTENTS_FOR_STRATEGY[strategy];
}
