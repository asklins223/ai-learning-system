/**
 * 服务端内核 ↔ 跨进程向量的对拍（批次 4.4 建立，批次 C 换形状之后重新闭合）。
 *
 * 这份用例回答一个问题：**主进程那边解码的字节，确实是这份内核写出去的语义**。
 * 两边没法共用源码（同一个进程里两份 yjs 会让 `instanceof` 跨份静默判假），所以"两份
 * 实现悄悄分叉"只能由这条机器发现。向量现在是 `Y.XmlFragment` 那一版的编码，且由
 * **主进程那份**内核产出——服务端解它必须得到 `expectedBlocks`：哪一边改了字段、属性、
 * 块容器或行内标记的序列化，哪一边自己红。
 *
 * 换形状那一段路上它一度是断开的（旧字节是 `Y.Array<Y.Map>`，新内核解出 0 块）。当时
 * 没有把期望值改掉让它重新变绿，而是把"解出 0 块"写成断言——分叉要看得见才不会再被
 * 遮回去。现在两端都在 fragment 上了，向量与期望值一起换，这条恢复成本来的样子。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTE_DOC_CONFORMANCE } from "@ailearn/shared/note-doc-conformance";
import {
  docFromSnapshot,
  emptyFragmentNoteDoc,
  projectFragmentBlocks,
  readNoteTitle,
  setNoteTitle,
  snapshotOf,
  writeFragmentBlocks,
  type NoteDocBlock,
} from "../modules/note/doc-fragment.ts";

const vectorBytes = () => new Uint8Array(Buffer.from(NOTE_DOC_CONFORMANCE.snapshotBase64, "base64"));

test("固定向量解出与主进程那份内核一致的块与标题", () => {
  const doc = docFromSnapshot(vectorBytes());
  const title = readNoteTitle(doc);
  const blocks = projectFragmentBlocks(doc);
  doc.destroy();

  assert.deepEqual({ ...(title ?? {}) }, { ...NOTE_DOC_CONFORMANCE.expectedTitle });
  assert.deepEqual(blocks, NOTE_DOC_CONFORMANCE.expectedBlocks);
  // 这两件是向量最初想护住的具体形状：多行代码不被压平、块级来源引用活得过一轮编码。
  assert.ok(String(blocks[2]?.content).includes("\n"), "多行代码块被压成了一行");
  assert.deepEqual(blocks[1]?.sourceRef, NOTE_DOC_CONFORMANCE.expectedBlocks[1].sourceRef);
  assert.equal(blocks[3]?.imageAssetId, "33333333-3333-4333-8333-333333333333");
});

test("从块重建再编码，解回来仍是同一份（写侧认这个形状）", () => {
  // 向量管的是"两边解同一串字节得到同一份东西"；这一条管另一侧——**写**进去的块与投影
  // 回来的块闭合。三件事：编码-解码闭合、只改一段时其余块原样解出来、证据链活过一轮编码。
  const source = emptyFragmentNoteDoc();
  const original: NoteDocBlock[] = [
    { type: "heading", content: "标题里的中文与 English" },
    {
      type: "paragraph",
      content: "第一段：改一处不该顶掉另一处。",
      sourceRef: {
        sourceId: "11111111-1111-4111-8111-111111111111",
        segmentId: "22222222-2222-4222-8222-222222222222",
      },
    },
    { type: "code", content: "const a = 1;\nconst b = 2; // 多行不能压成一行" },
  ];
  writeFragmentBlocks(source, original);

  const rebuilt = docFromSnapshot(snapshotOf(source));
  const rebuiltBlocks = projectFragmentBlocks(rebuilt);
  assert.deepEqual(rebuiltBlocks, projectFragmentBlocks(source), "编码-解码不闭合");

  // 只改一段，其余块要能原样解出来：行内容住在块自己的 `YXmlText` 里，意义就在这里。
  const edited = rebuiltBlocks.map((block) => ({
    type: block.type,
    content: block.ordinal === 1 ? `${block.content}（服务端又改的）` : block.content,
    ...(block.sourceRef ? { sourceRef: block.sourceRef } : {}),
    ...(block.imageAssetId ? { imageAssetId: block.imageAssetId } : {}),
  }));
  const target = docFromSnapshot(snapshotOf(source));
  writeFragmentBlocks(target, edited);
  setNoteTitle(target, "换了标题", "manual");
  const roundTrip = docFromSnapshot(snapshotOf(target));
  assert.deepEqual(
    projectFragmentBlocks(roundTrip).map((block) => block.content),
    edited.map((block) => block.content),
  );
  assert.equal(readNoteTitle(roundTrip)?.title, "换了标题");
  // 证据链必须跟着块活过一轮编码，否则恢复历史版本时第一个丢的就是它。
  assert.deepEqual(
    projectFragmentBlocks(roundTrip)[1]?.sourceRef,
    NOTE_DOC_CONFORMANCE.expectedBlocks[1].sourceRef,
  );
  for (const doc of [source, rebuilt, target, roundTrip]) doc.destroy();
});
