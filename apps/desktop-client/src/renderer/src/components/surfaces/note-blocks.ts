/**
 * 阅读页的表格识别：一块正文如果"每一行都是 `|a|b|`"，就画成表而不是散文。
 *
 * 这个文件以前还装着「编辑器文本 ↔ 保存合同的块」那一整套换算（`markdownToBlocks`、
 * `blocksToMarkdown`、`blocksMatchMarkdown`、`blockBody`）。正文的事实源换成共享文档
 * （批次 C）之后，那条换算搬进了 `packages/shared/note-doc-schema.ts`，服务端投影
 * `note_blocks` 与编辑器写文档用的都是它——这里剩下的只有"怎么把一段文本认成一张表"
 * 这一件**显示侧**的事。表格在存的约定里就是一个段落，所以它不需要块类型。
 */

/**
 * Parses a paragraph whose text is a GitHub-flavored markdown table into cell
 * rows (first row is the header). Returns null when the text is not a table,
 * so ordinary paragraphs stay prose. Tables have no dedicated block type in
 * the save contract — they live in a paragraph and are a display concern.
 *
 * 分列只切**没被转义**的竖线：单元里真要写一个 `|` 时，投影那侧写的是 `\|`
 * （`note-doc-schema.ts` 的 `tableToMarkdown`），按裸 `|` 切就会凭空多出一列。
 */
export function parseMarkdownTable(content: string): readonly (readonly string[])[] | null {
  const lines = content.trim().split("\n").map((line) => line.trim());
  if (lines.length < 2) return null;
  if (!lines.every((line) => line.startsWith("|") && line.endsWith("|"))) return null;
  const cells = (line: string) => line
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
  const separator = cells(lines[1] ?? "");
  if (separator.length === 0 || !separator.every((cell) => /^:?-{2,}:?$/.test(cell))) return null;
  return lines.map((line) => cells(line));
}
