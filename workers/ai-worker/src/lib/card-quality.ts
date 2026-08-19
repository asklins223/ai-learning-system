/**
 * 学习卡生成后质量校验与清洗。
 *
 * AI 模型输出的学习卡可能存在以下质量问题：
 * 1. quote_text 与原文不完全匹配（模型可能轻微改写了引用）
 * 2. key_points 之间存在语义重复
 * 3. claim 过短（只是话题标签，不是知识断言）
 * 4. claim 是模糊评价而非可验证的断言（如"X 很重要"）
 * 5. quote_text 过短，无法支撑 claim
 * 6. 模型输出超过 5 个 key_points
 * 7. claim 与 quote_text 完全无关（引用虽是原文逐字片段但与 claim 毫不相干）
 * 8. claim 只是 quote_text 的复述/压缩版，措辞高度重合——不是抽象提炼
 *
 * v0.6 新增：assessCardOutput 返回结构化质量报告（issue reason codes），
 * 用于驱动条件式修复（CARD-02，计划 §7.7）。
 *
 * 本模块提供轻量级的后处理函数，在 handler 持久化之前对输出进行清洗。
 * 所有函数都是纯函数，不依赖外部状态。
 */

import type { LearningCardOutput } from "@ailearn/shared";
import { CardRepairReasonCode } from "@ailearn/shared";
import { normalizeText, jaccard, containment } from "./text-similarity.ts";


// ─── v0.6: assessCardOutput (计划 §7.7) ───────────────────────────────────

/** 评估器版本 */
export const CARD_ASSESSOR_VERSION = "card-assessor-v1";

/** 质量问题 severity */
export type CardIssueSeverity = "hard" | "soft";

/** 单条质量问题 */
export interface CardIssue {
  code: string;
  severity: CardIssueSeverity;
  keyPointOrdinal?: number;
}

/**
 * 质量评估结果（计划 §7.7）。
 *
 * assessCardOutput 返回此结构，包含清洗后的输出和结构化 issue reason codes。
 * 用于驱动条件式修复：hard trigger 触发修复，soft trigger 可裁剪。
 */
export interface CardAssessmentResult {
  /** 清洗后的输出 */
  sanitized: LearningCardOutput;
  /** 检测到的质量问题，每项带 reason code 和 severity */
  issues: CardIssue[];
  /** 是否使用了渐进放宽 fallback */
  usedFallback: boolean;
  /** 是否存在 hard failure（无法安全解析或零有效 key point） */
  hardFailure: boolean;
  /** 评估器版本 */
  assessorVersion: string;
}

// ─── Shared helpers (internal) ────────────────────────────────────────────

// Local alias for brevity — uses the canonical NFKC-aware normalization
// from text-similarity.ts (BUG-07 fix).
const normalize = normalizeText;

// ─── Constants ─────────────────────────────────────────────────────────────

export const MIN_CLAIM_LENGTH = 12;
const CLAIM_DEDUP_THRESHOLD = 0.6;
const MIN_QUOTE_LENGTH = 10;
const QUOTE_CONTAINMENT_THRESHOLD = 0.5;
// CLAIM_QUOTE_SIMILARITY_THRESHOLD：claim 的 2-gram 在引文中的占比达到该值即判
// 「claim 复述引文」（claim_quote_too_similar），key point 被过滤。
// 校准说明：0.8 过于激进——真实改写（调整语序/句式、加入解释性表述）的 claim
// 与引文重合度实测集中在 0.5~0.65，而逐字照抄在 0.90+。0.85 能放行真实改写、
// 仍拦截近照抄，避免「重要性/评价类」等短句 claim 被误杀导致整卡
// insufficient_valid_key_points 硬失败。真正的质量底线由 claimQuoteRelevant
// （相关性）与 progressiveFallback 兜底。
const CLAIM_QUOTE_SIMILARITY_THRESHOLD = 0.85;
const MAX_KEY_POINTS = 5;

/** 覆盖率阈值：清洗后有效 key_points / 原始 key_points 低于此值触发 coverage_too_low */
const COVERAGE_TOO_LOW_THRESHOLD = 0.5;

// ─── Detection helpers ─────────────────────────────────────────────────────

