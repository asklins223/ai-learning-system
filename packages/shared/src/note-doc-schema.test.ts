import assert from "node:assert/strict";
import test from "node:test";
import {
  noteBlocksToPmNodes,
  parseInlineMarkdown,
  pmNodesToNoteBlocks,
  type NoteDocBlockSpec,
} from "./note-doc-schema.ts";

/**
 * 块 ↔ ProseMirror 节点的双向换算（CRDT 批次 C 的那半"内容保真"）。
 *
 * 换形状之前，`note_blocks.content` 就是一段 Markdown 原文，编辑器自己解析它；
 * 换形状之后，正文事实源是 fragment 里的**结构**，而 `note_blocks.content` 仍是
 * Markdown 原文（下游四个消费方读它，不能改口径）。所以两边之间必须有**一对**换算，
 * 而且两个方向都要测：
 *   - 写进去不解析行内语法 → 编辑器把 `**粗**` 当正文显示（不是丢字，是最难查的那种"没坏但变了"）；
 *   - 投影回来不还原行内语法 → 搜索索引与卡片证据里的正文丢了标记，且与写进去之前不等。
 *
 * 存的约定只有一处定义（`note-blocks.ts` 文件里那张表）：list 不带 `- `、quote 不带 `> `、
 * heading 只有标题本身、code 不带围栏、image 整行是 `![说明](地址)`。这里逐条钉住，
 * 因为漂移的方向是"打开一篇没改过的笔记就显示未提交"。
 */

const roundTrip = (blocks: NoteDocBlockSpec[]) => pmNodesToNoteBlocks(noteBlocksToPmNodes(blocks));

test("六种块写得进去也投得回来，字符串一个字都不变", () => {
  const blocks: NoteDocBlockSpec[] = [
    { type: "paragraph", content: "一句普通的话" },
    { type: "heading", content: "小标题" },
    { type: "code", content: "line one\nline two" },
    { type: "list", content: "甲\n乙" },
    { type: "quote", content: "引用一句" },
    { type: "image", content: "![示意图](/api/uploads/abc.png)" },
  ];
  assert.deepEqual(roundTrip(blocks), blocks);
});

test("行内四种标记写进去是结构、投影回来是原样", () => {
  const content = "这里有 **加粗** 和 *斜体* 与 `代码` 及 [链接](https://a.test)";
  const blocks = [{ type: "paragraph", content }];
  // 写进去那一侧：标记必须变成 mark，而不是留在文本里当正文。
  const nodes = noteBlocksToPmNodes(blocks);
  const texts = (nodes[0] as { content?: { text?: string; marks?: { type: string }[] }[] }).content ?? [];
  assert.deepEqual(
    texts.filter((node) => node.marks?.length).map((node) => `${node.text}|${node.marks?.[0]?.type}`),
    ["加粗|strong", "斜体|emphasis", "代码|inlineCode", "链接|link"],
  );
  assert.ok(!texts.some((node) => node.text?.includes("**")), "粗体还在文本里当字符，编辑器会画出星号");
  assert.deepEqual(roundTrip(blocks), blocks);
});

test("嵌套写法按现有的平铺解析口径往返，不改变意思", () => {
  // `parseInlineMarkdown` 是平铺的：`[**x**](u)` 整个命中"链接"那一支，里面不再拆。
  // 这条钉住的是"两侧共用同一个解析器"这件事——序列化回去还得是同一个串。
  const blocks = [{ type: "paragraph", content: "[**加粗的链接**](https://a.test)" }];
  assert.deepEqual(roundTrip(blocks), blocks);
});

test("代码块里的星号与换行是内容，不是语法", () => {
  const blocks = [{ type: "code", content: "const a = **b**;\n// 第二行" }];
  const nodes = noteBlocksToPmNodes(blocks);
  const content = (nodes[0] as { content?: unknown[] }).content ?? [];
  assert.equal(content.length, 1, "代码块被拆成多个子节点了（换行不该变成 hardbreak）");
  assert.deepEqual(roundTrip(blocks), blocks);
});

test("段落里的换行走 hardbreak 节点，往返仍是带 \\n 的一行", () => {
  const blocks = [{ type: "paragraph", content: "第一行\n第二行" }];
  const nodes = noteBlocksToPmNodes(blocks);
  const content = (nodes[0] as { content?: { type: string }[] }).content ?? [];
  assert.ok(content.some((node) => node.type === "hardbreak"));
  assert.deepEqual(roundTrip(blocks), blocks);
});

test("存的约定：列表与引用不带标记符，标题不带 #", () => {
  const blocks = [
    { type: "list", content: "甲\n乙" },
    { type: "quote", content: "第一行\n第二行" },
    { type: "heading", content: "只有标题" },
  ];
  for (const block of roundTrip(blocks)) {
    assert.ok(!/^\s*[-*+]\s/.test(block.content), `列表块带回了项目符号：${block.content}`);
    assert.ok(!block.content.startsWith(">"), `引用块带回了 > ：${block.content}`);
    assert.ok(!block.content.startsWith("#"), `标题块带回了 # ：${block.content}`);
  }
  assert.deepEqual(roundTrip(blocks), blocks);
});

