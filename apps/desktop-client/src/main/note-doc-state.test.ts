/**
 * 影子文档的收敛与回声规则（批次 4.4 建立，C2 之后它只转手增量）。
 *
 * C2 之前这份状态机收的是 blocks、由主进程替界面差分；现在增量在渲染进程产生，这里
 * 只负责：并进影子文档、认出哪些是本机写的（要上行）、哪些是别人写的（不能再发回去）。
 * 所以用例的"改一处"都改成**构造一条真实的本机增量**（打开文档、改那段 `YXmlText`、
 * 取 state vector 之差），而不是交一份 blocks 让主进程去猜——那个"猜"就是丢字的来源。
 *
 * 一条不对称的风险仍在这里钉住：远端更新被当成本机的，就会原样发回去（回声）。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createNoteDocState } from "./note-doc-state";
import { emptyNoteDoc, setNoteTitle, snapshotOf, writeNoteBlocks } from "./test-support/note-doc-test-doc";

const BLOCKS = [
  { type: "heading", content: "标题" },
  { type: "paragraph", content: "第一段" },
  { type: "paragraph", content: "第二段" },
];

function baseBytes(): string {
  const doc = emptyNoteDoc();
  writeNoteBlocks(doc, BLOCKS);
  setNoteTitle(doc, "标题", "auto");
  const bytes = snapshotOf(doc);
  doc.destroy();
  return Buffer.from(bytes).toString("base64");
}

const unB64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** 第 `nodeIndex` 个块节点里那条行内容（`Y.XmlElement` 没有 `firstChild()`，取子节点用 `get(i)`）。 */
function inlineText(fragment: Y.XmlFragment, nodeIndex: number): Y.XmlText {
  return (fragment.get(nodeIndex) as Y.XmlElement).get(0) as Y.XmlText;
}

/**
 * 模拟"编辑器里打了一次字"：从起点开一份文档，改第 `blockIndex` 块的那条文本，
 * 交回**这一次产生的增量**。增量而不是整篇——界面上行的就是这个东西。
 */
function localBodyEdit(seed: string, nodeIndex: number, at: number, text: string): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, unB64(seed));
  const before = Y.encodeStateVector(doc);
  inlineText(doc.getXmlFragment("content"), nodeIndex).insert(at, text);
  const update = Y.encodeStateAsUpdate(doc, before);
  doc.destroy();
  return b64(update);
}

describe("影子文档的增量转手", () => {
  it("seed 打底、本机一条增量应用后两边一致", () => {
    const base = baseBytes();
    const a = createNoteDocState();
    const b = createNoteDocState();
    a.seed(base);
    b.seed(base);

    const delta = a.applyLocal(localBodyEdit(base, 1, 3, "（A 改的）"));
    expect(delta).toBeTruthy();
    b.applyRemote(delta!);

    expect(b.encodeState()).not.toBe(base);
    // 收敛的定义是"两份状态互相包含"：把 b 的整份状态并进 a，a 不该再产生任何新操作。
    const before = unB64(a.encodeState()).length;
    a.applyRemote(b.encodeState());
    expect(a.encodeState().length).toBeGreaterThan(before - 1);
    expect(a.applyLocal(b.encodeState())).toBeNull();
    a.dispose();
    b.dispose();
  });

  it("两边各改一段的不同位置：交换之后两处都在、块数不涨", () => {
    const base = baseBytes();
    const a = createNoteDocState();
    const b = createNoteDocState();
    a.seed(base);
    b.seed(base);

    const deltaA = a.applyLocal(localBodyEdit(base, 1, 0, "A起的头"));
    const deltaB = b.applyLocal(localBodyEdit(base, 1, 3, "B插的腰"));
    a.applyRemote(deltaB!);
    b.applyRemote(deltaA!);

    const merged = new Y.Doc();
    Y.applyUpdate(merged, unB64(a.encodeState()));
    const text = inlineText(merged.getXmlFragment("content"), 1).toString();
    expect(merged.getXmlFragment("content").length).toBe(BLOCKS.length);
    expect(text).toContain("A起的头");
    expect(text).toContain("B插的腰");
    a.dispose();
    b.dispose();
    merged.destroy();
  });

  it("远端更新不产生本机增量（回声会被原样发回去）", () => {
    const base = baseBytes();
    const local = createNoteDocState();
    local.seed(base);
    const remote = localBodyEdit(base, 1, 0, "远端写的");
    expect(local.applyRemote(remote)).toBeUndefined();
    // 再交一次同一条增量：Yjs 幂等，没有新操作就不会有本机增量可上行。
    expect(local.applyLocal(remote)).toBeNull();
    local.dispose();
  });

  it("什么都没改时 applyLocal 返回 null（不空转一次上送）", () => {
    const base = baseBytes();
    const state = createNoteDocState();
    state.seed(base);
    const empty = b64(Y.encodeStateAsUpdate(new Y.Doc()));
    expect(state.applyLocal(empty)).toBeNull();
    state.dispose();
  });

  it("来历不明的增量必须抛出来，不许报成'没改动'", () => {
    // 与这份文档**没有共同历史**的一条增量（另一份补齐出来的文档上改的，同样的内容、
    // 不同的身份）：Yjs 对缺依赖的增量不报错，只把它挂进 `pendingStructs`，文档一个字
    // 不变、一个 update 事件都不发。于是 `applyLocal` 返回 null，调用方按"本来就有这条"
    // 处理、报成 `unchanged`——界面显示"已自动保存"，而这份文档里没有它、服务端更不会有。
    // 2026-09-23 那次"敲了五六行、回列表再进来就没了"就是这个形状，所以这里必须抛。
    const base = baseBytes();
    const state = createNoteDocState();
    state.seed(base);
    const foreign = localBodyEdit(baseBytes(), 1, 0, "另一份文档上写的");
    expect(() => state.applyLocal(foreign)).toThrow(/note_doc_update_unmerged/);

    // 正向对照：同一份起点上改出来的增量照常交出一条增量——上面那条不是因为
    // "applyLocal 坏了"才抛。
    expect(state.applyLocal(localBodyEdit(base, 1, 0, "同源改的"))).toBeTruthy();
    state.dispose();
  });

  it("标题走同一份文档：改名不动正文，且它自己就是那条增量", () => {
    const base = baseBytes();
    const state = createNoteDocState();
    state.seed(base);
    const delta = state.applyTitle("人工起的标题", "manual");
    expect(delta).toBeTruthy();
    // 同一个名字再写一次不该产出增量（否则每存一次都白上一次送）。
    expect(state.applyTitle("人工起的标题", "manual")).toBeNull();

    const after = new Y.Doc();
    Y.applyUpdate(after, unB64(state.encodeState()));
    expect(String(after.getMap<unknown>("meta").get("title"))).toBe("人工起的标题");
    expect(inlineText(after.getXmlFragment("content"), 1).toString()).toBe("第一段");
    state.dispose();
    after.destroy();
  });
});