/**
 * 合并后的单一 alternation 正则，替代 36 次线性扫描。
 * 用 new RegExp 构建，避免多行 regex literal 的语法限制。
 */
const VAGUE_CLAIM_PATTERNS_STR = [
  "很重要[。]?$",
  "很关键[。]?$",
  "很核心[。]?$",
  "很基础[。]?$",
  "很常见[。]?$",
  "是基础[。]?$",
  "是关键[。]?$",
  "是核心[。]?$",
  "很重要的概念[。]?$",
  "有重要影响[。]?$",
  "有显著影响[。]?$",
  "有很大影响[。]?$",
  "重要组成部分[。]?$",
  "关键组成部分[。]?$",
  "广泛应用于[^，。]+[。]?$",
  "是一种重要[^，。]*[。]?$",
  "至关重要[。]?$",
  "不可或缺[。]?$",
  "扮演重要角色[。]?$",
  "扮演关键角色[。]?$",
  "提供了基础[。]?$",
  "提供了支撑[。]?$",
  "提供了保障[。]?$",
  "具有重要意义的?$",
  "具有重要价值的?$",
  "具有重要作用[。]?$",
  "是常见的方法[。]?$",
  "是常见的做法[。]?$",
  "是核心概念[。]?$",
  "是核心机制[。]?$",
  "起着重要作用[。]?$",
  "起着关键作用[。]?$",
  "是不可或缺的?[。]?$",
  "有深远影响[。]?$",
  "有深刻影响[。]?$",
];
const VAGUE_CLAIM_RE = new RegExp(`(?:${VAGUE_CLAIM_PATTERNS_STR.join("|")})`);

export function isVagueClaim(claim: string): boolean {
  return VAGUE_CLAIM_RE.test(claim);
}

/**
 * 从已归一化文本直接构建 n-gram 集合，避免重复 normalize。
 * normalizeText 是幂等的，调用方（assessCardOutput/progressiveFallback 的循环）
 * 已先对 claim/quote 归一化，这里只做分词，节省每个 key point 多次重复归一化。
 */
function ngramSetFromNorm(norm: string, n: number): Set<string> {
  if (norm.length < n) return new Set([norm]);
  const out = new Set<string>();
  for (let i = 0; i <= norm.length - n; i++) {
    out.add(norm.slice(i, i + n));
  }
  return out;
}

/** 接收已归一化的 claim/quote，构建 bigram 集合做相关性检查 */
function claimQuoteRelevant(normClaim: string, normQuote: string): boolean {
  const claimBigrams = ngramSetFromNorm(normClaim, 2);
  const quoteBigrams = ngramSetFromNorm(normQuote, 2);
  if (claimBigrams.size === 0 || quoteBigrams.size === 0) return true;
  // BUG-06 fix: Require at least 2 overlapping bigrams for claims with ≥ 4
  // bigrams. A single bigram overlap (e.g. "基础" in "操作系统是基础" vs
  // "基础知识很重要") is insufficient for Chinese text where any two
  // adjacent characters can form a coincidental match.
  const minOverlap = claimBigrams.size >= 4 ? 2 : 1;
  let overlap = 0;
  for (const bg of claimBigrams) {
    if (quoteBigrams.has(bg)) {
      overlap++;
      if (overlap >= minOverlap) return true;
    }
  }
  return false;
}

function claimQuoteTooSimilar(normClaim: string, normQuote: string): boolean {
  if (normQuote.length < 30) return false;
  const claimBigrams = ngramSetFromNorm(normClaim, 2);
  const quoteBigrams = ngramSetFromNorm(normQuote, 2);
  if (claimBigrams.size === 0 || quoteBigrams.size === 0) return false;
  const claimInQuoteRatio = containment(claimBigrams, quoteBigrams);
  return claimInQuoteRatio >= CLAIM_QUOTE_SIMILARITY_THRESHOLD;
}

/**
 * PERF-26 修复：缓存 sourceBlocks 的 normalized 文本和 trigram 集合，
 * 避免在 assessCardOutput 的循环中对每个 key point 都重新计算。
 * 原代码对每个 key point 的 quote_text 检查时，都会重新 normalize 和
 * 计算 sourceBlocks 的 trigram 集合，产生大量重复计算。
 */
