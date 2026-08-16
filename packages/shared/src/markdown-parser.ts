/**
 * Markdown / 文本分段解析器。
 * Source 的 parse_source job 和 /import/markdown API 共用此模块。
 *
 * 分段规则（V0.3 不调模型，纯规则分段）：
 * - text：按双换行分段
 * - markdown：按标题和段落分段，保留代码块完整性
 * - code：整段作为一个 segment
 * - url：同 markdown 或 text，根据内容是否含 Markdown 语法推断
 */

export interface ParsedSegment {
  text: string;
  segmentType: "paragraph" | "heading" | "code" | "quote" | "list" | "image";
  charStart: number;
  charEnd: number;
}

export interface ParsedBlock {
  type: "paragraph" | "heading" | "code" | "list" | "quote" | "image";
  content: string;
}

/**
 * 将原始内容按类型分段。
 */
export function parseContent(
  content: string,
  sourceType: "text" | "markdown" | "code" | "url",
): ParsedSegment[] {
  if (!content.trim()) return [];

  switch (sourceType) {
    case "code":
      return [{
        text: content,
        segmentType: "code",
        charStart: 0,
        charEnd: content.length,
      }];

    case "text":
      return splitByDoubleNewline(content, "text");

    case "markdown":
    case "url":
      return parseMarkdown(content);

    default:
      return splitByDoubleNewline(content, "text");
  }
}

/**
 * 将 ParsedSegment 转换为 NoteBlock（用于创建笔记草稿和 Markdown 导入）。
 * 映射规则见 V0.3 迭代规划 §3.1.3。
 */
export function segmentsToBlocks(
  segments: ParsedSegment[],
  sourceType: "text" | "markdown" | "code" | "url",
): ParsedBlock[] {
  if (sourceType === "code") {
    return segments.map((s) => ({ type: "code" as const, content: s.text }));
  }

  if (sourceType === "text") {
    return segments.map((s) => ({ type: "paragraph" as const, content: s.text }));
  }

  // markdown / url：按 segmentType 直接映射
  return segments.map((s) => ({
    type: s.segmentType,
    content: s.text,
  }));
}

/**
 * 直接从 Markdown 文本解析为 blocks（用于 /import/markdown）。
 */
export function markdownToBlocks(markdown: string): ParsedBlock[] {
  const segments = parseMarkdown(markdown);
  return segments.map((s) => ({
    type: s.segmentType,
    content: s.text,
  }));
}

/**
 * 从 blocks 中提取标题（第一个 heading 或 paragraph 的内容）。
 */
export function extractTitleFromBlocks(blocks: ParsedBlock[]): string {
  const heading = blocks.find((b) => b.type === "heading" && b.content.trim());
  if (heading) {
    return cleanTitle(heading.content).slice(0, 60);
  }
  const fallback = blocks.find((b) => b.content.trim());
  if (fallback) {
    return cleanTitle(fallback.content).slice(0, 60);
  }
  return "无标题笔记";
}

