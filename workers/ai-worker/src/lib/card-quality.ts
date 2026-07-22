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
 * 本模块提供轻量级的后处理函数，在 handler 持久化之前对输出进行清洗。
 * 所有函数都是纯函数，不依赖外部状态。
 */

import type { LearningCardOutput } from "@ailearn/shared";

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

/**
 * 最小 claim 长度（归一化后）。低于此值的 claim 视为话题标签，不是知识断言。
 * 从 8 提升到 12：8 个归一化字符约 4 个汉字，仍可能是话题标签。
 * 12 个归一化字符约 6 个汉字，更可靠地过滤短标签。
 */
const MIN_CLAIM_LENGTH = 12;

/**
 * claim 去重阈值。两个 claim 的 Jaccard 相似度超过此值时，保留第一个。
 */
const CLAIM_DEDUP_THRESHOLD = 0.6;

/**
 * quote_text 最小长度（归一化后）。低于此值的引用太短，无法支撑 claim。
 */
const MIN_QUOTE_LENGTH = 10;

/**
 * quote_text 与原文的最低 containment 阈值。
 * 低于此值说明 quote_text 很可能是模型伪造或大幅改写的。
 *
 * 0.5：模型（尤其 qwen-plus）在提取原文时经常有轻微改写（标点、连接词、语序微调），
 * 要求 60% trigram 精确匹配过于严格，导致大量本应保留的 key points 被过滤，
 * fallback 频繁触发，输出质量反而下降。0.5 容忍轻微改写同时仍能拦截
 * 跨 block 拼接和大面积编造。
 */
const QUOTE_CONTAINMENT_THRESHOLD = 0.5;

/**
 * claim 与 quote_text 的最高相似度阈值。
 * 超过此值说明 claim 只是 quote_text 的复述/压缩版，不是抽象提炼。
 *
 * 0.8：使用 bigram containment（包容率）。理想情况下 claim 应该用不同措辞
 * 来表述知识点（像老师用自己的话讲解），但模型在提炼时不可避免地会
 * 复用一些领域术语（如"一致性"、"缓存"、"索引"等专有名词）。
 * 0.8 允许一定比例的术语复用（最多 20% 的 claim bigram 来自 quote），
 * 但能有效拦截 claim 几乎逐字复制 quote_text 的情况（containment > 0.8）。
 */
const CLAIM_QUOTE_SIMILARITY_THRESHOLD = 0.8;

/**
 * claim 与 quote_text 的最低相似度阈值。
 * 低于此值说明 claim 和 quote_text 在用词上完全不同，引用很可能选错了。
 *
 * 与 claimQuoteRelevant 的 bigram 重叠检查互补：
 * - claimQuoteRelevant 检查是否有至少 1 个 bigram 重叠（非常宽松）
 * - 此阈值在 fallback 场景中使用，确保最低限度的相关性
 */

/**
 * key_points 最大保留数量。与 prompt 中的"最多输出 5 个"一致。
 */
const MAX_KEY_POINTS = 5;

/**
 * 模糊评价型 claim 的检测模式。这些模式通常不可验证。
 * 覆盖常见模糊表达：「很重要」「很关键」「有重要影响」「是重要组成部分」
 * 「扮演重要角色」「提供了基础」「具有重要作用」等。
 */
const VAGUE_CLAIM_PATTERNS = [
  // 「X 很重要 / 很关键 / 很核心 / 很基础 / 很常见」
  /很重要[。]?$/,
  /很关键[。]?$/,
  /很核心[。]?$/,
  /很基础[。]?$/,
  /很常见[。]?$/,
  // 「X 是基础 / 是关键 / 是核心」
  /是基础[。]?$/,
  /是关键[。]?$/,
  /是核心[。]?$/,
  /很重要的概念[。]?$/,
  // 「X 有重要影响 / 有显著影响 / 有很大影响」
  /有重要影响[。]?$/,
  /有显著影响[。]?$/,
  /有很大影响[。]?$/,
  // 「X 是 ... 的重要组成部分 / 关键组成部分」
  /重要组成部分[。]?$/,
  /关键组成部分[。]?$/,
  // 「X 广泛应用于 Y」（缺乏具体原理说明）
  /广泛应用于[^，。]+[。]?$/,
  // 「X 是一种重要的 Y」（泛化描述，无可验证论断）
  /是一种重要[^，。]*[。]?$/,
  // 「X 对 Y 至关重要 / 不可或缺」
  /至关重要[。]?$/,
  /不可或缺[。]?$/,
  // v6 新增：更多常见模糊表达
  // 「X 扮演重要角色 / 扮演关键角色」
  /扮演重要角色[。]?$/,
  /扮演关键角色[。]?$/,
  // 「X 提供了基础 / 提供了支撑 / 提供了保障」
  /提供了基础[。]?$/,
  /提供了支撑[。]?$/,
  /提供了保障[。]?$/,
  // 「X 具有重要意义 / 具有重要价值 / 具有重要作用」
  /具有重要意义的?$/,
  /具有重要价值的?$/,
  /具有重要作用[。]?$/,
  // 「X 是常见的方法 / 是常见的做法」（泛化，无具体原理）
  /是常见的方法[。]?$/,
  /是常见的做法[。]?$/,
  // 「X 是核心概念 / 是核心机制」（仅贴标签，无原理说明）
  /是核心概念[。]?$/,
  /是核心机制[。]?$/,
  // 「X 起着重要作用 / 起着关键作用」
  /起着重要作用[。]?$/,
  /起着关键作用[。]?$/,
  // 「X 是不可或缺的」
  /是不可或缺的?[。]?$/,
  // 「X 对 Y 有深远影响 / 有深刻影响」
  /有深远影响[。]?$/,
  /有深刻影响[。]?$/,
];

