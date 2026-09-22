/**
 * 笔记正文的 ProseMirror schema 定义与块形状转换（CRDT 批次 B）。
 *
 * **这里只放纯数据与纯函数**：不 import `yjs`，也不 import `prosemirror-model`。
 * 原因是踩过的坑（见 `apps/api/src/modules/note/doc.ts` 文件头）：本仓没有 workspace
 * 根，`apps/api` 与 `apps/desktop-client` 各有自己的 `node_modules`，把带 yjs 的模块
 * 挪进 shared 会让一个进程里出现两份 yjs，`instanceof Y.Text` 静默为假，症状是
 * "块都在、正文全空"。所以共享的是**规格**，`new Schema(spec)` 由各进程自己做一次。
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
 */
export const noteDocSchemaSpec = {
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block", attrs: blockAttrs },
    heading: { content: "text*", group: "block", attrs: { level: { default: 2 }, ...blockAttrs } },
    code_block: { content: "text*", group: "block", code: true, attrs: blockAttrs },
    blockquote: { content: "block+", group: "block", attrs: blockAttrs },
    bullet_list: { content: "list_item+", group: "block", attrs: blockAttrs },
    list_item: { content: "paragraph+" },
    image: { group: "block", attrs: { src: { default: "" }, alt: { default: "" }, ...blockAttrs } },
    text: { group: "inline" },
  },
} as const;

type PmJson = { type: string; text?: string; attrs?: Record<string, unknown>; content?: PmJson[] };

const textNode = (content: string): PmJson => ({ type: "text", text: content });

/** 一个块的正文 → 放进 PM 节点里的行内容（空块不给 content，PM 要的是"没有子节点"）。 */
function inlineContent(content: string): PmJson[] | undefined {
  return content.length ? [textNode(content)] : undefined;
}

/**
 * 我们的行 → ProseMirror 的 JSON 节点数组（fragment 的写入形状）。
 *
 * 代码块**不能**压成多段落：`note_blocks.content` 里代码是带换行的一整段，
 * 摊平成多个段落再投影回来就会变成多行列表项——那是静默改内容。
 */
export function noteBlocksToPmNodes(blocks: readonly NoteDocBlockSpec[]): PmJson[] {
  return blocks.map((block) => {
    const attrs = { sourceRef: block.sourceRef ?? null, imageAssetId: block.imageAssetId ?? null };
    switch (block.type) {
      case "heading":
        return { type: "heading", attrs: { level: 2, ...attrs }, content: inlineContent(block.content) };
      case "code":
        return { type: "code_block", attrs, content: inlineContent(block.content) };
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
        // 图片块的 content 就是地址（站内 `/api/uploads/...` 或站外 URL），alt 不在行里，
        // 它本来就画在 content 的 markdown 语法里，由渲染层解析。
        return { type: "image", attrs: { src: block.content, alt: "", ...attrs } };
      }
      default:
        return { type: "paragraph", attrs, content: inlineContent(block.content) };
    }
  });
}

function collectText(node: PmJson | undefined): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(collectText).join("");
}

/**
 * ProseMirror 的 JSON → 我们的行。这是 `note_blocks` 唯一的派生口。
 *
 * 认不出的节点类型**当段落画**而不是丢掉那块：那可能只是对端是更新的一版客户端
 * 新增了一种块，因为一个类型名没认出来就不画人家写的字，是最坏的一种保守。
 */
export function pmNodesToNoteBlocks(nodes: readonly PmJson[]): NoteDocBlockSpec[] {
  return nodes.map((node) => {
    const sourceRef = (node.attrs?.sourceRef as NoteDocBlockSpec["sourceRef"]) ?? null;
    const imageAssetId = (node.attrs?.imageAssetId as string | null) ?? null;
    const extras = { ...(sourceRef ? { sourceRef } : {}), ...(imageAssetId ? { imageAssetId } : {}) };
    switch (node.type) {
      case "heading":
        return { type: "heading", content: collectText(node), ...extras };
      case "code_block":
        return { type: "code", content: collectText(node), ...extras };
      case "blockquote":
        // 引用在 PM 里是 block+ 容器，我们的行里是一整段文本：按段落拼回来。
        return { type: "quote", content: (node.content ?? []).map(collectText).join("\n"), ...extras };
      case "bullet_list":
        return {
          type: "list",
          content: (node.content ?? []).map((item) => (item.content ?? []).map(collectText).join(" ")).join(LIST_ITEM_SEPARATOR),
          ...extras,
        };
      case "image":
        return { type: "image", content: String(node.attrs?.src ?? ""), ...extras };
      default:
        return { type: "paragraph", content: collectText(node), ...extras };
    }
  });
}
