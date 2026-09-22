/**
 * 服务端内核 ↔ 跨进程向量的对拍（批次 4.4，批次 C 换形状之后重读）。
 *
 * 这份用例原本回答一个问题：**主进程那边解码的字节，确实是这份内核写出去的语义**。
 * 向量由服务端内核生成一次后固定，两份实现各自解码并断言投影结果，于是"两份实现悄悄
 * 分叉"是机器发现的，不是靠人对齐代码。
 *
 * 批次 C 把服务端这份换成了 `Y.XmlFragment`，那串固定字节仍然是**换形状之前**那份内核
 * 产出的 `Y.Array<Y.Map>` 编码。所以这里能继续对拍的与不能继续对拍的，分开写清楚：
 *  - **能**：`meta` 那一半。标题与 `titleSource` 住的 Y.Map 与块形状无关，两边解同一串
 *    字节得到的仍是同一个对象——这条断言原样保留，它量的是"同一份 yjs 编码 + 同一套
 *    meta 键"。
 *  - **不能**：正文那一半。数组形状的字节里没有 `content` 这个 XmlFragment，用现在的
 *    内核投影出 **0 块**（实测，下面那条断言就是钉这件事）。要恢复正文对拍，前置有两条，
 *    缺一条都不能动那串字节：① 主进程那份内核也落到 fragment 上；② 由落到 fragment 的
 *    那一版服务端重新生成 `snapshotBase64` + `expectedBlocks`（向量文件自己的规定：重新
 *    生成必须同时改期望值并确认两边用例都还成立）。在两条成立之前，把向量换成新字节或把
 *    断言改成"能解出来"，就是把这道分叉重新遮回去。
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

test("固定向量的 meta 那一半能被本内核解出预期标题；正文那一半是换形状之前的编码", () => {
  const doc = docFromSnapshot(vectorBytes());
  const title = readNoteTitle(doc);
  const blocks = projectFragmentBlocks(doc);
  doc.destroy();

  assert.deepEqual({ ...(title ?? {}) }, { ...NOTE_DOC_CONFORMANCE.expectedTitle });
  // 这一句不是"内核解不出旧形状所以没事干"，而是这一批的一次性事实：库里的 `state` 也是
  // 这串字节的那个形状，用新内核读它就是 0 块——`loadNoteDoc` 因此不能让旧快照留着。
  assert.deepEqual(blocks, [], "数组形状的编码被 fragment 内核投影出了块：两个形状被混在同一条路上读了");
});

test("从块重建再编码，解回来仍是同一份（写侧认这个形状）", () => {
  // 向量那串字节不能再当这里的起点（文件头说明了为什么），所以这一条按写侧自己的合同测：
  // 编码-解码闭合、只改一段时其余块原样解出来、证据链活过一轮编码。这三件事是向量原本
  // 想护住的东西，与那一串具体字节无关。
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
