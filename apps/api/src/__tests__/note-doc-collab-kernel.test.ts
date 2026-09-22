import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Y from "yjs";
import {
  docFromSnapshot,
  editFragmentBlockText,
  emptyFragmentNoteDoc,
  projectFragmentBlocks,
  readNoteTitle,
  restoreFragmentBlocksFrom,
  setNoteTitle,
  snapshotOf,
  writeFragmentBlocks,
  type NoteDocBlock,
} from "../modules/note/doc-fragment.ts";

/**
 * 三条差异最大的写路能不能共用一个文档形状——批量 Markdown 导入、来源转笔记、恢复历史版本。
 * 批次 4.0 是在 `Y.Array<Y.Map{content: Y.Text}>` 上验的这件事，批次 C 换到
 * `Y.XmlFragment` 之后**这批用例一条不留地跟着换**：它们守的是写路的行为（块序、证据链、
 * 并发不互相覆盖），不是某一个形状的内部构造。跑不通就要回来重议"所有写入都走 doc"这个决定。
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
  return projectFragmentBlocks(doc).map((block) => block.content);
}

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from));
  Y.applyUpdate(from, Y.encodeStateAsUpdate(to));
}

describe("三条写路共用一个文档形状", () => {
  it("批量 Markdown 导入：整篇写入再投影，块序与内容逐行相等", () => {
    const doc = emptyFragmentNoteDoc();
    const imported: NoteDocBlock[] = [
      ...blocks("导入段", 198),
      { type: "code", content: "def f(x):\n    return x  # 第二行\n" },
      { type: "math", content: "\\frac{\\partial L}{\\partial w}" },
    ];
    writeFragmentBlocks(doc, imported);

    const projected = projectFragmentBlocks(doc);
    assert.equal(projected.length, imported.length);
    // `math` 不在 schema 认得的六种块里：fragment 存的是**节点类型名**，认不出的那种按段落
    // 投影、一个字都不丢（`doc-fragment.test.ts` 钉的就是这条，理由是"因为一个类型名没认出来
    // 就不画人家写的字，是最坏的一种保守"）。数组形状能把类型名原样留着，因为它存的是字符串
    // 字段而不是节点。界面进不来这种块（`modules/note/schema.ts` 的 `z.enum` 只放那六种），
    // 所以这一格量的是内核层的宽容度，不是会发生的丢数据。
    const expected = imported.map((block) => (block.type === "math" ? { ...block, type: "paragraph" } : block));
    assert.deepEqual(
      projected.map(({ ordinal, ...block }) => ({ ...block, ordinal })),
      expected.map((block, ordinal) => ({ ...block, ordinal })),
    );
    assert.equal(projected[198].content, "def f(x):\n    return x  # 第二行\n");

    // 快照能落盘再读回（snapshot-on-idle 的前提）。
    const restored = docFromSnapshot(snapshotOf(doc));
    assert.deepEqual(projectFragmentBlocks(restored), projected);
    doc.destroy();
    restored.destroy();
  });

  it("来源转笔记：块级 sourceRef 随投影走，不会被整篇写入抹掉", () => {
    const doc = emptyFragmentNoteDoc();
    const withRefs = [
      { type: "heading", content: "标题", sourceRef: { sourceId: "src-1", segmentId: "seg-1" } },
      { type: "paragraph", content: "第一段", sourceRef: { sourceId: "src-1", segmentId: "seg-2" } },
      { type: "paragraph", content: "第二段", sourceRef: { sourceId: "src-1", segmentId: "seg-3" } },
    ];
    writeFragmentBlocks(doc, withRefs);
    assert.deepEqual(
      projectFragmentBlocks(doc).map((block) => block.sourceRef),
      [
        { sourceId: "src-1", segmentId: "seg-1" },
        { sourceId: "src-1", segmentId: "seg-2" },
        { sourceId: "src-1", segmentId: "seg-3" },
      ],
    );

    // 改中间一段的正文，前后块的回指仍在（证据链按块锚定，丢回指=卡片证据断链）。
    writeFragmentBlocks(doc, [
      withRefs[0],
      { ...withRefs[1], content: "第一段改过了" },
      withRefs[2],
    ]);
    assert.deepEqual(
      projectFragmentBlocks(doc).map((block) => [block.content, block.sourceRef]),
      [["标题", { sourceId: "src-1", segmentId: "seg-1" }],
       ["第一段改过了", { sourceId: "src-1", segmentId: "seg-2" }],
       ["第二段", { sourceId: "src-1", segmentId: "seg-3" }]],
    );
    doc.destroy();
  });

  it("恢复历史版本：替换发生在差异段，别人的并发新增不消失", () => {
    const server = emptyFragmentNoteDoc();
    writeFragmentBlocks(server, [
      { type: "paragraph", content: "v2 第一段" },
      { type: "paragraph", content: "共同的中间段" },
      { type: "paragraph", content: "共同的尾段" },
    ]);
    const v2 = snapshotOf(server);
    writeFragmentBlocks(server, [
      { type: "paragraph", content: "v1 第一段" },
      { type: "paragraph", content: "共同的中间段" },
      { type: "paragraph", content: "共同的尾段" },
    ]);

    // 另一台设备同时在尾部加了一段——恢复如果按"删光再插"就会把它抹掉。
    const other = emptyFragmentNoteDoc();
    sync(server, other);
    writeFragmentBlocks(other, [...projectFragmentBlocks(other).map(({ ordinal: _o, ...b }) => b), { type: "paragraph", content: "别人新加的尾后段" }]);

    restoreFragmentBlocksFrom(server, v2);
    sync(server, other);

    assert.deepEqual(
      contents(server),
      ["v2 第一段", "共同的中间段", "共同的尾段", "别人新加的尾后段"],
    );
    assert.deepEqual(contents(other), contents(server), "两个副本必须收敛到同一份");
    server.destroy();
    other.destroy();
  });

  it("两路自动保存同时落：块内文本合并，两处改动都在且不产生多余块", () => {
    const primary = emptyFragmentNoteDoc();
    writeFragmentBlocks(primary, blocks("段", 3));
    const windowA = emptyFragmentNoteDoc();
    const windowB = emptyFragmentNoteDoc();
    sync(primary, windowA);
    sync(primary, windowB);

    // 两个窗口持有同一份正文（旧实现里这就是同一个 OCC 令牌），各改不同的一段。
    editFragmentBlockText(windowA, 0, "A 改了第一段");
    editFragmentBlockText(windowB, 2, "B 改了第三段");

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
   * 这条从前是**特征刻画**：数组形状下整篇写入（state-based）用于并发交互编辑时，两边的
   * delete+insert 谁也取消不了谁，块数从 3 变 4。批次 C 换形状之后重跑同样的两次提交，
   * 实测是 **3 块、两处改动都在**——`updateYFragment` 把"这一块的正文变了"落成同一条
   * `YXmlText` 上的字符级操作，节点身份没换，所以没有可增殖的东西。
   *
   * 留着这条的理由变了但更硬：它是"整篇写入不再被交互路径禁用"这件事的唯一量测。
   * 哪天差分被换成"清空再重写"（`doc-fragment.test.ts` 里那条 43 秒跑不完的变异），
   * 或者块被拆成多个节点，这里就会红。交互编辑仍然**不该**用整篇写入，理由从"块数会涨"
   * 换成了"落后草稿的删除范围会盖掉对端的字"——那一条写在 `patchFragmentText` 的注释里。
   */
  it("整篇写入用于并发交互编辑：块数不涨，两边的改动都在（批次 C 实测）", () => {
    const primary = emptyFragmentNoteDoc();
    writeFragmentBlocks(primary, blocks("段", 3));
    const windowA = emptyFragmentNoteDoc();
    const windowB = emptyFragmentNoteDoc();
    sync(primary, windowA);
    sync(primary, windowB);

    writeFragmentBlocks(windowA, [{ type: "paragraph", content: "A 改了第一段" }, ...blocks("段", 2)]);
    writeFragmentBlocks(windowB, [...blocks("段", 2), { type: "paragraph", content: "B 改了第三段" }]);
    sync(windowA, primary);
    sync(windowB, primary);

    const merged = contents(primary);
    assert.equal(merged.length, 3, `块数从 3 变成 ${merged.length}：差分没跑，退成了"清空再整篇重写"`);
    assert.equal(merged[0], "A 改了第一段", "甲第 1 块的改动没落地");
    assert.equal(merged[1], "段 0", "甲第 2 块的改动没落地");
    // 第 3 块两边都动过（甲那份落后一格的整篇把它写成"段 1"、乙写成"B 改了第三段"）：
    // 并发插到同一处的字符**两拨都留着**，谁在前由 client id 决定，所以这里比字不比序。
    assert.equal(merged[2].replace("B 改了第三段", ""), "1", "同一块里的两处并发改动没有都留下");
    primary.destroy();
    windowA.destroy();
    windowB.destroy();
  });

  it("同一块被两边同时改：块数不变，文本合并成一处", () => {
    const a = emptyFragmentNoteDoc();
    const b = emptyFragmentNoteDoc();
    writeFragmentBlocks(a, [{ type: "paragraph", content: "原文" }]);
    sync(a, b);
    editFragmentBlockText(a, 0, "A 的写法");
    editFragmentBlockText(b, 0, "B 的写法");
    sync(a, b);

    const merged = contents(a);
    assert.equal(merged.length, 1, `同一段被改成了 ${merged.length} 块——块级替换没被消除`);
    assert.deepEqual(contents(b), merged, "两个副本必须一致");
    // 字符级合并：两边都插在同一位置，结果保留两句话，而不是谁的都不剩。
    assert.ok(merged[0].includes("A 的写法") && merged[0].includes("B 的写法"), merged[0]);
    a.destroy();
    b.destroy();
  });

  /**
   * `editFragmentBlockText` 的两条分支各钉一条，否则退回整篇差分那一支就是没人的代码。
   *
   * 判据是"块里那一条 `YXmlText` 的字 == 这一块投影出来的正文"：满足才做字符级就地改
   * （上面那两条用例走的就是这一支）。列表/引用是容器、带换行的段落是
   * `YXmlText + hardbreak + YXmlText`，拿其中一条文本去接整块的新内容会写出半截正文，
   * 所以它们必须走差分退回——未改动的块仍是同一个节点，别人的并发编辑不受影响。
   */
  it("改一块的正文：容器块与带换行的块走差分，其余块的字一个不动", () => {
    const doc = emptyFragmentNoteDoc();
    writeFragmentBlocks(doc, [
      { type: "list", content: "- 甲\n- 乙" },
      { type: "quote", content: "引用一句" },
      { type: "paragraph", content: "第一行\n第二行" },
      { type: "paragraph", content: "不动的一段" },
    ]);
    const untouched = contents(doc)[3];

    editFragmentBlockText(doc, 0, "- 甲\n- 乙\n- 丙");
    editFragmentBlockText(doc, 1, "引用改过了");
    editFragmentBlockText(doc, 2, "第一行\n第二行改过了\n新加的一行");

    const after = projectFragmentBlocks(doc);
    assert.equal(after.length, 4, `改三块的正文把块数改成了 ${after.length}`);
    assert.deepEqual(contents(doc), ["- 甲\n- 乙\n- 丙", "引用改过了", "第一行\n第二行改过了\n新加的一行", untouched]);
    // 退回整篇差分那一条路的正向对照：投影与文档必须还闭合，否则下一次落盘会写出另一套行。
    assert.deepEqual(contents(docFromSnapshot(snapshotOf(doc))), contents(doc));
    doc.destroy();
  });

  it("标题与正文分键：改标题不动正文块，快照 round-trip 保真", () => {
    const doc = emptyFragmentNoteDoc();
    writeFragmentBlocks(doc, blocks("正文", 2));
    setNoteTitle(doc, "新的标题", "manual");
    assert.deepEqual(contents(doc), ["正文 0", "正文 1"]);
    const snapshot = snapshotOf(doc);
    const revived = docFromSnapshot(snapshot);
    assert.deepEqual(readNoteTitle(revived), { title: "新的标题", titleSource: "manual" });
    doc.destroy();
    revived.destroy();
  });
});
