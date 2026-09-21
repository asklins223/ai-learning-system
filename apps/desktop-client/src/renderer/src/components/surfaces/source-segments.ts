import type { DesktopSourceListItem, DesktopSourceSegment } from "@ailearn/shared/desktop-surface-contracts";

/**
 * Reading-page helpers for one parsed source.
 *
 * The parser stores every fragment's raw Markdown on purpose: `charStart` /
 * `charEnd` must keep slicing the original text back out (evidence alignment
 * depends on it), so `text` keeps its `#`, `-` and `>` markers. The reading view
 * draws those markers itself, which is why the stripping happens here, at render
 * time, and never in the database.
 */

export const SEGMENT_LABELS: Record<string, string> = {
  heading: "小标题",
  paragraph: "段落",
  quote: "引用",
  code: "代码",
  list: "列表",
  image: "图片",
};

/** Measure words, so a structure line reads "3 个小标题、2 段代码" and not "3 段小标题". */
const SEGMENT_MEASURES: Record<string, string> = { code: "段", image: "张" };

export function segmentLabel(segment: DesktopSourceSegment): string {
  return SEGMENT_LABELS[segment.segmentType] ?? segment.segmentType;
}

export function segmentMeasure(segmentType: string): string {
  return SEGMENT_MEASURES[segmentType] ?? "个";
}

/** The fragment's text with the block marker its own element already draws removed. */
export function segmentText(segment: DesktopSourceSegment): string {
  switch (segment.segmentType) {
    case "heading":
      return segment.text.replace(/^#{1,6}\s+/, "");
    case "quote":
      return segment.text.replace(/^>\s?/gm, "");
    case "image":
      return segment.text.replace(
        /^!\[([^\]]*)\]\(([^)]+)\)$/,
        (_match, alt: string, url: string) => alt.trim() || url,
      );
    default:
      return segment.text;
  }
}

/** A list fragment as real list items, keeping whether the source numbered them. */
export function listSegment(text: string): { readonly ordered: boolean; readonly items: readonly string[] } {
  const items = text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim())
    .filter((line) => line.length > 0);
  return { ordered: /^\s*\d+\.\s/.test(text), items };
}

/**
 * The fragment the margin note quotes and the body marks.
 *
 * Only prose can carry that mark: a heading, a list or a code block has no
 * sentence to point at, and highlighting the page's own title as "the evidence"
 * was worse than saying nothing. No prose fragment means no margin note.
 */
export function pickFocusSegment(segments: readonly DesktopSourceSegment[]): DesktopSourceSegment | null {
  return segments.find((segment) => segment.segmentType === "quote")
    ?? segments.find((segment) => segment.segmentType === "paragraph" && segment.text.length > 40)
    ?? segments.find((segment) => segment.segmentType === "paragraph")
    ?? null;
}

/**
 * Splits the highlighted phrase off the front of a fragment. The mark is a whole
 * sentence: cutting at the first comma inside the first 34 characters marked an
 * arbitrary clause as if the source had emphasized it.
 */
export function splitHighlight(text: string): readonly [string, string] {
  const sentence = /[。！？!?]/.exec(text);
  if (sentence && sentence.index >= 5 && sentence.index < 120) {
    const end = sentence.index + 1;
    return [text.slice(0, end), text.slice(end)];
  }
  return [text, ""];
}

/**
 * An empty body means four different things, and the reader has to be able to
 * tell them apart: still queued, still parsing, failed, archived, or captured
 * with no text.
 */
export function parseStateLine(status: DesktopSourceListItem["status"]): string {
  switch (status) {
    case "draft":
      return "这份材料已经排进解析队列；开始解析后正文与结构会自动出现在这里。";
    case "processing":
      return "正在解析这份材料；完成后正文与结构会自动出现在这里。";
    case "failed":
      return "解析没有成功完成，所以这里还没有正文；可以回到来源库重新采集这份材料。";
    case "archived":
      return "这份来源已经归档，不再出现在默认索引里；内容仍可在此阅读。";
    default:
      return "这份来源还没有可阅读的正文片段。";
  }
}

/** Real counts of what parsing produced, in the order the mockup reads them. */
export function describeStructure(
  segments: readonly DesktopSourceSegment[],
  status: DesktopSourceListItem["status"] | undefined,
): string {
  if (segments.length === 0) {
    if (status === "draft" || status === "processing") return "正在解析，完成后这里会列出结构与片段。";
    if (status === "failed") return "解析没有成功完成，因此没有结构可以展示。";
    return "还没有取到正文结构。";
  }
  const counts = new Map<string, number>();
  for (const segment of segments) counts.set(segment.segmentType, (counts.get(segment.segmentType) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .filter(([type]) => type !== "paragraph")
    .map(([type, count]) => `${count} ${segmentMeasure(type)}${SEGMENT_LABELS[type] ?? type}`);
  const lead = `正文已识别为 ${segments.length} 个片段`;
  return breakdown.length ? `${lead}：${breakdown.join("、")}。` : `${lead}。`;
}

export function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 46 ? `${trimmed.slice(0, 46)}…` : trimmed;
}
