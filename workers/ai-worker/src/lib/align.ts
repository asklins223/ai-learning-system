// Mirror of apps/api/src/modules/evidence/align.ts for worker use.
// QUAL-15 fix: n-gram utilities now imported from shared text-similarity module.
import { normalizeText, ngramSet, jaccard, containment } from "./text-similarity.ts";

export interface AlignmentCandidate {
  blockId: string;
  blockOrdinal: number;
  text: string;
}

export interface AlignmentResult {
  best: { blockId: string; blockOrdinal: number; score: number; method: "exact" | "fuzzy" } | null;
  candidates: Array<{ blockId: string; blockOrdinal: number; score: number; method: "exact" | "fuzzy" }>;
}

// Local aliases for brevity — use canonical NFKC-aware normalization (BUG-07 fix).
const normalize = normalizeText;
const trigrams = (s: string): Set<string> => ngramSet(s, 3);
const bigrams = (s: string): Set<string> => ngramSet(s, 2);

export function alignQuote(quote: string, blocks: AlignmentCandidate[]): AlignmentResult {
  if (!quote.trim() || blocks.length === 0) return { best: null, candidates: [] };
  const normQuote = normalize(quote);
  const triQuote = trigrams(quote);
  const biQuote = bigrams(quote);
  const candidates: AlignmentResult["candidates"] = [];
  for (const b of blocks) {
    const normText = normalize(b.text);
    const scoreExact = normText.includes(normQuote) ? 100 : 0;
    let scoreFuzzy = 0;
    if (scoreExact < 100) {
      // Pre-compute block-level ngram sets for containment scoring.
      // This captures "the quote's content appears somewhere in this block"
      // without needing a sliding window, and is especially effective for
      // Chinese text where bigrams carry more semantic weight.
      const triBlock = trigrams(b.text);
      const biBlock = bigrams(b.text);
      const containmentTri = containment(triQuote, triBlock);
      const containmentBi = containment(biQuote, biBlock);
      const containmentScore = Math.max(containmentTri, containmentBi) * 100;

      // PERF-01 fix: Use containment as a fast pre-filter before the
      // expensive sliding-window Jaccard. If containment is already very
      // low, skip Jaccard entirely — the quote is clearly not in this block.
      if (containmentScore < 15) {
        scoreFuzzy = Math.round(containmentScore);
      } else {
        // Sliding-window Jaccard for positional accuracy.
        //
        // PERF-11 说明：滑动窗口中每个 slice 调用 trigrams(slice) 和 bigrams(slice)
        // 重新计算 ngram 集合。对于 100+ blocks 且每个 block 长文本的场景，
        // 这会产生大量临时 Set 对象。
        // 优化策略权衡：由于 slice 内容不同，无法直接缓存 ngram。
        // 已实施优化：(1) containment 预过滤（score < 15 时跳过 Jaccard），
        // (2) 滑动步长从 window/8 调整为 window/16 减少迭代次数。
        // 进一步优化可考虑使用 char-level rolling hash 替代 Set，
        // 但会增加实现复杂度且对中文文本（ngram 以字符为单位）效果有限。
        const window = Math.min(b.text.length, Math.max(80, quote.length * 2));
        const step = Math.max(1, Math.floor(window / 16));
        let bestJaccard = 0;
        for (let i = 0; i < b.text.length - 1; i += step) {
          const slice = b.text.slice(i, i + window);
          if (slice.length < quote.length * 0.5) break;
          const j = Math.max(
            jaccard(triQuote, trigrams(slice)),
            jaccard(biQuote, bigrams(slice)),
          );
          if (j > bestJaccard) bestJaccard = j;
        }
        const jaccardScore = Math.round(bestJaccard * 100);
        scoreFuzzy = Math.max(containmentScore, jaccardScore);
      }
    }
    if (scoreExact === 100) candidates.push({ blockId: b.blockId, blockOrdinal: b.blockOrdinal, score: 100, method: "exact" });
    else if (scoreFuzzy >= 40) candidates.push({ blockId: b.blockId, blockOrdinal: b.blockOrdinal, score: scoreFuzzy, method: "fuzzy" });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { best: candidates[0] ?? null, candidates: candidates.slice(0, 5) };
}