function cleanTitle(content: string): string {
  return content
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/`{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* --------------------------- internal parsers --------------------------- */

function splitByDoubleNewline(content: string, _sourceType: string): ParsedSegment[] {
  const parts = content.split(/\n\s*\n/).filter((p) => p.trim());
  const segments: ParsedSegment[] = [];
  let offset = 0;

  for (const part of parts) {
    const trimmed = part.trim();
    const start = content.indexOf(trimmed, offset);
    const end = start + trimmed.length;
    segments.push({
      text: trimmed,
      segmentType: "paragraph",
      charStart: start,
      charEnd: end,
    });
    offset = end;
  }

  return segments;
}

/**
 * Markdown 解析：按标题、代码块、引用、列表、段落分段。
 * 保留代码块完整性（不拆分 ``` 包裹的内容）。
 */
function parseMarkdown(content: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const lines = content.split("\n");
  // 用数组累积行，flush/收尾时才 join 一次，避免长文档逐行字符串
  // `+=` 造成 O(n²) 的不可变字符串重建。
  let currentLines: string[] = [];
  const currentText = (): string =>
    currentLines.length === 0 ? "" : currentLines.join("\n") + "\n";
  let currentType: ParsedSegment["segmentType"] = "paragraph";
  let charStart = 0;
  let currentOffset = 0;

  function flush() {
    // G-008: 调整 charStart 以跳过前导空白，确保 content.slice(charStart, charEnd) === text
    const text = currentText();
    const trimmedStart = text.trimStart();
    const trimmed = trimmedStart.trimEnd();
    if (trimmed) {
      const leadingWs = text.length - trimmedStart.length;
      segments.push({
        text: trimmed,
        segmentType: currentType,
        charStart: charStart + leadingWs,
        charEnd: charStart + leadingWs + trimmed.length,
      });
    }
    currentLines = [];
    currentType = "paragraph";
  }

  let inCodeBlock = false;
  let codeBlockLines: string[] = [];
  let codeBlockStartOffset = 0;

  for (const line of lines) {
    // 代码块开始/结束
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        // 代码块结束
        codeBlockLines.push(line);
        const codeBlockContent = codeBlockLines.join("\n") + "\n";
        const trimmedStart = codeBlockContent.trimStart();
        const text = trimmedStart.trimEnd();
        const leadingWhitespace = codeBlockContent.length - trimmedStart.length;
        segments.push({
          text,
          segmentType: "code",
          charStart: codeBlockStartOffset + leadingWhitespace,
          charEnd: codeBlockStartOffset + leadingWhitespace + text.length,
        });
        codeBlockLines = [];
        inCodeBlock = false;
      } else {
        // 先 flush 当前段落
        flush();
        inCodeBlock = true;
        codeBlockStartOffset = currentOffset;
        codeBlockLines = [line];
      }
      currentOffset += line.length + 1; // +1 for \n
      charStart = currentOffset;
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      currentOffset += line.length + 1;
      continue;
    }

    // 标题行
    if (/^#{1,6}\s/.test(line)) {
      flush();
      currentLines = [line];
      currentType = "heading";
      charStart = currentOffset;
      currentOffset += line.length + 1;
      flush();
      continue;
    }

    // 图片行（独立行，![alt](url) 格式）
    if (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(line)) {
      flush();
      currentLines = [line];
      currentType = "image";
      charStart = currentOffset;
      currentOffset += line.length + 1;
      flush();
      continue;
    }

    // 引用行
    if (/^>\s?/.test(line)) {
      if (currentType !== "quote") {
        flush();
        currentType = "quote";
        charStart = currentOffset;
      }
      currentLines.push(line);
      currentOffset += line.length + 1;
      continue;
    }

    // 列表行
    if (/^[-*+]\s/.test(line) || /^\d+\.\s/.test(line)) {
      if (currentType !== "list") {
        flush();
        currentType = "list";
        charStart = currentOffset;
      }
      currentLines.push(line);
      currentOffset += line.length + 1;
      continue;
    }

    // 空行 → 段落分隔
    if (line.trim() === "") {
      flush();
      // G-008: Account for line content length (not just \n) to keep offsets correct
      currentOffset += line.length + 1;
      charStart = currentOffset;
      continue;
    }

    // 普通段落
    if (currentType !== "paragraph") {
      flush();
      currentType = "paragraph";
      charStart = currentOffset;
    }
    currentLines.push(line);
    currentOffset += line.length + 1;
  }

  // flush 最后一段
  if (inCodeBlock && codeBlockLines.length > 0 && codeBlockLines.join("\n").trim()) {
    const codeBlockContent = codeBlockLines.join("\n") + "\n";
    const trimmedStart = codeBlockContent.trimStart();
    const text = trimmedStart.trimEnd();
    const leadingWhitespace = codeBlockContent.length - trimmedStart.length;
    segments.push({
      text,
      segmentType: "code",
      charStart: codeBlockStartOffset + leadingWhitespace,
      charEnd: codeBlockStartOffset + leadingWhitespace + text.length,
    });
  } else {
    flush();
  }

  return segments;
}
