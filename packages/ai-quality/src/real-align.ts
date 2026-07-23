/**
 * AIQ-01 RC 门禁真实证据对齐函数
 *
 * 这是 ai-worker `alignQuote` 的同构实现，用于 RC 门禁中真实 Provider
 * 输出的证据对齐。与 `mockAlignEvidence` 的区别：
 *
 * - mockAlignEvidence 使用简单 `includes` 检查，只适合 Mock 输出（quote
 *   直接取自期望块，必然精确匹配）
 * - realAlignEvidence 使用 trigram Jaccard 相似度 + 滑动窗口，能处理
 *   真实模型输出中的轻微措辞差异
 *
 * 算法与 `workers/ai-worker/src/lib/align.ts` 中的 `alignQuote` 完全一致，
 * 保持同构以避免 RC 门禁和生产 Worker 评分不一致。
 *
 * 不直接导入 ai-worker 包是为了避免 ai-quality 对 worker 的硬依赖；
 * ai-quality 是质量门禁包，应保持独立可测。
 */

import { getDatasetSample } from "./dataset.ts";
import type { AlignmentResult, ModelCardOutput } from "./types.ts";

// ─── 内部工具函数（与 align.ts 同构）───────────────────────────────

function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

function trigrams(s: string): Set<string> {
  const n = normalize(s);
  if (n.length < 3) return new Set([n]);
  const out = new Set<string>();
  for (let i = 0; i <= n.length - 3; i++) out.add(n.slice(i, i + 3));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 对单个 quote 在候选块中执行对齐。
 *
 * 返回 score (0-100) 和 method (exact/fuzzy)。
 * 与 alignQuote 的打分逻辑完全一致。
 */
function alignSingle(
  quote: string,
  blocks: Array<{ ordinal: number; text: string }>,
): { score: number; method: "exact" | "fuzzy"; blockOrdinal: number | null } {
  if (!quote.trim() || blocks.length === 0) {
    return { score: 0, method: "fuzzy", blockOrdinal: null };
  }

  const normQuote = normalize(quote);
  const triQuote = trigrams(quote);

  let bestScore = 0;
  let bestMethod: "exact" | "fuzzy" = "fuzzy";
  let bestOrdinal: number | null = null;

  for (const b of blocks) {
    const normText = normalize(b.text);
    const scoreExact = normText.includes(normQuote) ? 100 : 0;

    if (scoreExact === 100) {
      return { score: 100, method: "exact", blockOrdinal: b.ordinal };
    }

    // Fuzzy: sliding window trigram Jaccard
    let scoreFuzzy = 0;
    const window = Math.min(b.text.length, Math.max(80, quote.length * 2));
    const step = Math.max(1, Math.floor(window / 8));
    for (let i = 0; i < b.text.length - 1; i += step) {
      const slice = b.text.slice(i, i + window);
      if (slice.length < quote.length * 0.5) break;
      const j = jaccard(triQuote, trigrams(slice));
      if (j > scoreFuzzy) scoreFuzzy = j;
    }
    scoreFuzzy = Math.round(scoreFuzzy * 100);

    if (scoreFuzzy >= 40 && scoreFuzzy > bestScore) {
      bestScore = scoreFuzzy;
      bestMethod = "fuzzy";
      bestOrdinal = b.ordinal;
    }
  }

  if (bestScore === 0) {
    return { score: 0, method: "fuzzy", blockOrdinal: null };
  }

  return { score: bestScore, method: bestMethod, blockOrdinal: bestOrdinal };
}

/**
 * 真实证据对齐函数。
 *
 * 查找 noteFile 对应的数据集样本，对模型输出的每个 key_point 的 quote_text
 * 执行 trigram 对齐，返回 ai-quality AlignmentResult[] 格式。
 *
 * 对齐阈值与 mockAlignEvidence 一致：
 * - score >= 85 → aligned
 * - score >= 60 → soft
 * - score < 60  → unaligned
 *
 * @param noteFile - 样本 file key
 * @param modelOutput - 真实 Provider 生成的学习卡输出
 * @returns 每个 key point 的对齐结果
 */
export function realAlignEvidence(
  noteFile: string,
  modelOutput: ModelCardOutput,
): AlignmentResult[] {
  const sample = getDatasetSample(noteFile);
  if (!sample) {
    throw new Error(`样本 ${noteFile} 不存在于数据集中`);
  }

  const blocks = sample.blocks.map((b, i) => ({
    ordinal: i,
    text: b.content,
  }));

  return modelOutput.key_points.map((kp) => {
    const { score, method, blockOrdinal } = alignSingle(kp.quote_text, blocks);

    const alignment =
      score >= 85 ? "aligned" : score >= 60 ? "soft" : "unaligned";

    return {
      ordinal: kp.ordinal,
      alignment,
      alignmentScore: score,
      alignmentMethod: method,
      blockOrdinal,
    };
  });
}
