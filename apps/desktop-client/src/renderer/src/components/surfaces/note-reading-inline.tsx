import type { ReactNode } from "react";
import { parseInlineMarkdown, type NoteDocInlineSegment } from "@ailearn/shared/note-doc-schema";
import { isWebLinkUrl } from "@ailearn/shared/desktop-ipc-contracts";
import { noteBlockText } from "./surface-data";
import { ZoomableReadingImage } from "./image-viewer";
import { useSourceImage } from "./source-image";
import { openExternalLink } from "../../app/external-link";

/**
 * 阅读页怎么画一块正文。
 *
 * 一块的 `content` 不是"一行纯文本"，它是**带结构的 Markdown 原文**：段内换行是 `\n`、
 * 粗体是 `**`、图片是 `![](...)`。这三样以前都按字面画进 `<p>`，于是
 * 「编辑器里换的行在预览里没了」「`**重点**` 露着星号」「段落里的图整张看不见」。
 *
 * 所以这里不引入第二种语法：行内解析用 `note-doc-schema` 里那一份（服务端把块写回文档、
 * 编辑器写出的也是它），只是**画**出来。
 *
 * `Atom` 是这条路的中间形状：一个原子带自己在**显示文本**里的偏移区间。偏移只准有一份，
 * 因为「概念句」那条高亮是按字符区间切的——它和渲染各算一份，高亮就会整体错位几个
 * 标记符号的距离。图片是原子节点，不占字符（`start === end`）。
 */
export type NoteInlineAtom =
  | { readonly kind: "text" | "strong" | "em" | "strike" | "code"; readonly text: string; readonly start: number; readonly end: number }
  | { readonly kind: "link"; readonly text: string; readonly href: string; readonly start: number; readonly end: number }
  | { readonly kind: "image"; readonly alt: string; readonly src: string; readonly start: number; readonly end: number }
  | { readonly kind: "break"; readonly start: number; readonly end: number };

/** CommonMark 的"反斜杠转义只挡 ASCII 标点"，还原的就是这一批。 */
const MARKDOWN_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

/**
 * 反斜杠转义还原成它挡着的那个字符。编辑器解析过 Markdown，画出来的是 `~`；
 * 阅读页不还原就会露出 `干杯\~-bilibili` 这种字面串。
 *
 * 只在**文本**那一侧做：行内代码里的反斜杠是内容不是转义（`` `a\b` `` 还原成 `ab`
 * 就是静默改代码）。
 */
function unescapeMarkdown(value: string): string {
  return value.replace(MARKDOWN_ESCAPE, "$1");
}

const ESCAPABLE: Record<string, true> = { text: true, strong: true, em: true, strike: true, link: true };

/** 一段块的正文 → 原子序列（含行与行之间那个 `\n` 对应的 `break`）。 */
export function noteInlineAtoms(content: string): NoteInlineAtom[] {
  const lines = noteBlockText(content).split("\n");
  const atoms: NoteInlineAtom[] = [];
  let cursor = 0;
  lines.forEach((line, index) => {
    if (index > 0) {
      atoms.push({ kind: "break", start: cursor, end: cursor + 1 });
      cursor += 1;
    }
    for (const segment of parseInlineMarkdown(line)) {
      if (segment.kind === "image") {
        // 图片不占显示字符：高亮的偏移量算的是"看得见的字"。
        atoms.push({ kind: "image", alt: segment.alt, src: segment.src, start: cursor, end: cursor });
        continue;
      }
      const text = ESCAPABLE[segment.kind] === true ? unescapeMarkdown(segment.text) : segment.text;
      const at = { start: cursor, end: cursor + text.length };
      atoms.push(segment.kind === "link"
        ? { kind: "link", text, href: segment.href, ...at }
        : { kind: segment.kind, text, ...at });
      cursor += text.length;
    }
  });
  return atoms;
}

/** 这一屏真正显示出来的那几个字。概念句的高亮区间按它算，与渲染同源。 */
export function noteInlineDisplayText(content: string): string {
  return noteInlineAtoms(content).map((atom) => {
    if (atom.kind === "break") return "\n";
    if (atom.kind === "image") return "";
    return atom.text;
  }).join("");
}

/** 这一块里画得出来的图片有几张（整篇画廊要按正文顺序编号）。 */
export function noteInlineImageCount(content: string): number {
  return noteInlineImages(content).length;
}

/** 这一块里的行内图片，按正文顺序。整篇画廊要拿它编号，渲染要拿它画，同一份来源。 */
export function noteInlineImages(content: string): { readonly src: string; readonly alt: string }[] {
  return noteInlineAtoms(content).flatMap((atom) => (atom.kind === "image" ? [{ src: atom.src, alt: atom.alt }] : []));
}

/**
 * 站内地址（`/api/uploads/...`）在渲染层画不出来：origin 是 `ailearn-app://`，
 * 相对路径会落到应用包内。所以和块级图片走同一条路——带会话令牌取字节，换成 blob。
 */
