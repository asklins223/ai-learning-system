import * as Y from "yjs";

/**
 * 笔记正文的 CRDT 形状 —— **主进程这一份**（批次 4.4）。
 *
 * 为什么是第二份实现而不是 `import` 服务端那份：本仓没有 workspace 根，`apps/api` 与
 * `packages/shared` 各有自己的 `node_modules`，而 `import "yjs"` 按文件所在位置解析。
 * 服务端进程里 Hocuspocus 已经带着一份 yjs 建 `Y.Doc`，共享源码会让第二份 yjs 进来，
 * `instanceof Y.Text` 跨份静默判假——症状是"块都在、正文全空"（实测过，见
 * `apps/api/src/modules/note/doc.ts` 文件头）。主进程与服务端**不在同一个进程**，
 * 所以各自一份 yjs 是安全的；不安全的只是两份实现悄悄分叉。
 *
 * 分叉由 `@ailearn/shared/note-doc-conformance` 的向量封住：那串 base64 是服务端内核
 * 生成的，两边各自解码一次并断言投影结果——任一边改了字段名、改了 `content` 的类型、
 * 改了块的形状，它自己那条用例就会红。
 *
 * 形状（与服务端一致）：`meta` Y.Map 放标题，`blocks` Y.Array<Y.Map> 一个块一个条目，
 * 正文是块内的 `Y.Text`（不是字符串——字符串块只能 delete+insert，并发时块数会增殖）。
 */

export type NoteSourceRef = { sourceId?: string; segmentId?: string };

export type NoteDocBlock = {
  type: string;
  content: string;
  sourceRef?: NoteSourceRef | null;
  imageAssetId?: string | null;
};

export type ProjectedNoteBlock = { ordinal: number } & NoteDocBlock;

export function emptyNoteDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("meta");
  doc.getArray("blocks");
  return doc;
}

export function docFromSnapshot(snapshot: Uint8Array): Y.Doc {
  const doc = emptyNoteDoc();
  Y.applyUpdate(doc, snapshot);
  return doc;
}

export function snapshotOf(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

function contentOf(item: Y.Map<unknown>): string {
  const value = item.get("content");
  if (value instanceof Y.Text) return value.toString();
  return typeof value === "string" ? value : "";
}

function refOf(item: Y.Map<unknown>): NoteSourceRef | null {
  const raw = item.get("sourceRef");
  if (!raw || typeof raw !== "object") return null;
  const ref = raw as { sourceId?: unknown; segmentId?: unknown };
  const parsed: NoteSourceRef = {};
  if (typeof ref.sourceId === "string") parsed.sourceId = ref.sourceId;
  if (typeof ref.segmentId === "string") parsed.segmentId = ref.segmentId;
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function toBlock(item: Y.Map<unknown>): NoteDocBlock {
  const image = item.get("imageAssetId");
  return {
    type: String(item.get("type") ?? "paragraph"),
    content: contentOf(item),
    ...(refOf(item) ? { sourceRef: refOf(item) } : {}),
    ...(typeof image === "string" ? { imageAssetId: image } : {}),
  };
}

/** 读侧：Y.Doc → `note_blocks` 同形的行。渲染层拿到的就是这个。 */
export function projectNoteBlocks(doc: Y.Doc): ProjectedNoteBlock[] {
  return doc
    .getArray<Y.Map<unknown>>("blocks")
    .toArray()
    .map((item, ordinal) => ({ ordinal, ...toBlock(item) }));
}

/** 首尾公共字符不动，只替换真正变了的中段——两个人改同一段才能合并成一处。 */
function patchBlockText(text: Y.Text, next: string): void {
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

function writeBlock(target: Y.Map<unknown>, block: NoteDocBlock): void {
  // 每个字段都先比再写：`Y.Map.set` 对相同值也会记一次操作，于是"内容没变的自动保存"
  // 每次都会产出一条非空增量 —— 客户端就白跑一趟上送。
  if (target.doc && target.get("type") === block.type) {
    // 类型没变，什么都不做。
  } else {
    target.set("type", block.type);
  }
  // `target.doc` 为空 = 还没插进数组的新建条目，读它会触发 yjs 的 premature-access 警告。
  const existing = target.doc ? target.get("content") : undefined;
  if (existing instanceof Y.Text) patchBlockText(existing, block.content);
  else target.set("content", new Y.Text(block.content));
  // 未提供 = 这次提交没带这个字段，别动它；要清掉得显式传 null。
  if (block.sourceRef !== undefined) {
    if (block.sourceRef) target.set("sourceRef", { ...block.sourceRef });
    else target.delete("sourceRef");
  }
  if (block.imageAssetId !== undefined) {
    if (block.imageAssetId) target.set("imageAssetId", block.imageAssetId);
    else target.delete("imageAssetId");
  }
}

/**
 * 编辑器提交时用的同步：块数没变就**一个数组操作都不做**。
 *
 * 渲染层每次改动交上来的都是"我看到的整篇"，但它并不拥有整篇——并发的另一路（别人的
 * 编辑、或服务端自己的写入）也在这儿。按 ordinal 逐块改文本，两边改不同块就都留着，
 * 改同一块就合并成一处；退回数组 delete+insert 的话谁也取消不了谁，块数会涨。
 */
export function syncNoteBlocksForEditor(doc: Y.Doc, blocks: NoteDocBlock[]): void {
  const array = doc.getArray<Y.Map<unknown>>("blocks");
  if (array.length === blocks.length) {
    doc.transact(() => {
      blocks.forEach((block, index) => {
        const item = array.get(index);
        if (item) writeBlock(item, block);
      });
    });
    return;
  }
  writeNoteBlocks(doc, blocks);
}

/** 整篇写入：只有"确实拥有整篇"的路径能用它（服务端才有，这里保留是为了向量对拍）。 */
export function writeNoteBlocks(doc: Y.Doc, blocks: NoteDocBlock[]): void {
  doc.transact(() => {
    const array = doc.getArray<Y.Map<unknown>>("blocks");
    array.delete(0, array.length);
    array.insert(
      0,
      blocks.map((block) => {
        const item = new Y.Map<unknown>();
        writeBlock(item, block);
        return item;
      }),
    );
  });
}

export function setNoteTitle(doc: Y.Doc, title: string, titleSource: string): void {
  doc.transact(() => {
    const meta = doc.getMap<unknown>("meta");
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
