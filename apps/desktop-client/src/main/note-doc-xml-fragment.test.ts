// @vitest-environment node
/**
 * CRDT 批次 A 的形状验证：把笔记正文从 `Y.Array<Y.Map{content: Y.Text}>` 换成
 * y-prosemirror 的 `Y.XmlFragment`，到底成不成——**先证再铺开**。
 *
 * 四件事按重要性排：
 * 1. 同一段里两个人各打几个字，合并后两边的字都在、块数不涨（这是 blocks 差分
 *    关不掉的那个洞：A 整段重写会把 B 刚打的字盖掉）。
 * 2. 我们的六种块（段落/标题/代码/列表/引用/图片）写得进去也投影得回来——
 *    投影是 `note_blocks` 那张表，搜索、卡片证据链、导出都读它，形状一变就全断。
 * 3. 整篇写入（导入、来源转笔记、恢复版本）在 fragment 上不复制块。
 * 4. 两个副本收敛到同一份 JSON（CRDT 的基本承诺，服务端与客户端各持一份时要成立）。
 *
 * 这一条过不了，后面四个批次都不该开工。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";

type Block = { ordinal: number; type: string; content: string };

const textOf = (node: any): string => {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(textOf).join("");
};

/** 我们的行形状 → PM 的 JSON（代码/列表/引用/图片都落成**一个节点**，不摊平）。 */
function blocksToPmDoc(blocks: Block[]) {
  return {
    type: "doc",
    content: blocks.map((block) => {
      if (block.type === "heading") return { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: block.content }] };
      if (block.type === "code") return { type: "code_block", content: [{ type: "text", text: block.content }] };
      if (block.type === "quote") return { type: "blockquote", content: [{ type: "text", text: block.content }] };
      if (block.type === "list") return { type: "bullet_list", content: block.content.split("\n").map((line) => ({ type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: line }] }] })) };
      if (block.type === "image") return { type: "image", attrs: { src: block.content, alt: "" } };
      return { type: "paragraph", content: [{ type: "text", text: block.content }] };
    }),
  };
}

/** fragment → 我们的行形状。这是 `note_blocks` 的投影要替换的那一步。 */
function pmDocToBlocks(doc: any): Block[] {
  return (doc.content ?? []).map((node: any, index: number): Block => {
    if (node.type === "code_block") return { ordinal: index, type: "code", content: textOf(node) };
    if (node.type === "blockquote") return { ordinal: index, type: "quote", content: textOf(node) };
    if (node.type === "heading") return { ordinal: index, type: "heading", content: textOf(node) };
    if (node.type === "bullet_list") return { ordinal: index, type: "list", content: (node.content ?? []).map(textOf).join("\n") };
    if (node.type === "image") return { ordinal: index, type: "image", content: node.attrs?.src ?? "" };
    return { ordinal: index, type: "paragraph", content: textOf(node) };
  });
}

const freshReplica = (source: Y.Doc): { doc: Y.Doc; fragment: Y.XmlFragment } => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return { doc, fragment: doc.getXmlFragment("default") };
};

const BLOCKS: Block[] = [
  { ordinal: 0, type: "paragraph", content: "这一段两个人同时在改" },
  { ordinal: 1, type: "heading", content: "小标题" },
  { ordinal: 2, type: "code", content: "line one\nline two" },
  { ordinal: 3, type: "list", content: "- 甲\n- 乙" },
  { ordinal: 4, type: "quote", content: "引用一句" },
  { ordinal: 5, type: "image", content: "/api/uploads/abc.png" },
];

describe("笔记正文换成 Y.XmlFragment 之后", () => {
  it("同一段里两个人各打几个字：两边的字都在，块数不涨", () => {
    const a = new Y.Doc();
    const fragmentA = a.getXmlFragment("default");
    prosemirrorJSONToYXmlFragment(blocksToPmDoc(BLOCKS) as never, fragmentA);
    const b = freshReplica(a);

    // A 在段尾追加，B 在段中插入——两个位置，同一个 Y.Text。
    const textA = fragmentA.get(0)!.firstChild() as Y.Text;
    const textB = b.fragment.get(0)!.firstChild() as Y.Text;
    textA.insert(textA.length, "｜A 在段尾补的一句");
    textB.insert(6, "｜B 在中间插的，");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b.doc));
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a));

    const merged = pmDocToBlocks(yXmlFragmentToProsemirrorJSON(fragmentA) as any);
    const mergedOnB = pmDocToBlocks(yXmlFragmentToProsemirrorJSON(b.fragment) as any);
    // 这一句就是 blocks 差分做不到的那件事：旧写法里 A 的整段提交会把 B 那几个字盖掉。
    expect(merged[0].content).toContain("A 在段尾补的一句");
    expect(merged[0].content).toContain("B 在中间插的，");
    expect(merged).toHaveLength(BLOCKS.length);
    expect(mergedOnB).toEqual(merged);
  });

  it("六种块都写得进去、投影得回来（note_blocks 那张表的形状不变）", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    prosemirrorJSONToYXmlFragment(blocksToPmDoc(BLOCKS) as never, fragment);
    const roundTrip = pmDocToBlocks(yXmlFragmentToProsemirrorJSON(fragment) as any);
    expect(roundTrip).toEqual(BLOCKS);
  });

  it("整篇写入（导入、来源转笔记、恢复版本）得到干净的新形状，不出现重复块", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    prosemirrorJSONToYXmlFragment(blocksToPmDoc(BLOCKS.slice(0, 2)) as never, fragment);
    // 整篇替换：先清后写。这条路的语义本来就是"这一次提交拥有整篇"，所以它**可以**
    // 覆盖别人并发的字（4.0 定的规则：整篇写入只留给确实拥有整篇的路径）；这里要证
    // 的是形状本身不会像旧的 Y.Array 那样在并发下长出重复块。
    Y.transact(doc, () => {
      fragment.delete(0, fragment.length);
      prosemirrorJSONToYXmlFragment(blocksToPmDoc(BLOCKS) as never, fragment);
    });
    const after = pmDocToBlocks(yXmlFragmentToProsemirrorJSON(fragment) as any);
    expect(after).toEqual(BLOCKS);
    expect(new Set(after.map((block) => block.content)).size).toBe(BLOCKS.length);
  });

  it("两个副本收敛到同一份 JSON", () => {
    const a = new Y.Doc();
    prosemirrorJSONToYXmlFragment(blocksToPmDoc(BLOCKS) as never, a.getXmlFragment("default"));
    const b = freshReplica(a);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a));
    expect(yXmlFragmentToProsemirrorJSON(b.fragment)).toEqual(yXmlFragmentToProsemirrorJSON(a.getXmlFragment("default")));
  });
});
