/**
 * Markdown ↔ Block[] 转换（V0.3）。
 *
 * F-008: 修复列表/引用往返损坏。
 * - 列表项保留原始 marker（有序 `1.` / 无序 `- `），不再统一为 `·`
 * - 列表项保留换行，多行列表项不会被合并为单行
 * - quote 保留换行，连续多行引用各自保留
 * - flushBuilder 中非 code 类型的 join 改为 `\n`，保留原始行结构
 */
import { Block, BlockType } from "@/lib/api";

interface Builder {
  type: BlockType;
  content: string;
  lines: string[];
}

export interface MarkdownHeadingSelection {
  start: number;
  length: number;
}

/**
 * Returns source ranges for Markdown heading titles in document order.
 * The fence rule intentionally mirrors markdownToBlocks so `# example` lines
 * inside code blocks cannot shift outline navigation to the wrong heading.
 */
export function markdownHeadingSelections(md: string): MarkdownHeadingSelection[] {
  const lines = md.split("\n");
  const selections: MarkdownHeadingSelection[] = [];
  let offset = 0;
  let inCode = false;

  for (const raw of lines) {
    const syntaxLine = raw.trimEnd();
    if (/^```\s*([a-zA-Z0-9_-]*)\s*$/.test(syntaxLine)) {
      inCode = !inCode;
    } else if (!inCode) {
      const heading = /^(#{1,6})[\t ]+(.+?)[\t ]*$/.exec(syntaxLine);
      if (heading) {
        const title = heading[2];
        const titleOffset = raw.indexOf(title, heading[1].length);
        selections.push({
          start: offset + Math.max(0, titleOffset),
          length: title.length,
        });
      }
    }
    // split("\n") removes one character; any CR remains in `raw`, preserving
    // exact offsets for both LF and CRLF source.
    offset += raw.length + 1;
  }

  return selections;
}

function flushBuilder(buf: Builder | null, ordinalStart: number, blocks: Block[]): number {
  if (!buf || buf.lines.length === 0) return ordinalStart;
  // F-008: 非 code 类型也用 \n join，保留列表/引用的原始行结构
  // 不使用 trim：Markdown 行尾两个空格表示 hard break，代码尾空格也必须保真。
  const content = buf.lines.join("\n");
  if (!content.trim() && buf.type !== "code") return ordinalStart;
  blocks.push({ ordinal: ordinalStart, type: buf.type, content });
  return ordinalStart + 1;
}

export function markdownToBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let ordinal = 0;
  let buf: Builder | null = null;
  let inCode = false;
  let codeLang = "";

  const newBuilder = (type: BlockType): Builder => ({ type, content: "", lines: [] });

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // 结构识别可忽略行尾空白，但写入 block 时必须保留原始行。
    const syntaxLine = raw.trimEnd();

    // 代码围栏（``` 开头或结尾）
    const fence = /^```\s*([a-zA-Z0-9_-]*)\s*$/.exec(syntaxLine);
    if (fence) {
      if (!inCode) {
        ordinal = flushBuilder(buf, ordinal, blocks);
        buf = newBuilder("code");
        codeLang = fence[1] ?? "";
        buf.lines.push(codeLang ? `\`\`\`${codeLang}` : "```");
        inCode = true;
      } else {
        buf!.lines.push("```");
        inCode = false;
        ordinal = flushBuilder(buf, ordinal, blocks);
        buf = null;
      }
      continue;
    }

    if (inCode) {
      buf!.lines.push(raw);
      continue;
    }

    // 分隔线
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(syntaxLine)) {
      ordinal = flushBuilder(buf, ordinal, blocks);
      buf = newBuilder("paragraph");
      buf.lines.push("---");
      ordinal = flushBuilder(buf, ordinal, blocks);
      buf = null;
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.+)$/.exec(syntaxLine);
    if (heading) {
      ordinal = flushBuilder(buf, ordinal, blocks);
      const level = heading[1].length;
      buf = newBuilder("heading");
      buf.lines.push(`<h${level}>${heading[2]}</h${level}>`);
      ordinal = flushBuilder(buf, ordinal, blocks);
      buf = null;
      continue;
    }

    // 引用
    if (/^>\s?/.test(raw)) {
      if (!buf || buf.type !== "quote") {
        ordinal = flushBuilder(buf, ordinal, blocks);
        buf = newBuilder("quote");
      }
      buf.lines.push(raw.replace(/^>\s?/, ""));
      continue;
    }

    // 图片行（独立行，![alt](url) 格式）
    const imageMatch = /^!\[([^\]]*)\]\([^)]+\)\s*$/.exec(syntaxLine);
    if (imageMatch) {
      ordinal = flushBuilder(buf, ordinal, blocks);
      buf = newBuilder("image");
      buf.lines.push(syntaxLine);
      ordinal = flushBuilder(buf, ordinal, blocks);
      buf = null;
      continue;
    }

    // 列表（无序 / 有序）
    // F-008: 保留原始 marker 和缩进，不再统一为 ·
    if (/^(\s*)[-*+]\s+\S/.test(raw) || /^(\s*)\d+\.\s+\S/.test(raw)) {
      if (!buf || buf.type !== "list") {
        ordinal = flushBuilder(buf, ordinal, blocks);
        buf = newBuilder("list");
      }
      buf.lines.push(raw);
      continue;
    }

    // 空行 = 段落分隔
    if (raw.trim() === "") {
      ordinal = flushBuilder(buf, ordinal, blocks);
      buf = null;
      continue;
    }

    // 普通段落
    if (!buf || buf.type !== "paragraph") {
      ordinal = flushBuilder(buf, ordinal, blocks);
      buf = newBuilder("paragraph");
    }
    buf.lines.push(raw);
  }

  flushBuilder(buf, ordinal, blocks);

  // 修复 ordinal
  return blocks.map((b, i) => ({ ...b, ordinal: i }));
}

