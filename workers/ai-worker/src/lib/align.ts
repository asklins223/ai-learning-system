// Mirror of apps/api/src/modules/evidence/align.ts for worker use.
export interface AlignmentCandidate {
  blockId: string;
  blockOrdinal: number;
  text: string;
}

export interface AlignmentResult {
  best: { blockId: string; blockOrdinal: number; score: number; method: "exact" | "fuzzy" } | null;
  candidates: Array<{ blockId: string; blockOrdinal: number; score: number; method: "exact" | "fuzzy" }>;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

function ngrams(s: string, n: number): Set<string> {
  const normalized = normalize(s);
  if (normalized.length < n) return new Set([normalized]);
  const out = new Set<string>();
  for (let i = 0; i <= normalized.length - n; i++) {
    out.add(normalized.slice(i, i + n));
  }
  return out;
}

function trigrams(s: string): Set<string> {
  return ngrams(s, 3);
}

function bigrams(s: string): Set<string> {
  return ngrams(s, 2);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Containment ratio: what fraction of `query` ngrams appear in `target`.
 * Unlike Jaccard, this measures "how much of the quote is inside the block"
 * rather than "how similar the two texts are". This is more robust when the
 * block is much longer than the quote.
 */
function containment(queryNgrams: Set<string>, targetNgrams: Set<string>): number {
  if (queryNgrams.size === 0) return 0;
  let found = 0;
  for (const t of queryNgrams) if (targetNgrams.has(t)) found++;
  return found / queryNgrams.size;
}

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

      // Sliding-window Jaccard for positional accuracy.
      const window = Math.min(b.text.length, Math.max(80, quote.length * 2));
      // Reduced step from window/8 to window/16 for finer sampling coverage.
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

      // Take the max of containment and Jaccard: containment is better when
      // the block is long and the quote is a subset; Jaccard is better when
      // the texts are similar in length but slightly reordered.
      scoreFuzzy = Math.max(containmentScore, jaccardScore);
    }
    if (scoreExact === 100) candidates.push({ blockId: b.blockId, blockOrdinal: b.blockOrdinal, score: 100, method: "exact" });
    else if (scoreFuzzy >= 40) candidates.push({ blockId: b.blockId, blockOrdinal: b.blockOrdinal, score: scoreFuzzy, method: "fuzzy" });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { best: candidates[0] ?? null, candidates: candidates.slice(0, 5) };
}
