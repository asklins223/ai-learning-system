import * as Y from "yjs";

/**
 * 只给主进程用例用的那一份"文档"（批次 C2 之后主进程已经没有内核了）。
 *
 * 主进程这一层现在**不认识正文**：它转手的是不透明的 yjs 增量，唯一的解释动作是
 * `note-doc-state.readNoteTitle`（生产代码自己那份）。所以测试要一份起点、要读回
 * 屏幕上那些字时，不需要也不该再拖一份内核进来——这里就是那 40 行 raw yjs。
 *
 * 写法是**逐块就地改**，不是整篇删了重插：交出去的增量形状与真客户端一致，以后加
 * "同一起点、两边并发各改一块"那种用例时不会一上来就合出双份块。如实说一句：现有用例
 * 并不依赖这一点（换成整篇重写，`desktop-gateway.test.ts` 仍然全绿，实测过），这里留着
 * 是为下一次那种断言准备的，不是它此刻在挡什么。
 */

const FRAGMENT_KEY = "content";

export type TestNoteBlock = { type: string; content: string };
export type ProjectedTestBlock = TestNoteBlock & { ordinal: number };

export function emptyNoteDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getXmlFragment(FRAGMENT_KEY);
  return doc;
}

export function docFromSnapshot(snapshot: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, snapshot);
  return doc;
}

export function snapshotOf(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

function paragraph(type: string, content: string): Y.XmlElement {
  const element = new Y.XmlElement(type);
  element.insert(0, [new Y.XmlText(content)]);
  return element;
}

export function writeNoteBlocks(doc: Y.Doc, blocks: readonly TestNoteBlock[]): void {
  doc.transact(() => {
    const fragment = doc.getXmlFragment(FRAGMENT_KEY);
    while (fragment.length > blocks.length) {
      fragment.delete(blocks.length, fragment.length - blocks.length);
    }
    blocks.forEach((block, index) => {
      const existing = fragment.get(index);
      if (!existing) {
        fragment.insert(index, [paragraph(block.type, block.content)]);
        return;
      }
      if (!(existing instanceof Y.XmlElement) || existing.nodeName !== block.type) {
        fragment.delete(index, 1);
        fragment.insert(index, [paragraph(block.type, block.content)]);
        return;
      }
      const text = onlyTextOf(existing);
      if (text && text.toString() === block.content) return;
      if (text) {
        text.delete(0, text.length);
        text.insert(0, block.content);
        return;
      }
      // 结构不是"一个块一条文本"（例如上一版留下过多子节点）：换掉这一个节点，
      // 其余节点仍然原地留着。
      fragment.delete(index, 1);
      fragment.insert(index, [paragraph(block.type, block.content)]);
    });
  });
}

/** 与 `writeNoteBlocks` 同一件事：编辑器提交的就是"这份文档现在应该长这样"。 */
export function syncNoteBlocksForEditor(doc: Y.Doc, blocks: readonly TestNoteBlock[]): void {
  writeNoteBlocks(doc, blocks);
}

/**
 * 一个块的正文 = 它自己那些 `YXmlText` 子节点的字接起来。
 *
 * 不能用 `Y.XmlElement.toString()`：那是 XML 序列化，`<heading>标题</heading>` 会被
 * 当成正文断言出去（第一次跑就是这么红的）。
 */
function contentOf(node: unknown): string {
  if (!(node instanceof Y.XmlElement)) return String(node ?? "");
  let text = "";
  for (let index = 0; index < node.length; index += 1) {
    const child = node.get(index);
    if (child instanceof Y.XmlText) text += child.toString();
  }
  return text;
}

function onlyTextOf(element: Y.XmlElement): Y.XmlText | null {
  const child = element.length === 1 ? element.get(0) : null;
  return child instanceof Y.XmlText ? child : null;
}

export function projectNoteBlocks(doc: Y.Doc): ProjectedTestBlock[] {
  return doc
    .getXmlFragment(FRAGMENT_KEY)
    .toArray()
    .map((node, ordinal) => ({
      ordinal,
      type: node instanceof Y.XmlElement ? node.nodeName : "paragraph",
      content: contentOf(node),
    }));
}

export function setNoteTitle(doc: Y.Doc, title: string, titleSource: string): void {
  doc.transact(() => {
    const meta = doc.getMap<unknown>("meta");
    // 先比再写：`Y.Map.set` 对相同值也记一次操作，"名字没改"会变成一条非空增量。
    if (meta.get("title") !== title) meta.set("title", title);
    if (meta.get("titleSource") !== titleSource) meta.set("titleSource", titleSource);
  });
}
