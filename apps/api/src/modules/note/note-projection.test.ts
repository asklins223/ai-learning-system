import assert from "node:assert/strict";
import test from "node:test";
import { projectNoteDetailV1, projectNoteSaveReceiptV1 } from "./note-projection.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

const source = {
  note: {
    id: NOTE_ID,
    workspaceId: WORKSPACE_ID,
    title: "Note 标题",
    titleSource: "auto",
    sourceId: null,
    currentVersionId: VERSION_ID,
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

test("Note read projection is strict and role-aware", () => {
  const owner = projectNoteDetailV1(source, "owner", new Date("2026-08-23T00:00:02.000Z"));
  const member = projectNoteDetailV1(source, "member", new Date("2026-08-23T00:00:02.000Z"));
  assert.equal(owner.permissions.canEdit, true);
  assert.equal(member.permissions.canEdit, false);
  assert.deepEqual(owner.currentVersion.blocks, [
    { ordinal: 0, type: "heading", content: "标题" },
    { ordinal: 1, type: "paragraph", content: "正文" },
  ]);
  assert.equal(owner.currentVersionId, VERSION_ID);
});

test("Note read projection fails closed when the current version is absent", () => {
  assert.throws(
    () => projectNoteDetailV1({ ...source, note: { ...source.note, currentVersionId: null } }, "owner"),
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