/**
 * 检测 claim 是否是模糊评价而非可验证的断言。
 */
function isVagueClaim(claim: string): boolean {
  // 检查模糊评价模式
  for (const pattern of VAGUE_CLAIM_PATTERNS) {
    if (pattern.test(claim)) return true;
  }
  return false;
}

/**
 * 检测 claim 与 quote_text 是否有最低限度的相关性。
 *
 * 使用 bigram（2-gram）重叠检查：如果 claim 和 quote_text 没有任何
 * bigram 重叠，说明它们在用词上完全不同，引用很可能选错了。
 *
 * 阈值为 0 个重叠 bigram（即至少要有 1 个重叠），非常宽松。
 * 这只拦截完全无关的 claim-quote 对，不会误伤合法的抽象 claim。
 */
function claimQuoteRelevant(claim: string, quoteText: string): boolean {
  const claimBigrams = ngramSet(claim, 2);
  const quoteBigrams = ngramSet(quoteText, 2);
  if (claimBigrams.size === 0 || quoteBigrams.size === 0) return true;

  for (const bg of claimBigrams) {
    if (quoteBigrams.has(bg)) return true;
  }
  return false;
}

/**
 * 检测 claim 是否过于相似于 quote_text——即 claim 只是原文的复述/压缩版，
 * 而非抽象提炼。
 *
 * 使用 bigram containment（包容率）：测量 claim 的 bigram 中有多大比例
 * 出现在 quote_text 中。如果大部分 claim 的 bigram 都能在 quote_text 中找到，
 * 说明 claim 大量复用了原文措辞，没有真正用自己的语言重新表述知识点。
 *
 * 之所以用 containment 而非 Jaccard：当 quote_text 比 claim 长很多时
 * （常见场景），Jaccard 会被 quote_text 的额外 bigram 稀释，导致即使是
 * claim 完全包含在 quote_text 中的情况也无法检测。Containment 只关注
 * claim 的 bigram 有多少来自 quote_text，不受 quote_text 长度影响。
 *
 * 例外处理：当 quote_text 很短（< 30 归一化字符）时跳过此检查，因为短引用
 * 本身的 bigram 数量有限，容易产生高 containment 值，但这种情况不代表 claim
 * 是复述。
 */
function claimQuoteTooSimilar(claim: string, quoteText: string): boolean {
  const normQuote = normalize(quoteText);
  // 短引用不做相似度检查（bigram 集合太小，容易误判）
  if (normQuote.length < 30) return false;

  const claimBigrams = ngramSet(claim, 2);
  const quoteBigrams = ngramSet(quoteText, 2);
  if (claimBigrams.size === 0 || quoteBigrams.size === 0) return false;

  const claimInQuoteRatio = containment(claimBigrams, quoteBigrams);
  return claimInQuoteRatio >= CLAIM_QUOTE_SIMILARITY_THRESHOLD;
}

/**
 * 检测 quote_text 是否在原文 blocks 中存在（允许模糊匹配）。
 *
 * 使用 containment ratio（包容率）而非精确匹配：
 * - 精确匹配：quote 归一化后是某个 block 归一化后的子串
 * - 模糊匹配：quote 的 trigram 有 >= QUOTE_CONTAINMENT_THRESHOLD 比例出现在某个 block 中
 *
 * @param quoteText - 模型输出的引用文本
 * @param sourceBlocks - 原文 blocks 的内容数组
 * @returns 是否找到匹配的原文
 */
function quoteExistsInSource(
  quoteText: string,
  sourceBlocks: string[],
): boolean {
  const normQuote = normalize(quoteText);
  if (normQuote.length === 0) return false;

  // 快速路径：精确子串匹配
  for (const block of sourceBlocks) {
    const normBlock = normalize(block);
    if (normBlock.includes(normQuote)) return true;
  }

  // 模糊路径：基于 trigram containment
  const quoteTrigrams = ngramSet(quoteText, 3);
  if (quoteTrigrams.size === 0) return false;

  for (const block of sourceBlocks) {
    const blockTrigrams = ngramSet(block, 3);
    const ratio = containment(quoteTrigrams, blockTrigrams);
    if (ratio >= QUOTE_CONTAINMENT_THRESHOLD) return true;
  }

  return false;
}

