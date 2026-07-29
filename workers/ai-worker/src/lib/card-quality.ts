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

/**
 * 归一化文本：去除空白、转小写。
 */
function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/**
 * 生成 n-gram 集合。
 */
function ngramSet(s: string, n: number): Set<string> {
  const norm = normalize(s);
  if (norm.length < n) return new Set([norm]);
  const out = new Set<string>();
  for (let i = 0; i <= norm.length - n; i++) {
    out.add(norm.slice(i, i + n));
  }
  return out;
}

/**
 * Jaccard 相似度（0-1）。
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Containment ratio：query 中有多少比例的 ngram 出现在 target 中。
 * 适合检测 quote_text 是否是某个 block 的子串。
 */
function containment(queryNgrams: Set<string>, targetNgrams: Set<string>): number {
  if (queryNgrams.size === 0) return 0;
  let found = 0;
  for (const t of queryNgrams) if (targetNgrams.has(t)) found++;
  return found / queryNgrams.size;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const MIN_CLAIM_LENGTH = 12;
const CLAIM_DEDUP_THRESHOLD = 0.6;
const MIN_QUOTE_LENGTH = 10;
const QUOTE_CONTAINMENT_THRESHOLD = 0.5;
const CLAIM_QUOTE_SIMILARITY_THRESHOLD = 0.8;
const MAX_KEY_POINTS = 5;

/** 覆盖率阈值：清洗后有效 key_points / 原始 key_points 低于此值触发 coverage_too_low */
const COVERAGE_TOO_LOW_THRESHOLD = 0.5;

// ─── Detection helpers ─────────────────────────────────────────────────────

const VAGUE_CLAIM_PATTERNS = [
  /很重要[。]?$/,
  /很关键[。]?$/,
  /很核心[。]?$/,
  /很基础[。]?$/,
  /很常见[。]?$/,
  /是基础[。]?$/,
  /是关键[。]?$/,
  /是核心[。]?$/,
  /很重要的概念[。]?$/,
  /有重要影响[。]?$/,
  /有显著影响[。]?$/,
  /有很大影响[。]?$/,
  /重要组成部分[。]?$/,
  /关键组成部分[。]?$/,
  /广泛应用于[^，。]+[。]?$/,
  /是一种重要[^，。]*[。]?$/,
  /至关重要[。]?$/,
  /不可或缺[。]?$/,
  /扮演重要角色[。]?$/,
  /扮演关键角色[。]?$/,
  /提供了基础[。]?$/,
  /提供了支撑[。]?$/,
  /提供了保障[。]?$/,
  /具有重要意义的?$/,
  /具有重要价值的?$/,
  /具有重要作用[。]?$/,
  /是常见的方法[。]?$/,
  /是常见的做法[。]?$/,
  /是核心概念[。]?$/,
  /是核心机制[。]?$/,
  /起着重要作用[。]?$/,
  /起着关键作用[。]?$/,
  /是不可或缺的?[。]?$/,
  /有深远影响[。]?$/,
  /有深刻影响[。]?$/,
];

function isVagueClaim(claim: string): boolean {
  for (const pattern of VAGUE_CLAIM_PATTERNS) {
    if (pattern.test(claim)) return true;
  }
  return false;
}

function claimQuoteRelevant(claim: string, quoteText: string): boolean {
  const claimBigrams = ngramSet(claim, 2);
  const quoteBigrams = ngramSet(quoteText, 2);
  if (claimBigrams.size === 0 || quoteBigrams.size === 0) return true;
  for (const bg of claimBigrams) {
    if (quoteBigrams.has(bg)) return true;
  }
  return false;
}

function claimQuoteTooSimilar(claim: string, quoteText: string): boolean {
  const normQuote = normalize(quoteText);
  if (normQuote.length < 30) return false;
  const claimBigrams = ngramSet(claim, 2);
  const quoteBigrams = ngramSet(quoteText, 2);
  if (claimBigrams.size === 0 || quoteBigrams.size === 0) return false;
  const claimInQuoteRatio = containment(claimBigrams, quoteBigrams);
  return claimInQuoteRatio >= CLAIM_QUOTE_SIMILARITY_THRESHOLD;
}

function quoteExistsInSource(quoteText: string, sourceBlocks: string[]): boolean {
  const normQuote = normalize(quoteText);
  if (normQuote.length === 0) return false;
  for (const block of sourceBlocks) {
    const normBlock = normalize(block);
    if (normBlock.includes(normQuote)) return true;
  }
  const quoteTrigrams = ngramSet(quoteText, 3);
  if (quoteTrigrams.size === 0) return false;
  for (const block of sourceBlocks) {
    const blockTrigrams = ngramSet(block, 3);
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

  const seen = new Set<string>();
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

    if (isVagueClaim(kp.claim)) {
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

    if (sourceBlocks && sourceBlocks.length > 0) {
      if (!quoteExistsInSource(kp.quote_text, sourceBlocks)) {
        issues.push({
          code: CardRepairReasonCode.QUOTE_NOT_IN_SOURCE,
          severity: "hard",
          keyPointOrdinal: kp.ordinal,
        });
        continue;
      }
    }

    if (!claimQuoteRelevant(kp.claim, kp.quote_text)) {
      issues.push({
        code: CardRepairReasonCode.CLAIM_QUOTE_UNRELATED,
        severity: "hard",
        keyPointOrdinal: kp.ordinal,
      });
      continue;
    }

    if (claimQuoteTooSimilar(kp.claim, kp.quote_text)) {
      issues.push({
        code: CardRepairReasonCode.CLAIM_QUOTE_TOO_SIMILAR,
        severity: "soft",
        keyPointOrdinal: kp.ordinal,
      });
      continue;
    }

    const claimBigrams = ngramSet(kp.claim, 2);
    let isDuplicate = false;
    for (const seenNgram of seen) {
      if (jaccard(claimBigrams, ngramSet(seenNgram, 2)) >= CLAIM_DEDUP_THRESHOLD) {
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

    seen.add(kp.claim);
    deduped.push(kp);
    if (deduped.length >= MAX_KEY_POINTS) break;
  }

  // 检测覆盖率是否过低
  const validCount = deduped.length;
  if (originalCount > 0 && validCount / originalCount < COVERAGE_TOO_LOW_THRESHOLD) {
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
  const keptClaims = new Set<string>();

  function tryAdd(kp: LearningCardOutput["key_points"][number], dedupThreshold: number): boolean {
    if (kept.length >= 3) return false;
    const normClaim = normalize(kp.claim);
    if (normClaim.length === 0) return false;
    const claimBigrams = ngramSet(kp.claim, 2);
    for (const seen of keptClaims) {
      if (jaccard(claimBigrams, ngramSet(seen, 2)) >= dedupThreshold) return false;
    }
    kept.push(kp);
    keptClaims.add(kp.claim);
    return true;
  }

  // 级别 1：放宽 quote 校验（阈值 0.3）
  if (sourceBlocks && sourceBlocks.length > 0) {
    for (const kp of candidates) {
      if (normalize(kp.claim).length < MIN_CLAIM_LENGTH) continue;
      if (normalize(kp.quote_text).length < MIN_QUOTE_LENGTH) continue;
      if (!claimQuoteRelevant(kp.claim, kp.quote_text)) continue;
      if (claimQuoteTooSimilar(kp.claim, kp.quote_text)) continue;
      const quoteTrigrams = ngramSet(kp.quote_text, 3);
      if (quoteTrigrams.size === 0) continue;
      let bestRatio = 0;
      for (const block of sourceBlocks) {
        const blockTrigrams = ngramSet(block, 3);
        bestRatio = Math.max(bestRatio, containment(quoteTrigrams, blockTrigrams));
      }
      if (bestRatio >= 0.3) tryAdd(kp, CLAIM_DEDUP_THRESHOLD);
    }
  }
  if (kept.length >= 1) return kept;

  // 级别 2：放宽 quote 校验（阈值 0.3）+ 放宽相似度检查
  if (sourceBlocks && sourceBlocks.length > 0) {
    for (const kp of candidates) {
      if (normalize(kp.claim).length < MIN_CLAIM_LENGTH) continue;
      if (normalize(kp.quote_text).length < MIN_QUOTE_LENGTH) continue;
      if (!claimQuoteRelevant(kp.claim, kp.quote_text)) continue;
      const quoteTrigrams = ngramSet(kp.quote_text, 3);
      if (quoteTrigrams.size === 0) continue;
      let bestRatio = 0;
      for (const block of sourceBlocks) {
        const blockTrigrams = ngramSet(block, 3);
        bestRatio = Math.max(bestRatio, containment(quoteTrigrams, blockTrigrams));
      }
      if (bestRatio >= 0.3) tryAdd(kp, CLAIM_DEDUP_THRESHOLD);
    }
  }
  if (kept.length >= 1) return kept;

  // 级别 3：放宽 claim 最小长度（降到 8），不检查 quote 校验
  for (const kp of candidates) {
    if (normalize(kp.claim).length < 8) continue;
    if (normalize(kp.quote_text).length < MIN_QUOTE_LENGTH) continue;
    if (!claimQuoteRelevant(kp.claim, kp.quote_text)) continue;
    tryAdd(kp, CLAIM_DEDUP_THRESHOLD);
  }
  if (kept.length >= 1) return kept;

  // 级别 4：放宽相关性检查（只要求 1 个 unigram 重叠）
  for (const kp of candidates) {
    if (normalize(kp.claim).length < 8) continue;
    const claimUnigrams = ngramSet(kp.claim, 1);
    const quoteUnigrams = ngramSet(kp.quote_text, 1);
    let hasOverlap = false;
    for (const ug of claimUnigrams) {
      if (quoteUnigrams.has(ug)) { hasOverlap = true; break; }
    }
    if (hasOverlap) tryAdd(kp, 0.8);
  }
  if (kept.length >= 1) return kept;

  // 级别 5：最后退路——返回 claim 最长的原始 key points（最多 2 个）
  return candidates
    .sort((a, b) => normalize(b.claim).length - normalize(a.claim).length)
    .slice(0, 2);
}
