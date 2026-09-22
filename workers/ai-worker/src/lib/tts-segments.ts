/**
 * P3 TTS 切句（§11.3）：Worker 是切句唯一所有者。
 *
 * - 输入为已净化可见文本（Markdown 标记/URL/代码块/隐藏 metadata 已在
 *   validateCompanionOutput 后由本模块剔除，不进入 voice segment）；
 * - 切句优先 `。！？；\n` 或 `.?!;` + 空白；句子至少 8 个中文字符，
 *   final 强制 flush；单段最多 160 字符，超限在最近合法标点/空白强制切分；
 * - 每 run 最多 200 段、总可朗读文本最多 20000 字（与回复硬上限
 *   COMPANION_HARD_MAX_CHARS 对齐——回复多长就朗读多长，实际不限制）；
 *   2026-08-12+（15a 新反馈）：用户明确不要朗读上限，去掉原 20 段/2000 字、
 *   40 段/4000 字的限制。
 * - 净化后为空 → 零段（不发 voice.segment.ready）；
 * - segmentId = sha256(runId:ordinal:text)（64 hex，稳定唯一）；textSha256 = sha256(text)。
 */

import { createHash } from "node:crypto";

export const TTS_MAX_SEGMENTS = 200;
export const TTS_MAX_TOTAL_CHARS = 20_000;
export const TTS_MAX_SEGMENT_CHARS = 160;
/** 15b 二期（问题2 修复）：首段提前触发的最小字符数——流式文字生成中，
 *  缓冲达到该长度即切出首段（不要求完整句），让 TTS 合成尽早开始，声音
 *  与文字感官同步（"字幕般"）；后续段仍按完整句切，朗读连贯性不受影响。 */
export const TTS_FIRST_SEGMENT_MIN_CHARS = 14;
/**
 * 展示段的目标长度（方案 29 §14.11 修复 ④）。
 *
 * 一段一次合成，**合成时间与字数近似成正比**，而它必须在下一段的播放时间里跑完
 * （引擎对同一用户是串行的）。实测段长 p50 = 19、p90 = 41、最长 97 字；那几条
 * 90+ 字的段一次要合成 3 秒以上，一旦前一段的音频比它短，中间就是一段可听静音。
 *
 * 所以：一句之内如果没有句末标点、但已经攒过目标长度且有逗号级停顿，就先切出去
 * （逗号本来就是朗读的自然停顿，切在这里不伤语气）。目标 48 字只影响 p90 之后
 * 那条长尾——p50/p90 的段一个都不会被切开。
 */
export const TTS_DISPLAY_SEGMENT_TARGET_CHARS = 48;

export interface CompanionTtsSegment {
  ordinal: number;
  segmentId: string;
  text: string;
  textSha256: string;
}

