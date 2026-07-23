import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeNoteTitle,
  reconcileSavedNoteTitle,
} from "../note-title-save";

describe("note title save reconciliation", () => {
  it("accepts the server title when the user did not edit during the request", () => {
    assert.deepEqual(
      reconcileSavedNoteTitle({
        latestTitle: "旧自动标题",
        savedTitle: "新的自动标题",
        requestEditRevision: 2,
        currentEditRevision: 2,
      }),
      { nextTitle: "新的自动标题", isDirty: false },
    );
  });

  it("preserves a newer local title when an older save finishes", () => {
    assert.deepEqual(
      reconcileSavedNoteTitle({
        latestTitle: "标题 A",
        savedTitle: "标题 B",
        requestEditRevision: 3,
        currentEditRevision: 4,
      }),
      { nextTitle: "标题 A", isDirty: true },
    );
  });

  it("preserves a pending title while refreshing after an uncertain keepalive", () => {
    assert.deepEqual(
      reconcileSavedNoteTitle({
        latestTitle: "待保存标题",
        savedTitle: "服务端旧标题",
        requestEditRevision: 7,
        currentEditRevision: 7,
        preservePendingEdit: true,
      }),
      { nextTitle: "待保存标题", isDirty: true },
    );
  });

  it("settles when the newer input already matches the saved title", () => {
    assert.deepEqual(
      reconcileSavedNoteTitle({
        latestTitle: "  标题 B  ",
        savedTitle: "标题 B",
        requestEditRevision: 5,
        currentEditRevision: 6,
      }),
      { nextTitle: "标题 B", isDirty: false },
    );
  });

  it("normalizes a blank title to the untitled fallback", () => {
    assert.equal(normalizeNoteTitle("   "), "无标题笔记");
  });
});
