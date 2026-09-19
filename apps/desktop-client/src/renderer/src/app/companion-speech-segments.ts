import { COMPANION_VOICE_MAX_TEXT_LENGTH } from "@ailearn/shared/companion-voice-contracts";

/**
 * 伴星回复的语音分段（2026-09-18）。
 *
 * `/voice/tts` 是一条一次性请求，服务端把单次文本上限定在
 * `COMPANION_VOICE_MAX_TEXT_LENGTH`（120 字），而助手回复通常更长。所以渲染层
 * 先按句子切段、逐段合成，朗读与文本显现共用同一份分段结果——气泡里先出现哪
 * 一句，就是先念出来的那一句。
 *
 * 两条不变量（都有单测）：
 * 1. 每段 trim 后非空——否则会撞上服务端 `text.trim().min(1)` 的校验；
 * 2. `endIndex` 是该段在 `text.trim()` 中的结束下标，因此"念完第几段"可以直接
 *    映射回可见文本，不需要按字数猜。
 */

export const COMPANION_SPEECH_MAX_SEGMENT_CHARS = COMPANION_VOICE_MAX_TEXT_LENGTH;

/**
 * 第一段可以提前开口的最小长度（2026-09-19）。
 *
 * 起因是"字幕式朗读"：文字显现由真实播放进度驱动（`companion-reveal-driver`），所以
 * **音频晚开口就等于文字晚出现**。只认句末标点的话，模型先写一段带逗号的长句时，
 * 第一段要等到句号才成立——合成还没开始，气泡就先空等一两秒。
 *
 * 14 与 worker 侧 `TTS_FIRST_SEGMENT_MIN_CHARS` 同一个量级，两边对"第一句多短算短"
 * 的口径不要各说各话。
 */
export const COMPANION_SPEECH_FIRST_SEGMENT_MIN_CHARS = 14;

/** 句子结束符：在这里断句最自然，标点算作上一段的结尾。 */
const SENTENCE_BREAKS = "。！？；!?;\n";
/** 段内软断点：单句超长时优先在这里再切，避免把一个词劈开。 */
const CLAUSE_BREAKS = "，,、：:—…";
/** 软断点要落在窗口后半段才采用，否则宁可硬切，免得切出一地短碎片。 */
const MIN_SOFT_BREAK_RATIO = 0.5;

export interface CompanionSpeechSegment {
  readonly text: string;
  /** 该段在 `text.trim()` 中的结束下标（不含）。 */
  readonly endIndex: number;
}

function takeSentences(text: string): string[] {
  const sentences: string[] = [];
  let buffer = "";
  for (const char of text) {
    buffer += char;
    if (SENTENCE_BREAKS.includes(char)) {
      sentences.push(buffer);
      buffer = "";
    }
  }
  if (buffer.length > 0) sentences.push(buffer);
  return sentences;
}

/**
 * 纯空白的片段（段落之间的空行）会撞上服务端的 trim 校验，所以折进前一个片段，
 * 而不是丢掉——丢掉会让后面的 endIndex 与原文对不上。
 */
function mergeBlankRuns(units: readonly string[]): string[] {
  const merged: string[] = [];
  for (const unit of units) {
    if (unit.trim().length === 0) {
      if (merged.length > 0) merged[merged.length - 1] += unit;
      continue;
    }
    merged.push(unit);
  }
  return merged;
}

function lastClauseBreak(window: string): number {
  for (let index = window.length - 1; index >= 0; index -= 1) {
    if (CLAUSE_BREAKS.includes(window[index])) return index;
  }
  return -1;
}

