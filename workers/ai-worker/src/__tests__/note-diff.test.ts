import { test } from "node:test";
import assert from "node:assert/strict";
import { diffNoteVersions, attributeSpansToBundles, blockContentHash, type NoteBlockLike } from "../agent/note-diff.ts";

function block(id: string, content: string, ordinal = 0): NoteBlockLike {
  return { id, ordinal, type: "paragraph", content };
}

test("identical blocks → no changes, all unchanged", () => {
  const prev = [block("b1", "内容一", 0), block("b2", "内容二", 1)];
  const next = [block("b1", "内容一", 0), block("b2", "内容二", 1)];
  const d = diffNoteVersions(prev, next);
  assert.equal(d.hasChanges, false);
  assert.deepEqual(d.changedSpans, []);
  assert.deepEqual(d.unchangedSpans.sort(), ["b1", "b2"]);
});

test("changed block reported with prev/next content hashes", () => {
  const prev = [block("b1", "旧内容", 0)];
  const next = [block("b1", "新内容", 0)];
  const d = diffNoteVersions(prev, next);
  assert.equal(d.hasChanges, true);
  assert.equal(d.changedSpans.length, 1);
  assert.equal(d.changedSpans[0].change, "changed");
  assert.equal(d.changedSpans[0].spanKey, "b1");
  assert.notEqual(d.changedSpans[0].prevContentHash, d.changedSpans[0].nextContentHash);
});

test("added and removed spans detected", () => {
  const prev = [block("b1", "x", 0), block("b2", "y", 1)];
  const next = [block("b1", "x", 0), block("b3", "z", 1)];
  const d = diffNoteVersions(prev, next);
  const added = d.changedSpans.filter((s) => s.change === "added");
  const removed = d.changedSpans.filter((s) => s.change === "removed");
  assert.deepEqual(added.map((s) => s.spanKey), ["b3"]);
  assert.deepEqual(removed.map((s) => s.spanKey), ["b2"]);
});

test("imageAssetId change invalidates span", () => {
  const prev = [{ id: "img1", ordinal: 0, type: "image", content: "", imageAssetId: "asset-a" }];
  const next = [{ id: "img1", ordinal: 0, type: "image", content: "", imageAssetId: "asset-b" }];
  const d = diffNoteVersions(prev, next);
  assert.equal(d.hasChanges, true);
  assert.equal(d.changedSpans[0].change, "changed");
});

test("nextContentHash changes when any span changes", () => {
  const d1 = diffNoteVersions([block("b1", "a")], [block("b1", "a")]);
  const d2 = diffNoteVersions([block("b1", "a")], [block("b1", "b")]);
  assert.notEqual(d1.nextContentHash, d2.nextContentHash);
});

test("attributeSpansToBundles: spans attributed by sectionKey, leftovers surfaced", () => {
  const prev = [block("s1", "旧"), block("s2", "旧"), block("s3", "旧")];
  const next = [block("s1", "新"), block("s2", "旧"), block("s3", "新")];
  const d = diffNoteVersions(prev, next);
  // span → sectionKey:s1→"1.1", s2→"1.2", s3→"2.1"
  const sectionByBundle = { "bundle-a": ["1.1", "1.2"], "bundle-b": ["2.1"] };
  const spanSection = (spanKey: string) => (spanKey === "s1" ? "1.1" : spanKey === "s2" ? "1.2" : spanKey === "s3" ? "2.1" : null);
  const r = attributeSpansToBundles(d, sectionByBundle, spanSection);
  assert.deepEqual(r.byBundle["bundle-a"].map((s) => s.spanKey), ["s1"]);
  assert.deepEqual(r.byBundle["bundle-b"].map((s) => s.spanKey), ["s3"]);
  assert.deepEqual(r.leftovers, [], "s2 未变化不在 diff 中");

  // 无 section 归属 → leftovers
  const r2 = attributeSpansToBundles(d, { "bundle-a": ["1.1"] }, () => null);
  assert.equal(r2.leftovers.length, 2);
});

test("blockContentHash stable for same content", () => {
  assert.equal(blockContentHash(block("b1", "x")), blockContentHash(block("b1", "x")));
  assert.notEqual(blockContentHash(block("b1", "x")), blockContentHash(block("b1", "y")));
});

test("review should-fix: block 重排(内容不变)不产生变化且 nextContentHash 稳定", () => {
  const prev = [block("b1", "x", 0), block("b2", "y", 1)];
  const next = [block("b2", "y", 1), block("b1", "x", 0)]; // 顺序交换,内容不变
  const d = diffNoteVersions(prev, next);
  assert.equal(d.hasChanges, false, "内容不变的重排不产生 changed span");
  assert.deepEqual(d.changedSpans, []);
  // hash 与顺序无关:重排后 hash 与原始顺序版本一致
  const original = diffNoteVersions([block("b1", "x", 0), block("b2", "y", 1)], [block("b1", "x", 0), block("b2", "y", 1)]);
  assert.equal(d.nextContentHash, original.nextContentHash, "重排不改变 nextContentHash(失效键稳定)");
});
