import { test } from "node:test";
import assert from "node:assert/strict";
import { diffNoteVersions, type NoteBlockLike } from "../agent/note-diff.ts";

function block(id: string, content: string, ordinal = 0): NoteBlockLike {
  return { id, ordinal, type: "paragraph", content };
}

// 注:checkIncrementalReuse 的 DB 分支(hasPrevious/reuseRatio)由
// incremental-reuse-postgres.integration.ts(真实 postgres)覆盖;
// 单测仅覆盖纯 diff 语义(不建立 DB 连接,避免测试进程连接泄漏)。

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