const SPLIT_PATTERN = /(?<=[。！？；\n.!?;])\s*/;
const HARD_SPLIT_PATTERN = /(?<=[，,、])/;
/** 目标长度内最后一个"逗号级停顿"之后的位置；没有就返回 -1。 */
function lastSecondaryBoundary(text: string, limit: number): number {
  for (let index = Math.min(text.length, limit) - 1; index >= 0; index -= 1) {
    if (/[，,、]/.test(text[index] ?? "")) return index + 1;
  }
  return -1;
}
const MARKDOWN_BLOCK_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const URL_PATTERN = /https?:\/\/[^\s，。！？；,.!?;]+/g;
// 只剥离“行首标记/成对强调/链接语法”，不误删正文中的半角括号、连字符、
// 方括号等普通字符（如 “第3-4题 (b)”、“[重要]” 需原样朗读）。
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;
// 有序列表标记也要剥：可见正文从 §4.8 起保留 markdown，实机落库的朗读段里出现过
// 单独一段 `4.`——TTS 会把它念成"四点"。`1.5 米` 这种不会被误伤（数字后必须紧跟
// `.`/`)` 再加空白才算列表项）。
const MARKDOWN_LINE_MARKERS = /^[#>*]{1,6}\s+|^\s*[-+]\s+|^\s*\d+[.)]\s+|^\s*\|/gm;
const MARKDOWN_EMPHASIS_PATTERN = /\*\*|__|~~/g;

/** 净化可见文本：去掉代码块/行内代码、URL、markdown 语法后压缩空白。 */
export function purifyVoiceText(text: string): string {
  return text
    .replace(MARKDOWN_BLOCK_PATTERN, " ")
    .replace(URL_PATTERN, " ")
    .replace(MARKDOWN_LINK_PATTERN, "$1")
    .replace(MARKDOWN_LINE_MARKERS, " ")
    .replace(MARKDOWN_EMPHASIS_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * §11.3 增量切段（2026-08-12+ 15b：字幕般流式 TTS）。
 *
 * 与 splitCompanionTtsSegments 的区别：输入是"新增的流式文本"而非全文——
 * 每次调用只切出**以句结束符结尾的完整句**，未完成句留在 rest 下次继续；
 * isFinal=true 时把 rest 一并切出（final flush）。
 *
 * 段上限（maxSegments/maxTotalChars）按已发段累计维护：超限的剩余文本
 * 直接丢弃（只显示文字、不朗读），与全文版语义一致。
 *
 * 注意：净化（purifyVoiceText）按"rest+新增"整体执行，跨 delta 的 markdown
 * 边界处理可能不完美（偶发残留符号，可接受——TTS 文本）。
 */
export interface IncrementalTtsState {
  /** 未完成句（净化后），等待与后续文本拼成完整句 */
  rest: string;
  /** 已发出段数（ordinal 从 sentCount+1 起） */
  sentCount: number;
  /** 已发出段总字符数 */
  sentChars: number;
}

export interface IncrementalTtsSplit {
  segments: CompanionTtsSegment[];
  next: IncrementalTtsState;
}

/**
 * 已提交可见正文上的稳定区间切分。与旧增量切句器不同，它不净化、压缩或重排文字，
 * 因而 `displayText === fullText.slice(displayStart, displayEnd)` 始终成立，客户端可以
 * 直接用绝对下标同步字幕，不再做易错的字符串前缀匹配。
 */
export interface CompanionDisplaySegmentState {
  readonly cursor: number;
  readonly sentCount: number;
}

export interface CompanionDisplaySegment {
  readonly ordinal: number;
  readonly displayText: string;
  readonly displayStart: number;
  readonly displayEnd: number;
}

export function splitCommittedDisplaySegments(
  fullText: string,
  state: CompanionDisplaySegmentState,
  isFinal = false,
  opts?: {
    readonly firstSegmentMinChars?: number;
    readonly maxSegmentChars?: number;
    readonly maxSegments?: number;
    /** 目标段长；超过它且句内没有句末标点时，在逗号级停顿处先切一段（§14.11 ④）。 */
    readonly targetSegmentChars?: number;
  },
): { readonly segments: CompanionDisplaySegment[]; readonly next: CompanionDisplaySegmentState } {
  const maxSegmentChars = opts?.maxSegmentChars ?? TTS_MAX_SEGMENT_CHARS;
  const maxSegments = opts?.maxSegments ?? TTS_MAX_SEGMENTS;
  const firstSegmentMinChars = opts?.firstSegmentMinChars ?? TTS_FIRST_SEGMENT_MIN_CHARS;
  const targetSegmentChars = Math.min(
    maxSegmentChars,
    opts?.targetSegmentChars ?? TTS_DISPLAY_SEGMENT_TARGET_CHARS,
  );
  let cursor = Math.min(Math.max(0, state.cursor), fullText.length);
  let ordinal = state.sentCount;
  const segments: CompanionDisplaySegment[] = [];

  const push = (start: number, end: number): void => {
    let displayStart = start;
    let displayEnd = end;
    while (displayStart < displayEnd && /\s/.test(fullText[displayStart] ?? "")) displayStart += 1;
    while (displayEnd > displayStart && /\s/.test(fullText[displayEnd - 1] ?? "")) displayEnd -= 1;
    cursor = end;
    if (displayEnd <= displayStart || ordinal >= maxSegments) return;
    ordinal += 1;
    segments.push({
      ordinal,
      displayText: fullText.slice(displayStart, displayEnd),
      displayStart,
      displayEnd,
    });
  };

  while (cursor < fullText.length && ordinal < maxSegments) {
    const remaining = fullText.slice(cursor);
    const hardEnd = Math.min(fullText.length, cursor + maxSegmentChars);
    let boundary = -1;
    const scanLimit = Math.min(remaining.length, maxSegmentChars);
    for (let index = 0; index < scanLimit; index += 1) {
      if (/[。！？；\n.!?;]/.test(remaining[index] ?? "")) {
        boundary = cursor + index + 1;
        break;
      }
    }

    if (boundary > cursor) {
      // 句末标点**离得太远**（超过目标段长）而句内有逗号级停顿：先切在逗号上
      // （§14.11 ④）。一段一次合成、同一用户的合成是串行的，段越长越可能跑不进
      // 前一段的播放时间——那中间就是一段可听静音。切在逗号上是朗读的自然停顿。
      if (boundary - cursor > targetSegmentChars) {
        const secondary = lastSecondaryBoundary(remaining, targetSegmentChars);
        if (secondary > 0) {
          push(cursor, cursor + secondary);
          continue;
        }
      }
      push(cursor, boundary);
      continue;
    }
    // 整段扫不到句末标点（超长句）：同样先在逗号处切，再退到 160 硬上限。
    if (remaining.length > targetSegmentChars) {
      const secondary = lastSecondaryBoundary(remaining, targetSegmentChars);
      if (secondary > 0) {
        push(cursor, cursor + secondary);
        continue;
      }
    }
    if (remaining.length >= maxSegmentChars) {
      push(cursor, hardEnd);
      continue;
    }
    if (!isFinal && ordinal === 0 && remaining.trim().length >= firstSegmentMinChars) {
      // 首段尽早发出，但保持这次已经提交的稳定前缀完整，避免把一个短句切成多个请求。
      push(cursor, fullText.length);
      continue;
    }
    if (isFinal) {
      push(cursor, fullText.length);
    }
    break;
  }

  return { segments, next: { cursor, sentCount: ordinal } };
}

export function splitCompanionTtsSegmentsIncremental(
  text: string,
  state: IncrementalTtsState,
  isFinal = false,
  opts?: {
    maxSegments?: number;
    maxTotalChars?: number;
    maxSegmentChars?: number;
    /** 首段提前触发的最小字符数（>0 且 sentCount===0 时生效） */
    firstSegmentMinChars?: number;
  },
): IncrementalTtsSplit {
  const maxSegments = opts?.maxSegments ?? TTS_MAX_SEGMENTS;
  const maxTotalChars = opts?.maxTotalChars ?? TTS_MAX_TOTAL_CHARS;
  const maxSegmentChars = opts?.maxSegmentChars ?? TTS_MAX_SEGMENT_CHARS;

  const combined = purifyVoiceText(`${state.rest}${text}`);
  if (combined.length === 0) {
    return { segments: [], next: { ...state, rest: "" } };
  }

  // 15b 二期（问题2 修复）：首段提前——从未发过段且缓冲达到最小长度时，
  // 不要求完整句直接切出首段（声音尽早开始，与流式文字感官同步）。
  // 2026-08-24（三轮自查）：首段同样受单段 160 字符合同上限约束（web 客户端
  // 按 >160 静默丢音频）——此前整个首刷批次（可达 256+ 字符）无上限成段；
  // 超出部分留在 rest，随下一次调用继续正常切句，文本不丢失。
  const firstMin = opts?.firstSegmentMinChars ?? 0;
  if (
    !isFinal && state.sentCount === 0 && firstMin > 0
    // 三轮审查 nit：提前分支同样受总字数配额约束（生产调用方均用默认大配额，
    // 此为防御性守卫；自定义小配额的调用方不再被首段绕过）。
    && combined.length >= firstMin && combined.length <= maxTotalChars
  ) {
    const segText = combined.trim().slice(0, maxSegmentChars);
    const restText = combined.trim().slice(maxSegmentChars);
    if (segText.length > 0) {
      const textSha256 = createHash("sha256").update(segText, "utf8").digest("hex");
      return {
        segments: [{
          ordinal: 1,
          text: segText,
          textSha256,
          segmentId: createHash("sha256")
            .update(`1:${textSha256}`, "utf8")
            .digest("hex"),
        }],
        next: { rest: restText, sentCount: 1, sentChars: segText.length },
      };
    }
  }

  const sentences = combined.split(SPLIT_PATTERN).filter((s) => s.trim().length > 0);
  const last = sentences[sentences.length - 1];
  const lastComplete = isFinal || /[。！？；\n.!?;]$/.test(last.trim());
  const complete = (lastComplete ? sentences : sentences.slice(0, -1))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const rest = lastComplete ? "" : last.trim();

  // 超长句硬切（与全文版一致：HARD_SPLIT_PATTERN 在最近标点/空白切）
  const rawSegments: string[] = [];
  for (const sentence of complete) {
    if (sentence.length <= maxSegmentChars) {
      rawSegments.push(sentence);
      continue;
    }
    let r = sentence;
    while (r.length > maxSegmentChars) {
      const slice = r.slice(0, maxSegmentChars);
      const hardMatch = HARD_SPLIT_PATTERN.exec(slice);
      const cutAt = hardMatch ? hardMatch.index + 1 : maxSegmentChars;
      rawSegments.push(slice.slice(0, cutAt).trim());
      r = r.slice(cutAt).trim();
    }
    if (r.length > 0) rawSegments.push(r);
  }

  const out: CompanionTtsSegment[] = [];
  let total = state.sentChars;
  for (const segText of rawSegments) {
    if (state.sentCount + out.length >= maxSegments) break; // 超段数：只显示文字
    if (total + segText.length > maxTotalChars) break; // 超总字数：只显示文字
    total += segText.length;
    out.push({
      ordinal: state.sentCount + out.length + 1,
      text: segText,
      textSha256: createHash("sha256").update(segText, "utf8").digest("hex"),
      segmentId: "",
    });
  }
  return {
    segments: out.map((seg) => ({
      ...seg,
      segmentId: createHash("sha256")
        .update(`${seg.ordinal}:${seg.textSha256}`, "utf8")
        .digest("hex"),
    })),
    next: {
      rest,
      sentCount: state.sentCount + out.length,
      sentChars: total,
    },
  };
}

/**
 * §11.3 切句：段 ≤160、优先合法标点/空白、final flush。
 */export function splitCompanionTtsSegments(
  text: string,
  opts?: {
    maxSegments?: number;
    maxTotalChars?: number;
    maxSegmentChars?: number;
  },
): CompanionTtsSegment[] {
  const maxSegments = opts?.maxSegments ?? TTS_MAX_SEGMENTS;
  const maxTotalChars = opts?.maxTotalChars ?? TTS_MAX_TOTAL_CHARS;
  const maxSegmentChars = opts?.maxSegmentChars ?? TTS_MAX_SEGMENT_CHARS;

  const purified = purifyVoiceText(text);
  if (purified.length === 0) return [];

  // 先按完整句切；超长句再按硬切标点切
  const sentences = purified.split(SPLIT_PATTERN).filter((s) => s.trim().length > 0);
  const rawSegments: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxSegmentChars) {
      rawSegments.push(sentence.trim());
      continue;
    }
    // 超限：在最近合法标点/空白强制切分
    let rest = sentence;
    while (rest.length > maxSegmentChars) {
      const slice = rest.slice(0, maxSegmentChars);
      const hardMatch = HARD_SPLIT_PATTERN.exec(slice);
      const cutAt = hardMatch ? hardMatch.index + 1 : maxSegmentChars;
      rawSegments.push(slice.slice(0, cutAt).trim());
      rest = rest.slice(cutAt).trim();
    }
    if (rest.length > 0) rawSegments.push(rest.trim());
  }

  // final flush：2026-08-12（语音段落间隔优化）贪心合并相邻句子到目标段长
  // （≤ min(maxSegmentChars, 120)）。此前仅合并 <8 字的短句，导致"每句一段
  // → 每段一次独立 TTS 请求"，段落间隔（合成+网络延迟）被成倍放大；合并后
  // 段内句子由 TTS 自然停顿衔接，朗读更连贯、间隔次数大幅减少。
  // 限制：合并后 ≤ maxSegmentChars（单段 160 上限不变）；目标 120 字符
  // （约 15-18 秒朗读）避免单段过长。超过目标段不强行合并。
  const MERGE_TARGET = Math.min(maxSegmentChars, 120);
  const segments: string[] = [];
  for (const raw of rawSegments) {
    const current = segments[segments.length - 1];
    if (
      current &&
      current.length + raw.length <= MERGE_TARGET &&
      current.length + raw.length <= maxSegmentChars
    ) {
      segments[segments.length - 1] = `${current}${raw}`;
    } else {
      segments.push(raw);
    }
  }

  const out: CompanionTtsSegment[] = [];
  let total = 0;
  for (const segText of segments) {
    if (out.length >= maxSegments) break; // >20 段：只显示文字
    if (total + segText.length > maxTotalChars) break; // >2000 字：只显示文字
    total += segText.length;
    out.push({
      ordinal: out.length + 1,
      text: segText,
      textSha256: createHash("sha256").update(segText, "utf8").digest("hex"),
      segmentId: "",
    });
  }
  // segmentId 由调用方（worker handler）按合同公式
  // sha256(runId:generation:ordinal:textSha256) 填充；此处先用
  // (ordinal:textSha256) 计算确定性占位，避免任何调用方误用明文 text。
  return out.map((seg, i) => ({
    ...seg,
    segmentId: createHash("sha256")
      .update(`${i + 1}:${seg.textSha256}`, "utf8")
      .digest("hex"),
  }));
}

/**
 * §11.3（03 §5.2 line 778）：segmentId 固定为
 * `sha256(runId:generation:ordinal:textSha256)` 的 64 位小写十六进制。
 * 调用方（worker handler）传 runId/generation 与段自身 textSha256。
 */
export function companionSegmentId(
  runId: string,
  generation: number,
  ordinal: number,
  textSha256: string,
): string {
  return createHash("sha256")
    .update(`${runId}:${generation}:${ordinal}:${textSha256}`, "utf8")
    .digest("hex");
}

// ─── 15b 二期：情感与富语言标签（阿里百炼 Qwen-Audio-TTS） ───────────────
// 双文本管线：LLM 输出可嵌入标签（仅 qwen 朗读文本保留），展示/入库文本
// 必须剥离（stripVoiceExpressionTags）；段级情感由 extractVoiceEmotion
// 解析（最后一个控制类标签 → emotion，供 live2d 协同，见 15 方案待办）。
// 2026-08-13（引擎兼容）：实现位于 packages/shared/voice-expression-tags
// （api edge 分支净化也需使用），调用方直接从 @ailearn/shared/voice-expression-tags 导入。
