/**
 * 极简 Markdown 渲染器（仅用于预览，不依赖第三方库）。
 *
 * 支持：
 * - `#` 至 `######` 六级标题
 * - `**bold**` / `*italic*` / `__bold__` / `_italic_`
 * - `` `code` `` 行内代码
 * - ` ```lang\n...\n``` ` 代码块
 * - `> quote` 引用块
 * - `- * +` 无序列表 / `1.` 有序列表
 * - GFM 风格表格（含对齐方式）
 * - `---` 分隔线
 * - `[text](url)` HTTPS/HTTP 外链与安全的站内相对链接
 * - `![alt](url)` HTTPS 或 `/api/uploads/` 站内图片
 * - 行内自动转义 HTML
 */
import React, { Fragment } from "react";

interface Props {
  source: string;
  /** 页面已有主标题时，将 Markdown 标题整体下移一级，避免出现多个 h1。 */
  demoteHeadings?: boolean;
}

interface Token {
  kind: "codeblock" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "quote" | "ul" | "ol" | "hr" | "image" | "table";
  raw?: string;
  lang?: string;
  items?: string[];
  headers?: string[];
  rows?: string[][];
  alignments?: TableAlignment[];
}

type TableAlignment = "left" | "center" | "right" | null;

type SafeLinkDestination = {
  href: string;
  external: boolean;
};

const SITE_URL_BASE = "https://markdown-preview.invalid";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 只解码 escapeHtml() 在当前调用中产生的一层实体，供 URL 校验使用。
 * `&amp;quot;` 会解码为字面量 `&quot;` 而不是引号，避免二次实体解码。
 */
function decodeEscapedHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function hasUnsafeUrlCharacters(value: string): boolean {
  return /[\u0000-\u0020\u007f]/.test(value);
}

/**
 * 链接允许现有的 HTTP(S) 外链，以及保持在当前 origin 的根路径、
 * `./` / `../` 相对路径、query 和 fragment。明确拒绝协议相对 URL
 * 与除 HTTP(S) 以外的所有 scheme。
 */
