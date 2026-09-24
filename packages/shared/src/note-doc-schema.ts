/**
 * 笔记正文的 ProseMirror schema 定义与块形状转换（CRDT 批次 B）。
 *
 * **这里只放纯数据与纯函数**：不 import `yjs`，也不 import `prosemirror-model`。
 * 原因是踩过的坑（写在新内核 `apps/api/src/modules/note/doc-fragment.ts` 文件头）：
 * 本仓没有 workspace 根，`apps/api` 与 `apps/desktop-client` 各有自己的 `node_modules`，
 * 把带 yjs 的模块挪进 shared 会让一个进程里出现两份 yjs，`instanceof` 跨份静默判假，
 * 症状是"块都在、正文全空"。所以共享的是**规格**，`new Schema(spec)` 由各进程自己做一次。
 *
 * 为什么必须有这一份规格：正文换成 `Y.XmlFragment` 之后，fragment 里存的是节点类型名
 * 与属性（批次 A 实测：`prosemirrorJSONToYXmlFragment` 的第一个参数就是 schema）。
 * 服务端要写整篇（导入、来源转笔记、恢复版本）也要投影回 `note_blocks` 的行，
 * 就必须认得编辑器写进来的那些节点；两边各写一份 schema 就是"两个真相"的新版本。
 *
 * 一个不显眼但会丢数据的点：`sourceRef` / `imageAssetId` 在这里是**节点属性**。
 * 不在 schema 里的属性会被编辑器丢掉，而它们正是"来源转笔记"那条证据链的命脉——
 * 恢复历史版本时第一个丢的就是它们。所以它们和 `src`/`alt` 一样必须写进规格。
 */

export type NoteDocBlockSpec = {
  type: string;
  content: string;
  sourceRef?: { sourceId?: string; segmentId?: string } | null;
  imageAssetId?: string | null;
};

/** 我们的块类型 ↔ ProseMirror 节点名。列表/引用在 PM 里是容器，投影时压回一行文本。 */
export const NOTE_BLOCK_NODE_NAMES = {
  paragraph: "paragraph",
  heading: "heading",
  code: "code_block",
  list: "bullet_list",
  quote: "blockquote",
  image: "image",
} as const;

const LIST_ITEM_SEPARATOR = "\n";

/**
 * 每个块节点都带的属性。
 *
 * **必须逐类型声明，不能只给图片块**：`prosemirrorJSONToYXmlFragment` 内部走的是
 * `Node.fromJSON(schema, json)`，而 PM 建节点时只认 schema 里声明过的属性——
 * 没声明的那个键会被**静默丢掉**（实测：给 paragraph 传 `sourceRef` 之后，投影回来
 * 只剩 `{"type":"paragraph","content":[…]}`，一个字符的报错都没有）。段落与标题正是
 * "来源转笔记"最常产出的两种块，所以这两个键漏在这里等于证据链在最常见的那条路上失效。
 */
const blockAttrs = { sourceRef: { default: null }, imageAssetId: { default: null } };

/**
 * 交给 `new Schema(...)` 的规格。`content` 表达式按 ProseMirror 的语法写。
 *
 * `heading.level` 有默认值：编辑器不写它时也要能投影，否则 `Node.fromJSON` 直接报错，
 * 症状是导入整条失败而不是"少个属性"。
 *
 * **这份规格必须覆盖编辑器会产出的那些节点与 mark**（`hardbreak`、`ordered_list`、`hr`、
 * 以及 `strong`/`emphasis`/`code`/`link`/`strike_through` 五个 mark）。名字对不上时
 * `Node.fromJSON` 会**忽略**它不认识的类型，症状是服务端整篇写入把对端的换行、编号列表、
 * 表格线写成别的形状。它与编辑器的真实 schema 由 `note-doc-schema.test.ts` 里那条
 * 名字清单钉住——两边各写一份就是这批一路在消灭的"两个真相"。
 *
 * **位置也要对得上，光名字对不上不行**（2026-09-24 实测，两份 schema 的声明逐条打出来比过）：
 * 编辑器的段落是 `content: "inline*"`、图片是 `inline: true, group: "inline"`，所以
 * 编辑器写出的形状是 `paragraph > image`。规格这边以前写的是段落 `text*` + 图片 `group: "block"`，
 * 于是服务端整篇写入（导入、来源转笔记、恢复历史版本）遇到段落里的一张图，只能把它写成
 * **一个装着 `![配图](/api/uploads/a.png)` 的文本节点**——症状不是丢字，是编辑器把那串
 * 标记当正文显示出来（与行内标记当年那条一模一样）。
 *
 * 现在两边同形：段落与标题收 `inline*`，图片挂在 `inline` 组，块级图片写的是
 * `paragraph > image`（编辑器本来产出的就是这一种）。**存的块类型没跟着变**：
 * `note_blocks.type` 上挂着一条数据库约束
 * （`0046_card_generation_image_pipeline.sql`：`CHECK (image_asset_id IS NULL OR type = 'image')`），
 * 服务端另有十处按 `type === "image"` 分叉（搜索索引、卡片图片管线、导出、正文摘要…），
 * 所以"整段就一张图"在投影那一侧认回 `image`（见 `pmNodesToNoteBlocks`），
 * 一张图夹在字里才归段落。
 *
 * 顺带一条实测：`group: "block inline"`（想同时允许两种位置）会被 prosemirror-model 直接拒掉，
 * 报 `Mixing inline and block content`——图片不能既算块又算行内。
 */