/**
 * Block[] → Markdown。
 * - heading：把 `<hN>...</hN>` 还原成 `# ...`
 * - code：```lang ... ```
 * - quote：每行加 `> `
 * - list：每行 `- `
 * - paragraph：原样（保留行内 markdown）
 */
export function blocksToMarkdown(blocks: Block[]): string {
  if (!blocks || blocks.length === 0) return "";
  return blocks
    .map((b) => {
      switch (b.type) {
        case "heading": {
          const m = /^<h(\d)>([\s\S]+)<\/h\1>$/.exec(b.content.trim());
          if (m) return `${"#".repeat(Math.min(6, Math.max(1, Number(m[1]))))} ${m[2]}`;
          // G-008: 如果 content 已经是 Markdown 标题格式（# 开头），保留原样
          if (/^#{1,6}\s+/.test(b.content.trim())) return b.content.trim();
          return `## ${b.content}`;
        }
        case "code": {
          const m = /^```([a-zA-Z0-9_-]*)$/m.exec(b.content);
          if (m && b.content.trimEnd().endsWith("```")) {
            // 已经是围栏包裹
            return b.content;
          }
          return "```\n" + b.content + "\n```";
        }
        case "quote":
          // R-015: 检查 content 是否已包含 > 前缀（API 导入的 blocks 会保留 >），
          // 避免二次添加导致 > > quote
          return b.content
            .split("\n")
            .map((l) => l.startsWith(">") ? l : `> ${l}`)
            .join("\n");
        case "list":
          // F-008: 保留原始 marker（有序/无序），只 trim 前导空格到统一格式
          return b.content
            .split("\n")
            .filter((l) => l.trim().length > 0)
            .map((l) => {
              // 已经有 marker 的保留
              if (/^\s*([-*+]|\d+\.)\s+/.test(l)) return l;
              // 兼容旧格式 ·
              return `- ${l.replace(/^·\s*/, "")}`;
            })
            .join("\n");
        case "image":
          return b.content;
        case "paragraph":
        default:
          return b.content;
      }
    })
    .join("\n\n");
}
