// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Schema } from "prosemirror-model";
import { Editor, rootCtx, defaultValueCtx, schemaCtx } from "@milkdown/kit/core";
import {
  commonmark,
  paragraphSchema,
  headingSchema,
  codeBlockSchema,
  blockquoteSchema,
  bulletListSchema,
  orderedListSchema,
  imageSchema,
} from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import {
  prosemirrorJSONToYXmlFragment,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror";
import { noteDocSchemaSpec } from "@ailearn/shared/note-doc-schema";

/**
 * 批次 C2 的门槛用例：**编辑器的 schema 带不带得住我们的块属性**。
 *
 * 为什么这是门槛而不是细节：`sourceRef` / `imageAssetId` 换形状之后住在**节点属性**里，
 * 而 `updateYFragment` 对"PM 节点上没有的属性"只有一种处理——删掉
 * （`for (const key in yDomAttrs) if (!(key in pAttrs)) removeAttribute(key)`）。
 * 所以编辑器的 schema 不声明这两个键的结局是：**对方在编辑器里敲一个字就抹掉证据链**，
 * 不报错也不留痕。这一条不成立就得换成"引用不归文档管"，那是产品能力的取舍，
 * 必须现在量出来，不能等写完才发现。
 *
 * 第二件事顺带钉住：服务端那份窄规格写出来的节点名，编辑器的 schema 必须全都认得，
 * 否则服务端整篇写入（导入、来源转笔记、恢复版本）的块在对端是看不见的节点。
 */

const BLOCK_NODES = ["paragraph", "heading", "code_block", "blockquote", "bullet_list", "ordered_list", "image"];
const NOTE_DOC_ATTRS = { sourceRef: { default: null }, imageAssetId: { default: null } };
const REF = { sourceId: "11111111-1111-4111-8111-111111111111" };

const serverSchema = new Schema(noteDocSchemaSpec as never);

/**
 * 带属性那一份编辑器：用 preset 自己的 `extendSchema` 逐个块类型合并属性。
 *
 * 两个都不是 guesses 的合约（都踩过一次才量出来）：
 * - 不在 `.config()` 里改 `nodesCtx`：`config` 跑在 preset 把节点推进去**之前**，
 *   那张表当时还是空的，map 一个都改不到（症状是"扩了但 schema 里什么都没有"）。
 * - `extendSchema` 的 handler 拿到的是**`(ctx) => 节点定义` 那个函数**，不是定义对象
 *   （`$nodeSchema` 的第二个参数就是它）。直接展开它会得到 `$ctx(...) is not a function`。
 */
const attrFactory = (factory: (ctx: never) => object) => (ctx: never) => {
  const definition = factory(ctx) as { attrs?: Record<string, unknown> };
  return { ...definition, attrs: { ...definition.attrs, ...NOTE_DOC_ATTRS } };
};

// `extendSchema` 的 handler 形参类型写作 `never`：它是方法签名（双变），这样七个
// preset 对象能共用一个 helper；两处 cast 的运行时合约由上面那两条注释与用例钉住。
const withNoteDocAttrs = (schemaObject: { extendSchema: (handler: never) => unknown }) =>
  schemaObject.extendSchema(attrFactory as never);

const ATTR_BEARING = [
  paragraphSchema,
  headingSchema,
  codeBlockSchema,
  blockquoteSchema,
  bulletListSchema,
  orderedListSchema,
  imageSchema,
];

function makeEditor(withAttrs: boolean) {
  let editor = Editor.make().config((ctx) => {
    ctx.set(rootCtx, document.createElement("div"));
    ctx.set(defaultValueCtx, "正文一句话");
  });
  editor = editor.use(commonmark).use(gfm) as typeof editor;
  if (withAttrs) {
    for (const schemaObject of ATTR_BEARING) editor = editor.use(withNoteDocAttrs(schemaObject) as never) as typeof editor;
  }
  return editor.create();
}

/**
 * 模拟"对端在编辑器里打了一个字"：从 fragment 读出 PM 文档（用的是**编辑器那份** schema），
 * 插一个字，再差分回 fragment。`ySyncPlugin` 在真连接里做的就是这一串。
 */
function typeIntoFragment(editorSchema: Schema): unknown {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("content");
  prosemirrorJSONToYXmlFragment(serverSchema, {
    type: "doc",
    content: [{ type: "paragraph", attrs: { sourceRef: REF }, content: [{ type: "text", text: "正文一句话" }] }],
  } as never, fragment);
  expect(fragment.get(0)!.getAttribute("sourceRef")).toBeTruthy();
  const read = yXmlFragmentToProseMirrorRootNode(fragment, editorSchema);
  // 改动直接在 JSON 上做：`Transform` 不在 prosemirror-state 的导出里（它在
  // prosemirror-transform），import 进来是 undefined，症状是一句和测试意图毫无关系的
  // `Cannot read properties of undefined (reading 'create')`。
  const json = read.toJSON() as { content?: { content?: { text?: string }[] }[] };
  json.content![0].content![0].text += "多";
  const typed = editorSchema.nodeFromJSON(json as never);
  updateYFragment(doc, fragment, typed, { mapping: new Map(), isOMark: new Map() });
  return fragment.get(0)!.getAttribute("sourceRef");
}

describe("编辑器的 schema 与 fragment 上的块属性", () => {
  it("不扩属性时：编辑器改一个字就把来源引用抹掉（这就是为什么要扩）", async () => {
    const editor = await makeEditor(false);
    const plain = editor.action((ctx) => ctx.get(schemaCtx));
    expect(plain.nodes.paragraph.spec.attrs ?? {}).not.toHaveProperty("sourceRef");
    expect(typeIntoFragment(plain)).toBeUndefined();
    editor.destroy();
  });

  it("扩了属性之后：同一个改动之后来源引用还在", async () => {
    const editor = await makeEditor(true);
    const extended = editor.action((ctx) => ctx.get(schemaCtx));
    expect(Object.keys(extended.nodes.paragraph.spec.attrs ?? {})).toEqual(
      expect.arrayContaining(["sourceRef", "imageAssetId"]),
    );
    expect(typeIntoFragment(extended)).toMatchObject(REF);
    editor.destroy();
  });

  it("服务端窄规格里的节点名，编辑器的 schema 全都认得", async () => {
    const editor = await makeEditor(true);
    const extended = editor.action((ctx) => ctx.get(schemaCtx));
    const serverNames = Object.keys((noteDocSchemaSpec as { nodes: Record<string, unknown> }).nodes);
    const unknown = serverNames.filter((name) => !extended.nodes[name]);
    // text/doc 这类两边同名才算对上；对不上就是服务端写进去的块在对端不存在。
    expect(unknown).toEqual([]);
    editor.destroy();
  });

  it("窄规格里的 mark 名也在编辑器 schema 里（行内标记靠它们往返）", async () => {
    const editor = await makeEditor(true);
    const extended = editor.action((ctx) => ctx.get(schemaCtx));
    const serverMarks = Object.keys((noteDocSchemaSpec as { marks: Record<string, unknown> }).marks);
    expect(serverMarks.filter((name) => !extended.marks[name])).toEqual([]);
    // 反向的一半：编辑器有、窄规格没有的那些（表格、html…）由投影按段落兜底，
    // 归 `note-doc-schema.test.ts` 那组"编辑器产出的节点"用例管。
    editor.destroy();
  });
});
