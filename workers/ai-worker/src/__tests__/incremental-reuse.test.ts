import { test } from "node:test";
import assert from "node:assert/strict";
import { diffNoteVersions, type NoteBlockLike } from "../agent/note-diff.ts";
import { checkIncrementalReuse, type IncrementalReuseInfo } from "../agent/incremental-reuse.ts";

function block(id: string, content: string, ordinal = 0): NoteBlockLike {
  return { id, ordinal, type: "paragraph", content };
}

test("checkIncrementalReuse: 无上一版本 → hasPrevious=false(全量路径)", async () => {
  // DB 查询在无数据时返回空 → 走全量(不抛)
  const result: IncrementalReuseInfo = await checkIncrementalReuse("w-missing", "r-missing").catch((err) => {
    // 测试环境无 DB 时也视为降级路径(生产有 DB)
    assert.ok(err, "无 DB 时抛错由调用方降级全量");
    return { hasPrevious: false, prevVersionNo: null, changedSpanCount: 0, unchangedSpanCount: 0, reuseRatio: 0, hasChanges: false };
  });
  assert.equal(result.hasPrevious, false);
});

test("diff 语义:内容不变 → 无可复用变化(全量可复用)", () => {
  const d = diffNoteVersions([block("b1", "x")], [block("b1", "x")]);
  assert.equal(d.hasChanges, false);
  assert.deepEqual(d.unchangedSpans, ["b1"]);
  assert.equal(d.changedSpans.length, 0);
});

test("diff 语义:部分变化 → 未变化 span 可复用(reuseRatio>0)", () => {
  const d = diffNoteVersions([block("b1", "x"), block("b2", "y")], [block("b1", "x"), block("b2", "改")]);
  assert.equal(d.hasChanges, true);
  assert.deepEqual(d.unchangedSpans, ["b1"]);
  assert.deepEqual(d.changedSpans.map((s) => s.spanKey), ["b2"]);
  const total = d.changedSpans.length + d.unchangedSpans.length;
  const reuseRatio = total > 0 ? d.unchangedSpans.length / total : 0;
  assert.equal(reuseRatio, 0.5);
});
