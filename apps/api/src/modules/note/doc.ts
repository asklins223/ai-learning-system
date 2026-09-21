import * as Y from "yjs";

/**
 * 笔记正文的 CRDT 文档形状（批次 4 协同内核）。
 *
 * 一条笔记 = 一个 Y.Doc：
 *   - `meta`   Y.Map，放标题这类标量（谁的偏好谁自己写，正文之外不放行为数据）
 *   - `blocks` Y.Array<Y.Map>，一个块一个条目
 *
 * 为什么是"块数组"而不是"一整条 Y.Text"：`note_blocks` 是带 `ordinal` 的关系表，
 * 下游四个消费方（搜索索引、卡片证据链、导出、列表预览）按行读它，而卡片的证据锚点
 * 精确到"哪一块"。整条 Y.Text 会把块边界变成一次全量替换，两个客户端各改一段时
 * 必然互相冲掉行；块级条目才能做字段级合并与逐块投影。
 *
 * `sourceRef` / `imageAssetId` 是"来源转笔记"那条路的命脉（证据链按块回指来源），
 * 所以它们必须是块上的普通字段，而不是另存一张映射表——否则恢复历史版本时第一个
 * 丢的就是它们。
 *
 * **`content` 是 `Y.Text`，不是字符串**（4.0 实测出来的）：字符串块只能整块替换，
 * 而"整块替换"在 CRDT 里是 delete+insert；两边同时各替换一块时谁也取消不了谁，
 * 合并结果是**两块**——同一块被两人改过就变成两份内容。实测数字：3 块并发改两处
 * 收成 4 块，1 块并发改收成 2 块。改成块内 `Y.Text` 后，替换是在同一个文本对象上做
 * 字符级操作，块数不会增殖，两个人改同一段也只是文本合并。
 *
 * **这个文件不能挪进 `packages/shared`**（试过，症状很怪所以写在这里）：本仓没有 workspace 根，
 * `apps/api` 与 `packages/shared` 各有自己的 `node_modules`，而 `import "yjs"` 是按**该文件所在
 * 位置**解析的。挪过去之后 api 进程里就有两份 yjs：Hocuspocus 用 api 那份建 `Y.Doc`，这里的
 * `instanceof Y.Text` 却是另一份的类，判据静默为假 → `contentOf` 走字符串分支返回 `""`，症状是
 * "块都在、正文全空"（实测：协同集测 7 条同时红）。渲染层要共用这份形状，前提是同一个进程只有
 * 一份 yjs；跨包共享源码不满足它。真要收敛，先让依赖布局收敛（加 workspace 根）。
 */

/** 与 `note_blocks.source_ref`（jsonb）同形：证据链按"哪个来源的哪一段"锚定。 */
export type NoteSourceRef = { sourceId?: string; segmentId?: string };

export type NoteDocBlock = {
  type: string;
  content: string;
  sourceRef?: NoteSourceRef | null;
  imageAssetId?: string | null;
};

/** 投影后的行：ordinal 由数组下标给出，不单独存一份（存了就会和数组打架）。 */
export type ProjectedNoteBlock = { ordinal: number } & NoteDocBlock;

export function emptyNoteDoc(): Y.Doc {
  const doc = new Y.Doc();
  // 提前建好两个共享类型：空文档和"没有这两个 key"在编码上不同，
  // 快照恢复时不想依赖第一次写入的顺序。
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
  if (raw && typeof raw === "object") return raw as NoteSourceRef;
  return null;
}

function toBlock(item: Y.Map<unknown>): NoteDocBlock {
  const sourceRef = refOf(item);
  const imageAssetId = item.get("imageAssetId");
  return {
    type: String(item.get("type") ?? "paragraph"),
    content: contentOf(item),
    ...(sourceRef ? { sourceRef } : {}),
    ...(typeof imageAssetId === "string" ? { imageAssetId } : {}),
  };
}

/** 读侧：Y.Doc → `note_blocks` 的行。关系表由这里派生，不再有第二条写路。 */
export function projectNoteBlocks(doc: Y.Doc): ProjectedNoteBlock[] {
  return doc
    .getArray<Y.Map<unknown>>("blocks")
    .toArray()
    .map((item, ordinal) => ({ ordinal, ...toBlock(item) }));
}

