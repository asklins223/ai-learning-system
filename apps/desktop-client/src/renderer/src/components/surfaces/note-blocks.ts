import type { NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import type { NoteBlockWriteV1 } from "@ailearn/shared/note-save-contracts";
import { noteBlockText } from "./surface-data";

/**
 * 笔记正文在「编辑器文本」和「保存合同的块」之间的唯一换算。
 *
 * 编辑器那一侧现在是真的 Markdown：正文由 Milkdown 渲染与产出，`#`、`> `、`- `、
 * ``` 都是它自己写的语法，不再是靠工具按钮拼出来的标记。所以这里只需要一个
 * Markdown ↔ Block[] 的换算，而不是过去那套「纯文本标记 + 转义」的往返。
 *
 * 存进服务端的块形状沿用本客户端既有的约定，也向后兼容 Web 端写下的老版本：
 *
 * | 类型 | 存的 content | 编辑器里的写法 |
 * |---|---|---|
 * | heading | 标题本身（老版本可能是 `<h1>…</h1>`） | `# 标题` |
 * | quote | 不带 `> ` 的引用正文（老版本可能带） | `> 引用` |
 * | list | 不带 `- ` 的条目，换行分隔（老版本可能带） | `- 条目` |
 * | code | 代码本身，不带围栏（老版本可能带） | \`\`\` 围栏 |
 * | image | 整行是 `![说明](地址)` | 同左 |
 * | paragraph | 原文，可含行内 Markdown | 同左 |
 *
 * `blockBody` 是这套约定的唯一定义：`blockToMarkdown` 用它产出编辑器文本，
 * `blocksMatchMarkdown` 用它判断「编辑器的文本是否等于已提交的版本」。只有一个
 * 定义，就不会出现「读进来一种、写出去另一种」的漂移——那种漂移的后果是打开
 * 一篇没改过的笔记就显示未提交，然后自动保存重写一个内容相同的版本。
 */

const FENCE = "```";
const HEADING_MARKER_ANY = /^(#{1,6})[ \t]+(.*)$/;
const QUOTE_MARKER = /^>[ \t]?/;
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d+\.)[ \t]+/;
const BULLET_OR_ORDERED = /^[ \t]*(?:[-*+]|\d+\.)[ \t]+\S/;
const HORIZONTAL_RULE = /^(?:\*{3,}|-{3,}|_{3,})[ \t]*$/;
const FENCE_LINE = /^```[ \t]*[A-Za-z0-9_+-]*[ \t]*$/;
const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

/**
 * Parses a paragraph whose text is a GitHub-flavored markdown table into cell
 * rows (first row is the header). Returns null when the text is not a table,
 * so ordinary paragraphs stay prose. Tables have no dedicated block type in
 * the save contract — they live in a paragraph and are a display concern.
 */
export function parseMarkdownTable(content: string): readonly (readonly string[])[] | null {
  const lines = content.trim().split("\n").map((line) => line.trim());
  if (lines.length < 2) return null;
  if (!lines.every((line) => line.startsWith("|") && line.endsWith("|"))) return null;
  const cells = (line: string) => line.slice(1, -1).split("|").map((cell) => cell.trim());
  const separator = cells(lines[1] ?? "");
  if (separator.length === 0 || !separator.every((cell) => /^:?-{2,}:?$/.test(cell))) return null;
  return lines.map((line) => cells(line));
}

function stripPerLine(value: string, pattern: RegExp): string {
  return value.split("\n").map((line) => line.replace(pattern, "")).join("\n");
}

function stripFences(value: string): string {
  const lines = value.split("\n");
  const kept = lines.filter((line) => !FENCE_LINE.test(line.trim()));
  return (kept.length ? kept : lines).join("\n").replace(/\n+$/, "");
}

/**
 * The canonical body text of a stored block: what the editor shows for it and
 * what a save would write back. Legacy shapes (a Web-era `<h1>` wrapper, a list
 * that kept its `- `, a code block that kept its fences) all collapse to the
 * same body here, so a version written by either client round-trips to itself.
 */
export function blockBody(type: NoteBlockWriteV1["type"], content: string): string {
  if (type === "code") return stripFences(content);
  if (type === "image") return content.trim();
  const text = noteBlockText(content);
  if (type === "heading") return text.trim();
  if (type === "quote") return stripPerLine(text, QUOTE_MARKER).trim();
  if (type === "list") return stripPerLine(text, LIST_MARKER).trim();
  return text;
}

/**
 * One stored block as the Markdown the editor carries. A text block whose body
 * is empty contributes nothing: an empty heading has no `#` line to write, and
 * emitting one would come back as a different block on the next save.
 */
export function blockToMarkdown(block: NoteBlockProjectionV1): string {
  const body = blockBody(block.type, block.content);
  // Only a code block has a markdown form when it is empty (its fence pair);
  // every other empty block would come back as a different type or vanish.
  if (block.type !== "code" && body.trim() === "") return "";
  switch (block.type) {
    case "heading":
      return body.split("\n").filter((line) => line.trim() !== "").map((line) => `# ${line}`).join("\n");
    case "quote":
      return body.split("\n").map((line) => `> ${line}`).join("\n");
    case "list":
      return body.split("\n").filter((line) => line.trim() !== "").map((line) => `- ${line}`).join("\n");
    case "code":
      return `${FENCE}\n${body}\n${FENCE}`;
    default:
      // Image content already IS its markdown; a paragraph is its own text.
      return body;
  }
}

export function blocksToMarkdown(blocks: readonly NoteBlockProjectionV1[]): string {
  return blocks
    .map(blockToMarkdown)
    .filter((section) => section.trim() !== "")
    .join("\n\n");
}

/** Splits on blank lines, keeping a fenced code block in one piece. */
function splitSections(value: string): string[][] {
  const sections: string[][] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of value.split("\n")) {
    if (FENCE_LINE.test(line.trim())) {
      fenced = !fenced;
      current.push(line);
      continue;
    }
    if (!fenced && line.trim() === "") {
      if (current.length) sections.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) sections.push(current);
  return sections;
}

function sectionToBlock(section: readonly string[]): NoteBlockWriteV1 | null {
  const first = section[0] ?? "";
  if (FENCE_LINE.test(first.trim())) {
    const inner = section.filter((line) => !FENCE_LINE.test(line.trim()));
    return { type: "code", content: inner.join("\n") };
  }
  if (section.length === 1) {
    const only = first.trim();
    if (IMAGE_LINE.test(only)) return { type: "image", content: only };
    if (HORIZONTAL_RULE.test(only)) return { type: "paragraph", content: "---" };
  }
  if (section.every((line) => HEADING_MARKER_ANY.test(line))) {
    const titles = section.map((line) => HEADING_MARKER_ANY.exec(line)?.[2]?.trim() ?? "");
    return { type: "heading", content: titles.join("\n") };
  }
  if (section.every((line) => QUOTE_MARKER.test(line))) {
    return { type: "quote", content: stripPerLine(section.join("\n"), QUOTE_MARKER).trim() };
  }
  if (section.every((line) => BULLET_OR_ORDERED.test(line))) {
    return { type: "list", content: stripPerLine(section.join("\n"), LIST_MARKER).trim() };
  }
  const content = section.join("\n").trim();
  return content ? { type: "paragraph", content } : null;
}

export function markdownToBlocks(value: string): NoteBlockWriteV1[] {
  return splitSections(value)
    .map(sectionToBlock)
    .filter((block): block is NoteBlockWriteV1 => block !== null);
}

/**
 * True when the editor's Markdown would save into exactly the stored blocks.
 *
 * Dirty must be a statement about versions, not characters: text that only
 * loses whitespace on the round trip (a trailing newline, a collapsed blank
 * line) would otherwise stay dirty forever and re-save the same version on
 * every autosave tick. Both sides go through `blockBody`, so a legacy version
 * written by the Web client also compares as clean instead of looking edited
 * the moment it is opened.
 */
export function blocksMatchMarkdown(value: string, blocks: readonly NoteBlockProjectionV1[]): boolean {
  const expected = blocks
    .map((block) => ({ type: block.type, content: blockBody(block.type, block.content) }))
    // Mirrors `blockToMarkdown`: an empty text block carries no markdown at all.
    .filter((block) => block.type === "code" || block.content.trim() !== "");
  const next = markdownToBlocks(value);
  if (next.length !== expected.length) return false;
  return next.every((block, index) => {
    const current = expected[index];
    return current !== undefined && block.type === current.type && block.content === current.content;
  });
}

/** A paragraph that is nothing but a markdown horizontal rule. */
export function isHorizontalRule(text: string): boolean {
  return HORIZONTAL_RULE.test(text.trim());
}
