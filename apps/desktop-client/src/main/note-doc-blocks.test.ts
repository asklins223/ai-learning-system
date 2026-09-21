/**
 * 主进程那份 CRDT 内核的用例（批次 4.4）。
 *
 * 第一段是**对拍**：解码 `@ailearn/shared/note-doc-conformance` 里由服务端内核生成的
 * 字节，必须得到同样的块与标题。两份实现没法共用源码（同一个进程里两份 yjs 会让
 * `instanceof Y.Text` 静默判假），这条断言就是分叉的探测器。
 *
 * 第二段测的是渲染层提交时真正依赖的性质：块数没变时逐块改文本，两边改不同块都留着，
 * 改同一块合并成一处，而且不复制块。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NOTE_DOC_CONFORMANCE } from "@ailearn/shared/note-doc-conformance";
import {
  docFromSnapshot,
  emptyNoteDoc,
  projectNoteBlocks,
  readNoteTitle,
  setNoteTitle,
  snapshotOf,
  syncNoteBlocksForEditor,
} from "./note-doc-blocks";

function decodeVector() {
  return docFromSnapshot(new Uint8Array(Buffer.from(NOTE_DOC_CONFORMANCE.snapshotBase64, "base64")));
}

describe("与服务端内核对拍", () => {
  it("同一串字节解出同样的块与标题", () => {
    const doc = decodeVector();
    const blocks = projectNoteBlocks(doc);
    const title = readNoteTitle(doc);
    doc.destroy();

    expect(blocks).toEqual(NOTE_DOC_CONFORMANCE.expectedBlocks);
    expect(title).toEqual(NOTE_DOC_CONFORMANCE.expectedTitle);
  });

  it("多行代码块与块级来源引用都要活着解出来", () => {
    const doc = decodeVector();
    const blocks = projectNoteBlocks(doc);
    doc.destroy();

    expect(blocks[2]?.content).toContain("\n");
    expect(blocks[1]?.sourceRef).toEqual({
      sourceId: "11111111-1111-4111-8111-111111111111",
      segmentId: "22222222-2222-4222-8222-222222222222",
    });
    expect(blocks[3]?.imageAssetId).toBe("33333333-3333-4333-8333-333333333333");
  });
});

describe("编辑器提交的同步", () => {
  it("块数没变时两边各改一块：两处都在，块数不涨", () => {
    const base = emptyNoteDoc();
    setNoteTitle(base, "标题", "auto");
    syncNoteBlocksForEditor(base, [
      { type: "paragraph", content: "第一段" },
      { type: "paragraph", content: "第二段" },
    ]);
    const bytes = snapshotOf(base);

    const windowA = docFromSnapshot(bytes);
    const windowB = docFromSnapshot(bytes);
    syncNoteBlocksForEditor(windowA, [
      { type: "paragraph", content: "第一段（A 改的）" },
      { type: "paragraph", content: "第二段" },
    ]);
    syncNoteBlocksForEditor(windowB, [
      { type: "paragraph", content: "第一段" },
      { type: "paragraph", content: "第二段（B 改的）" },
    ]);

    const merged = docFromSnapshot(bytes);
    Y.applyUpdate(merged, snapshotOf(windowA));
    Y.applyUpdate(merged, snapshotOf(windowB));

    const contents = projectNoteBlocks(merged).map((block) => block.content);
    expect(contents).toEqual(["第一段（A 改的）", "第二段（B 改的）"]);

    base.destroy();
    windowA.destroy();
    windowB.destroy();
    merged.destroy();
  });

  it("同一段被两边同时改：合并成一处，不产生第二份", () => {
    const base = emptyNoteDoc();
    syncNoteBlocksForEditor(base, [{ type: "paragraph", content: "开头 结尾" }]);
    const bytes = snapshotOf(base);
    const left = docFromSnapshot(bytes);
    const right = docFromSnapshot(bytes);
    syncNoteBlocksForEditor(left, [{ type: "paragraph", content: "开头 A 结尾" }]);
    syncNoteBlocksForEditor(right, [{ type: "paragraph", content: "开头 B 结尾" }]);

    const merged = docFromSnapshot(bytes);
    Y.applyUpdate(merged, snapshotOf(left));
    Y.applyUpdate(merged, snapshotOf(right));
    const contents = projectNoteBlocks(merged).map((block) => block.content);
    expect(contents).toHaveLength(1);
    // 两边都插了字，合并结果必须同时含 A 与 B（不要求顺序，顺序由 CRDT 决定）。
    expect(contents[0]).toContain("A");
    expect(contents[0]).toContain("B");
    base.destroy();
    left.destroy();
    right.destroy();
    merged.destroy();
  });

  it("插入块时数组真的动，但不把没改的块换成新条目", () => {
    const base = emptyNoteDoc();
    syncNoteBlocksForEditor(base, [
      { type: "paragraph", content: "留着的" },
      { type: "paragraph", content: "第二段" },
    ]);
    syncNoteBlocksForEditor(base, [
      { type: "paragraph", content: "留着的" },
      { type: "paragraph", content: "新插进来的" },
      { type: "paragraph", content: "第二段" },
    ]);
    expect(projectNoteBlocks(base).map((block) => block.content)).toEqual([
      "留着的",
      "新插进来的",
      "第二段",
    ]);
    base.destroy();
  });

  it("未提供 sourceRef / imageAssetId 时保持不动（普通保存不抹证据链）", () => {
    const doc = decodeVector();
    const before = projectNoteBlocks(doc);
    syncNoteBlocksForEditor(
      doc,
      before.map((block) => ({ type: block.type, content: `${block.content}·` })),
    );
    const after = projectNoteBlocks(doc);
    expect(after[1]?.sourceRef).toEqual(before[1]?.sourceRef);
    expect(after[3]?.imageAssetId).toEqual(before[3]?.imageAssetId);
    doc.destroy();
  });
});
