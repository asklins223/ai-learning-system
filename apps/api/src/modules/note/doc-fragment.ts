import * as Y from "yjs";
import { Schema } from "prosemirror-model";
import { prosemirrorJSONToYXmlFragment, updateYFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import {
  noteBlocksToPmNodes,
  noteDocSchemaSpec,
  pmNodesToNoteBlocks,
  type NoteDocBlockSpec,
} from "@ailearn/shared/note-doc-schema";

/**
 * 笔记正文的 CRDT 文档形状（批次 C 起：服务端唯一的一份内核）。
 *
 * 一条笔记 = 一个 Y.Doc：
 *   - `meta`          Y.Map，放标题这类标量（谁的偏好谁自己写，正文之外不放行为数据）
 *   - `content`       Y.XmlFragment，一个块一个 `Y.XmlElement`，行内容在块内的 `YXmlText` 上
 *
 * **`doc.ts` 那份 `Y.Array<Y.Map{content: Y.Text}>` 已随本次切换整条删除**，不留双轨。形状无关
 * 的那几个助手（快照进出、`meta` 里的标题、自动标题的推导）跟着搬到这里来——它们本来就不属于
 * 任何一种块形状，只是当初和数组形状写在了同一个文件里。
 *
 * 为什么换（旧形状的两条实测，留着是因为它们就是这一批的立项理由）：
 *  - 数组形状下两边各整篇写一次，3 块并发改两处收成 **4 块**、1 块并发改收成 2 块：字符串块的
 *    "替换"在 CRDT 里是 delete+insert，两边谁也取消不了谁，于是同一块被两人改过就变成两份内容。
 *  - 更要紧的是编辑器里那份**字符串草稿**：它落后于本机文档时，自动保存的差分会把对端刚写的字
 *    算成"我删掉了"（批次 A 的对照用例量到了）。fragment + 编辑器直接写文档之后没有那份拷贝，
 *    也就没有"拷贝落后"这件事。块数的安全性不再靠"提交方拥有整篇"这个前提，而由
 *    `updateYFragment` 的节点差分给出（`doc-fragment.test.ts` 那条"整篇重写不复制块"）。
 *
 * schema 只在**写整篇与投影**时用到；应用不透明的 yjs 增量不需要它（CRDT 层不认识形状）。
 * 这也是为什么规格放在 `packages/shared` 而 `new Schema()` 在这里做一次：
 * 见 `note-doc-schema.ts` 文件头那条"一个进程只能有一份 yjs"的坑。
 *
 * 依赖里 `y-prosemirror` 与三个 `prosemirror-*` 是**钉死版本**的（`package.json` 里没有 `^`）：
 * fragment 存的是别人写进快照的编码，而这一份文档服务端与桌面端各持一半。哪天一端升到
 * 改了属性的写法，症状不是报错，是同一篇笔记在两个副本上投影出不同的行。
 *
 * `sourceRef` / `imageAssetId` 是"来源转笔记"那条路的命脉（证据链按块回指来源，投影进
 * `note_blocks.source_ref` 那列 jsonb），现在它们是**节点属性**而不是 Y.Map 的键。
 * 没在 schema 里声明的属性会被 `Node.fromJSON` 静默丢掉，所以规格里逐类型声明了它们——
 * 恢复历史版本时第一个要活下来的就是这两个键。
 */

/**
 * 块的行形状就是共享规格那一份：服务端、投影、编辑器共用同一个类型，
 * 再定义一次就是"两个真相"在这条链上的新版本。
 * （旧内核那份 `NoteSourceRef` 跟着数组形状一起没了：它唯一的用处是描述 `Y.Map` 上的键，
 * 而 `sourceRef` 现在由 `note-doc-schema.ts` 的规格定义。）
 */
export type NoteDocBlock = NoteDocBlockSpec;

/** 投影后的行：ordinal 由 fragment 下标给出，不单独存一份（存了就会和顺序打架）。 */
export type ProjectedNoteBlock = NoteDocBlockSpec & { ordinal: number };

/** fragment 的 key 名：一旦定下来就是持久化形状的一部分，改它等于换库。 */
export const NOTE_DOC_FRAGMENT_KEY = "content";

let cachedSchema: Schema | null = null;

/** 惰性建一次：`new Schema` 会校验 content 表达式，出错要在第一次用时喊出来。 */
export function noteDocSchema(): Schema {
  if (!cachedSchema) cachedSchema = new Schema(noteDocSchemaSpec as never);
  return cachedSchema;
}

export function emptyFragmentNoteDoc(): Y.Doc {
  const doc = new Y.Doc();
  // 提前建好两个共享类型：空文档和"没有这两个 key"在编码上不同，
  // 快照恢复时不想依赖第一次写入的顺序。
  doc.getMap("meta");
  doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
  return doc;
}

/**
 * 从快照读回文档。
 *
 * 必须先用 `emptyFragmentNoteDoc()` 建好共享类型再 `applyUpdate`：投影那一步读的是
 * `content` 这个 XmlFragment，一个"这份编码里根本没有这个 key"的文档和一个"有这个 key
 * 且为空"的文档在编码上不同，靠 applyUpdate 顺带建出来就会把这两种情况混成一种。
 */
export function docFromSnapshot(snapshot: Uint8Array): Y.Doc {
  const doc = emptyFragmentNoteDoc();
  Y.applyUpdate(doc, snapshot);
  return doc;
}

export function snapshotOf(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

/** 空正文也得有一个段落：schema 的 `doc: block+` 不接受零个子节点。 */
function pmDocJson(blocks: readonly NoteDocBlockSpec[]) {
  const content = blocks.length ? noteBlocksToPmNodes(blocks) : [{ type: "paragraph" }];
  return { type: "doc", content };
}

/**
 * 整篇写入（导入、来源转笔记、恢复版本）。
 *
 * `updateYFragment` 是按节点差分的：它只替换真正变了的那一段，未改动的节点保持同一个
 * `Y.XmlElement`，所以别人正在编辑的块不会被换成新条目。批次 C 量过这件事值多少：
 * 一份 3 块的文档分两个副本，各自**整篇**写回一次、各改一块，合回来是 3 块且两处改动
 * 都在（数组形状同样是这两次提交，合回来 4 块——就是文件头那条增殖）。
 *
 * 换成"清空再整篇重写"不是慢一点，是**跑不完**：`doc-fragment.test.ts` 里那个变异实测
 * 43 秒后被 SIGKILL。所以差分不是偏好，是这条路唯一能落地的形状。
 *
 * 第四个参数 `meta` 是**必传**的（实测：不传立刻 `Cannot read properties of undefined
 * (reading 'set')`，因为它第一行就是 `meta.mapping.set(...)`）。这里每次新建一对空表：
 * 它们只是这一次差分的节点↔片段映射，跨调用留着反而是脏状态。
 */
export function writeFragmentBlocks(doc: Y.Doc, blocks: readonly NoteDocBlockSpec[]): void {
  const fragment = doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
  const node = noteDocSchema().nodeFromJSON(pmDocJson(blocks) as never);
  Y.transact(doc, () => {
    if (fragment.length === 0) {
      // 第一次写没有可差分的目标：直接由 JSON 建出 fragment。
      prosemirrorJSONToYXmlFragment(noteDocSchema(), pmDocJson(blocks) as never, fragment);
      return;
    }
    updateYFragment(doc, fragment, node, { mapping: new Map(), isOMark: new Map() });
  });
}

/** 读侧：fragment → `note_blocks` 的行。ordinal 由下标给出，不另存一份。 */
export function projectFragmentBlocks(doc: Y.Doc): ProjectedNoteBlock[] {
  const fragment = doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
  const json = yXmlFragmentToProsemirrorJSON(fragment) as { content?: unknown[] };
  return pmNodesToNoteBlocks((json.content ?? []) as never).map((block, ordinal) => ({ ordinal, ...block }));
}

/**
 * 在一个 `YXmlText` 上把内容改成 `next`，只替换真正变了的中段。
 *
 * 首尾公共字符不动，所以两边改同一段的不同位置时，操作落在不相交的区间上，合并结果
 * 就是两处都改到——数组形状里块内那条 `Y.Text` 买到的也是这件事，换形状换的是块的容器，
 * 这一层没换。反过来，"清空再整段插入"会把删除范围铺满整段——一份**落后的草稿**这样提交一次，
 * 对端刚写进来的那几个字就正好落在被删的中段里（批次 A 的对照用例量的就是这一条）。
 * 缩到"真正变了的中段"是必要的，但不充分：根治办法是编辑器直接写这份文档、不再持有拷贝。
 */
function patchFragmentText(text: Y.XmlText, next: string): void {
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
 * 块里"那一条行内容"：只有一个子节点、且它是 `YXmlText` 时才算（实测
 * `Y.XmlElement` 没有 `firstChild()`，那是 DOM 的说法，取子节点用 `get(i)`）。
 * 下面这些形状都拿不到"一条"文本，调用处要退回去：引用与列表在 PM 里是容器
 * （`blockquote>paragraph`、`bullet_list>list_item+`）、图片没有子节点（地址在 `src`
 * 属性上）、带换行或行内标记的段落是 `YXmlText / hardbreak / YXmlText …` 好几个子节点。
 */
function blockInlineText(element: Y.XmlElement): Y.XmlText | null {
  if (element.length !== 1) return null;
  const child = element.get(0);
  return child instanceof Y.XmlText ? child : null;
}

/**
 * 就地改某一块的正文：在同一个 `YXmlText` 上做字符级 diff + 替换，而不是换掉整个节点。
 * 交互编辑走这里——它产生的是"同一块内的一次文本操作"，两个人同时编辑会合并成一份内容。
 *
 * 判据是"那一条文本里的字，就是这一整块投影出来的正文"（`text.toString() === 投影值`）。
 * 不满足就退回整篇差分，而不是自己拆容器、拆 mark 去猜行边界：`updateYFragment` 本身
 * 就是节点级的，未改动的块仍是同一个节点，所以这次退化不会伤到别人正在编辑的那些块。
 * 这条判据同时挡住了"只改了一半正文"的错法——一段里有 `YXmlText + hardbreak + YXmlText`
 * 时，拿第一条文本去接住整块的新内容，等于把第二行写成第一条文本的字。
 *
 * 只在"这一块的正文就是这一条文本"时才就地改，也就意味着：这一支写的永远是**纯文本**。
 * `**粗**` 要变成 mark 是编辑器那一侧的事（它才有序列与选区状态），服务端不替它猜。
 */
export function editFragmentBlockText(doc: Y.Doc, ordinal: number, nextContent: string): void {
  doc.transact(() => {
    const fragment = doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
    if (!fragment.get(ordinal)) throw new Error(`笔记没有第 ${ordinal} 块`);
    const blocks = projectFragmentBlocks(doc);
    const element = fragment.get(ordinal);
    const text = element instanceof Y.XmlElement ? blockInlineText(element) : null;
    const current = blocks[ordinal];
    if (text && current && text.toString() === current.content) {
      patchFragmentText(text, nextContent);
      return;
    }
    writeFragmentBlocks(
      doc,
      blocks.map(({ ordinal: _ordinal, ...block }, index) =>
        (index === ordinal ? { ...block, content: nextContent } : block)),
    );
  });
}

/**
 * 恢复历史版本 = 把快照里的块列表当成目标做一次 `writeFragmentBlocks`。
 *
 * 不是"删光再插"：那会在别人正在编辑时把他的内容整篇抹掉，而且没有版本可回退。
 * 走同一套节点差分，恢复只替换真正变化的那一段，别人的并发编辑落在未改动的节点里就保住。
 */
export function restoreFragmentBlocksFrom(doc: Y.Doc, snapshot: Uint8Array): void {
  const source = docFromSnapshot(snapshot);
  const target = projectFragmentBlocks(source).map(({ ordinal: _ordinal, ...block }) => block);
  writeFragmentBlocks(doc, target);
  source.destroy();
}

export function setNoteTitle(doc: Y.Doc, title: string, titleSource: string): void {
  doc.transact(() => {
    const meta = doc.getMap<unknown>("meta");
    // 每个字段都先比再写：`Y.Map.set` 对相同值也会记一次操作，于是"内容没变的自动保存"
    // 每次都会产出一条非空增量——白跑一趟上送，还把 revision 往上推。
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

/**
 * 自动标题：`meta.titleSource` 是 `auto` 时，标题就是"正文里第一行能当标题的话"。
 *
 * 放在文档这一层而不是放在保存接口那一层，是因为正文写入走增量之后，能重算它的时机
 * 只剩落盘投影那一次——那时在场的是从文档投影出来的块，请求体里已经没有整篇了。
 * 留在 service 里就会变成"两条写路各自决定标题"，而标题只有一个事实源（`meta`）。
 */
export function cleanTitleCandidate(content: string): string {
  return content
    .trim()
    .replace(/^<h\d>([\s\S]+)<\/h\d>$/i, "$1")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^·\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/`{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function deriveNoteTitle(blocks: readonly { type: string; content: string }[]): string {
  const heading = blocks.find((block) => block.type === "heading" && cleanTitleCandidate(block.content));
  const fallback = heading ?? blocks.find((block) => cleanTitleCandidate(block.content));
  const title = fallback ? cleanTitleCandidate(fallback.content) : "";
  return title.slice(0, 60) || "无标题笔记";
}
