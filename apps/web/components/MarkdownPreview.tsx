/**
 * 极简 Markdown 渲染器（仅用于预览）。
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
 * - `$...$` 行内数学公式 / `$$...$$` 块级数学公式（KaTeX 渲染）
 * - 行内自动转义 HTML
 */
import React, { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

// F4：KaTeX 改为按需加载——不再静态 `import katex`（会落入共享 chunk）。
// module 级缓存 + 实例引用：renderMath 是同步调用，无法 await，因此在加载
// 完成后缓存 katex 实例并发一次 re-render；尚未加载时公式以纯文本回退显示，
// 加载完成后自动重渲为 KaTeX HTML，渲染行为与原先一致。
let katexInstance: typeof import("katex") | null = null;
let katexLoadPromise: Promise<typeof import("katex")> | null = null;

function loadKatex(): Promise<typeof import("katex")> {
  if (katexInstance) return Promise.resolve(katexInstance);
  if (!katexLoadPromise) {
    // F4：KaTeX 原先在根 layout 全局静态 import（全站每页下载 CSS/字体）；
    // 改为按需 dynamic import——仅在实际渲染含公式的页面才加载 JS 与 CSS。
    katexLoadPromise = Promise.all([
      import("katex"),
      import("katex/dist/katex.min.css"),
    ]).then(([mod]) => {
      // katex 是 CommonJS 模块：webpack 把导出 attach 到命名空间（含 `default`）。
      // 取 `default` 若存在，否则用命名空间本身。
      const candidate = (mod as { default?: unknown }).default;
      const instance = (candidate && typeof candidate === "object" ? candidate : mod) as typeof import("katex");
      katexInstance = instance;
      return instance;
    }).catch(() => {
      // 加载失败：清除 promise 允许后续重试，当前以纯文本回退。
      katexLoadPromise = null;
      throw new Error("katex load failed");
    });
  }
  return katexLoadPromise;
}

interface Props {
  source: string;
  /** 页面已有主标题时，将 Markdown 标题整体下移一级，避免出现多个 h1。 */
  demoteHeadings?: boolean;
  /** 只读审计页可禁用远程图片，避免打开历史记录时向第三方发送网络请求。 */
  allowRemoteImages?: boolean;
}

interface GalleryImage {
  src: string;
  alt: string;
}

interface LightboxState {
  images: GalleryImage[];
  index: number;
}

interface Token {
  kind: "codeblock" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "quote" | "ul" | "ol" | "hr" | "image" | "table" | "math";
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
function safeImageDestination(escapedUrl: string, allowRemoteImages = true): string | null {
  const src = decodeEscapedHtml(escapedUrl);
  if (!src || src !== src.trim() || hasUnsafeUrlCharacters(src)) return null;
  if (src.startsWith("//") || src.startsWith("\\")) return null;

  if (/^https:\/\//i.test(src)) {
    if (!allowRemoteImages) return null;
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
function renderInlineMarkup(escaped: string, allowRemoteImages: boolean): string {
  const markdownDestination = /(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  let output = "";
  let cursor = 0;

  for (const match of escaped.matchAll(markdownDestination)) {
    const index = match.index ?? 0;
    output += applyInlineStyles(escaped.slice(cursor, index));

    const [whole, imageMarker, label, destination] = match;
    if (imageMarker === "!") {
      const safeSrc = safeImageDestination(destination, allowRemoteImages);
      output += safeSrc
        ? `<img src="${safeSrc}" alt="${label}" class="md-image md-image--inline" loading="lazy" />`
        : /^https:\/\//i.test(decodeEscapedHtml(destination)) && !allowRemoteImages
          ? `<span class="md-image-blocked">远程图片未自动加载：${label || "未命名图片"}</span>`
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

/**
 * 用 KaTeX 渲染数学公式，失败时回退为纯文本。
 * formula 已经过 escapeHtml 处理，需要先 decode 还原 LaTeX 反斜杠等字符。
 * F4：katex 为按需加载——加载完成前以纯文本回退（加载后组件 re-render 补渲）。
 */
function renderMath(escapedFormula: string, displayMode: boolean): string {
  const formula = decodeEscapedHtml(escapedFormula);
  const instance = katexInstance;
  if (!instance) return escapedFormula;
  try {
    return instance.renderToString(formula, { throwOnError: false, displayMode });
  } catch {
    return escapedFormula;
  }
}

/** 行内数学公式 $...$ 分割，交由 KaTeX 渲染，其余走 renderInlineMarkup */
function renderInlineMath(s: string, allowRemoteImages: boolean): string {
  return s
    .split(/(\$[^$\n]+\$)/g)
    .map((part) => {
      if (part.startsWith("$") && part.endsWith("$") && part.length > 2) {
        return renderMath(part.slice(1, -1), false);
      }
      return renderInlineMarkup(part, allowRemoteImages);
    })
    .join("");
}

/** 行内强调 / code / link / image / inline math */
function inline(s: string, allowRemoteImages: boolean): string {
  const escaped = escapeHtml(s);
  return escaped
    .split(/(`[^`\n]+`)/g)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        return `<code class="md-code">${part.slice(1, -1)}</code>`;
      }
      return renderInlineMath(part, allowRemoteImages);
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

    // 块级数学公式 $$...$$（单行）
    const blockMath = /^\$\$(.+)\$\$$/.exec(line);
    if (blockMath) {
      tokens.push({ kind: "math", raw: blockMath[1] });
      i++;
      continue;
    }

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
      !/^(#{1,6}\s|>\s?|[-*+]\s|\d+\.\s|```|!\[|\$\$)/.test(lines[i]) &&
      !parseTableAt(lines, i)
    ) {
      buf.push(lines[i]);
      i++;
    }
    tokens.push({ kind: "p", raw: buf.join("\n") });
  }
  return tokens;
}

export const MarkdownPreview = React.memo(function MarkdownPreview({ source, demoteHeadings = false, allowRemoteImages = true }: Props) {
  const [katexReady, bumpKatexReady] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    let cancelled = false;
    // F4：按需加载 KaTeX，完成后 re-render 补渲公式。
    loadKatex()
      .then(() => {
        if (!cancelled) bumpKatexReady();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // 仅首次挂载需要；katexReady 变化只为触发重渲。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  void katexReady;
  const tokens = useMemo(() => tokenize(source), [source]);
  const containerRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  const closeLightbox = useCallback(() => setLightbox(null), []);

  const goNext = useCallback(() => {
    setLightbox((current) => {
      if (!current) return current;
      const len = current.images.length;
      if (len <= 1) return current;
      return { ...current, index: (current.index + 1) % len };
    });
  }, []);

  const goPrev = useCallback(() => {
    setLightbox((current) => {
      if (!current) return current;
      const len = current.images.length;
      if (len <= 1) return current;
      return { ...current, index: (current.index - 1 + len) % len };
    });
  }, []);

  // 仅在 lightbox 打开/关闭时重新挂载监听器，避免每次切换图片都重订阅
  const lightboxOpen = lightbox !== null;
  useEffect(() => {
    if (!lightbox) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeLightbox();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      }
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // 打开时将焦点移到关闭按钮，关闭后恢复到原元素
    closeBtnRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      lastFocusedRef.current?.focus();
      lastFocusedRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightboxOpen, closeLightbox, goNext, goPrev]);

  const handlePreviewClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== "IMG" || !target.classList.contains("md-image")) return;
      const container = containerRef.current;
      if (!container) return;
      lastFocusedRef.current = target as HTMLImageElement;
      const allImgs = Array.from(
        container.querySelectorAll<HTMLImageElement>("img.md-image"),
      ).map((img) => ({
        src: img.currentSrc || img.src,
        alt: img.alt || "",
      }));
      if (allImgs.length === 0) return;
      const clickedSrc = (target as HTMLImageElement).currentSrc || (target as HTMLImageElement).src;
      const clickedIndex = allImgs.findIndex((img) => img.src === clickedSrc);
      setLightbox({
        images: allImgs,
        index: clickedIndex >= 0 ? clickedIndex : 0,
      });
    },
    [],
  );

  return (
    <div className="md-preview" ref={containerRef} onClick={handlePreviewClick}>
      {tokens.map((t, idx) => {
        switch (t.kind) {
          case "h1":
            if (demoteHeadings) {
              return <h2 key={idx} className="md-h1" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages) }} />;
            }
            return <h1 key={idx} className="md-h1" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages) }} />;
          case "h2":
            if (demoteHeadings) {
              return <h3 key={idx} className="md-h2" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages) }} />;
            }
            return <h2 key={idx} className="md-h2" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages) }} />;
          case "h3":
            if (demoteHeadings) {
              return <h4 key={idx} className="md-h3" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages) }} />;
            }
            return <h3 key={idx} className="md-h3" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages) }} />;
          case "h4":
            if (demoteHeadings) {
              return <h5 key={idx} className="md-h4" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages) }} />;
            }
            return <h4 key={idx} className="md-h4" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages) }} />;
          case "h5":
            if (demoteHeadings) {
              return <h6 key={idx} className="md-h5" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages) }} />;
            }
            return <h5 key={idx} className="md-h5" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages) }} />;
          case "h6":
            return <h6 key={idx} className="md-h6" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages) }} />;
          case "p":
            return <p key={idx} className="md-p" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages).replace(/\n/g, "<br/>") }} />;
          case "quote":
            return <blockquote key={idx} className="md-quote" dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages).replace(/\n/g, "<br/>") }} />;
          case "ul":
            return (
              <ul key={idx} className="md-ul">
                {(t.items ?? []).map((it, j) => (
                  <li key={j} dangerouslySetInnerHTML={{ __html: inline(it, allowRemoteImages) }} />
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={idx} className="md-ol">
                {(t.items ?? []).map((it, j) => (
                  <li key={j} dangerouslySetInnerHTML={{ __html: inline(it, allowRemoteImages) }} />
                ))}
              </ol>
            );
          case "hr":
            return <hr key={idx} className="md-hr" />;
          case "image": {
            const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec((t.raw ?? "").trim());
            if (m) {
              const escapedSrc = escapeHtml(m[2]);
              const safeSrc = safeImageDestination(escapedSrc, allowRemoteImages);
              if (safeSrc) {
                return <img key={idx} src={decodeEscapedHtml(safeSrc)} alt={m[1]} className="md-image" loading="lazy" />;
              }
              if (/^https:\/\//i.test(m[2]) && !allowRemoteImages) {
                return <p key={idx} className="md-image-blocked">远程图片未自动加载：{m[1] || "未命名图片"}</p>;
              }
            }
            return <p key={idx} dangerouslySetInnerHTML={{ __html: inline(t.raw ?? "", allowRemoteImages) }} />;
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
                            dangerouslySetInnerHTML={{ __html: inline(header, allowRemoteImages) }}
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
                              dangerouslySetInnerHTML={{ __html: inline(cell, allowRemoteImages) }}
                            />
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "math":
            return <div key={idx} className="md-math" dangerouslySetInnerHTML={{ __html: renderMath(escapeHtml(t.raw ?? ""), true) }} />;
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

      {lightbox && (() => {
        const current = lightbox.images[lightbox.index];
        if (!current) return null;
        const hasMultiple = lightbox.images.length > 1;
        return (
          <div
            className="md-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="图片预览"
            onClick={closeLightbox}
          >
            <button
              ref={closeBtnRef}
              type="button"
              className="md-lightbox-close"
              aria-label="关闭图片预览"
              onClick={closeLightbox}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            {hasMultiple && (
              <>
                <button
                  type="button"
                  className="md-lightbox-nav md-lightbox-nav--prev"
                  aria-label="上一张图片"
                  onClick={(e) => {
                    e.stopPropagation();
                    goPrev();
                  }}
                >
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="md-lightbox-nav md-lightbox-nav--next"
                  aria-label="下一张图片"
                  onClick={(e) => {
                    e.stopPropagation();
                    goNext();
                  }}
                >
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </>
            )}
            <img
              src={current.src}
              alt={current.alt}
              className="md-lightbox-img"
              onClick={(e) => e.stopPropagation()}
            />
            {current.alt && (
              <p className="md-lightbox-caption">{current.alt}</p>
            )}
            {hasMultiple && (
              <p className="md-lightbox-counter">
                {lightbox.index + 1} / {lightbox.images.length}
              </p>
            )}
          </div>
        );
      })()}
    </div>
  );
});