function quoteExistsInSource(
  normQuote: string,
  sourceBlockData: Array<{ normBlock: string; blockTrigrams: Set<string> }>,
): boolean {
  if (normQuote.length === 0) return false;
  // 第一轮：精确子串匹配
  for (const { normBlock } of sourceBlockData) {
    if (normBlock.includes(normQuote)) return true;
  }
  // 第二轮：trigram containment 匹配
  const quoteTrigrams = ngramSetFromNorm(normQuote, 3);
  if (quoteTrigrams.size === 0) return false;
  for (const { blockTrigrams } of sourceBlockData) {
    const ratio = containment(quoteTrigrams, blockTrigrams);
    if (ratio >= QUOTE_CONTAINMENT_THRESHOLD) return true;
  }
  return false;
}

// ─── assessCardOutput (计划 §7.7) ──────────────────────────────────────────

/**
 * 对 AI 输出的学习卡进行质量评估和清洗，返回结构化质量报告。
 *
 * 这是 v0.6 版本的 sanitizeCardOutput（计划 §7.7），
 * 在执行清洗的同时收集 issue reason codes，用于驱动条件式修复。
 *
 * 触发规则（计划 §7.7）：
 * - hard trigger：伪造/无原文引用(quote_not_in_source)、零有效 key point
 *   (insufficient_valid_key_points)、schema_invalid_bounded、必须使用渐进放宽 fallback
 * - terminal schema failure：无法安全解析(schema_unparseable)、字段/大小无界 →
 *   直接失败，不进入 repair
 * - soft trigger：大量重复(duplicate_key_point)、有效 key point 被移除超过冻结阈值
 *   (coverage_too_low)
 *
 * @param output - AI 模型输出的学习卡
 * @param sourceBlocks - 可选，原文 blocks 的内容数组。传入时会验证 quote_text 是否在原文中存在。
 * @returns 结构化质量评估结果
 */
