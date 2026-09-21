/**
 * 本机文档状态的收敛与回声规则（批次 4.4）。
 *
 * 这里测的是"渲染层能不能只说 blocks"这个决定的地基：两份状态从同一份字节出发，
 * 各自改不同的块，交换一次增量之后必须都收敛到"两处改动都在"。以及一条不对称的
 * 风险：远端更新如果被当成本机的，会被原样发回去（回声），所以它也在这里钉住。
 */
import { describe, expect, it } from "vitest";
import { createNoteDocState } from "./note-doc-state";
import { emptyNoteDoc, setNoteTitle, snapshotOf, syncNoteBlocksForEditor } from "./note-doc-blocks";

function baseBytes() {
  const doc = emptyNoteDoc();
  syncNoteBlocksForEditor(doc, [
    { type: "heading", content: "标题" },
    { type: "paragraph", content: "第一段" },
    { type: "paragraph", content: "第二段" },
  ]);
  setNoteTitle(doc, "标题", "auto");
  const bytes = snapshotOf(doc);
  doc.destroy();
  return Buffer.from(bytes).toString("base64");
}

describe("本机文档状态", () => {
  it("seed 打底、submitBlocks 返回增量，另一份状态应用后两边一致", () => {
    const base = baseBytes();
    const a = createNoteDocState();
    const b = createNoteDocState();
    a.seed(base);
    b.seed(base);

    const delta = a.submitBlocks([
      { type: "heading", content: "标题" },
      { type: "paragraph", content: "第一段（A 改的）" },
      { type: "paragraph", content: "第二段" },
    ]);
    expect(delta).toBeTruthy();
    b.applyRemote(delta!);

    expect(b.view().blocks.map((block) => block.content))
      .toEqual(["标题", "第一段（A 改的）", "第二段"]);
    expect(a.view().blocks.map((block) => block.content))
      .toEqual(b.view().blocks.map((block) => block.content));
    a.dispose();
    b.dispose();
  });

  it("两边各改一块，交换后两处都在、块数不涨", () => {
    const base = baseBytes();
    const a = createNoteDocState();
    const b = createNoteDocState();
    a.seed(base);
    b.seed(base);

    const deltaA = a.submitBlocks([
      { type: "heading", content: "标题" },
      { type: "paragraph", content: "第一段（A）" },
      { type: "paragraph", content: "第二段" },
    ]);
    const deltaB = b.submitBlocks([
      { type: "heading", content: "标题" },
      { type: "paragraph", content: "第一段" },
      { type: "paragraph", content: "第二段（B）" },
    ]);
    a.applyRemote(deltaB!);
    b.applyRemote(deltaA!);

    expect(a.view().blocks.map((block) => block.content))
      .toEqual(["标题", "第一段（A）", "第二段（B）"]);
    expect(b.view().blocks).toEqual(a.view().blocks);
    a.dispose();
    b.dispose();
  });

  it("远端更新不产生本机增量（回声会被原样发回去）", () => {
    const base = baseBytes();
    const local = createNoteDocState();
    const other = createNoteDocState();
    local.seed(base);
    other.seed(base);

    const delta = other.submitBlocks([
      { type: "heading", content: "标题" },
      { type: "paragraph", content: "远端改的" },
      { type: "paragraph", content: "第二段" },
    ]);
    local.applyRemote(delta!);
    expect(local.view().blocks[1].content).toBe("远端改的");
    // seed 与 applyRemote 都不该吐增量：它们是"别人写进来的"，再发回去就是回声。
    // 注意这里必须拿**当前**视图：交回旧视图等于把远端那次改动覆盖掉（那是合法写入，
    // 会真的产出增量），也正是"提交的 blocks 必须是最新视图 + 本地打字"这条约束的由来。
    expect(local.submitBlocks(local.view().blocks.map((block) => ({ type: block.type, content: block.content }))))
      .toBeNull();
    local.dispose();
    other.dispose();
  });

  it("什么都没改时 submitBlocks 返回 null（不空转一次上送）", () => {
    const state = createNoteDocState();
    state.seed(baseBytes());
    const same = state.view().blocks.map((block) => ({ type: block.type, content: block.content }));
    expect(state.submitBlocks(same)).toBeNull();
    state.dispose();
  });

  it("标题走同一份文档：改名不会动正文块", () => {
    const state = createNoteDocState();
    state.seed(baseBytes());
    const blocks = state.view().blocks;
    const delta = state.submitBlocks(
      blocks.map((block) => ({ type: block.type, content: block.content })),
      { title: "人工起的标题", titleSource: "manual" },
    );
    expect(delta).toBeTruthy();
    const view = state.view();
    expect(view.title).toBe("人工起的标题");
    expect(view.titleSource).toBe("manual");
    expect(view.blocks.map((block) => block.content)).toEqual(["标题", "第一段", "第二段"]);
    state.dispose();
  });
});
