import assert from "node:assert/strict";
import test from "node:test";
import { noteSaveReceiptV1Schema, noteSaveRequestV1Schema } from "./note-save-contracts.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

test("Note save 只确认版本，不再收正文", () => {
  // 空 body（只有 baseVersionId）现在是**合法**的：这一条的意思就是"把文档此刻定成
  // 一版"，不需要携带任何改动。反过来，带 blocks 必须被拒——整篇覆盖那条路已经删了，
  // 一个还能收 blocks 的契约等于留着那个洞。
  assert.ok(noteSaveRequestV1Schema.safeParse({ version: 1, baseVersionId: VERSION_ID }).success);
  assert.ok(noteSaveRequestV1Schema.safeParse({ version: 1, title: "新标题", baseVersionId: VERSION_ID }).success);
  assert.equal(
    noteSaveRequestV1Schema.safeParse({
      version: 1,
      baseVersionId: VERSION_ID,
      blocks: [{ type: "paragraph", content: "整篇覆盖" }],
    }).success,
    false,
  );
  assert.equal(noteSaveRequestV1Schema.safeParse({ version: 1, title: "x", baseVersionId: "not-a-uuid" }).success, false);
  assert.equal(
    noteSaveRequestV1Schema.safeParse({ version: 1, title: "x", baseVersionId: NOTE_ID, extra: true }).success,
    false,
  );
});

test("Note save receipt is committed evidence and binds the new version", () => {
  const receipt = noteSaveReceiptV1Schema.parse({
    version: 1,
    status: "committed",
    noteId: NOTE_ID,
    workspaceId: WORKSPACE_ID,
    baseVersionId: VERSION_ID,
    versionId: "44444444-4444-4444-8444-444444444444",
    currentVersionId: "44444444-4444-4444-8444-444444444444",
    versionNo: 4,
    revision: "44444444-4444-4444-8444-444444444444",
    savedAt: "2026-08-23T00:00:00.000Z",
  });
  assert.equal(receipt.status, "committed");
  assert.equal(receipt.revision, receipt.currentVersionId);
});