function sameBlock(left: NoteDocBlock, right: NoteDocBlock): boolean {
  return (
    left.type === right.type
    && left.content === right.content
    && JSON.stringify(left.sourceRef ?? null) === JSON.stringify(right.sourceRef ?? null)
    && (left.imageAssetId ?? null) === (right.imageAssetId ?? null)
  );
}

function writeBlock(target: Y.Map<unknown>, block: NoteDocBlock): void {
  target.set("type", block.type);
  // 新条目才建 Y.Text；已经挂在文档上的一律就地改。换掉这个对象等于把块的身份也换掉，
  // 并发时两边的 delete+insert 谁也取消不了谁，合并结果就成了两份内容。
  // `target.doc` 为空表示这是一个还没插进数组的新建条目——读它会触发 yjs 的
  // "Add Yjs type to a document before reading data"（实测一次导入刷出上百条）。
  const existing = target.doc ? target.get("content") : undefined;
  if (existing instanceof Y.Text) patchBlockText(existing, block.content);
  else target.set("content", new Y.Text(block.content));
  // `undefined` = 这次提交没带这个字段，别动它。自动保存提交的只有 type/content，
  // 若把"没给"当成"要清空"，每存一次就会把来源转笔记那条路记下的证据链抹掉一次。
  // 要真的清掉请显式传 `null`。
  if (block.sourceRef !== undefined) {
    if (block.sourceRef) target.set("sourceRef", { ...block.sourceRef });
    else target.delete("sourceRef");
  }
  if (block.imageAssetId !== undefined) {
    if (block.imageAssetId) target.set("imageAssetId", block.imageAssetId);
    else target.delete("imageAssetId");
  }
}

function insertBlocks(doc: Y.Doc, at: number, blocks: NoteDocBlock[]): void {
  const array = doc.getArray<Y.Map<unknown>>("blocks");
  array.insert(
    at,
    blocks.map((block) => {
      const item = new Y.Map<unknown>();
      writeBlock(item, block);
      return item;
    }),
  );
}

/**
 * 整篇写入（导入、来源转笔记、自动保存都走这里）。
 *
 * 用首尾公共前/后缀只改中间那段：完全重写会把每个块的条目身份换掉，两个客户端
 * 同时保存时后写的会把前写的整篇冲掉——那正是这次要修的缺陷。前缀/后缀之外的
 * 差异才落盘，未改动的块保持同一个 Y.Map，并发的编辑因此能存活。
 */
export function writeNoteBlocks(doc: Y.Doc, blocks: NoteDocBlock[]): void {
  doc.transact(() => {
    const array = doc.getArray<Y.Map<unknown>>("blocks");
    const current = array.toArray();
    const patch = diffSpans(current, blocks);
    if (patch.deleteCount > 0) array.delete(patch.start, patch.deleteCount);
    if (patch.insert.length > 0) insertBlocks(doc, patch.start, patch.insert);
    // 位置对得上、只是正文或元数据变了的块，就地改它的 Y.Text（保留条目身份），
    // 否则一次导入会把别人正在编辑的块换成新条目。
    for (let index = 0; index < blocks.length; index += 1) {
      const item = array.get(index);
      if (!item) continue;
      const block = blocks[index];
      if (contentOf(item) !== block.content) {
        const text = item.get("content");
        if (text instanceof Y.Text) patchBlockText(text, block.content);
      }
      if (String(item.get("type") ?? "") !== block.type) item.set("type", block.type);
      const ref = block.sourceRef ?? null;
      if (JSON.stringify(refOf(item) ?? null) !== JSON.stringify(ref)) {
        if (ref) item.set("sourceRef", { ...ref }); else item.delete("sourceRef");
      }
      const asset = block.imageAssetId ?? null;
      if ((item.get("imageAssetId") ?? null) !== asset) {
        if (asset) item.set("imageAssetId", asset); else item.delete("imageAssetId");
      }
    }
  });
}

