/**
 * Content hash consistency PostgreSQL integration test.
 *
 * Validates that the migration's backfill logic
 *   `UPDATE note_versions SET content_hash = md5(content_json::text)`
 * produces the same hash as the application-layer `computeContentHash()` function.
 *
 * If these diverge, content deduplication will fail to match pre-migration
 * versions, causing unnecessary new-version creation on undo/redo.
 *
 * Environment variables:
 *   CONTENT_HASH_TEST_DATABASE_URL — connection string for the test database
 *   (must connect as ailearn_api or ailearn_migrator role)
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres from "postgres";
import { computeContentHash } from "../modules/note/service.ts";

const databaseUrl = process.env.CONTENT_HASH_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "CONTENT_HASH_TEST_DATABASE_URL is required for the content hash consistency test",
  );
}

const sql = postgres(databaseUrl, { max: 2 });

// ─── Helpers ─────────────────────────────────────────────────────────────

async function seedWorkspaceAndNote(
  tx: postgres.TransactionSql,
): Promise<{ workspaceId: string; userId: string; noteId: string }> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const noteId = randomUUID();

  // Insert user first — workspaces.owner_id has a non-deferrable FK to users.id.
  await tx`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (${userId}, ${`test-${userId.slice(0, 8)}@example.test`}, 'test-hash', 'owner')
  `;
  await tx`
    INSERT INTO workspaces (id, name, owner_id)
    VALUES (${workspaceId}, ${`test-ws-${workspaceId.slice(0, 8)}`}, ${userId})
  `;
  await tx`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${workspaceId}, ${userId}, 'owner')
  `;
  await tx`
    INSERT INTO notes (id, workspace_id, title, title_source, created_by)
    VALUES (${noteId}, ${workspaceId}, 'Hash Consistency Test', 'auto', ${userId})
  `;

  return { workspaceId, userId, noteId };
}

async function cleanupWorkspace(
  tx: postgres.TransactionSql,
  workspaceId: string,
  userId: string,
  noteId: string,
) {
  await tx`DELETE FROM note_blocks WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM notes WHERE id = ${noteId}`;
  await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await tx`DELETE FROM users WHERE id = ${userId}`;
}

// ─── Tests ───────────────────────────────────────────────────────────────

test("content hash: PostgreSQL md5(content_json::text) matches computeContentHash for ASCII content", async () => {
  const contentJson = { blocks: [
    { type: "heading", content: "# Test Heading" },
    { type: "paragraph", content: "Some paragraph text." },
    { type: "code", content: "const x = 1;" },
  ] };

  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId } = await seedWorkspaceAndNote(tx);
    const versionId = randomUUID();

    try {
      // Insert note_version with a placeholder hash
      await tx`
        INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
        VALUES (${versionId}, ${noteId}, ${workspaceId}, 1, ${JSON.stringify(contentJson)}, 'placeholder', ${userId})
      `;

      // Compute hash the way the migration does
      const [pgRow] = await tx<{ hash: string }[]>`
        SELECT md5(content_json::text) AS hash
        FROM note_versions
        WHERE id = ${versionId}
      `;

      // Compute hash the way the application does
      const appHash = computeContentHash(contentJson);

      assert.equal(
        pgRow.hash,
        appHash,
        "PostgreSQL md5(content_json::text) must match computeContentHash() for ASCII content",
      );
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("content hash: consistency for Unicode (CJK) content", async () => {
  const contentJson = { blocks: [
    { type: "heading", content: "# 中文标题" },
    { type: "paragraph", content: "这是一段中文内容，包含一些特殊字符：·→✓" },
    { type: "list", content: "- 列表项一\n- 列表项二" },
  ] };

  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId } = await seedWorkspaceAndNote(tx);
    const versionId = randomUUID();

    try {
      await tx`
        INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
        VALUES (${versionId}, ${noteId}, ${workspaceId}, 1, ${JSON.stringify(contentJson)}, 'placeholder', ${userId})
      `;

      const [pgRow] = await tx<{ hash: string }[]>`
        SELECT md5(content_json::text) AS hash
        FROM note_versions
        WHERE id = ${versionId}
      `;

      const appHash = computeContentHash(contentJson);

      assert.equal(
        pgRow.hash,
        appHash,
        "PostgreSQL md5(content_json::text) must match computeContentHash() for Unicode content",
      );
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("content hash: consistency for image blocks", async () => {
  const contentJson = { blocks: [
    { type: "paragraph", content: "图片下方说明" },
    { type: "image", content: "![架构图](/api/uploads/ws/notes/n/abc.png)" },
  ] };

  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId } = await seedWorkspaceAndNote(tx);
    const versionId = randomUUID();

    try {
      await tx`
        INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
        VALUES (${versionId}, ${noteId}, ${workspaceId}, 1, ${JSON.stringify(contentJson)}, 'placeholder', ${userId})
      `;

      const [pgRow] = await tx<{ hash: string }[]>`
        SELECT md5(content_json::text) AS hash
        FROM note_versions
        WHERE id = ${versionId}
      `;

      const appHash = computeContentHash(contentJson);

      assert.equal(
        pgRow.hash,
        appHash,
        "PostgreSQL md5(content_json::text) must match computeContentHash() for image blocks",
      );
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("content hash: consistency for empty blocks", async () => {
  const contentJson = { blocks: [] };

  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId } = await seedWorkspaceAndNote(tx);
    const versionId = randomUUID();

    try {
      await tx`
        INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
        VALUES (${versionId}, ${noteId}, ${workspaceId}, 1, ${JSON.stringify(contentJson)}, 'placeholder', ${userId})
      `;

      const [pgRow] = await tx<{ hash: string }[]>`
        SELECT md5(content_json::text) AS hash
        FROM note_versions
        WHERE id = ${versionId}
      `;

      const appHash = computeContentHash(contentJson);

      assert.equal(
        pgRow.hash,
        appHash,
        "PostgreSQL md5(content_json::text) must match computeContentHash() for empty blocks",
      );
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("content hash: consistency for emoji (BMP-external) content", async () => {
  // Emoji like 🎉 (U+1F389) and 👨‍👩‍👧‍👦 (family ZWJ sequence) use
  // surrogate pairs in JS and 4-byte UTF-8 in PostgreSQL.
  // This test ensures both sides encode them identically.
  const contentJson = { blocks: [
    { type: "heading", content: "# 标题 🎉" },
    { type: "paragraph", content: "表情符号测试：🎉🚀✨🧠💡📚" },
    { type: "paragraph", content: "家庭组合 emoji：👨‍👩‍👧‍👦 和 🦄" },
    { type: "code", content: "const emoji = '😀';" },
  ] };

  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId } = await seedWorkspaceAndNote(tx);
    const versionId = randomUUID();

    try {
      await tx`
        INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
        VALUES (${versionId}, ${noteId}, ${workspaceId}, 1, ${JSON.stringify(contentJson)}, 'placeholder', ${userId})
      `;

      const [pgRow] = await tx<{ hash: string }[]>`
        SELECT md5(content_json::text) AS hash
        FROM note_versions
        WHERE id = ${versionId}
      `;

      const appHash = computeContentHash(contentJson);

      assert.equal(
        pgRow.hash,
        appHash,
        "PostgreSQL md5(content_json::text) must match computeContentHash() for emoji (BMP-external) content",
      );
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("content hash: deduplication works end-to-end with real PostgreSQL", async () => {
  // Insert a version, then verify that computeContentHash for the same
  // content produces a hash that matches the stored content_hash column.
  const contentJson = { blocks: [
    { type: "heading", content: "# Dedup Test" },
    { type: "paragraph", content: "Content for dedup verification." },
  ] };

  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId } = await seedWorkspaceAndNote(tx);
    const versionId = randomUUID();
    const expectedHash = computeContentHash(contentJson);

    try {
      await tx`
        INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
        VALUES (${versionId}, ${noteId}, ${workspaceId}, 1, ${JSON.stringify(contentJson)}, ${expectedHash}, ${userId})
      `;

      // Simulate the dedup lookup: find a version by content_hash
      const [matched] = await tx<{ id: string }[]>`
        SELECT id FROM note_versions
        WHERE note_id = ${noteId} AND content_hash = ${expectedHash}
      `;

      assert.ok(matched, "Dedup lookup should find the version by content_hash");
      assert.equal(matched.id, versionId);
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});
