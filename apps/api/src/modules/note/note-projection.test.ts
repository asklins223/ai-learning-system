import assert from "node:assert/strict";
import test from "node:test";
import { projectNoteDetailV1, projectNoteSaveReceiptV1 } from "./note-projection.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";
const AUTHOR_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_ID = "66666666-6666-4666-8666-666666666666";

const source = {
  note: {
    id: NOTE_ID,
    workspaceId: WORKSPACE_ID,
    title: "Note 标题",
    titleSource: "auto",
    sourceId: null,
    currentVersionId: VERSION_ID,
    shareScope: "shared",
    createdBy: AUTHOR_ID,
  },
  version: {
    id: VERSION_ID,
    noteId: NOTE_ID,
    versionNo: 2,
    contentHash: "0123456789abcdef0123456789abcdef",
    createdAt: new Date("2026-08-23T00:00:00.000Z"),
    updatedAt: new Date("2026-08-23T00:00:01.000Z"),
  },
  blocks: [
    { id: "private-block-id", ordinal: 0, type: "heading", content: "标题", imageAssetId: "private-asset-id" },
    { ordinal: 1, type: "paragraph", content: "正文", sourceRef: { sourceId: NOTE_ID } },
  ],
};

const SNAPSHOT_AT = new Date("2026-08-23T00:00:02.000Z");

test("Note read projection is strict and role-aware", () => {
  const owner = projectNoteDetailV1(source, "owner", AUTHOR_ID, SNAPSHOT_AT);
  const member = projectNoteDetailV1(source, "member", OTHER_ID, SNAPSHOT_AT);
  assert.equal(owner.permissions.canEdit, true);
  assert.equal(member.permissions.canEdit, false);
  // `canShare` 与 `canEdit` 是两条判据：归属动作问的是"这篇是不是你写的"，
  // 而编辑问的是"你在空间里能不能写"。所以一个 member 拿到自己写的篇时
  // canEdit=false / canShare=true 是合法组合，不能合并成一个位。
  assert.equal(owner.permissions.canShare, true);
  assert.equal(member.permissions.canShare, false);
  assert.equal(owner.shareScope, "shared");
  assert.deepEqual(owner.currentVersion.blocks, [
    { ordinal: 0, type: "heading", content: "标题" },
    { ordinal: 1, type: "paragraph", content: "正文" },
  ]);
  assert.equal(owner.currentVersionId, VERSION_ID);
});

test("Note read projection fails closed when the current version is absent", () => {
  assert.throws(
    () => projectNoteDetailV1({ ...source, note: { ...source.note, currentVersionId: null } }, "owner", AUTHOR_ID),
    /note_current_version_missing/,
  );
});

test("Note save receipt exposes only committed version evidence", () => {
  const receipt = projectNoteSaveReceiptV1({
    note: { id: NOTE_ID, workspaceId: WORKSPACE_ID, currentVersionId: VERSION_ID },
    version: {
      id: VERSION_ID,
      versionNo: 3,
      updatedAt: new Date("2026-08-23T00:00:03.000Z"),
    },
  }, VERSION_ID);
  assert.equal(receipt.status, "committed");
  assert.equal(receipt.versionId, VERSION_ID);
  assert.equal(receipt.revision, VERSION_ID);
});