/** 单句超过上限时按软断点优先、硬切兜底地拆开。 */
function breakLongUnit(unit: string, limit: number): string[] {
  if (unit.length <= limit) return [unit];
  const parts: string[] = [];
  let rest = unit;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const softBreak = lastClauseBreak(window);
    const cut = softBreak >= Math.floor(limit * MIN_SOFT_BREAK_RATIO) ? softBreak + 1 : limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * 流式切段的推进状态：`pendingStart` 之前的文本已经成为段（可能正在合成/播放），
 * 之后的还在等一个完整的句子。只前进，不回退。
 */
export interface CompanionSpeechFeedState {
  readonly pendingStart: number;
}

export const COMPANION_SPEECH_FEED_INITIAL: CompanionSpeechFeedState = { pendingStart: 0 };

/**
 * 第一段的提前切点：还没有产出任何段、尾巴够长、且软断点不靠前时，允许在逗号处先成段。
 *
 * 只对**第一段**生效：后面各段仍等句末标点，避免把一段话切成一地碎片（返工的代价是
 * 每多一段就多一次合成往返）。
 */
function firstSegmentCut(
  state: CompanionSpeechFeedState,
  pending: string,
  limit: number,
): number {
  if (state.pendingStart !== 0) return -1;
  if (pending.length < COMPANION_SPEECH_FIRST_SEGMENT_MIN_CHARS) return -1;
  const window = pending.slice(0, limit);
  const softBreak = lastClauseBreak(window);
  if (softBreak < 0) return -1;
  if (softBreak + 1 < Math.floor(window.length * MIN_SOFT_BREAK_RATIO)) return -1;
  return softBreak + 1;
}

/**
 * 流式切段：从"还没成段的尾巴"里切出**稳定**的段（绝对下标）。
 *
 * 稳定 = 落在句末标点之后（`好。` 是完整一句），或尾巴已经超过单段上限被迫硬切。
 * 没有句末标点的尾巴留到下一次 feed；`isFinal` 时强制成段（收尾不能漏字）。
 * 这样同一段文本不会被重新切分——已经合成/播过的音频不需要重来。
 */
export function splitForSpeechIncremental(
  accumulated: string,
  state: CompanionSpeechFeedState,
  isFinal = false,
  maxChars: number = COMPANION_SPEECH_MAX_SEGMENT_CHARS,
): { segments: CompanionSpeechSegment[]; next: CompanionSpeechFeedState } {
  const limit = Math.max(1, Math.floor(maxChars));
  // 跳过开头空白：服务端 `text.trim().min(1)` 会拒绝纯空白段。
  let start = state.pendingStart;
  while (start < accumulated.length && /\s/.test(accumulated[start])) start += 1;
  const pending = accumulated.slice(start);
  if (pending.length === 0) return { segments: [], next: { pendingStart: start } };

  let cut = -1;
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (SENTENCE_BREAKS.includes(pending[index])) {
      cut = index + 1;
      break;
    }
  }
  if (cut <= 0) {
    // 没有完整句：第一段允许在靠后的软断点提前开口，其余情况只有收尾或尾巴超长才切
    // （超长由 splitForSpeech 的软断点/硬切处理）。
    const early = isFinal ? -1 : firstSegmentCut(state, pending, limit);
    if (early > 0) cut = early;
    else if (!isFinal && pending.length <= limit) return { segments: [], next: { pendingStart: start } };
    else cut = pending.length;
  }
  const head = pending.slice(0, cut);
  const segments = splitForSpeech(head, limit).map((segment) => ({
    text: segment.text,
    endIndex: start + segment.endIndex,
  }));
  return { segments, next: { pendingStart: start + cut } };
}

export function splitForSpeech(
  text: string,
  maxChars: number = COMPANION_SPEECH_MAX_SEGMENT_CHARS,
): CompanionSpeechSegment[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const units = mergeBlankRuns(takeSentences(trimmed)).flatMap((unit) => breakLongUnit(unit, limit));
  const segments: CompanionSpeechSegment[] = [];
  let cursor = 0;
  let buffer = "";
  let bufferEnd = 0;

  for (const unit of units) {
    cursor += unit.length;
    if (unit.trim().length === 0) continue;
    if (buffer.length > 0 && buffer.length + unit.length > limit) {
      segments.push({ text: buffer, endIndex: bufferEnd });
      buffer = "";
    }
    buffer += unit;
    bufferEnd = cursor;
  }
  if (buffer.length > 0) segments.push({ text: buffer, endIndex: bufferEnd });
  return segments;
}
