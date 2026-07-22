/**
 * Note version restore PostgreSQL integration test.
 *
 * Validates the `restoreNoteVersion` service function against a real PostgreSQL
 * database, covering scenarios that unit tests with mock executors cannot
 * fully verify:
 *
 *   1. Restore switches currentVersionId without creating a new version
 *   2. Restore with mismatched baseVersionId throws RevisionConflictError
 *   3. Restore updates the search index
 *   4. Restore on a soft-deleted note returns null
 *   5. Restore with a non-existent target version returns null
 *   6. Auto title is re-derived from restored version content
 *   7. canUpdateVersionInPlace blocks in-place update when superseded card exists
 *
 * Environment variables:
 *   NOTE_VERSION_RESTORE_TEST_DATABASE_URL — connection string for the test database
 *   (must connect as ailearn_api or ailearn_migrator role)
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import postgres, { type TransactionSql } from "postgres";
import {
  restoreNoteVersion,
  updateNote,
  RevisionConflictError,
  computeContentHash,
} from "../modules/note/service.ts";
import { db } from "../db/client.ts";

// db is a PostgresJsDatabase, but service functions expect ApiTransaction.
// They are runtime-compatible (db has all query methods of a transaction),
// but TypeScript's type system doesn't see them as interchangeable.
const txExecutor = db as any;

const databaseUrl = process.env.NOTE_VERSION_RESTORE_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "NOTE_VERSION_RESTORE_TEST_DATABASE_URL is required for the note version restore integration test",
  );
}

const sql = postgres(databaseUrl, { max: 2 });

// ─── Helpers ─────────────────────────────────────────────────────────────

interface SeedResult {
  workspaceId: string;
  userId: string;
  noteId: string;
  v1Id: string;
  v2Id: string;
}

async function seedWorkspaceNoteWithTwoVersions(
  tx: TransactionSql,
): Promise<SeedResult> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const noteId = randomUUID();
  const v1Id = randomUUID();
  const v2Id = randomUUID();

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
  // Insert notes first with NULL current_version_id — note_versions.note_id
  // has a non-deferrable FK to notes.id, and notes.current_version_id has a
  // non-deferrable composite FK to note_versions(id, workspace_id).  We break
  // the cycle by inserting notes with NULL, then note_versions, then updating.
  await tx`
    INSERT INTO notes (id, workspace_id, title, title_source, created_by)
    VALUES (${noteId}, ${workspaceId}, 'Test Note', 'auto', ${userId})
  `;

  // v1 content
  const v1Content = { blocks: [{ type: "paragraph", content: "v1 content" }] };
  const v1Hash = computeContentHash(v1Content);
  await tx`
    INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
    VALUES (${v1Id}, ${noteId}, ${workspaceId}, 1, ${JSON.stringify(v1Content)}, ${v1Hash}, ${userId})
  `;
  await tx`
    INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
    VALUES (${v1Id}, ${workspaceId}, 0, 'paragraph', 'v1 content')
  `;

  // v2 content (different from v1)
  const v2Content = { blocks: [{ type: "paragraph", content: "v2 content" }] };
  const v2Hash = computeContentHash(v2Content);
  await tx`
    INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
    VALUES (${v2Id}, ${noteId}, ${workspaceId}, 2, ${JSON.stringify(v2Content)}, ${v2Hash}, ${userId})
  `;
  await tx`
    INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
    VALUES (${v2Id}, ${workspaceId}, 0, 'paragraph', 'v2 content')
  `;

  // Now set current_version_id — the note_versions record must exist first.
  await tx`
    UPDATE notes SET current_version_id = ${v2Id} WHERE id = ${noteId}
  `;

  return { workspaceId, userId, noteId, v1Id, v2Id };
}

async function cleanupWorkspace(
  tx: TransactionSql,
  workspaceId: string,
  userId: string,
  noteId: string,
) {
  await tx`DELETE FROM search_documents WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM note_blocks WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM learning_cards WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM notes WHERE id = ${noteId}`;
  await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await tx`DELETE FROM users WHERE id = ${userId}`;
}

// ─── Tests ───────────────────────────────────────────────────────────────

test("restore: switches currentVersionId to target version without creating a new version", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId, v1Id, v2Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // Restore to v1
      const result = await restoreNoteVersion(txExecutor, noteId, v1Id, workspaceId, userId);

      assert.ok(result, "restore should return a result");
      assert.equal(result!.version.id, v1Id, "restored version should be v1");
      assert.equal(result!.note.currentVersionId, v1Id, "currentVersionId should point to v1");

      // Verify no new version was created (still only 2 versions)
      const versionCount = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM note_versions WHERE note_id = ${noteId}
      `;
      assert.equal(versionCount[0].count, 2, "no new version should be created");

      // Verify note.currentVersionId in DB is v1Id
      const [noteRow] = await tx<{ current_version_id: string }[]>`
        SELECT current_version_id FROM notes WHERE id = ${noteId}
      `;
      assert.equal(noteRow.current_version_id, v1Id, "DB currentVersionId should be v1");

      // Restore back to v2 to verify bidirectional restore
      const result2 = await restoreNoteVersion(txExecutor, noteId, v2Id, workspaceId, userId);
      assert.ok(result2);
      assert.equal(result2!.version.id, v2Id);
      assert.equal(result2!.note.currentVersionId, v2Id);

      // Still only 2 versions
      const versionCount2 = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM note_versions WHERE note_id = ${noteId}
      `;
      assert.equal(versionCount2[0].count, 2, "no new version should be created on second restore");
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("restore: baseVersionId mismatch throws RevisionConflictError", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId, v1Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // currentVersionId is v2Id, but we pass v1Id as baseVersionId
      await assert.rejects(
        () => restoreNoteVersion(txExecutor, noteId, v1Id, workspaceId, userId, "wrong-base-version-id"),
        (err: unknown) => {
          assert.ok(err instanceof RevisionConflictError, "should throw RevisionConflictError");
          return true;
        },
        "baseVersionId mismatch should throw RevisionConflictError",
      );

      // Verify currentVersionId was NOT changed
      const [noteRow] = await tx<{ current_version_id: string }[]>`
        SELECT current_version_id FROM notes WHERE id = ${noteId}
      `;
      assert.notEqual(noteRow.current_version_id, v1Id, "currentVersionId should not have changed");
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("restore: updates search index after restore", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId, v1Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // Insert a search document for the note (simulating existing index)
      await tx`
        INSERT INTO search_documents (workspace_id, object_type, object_id, title, body, metadata, indexed_at)
        VALUES (${workspaceId}, 'note', ${noteId}, 'Old Title', 'old body', '{}', NOW())
      `;

      await restoreNoteVersion(txExecutor, noteId, v1Id, workspaceId, userId);

      // Verify search document was updated
      const [searchRow] = await tx<{ title: string; body: string }[]>`
        SELECT title, body FROM search_documents
        WHERE workspace_id = ${workspaceId} AND object_type = 'note' AND object_id = ${noteId}
      `;
      assert.ok(searchRow, "search document should exist after restore");
      // v1 content is "v1 content", auto title should be derived from it
      assert.equal(searchRow.body, "v1 content", "search body should reflect restored version content");
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("restore: soft-deleted note returns null", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId, v1Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // Soft-delete the note
      await tx`UPDATE notes SET deleted_at = NOW() WHERE id = ${noteId}`;

      const result = await restoreNoteVersion(txExecutor, noteId, v1Id, workspaceId, userId);
      assert.equal(result, null, "restoring a soft-deleted note should return null");
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("restore: non-existent target version returns null", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId } = await seedWorkspaceNoteWithTwoVersions(tx);
    const fakeVersionId = randomUUID();

    try {
      const result = await restoreNoteVersion(txExecutor, noteId, fakeVersionId, workspaceId, userId);
      assert.equal(result, null, "restoring to a non-existent version should return null");
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("restore: auto title is re-derived from restored version content", async () => {
  await sql.begin(async (tx) => {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const noteId = randomUUID();
    const v1Id = randomUUID();
    const v2Id = randomUUID();

    await tx`
      INSERT INTO workspaces (id, name, owner_id)
      VALUES (${workspaceId}, ${`test-ws-${workspaceId.slice(0, 8)}`}, ${userId})
    `;
    await tx`
      INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`test-${userId.slice(0, 8)}@example.test`}, 'test-hash', 'owner')
    `;
    await tx`
      INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')
    `;
    // Note has an auto title "v2 Title" that was derived from v2 content
    await tx`
      INSERT INTO notes (id, workspace_id, title, title_source, current_version_id, created_by)
      VALUES (${noteId}, ${workspaceId}, 'v2 Title', 'auto', ${v2Id}, ${userId})
    `;

    // v1 has a heading "v1 Heading"
    const v1Content = { blocks: [{ type: "heading", content: "# v1 Heading" }] };
    const v1Hash = computeContentHash(v1Content);
    await tx`
      INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${v1Id}, ${noteId}, ${workspaceId}, 1, ${JSON.stringify(v1Content)}, ${v1Hash}, ${userId})
    `;
    await tx`
      INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
      VALUES (${v1Id}, ${workspaceId}, 0, 'heading', '# v1 Heading')
    `;

    // v2 has a heading "v2 Heading"
    const v2Content = { blocks: [{ type: "heading", content: "# v2 Heading" }] };
    const v2Hash = computeContentHash(v2Content);
    await tx`
      INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${v2Id}, ${noteId}, ${workspaceId}, 2, ${JSON.stringify(v2Content)}, ${v2Hash}, ${userId})
    `;
    await tx`
      INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
      VALUES (${v2Id}, ${workspaceId}, 0, 'heading', '# v2 Heading')
    `;

    try {
      const result = await restoreNoteVersion(txExecutor, noteId, v1Id, workspaceId, userId);

      assert.ok(result);
      // Auto title should be re-derived from v1 content
      assert.equal(result!.note.title, "v1 Heading", "auto title should be re-derived from restored version");

      // Verify DB was updated
      const [noteRow] = await tx<{ title: string }[]>`
        SELECT title FROM notes WHERE id = ${noteId}
      `;
      assert.equal(noteRow.title, "v1 Heading", "DB title should be updated to v1 Heading");
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("restore: manual title is preserved during restore", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId, v1Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // Set title to manual
      await tx`UPDATE notes SET title = 'My Manual Title', title_source = 'manual' WHERE id = ${noteId}`;

      const result = await restoreNoteVersion(txExecutor, noteId, v1Id, workspaceId, userId);

      assert.ok(result);
      assert.equal(result!.note.title, "My Manual Title", "manual title should not be overwritten");
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("canUpdateVersionInPlace: superseded card blocks in-place update", async () => {
  await sql.begin(async (tx) => {
    const { workspaceId, userId, noteId, v2Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // Insert a superseded card referencing v2
      await tx`
        INSERT INTO learning_cards (id, workspace_id, note_version_id, status, schema_json)
        VALUES (${randomUUID()}, ${workspaceId}, ${v2Id}, 'superseded', ${JSON.stringify({ title: "Old Card", summary: "Superseded" })})
      `;

      // Attempt autosave (isAutosave=true) — should fall back to creating v3
      // because superseded card references the current version
      const result = await updateNote(txExecutor, noteId, workspaceId, userId, {
        blocks: [{ type: "paragraph", content: "updated content" }],
        baseVersionId: v2Id,
        isAutosave: true,
      });

      assert.ok(result);
      // Should have created a new version (v3), not updated v2 in place
      assert.notEqual(result!.version.id, v2Id, "should create new version, not update v2 in place");
      assert.equal(result!.version.versionNo, 3, "new version should be v3");

      // Verify v2 content was NOT modified
      const [v2Block] = await tx<{ content: string }[]>`
        SELECT content FROM note_blocks WHERE version_id = ${v2Id} ORDER BY ordinal LIMIT 1
      `;
      assert.equal(v2Block.content, "v2 content", "v2 content should be unchanged");
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});
