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
import { Schema } from "prosemirror-model";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";

/**
 * 第一个量到的事实：`prosemirrorJSONToYXmlFragment(schema, json, fragment)` **第一个参数
 * 就是 schema**（少传直接 `schema.nodeType is not a function`，我按直觉的顺序写了两次才试出来）。
 * fragment 里存的是节点类型名与属性，投影要认得它们——也就是说形状一旦换，
 * **服务端那份 headless 文档就得知道编辑器的 schema**。这里先用一个最小 schema 证机制，
 * 批次 C 绑真编辑器时换成 Milkdown 的实际 schema，并且让服务端从同一处取——
 * 抄第二份 schema 就是"两个真相"在这条链上的新版本。
 */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block" },
    heading: { content: "text*", group: "block", attrs: { level: { default: 1 } } },
    code_block: { content: "text*", group: "block", code: true },
    blockquote: { content: "block+", group: "block" },
    bullet_list: { content: "list_item+", group: "block" },
    list_item: { content: "paragraph+" },
    image: { group: "block", attrs: { src: {}, alt: { default: "" } } },
    text: { group: "inline" },
  },
});

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
      // blockquote 的 content 是 block+，所以引用要包一层段落（schema 逼出来的形状）
      if (block.type === "quote") return { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: block.content }] }] };
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

/** `Y.XmlFragment.get(i)` 的类型是 `YXmlText | YXmlElement`，段里的行内容只在 element
 * 那一支上才有 `get(0)`——类型不知道我们存的是什么，这一层 cast 是它的边界。 */
const inlineText = (fragment: Y.XmlFragment, blockIndex: number): Y.XmlText =>
  (fragment.get(blockIndex) as Y.XmlElement).get(0) as Y.XmlText;

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
    prosemirrorJSONToYXmlFragment(schema, blocksToPmDoc(BLOCKS), fragmentA);
    const b = freshReplica(a);

    // A 在段尾追加，B 在段中插入——两个位置，同一个 Y.Text。
    // 第二个量到的事实：`Y.XmlElement` **没有** `firstChild()`（那是 DOM 的说法），
    // 段里的行内容要用 `element.get(0)` 取那个 `YXmlText`。
    const textA = inlineText(fragmentA, 0);
    const textB = inlineText(b.fragment, 0);
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
    prosemirrorJSONToYXmlFragment(schema, blocksToPmDoc(BLOCKS), fragment);
    const roundTrip = pmDocToBlocks(yXmlFragmentToProsemirrorJSON(fragment) as any);
    expect(roundTrip).toEqual(BLOCKS);
  });

  it("整篇写入（导入、来源转笔记、恢复版本）得到干净的新形状，不出现重复块", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    prosemirrorJSONToYXmlFragment(schema, blocksToPmDoc(BLOCKS.slice(0, 2)), fragment);
    // 整篇替换：先清后写。这条路的语义本来就是"这一次提交拥有整篇"，所以它**可以**
    // 覆盖别人并发的字（4.0 定的规则：整篇写入只留给确实拥有整篇的路径）；这里要证
    // 的是形状本身不会像旧的 Y.Array 那样在并发下长出重复块。
    Y.transact(doc, () => {
      fragment.delete(0, fragment.length);
      prosemirrorJSONToYXmlFragment(schema, blocksToPmDoc(BLOCKS), fragment);
    });
    const after = pmDocToBlocks(yXmlFragmentToProsemirrorJSON(fragment) as any);
    expect(after).toEqual(BLOCKS);
    expect(new Set(after.map((block) => block.content)).size).toBe(BLOCKS.length);
  });

  it("两个副本收敛到同一份 JSON", () => {
    const a = new Y.Doc();
    prosemirrorJSONToYXmlFragment(schema, blocksToPmDoc(BLOCKS), a.getXmlFragment("default"));
    const b = freshReplica(a);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a));
    expect(yXmlFragmentToProsemirrorJSON(b.fragment)).toEqual(yXmlFragmentToProsemirrorJSON(a.getXmlFragment("default")));
  });

  /**
   * 对照：**今天这套形状为什么会丢字，以及它不是 CRDT 的错。**
   *
   * 编辑器里是一份纯字符串草稿（"拷贝"），自动保存时拿它跟本机文档做差分。B 的改动
   * 已经进了本机文档、但还没进 A 的草稿（那正是实窗量到的 3.5 秒窗口）——差分于是
   * 把 B 那几个字算成"A 把它们删掉了"。换成 fragment + 编辑器直接写文档之后，
   * **没有那份拷贝**，也就没有"拷贝落后"这件事。
   */
  it("对照：草稿是拷贝时，落后的那份会把别人的字差分掉", async () => {
    const { projectNoteBlocks, writeNoteBlocks } = await import("./note-doc-blocks.ts");
    const original = "这一段两个人同时在改";
    const a = new Y.Doc();
    writeNoteBlocks(a, [{ type: "paragraph", content: original }]);
    const b = freshReplica(a);
    // B 先在自己的副本里插了一句（A 还不知道）
    (b.doc.getArray<Y.Map<unknown>>("blocks").get(0)!.get("content") as Y.Text).insert(6, "｜B 改的，");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b.doc));
    // A 的编辑器里躺着的仍是**没收到 B 那一笔之前**的草稿；它现在提交整段
    const staleDraft = `${original}｜A 补的`;
    const { syncNoteBlocksForEditor } = await import("./note-doc-blocks.ts");
    syncNoteBlocksForEditor(a, [{ type: "paragraph", content: staleDraft }]);
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a));
    const merged = (projectNoteBlocks(b.doc)[0] as { content: string }).content;
    // 今天的行为：B 的字被差分掉了——这就是这一批要买下来的东西，不是抽象的"更协同"。
    expect(merged).not.toContain("B 改的");
    expect(merged).toContain("A 补的");
  });

  it("对照：fragment 那条路上同样的两次先后写，两边的字都在", () => {
    const a = new Y.Doc();
    const fragmentA = a.getXmlFragment("default");
    prosemirrorJSONToYXmlFragment(schema, blocksToPmDoc([{ ordinal: 0, type: "paragraph", content: "这一段两个人同时在改" }]), fragmentA);
    const b = freshReplica(a);
    inlineText(b.fragment, 0).insert(6, "｜B 改的，");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b.doc));
    // A 这一侧没有"拷贝"可落后：它写的是同一个 Y.Text 的段尾。
    const textA = inlineText(fragmentA, 0);
    textA.insert(textA.length, "｜A 补的");
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a));
    const merged = pmDocToBlocks(yXmlFragmentToProsemirrorJSON(b.fragment) as any);
    expect(merged[0].content).toContain("B 改的");
    expect(merged[0].content).toContain("A 补的");
  });
});
