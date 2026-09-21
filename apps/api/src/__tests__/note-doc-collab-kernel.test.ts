import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Y from "yjs";
import {
  docFromSnapshot,
  emptyNoteDoc,
  projectNoteBlocks,
  readNoteTitle,
  restoreNoteBlocksFrom,
  setNoteTitle,
  snapshotOf,
  writeNoteBlocks,
  editBlockContent,
  type NoteDocBlock,
} from "../modules/note/doc.ts";

/**
 * 批次 4 的 4.0 前置验证：一条 headless Y.Doc 形状，能不能同时承载差异最大的三条
 * 写路——批量 Markdown 导入、来源转笔记、恢复历史版本。跑不通就要回来重议"所有
 * 写入都走 doc"这个决定，而不是把笔记写入留在半迁移状态。
 *
 * 这组用例同时是审查里那条"两个人/两个窗口持同一个 OCC 令牌双双通过检查、后写
 * 把前写覆盖且无从恢复"的行为测试：修复的判据不是"有没有加锁"，而是**两边的内容
 * 都还在，而且两个副本最终一致**。
 */

function blocks(prefix: string, count: number): NoteDocBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    type: "paragraph",
    content: `${prefix} ${index}`,
  }));
}

function contents(doc: Y.Doc): string[] {
  return projectNoteBlocks(doc).map((block) => block.content);
}

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
  Y.applyUpdate(from, Y.encodeStateAsUpdate(to));
}