test("证据链的两个属性跟着块走一个来回", () => {
  const ref = { sourceId: "11111111-1111-4111-8111-111111111111", segmentId: "seg-1" };
  const blocks = [
    { type: "paragraph", content: "来自来源的一句", sourceRef: ref, imageAssetId: "asset-1" },
    { type: "list", content: "甲", sourceRef: ref },
  ];
  assert.deepEqual(roundTrip(blocks), blocks);
});

/**
 * 编辑器会产出、而服务端**从不写**的那些节点。
 *
 * 它们只能手写 JSON 来测：服务端那半的规格里没有 table / html / ordered_list 的
 * 完整形状（真正的形状归 Milkdown）。投影认不出来的后果是"字还在但意思变了"，
 * 所以每一条都断言投影出来的**文本形状**，不只是不抛错。
 */
test("编辑器产出的有序列表、分隔线、表格、html 都投影成既有约定的样子", () => {
  const editorNodes = [
    { type: "ordered_list", content: [
      { type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "第一步" }] }] },
      { type: "list_item", content: [{ type: "paragraph", content: [{ type: "text", text: "第二步" }] }] },
    ] },
    { type: "hr" },
    { type: "table", content: [
      { type: "table_header_row", content: [
        { type: "table_header", content: [{ type: "paragraph", content: [{ type: "text", text: "列甲" }] }] },
        { type: "table_header", content: [{ type: "paragraph", content: [{ type: "text", text: "列乙" }] }] },
      ] },
      { type: "table_row", content: [
        { type: "table_cell", content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] },
        { type: "table_cell", content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }] },
      ] },
    ] },
    { type: "html", attrs: { value: "<details>展开</details>" } },
    { type: "paragraph", content: [
      { type: "text", text: "删掉的", marks: [{ type: "strike_through" }] },
      { type: "text", text: "和" },
      { type: "text", text: "带链接的粗体", marks: [{ type: "strong" }, { type: "link", attrs: { href: "https://a.test" } }] },
    ] },
  ];
  const [list, rule, table, html, rich] = pmNodesToNoteBlocks(editorNodes as never);
  // 编号归进 list 时丢掉，与换形状之前一致（`LIST_MARKER` 连 `\d+.` 一起剥）。
  assert.deepEqual({ type: list!.type, content: list!.content }, { type: "list", content: "第一步\n第二步" });
  assert.equal(rule!.content, "---");
  assert.equal(table!.type, "paragraph", "表格在存的约定里就是一个段落");
  assert.equal(table!.content, "| 列甲 | 列乙 |\n| --- | --- |\n| 1 | 2 |");
  assert.equal(html!.content, "<details>展开</details>");
  // link 在最外：`[**x**](u)` 能被平铺解析器整串认出，`**[x](u)**` 反过来会换意思。
  assert.equal(rich!.content, "~~删掉的~~和[**带链接的粗体**](https://a.test)");
});

test("表格投影出来的文本能被既有的表格解析认回去", () => {
  // 分隔行不是装饰：`parseMarkdownTable` 要求第二行每格都匹配 `:?-{2,}:?`，
  // 少写一行就"是表格文本但不被画成表"。这条把那个契约钉在换算这一侧。
  const table = pmNodesToNoteBlocks([{
    type: "table",
    content: [{ type: "table_header_row", content: [
      { type: "table_header", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
    ] }],
  } as never] as never);
  const lines = table[0]!.content.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(/^\| :?-{2,}:? \|$/.test(lines[1] ?? ""), lines[1]);
});

test("认不出的节点类型当段落画、字不丢", () => {
  const blocks = pmNodesToNoteBlocks([{ type: "callout", content: [{ type: "text", text: "对端新增块类型里的字" }] } as never] as never);
  assert.deepEqual({ type: blocks[0]!.type, content: blocks[0]!.content }, {
    type: "paragraph",
    content: "对端新增块类型里的字",
  });
});

test("图片行认不出 Markdown 时把整串当地址，不当说明", () => {
  const blocks = pmNodesToNoteBlocks([{ type: "image", attrs: { src: "/api/uploads/x.png", alt: "" } }] as never);
  assert.equal(blocks[0]!.content, "![](/api/uploads/x.png)");
  assert.deepEqual(roundTrip(blocks), blocks);
});

test("未闭合的标记按原文留着，与阅读页同一口径", () => {
  assert.deepEqual(parseInlineMarkdown("**未闭合的加粗"), [{ kind: "text", text: "**未闭合的加粗" }]);
  const blocks = [{ type: "paragraph", content: "**未闭合的加粗" }];
  assert.deepEqual(roundTrip(blocks), blocks);
});
