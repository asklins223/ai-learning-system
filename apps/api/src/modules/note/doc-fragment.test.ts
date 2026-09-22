import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { noteDocSchemaSpec, type NoteDocBlockSpec } from "@ailearn/shared/note-doc-schema";
import {
  NOTE_DOC_FRAGMENT_KEY,
  emptyFragmentNoteDoc,
  noteDocSchema,
  projectFragmentBlocks,
  writeFragmentBlocks,
} from "./doc-fragment.ts";

/**
 * CRDT 批次 B：服务端那份 `Y.XmlFragment` 内核。
 *
 * 批次 A（`416962cd`）用一份临时 schema 证明了 fragment 这个形状买得到我们想要的东西
 * （同块不同位置能合、块数不涨）。这一份测的是**换上真规格之后还成不成**，
 * 因为 A 那份 schema 是简化过的，而形状一旦定下来就是持久化的一部分。
 *
 * 三条 A 没有覆盖、且只有在真规格上才会暴露的路：
 * - 证据链的两个属性（`sourceRef` / `imageAssetId`）现在住在**节点属性**里，
 *   而 PM 建节点只认 schema 声明过的键 —— 没声明就是静默丢掉，一个字符的报错都没有。
 * - 对端（更新的一版客户端）写了这一个 schema 不认识的块类型时，投影不能把字弄丢。
 * - "内容没变的自动保存不该产生增量"：`doc.ts` 里逐字段先比再写换来的那条，
 *   fragment 这边由 `updateYFragment` 决定，得量才知道成不成立。
 */

const BLOCKS: NoteDocBlockSpec[] = [
  { type: "paragraph", content: "这一段两个人同时在改" },
  { type: "heading", content: "小标题" },
  { type: "code", content: "line one\nline two" },
  { type: "list", content: "- 甲\n- 乙" },
  { type: "quote", content: "引用一句" },
  { type: "image", content: "/api/uploads/abc.png" },
];

const REF = { sourceId: "11111111-1111-4111-8111-111111111111", segmentId: "seg-2" };

/** 段落里那一行的 `YXmlText`（`Y.XmlElement` 没有 `firstChild()`，行内容在 `get(0)`）。 */
function inlineText(fragment: Y.XmlFragment, blockIndex: number): Y.XmlText {
  return (fragment.get(blockIndex) as Y.XmlElement).get(0) as Y.XmlText;
}

function replicaOf(source: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(source));
  return copy;
}

const blocksOf = (doc: Y.Doc) => projectFragmentBlocks(doc);
const contentOf = (blocks: readonly { content: string }[]) => blocks.map((block) => block.content);

test("六种块写得进 fragment、也投影得回 note_blocks 的行形状", () => {
  const doc = emptyFragmentNoteDoc();
  writeFragmentBlocks(doc, BLOCKS);
  const projected = blocksOf(doc);
  assert.equal(projected.length, BLOCKS.length);
  assert.deepEqual(
    projected.map((block) => ({ type: block.type, content: block.content })),
    BLOCKS.map((block) => ({ type: block.type, content: block.content })),
  );
  // ordinal 由数组下标给出：fragment 里绝不另存一份，否则它和顺序迟早打架。
  assert.deepEqual(projected.map((block) => block.ordinal), [0, 1, 2, 3, 4, 5]);
});

test("空正文写进去是一个空段落，不是零个节点", () => {
  const doc = emptyFragmentNoteDoc();
  writeFragmentBlocks(doc, []);
  // schema 的 `doc: block+` 不接受空 doc，而 `note_blocks` 允许零行；
  // 投影回来是一行空段落，编辑端拿到的是"光标的落点"而不是"没有可编辑的东西"。
  assert.deepEqual(blocksOf(doc).map((block) => block.content), [""]);
});

test("证据链的两个属性在**每一种**块上都留得住", () => {
  // 这一条是批次 B 新学来的：`prosemirrorJSONToYXmlFragment` 走 `Node.fromJSON`，
  // 没在 schema 里声明的属性会被丢掉（实测：给 paragraph 传 sourceRef 之后投影回来
  // 只剩 {"type":"paragraph","content":[…]}）。段落是"来源转笔记"最常见的产出，
  // 所以这一条按六种块各来一遍，而不是只测图片那种。
  for (const block of BLOCKS) {
    const doc = emptyFragmentNoteDoc();
    writeFragmentBlocks(doc, [{ ...block, sourceRef: REF, imageAssetId: "asset-7" }]);
    const [projected] = blocksOf(doc);
    assert.deepEqual(
      { type: projected.type, content: projected.content, sourceRef: projected.sourceRef, imageAssetId: projected.imageAssetId },
      { type: block.type, content: block.content, sourceRef: REF, imageAssetId: "asset-7" },
      `块类型 ${block.type} 丢了它的属性`,
    );
  }
});

