import * as Y from "yjs";
import { Schema } from "prosemirror-model";
import {
  prosemirrorJSONToYXmlFragment,
  updateYFragment,
  yXmlFragmentToProsemirrorJSON,
} from "y-prosemirror";
import {
  noteBlocksToPmNodes,
  noteDocSchemaSpec,
  pmNodesToNoteBlocks,
  type NoteDocBlockSpec,
} from "@ailearn/shared/note-doc-schema";

/**
 * 笔记正文的 CRDT 形状 —— **主进程这一份**（批次 4.4 起，形状在批次 C 换成 fragment）。
 *
 * 为什么是第二份实现而不是 `import` 服务端那份：本仓没有 workspace 根，`apps/api` 与
 * `apps/desktop-client` 各有自己的 `node_modules`，而 `import "yjs"` 按文件所在位置解析。
 * 共享源码会让一个进程里出现两份 yjs，`instanceof` 跨份静默判假——症状是"块都在、
 * 正文全空"（实测过，见 `apps/api/src/modules/note/doc-fragment.ts` 文件头）。
 * 两份实现悄悄分叉由 `@ailearn/shared/note-doc-conformance` 的向量封住。
 *
 * **换形状换来的第一件事**：投影不再需要 schema（`yXmlFragmentToProsemirrorJSON` 只吃
 * fragment），所以主进程这份只在**写整篇**时才用 `new Schema(spec)`。规格本身来自
 * `@ailearn/shared/note-doc-schema`，两边同一份，不抄第二份。
 *
 * 形状：`meta` Y.Map 放标题，`content` Y.XmlFragment 一个块一个节点，块内正文是节点里的
 * `YXmlText`（不是字符串——字符串只能 delete+insert，并发时谁也取消不了谁）。
 */

export type NoteDocBlock = NoteDocBlockSpec;
export type ProjectedNoteBlock = { ordinal: number } & NoteDocBlock;

/** 与服务端 `NOTE_DOC_FRAGMENT_KEY` 必须一致：改它等于换库。 */
export const NOTE_DOC_FRAGMENT_KEY = "content";

let cachedSchema: Schema | null = null;

function noteDocSchema(): Schema {
  if (!cachedSchema) cachedSchema = new Schema(noteDocSchemaSpec as never);
  return cachedSchema;
}

export function emptyNoteDoc(): Y.Doc {
  // 就是 `new Y.Doc()`：留着这个函数是为了"这份文档的形状由这里定义"这一句话有地方说。
  // 曾经在这里预建 `meta` 与 `content` 两个共享类型（旧内核的注释说"空文档和没有这两个
  // key 在编码上不同"）—— 换到 fragment 之后实测不成立：预建的文档编码是 2 字节，
  // 与裸 `new Y.Doc()` 一字不差，读写两侧也都是 `doc.get…(key)` 按需取。所以不保留
  // 没有依据的两行。
  return new Y.Doc();
}

export function docFromSnapshot(snapshot: Uint8Array): Y.Doc {
  const doc = emptyNoteDoc();
  Y.applyUpdate(doc, snapshot);
  return doc;
}

