// @vitest-environment jsdom

import { expect, it } from "vitest";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { NOTE_DOC_CONFORMANCE } from "@ailearn/shared/note-doc-conformance";
import { pmNodesToNoteBlocks } from "@ailearn/shared/note-doc-schema";
import { projectBlocks } from "./use-note-doc-live-view";

/**
 * 跨进程向量的**编辑器这一侧**：同一串字节（由服务端那份内核产出）必须由渲染层的解码
 * 路径解出同样的块（批次 C2 之后，桌面端不再有第二份内核，与服务器相对的那一份实现就是这里）。
 *
 * 为什么要单独有这一条：`projectBlocks` 走的是 `y-prosemirror` + `note-doc-schema`，而
 * 编辑器实际挂在上面的 schema 是 Milkdown preset 加属性声明拼出来的 —— 属性没在编辑器
 * 那份 schema 里声明的话，`updateYFragment` 会把 fragment 里"我的节点上没有的键"**删掉**。
 * 那种破坏在这条对拍里看得见：`sourceRef` / `imageAssetId` 一旦从解码结果里掉出去，
 * 下面两条断言立刻红（已经用变异验过：把 `pmNodesToNoteBlocks` 里 imageAssetId 那一行
 * 摘掉，第二条就喊）。
 *
 * 起点没到时 `projectBlocks` 与全量解码用的是同一条路径，所以这里读两遍同一串字节，
 * 一遍给"界面画出来的那一份"，一遍给"证据链要活着"。
 */
const decode = (): Y.Doc => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(atob(NOTE_DOC_CONFORMANCE.snapshotBase64), (c) => c.charCodeAt(0)));
  return doc;
};

/** 与 `projectBlocks` 同一条解码路径：ydom → PM JSON 的**节点数组**（不是整个 doc 对象）。 */
const nodesOf = (doc: Y.Doc): unknown[] =>
  (yXmlFragmentToProsemirrorJSON(doc.getXmlFragment("content")) as { content?: unknown[] }).content ?? [];

it("服务端写出去的字节，编辑器这一侧解得回同样的块（顺序与正文一字不差）", () => {
  const doc = decode();
  const projected = projectBlocks(doc);
  doc.destroy();

  expect(projected.map((block) => block.ordinal)).toEqual(
    NOTE_DOC_CONFORMANCE.expectedBlocks.map((block) => block.ordinal),
  );
  expect(projected.map((block) => block.content)).toEqual(
    NOTE_DOC_CONFORMANCE.expectedBlocks.map((block) => block.content),
  );
  expect(projected.map((block) => block.type)).toEqual(
    NOTE_DOC_CONFORMANCE.expectedBlocks.map((block) => block.type),
  );
});

it("块级证据链与图片资产引用在编辑器这一侧也活着", () => {
  const doc = decode();
  const blocks = pmNodesToNoteBlocks(nodesOf(doc) as never);
  doc.destroy();

  expect(blocks[1]?.sourceRef).toEqual(NOTE_DOC_CONFORMANCE.expectedBlocks[1].sourceRef);
  expect(blocks[3]?.imageAssetId).toBe(NOTE_DOC_CONFORMANCE.expectedBlocks[3].imageAssetId);
});

it("标题住在 meta 里：解出来的那一份与期望值同名字同来源", () => {
  const doc = decode();
  const meta = doc.getMap<unknown>("meta");
  const title = { title: String(meta.get("title")), titleSource: String(meta.get("titleSource")) };
  doc.destroy();

  expect(title).toEqual({ ...NOTE_DOC_CONFORMANCE.expectedTitle });
});