function safeLinkDestination(escapedUrl: string): SafeLinkDestination | null {
  const href = decodeEscapedHtml(escapedUrl);
  if (!href || href !== href.trim() || hasUnsafeUrlCharacters(href)) return null;
  if (href.startsWith("//") || href.startsWith("\\")) return null;

  if (/^https?:\/\//i.test(href)) {
    try {
      const parsed = new URL(href);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      return { href: escapedUrl, external: true };
    } catch {
      return null;
    }
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;

  try {
    const parsed = new URL(href, SITE_URL_BASE);
    if (parsed.origin !== SITE_URL_BASE) return null;
    return { href: escapedUrl, external: false };
  } catch {
    return null;
  }
}

/** 图片延续原安全边界：只允许 HTTPS 与规范化后的站内上传路径。 */
function safeImageDestination(escapedUrl: string): string | null {
  const src = decodeEscapedHtml(escapedUrl);
  if (!src || src !== src.trim() || hasUnsafeUrlCharacters(src)) return null;
  if (src.startsWith("//") || src.startsWith("\\")) return null;

  if (/^https:\/\//i.test(src)) {
    try {
      const parsed = new URL(src);
      return parsed.protocol === "https:" ? escapedUrl : null;
    } catch {
      return null;
    }
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;

  try {
    const parsed = new URL(src, SITE_URL_BASE);
    if (parsed.origin !== SITE_URL_BASE) return null;
    if (!parsed.pathname.startsWith("/api/uploads/")) return null;
    return escapedUrl;
  } catch {
    return null;
  }
}

function applyInlineStyles(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="md-bold">$1</strong>')
    .replace(/__([^_]+)__/g, '<strong class="md-bold">$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em class="md-italic">$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em class="md-italic">$2</em>')
    .replace(/==([^=]+)==/g, '<mark class="md-mark">$1</mark>')
    .replace(/!!([^!]+)!!/g, '<span class="md-fluo">$1</span>');
}

/**
 * 同一次扫描同时处理 image/link，`!` 是匹配的一部分，因此图片不会先被
 * 链接规则消费。URL 和 alt 仍使用 escapeHtml() 后的值构造属性。
 */
function renderInlineMarkup(escaped: string): string {
  const markdownDestination = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  let output = "";
  let cursor = 0;

  for (const match of escaped.matchAll(markdownDestination)) {
    const index = match.index ?? 0;
    output += applyInlineStyles(escaped.slice(cursor, index));

    const [whole, imageMarker, label, destination] = match;
    if (imageMarker === "!") {
      const safeSrc = safeImageDestination(destination);
      output += safeSrc
        ? `<img src="${safeSrc}" alt="${label}" class="md-image md-image--inline" loading="lazy" />`
        : applyInlineStyles(whole);
    } else {
      const safeLink = safeLinkDestination(destination);
      if (!safeLink) {
        output += applyInlineStyles(whole);
      } else if (safeLink.external) {
        output += `<a href="${safeLink.href}" target="_blank" rel="noopener noreferrer" class="md-link">${applyInlineStyles(label)}</a>`;
      } else {
        output += `<a href="${safeLink.href}" class="md-link">${applyInlineStyles(label)}</a>`;
      }
    }
    cursor = index + whole.length;
  }

  return output + applyInlineStyles(escaped.slice(cursor));
}

/** 行内强调 / code / link / image */
function inline(s: string): string {
  const escaped = escapeHtml(s);
  return escaped
    .split(/(`[^`\n]+`)/g)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        return `<code class="md-code">${part.slice(1, -1)}</code>`;
      }
      return renderInlineMarkup(part);
    })
    .join("");
}

function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\" && value[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseTableAlignment(cell: string): TableAlignment | undefined {
  const value = cell.trim();
  if (!/^:?-{3,}:?$/.test(value)) return undefined;
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  if (value.startsWith(":")) return "left";
  return null;
}

function parseTableAt(lines: string[], index: number): { token: Token; nextIndex: number } | null {
  const headerLine = lines[index];
  const separatorLine = lines[index + 1];
  if (separatorLine === undefined || !headerLine.includes("|") || !separatorLine.includes("|")) return null;

  const headers = splitTableRow(headerLine);
  const separatorCells = splitTableRow(separatorLine);
  if (headers.length === 0 || headers.length !== separatorCells.length) return null;

  const alignments = separatorCells.map(parseTableAlignment);
  if (alignments.some((alignment) => alignment === undefined)) return null;

  const rows: string[][] = [];
  let cursor = index + 2;
  while (cursor < lines.length && lines[cursor].trim() !== "" && lines[cursor].includes("|")) {
    const row = splitTableRow(lines[cursor]).slice(0, headers.length);
    while (row.length < headers.length) row.push("");
    rows.push(row);
    cursor += 1;
  }

  return {
    token: {
      kind: "table",
      headers,
      rows,
      alignments: alignments as TableAlignment[],
    },
    nextIndex: cursor,
  };
}

function tokenize(src: string): Token[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const tokens: Token[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 代码围栏
    const fence = /^```\s*([a-zA-Z0-9_-]*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      tokens.push({ kind: "codeblock", raw: buf.join("\n"), lang });
      i++; // 跳过结尾 ```
      continue;
    }

    // GFM 表格：表头与分隔行必须都显式包含 pipe，避免把普通段落 + `---` 误判为表格。
    const table = parseTableAt(lines, i);
    if (table) {
      tokens.push(table.token);
      i = table.nextIndex;
      continue;
    }

    // 分隔线
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      tokens.push({ kind: "hr" });
      i++;
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      const level = h[1].length;
      tokens.push({ kind: (`h${level}` as Token["kind"]), raw: h[2] });
      i++;
      continue;
    }

    // 引用块（连续多行）
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      tokens.push({ kind: "quote", raw: buf.join("\n") });
      continue;
    }

    // 独立图片行 ![alt](url)
    const imageMatch = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (imageMatch) {
      tokens.push({ kind: "image", raw: line });
      i++;
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+\S/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+\S/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s+/, ""));
        i++;
      }
      tokens.push({ kind: "ul", items });
      continue;
    }

    // 有序列表
    if (/^\d+\.\s+\S/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+\S/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      tokens.push({ kind: "ol", items });
      continue;
    }

    // 段落（合并到下一空行）
    if (line.trim() === "") {
      i++;
      continue;
    }
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6}\s|>\s?|[-*+]\s|\d+\.\s|```|!\[)/.test(lines[i]) &&
      !parseTableAt(lines, i)
    ) {
      buf.push(lines[i]);
      i++;
    }
    tokens.push({ kind: "p", raw: buf.join("\n") });
  }
  return tokens;
}

export function MarkdownPreview({ source, demoteHeadings = false }: Props) {
  const tokens = tokenize(source);
  return (
    <div className="md-preview">
      {tokens.map((t, idx) => {
        switch (t.kind) {
          case "h1":
            if (demoteHeadings) {
              return <h2 key={idx} className="md-h1" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "") }} />;
            }
            return <h1 key={idx} className="md-h1" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "") }} />;
          case "h2":
            if (demoteHeadings) {
              return <h3 key={idx} className="md-h2" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "") }} />;
            }
            return <h2 key={idx} className="md-h2" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "") }} />;
          case "h3":
            if (demoteHeadings) {
              return <h4 key={idx} className="md-h3" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "") }} />;
            }
            return <h3 key={idx} className="md-h3" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "") }} />;
          case "h4":
            if (demoteHeadings) {
              return <h5 key={idx} className="md-h4" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "") }} />;
            }
            return <h4 key={idx} className="md-h4" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "") }} />;
          case "h5":
            if (demoteHeadings) {
              return <h6 key={idx} className="md-h5" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "") }} />;
            }
            return <h5 key={idx} className="md-h5" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "") }} />;
          case "h6":
            return <h6 key={idx} className="md-h6" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "") }} />;
          case "p":
            return <p key={idx} className="md-p" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "").replace(/\n/g, "<br/>") }} />;
          case "quote":
            return <blockquote key={idx} className="md-quote" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "").replace(/\n/g, "<br/>") }} />;
          case "ul":
            return (
              <ul key={idx} className="md-ul">
                {(t.items ?? []).map((it, j) => (
                  <li key={j} dangerouslySetInnerHTML={{ __html: inline(it) }} />
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={idx} className="md-ol">
                {(t.items ?? []).map((it, j) => (
                  <li key={j} dangerouslySetInnerHTML={{ __html: inline(it) }} />
                ))}
              </ol>
            );
          case "hr":
            return <hr key={idx} className="md-hr" />;
          case "image": {
            const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec((t.raw ?? "").trim());
            if (m) {
              const escapedSrc = escapeHtml(m[2]);
              const safeSrc = safeImageDestination(escapedSrc);
              if (safeSrc) {
                return <img key={idx} src={decodeEscapedHtml(safeSrc)} alt={m[1]} className="md-image" loading="lazy" />;
              }
            }
            return <p key={idx} dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "") }} />;
          }
          case "table":
            return (
              <div
                key={idx}
                className="md-table-wrap"
                role="region"
                aria-label="可横向滚动的表格"
                tabIndex={0}
              >
                <table className="md-table">
                  <thead>
                    <tr>
                      {(t.headers ?? []).map((header, columnIndex) => {
                        const alignment = t.alignments?.[columnIndex] ?? null;
                        return (
                          <th
                            key={columnIndex}
                            scope="col"
                            style={alignment ? { textAlign: alignment } : undefined}
                            dangerouslySetInnerHTML={{ __html: inline(header) }}
                          />
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {(t.rows ?? []).map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, columnIndex) => {
                          const alignment = t.alignments?.[columnIndex] ?? null;
                          return (
                            <td
                              key={columnIndex}
                              style={alignment ? { textAlign: alignment } : undefined}
                              dangerouslySetInnerHTML={{ __html: inline(cell) }}
                            />
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "codeblock":
            return (
              <pre key={idx} className="md-pre">
                {t.lang && <span className="md-pre-lang">{t.lang}</span>}
                <code>{t.raw}</code>
              </pre>
            );
          default:
            return <Fragment key={idx} />;
        }
      })}
      {tokens.length === 0 && (
        <p className="text-sm text-faint">（暂无内容，开始写点什么吧）</p>
      )}
    </div>
  );
}