export const noteDocSchemaSpec = {
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block", attrs: blockAttrs },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 2 }, ...blockAttrs } },
    code_block: { content: "text*", group: "block", code: true, attrs: blockAttrs },
    blockquote: { content: "block+", group: "block", attrs: blockAttrs },
    bullet_list: { content: "list_item+", group: "block", attrs: blockAttrs },
    ordered_list: { content: "list_item+", group: "block", attrs: blockAttrs },
    list_item: { content: "paragraph+" },
    image: { inline: true, group: "inline", attrs: { src: { default: "" }, alt: { default: "" }, ...blockAttrs } },
    hr: { group: "block" },
    // `inline: true` 不是装饰：prosemirror-model 判行内只看 `!(spec.inline || name=="text")`，
    // **组名不参与**。少写它，`hardbreak` 就是个块类型，段落那句 `inline*` 当场报
    // `Mixing inline and block content`。以前它挂着 `group:"inline"` 也没出事，只是因为
    // 那两份规格里从没有哪个 content 表达式真的引用过 `inline` 组。
    hardbreak: { inline: true, group: "inline" },
    text: { group: "inline" },
  },
  marks: {
    strong: {},
    emphasis: {},
    // 名字是 `inlineCode` 不是 `code`（实测：编辑器 schema 的 mark 是
    // `emphasis,strong,inlineCode,link,strike_through`）。写成 `code` 的结局两头都错：
    // 服务端写进去的行内代码在对端不认，对端写的行内代码投影回来丢了反引号。
    inlineCode: {},
    link: { attrs: { href: { default: "" } } },
    strike_through: {},
  },
} as const;

type PmJson = {
  type: string;
  text?: string;
  marks?: readonly PmJsonMark[];
  attrs?: Record<string, unknown>;
  content?: PmJson[];
};
type PmJsonMark = { type: string; attrs?: Record<string, unknown> };

const textNode = (content: string): PmJson => ({ type: "text", text: content });

/**
 * 行内 Markdown 的解析结果。**这份定义就是行内语法的唯一事实源**：
 * 阅读页拿它画段（`note-blocks.ts` 的 `parseInlineMarkdown` 现在转过来调它），
 * 服务端把块写进 fragment 也拿它建 mark。两处各解析一遍的结局是"编辑器里的粗体
 * 和阅读页里的粗体不是同一批"，那种错位没人喊。
 */
export type NoteDocInlineSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "em"; readonly text: string }
  | { readonly kind: "strike"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string }
  /**
   * 行内图片。它**没有** `text`：图片是原子节点，不占一个字符，画出来占的是格线
   * 之外的一块。阅读页的「概念句」偏移量按显示文本算，给图片塞进 alt 会让后面所有
   * 字符整体错位——所以这里刻意不给，让每个消费方自己决定怎么对待它。
   */
  | { readonly kind: "image"; readonly alt: string; readonly src: string };

/**
 * 图片那一支必须**在解析器里存在**，而不是只靠链接那一支：`![a](b)` 少了它，解析结果
 * 是「一个 `!` 字符 + 一个链接 `[a](b)`」——图凭空没了，还多出一个感叹号。两支不会在
 * 同一个起点上相撞（一个以 `!` 开头、一个以 `[` 开头），所以先后不是正确性问题，
 * 只是让"更长的形状在前"这条读起来和跑起来一致。
 */
