/**
 * 主进程那份 fragment 内核的用例（批次 C）。
 *
 * 第一段测渲染层提交时真正依赖的性质：块数没变、每块只改了正文时**不动节点**，
 * 两边改不同块都留着，改同一块合并成一处，而且不复制块。
 *
 * 第二段是这一批新学来的那条：`updateYFragment` 没有"这次没给这个字段就别动它"的语义
 * （属性从目标节点的 `attrs` 抄，`null` 就是删）。而渲染层交上来的只有 `{type, content}` ——
 * 编辑器里没有"来源引用"这个概念。所以不抄回现存属性的一次自动保存，就会把整篇的
 * `sourceRef` 抹掉并被投影写进 `note_blocks`：**用户只是打了个字，证据链就断了**。
 * 这条在旧的数组形状里是靠 `writeBlock` 的 `undefined` 分支挡住的，换形状时最容易整个丢掉。
 *
 * 与 `@ailearn/shared/note-doc-conformance` 向量的对拍在最后一组：那串字节就是这份
 * 内核写的，服务端那份解它必须得到同样的块与标题——两份实现没法共用源码（一个进程里
 * 两份 yjs 会让 `instanceof` 跨份静默判假），这条就是分叉的探测器。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { NOTE_DOC_CONFORMANCE } from "@ailearn/shared/note-doc-conformance";
import {
  NOTE_DOC_FRAGMENT_KEY,
  docFromSnapshot,
  emptyNoteDoc,
  projectNoteBlocks,
  readNoteTitle,
  setNoteTitle,
  snapshotOf,
  syncNoteBlocksForEditor,
  writeNoteBlocks,
} from "./note-doc-fragment";

const REF = { sourceId: "11111111-1111-4111-8111-111111111111", segmentId: "22222222-2222-4222-8222-222222222222" };

const merge = (bytes: Uint8Array, ...locals: Y.Doc[]) => {
  const merged = docFromSnapshot(bytes);
  for (const local of locals) Y.applyUpdate(merged, snapshotOf(local));
  return merged;
};

const contents = (doc: Y.Doc) => projectNoteBlocks(doc).map((block) => block.content);

describe("与服务端内核对拍", () => {
  it("同一串字节在本内核解出同样的块与标题", () => {
    // 字节是这份内核写的（见向量文件头），服务端那份解它必须得到同样的东西：
    // 两边不能共用源码，所以这条是分叉唯一的探测器。
    const doc = docFromSnapshot(new Uint8Array(Buffer.from(NOTE_DOC_CONFORMANCE.snapshotBase64, "base64")));
    expect(projectNoteBlocks(doc)).toEqual(NOTE_DOC_CONFORMANCE.expectedBlocks);
    expect(readNoteTitle(doc)).toEqual(NOTE_DOC_CONFORMANCE.expectedTitle);
    doc.destroy();
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
    expect(contents(merge(bytes, windowA, windowB))).toEqual(["第一段（A 改的）", "第二段（B 改的）"]);
    base.destroy();
    windowA.destroy();
    windowB.destroy();
  });

  it("同一段被两边同时改：合并成一处，不产生第二份", () => {
    const base = emptyNoteDoc();
    syncNoteBlocksForEditor(base, [{ type: "paragraph", content: "开头 结尾" }]);
    const bytes = snapshotOf(base);
    const left = docFromSnapshot(bytes);
    const right = docFromSnapshot(bytes);
    syncNoteBlocksForEditor(left, [{ type: "paragraph", content: "开头 A 结尾" }]);
    syncNoteBlocksForEditor(right, [{ type: "paragraph", content: "开头 B 结尾" }]);
    const merged = contents(merge(bytes, left, right));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toContain("A");
    expect(merged[0]).toContain("B");
    base.destroy();
    left.destroy();
    right.destroy();
  });

  it("插入块时片段真的动，但不把没改的块换成新条目", () => {
    const doc = emptyNoteDoc();
    const fragment = doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
    syncNoteBlocksForEditor(doc, [
      { type: "paragraph", content: "留着的" },
      { type: "paragraph", content: "第二段" },
    ]);
    const untouched = fragment.get(0);
    syncNoteBlocksForEditor(doc, [
      { type: "paragraph", content: "留着的" },
      { type: "paragraph", content: "新插进来的" },
      { type: "paragraph", content: "第二段" },
    ]);
    expect(contents(doc)).toEqual(["留着的", "新插进来的", "第二段"]);
    // 同一个节点才算"没被换掉"：换成新条目时别人正在这一块里打的字会被抹掉。
    expect(fragment.get(0)).toBe(untouched);
    doc.destroy();
  });

  it("把一段改成标题：类型真的变了，正文与引用都跟着走", () => {
    // 工具栏的"标题"按钮就是这一条。类型变了就不可能靠改文本完成，必须退到整篇差分；
    // 退的时候不能把引用一起丢掉（上面那条覆盖的就是这件事）。
    const doc = emptyNoteDoc();
    writeNoteBlocks(doc, [
      { type: "paragraph", content: "一句话", sourceRef: REF },
      { type: "paragraph", content: "另一句" },
    ]);
    syncNoteBlocksForEditor(doc, [
      { type: "heading", content: "一句话" },
      { type: "paragraph", content: "另一句" },
    ]);
    const blocks = projectNoteBlocks(doc);
    expect(blocks.map((block) => [block.type, block.content])).toEqual([
      ["heading", "一句话"],
      ["paragraph", "另一句"],
    ]);
    expect(blocks[0]?.sourceRef).toEqual(REF);
    doc.destroy();
  });

  it("带换行的一块改了正文：走整篇差分，不会只改到第一行", () => {
    // 这一块的行内容不止一条 `YXmlText`（中间夹着 hardbreak），所以"就地改那条文本"
    // 的判据必须不成立。判据一旦去掉，症状是把整块的新文本写进**第一条**文本里，
    // 第二行留在原地——合出来一个两头都不像的段落，而且不报错。
    const doc = emptyNoteDoc();
    writeNoteBlocks(doc, [{ type: "paragraph", content: "第一行\n第二行" }]);
    syncNoteBlocksForEditor(doc, [{ type: "paragraph", content: "第一行\n第二行改过了" }]);
    expect(contents(doc)).toEqual(["第一行\n第二行改过了"]);
    doc.destroy();
  });

  it("内容完全没变的一次自动保存不产生增量", () => {
    const doc = emptyNoteDoc();
    const blocks = [{ type: "paragraph", content: "一句" }, { type: "heading", content: "标题" }];
    syncNoteBlocksForEditor(doc, blocks);
    const before = snapshotOf(doc).length;
    syncNoteBlocksForEditor(doc, JSON.parse(JSON.stringify(blocks)));
    expect(snapshotOf(doc).length).toBe(before);
    doc.destroy();
  });
});

describe("来源引用在自动保存里不被抹掉", () => {
  it("提交只带 type/content 的整篇时，每块的 sourceRef 与 imageAssetId 保持不动", () => {
    const doc = emptyNoteDoc();
    writeNoteBlocks(doc, [
      { type: "paragraph", content: "来自来源的一句", sourceRef: REF },
      { type: "image", content: "![示意图](/api/uploads/abc.png)", imageAssetId: "33333333-3333-4333-8333-333333333333" },
      { type: "list", content: "甲\n乙", sourceRef: REF },
    ]);
    const before = projectNoteBlocks(doc);
    // 走差分那一条（内容变了、块数没变）与走整篇那一条（加了一块）都要保住引用。
    syncNoteBlocksForEditor(doc, before.map((block) => ({ type: block.type, content: `${block.content}·` })));
    let after = projectNoteBlocks(doc);
    expect(after[0]?.sourceRef).toEqual(REF);
    expect(after[1]?.imageAssetId).toBe(before[1]?.imageAssetId);
    expect(after[2]?.sourceRef).toEqual(REF);

    syncNoteBlocksForEditor(doc, [...after.map((block) => ({ type: block.type, content: block.content })), { type: "paragraph", content: "新加的一块" }]);
    after = projectNoteBlocks(doc);
    expect(after).toHaveLength(4);
    expect(after[0]?.sourceRef).toEqual(REF);
    expect(after[1]?.imageAssetId).toBe(before[1]?.imageAssetId);
    expect(after[2]?.sourceRef).toEqual(REF);
    doc.destroy();
  });

  it("提交路径只管正文：清属性要走整篇写入，不会被顺手做掉", () => {
    // 渲染层交上来的永远只有 `{type, content}`，所以"把来源引用清掉"这句话只能由
    // 整篇那条路（恢复历史版本、服务端写入）说。这条断言把边界钉住：有人哪天以为
    // 自动保存能清属性，就会在属性上做出与投影不一致的假设。
    const doc = emptyNoteDoc();
    writeNoteBlocks(doc, [{ type: "paragraph", content: "一句", sourceRef: REF }]);
    syncNoteBlocksForEditor(doc, [{ type: "paragraph", content: "一句", sourceRef: null }]);
    expect(projectNoteBlocks(doc)[0]?.sourceRef).toEqual(REF);
    writeNoteBlocks(doc, [{ type: "paragraph", content: "一句", sourceRef: null }]);
    expect(projectNoteBlocks(doc)[0]?.sourceRef ?? null).toBeNull();
    doc.destroy();
  });
});

describe("形状本身", () => {
  it("标题与正文分键：改标题不动正文块，快照 round-trip 保真", () => {
    const doc = emptyNoteDoc();
    writeNoteBlocks(doc, [{ type: "code", content: "const a = 1;\nconst b = 2; // 多行不压成一行" }]);
    setNoteTitle(doc, "向量标题", "manual");
    const restored = docFromSnapshot(snapshotOf(doc));
    expect(contents(restored)).toEqual(contents(doc));
    expect(readNoteTitle(restored)).toEqual({ title: "向量标题", titleSource: "manual" });
    doc.destroy();
    restored.destroy();
  });

  it("六类块写得进也投影得回来，含行内标记与图片的 Markdown 形状", () => {
    const blocks = [
      { type: "paragraph", content: "有 **粗** 和 `码`" },
      { type: "heading", content: "小标题" },
      { type: "code", content: "line one\nline two" },
      { type: "list", content: "甲\n乙" },
      { type: "quote", content: "引用一句" },
      { type: "image", content: "![示意图](/api/uploads/abc.png)" },
    ];
    const doc = emptyNoteDoc();
    writeNoteBlocks(doc, blocks);
    expect(projectNoteBlocks(doc).map(({ ordinal: _ordinal, ...block }) => block)).toEqual(blocks);
    doc.destroy();
  });
});