test("没带属性时投影出来就是没有，不会凭空出现 null 键", () => {
  const doc = emptyFragmentNoteDoc();
  writeFragmentBlocks(doc, [{ type: "paragraph", content: "一句没有来源的话" }]);
  const [projected] = blocksOf(doc);
  assert.equal("sourceRef" in projected, false);
  assert.equal("imageAssetId" in projected, false);
});

test("整篇重写不复制块，未改动的块保持同一个节点", () => {
  // 这条断言为什么值得写：批次 B 一开始把"清空再整篇重写"当过差分失败时的退路，
  // 实测（把 updateYFragment 换成 delete+prosemirrorJSONToYXmlFragment 的变异）不是
  // 慢一点，是**跑不完**——43 秒后被 SIGKILL。所以 `updateYFragment` 不是偏好，
  // 是这条路唯一能落地的形状；恢复版本那一步将来也想清空重写时会撞上同一件事。
  const doc = emptyFragmentNoteDoc();
  writeFragmentBlocks(doc, BLOCKS);
  const before = doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY).get(1);
  writeFragmentBlocks(doc, [
    BLOCKS[0],
    BLOCKS[1],
    BLOCKS[2],
    BLOCKS[3],
    { type: "quote", content: "引用一句（改了）" },
    { type: "paragraph", content: "尾部新增的一段" },
  ]);
  const after = doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
  assert.equal(after.length, 6, "块数不该因为一次整篇写入而涨");
  // 同一条 `Y.XmlElement` 才算"没被换掉"：换成新条目时，别人正在这一块里打的字会被抹掉。
  assert.equal(after.get(1), before, "第 2 块内容没变，必须是同一个节点");
  const projected = blocksOf(doc);
  assert.deepEqual(contentOf(projected), [
    "这一段两个人同时在改",
    "小标题",
    "line one\nline two",
    "- 甲\n- 乙",
    "引用一句（改了）",
    "尾部新增的一段",
  ]);
});

test("内容完全没变的整篇写入不产生增量", () => {
  // 这一条量的不是"能不能写"，是**白跑一趟上送**：`doc.ts` 里逐字段先比再写就是为了让
  // "内容没变的自动保存"不推 revision。fragment 这边由 `updateYFragment` 决定，
  // 而它比属性用的是 `!==`（对象属性每次都是新字面量），所以这一条必须实测。
  // 实测结论：带 `sourceRef`（对象属性）的块也是 0 增量。
  const withRef = [{ type: "paragraph", content: "一句", sourceRef: REF }];
  for (const blocks of [BLOCKS, withRef]) {
    const doc = emptyFragmentNoteDoc();
    writeFragmentBlocks(doc, blocks);
    const before = Y.encodeStateAsUpdate(doc);
    writeFragmentBlocks(doc, JSON.parse(JSON.stringify(blocks)) as NoteDocBlockSpec[]);
    const after = Y.encodeStateAsUpdate(doc);
    assert.equal(
      after.length - before.length,
      0,
      `同样的 blocks 写第二次产生了 ${after.length - before.length} 字节增量：自动保存会白上一次送`,
    );
  }
  // 对照组：没有它，上面那两句可能只是"第二次写根本没动手"而不是"比过之后发现没变"。
  const doc = emptyFragmentNoteDoc();
  writeFragmentBlocks(doc, BLOCKS);
  const before = Y.encodeStateAsUpdate(doc);
  writeFragmentBlocks(doc, [{ ...BLOCKS[0], content: `${BLOCKS[0].content}多出来的一个字` }, ...BLOCKS.slice(1)]);
  assert.ok(Y.encodeStateAsUpdate(doc).length > before.length, "改了一个字却没产生增量：差分根本没跑");
});

/**
 * fragment 里对象属性的两副面孔（读到这一条别再往下猜）：
 * `getAttributes()` 与 `yXmlFragmentToProsemirrorJSON` 拿到的是**原对象**，
 * 而 `toString()` / `toDOM` 这类 XML 串法会把它写成 `sourceRef="[object Object]"`。
 * 我们这一侧只走对象那条（服务端投影、编辑器都从 `Node` 读），所以成立；
 * 真要按 DOM 串读这份文档（比如哪天拿 `toString()` 做导出），属性就是坏的。
 */