export function assessCardOutput(
  output: LearningCardOutput,
  sourceBlocks?: string[],
): CardAssessmentResult {
  const issues: CardIssue[] = [];
  const originalCount = output.key_points.length;

  // 检测 schema_unparseable：输出无 key_points 或 title/summary 为空
  if (!output.key_points || output.key_points.length === 0 ||
      !output.title || !output.summary) {
    return {
      sanitized: output,
      issues: [{ code: CardRepairReasonCode.SCHEMA_UNPARSEABLE, severity: "hard" }],
      usedFallback: false,
      hardFailure: true,
      assessorVersion: CARD_ASSESSOR_VERSION,
    };
  }

  // 检测 schema_invalid_bounded：key_points 超过 10 个
  if (output.key_points.length > 10) {
    issues.push({
      code: CardRepairReasonCode.SCHEMA_INVALID_BOUNDED,
      severity: "hard",
    });
  }

  // PERF-02 fix: Cache bigrams of seen claims instead of recomputing
  // PERF-26 修复：预计算 sourceBlocks 的 normalized 文本和 trigram 集合，
  // 避免在循环中对每个 key point 重复计算。
  const sourceBlockData = sourceBlocks && sourceBlocks.length > 0
    ? sourceBlocks.map((block) => {
        const normBlock = normalize(block);
        return { normBlock, blockTrigrams: ngramSetFromNorm(normBlock, 3) };
      })
    : [];

  // ngramSet(seenNgram, 2) for each comparison.
  const seenBigrams: Set<string>[] = [];
  const deduped: LearningCardOutput["key_points"] = [];

  for (const kp of output.key_points) {
    const normClaim = normalize(kp.claim);
    const normQuote = normalize(kp.quote_text);

    if (normClaim.length < MIN_CLAIM_LENGTH) {
      issues.push({
        code: CardRepairReasonCode.CLAIM_TOO_SHORT,
        severity: "soft",
        keyPointOrdinal: kp.ordinal,
      });
      continue;
    }

    if (isVagueClaim(normClaim)) {
      issues.push({
        code: CardRepairReasonCode.CLAIM_VAGUE,
        severity: "soft",
        keyPointOrdinal: kp.ordinal,
      });
      continue;
    }

    if (normQuote.length < MIN_QUOTE_LENGTH) {
      issues.push({
        code: CardRepairReasonCode.QUOTE_NOT_IN_SOURCE,
        severity: "soft",
        keyPointOrdinal: kp.ordinal,
      });
      continue;
    }

    if (sourceBlockData.length > 0) {
      if (!quoteExistsInSource(normQuote, sourceBlockData)) {
        issues.push({
          code: CardRepairReasonCode.QUOTE_NOT_IN_SOURCE,
          severity: "hard",
          keyPointOrdinal: kp.ordinal,
        });
        continue;
      }
    }

    if (!claimQuoteRelevant(normClaim, normQuote)) {
      issues.push({
        code: CardRepairReasonCode.CLAIM_QUOTE_UNRELATED,
        severity: "hard",
        keyPointOrdinal: kp.ordinal,
      });
      continue;
    }

    if (claimQuoteTooSimilar(normClaim, normQuote)) {
      issues.push({
        code: CardRepairReasonCode.CLAIM_QUOTE_TOO_SIMILAR,
        severity: "soft",
        keyPointOrdinal: kp.ordinal,
      });
      continue;
    }

    const claimBigrams = ngramSetFromNorm(normClaim, 2);
    let isDuplicate = false;
    for (const existingBigrams of seenBigrams) {
      if (jaccard(claimBigrams, existingBigrams) >= CLAIM_DEDUP_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }

    if (isDuplicate) {
      issues.push({
        code: CardRepairReasonCode.DUPLICATE_KEY_POINT,
        severity: "soft",
        keyPointOrdinal: kp.ordinal,
      });
      continue;
    }

    seenBigrams.push(claimBigrams);
    deduped.push(kp);
    if (deduped.length >= MAX_KEY_POINTS) break;
  }

  // 检测覆盖率是否过低
  const validCount = deduped.length;
  // 截断修正：当原始 key_points 超过 MAX_KEY_POINTS(5) 时，deduped 会因截断停在 5，
  // validCount/originalCount 会因截断而非质量过滤产生 coverage_too_low 假阳性。
  // 分母取 min(originalCount, MAX_KEY_POINTS)：5 个以内保持原有语义，超过 5 个时
  // 覆盖率以"最多可保留的 5 个"为基准，避免假阳性。
  const coverageDenominator = Math.min(originalCount, MAX_KEY_POINTS);
  if (coverageDenominator > 0 && validCount / coverageDenominator < COVERAGE_TOO_LOW_THRESHOLD) {
    issues.push({
      code: CardRepairReasonCode.COVERAGE_TOO_LOW,
      severity: "soft",
    });
  }

  // 检测零有效 key point
  if (deduped.length === 0) {
    issues.push({
      code: CardRepairReasonCode.INSUFFICIENT_VALID_KEY_POINTS,
      severity: "hard",
    });

    const fallbackKps = progressiveFallback(output, sourceBlocks);
    const renumberedFallback = fallbackKps.map((kp, idx) => ({
      ...kp,
      ordinal: idx,
    }));

    return {
      sanitized: {
        ...output,
        key_points: renumberedFallback,
      },
      issues,
      usedFallback: true,
      hardFailure: false,
      assessorVersion: CARD_ASSESSOR_VERSION,
    };
  }

  const renumbered = deduped.map((kp, idx) => ({
    ...kp,
    ordinal: idx,
  }));

  return {
    sanitized: {
      ...output,
      key_points: renumbered,
    },
    issues,
    usedFallback: false,
    hardFailure: false,
    assessorVersion: CARD_ASSESSOR_VERSION,
  };
}

// ─── sanitizeCardOutput (backward-compatible wrapper) ──────────────────────

/**
 * 对 AI 输出的学习卡进行后处理清洗。
 *
 * 这是 sanitizeCardOutput 的向后兼容包装，调用 assessCardOutput 并只返回 sanitized。
 * v0.6 新代码应直接使用 assessCardOutput 获取结构化质量报告。
 *
 * @param output - AI 模型输出的学习卡
 * @param sourceBlocks - 可选，原文 blocks 的内容数组。传入时会验证 quote_text 是否在原文中存在。
 */
export function sanitizeCardOutput(
  output: LearningCardOutput,
  sourceBlocks?: string[],
): LearningCardOutput {
  return assessCardOutput(output, sourceBlocks).sanitized;
}

// ─── progressiveFallback (internal) ───────────────────────────────────────

/**
 * 渐进放宽的 fallback 策略。
 *
 * 当严格过滤后 key_points 为空时，逐级放宽条件尝试保留「最不差」的 key points：
 * 1. 放宽 quote 校验（阈值从 0.5 降到 0.3），保留 claim 不太相似于 quote 的
 * 2. 放宽 quote 校验（阈值 0.3）+ 放宽相似度检查（允许 claim 复述 quote）
 * 3. 放宽 claim 最小长度（从 12 降到 8），不检查 quote 校验
 * 4. 放宽相关性检查（要求至少有 1 个 unigram 重叠）
 * 5. 如果以上都失败，返回 claim 最长的原始 key points
 *
 * 每一步都在前一步保留结果的基础上补充，目标保留 1-3 个 key points。
 * 避免直接返回原始输出（可能包含伪造引用或完全无关的 claim-quote 对）。
 */
function progressiveFallback(
  output: LearningCardOutput,
  sourceBlocks?: string[],
): LearningCardOutput["key_points"] {
  const candidates = [...output.key_points];
  const kept: LearningCardOutput["key_points"] = [];
  const keptBigrams: Set<string>[] = [];

  // PERF-31 修复：使用惰性计算替代全量预计算。
  // 原代码（PERF-03 fix）对所有候选预计算 5 种 ngram 集合，
  // 但如果 level 1 成功（常见情况），claimUnigrams 和 quoteUnigrams
  // 的计算是纯开销。改为惰性计算：只在首次访问时计算对应 ngram 集合。
  // 同时保留 normClaimLen/normQuoteLen 的预计算（轻量，所有级别都需要）。
  // PERF-31 修复 + normalize 复用：预计算 normalized 文本，所有 ngram 都从 norm 生成。
  // 原代码 getter 使用 ngramSet(kp.claim, 2) 会重复 normalize；
  // 且 claimQuoteRelevant/claimQuoteTooSimilar 接收已归一化文本，
  // 但被传入了 raw text，导致 n-gram 在未归一化文本上计算。
  const precomputed = candidates.map((kp) => {
    const normClaim = normalize(kp.claim);
    const normQuote = normalize(kp.quote_text);
    // 惰性缓存：ngram 集合只在首次访问时计算，复用已归一化文本
    let _claimBigrams: Set<string> | null = null;
    let _claimUnigrams: Set<string> | null = null;
    let _quoteTrigrams: Set<string> | null = null;
    let _quoteUnigrams: Set<string> | null = null;
    return {
      normClaim,
      normQuote,
      normClaimLen: normClaim.length,
      normQuoteLen: normQuote.length,
      get claimBigrams() { return _claimBigrams ??= ngramSetFromNorm(normClaim, 2); },
      get claimUnigrams() { return _claimUnigrams ??= ngramSetFromNorm(normClaim, 1); },
      get quoteTrigrams() { return _quoteTrigrams ??= ngramSetFromNorm(normQuote, 3); },
      get quoteUnigrams() { return _quoteUnigrams ??= ngramSetFromNorm(normQuote, 1); },
    };
  });

  // 惰性计算 block trigrams（仅在 level 1/2 需要时计算），复用已归一化文本
  let _blockTrigrams: Set<string>[] | null = null;
  const getBlockTrigrams = (): Set<string>[] | null => {
    if (_blockTrigrams === null && sourceBlocks) {
      _blockTrigrams = sourceBlocks.map((block) => ngramSetFromNorm(normalize(block), 3));
    }
    return _blockTrigrams;
  };

  function tryAdd(idx: number, dedupThreshold: number): boolean {
    const kp = candidates[idx];
    const ng = precomputed[idx];
    if (kept.length >= 3) return false;
    if (ng.normClaimLen === 0) return false;
    for (const existingBigrams of keptBigrams) {
      if (jaccard(ng.claimBigrams, existingBigrams) >= dedupThreshold) return false;
    }
    kept.push(kp);
    keptBigrams.push(ng.claimBigrams);
    return true;
  }

  // 级别 1：放宽 quote 校验（阈值 0.3）
  // PERF-31 修复：使用 getBlockTrigrams() 惰性获取 block trigrams
  const blockTrigramsL1 = getBlockTrigrams();
  if (blockTrigramsL1) {
    for (let i = 0; i < candidates.length; i++) {
      const ng = precomputed[i];
      if (ng.normClaimLen < MIN_CLAIM_LENGTH) continue;
      if (ng.normQuoteLen < MIN_QUOTE_LENGTH) continue;
      if (!claimQuoteRelevant(ng.normClaim, ng.normQuote)) continue;
      if (claimQuoteTooSimilar(ng.normClaim, ng.normQuote)) continue;
      if (ng.quoteTrigrams.size === 0) continue;
      let bestRatio = 0;
      for (const bt of blockTrigramsL1) {
        bestRatio = Math.max(bestRatio, containment(ng.quoteTrigrams, bt));
      }
      if (bestRatio >= 0.3) tryAdd(i, CLAIM_DEDUP_THRESHOLD);
    }
  }
  if (kept.length >= 1) return kept;

  // 级别 2：放宽 quote 校验（阈值 0.3）+ 放宽相似度检查（允许 claim 复述 quote）
  // BUG-02 fix: Level 2 now actually relaxes the claimQuoteTooSimilar check
  // that level 1 applies, making it behaviorally distinct from level 1.
  // PERF-31 修复：level 2 复用 level 1 已计算的 blockTrigrams 缓存
  const blockTrigramsL2 = getBlockTrigrams();
  if (blockTrigramsL2) {
    for (let i = 0; i < candidates.length; i++) {
      const ng = precomputed[i];
      if (ng.normClaimLen < MIN_CLAIM_LENGTH) continue;
      if (ng.normQuoteLen < MIN_QUOTE_LENGTH) continue;
      if (!claimQuoteRelevant(ng.normClaim, ng.normQuote)) continue;
      // NOTE: claimQuoteTooSimilar check is intentionally omitted here —
      // this level allows claims that closely paraphrase the quote.
      if (ng.quoteTrigrams.size === 0) continue;
      let bestRatio = 0;
      for (const bt of blockTrigramsL2) {
        bestRatio = Math.max(bestRatio, containment(ng.quoteTrigrams, bt));
      }
      if (bestRatio >= 0.3) tryAdd(i, CLAIM_DEDUP_THRESHOLD);
    }
  }
  if (kept.length >= 1) return kept;

  // 级别 3：放宽 claim 最小长度（降到 8），不检查 quote 校验
  for (let i = 0; i < candidates.length; i++) {
    const ng = precomputed[i];
    if (ng.normClaimLen < 8) continue;
    if (ng.normQuoteLen < MIN_QUOTE_LENGTH) continue;
    if (!claimQuoteRelevant(ng.normClaim, ng.normQuote)) continue;
    tryAdd(i, CLAIM_DEDUP_THRESHOLD);
  }
  if (kept.length >= 1) return kept;

  // 级别 4：放宽相关性检查（只要求 1 个 unigram 重叠）
  for (let i = 0; i < candidates.length; i++) {
    const ng = precomputed[i];
    if (ng.normClaimLen < 8) continue;
    let hasOverlap = false;
    for (const ug of ng.claimUnigrams) {
      if (ng.quoteUnigrams.has(ug)) { hasOverlap = true; break; }
    }
    if (hasOverlap) tryAdd(i, 0.8);
  }
  if (kept.length >= 1) return kept;

  // 级别 5：最后退路——返回 normClaim 最长的原始 key points（最多 2 个）
  // 复用 precomputed 的 normClaim 避免重复 normalize
  return precomputed
    .map((ng, i) => ({ kp: candidates[i]!, normLen: ng.normClaimLen }))
    .sort((a, b) => b.normLen - a.normLen)
    .slice(0, 2)
    .map((entry) => entry.kp);
}