/**
 * 对 AI 输出的学习卡进行后处理清洗。
 *
 * 步骤：
 * 1. 过滤 claim 过短的 key point（只是话题标签）
 * 2. 过滤 claim 是模糊评价的 key point（如"X 很重要"）
 * 3. 过滤 quote_text 过短的 key point
 * 4. 如果传入了 sourceBlocks，验证 quote_text 是否在原文中存在，丢弃伪造引用
 * 5. 检测 claim 与 quote_text 的相关性，丢弃引用与论断完全无关的 key point
 * 6. 检测 claim 是否过于相似于 quote_text（只是原文复述而非抽象提炼），丢弃复述型 claim
 * 7. 去除语义重复的 key point（claim 之间 Jaccard 相似度过高）
 * 8. 截断到 MAX_KEY_POINTS 个（保留前 N 个，模型应已按重要性排序）
 * 9. 重新编号 ordinal（确保连续从 0 开始）
 *
 * 如果清洗后 key_points 为空，尝试从原始输出中挑选「最不差」的 1-2 个保留
 * （优先保留 claim 长度达标的），避免完全空卡。如果实在没有可用的，返回原始输出。
 *
 * @param output - AI 模型输出的学习卡
 * @param sourceBlocks - 可选，原文 blocks 的内容数组。传入时会验证 quote_text 是否在原文中存在。
 */
export function sanitizeCardOutput(
  output: LearningCardOutput,
  sourceBlocks?: string[],
): LearningCardOutput {
  const seen = new Set<string>();
  const deduped: LearningCardOutput["key_points"] = [];

  for (const kp of output.key_points) {
    const normClaim = normalize(kp.claim);
    const normQuote = normalize(kp.quote_text);

    // 跳过过短的 claim（通常是话题标签）
    if (normClaim.length < MIN_CLAIM_LENGTH) continue;

    // 跳过模糊评价型 claim
    if (isVagueClaim(kp.claim)) continue;

    // 跳过过短的 quote_text（太短的引用无法支撑 claim）
    if (normQuote.length < MIN_QUOTE_LENGTH) continue;

    // 如果有原文 blocks，验证 quote_text 是否在原文中存在
    if (sourceBlocks && sourceBlocks.length > 0) {
      if (!quoteExistsInSource(kp.quote_text, sourceBlocks)) continue;
    }

    // 检查 claim 与 quote_text 的相关性
    if (!claimQuoteRelevant(kp.claim, kp.quote_text)) continue;

    // v6: 检测 claim 是否过于相似于 quote_text（只是原文复述而非抽象提炼）
    if (claimQuoteTooSimilar(kp.claim, kp.quote_text)) continue;

    // 检查与已保留 claim 的相似度
    const claimBigrams = ngramSet(kp.claim, 2);
    let isDuplicate = false;
    for (const seenNgram of seen) {
      if (jaccard(claimBigrams, ngramSet(seenNgram, 2)) >= CLAIM_DEDUP_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }

    if (isDuplicate) continue;

    seen.add(kp.claim);
    deduped.push(kp);

    // 达到最大数量后停止
    if (deduped.length >= MAX_KEY_POINTS) break;
  }

  // 如果清洗后为空，尝试渐进放宽过滤条件，避免完全空卡或返回低质量原始输出。
  // 逐级放宽：先放宽 quote 校验 → 再放宽 claim 长度 → 最后放宽相关性检查。
  // 每一级都在之前保留的结果上继续补充，目标保留 1-3 个 key points。
  if (deduped.length === 0) {
    const fallbackKps = progressiveFallback(output, sourceBlocks);
    const renumberedFallback = fallbackKps.map((kp, idx) => ({
      ...kp,
      ordinal: idx,
    }));
    return {
      ...output,
      key_points: renumberedFallback,
    };
  }

  // 重新编号 ordinal
  const renumbered = deduped.map((kp, idx) => ({
    ...kp,
    ordinal: idx,
  }));

  return {
    ...output,
    key_points: renumbered,
  };
}

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

  // 级别 1：放宽 quote 校验（阈值 0.3），保留 claim 长度达标、quote 不太离谱、
  // 且 claim 不是 quote 的复述（claimQuoteTooSimilar 不触发）的 key points
  if (sourceBlocks && sourceBlocks.length > 0) {
    for (const kp of candidates) {
      if (normalize(kp.claim).length < MIN_CLAIM_LENGTH) continue;
      if (normalize(kp.quote_text).length < MIN_QUOTE_LENGTH) continue;
      if (!claimQuoteRelevant(kp.claim, kp.quote_text)) continue;
      if (claimQuoteTooSimilar(kp.claim, kp.quote_text)) continue;
      // 用更宽松的 containment 检查
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

  // 级别 2：放宽 quote 校验（阈值 0.3）+ 放宽相似度检查（允许 claim 复述 quote）
  // 当所有 claim 都是原文复述时，这是必要的退路
  if (sourceBlocks && sourceBlocks.length > 0) {
    for (const kp of candidates) {
      if (normalize(kp.claim).length < MIN_CLAIM_LENGTH) continue;
      if (normalize(kp.quote_text).length < MIN_QUOTE_LENGTH) continue;
      if (!claimQuoteRelevant(kp.claim, kp.quote_text)) continue;
      // 不再检查 claimQuoteTooSimilar — 允许复述型 claim 作为退路
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
