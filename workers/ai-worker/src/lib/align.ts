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

export function alignQuote(quote: string, blocks: AlignmentCandidate[]): AlignmentResult {
  if (!quote.trim() || blocks.length === 0) return { best: null, candidates: [] };
  const normQuote = normalize(quote);
  const triQuote = trigrams(quote);
  const candidates: AlignmentResult["candidates"] = [];
  for (const b of blocks) {
    const normText = normalize(b.text);
    const scoreExact = normText.includes(normQuote) ? 100 : 0;
    let scoreFuzzy = 0;
    if (scoreExact < 100) {
      const window = Math.min(b.text.length, Math.max(80, quote.length * 2));
      // 步进采样：长文用更大步长降低计算量，但不再硬截断前 50 个偏移。
      // 步长 = window/8，至少 1，保证覆盖整段 block 而不漏掉后半部分。
      const step = Math.max(1, Math.floor(window / 8));
      let best = 0;
      for (let i = 0; i < b.text.length - 1; i += step) {
        const slice = b.text.slice(i, i + window);
        if (slice.length < quote.length * 0.5) break;
        const j = jaccard(triQuote, trigrams(slice));
        if (j > best) best = j;
      }
      scoreFuzzy = Math.round(best * 100);
    }
    if (scoreExact === 100) candidates.push({ blockId: b.blockId, blockOrdinal: b.blockOrdinal, score: 100, method: "exact" });
    else if (scoreFuzzy >= 40) candidates.push({ blockId: b.blockId, blockOrdinal: b.blockOrdinal, score: scoreFuzzy, method: "fuzzy" });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { best: candidates[0] ?? null, candidates: candidates.slice(0, 5) };
}