const INLINE_PATTERN =
  /(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(`[^`\n]+`)|(!\[[^\]\n]*\]\(([^)\s]+)\))|(\[[^\]\n]*\]\([^)\s]+\))/g;

export function parseInlineMarkdown(value: string): NoteDocInlineSegment[] {
  const segments: NoteDocInlineSegment[] = [];
  let cursor = 0;
  for (const match of value.matchAll(INLINE_PATTERN)) {
    const at = match.index ?? 0;
    if (at > cursor) segments.push({ kind: "text", text: value.slice(cursor, at) });
    const token = match[0];
    if (token.startsWith("**")) {
      segments.push({ kind: "strong", text: token.slice(2, -2) });
    } else if (token.startsWith("~~")) {
      segments.push({ kind: "strike", text: token.slice(2, -2) });
    } else if (token.startsWith("`")) {
      segments.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("![")) {
      const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      segments.push({ kind: "image", alt: image?.[1] ?? "", src: image?.[2] ?? "" });
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      segments.push({ kind: "link", text: link?.[1] ?? token, href: link?.[2] ?? "" });
    } else {
      segments.push({ kind: "em", text: token.slice(1, -1) });
    }
    cursor = at + token.length;
  }
  if (cursor < value.length) segments.push({ kind: "text", text: value.slice(cursor) });
  return segments;
}

const MARK_BY_SEGMENT: Partial<Record<NoteDocInlineSegment["kind"], string>> = {
  strong: "strong",
  em: "emphasis",
  strike: "strike_through",
  // 编辑器的行内代码 mark 叫 `inlineCode`（实测出的名字清单），不是 `code`。
  code: "inlineCode",
};

function segmentToPmText(segment: NoteDocInlineSegment): PmJson {
  if (segment.kind === "link") {
    return { type: "text", text: segment.text, marks: [{ type: "link", attrs: { href: segment.href } }] };
  }
  if (segment.kind === "image") {
    // 图片是原子节点：地址与说明在**属性**上，不在文本里。写成文本节点的话，编辑器
    // 画出来的就是一串 `![配图](/api/uploads/a.png)`——那是 2026-09-24 实测到的改前形状
    // （导入、来源转笔记、恢复历史版本三条服务端整篇写入都会踩到）。
    return { type: "image", attrs: { src: segment.src, alt: segment.alt } };
  }
  const mark = MARK_BY_SEGMENT[segment.kind];
  return mark
    ? { type: "text", text: segment.text, marks: [{ type: mark }] }
    : textNode(segment.text);
}

/**
 * 一段块的正文 → 节点的子内容。
 *
 * 换行落成 `hardbreak` 节点而不是留在文本里：ProseMirror 的文本节点不该带 `\n`
 * （DOM 会把它折叠成空格，编辑器里两行变一行）。`raw` 那一支给代码块用——
 * 代码里的 `**` 与换行都是内容，不是语法。
 */
function inlineContent(content: string, mode: "markdown" | "raw" = "markdown"): PmJson[] | undefined {
  if (!content.length) return undefined;
  if (mode === "raw") return [textNode(content)];
  const lines = content.split("\n");
  const nodes: PmJson[] = [];
  lines.forEach((line, index) => {
    if (index > 0) nodes.push({ type: "hardbreak" });
    for (const segment of parseInlineMarkdown(line)) nodes.push(segmentToPmText(segment));
  });
  return nodes;
}

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

function parseImageLine(content: string): { src: string; alt: string } {
  const match = IMAGE_LINE.exec(content.trim());
  if (match) return { alt: match[1] ?? "", src: match[2] ?? "" };
  // 认不出 Markdown 语法的图片行（Web 端老数据可能只存了地址）：整串当地址，
  // 说明留空——地址猜错的代价是图裂，把地址当说明写进去的代价是永远修不好。
  return { src: content.trim(), alt: "" };
}

/**
 * 一个块的正文 → 放进 PM 节点里的行内容（空块不给 content，PM 要的是"没有子节点"）。
 *
 * 图片是**原子行内节点**：没有文本、也没有子节点，走到最后那行 `content.map(...)`
 * 只会得到空串。编辑器里那张图在、投影回来却一个字都没有——那是整块内容凭空消失，
 * 而这条投影同时喂着服务端的 `note_blocks`，所以丢的那半不止是预览看不见。
 */
function collectInline(node: PmJson | undefined): string {
  if (!node) return "";
  if (node.type === "hardbreak") return "\n";
  if (node.type === "image") {
    const alt = String(node.attrs?.alt ?? "");
    const src = String(node.attrs?.src ?? "");
    return alt ? `![${alt}](${src})` : `![](${src})`;
  }
  if (typeof node.text === "string") return applyMarks(node.text, node.marks ?? []);
  return (node.content ?? []).map(collectInline).join("");
}

