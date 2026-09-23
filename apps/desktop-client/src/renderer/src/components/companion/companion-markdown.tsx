/**
 * 伴星可见正文的 markdown 渲染（方案 29 §4.8，抱怨 #10「只能输出纯文本」）。
 *
 * 服务端从这批起**不再剥 markdown**（`sanitizeCompanionVisibleText`），结构留在正文里，
 * 排版责任落到这里。所以这个渲染器只做两件事：把常见的行内/块级标记变成元素，
 * 以及**绝不解释 HTML**——所有文字都走 React 文本节点，模型写出 `<img onerror=…>`
 * 也只会作为字面文字出现（有单测钉住）。
 *
 * 流式友好是硬要求：她正在被打字的地方会出现"标记没闭合"的中间态
 * （`这一步要**先关燃气`）。这种情况下按字面显示，不吞字符、不提前整段变粗——
 * 已下发前缀之后还会变，任何"猜闭合"的做法都会让文字在用户眼前跳变。
 */
import type { ReactNode } from "react";
import { openCompanionExternalLink } from "./companion-link";

/**
 * 行内标记。斜体那条刻意要求星号两侧都不是空白，否则 `长 * 宽 * 高`
 * 这种乘法写法会被吃成 `长  宽  高`——静默改内容比不渲染更坏（旧剥离器踩过）。
 *
 * 链接只认 `http(s):`：`javascript:`、`data:` 这类不解析成结构，照原文留成**文本**
 * （这里没有 `dangerouslySetInnerHTML`，所以它既点不动也执行不了）。
 */
const INLINE_PATTERN = /(?<code>`[^`\n]+`)|(?<link>\[(?<label>[^\]\n]+)\]\((?<url>https?:[^)\s]*)\))|(?<bold>\*\*(?<boldText>[^*\n]+?)\*\*)|(?<![\w*])\*(?<emText>[^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const groups = match.groups ?? {};
    if (groups.code) nodes.push(<code key={`${keyBase}-${index}`}>{groups.code.slice(1, -1)}</code>);
    else if (groups.link) {
      // 画成能点的，是因为**真能点开**：一条只放行 http/https 的 `shell.openExternal`
      // 通道（方案 35 F7）。协议白名单两边同一份（合同里的 `isWebLinkUrl`），所以不会
      // 出现"这里画了颗按钮、主进程把它拒了"。`javascript:`、`data:` 这类根本不解析成
      // 结构，照原文留成文本。
      // 去处仍然写在下面一行：打不开时（系统没有默认浏览器等）它至少还能被复制。
      nodes.push(
        <button
          type="button"
          className="companion-md__link"
          key={`${keyBase}-${index}`}
          onClick={() => { void openCompanionExternalLink(groups.url); }}
        >
          <span>{groups.label}</span>
          <small>{groups.url}</small>
        </button>,
      );
    }
    else if (groups.bold) nodes.push(<strong key={`${keyBase}-${index}`}>{groups.boldText}</strong>);
    else if (groups.emText) nodes.push(<em key={`${keyBase}-${index}`}>{groups.emText}</em>);
    last = at + match[0].length;
    index += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const FENCE_LINE = /^```[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9+#-]*)[ \t]*$/;
const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

function isBlockStart(line: string): boolean {
  return FENCE_OPEN.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line);
}

/**
 * 气泡用的**纯文本投影**。
 *
 * 宠物旁边那个气泡是"单节点槽位"：一次只放一句、按字符显现，没有排版可言；
 * 而显现驱动器数的是字符数，留着 `**` 就会露出标记符号。所以结构留在抽屉/记录页
 * （`renderCompanionMarkdown`），气泡这里把标记去掉——这是**呈现层的取舍**，
 * 不再是服务端把她的输出改平。
 */
export function plainCompanionBubbleText(text: string): string {
  return text
    .replace(/^```[^\n]*\n?/gm, "")
    .replace(/^```\s*$/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

/** 入口：一段可见正文 → 一组 React 节点。 */
export function renderCompanionMarkdown(text: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let cursor = 0;
  let key = 0;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim().length === 0) {
      cursor += 1;
      continue;
    }

    const fence = line.match(FENCE_OPEN);
    if (fence) {
      const body: string[] = [];
      cursor += 1;
      // 没闭合也照收（流式中）：把剩下的行都当代码，比"半个围栏符号"好看。
      while (cursor < lines.length && !FENCE_LINE.test(lines[cursor])) {
        body.push(lines[cursor]);
        cursor += 1;
      }
      cursor += 1;
      blocks.push(
        <pre className="companion-md__code" data-lang={fence[1] || undefined} key={`b${key++}`}>
          {body.join("\n")}
        </pre>,
      );
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push(
        <p className="companion-md__heading" key={`b${key++}`}>
          {renderInline(heading[1], `h${key}`)}
        </p>,
      );
      cursor += 1;
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = NUMBERED.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (cursor < lines.length && pattern.test(lines[cursor])) {
        items.push(lines[cursor].match(pattern)![1]);
        cursor += 1;
      }
      const children = items.map((item, n) => <li key={`li${n}`}>{renderInline(item, `l${key}-${n}`)}</li>);
      blocks.push(ordered
        ? <ol className="companion-md__list" key={`b${key++}`}>{children}</ol>
        : <ul className="companion-md__list" key={`b${key++}`}>{children}</ul>);
      continue;
    }

    const paragraph: string[] = [];
    while (
      cursor < lines.length
      && lines[cursor].trim().length > 0
      && !isBlockStart(lines[cursor])
    ) {
      paragraph.push(lines[cursor]);
      cursor += 1;
    }
    const nodes: ReactNode[] = [];
    paragraph.forEach((row, n) => {
      if (n > 0) nodes.push(<br key={`br${n}`} />);
      nodes.push(...renderInline(row, `p${key}-${n}`));
    });
    blocks.push(<p className="companion-md__para" key={`b${key++}`}>{nodes}</p>);
  }

  return blocks;
}