function InlineImage({
  src,
  alt,
  workspaceEpoch,
  galleryIndex,
  onOpenGallery,
}: {
  readonly src: string;
  readonly alt: string;
  readonly workspaceEpoch?: number;
  /** 这一张在整篇图片画廊里的序号；不传就是这一篇没有画廊，点了只放大这一张。 */
  readonly galleryIndex?: number;
  readonly onOpenGallery?: (index: number) => void;
}) {
  const { state, retry } = useSourceImage(src, workspaceEpoch);
  if (state.status === "loading") return <span className="small">正在载入图片…</span>;
  if (state.status === "unavailable") return <span className="small">这张图片没能取回：{alt || src}</span>;
  if (galleryIndex === undefined || !onOpenGallery) {
    return <ZoomableReadingImage src={state.src} alt={alt} retryable={state.status === "ready"} onRetry={retry} />;
  }
  return (
    <ZoomableReadingImage
      src={state.src}
      alt={alt}
      retryable={state.status === "ready"}
      onRetry={retry}
      // 开关交给整篇画廊接管：受控时组件自己不再叠一层灯箱。
      open={false}
      onOpenChange={(open) => { if (open) onOpenGallery(galleryIndex); }}
    />
  );
}

function wrapKind(kind: NoteInlineAtom["kind"], nodes: ReactNode, key: string): ReactNode {
  if (kind === "strong") return <strong key={key}>{nodes}</strong>;
  if (kind === "em") return <em key={key}>{nodes}</em>;
  if (kind === "strike") return <del key={key}>{nodes}</del>;
  if (kind === "code") return <code key={key}>{nodes}</code>;
  return nodes;
}

/** 一块正文里"整段就是一条分隔线"的写法（编辑器画成 `<hr>`，读侧不能露出三个减号）。 */
const HORIZONTAL_RULE = /^(?:\*{3,}|-{3,}|_{3,})$/;

export function isHorizontalRule(text: string): boolean {
  return HORIZONTAL_RULE.test(text.trim());
}

/**
 * 一块正文 → 按行分组的 React 节点。
 *
 * `mark` 是「概念句」高亮的字符区间，切在显示文本的坐标上（见 `noteInlineDisplayText`）。
 * `galleryStart` 是这一块第一张行内图片在整篇画廊里的序号；不传即这一篇没有画廊。
 * `lineClass` 给每一行套一个 `<span>`（列表项要逐行带记号），此时不再插 `<br>`。
 */
export function renderNoteInline(
  content: string,
  options: {
    readonly mark?: readonly [number, number] | null;
    readonly workspaceEpoch?: number;
    readonly galleryStart?: number;
    readonly onOpenGallery?: (index: number) => void;
    readonly lineClass?: string;
  } = {},
): ReactNode[] {
  const atoms = noteInlineAtoms(content);
  const mark = options.mark ?? null;
  const [from, to] = mark ?? [0, 0];
  let imageSeen = 0;
  const lines: ReactNode[][] = [[]];
  atoms.forEach((atom, index) => {
    const key = `${atom.kind}-${index}`;
    if (atom.kind === "break") {
      lines.push([]);
      return;
    }
    let node: ReactNode;
    if (atom.kind === "image") {
      const galleryIndex = options.galleryStart === undefined ? undefined : options.galleryStart + imageSeen;
      imageSeen += 1;
      node = (
        <InlineImage
          key={key}
          src={atom.src}
          alt={atom.alt}
          workspaceEpoch={options.workspaceEpoch}
          galleryIndex={galleryIndex}
          onOpenGallery={options.onOpenGallery}
        />
      );
    } else {
      node = renderTextAtom(atom, key, mark, [from, to]);
    }
    lines[lines.length - 1]?.push(node);
  });
  if (options.lineClass) {
    return lines.map((nodes, index) => <span className={options.lineClass} key={`line-${index}`}>{nodes}</span>);
  }
  return lines.flatMap((nodes, index) => (index === 0 ? nodes : [<br key={`break-${index}`} />, ...nodes]));
}

function renderTextAtom(
  atom: Extract<NoteInlineAtom, { text: string }>,
  key: string,
  mark: readonly [number, number] | null,
  [from, to]: readonly [number, number],
): ReactNode {
  const cut = (start: number, end: number) => atom.text.slice(start - atom.start, end - atom.start);
  const overlapFrom = Math.max(atom.start, from);
  const overlapTo = Math.min(atom.end, to);
  const marked = mark !== null && overlapFrom < overlapTo;
  let nodes: ReactNode = atom.text;
  if (marked) {
    const parts: ReactNode[] = [];
    if (overlapFrom > atom.start) parts.push(cut(atom.start, overlapFrom));
    parts.push(<span className="mark" key="mark">{cut(overlapFrom, overlapTo)}</span>);
    if (overlapTo < atom.end) parts.push(cut(overlapTo, atom.end));
    nodes = parts;
  }
  if (atom.kind === "link") {
    /**
     * 只把 http(s) 画成能点的：`javascript:`、`data:` 这类不解析成结构，照原文留成
     * 文本。窗口本身永远不导航出去（主进程 `will-navigate` 拦外链），所以"画成能点"
     * 与"真能打开"用的是合同里同一份 `isWebLinkUrl`，不会两套口径。
     */
    if (!isWebLinkUrl(atom.href)) return wrapKind("text", `[${atom.text}](${atom.href})`, key);
    return (
      <a
        key={key}
        href={atom.href}
        onClick={(event) => {
          event.preventDefault();
          void openExternalLink(atom.href);
        }}
      >
        {nodes}
      </a>
    );
  }
  return wrapKind(atom.kind, nodes, key);
}
