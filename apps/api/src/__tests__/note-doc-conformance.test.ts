/**
 * 服务端内核 ↔ 跨进程向量的对拍（批次 4.4）。
 *
 * 这份用例只回答一个问题：**主进程那边解码的字节，确实是这份内核写出去的语义**。
 * 向量由本内核生成一次后固定；这边改了形状（字段改名、`content` 不再是 `Y.Text`、
 * 块的排列方式变了），这里就会红，紧接着主进程那份的同一断言也会红——两边看到的
 * 是同一串字节，分叉藏不住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTE_DOC_CONFORMANCE } from "@ailearn/shared/note-doc-conformance";
import {
  docFromSnapshot,
  projectNoteBlocks,
  readNoteTitle,
  setNoteTitle,
  snapshotOf,
  writeNoteBlocks,
} from "../modules/note/doc.ts";

test("固定向量能被本内核解出预期的块与标题", () => {
  const doc = docFromSnapshot(new Uint8Array(Buffer.from(NOTE_DOC_CONFORMANCE.snapshotBase64, "base64")));
  const blocks = projectNoteBlocks(doc);
  const title = readNoteTitle(doc);
  doc.destroy();

  assert.deepEqual(
    blocks,
    NOTE_DOC_CONFORMANCE.expectedBlocks.map((block) => ({ ...block })),
    "向量解出来的块与预期不符：形状变了，主进程那份内核会解成另一样东西",
  );
  assert.deepEqual({ ...(title ?? {}) }, { ...NOTE_DOC_CONFORMANCE.expectedTitle });
});

test("从块重建再编码，解回来仍是同一份（向量的另一半：写侧也认这个形状）", () => {
  const source = docFromSnapshot(new Uint8Array(Buffer.from(NOTE_DOC_CONFORMANCE.snapshotBase64, "base64")));
  const rebuilt = docFromSnapshot(snapshotOf(source));
  const rebuiltBlocks = projectNoteBlocks(rebuilt);
  assert.deepEqual(rebuiltBlocks, projectNoteBlocks(source), "编码-解码不闭合");

  // 只改一段，其余块要能原样解出来：块级 `Y.Text` 的意义就在这里。
  const edited = rebuiltBlocks.map((block) => ({
    type: block.type,
    content: block.ordinal === 1 ? `${block.content}（服务端又改的）` : block.content,
    ...(block.sourceRef ? { sourceRef: block.sourceRef } : {}),
    ...(block.imageAssetId ? { imageAssetId: block.imageAssetId } : {}),
  }));
  const target = docFromSnapshot(snapshotOf(source));
  writeNoteBlocks(target, edited);
  setNoteTitle(target, "换了标题", "manual");
  const roundTrip = docFromSnapshot(snapshotOf(target));
  assert.deepEqual(
    projectNoteBlocks(roundTrip).map((block) => block.content),
    edited.map((block) => block.content),
  );
  assert.equal(readNoteTitle(roundTrip)?.title, "换了标题");
  // 证据链必须跟着块活过一轮编码，否则恢复历史版本时第一个丢的就是它。
  assert.deepEqual(
    projectNoteBlocks(roundTrip)[1]?.sourceRef,
    NOTE_DOC_CONFORMANCE.expectedBlocks[1].sourceRef,
  );
  for (const doc of [source, rebuilt, target, roundTrip]) doc.destroy();
});
