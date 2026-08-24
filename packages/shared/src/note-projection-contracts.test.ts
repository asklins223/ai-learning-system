import assert from "node:assert/strict";
import test from "node:test";
import { noteDetailV1Schema } from "./note-projection-contracts.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

function fixture(role: "owner" | "member" = "member") {
  return {
    version: 1 as const,
    noteId: NOTE_ID,
    workspaceId: WORKSPACE_ID,
    title: "真实 Note",
    titleSource: "manual" as const,
    sourceId: null,
    currentVersionId: VERSION_ID,
    currentVersion: {
      versionId: VERSION_ID,
      noteId: NOTE_ID,
      versionNo: 3,
      contentHash: "0123456789abcdef0123456789abcdef",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
      blocks: [{ ordinal: 0, type: "paragraph" as const, content: "正文" }],
    },
    permissions: { canRead: true as const, canEdit: role === "owner", canSave: role === "owner" },
    revision: VERSION_ID,
    snapshotAt: "2026-08-23T00:00:02.000Z",
  };
}

test("NoteDetailV1 accepts the safe Owner/Member read shape", () => {
  assert.equal(noteDetailV1Schema.parse(fixture("owner")).permissions.canEdit, true);
  assert.equal(noteDetailV1Schema.parse(fixture("member")).permissions.canEdit, false);
});

test("NoteDetailV1 rejects private or unknown fields", () => {
  const value = { ...fixture(), currentVersion: { ...fixture().currentVersion, imageAssetId: VERSION_ID } };
  assert.equal(noteDetailV1Schema.safeParse(value).success, false);
});

test("NoteDetailV1 binds the OCC revision to the current version", () => {
  const value = { ...fixture(), revision: NOTE_ID };
  assert.equal(noteDetailV1Schema.safeParse(value).success, false);
});