/**
 * mark → 行内 Markdown 语法。
 *
 * 包裹顺序是**从里到外**：code 最里（`` ` `` 里不再认别的语法），然后 strike/strong/em，
 * link 最外。反过来（link 在内）会写出 `[x](u)` 外面再套 `**` 也认、套在中间就不认的串，
 * 下一次解析就换意思了。
 */
function applyMarks(text: string, marks: readonly PmJsonMark[]): string {
  let value = text;
  const names = new Set(marks.map((mark) => mark.type));
  if (names.has("inlineCode")) value = `\`${value}\``;
  if (names.has("strike_through")) value = `~~${value}~~`;
  if (names.has("strong")) value = `**${value}**`;
  if (names.has("emphasis")) value = `*${value}*`;
  for (const mark of marks) {
    if (mark.type !== "link") continue;
    value = `[${value}](${String(mark.attrs?.href ?? "")})`;
  }
  return value;
}

function attrOf(node: PmJson): { sourceRef: NoteDocBlockSpec["sourceRef"]; imageAssetId: string | null } {
  return {
    sourceRef: (node.attrs?.sourceRef as NoteDocBlockSpec["sourceRef"]) ?? null,
    imageAssetId: (node.attrs?.imageAssetId as string | null) ?? null,
  };
}

const CELLS: Record<string, true> = { table_cell: true, table_header: true };
const ROWS: Record<string, true> = { table_row: true, table_header_row: true };

/**
 * GFM 表格 → 一个段落里的 Markdown 表格文本。
 *
 * 今天的约定就是"表格活在段落正文里"（`markdownToBlocks` 没有 table 这一档，
 * `parseMarkdownTable` 在**读**的时候才把那种段落画成表）。所以这里不发明新块类型，
 * 只把节点还原成它存进来时的那个文本形状——分隔行必须给，否则 `parseMarkdownTable`
 * 认不出它是表，一段 `|a|b|` 就按散文画出来了。
 */
function tableToMarkdown(node: PmJson): string {
  const rows = (node.content ?? []).filter((row) => ROWS[row.type]);
  // 一格必须**只占一行**：`parseMarkdownTable` 是按行认表的（每行都要以 `|` 开头结尾），
  // 单元里带进一个换行，那一行就不再像表格线，整张表退回成竖线散文。
  // `|` 同理：它是分隔符，不转义就会凭空多出一列。读侧的反转义在显示那一步做。
  const cellsOf = (row: PmJson) => (row.content ?? [])
    .filter((cell) => CELLS[cell.type])
    .map((cell) => collectInline(cell).replace(/\n+/g, " ").replace(/\|/g, "\\|"));
  const body = rows.map((row) => `| ${cellsOf(row).join(" | ")} |`);
  if (body.length === 0) return "";
  const hasHeader = rows.some((row) => row.type === "table_header_row");
  const widths = cellsOf(rows.find((row) => row.type === "table_header_row") ?? rows[0]!);
  const separator = `| ${widths.map(() => "---").join(" | ")} |`;
  return hasHeader ? [body[0], separator, ...body.slice(1)].join("\n") : [separator, ...body].join("\n");
}

/**
 * ProseMirror 的 JSON → 我们的行。这是 `note_blocks` 唯一的派生口。
 *
 * 认不出的节点类型**当段落画**而不是丢掉那块：那可能只是对端是更新的一版客户端
 * 新增了一种块，因为一个类型名没认出来就不画人家写的字，是最坏的一种保守。
 *
 * 有序列表归进 `list` 会**丢编号**，`code_block` 的语言标记也会丢：这两条不是退化，
 * 是与换形状之前一致——`note_blocks` 从来存不下它们（`LIST_MARKER` 连 `\d+.` 一起剥）。
 * 现在文档是事实源，所以丢的只是投影那一侧：编辑器里编号与语言仍在，搜索/卡片读到的
 * 正文也仍和以前一样。
 */
