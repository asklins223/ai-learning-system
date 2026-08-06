/**
 * Shared text normalization and n-gram similarity utilities.
 *
 * This module provides a single canonical normalize function and n-gram based
 * similarity functions (Jaccard, containment) used across:
 * - card-quality.ts (card output quality assessment)
 * - align.ts (evidence alignment)
 *
 * BUG-07 / QUAL-04 / QUAL-15 fix: Previously, separate `normalize`
 * functions existed with inconsistent behavior. This module unifies them
 * with NFKC normalization to handle full-width/half-width character mixing
 * consistently.
 */

/**
 * Canonical text normalization for n-gram matching.
 *
 * Applies:
 * 1. NFKC Unicode normalization (unifies full-width/half-width variants)
 * 2. Lowercasing (locale-independent)
 * 3. Whitespace removal
 *
 * Note: Punctuation is NOT removed here because quote alignment (align.ts)
 * needs to preserve punctuation for positional accuracy. Callers that need
 * punctuation-stripped normalization (e.g. claim hashing) should apply
 * additional stripping on top of this function.
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/\s+/g, "");
}

/**
 * Generate the set of n-grams from a string.
 * If the normalized string is shorter than n, returns a set containing
 * the entire normalized string as its only element.
 */
export function ngramSet(s: string, n: number): Set<string> {
  const norm = normalizeText(s);
  if (norm.length < n) return new Set([norm]);
  const out = new Set<string>();
  for (let i = 0; i <= norm.length - n; i++) {
    out.add(norm.slice(i, i + n));
  }
  return out;
}

/**
 * Jaccard similarity coefficient (0–1) between two sets.
 * Returns 0 if either set is empty.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Containment ratio: what fraction of `query` n-grams appear in `target`.
 * Unlike Jaccard, this is asymmetric and measures "how much of the query
 * is inside the target" — more robust when target is much larger than query.
 */
export function containment(queryNgrams: Set<string>, targetNgrams: Set<string>): number {
  if (queryNgrams.size === 0) return 0;
  let found = 0;
  for (const t of queryNgrams) if (targetNgrams.has(t)) found++;
  return found / queryNgrams.size;
}
