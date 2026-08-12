/**
 * Bubble content model (01 §6): display priority, sentence/segment splitting,
 * auto-dismiss timing, long-content and URL handling. Pure functions, no DOM.
 */

// ─── 1. Display priority (01 §6.1) ───────────────────────────────────────

export type BubbleSourceV1 =
  | "voice_error"
  | "user_turn"
  | "confirmation"
  | "task_result"
  | "proactive"
  | "ambient";

const BUBBLE_PRIORITY_ORDER: readonly BubbleSourceV1[] = [
  "voice_error",
  "user_turn",
  "confirmation",
  "task_result",
  "proactive",
  "ambient",
];

export function bubblePriority(source: BubbleSourceV1): number {
  return BUBBLE_PRIORITY_ORDER.indexOf(source);
}

export function canOverrideBubble(
  incoming: BubbleSourceV1,
  current: BubbleSourceV1 | null,
): boolean {
  if (current === null) return true;
  return bubblePriority(incoming) < bubblePriority(current);
}

// ─── 2. Sentence splitting (01 §6.2) ─────────────────────────────────────

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
// Chinese full-width punctuation breaks immediately; Latin punctuation only
// breaks before whitespace/end so abbreviations survive via buffer merge.
const SENTENCE_BREAK = /(?<=[。！？；])|(?<=[.!?;])(?=\s|$)|(?<=\n)/;
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e",
  "u.s", "u.k", "a.m", "p.m", "no", "fig",
]);

export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const parts = trimmed.split(SENTENCE_BREAK);
  const sentences: string[] = [];
  let buffer = "";
  for (const part of parts) {
    const candidate = buffer + part;
    const lastWord = candidate.match(/([A-Za-z]+(?:\.[A-Za-z]+)*)\.$/);
    if (lastWord && ABBREVIATIONS.has(lastWord[1].toLowerCase())) {
      buffer = candidate;
      continue;
    }
    sentences.push(candidate.trim());
    buffer = "";
  }
  if (buffer.trim().length > 0) sentences.push(buffer.trim());
  return sentences.filter((s) => s.length > 0);
}

export function isCjkText(text: string): boolean {
  return CJK_PATTERN.test(text);
}

const MAX_CJK_SEGMENT = 60;
const MAX_LATIN_SEGMENT = 140;
const MIN_CJK_SEGMENT = 18;
const MIN_LATIN_SEGMENT = 40;

/**
 * Greedy merge of sentences into display/TTS segments. Each segment stays
 * within the contract's length window; text is never rewritten.
 */
export function buildPreviewSegments(text: string): string[] {
  const sentences = splitSentences(text);
  const segments: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const combined = current.length === 0 ? sentence : `${current}${sentence}`;
    const max = isCjkText(combined) ? MAX_CJK_SEGMENT : MAX_LATIN_SEGMENT;
    if (combined.length <= max || current.length === 0) {
      current = combined;
      continue;
    }
    segments.push(current);
    current = sentence;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export function segmentLengthRange(text: string): { min: number; max: number } {
  return isCjkText(text)
    ? { min: MIN_CJK_SEGMENT, max: MAX_CJK_SEGMENT }
    : { min: MIN_LATIN_SEGMENT, max: MAX_LATIN_SEGMENT };
}

// ─── 3. Auto-dismiss timing (01 §6.3) ────────────────────────────────────

export type BubbleDismissKindV1 =
  | "turn"
  | "incoming"
  | "privacy_placeholder"
  | "never";

/**
 * Auto-dismiss duration in ms, or null when the bubble must not auto-dismiss
 * (error/confirmation, or while interactive conditions are active).
 */
export function bubbleAutoDismissMs(
  kind: BubbleDismissKindV1,
  textLength: number,
): number | null {
  switch (kind) {
    case "privacy_placeholder":
      return 6000;
    case "incoming":
    case "turn": {
      const estimate = 2500 + textLength * 80;
      return Math.max(4000, Math.min(12000, estimate));
    }
    case "never":
      return null;
  }
}

// ─── 4. Long content & URL handling (01 §6.2) ────────────────────────────

export const LONG_CONTENT_CHAR_LIMIT = 280;

const CODE_BLOCK_PATTERN = /```|`[^`\n]{40,}`/;
const TABLE_PATTERN = /^\s*\|.*\|\s*$/m;

export function shouldShowFullContentLink(text: string): boolean {
  return (
    text.length > LONG_CONTENT_CHAR_LIMIT ||
    CODE_BLOCK_PATTERN.test(text) ||
    TABLE_PATTERN.test(text)
  );
}

/**
 * URL → short display label: scheme-less hostname (or the bare host) with an
 * optional path prefix. Non-URL input is returned unchanged.
 */
export function displayUrlLabel(input: string): string {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    if (path.length === 0 || path === "/") return host;
    const prefix = path.split("/").filter(Boolean)[0];
    return `${host}/${prefix}`;
  } catch {
    return trimmed;
  }
}