/**
 * 交互编辑（自动保存）专用的写入：块数没变就**一次数组操作都不做**。
 *
 * 与 `writeNoteBlocks` 的分工是刻意的：后者按"整篇是我要提交的那份"来对齐，内容变了
 * 的块会走数组 delete+insert——两条并发提交里谁也没取消谁，块数就涨（文件头那条
 * 特征刻画用例量的就是这个）。而自动保存每 2.5 秒提交一次"我这一版看到的整篇"，
 * 绝大多数时候只有少数块变了、块数根本没变：这时唯一安全的形状是逐个块在同一个
 * `Y.Text` 上做字符级 diff。真增删了块才退回 `writeNoteBlocks`——插入的块本来就是新
 * 条目，并发插入两份是正确结果，不是增殖。
 */
export function syncNoteBlocksForEditor(doc: Y.Doc, blocks: NoteDocBlock[]): void {
  const array = doc.getArray<Y.Map<unknown>>("blocks");
  if (array.length !== blocks.length) {
    writeNoteBlocks(doc, blocks);
    return;
  }
  doc.transact(() => {
    blocks.forEach((block, index) => {
      const item = array.get(index);
      if (item) writeBlock(item, block);
    });
  });
}

/**
 * 就地改某一块的正文：在同一个 `Y.Text` 上做字符级 diff + 替换，而不是换掉整个块。
 * 交互编辑（自动保存）走这里——它产生的是"同一块内的一次文本操作"，两个人同时编辑
 * 会合并成一份内容；换成整块替换就会让块数增殖（见文件头 4.0 实测）。
 */
export function editBlockContent(doc: Y.Doc, ordinal: number, nextContent: string): void {
  doc.transact(() => {
    const array = doc.getArray<Y.Map<unknown>>("blocks");
    const item = array.get(ordinal);
    if (!item) throw new Error(`笔记没有第 ${ordinal} 块`);
    const text = item.get("content");
    if (!(text instanceof Y.Text)) throw new Error(`第 ${ordinal} 块的正文不是 Y.Text`);
    patchBlockText(text, nextContent);
  });
}

/**
 * 在一个 `Y.Text` 上把内容改成 `next`，只替换真正变了的中段。
 *
 * 首尾公共字符不动，所以两边改同一段的不同位置时，操作落在不相交的区间上，合并
 * 结果就是两处都改到。反过来，"清空再整段插入"在 CRDT 里是 delete+insert 而不是
 * 替换，两个人同时改一段会把这段变成两份——`writeNoteBlocks` 也走这里，理由相同：
 * 一次导入或一次编辑器保存都不该把别人正在编辑的块换成新条目。
 */
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

/** 当前块 vs 目标块 → 最小的一段替换（前后缀相同的部分不动）。 */
function diffSpans(current: Y.Map<unknown>[], target: NoteDocBlock[]) {
  const currentBlocks = current.map(toBlock);
  let prefix = 0;
  while (prefix < currentBlocks.length && prefix < target.length && sameBlock(currentBlocks[prefix], target[prefix])) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < currentBlocks.length - prefix
    && suffix < target.length - prefix
    && sameBlock(currentBlocks[currentBlocks.length - 1 - suffix], target[target.length - 1 - suffix])
  ) {
    suffix += 1;
  }
  return {
    start: prefix,
    deleteCount: currentBlocks.length - prefix - suffix,
    insert: target.slice(prefix, target.length - suffix),
  };
}

/**
 * 恢复历史版本 = 把快照里的块列表当成目标做一次 `writeNoteBlocks`。
 *
 * 不是"删光再插"：那会在别人正在编辑时把他的内容整篇抹掉，而且没有版本可回退。
 * 走同一套首尾差分，恢复只替换真正变化的那段，别人的并发编辑落在前缀/后缀里就保住。
 */
export function restoreNoteBlocksFrom(doc: Y.Doc, snapshot: Uint8Array): void {
  const source = docFromSnapshot(snapshot);
  const target = projectNoteBlocks(source).map(({ ordinal: _ordinal, ...block }) => block);
  writeNoteBlocks(doc, target);
  source.destroy();
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
  if (typeof title !== "string") return null;
  return { title, titleSource: String(meta.get("titleSource") ?? "auto") };
}
