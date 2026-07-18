/**
 * 极简 Markdown 渲染器（仅用于预览，不依赖第三方库）。
 *
 * 支持：
 * - `# / ## / ### / ####` 标题
 * - `**bold**` / `*italic*` / `__bold__` / `_italic_`
 * - `` `code` `` 行内代码
 * - ` ```lang\n...\n``` ` 代码块
 * - `> quote` 引用块
 * - `- * +` 无序列表 / `1.` 有序列表
 * - `---` 分隔线
 * - `[text](url)` 链接（外部，新窗口打开）
 * - 行内自动转义 HTML
 */
import { Fragment } from "react";

interface Props {
  source: string;
  /** 页面已有主标题时，将 Markdown 标题整体下移一级，避免出现多个 h1。 */
  demoteHeadings?: boolean;
}

interface Token {
  kind: "codeblock" | "h1" | "h2" | "h3" | "h4" | "p" | "quote" | "ul" | "ol" | "hr";
  raw?: string;
  lang?: string;
  items?: string[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 行内强调 / code / link */
function inline(s: string): string {
  const escaped = escapeHtml(s);
  return escaped
    .split(/(`[^`\n]+`)/g)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        return `<code class="md-code">${part.slice(1, -1)}</code>`;
      }

      let out = part;
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong class="md-bold">$1</strong>');
      out = out.replace(/__([^_]+)__/g, '<strong class="md-bold">$1</strong>');
      out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em class="md-italic">$2</em>');
      out = out.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em class="md-italic">$2</em>');
      out = out.replace(/==([^=]+)==/g, '<mark class="md-mark">$1</mark>');
      out = out.replace(/!!([^!]+)!!/g, '<span class="md-fluo">$1</span>');
      out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, t: string, u: string) =>
        `<a href="${u}" target="_blank" rel="noopener" class="md-link">${t}</a>`,
      );
      return out;
    })
    .join("");
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

    // 分隔线
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      tokens.push({ kind: "hr" });
      i++;
      continue;
    }

    // 标题
    const h = /^(#{1,4})\s+(.+)$/.exec(line);
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
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4}\s|>\s?|[-*+]\s|\d+\.\s|```)/.test(lines[i])) {
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
