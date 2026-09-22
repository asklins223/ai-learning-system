/**
 * 服务端这一侧的向量对拍（批次 4.4 建立，C2 之后字节来源换过一次）。
 *
 * 这串字节现在**由这份内核自己产出**（生成器：`apps/api/scripts/note-doc-vector-generate.mts`），
 * 所以这一条量的是两件别的东西查不到的事：① 库里那份编码读得回来（写侧形状一改，
 * 已经存进去的字节就解不出同样的块）；② 期望值不是抄的——同一份投影从这里出去，交给
 * 编辑器那一侧的第二条用例（`apps/desktop-client/.../note-doc-conformance.test.ts`）独立解一遍。
 * 两份实现的分叉由"同一串字节两边各解一次"发现，因为它们没法共用源码：同一个进程里出现
 * 两份 yjs 会让 `instanceof Y.XmlText` 静默判假。
 *
 * 换形状那一段路上它一度是断开的（旧字节是 `Y.Array<Y.Map>`，新内核解出 0 块）。当时
 * 没有把期望值改掉让它重新变绿，而是把"解出 0 块"写成断言——分叉要看得见才不会再被
 * 遮回去。现在两端都在 fragment 上，那条断言跟着回到"解得出同样的块"。
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

test("固定向量解得出期望的块与标题（多行代码、块级来源引用、图片资产都在）", () => {
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
