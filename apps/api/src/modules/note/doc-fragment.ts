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
 * 正文的 `Y.XmlFragment` 容器（CRDT 批次 B）。
 *
 * **现在还没有运行时调用方**：生产路径仍走 `doc.ts` 那份 `Y.Array<Y.Map{content: Y.Text}>`。
 * 不是因为这一份没备好，而是服务端单独换形状会造出一个不能验收的中间态——桌面端内核还按
 * 数组形状写，下一次落盘投影就把已有 `note_blocks` 的正文投成空。所以换形状与批次 C 的
 * 编辑器绑定同一次落地，那时 `doc.ts` 的数组形状整条删除，不留双轨。
 *
 * 为什么换：现行形状下编辑器里是一份字符串拷贝，它落后于本机文档时，自动保存的差分
 * 会把对端刚写的字算成"我删掉了"（批次 A 的对照用例量到了）。fragment + 编辑器直接
 * 写文档之后没有那份拷贝，也就没有"拷贝落后"这件事。
 *
 * schema 只在**写整篇与投影**时用到；应用不透明的 yjs 增量不需要它（CRDT 层不认识形状）。
 * 这也是为什么规格放在 `packages/shared` 而 `new Schema()` 在这里做一次：
 * 见 `note-doc-schema.ts` 文件头那条"一个进程只能有一份 yjs"的坑。
 *
 * 依赖里 `y-prosemirror` 与三个 `prosemirror-*` 是**钉死版本**的（`package.json` 里没有 `^`）：
 * fragment 存的是别人写进快照的编码，而这一份文档服务端与桌面端各持一半。哪天一端升到
 * 改了属性的写法，症状不是报错，是同一篇笔记在两个副本上投影出不同的行。
 */

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
  doc.getMap("meta");
  doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
  return doc;
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
 * `Y.XmlElement`，所以别人正在编辑的块不会被换成新条目——换成"清空再重写"就会
 * （4.0 那条实测：两边各整篇写一次，块数增殖）。
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
export function projectFragmentBlocks(doc: Y.Doc): (NoteDocBlockSpec & { ordinal: number })[] {
  const fragment = doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
  const json = yXmlFragmentToProsemirrorJSON(fragment) as { content?: unknown[] };
  return pmNodesToNoteBlocks((json.content ?? []) as never).map((block, ordinal) => ({ ordinal, ...block }));
}
