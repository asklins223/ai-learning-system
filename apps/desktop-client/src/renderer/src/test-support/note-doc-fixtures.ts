import * as Y from "yjs";

/**
 * 协同那一侧的测试夹具：**真的 yjs 增量**，而且是从**同一起点**上改出来的。
 *
 * 过 IPC 的形状现在就是编码（blocks 视图那一层已经没有了），所以替身必须交出 apply 得进
 * 一份文档的字节。塞字符串会让用例假绿：界面拿到的是 `undefined`，effect 里什么都不做，
 * 断言"看到对端的字"就永远红或永远凭运气。
 *
 * 为什么对端那句必须在起点文档上改、而不是新建一篇再塞进来：两份毫无共同历史的文档在
 * CRDT 里是**并发插入**，合起来是"两句都在、块数 +1"；而真实场景是他改的就是那一段，
 * 合并结果应该是一段。用前者写用例，测的就不是产品会发生的事。
 */
const FRAGMENT_KEY = "content";
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...Array.from(bytes)));
const unb64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

function bodyDoc(paragraphs: readonly string[], title: string | null): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(FRAGMENT_KEY);
  const nodes = paragraphs.map((text) => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(text)]);
    return paragraph;
  });
  if (nodes.length) fragment.insert(0, nodes);
  if (title !== null) {
    doc.getMap("meta").set("title", title);
    doc.getMap("meta").set("titleSource", "auto");
  }
  return doc;
}

/** 起点：两块正文 + 一个标题。 */
export function seedUpdate(
  title = "起点标题",
  paragraphs: readonly string[] = ["第一段正文", "第二段正文"],
): string {
  return b64(Y.encodeStateAsUpdate(bodyDoc(paragraphs, title)));
}

/** 对端在那一起点上改出来的一条增量；只碰写进来的那几处。 */
export function peerUpdate(
  seed: string,
  changes: { text?: string; paragraphIndex?: number; title?: string },
): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, unb64(seed));
  doc.transact(() => {
    if (changes.text !== undefined) {
      const paragraph = doc.getXmlFragment(FRAGMENT_KEY).get(changes.paragraphIndex ?? 0) as Y.XmlElement;
      const line = paragraph?.firstChild;
      // 就地替换那一段的字：删掉再插，合并结果仍然是一段，与真窗口里对方的按键一致。
      if (line instanceof Y.XmlText) {
        line.delete(0, line.length);
        line.insert(0, changes.text);
      }
    }
    // 标题是 `meta` 里的一份 LWW 文本，不碰正文。
    if (changes.title !== undefined) doc.getMap("meta").set("title", changes.title);
  });
  const update = b64(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return update;
}

/** `note.doc` 那三个动作的替身；要记次数就在外面包一层。 */
export function noteDocResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    workspaceEpoch: 1,
    data: { update: seedUpdate(), revision: 3, backfilled: false, shareScope: "shared", ...overrides },
  };
}
