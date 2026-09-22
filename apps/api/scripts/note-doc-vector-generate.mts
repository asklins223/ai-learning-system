import * as Y from "yjs";
import {
  docFromSnapshot,
  emptyFragmentNoteDoc,
  projectFragmentBlocks,
  setNoteTitle,
  snapshotOf,
  writeFragmentBlocks,
  type NoteDocBlock,
} from "../src/modules/note/doc-fragment.ts";

/**
 * 重新生成跨进程一致性向量的那串字节（`packages/shared/src/note-doc-conformance.ts`）。
 *
 * 为什么要有这么一个可复跑的东西：向量的规定是"换字节必须同时确认两侧用例都还成立"，
 * 那就不能靠某一次手打的代码片段。这一份**只当生成器与诊断用**，不参与运行时。
 *
 * 跑法：`cd apps/api && node --import tsx scripts/note-doc-vector-generate.mts`
 * 打印的 base64 就是新的 `snapshotBase64`；同时打印服务端这份内核投影回来的块与标题，
 * 用来核对 `expectedBlocks` / `expectedTitle` 是否真的不用改（改了就要两侧一起确认）。
 * 之后必须跑：api 那份对拍用例 + 桌面渲染层那份对拍用例（两侧各自解同一串字节）。
 */
const BLOCKS: NoteDocBlock[] = [
  { type: "heading", content: "# 标题里的中文与 English" },
  {
    type: "paragraph",
    content: "第一段：改一处不该顶掉另一处。",
    sourceRef: {
      sourceId: "11111111-1111-4111-8111-111111111111",
      segmentId: "22222222-2222-4222-8222-222222222222",
    },
  },
  { type: "code", content: "const a = 1;\nconst b = 2; // 多行不能压成一行" },
  {
    type: "image",
    content: "![配图](/api/uploads/abc.png)",
    imageAssetId: "33333333-3333-4333-8333-333333333333",
  },
];

const doc = emptyFragmentNoteDoc();
writeFragmentBlocks(doc, BLOCKS);
setNoteTitle(doc, "向量标题", "manual");
const bytes = snapshotOf(doc);

// 解一遍自己产的字节：这一步就证明"服务端写的那一份，服务端读得回来"，
// 也就是向量里的期望值不是抄来的，是这份内核投影出来的。
const reread = docFromSnapshot(bytes);
const projected = projectFragmentBlocks(reread);
const title = (() => {
  const meta = reread.getMap<unknown>("meta");
  return { title: String(meta.get("title")), titleSource: String(meta.get("titleSource")) };
})();

console.log(`snapshotBytes: ${bytes.byteLength}`);
console.log(`snapshotBase64:\n${Buffer.from(bytes).toString("base64")}`);
console.log("expectedBlocks:\n" + JSON.stringify(projected, null, 2));
console.log("expectedTitle:\n" + JSON.stringify(title));
doc.destroy();
reread.destroy();