export function pmNodesToNoteBlocks(nodes: readonly PmJson[]): NoteDocBlockSpec[] {
  return nodes.map((node) => {
    const { sourceRef, imageAssetId } = attrOf(node);
    const extras = { ...(sourceRef ? { sourceRef } : {}), ...(imageAssetId ? { imageAssetId } : {}) };
    switch (node.type) {
      case "heading":
        return { type: "heading", content: collectInline(node), ...extras };
      case "code_block":
        return { type: "code", content: collectInline(node), ...extras };
      case "blockquote":
        return { type: "quote", content: (node.content ?? []).map(collectInline).join("\n"), ...extras };
      case "bullet_list":
      case "ordered_list":
        return {
          type: "list",
          content: (node.content ?? [])
            .map((item) => (item.content ?? []).map(collectInline).join("\n"))
            .join(LIST_ITEM_SEPARATOR),
          ...extras,
        };
      case "image": {
        // 老数据与跨进程向量里那份字节：图片**就是**一个顶层节点。仍然投成 `image`。
        const src = String(node.attrs?.src ?? "");
        const alt = String(node.attrs?.alt ?? "");
        return { type: "image", content: alt ? `![${alt}](${src})` : `![](${src})`, ...extras };
      }
      case "hr":
        // 与 `markdownToBlocks` 的既有约定对齐：一条 `---` 是一个段落，不是新的块类型。
        return { type: "paragraph", content: "---", ...extras };
      case "table":
        return { type: "paragraph", content: tableToMarkdown(node), ...extras };
      case "html":
        return { type: "paragraph", content: String(node.attrs?.value ?? ""), ...extras };
      default: {
        // "整段就一张图"是块级图片在文档里的形状（编辑器里图片是行内节点，写不出顶层图片块），
        // 但它存的仍然是 `image`：那条数据库约束与服务端十处分叉都认这个类型。
        const only = (node.content ?? [])[0];
        if (node.type === "paragraph" && (node.content ?? []).length === 1 && only?.type === "image") {
          return { type: "image", content: collectInline(only), ...extras };
        }
        return { type: "paragraph", content: collectInline(node), ...extras };
      }
    }
  });
}

/**
 * 我们的行 → ProseMirror 的 JSON 节点数组（fragment 的写入形状）。
 *
 * 代码块**不能**压成多段落：`note_blocks.content` 里代码是带换行的一整段，
 * 摊平成多个段落再投影回来就会变成多行列表项——那是静默改内容。
 *
 * **行内 Markdown 必须在这里变成 mark 结构**（批次 C 读侧那半的对称要求）：
 * `note_blocks.content` 存的是 Markdown 原文（`**粗**`、`[字](地址)`），而 fragment 一旦
 * 成为正文事实源，编辑器画的就是 fragment 里的结构。整串字符当一段纯文本写进去，
 * 症状不是丢字，是**编辑器把 `**` 当正文显示出来**——原来在 Markdown 编辑器里是粗体。
 * 所以这里解析，`pmNodesToNoteBlocks` 那侧再序列化回去，两边共用同一个行内解析器。
 */
export function noteBlocksToPmNodes(blocks: readonly NoteDocBlockSpec[]): PmJson[] {
  return blocks.map((block) => {
    const attrs = { sourceRef: block.sourceRef ?? null, imageAssetId: block.imageAssetId ?? null };
    switch (block.type) {
      case "heading":
        return { type: "heading", attrs: { level: 2, ...attrs }, content: inlineContent(block.content) };
      case "code":
        // 代码块里的星号是代码，不是粗体：整段一个字都不动地当一个文本节点放进去。
        return { type: "code_block", attrs, content: inlineContent(block.content, "raw") };
      case "quote":
        return { type: "blockquote", attrs, content: [{ type: "paragraph", content: inlineContent(block.content) }] };
      case "list":
        return {
          type: "bullet_list",
          attrs,
          content: block.content
            .split(LIST_ITEM_SEPARATOR)
            .map((line) => ({ type: "list_item", content: [{ type: "paragraph", content: inlineContent(line) }] })),
        };
      case "image": {
        // 图片块的 content 就是它的 Markdown（`![说明](地址)`），与 `note-blocks.ts`
        // 存的约定一致；地址与说明从 Markdown 里取，因为 PM 的 image 节点是属性不是文本。
        // 写出去的形状是 `paragraph > image`——编辑器里图片只有这一个位置（它是行内节点），
        // 规格把图片挂在 `inline` 组上，顶层放不下。投影那一侧再把"整段一张图"认回 `image`。
        const parsed = parseImageLine(block.content);
        return {
          type: "paragraph",
          attrs,
          content: [{ type: "image", attrs: { src: parsed.src, alt: parsed.alt } }],
        };
      }
      default:
        return { type: "paragraph", attrs, content: inlineContent(block.content) };
    }
  });
}