describe("4.0 三条写路共用一个文档形状", () => {
  it("批量 Markdown 导入：整篇写入再投影，块序与内容逐行相等", () => {
    const doc = emptyNoteDoc();
    const imported: NoteDocBlock[] = [
      ...blocks("导入段", 198),
      { type: "code", content: "def f(x):\n    return x  # 第二行\n" },
      { type: "math", content: "\\frac{\\partial L}{\\partial w}" },
    ];
    writeNoteBlocks(doc, imported);

    const projected = projectNoteBlocks(doc);
    assert.equal(projected.length, imported.length);
    assert.deepEqual(projected.map(({ ordinal, ...block }) => ({ ...block, ordinal })), imported.map((block, ordinal) => ({ ...block, ordinal })));
    assert.equal(projected[198].content, "def f(x):\n    return x  # 第二行\n");

    // 快照能落盘再读回（snapshot-on-idle 的前提）。
    const restored = docFromSnapshot(snapshotOf(doc));
    assert.deepEqual(projectNoteBlocks(restored), projected);
    doc.destroy();
    restored.destroy();
  });

  it("来源转笔记：块级 sourceRef 随投影走，不会被整篇写入抹掉", () => {
    const doc = emptyNoteDoc();
    const withRefs = [
      { type: "heading", content: "标题", sourceRef: { sourceId: "src-1", segmentId: "seg-1" } },
      { type: "paragraph", content: "第一段", sourceRef: { sourceId: "src-1", segmentId: "seg-2" } },
      { type: "paragraph", content: "第二段", sourceRef: { sourceId: "src-1", segmentId: "seg-3" } },
    ];
    writeNoteBlocks(doc, withRefs);
    assert.deepEqual(
      projectNoteBlocks(doc).map((block) => block.sourceRef),
      [
        { sourceId: "src-1", segmentId: "seg-1" },
        { sourceId: "src-1", segmentId: "seg-2" },
        { sourceId: "src-1", segmentId: "seg-3" },
      ],
    );

    // 改中间一段的正文，前后块的回指仍在（证据链按块锚定，丢回指=卡片证据断链）。
    writeNoteBlocks(doc, [
      withRefs[0],
      { ...withRefs[1], content: "第一段改过了" },
      withRefs[2],
    ]);
    assert.deepEqual(
      projectNoteBlocks(doc).map((block) => [block.content, block.sourceRef]),
      [["标题", { sourceId: "src-1", segmentId: "seg-1" }],
       ["第一段改过了", { sourceId: "src-1", segmentId: "seg-2" }],
       ["第二段", { sourceId: "src-1", segmentId: "seg-3" }]],
    );
    doc.destroy();
  });

  it("恢复历史版本：替换发生在差异段，别人的并发新增不消失", () => {
    const server = emptyNoteDoc();
    writeNoteBlocks(server, [
      { type: "paragraph", content: "v2 第一段" },
      { type: "paragraph", content: "共同的中间段" },
      { type: "paragraph", content: "共同的尾段" },
    ]);
    const v2 = snapshotOf(server);
    writeNoteBlocks(server, [
      { type: "paragraph", content: "v1 第一段" },
      { type: "paragraph", content: "共同的中间段" },
      { type: "paragraph", content: "共同的尾段" },
    ]);

    // 另一台设备同时在尾部加了一段——恢复如果按"删光再插"就会把它抹掉。
    const other = emptyNoteDoc();
    sync(server, other);
    writeNoteBlocks(other, [...projectNoteBlocks(other).map(({ ordinal: _o, ...b }) => b), { type: "paragraph", content: "别人新加的尾后段" }]);

    restoreNoteBlocksFrom(server, v2);
    sync(server, other);

    assert.deepEqual(
      contents(server),
      ["v2 第一段", "共同的中间段", "共同的尾段", "别人新加的尾后段"],
    );
    assert.deepEqual(contents(other), contents(server), "两个副本必须收敛到同一份");
    server.destroy();
    other.destroy();
  });

  it("两路自动保存同时落：块内 Y.Text 合并，两处改动都在且不产生多余块", () => {
    const primary = emptyNoteDoc();
    writeNoteBlocks(primary, blocks("段", 3));
    const windowA = emptyNoteDoc();
    const windowB = emptyNoteDoc();
    sync(primary, windowA);
    sync(primary, windowB);

    // 两个窗口持有同一份正文（旧实现里这就是同一个 OCC 令牌），各改不同的一段。
    editBlockContent(windowA, 0, "A 改了第一段");
    editBlockContent(windowB, 2, "B 改了第三段");

    sync(windowA, primary);
    sync(windowB, primary);

    const merged = contents(primary);
    assert.equal(merged.length, 3, `块数增殖成 ${merged.length}——说明有人在用整块替换做交互编辑`);
    assert.equal(merged[0], "A 改了第一段", "A 的改动被冲掉了");
    assert.equal(merged[2], "B 改了第三段", "B 的改动被冲掉了");
    primary.destroy();
    windowA.destroy();
    windowB.destroy();
  });

  /**
   * 这条不是"期望行为"，是**特征刻画**：整篇写入（state-based）用于并发交互编辑时，
   * 两边的 delete+insert 谁也取消不了谁，块数从 3 变 4。留下它是为了让这个错误
   * 不能悄悄回来——自动保存一旦图省事改回"提交整篇"，这条就会红。
   */
  it("整篇写入不能用于并发交互编辑：它会复制块（4.0 实测）", () => {
    const primary = emptyNoteDoc();
    writeNoteBlocks(primary, blocks("段", 3));
    const windowA = emptyNoteDoc();
    const windowB = emptyNoteDoc();
    sync(primary, windowA);
    sync(primary, windowB);

    writeNoteBlocks(windowA, [{ type: "paragraph", content: "A 改了第一段" }, ...blocks("段", 2)]);
    writeNoteBlocks(windowB, [...blocks("段", 2), { type: "paragraph", content: "B 改了第三段" }]);
    sync(windowA, primary);
    sync(windowB, primary);

    assert.equal(contents(primary).length, 4, "整块替换在并发下必然复制块——所以交互路径必须发增量");
    primary.destroy();
    windowA.destroy();
    windowB.destroy();
  });

  it("同一块被两边同时改：块数不变，文本合并成一处", () => {
    const a = emptyNoteDoc();
    const b = emptyNoteDoc();
    writeNoteBlocks(a, [{ type: "paragraph", content: "原文" }]);
    sync(a, b);
    editBlockContent(a, 0, "A 的写法");
    editBlockContent(b, 0, "B 的写法");
    sync(a, b);

    const merged = contents(a);
    assert.equal(merged.length, 1, `同一段被改成了 ${merged.length} 块——块级替换没被消除`);
    assert.deepEqual(contents(b), merged, "两个副本必须一致");
    // 字符级合并：两边都插在同一位置，结果保留两句话，而不是谁的都不剩。
    assert.ok(merged[0].includes("A 的写法") && merged[0].includes("B 的写法"), merged[0]);
    a.destroy();
    b.destroy();
  });

  it("标题与正文分键：改标题不动正文块，快照 round-trip 保真", () => {
    const doc = emptyNoteDoc();
    writeNoteBlocks(doc, blocks("正文", 2));
    setNoteTitle(doc, "新的标题", "manual");
    assert.deepEqual(contents(doc), ["正文 0", "正文 1"]);
    const snapshot = snapshotOf(doc);
    const revived = docFromSnapshot(snapshot);
    assert.deepEqual(readNoteTitle(revived), { title: "新的标题", titleSource: "manual" });
    doc.destroy();
    revived.destroy();
  });
});