export function snapshotOf(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

/** 读侧：fragment → 与 `note_blocks` 同形的行。渲染层拿到的就是这个。 */
export function projectNoteBlocks(doc: Y.Doc): ProjectedNoteBlock[] {
  const fragment = doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
  const json = yXmlFragmentToProsemirrorJSON(fragment) as { content?: unknown[] };
  return pmNodesToNoteBlocks((json.content ?? []) as never).map((block, ordinal) => ({ ordinal, ...block }));
}

/** 空正文也得有一个段落：schema 的 `doc: block+` 不接受零个子节点。 */
function pmDocJson(blocks: readonly NoteDocBlock[]) {
  return { type: "doc", content: blocks.length ? noteBlocksToPmNodes(blocks) : [{ type: "paragraph" }] };
}

/**
 * 整篇写入。只留给"确实拥有整篇"的路径（恢复历史版本、以及块数变化时的同步）。
 *
 * 第四个参数 `meta` 必传（实测：不传立刻 `Cannot read properties of undefined
 * (reading 'set')`，因为它第一行就是 `meta.mapping.set(...)`）。
 */
export function writeNoteBlocks(doc: Y.Doc, blocks: readonly NoteDocBlock[]): void {
  const fragment = doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
  Y.transact(doc, () => {
    if (fragment.length === 0) {
      prosemirrorJSONToYXmlFragment(noteDocSchema(), pmDocJson(blocks) as never, fragment);
      return;
    }
    updateYFragment(doc, fragment, noteDocSchema().nodeFromJSON(pmDocJson(blocks) as never), {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
}

/**
 * 首尾公共字符不动，只替换真正变了的中段——两个人改同一段的不同位置才能合并成一处。
 *
 * 必要但**不充分**：一份落后的草稿这样提交一次，对端刚写进来的那几个字仍可能落在被删的
 * 中段里。根治办法是编辑器直接写这份文档、不再持有拷贝（批次 C2 的后一半）。
 */
function patchBlockText(text: Y.XmlText, next: string): void {
  const current = text.toString();
  if (current === next) return;
  let prefix = 0;
  while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < current.length - prefix
    && suffix < next.length - prefix
    && current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix += 1;
  text.delete(prefix, current.length - prefix - suffix);
  text.insert(prefix, next.slice(prefix, next.length - suffix));
}

/**
 * 块里"那一条行内容"：只有一个子节点、且它是 `YXmlText` 时才算
 * （`Y.XmlElement` 没有 `firstChild()`，那是 DOM 的说法，取子节点用 `get(i)`）。
 * 引用与列表在 PM 里是容器、图片没有子节点（地址在 `src` 属性上）、带换行或行内标记的
 * 段落有好几个子节点——这些都拿不到"一条"，调用处要退回整篇差分。
 */
function blockInlineText(element: Y.XmlElement): Y.XmlText | null {
  if (element.length !== 1) return null;
  const child = element.get(0);
  return child instanceof Y.XmlText ? child : null;
}

/**
 * 渲染层提交时用的同步：块数没变、且每块都只是"正文里那几个字变了"时，
 * **一个数组与节点替换操作都不做**。
 *
 * 换形状之后这件事比之前更值得做：`updateYFragment` 是节点级的，一旦走上去，未改动的块
 * 仍是同一个节点（不会像旧的 `Y.Array` 那样增殖），但它**没有"这次没给这个字段就别动它"**
 * 这一层语义——属性是从目标节点的 `attrs` 抄的，而 `null` 会被当成"删掉这个属性"。
 * 渲染层每次交上来的只有 `{type, content}`（编辑器里没有来源引用这个概念），所以直接
 * 整篇差分会把每一块的 `sourceRef` / `imageAssetId` 抹掉，接着被投影写进 `note_blocks`，
 * 证据链就这么在"用户只是打了个字"的路上断掉。这里先把文档里现存的两个值抄回目标块，
 * 让"没给"仍然是"没给"。
 */
export function syncNoteBlocksForEditor(doc: Y.Doc, blocks: readonly NoteDocBlock[]): void {
  const fragment = doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
  const projected = projectNoteBlocks(doc);
  const merged = blocks.map((block, index) => withExistingRefs(block, projected[index]));
  if (fragment.length === blocks.length) {
    let needsNodeDiff = false;
    doc.transact(() => {
      merged.forEach((block, index) => {
        const current = projected[index];
        if (!current) {
          needsNodeDiff = true;
          return;
        }
        if (block.type !== current.type) {
          needsNodeDiff = true;
          return;
        }
        if (block.content === current.content) return;
        const element = fragment.get(index);
        const text = element instanceof Y.XmlElement ? blockInlineText(element) : null;
        if (text && text.toString() === current.content) patchBlockText(text, block.content);
        else needsNodeDiff = true;
      });
    });
    if (!needsNodeDiff) return;
  }
  writeNoteBlocks(doc, merged);
}

/** "这次没给"= 保持文档里那一份；显式给 `null` 才清掉。与旧数组内核同一条规则。 */
function withExistingRefs(block: NoteDocBlock, existing: NoteDocBlock | undefined): NoteDocBlock {
  if (!existing) return block;
  const next = { ...block };
  if (block.sourceRef === undefined && existing.sourceRef) next.sourceRef = existing.sourceRef;
  if (block.imageAssetId === undefined && existing.imageAssetId) next.imageAssetId = existing.imageAssetId;
  return next;
}

export function setNoteTitle(doc: Y.Doc, title: string, titleSource: string): void {
  doc.transact(() => {
    const meta = doc.getMap<unknown>("meta");
    // 先比再写：`Y.Map.set` 对相同值也记一次操作，于是"内容没变的自动保存"每次都产出
    // 一条非空增量——白跑一趟上送，还把 revision 往上推。
    if (meta.get("title") !== title) meta.set("title", title);
    if (meta.get("titleSource") !== titleSource) meta.set("titleSource", titleSource);
  });
}

export function readNoteTitle(doc: Y.Doc): { title: string; titleSource: string } | null {
  const meta = doc.getMap<unknown>("meta");
  const title = meta.get("title");
  const titleSource = meta.get("titleSource");
  if (typeof title !== "string") return null;
  return { title, titleSource: typeof titleSource === "string" ? titleSource : "auto" };
}
