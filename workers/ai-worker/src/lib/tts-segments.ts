/**
 * P3 TTS 切句（§11.3）：Worker 是切句唯一所有者。
 *
 * - 输入为已净化可见文本（Markdown 标记/URL/代码块/隐藏 metadata 已在
 *   validateCompanionOutput 后由本模块剔除，不进入 voice segment）；
 * - 切句优先 `。！？；\n` 或 `.?!;` + 空白；句子至少 8 个中文字符，
 *   final 强制 flush；单段最多 160 字符，超限在最近合法标点/空白强制切分；
 * - 每 run 最多 20 段、总可朗读文本最多 2000 字；超过后只显示文字（不发段）；
 * - 净化后为空 → 零段（不发 voice.segment.ready）；
 * - segmentId = sha256(runId:ordinal:text)（64 hex，稳定唯一）；textSha256 = sha256(text)。
 */

import { createHash } from "node:crypto";

export const TTS_MAX_SEGMENTS = 20;
export const TTS_MAX_TOTAL_CHARS = 2_000;
export const TTS_MAX_SEGMENT_CHARS = 160;
export const TTS_MIN_SEGMENT_CHARS = 8;

export interface CompanionTtsSegment {
  ordinal: number;
  segmentId: string;
  text: string;
  textSha256: string;
}

const SPLIT_PATTERN = /(?<=[。！？；\n.!?;])\s*/;
const HARD_SPLIT_PATTERN = /(?<=[，,、])/;
const MARKDOWN_BLOCK_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const URL_PATTERN = /https?:\/\/[^\s，。！？；,.!?;]+/g;
// 只剥离“行首标记/成对强调/链接语法”，不误删正文中的半角括号、连字符、
// 方括号等普通字符（如 “第3-4题 (b)”、“[重要]” 需原样朗读）。
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;
const MARKDOWN_LINE_MARKERS = /^[#>*]{1,6}\s+|^\s*[-+]\s+|^\s*\|/gm;
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

/** §11.3 切句：段 ≤160、优先合法标点/空白、final flush。 */
export function splitCompanionTtsSegments(
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