test("对象属性在 XML 串法里是 [object Object]，只有走节点对象才对", () => {
  const doc = emptyFragmentNoteDoc();
  writeFragmentBlocks(doc, [{ type: "paragraph", content: "一句", sourceRef: REF }]);
  const element = doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY).get(0) as Y.XmlElement;
  assert.ok(element.toString().includes('sourceRef="[object Object]"'));
  assert.deepEqual(projectFragmentBlocks(doc)[0].sourceRef, REF);
});

test("两个人在同一块里各写一句：两边的字都在，两个副本收敛", () => {
  const a = emptyFragmentNoteDoc();
  writeFragmentBlocks(a, BLOCKS);
  const b = replicaOf(a);
  const fragmentA = a.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
  const fragmentB = b.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
  inlineText(fragmentA, 0).insert(inlineText(fragmentA, 0).length, "｜A 在段尾补的一句");
  inlineText(fragmentB, 0).insert(6, "｜B 在中间插的，");
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const merged = blocksOf(a);
  assert.equal(merged.length, BLOCKS.length, "合并之后块数不该涨");
  assert.ok(merged[0].content.includes("A 在段尾补的一句"));
  assert.ok(merged[0].content.includes("B 在中间插的，"));
  assert.deepEqual(blocksOf(b), merged);
});

test("对端写了这份 schema 不认识的块类型时，按段落投影、字不丢", () => {
  const doc = emptyFragmentNoteDoc();
  writeFragmentBlocks(doc, [{ type: "paragraph", content: "已知段" }]);
  const fragment = doc.getXmlFragment(NOTE_DOC_FRAGMENT_KEY);
  // 手搭一个 schema 之外的节点，模拟"对端是更新的一版客户端，新增了一种块"。
  const callout = new Y.XmlElement("callout");
  callout.insert(0, [new Y.XmlText("对端新增块类型里的字")]);
  fragment.insert(1, [callout]);
  assert.equal((yXmlFragmentToProsemirrorJSON(fragment) as { content: unknown[] }).content.length, 2);
  const projected = blocksOf(doc);
  assert.equal(projected.length, 2);
  assert.equal(projected[1].type, "paragraph");
  assert.equal(projected[1].content, "对端新增块类型里的字");
});

test("note_blocks 的行里出现的块类型，都在 schema 里", () => {
  // 投影是"我们这一侧"的形状，schema 是"编辑器那一侧"的形状；两边靠
  // `noteBlocksToPmNodes` 对齐。写漏一种的症状不是报错，是那种块退化成段落——
  // 内容还在，但列表/引用/代码的换行含义全变了，所以这条要正面挡住。
  const spec = noteDocSchemaSpec as unknown as { nodes: Record<string, unknown> };
  const pmNodeNames = new Set(Object.keys(spec.nodes));
  const ourTypes = ["paragraph", "heading", "code", "list", "quote", "image"] as const;
  const mapped = { paragraph: "paragraph", heading: "heading", code: "code_block", list: "bullet_list", quote: "blockquote", image: "image" };
  for (const type of ourTypes) {
    assert.ok(pmNodeNames.has(mapped[type]), `块类型 ${type} 在 schema 里没有对应节点`);
    const doc = emptyFragmentNoteDoc();
    writeFragmentBlocks(doc, [{ type, content: "一句" }]);
    assert.equal(blocksOf(doc)[0].type, type, `${type} 写进去投影回来变了类型`);
  }
  // 建 schema 这件事本身要能成：`new Schema` 会校验 content 表达式，写错是在这里炸，
  // 不是等到投影时少一块。属性名是 `nodes`（不是 `nodeTypes`，那次写错读到 undefined）。
  assert.equal(noteDocSchema(), noteDocSchema(), "schema 每次都重建：它校验过一遍规格，也是节点身份的比较基准");
  assert.ok(noteDocSchema().nodes.paragraph);
  // `code: true` 是"这一块里的内容是原样"的那个标记：少了它，编辑器在代码块里回车会
  // 继续列表、粘贴会带格式，而这些都不报错，只会让代码块变成一堆段落。
  assert.equal(noteDocSchema().nodes.code_block.spec.code, true);
});
