import assert from "node:assert/strict";
import test from "node:test";
import {
  noteBlocksToPmNodes,
  noteDocSchemaSpec,
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

test("服务端写段落里的图片：写出去是节点，不是那串标记字", () => {
  // 改前实测：`noteBlocksToPmNodes` 把 `![配图](…)` 整串塞进一个 text 节点，
  // 编辑器于是把标记当正文显示（导入、来源转笔记、恢复历史版本三条路都踩）。
  const nodes = noteBlocksToPmNodes([{ type: "paragraph", content: "上图：![配图](/api/uploads/a.png)，如下" }]);
  const content = (nodes[0] as { content?: { type: string; text?: string }[] }).content ?? [];
  assert.deepEqual(content.map((node) => node.type), ["text", "image", "text"]);
  assert.deepEqual(roundTrip([{ type: "paragraph", content: "上图：![配图](/api/uploads/a.png)，如下" }]), [
    { type: "paragraph", content: "上图：![配图](/api/uploads/a.png)，如下" },
  ]);
});

test("块级图片写的是 paragraph > image，投回来仍然是 image 那一档", () => {
  // 编辑器里图片只有行内一个位置，所以文档里不存在"顶层图片节点"这种形状；
  // 但 `note_blocks.type` 上挂着数据库约束（`image_asset_id` 只允许出现在 type='image' 的行），
  // 服务端另有十处按这个类型分叉，所以"整段就一张图"必须认回 `image`。
  const blocks = [{ type: "image", content: "![整块图](/api/uploads/b.png)", imageAssetId: "asset-9" }];
  const nodes = noteBlocksToPmNodes(blocks);
  assert.equal((nodes[0] as { type: string }).type, "paragraph");
  assert.deepEqual((nodes[0] as { content?: { type: string }[] }).content?.map((node) => node.type), ["image"]);
  assert.deepEqual(roundTrip(blocks), blocks);
  // 夹在字里的那张不算块级图片，它归段落。
  const mixed = pmNodesToNoteBlocks([{
    type: "paragraph",
    content: [{ type: "image", attrs: { src: "/a.png", alt: "图" } }, { type: "text", text: "旁边还有字" }],
  } as never] as never);
  assert.equal(mixed[0]!.type, "paragraph");
  assert.equal(mixed[0]!.content, "![图](/a.png)旁边还有字");
});

/**
 * 窄规格与编辑器 schema 的**位置**也要一致（名字对上了放不进去一样是丢内容）。
 * 这一条只钉得住"规格自己编译得过"，另一半（编辑器读出来是 image 节点还是文本）在
 * `apps/desktop-client/.../note-doc-editor-binding.test.tsx` —— 那里才有真编辑器的 schema。
 */
test("窄规格里 hardbreak 与 image 都带 inline: true，段落才收得下 inline*", () => {
  // prosemirror-model 判行内只看 `!(spec.inline || name=="text")`，组名不参与。
  // 少写这一个标记，`new Schema(noteDocSchemaSpec)` 当场报 Mixing inline and block content。
  const spec = noteDocSchemaSpec as unknown as {
    nodes: Record<string, { inline?: boolean; group?: string; content?: string }>;
  };
  for (const name of ["hardbreak", "image"]) {
    assert.equal(spec.nodes[name]!.inline, true, `${name} 没标 inline，段落的 inline* 会拒收它`);
  }
  assert.equal(spec.nodes.paragraph!.content, "inline*");
  assert.equal(spec.nodes.heading!.content, "inline*");
});

test("未闭合的标记按原文留着，与阅读页同一口径", () => {
  assert.deepEqual(parseInlineMarkdown("**未闭合的加粗"), [{ kind: "text", text: "**未闭合的加粗" }]);
  const blocks = [{ type: "paragraph", content: "**未闭合的加粗" }];
  assert.deepEqual(roundTrip(blocks), blocks);
});

/**
 * 下面这几条钉的是 2026-09-24 阅读页对拍量出来的那几类"编辑器里有、投影回来没有"。
 * 共同点不是显示样式不好看，是**内容凭空少了一块**：这条投影同时喂着服务端的
 * `note_blocks`，所以丢的那半在搜索与卡片证据里也一样不存在。
 */
test("段落里的行内图片投影成 Markdown，不再整块变空", () => {
  // Milkdown 的 image 是 `inline: true, group: "inline"`，所以编辑器写出的就是
  // `paragraph > image`。它没有文本也没有子节点，投影漏掉它时症状是"这一块的正文变成空串"。
  const nodes = [{
    type: "paragraph",
    content: [
      { type: "text", text: "上图：" },
      { type: "image", attrs: { src: "/api/uploads/a.png", alt: "示意图" } },
      { type: "text", text: "，如下" },
    ],
  }];
  const [block] = pmNodesToNoteBlocks(nodes as never);
  assert.equal(block!.content, "上图：![示意图](/api/uploads/a.png)，如下");
  // 写侧此刻还放不进去（规格里 image 是块级），所以往返必须**稳定在原样**，
  // 不能一次比一次少字。
  assert.deepEqual(roundTrip([{ type: "paragraph", content: block!.content }]), [
    { type: "paragraph", content: block!.content },
  ]);
});

test("图片语法不被拆成「一个感叹号 + 一个链接」", () => {
  assert.deepEqual(parseInlineMarkdown("![示意图](/a.png)"), [
    { kind: "image", alt: "示意图", src: "/a.png" },
  ]);
});

test("删除线两侧对称：序列化写 ~~，解析也认得 ~~", () => {
  // `applyMarks` 一直在写 `~~x~~`，而解析器没有这一支——写进服务端的删除线在对端编辑器
  // 里是字面的波浪号。这条把"只写不读"那种半边实现钉住。
  const [block] = pmNodesToNoteBlocks([{
    type: "paragraph",
    content: [{ type: "text", text: "作废", marks: [{ type: "strike_through" }] }],
  } as never] as never);
  assert.equal(block!.content, "~~作废~~");
  assert.deepEqual(parseInlineMarkdown("~~作废~~"), [{ kind: "strike", text: "作废" }]);
  const nodes = noteBlocksToPmNodes([{ type: "paragraph", content: "~~作废~~" }]);
  const texts = (nodes[0] as { content?: { text?: string; marks?: { type: string }[] }[] }).content ?? [];
  assert.deepEqual(
    texts.filter((node) => node.marks?.length).map((node) => `${node.text}|${node.marks?.[0]?.type}`),
    ["作废|strike_through"],
  );
});

test("表格单元里的换行与竖线不会把整张表打回散文", () => {
  // `parseMarkdownTable` 按行认表：每行都要以 `|` 开头结尾。单元里带进一个换行，
  // 那一行就不像表格线了，读侧于是把整张表当普通段落画（竖线全露出来）。
  const cell = (content: { type: string; text?: string }[]) => ({
    type: "table_cell",
    content: [{ type: "paragraph", content }],
  });
  const [block] = pmNodesToNoteBlocks([{
    type: "table",
    content: [
      { type: "table_header_row", content: [
        { type: "table_header", content: [{ type: "paragraph", content: [{ type: "text", text: "列甲" }] }] },
        { type: "table_header", content: [{ type: "paragraph", content: [{ type: "text", text: "列乙" }] }] },
      ] },
      { type: "table_row", content: [
        cell([{ type: "text", text: "格里" }, { type: "hardbreak" }, { type: "text", text: "换行" }]),
        cell([{ type: "text", text: "a|b" }]),
      ] },
    ],
  } as never] as never);
  const lines = block!.content.split("\n");
  // 表头 + 分隔行 + 这一行数据：单元里那个换行**不该**再多撑出一行。
  assert.equal(lines.length, 3, `表格被单元里的换行撑成了 ${lines.length} 行`);
  for (const line of lines) {
    assert.ok(line.startsWith("|") && line.endsWith("|"), `这一行不再像表格：${line}`);
  }
  // 两列还是两列：单元里的 `|` 转义过，不会被当成列分隔符。第三行才是数据行。
  const dataRow = lines[lines.length - 1]!;
  assert.equal(dataRow.slice(1, -1).split(/(?<!\\)\|/).length, 2, dataRow);
});
