import { test } from "node:test";
import assert from "node:assert/strict";
import { diffNoteVersions, type NoteBlockLike } from "../agent/note-diff.ts";
import {
  planIncrementalIndexUpdate,
  applyIndexUpdate,
  verifyIndexConsistency,
  indexedTextHash,
  type SearchIndexState,
} from "../agent/incremental-search-projection.ts";

function block(id: string, content: string): NoteBlockLike {
  return { id, ordinal: 0, type: "paragraph", content };
}

function state(): SearchIndexState {
  return { entries: new Map() };
}

test("P5-6: 只更新变化 span,未变化 span 零成本", () => {
  const diff = diffNoteVersions([block("s1", "旧"), block("s2", "旧")], [block("s1", "新"), block("s2", "旧")]);
  const spanIndexedText = new Map([
    ["s1", "变化后的索引文本"],
    ["s2", "未变化的索引文本"],
  ]);
  const plan = planIncrementalIndexUpdate(diff, spanIndexedText, 2);
  assert.deepEqual(plan.upsert.map((e) => e.spanKey), ["s1"], "只 upsert 变化的 s1");
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.upsert[0].version, 2);
});

test("P5-6: removed span 生成 remove 计划", () => {
  const diff = diffNoteVersions([block("s1", "旧"), block("s2", "旧")], [block("s2", "旧")]);
  const plan = planIncrementalIndexUpdate(diff, new Map([["s2", "未变化"] ]), 2);
  assert.deepEqual(plan.remove, ["s1"]);
  assert.deepEqual(plan.upsert, []);
});

test("P5-6: span 无索引文本(内容被删)→ remove", () => {
  const diff = diffNoteVersions([block("s1", "旧")], [block("s1", "")]);
  const plan = planIncrementalIndexUpdate(diff, new Map(), 2);
  assert.deepEqual(plan.remove, ["s1"]);
});

test("P5-6: 应用计划并保持一致性(无孤儿/无缺失)", () => {
  const diff = diffNoteVersions([block("s1", "旧"), block("s2", "旧")], [block("s1", "新"), block("s2", "旧")]);
  const plan = planIncrementalIndexUpdate(diff, new Map([["s1", "新文本"], ["s2", "旧文本"]]), 2);
  // 初始状态:上一版本已索引 s1(旧)与 s2(旧)
  const initial = state();
  initial.entries.set("s1", { entryKey: "s1", spanKey: "s1", indexedText: "旧文本", version: 1 });
  initial.entries.set("s2", { entryKey: "s2", spanKey: "s2", indexedText: "旧文本", version: 1 });
  const st = applyIndexUpdate(initial, plan);
  // 变化 s1 更新为新版本;s2 未变化保留
  const expected = new Set(["s1", "s2"]);
  const v = verifyIndexConsistency(st, expected);
  assert.deepEqual(v, { orphan: [], missing: [] });
  assert.equal(st.entries.get("s1")?.version, 2, "s1 更新为新版本");
  assert.equal(st.entries.get("s2")?.version, 1, "s2 未变化保留旧版本");
});

test("indexedTextHash 内容寻址且稳定", () => {
  assert.equal(indexedTextHash("文本"), indexedTextHash("文本"));
  assert.notEqual(indexedTextHash("文本"), indexedTextHash("文本2"));
});
