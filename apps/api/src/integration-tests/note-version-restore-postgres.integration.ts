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
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { type ApiTransaction } from "../db/client.ts";
import * as schema from "@ailearn/shared/db-schema";
import {
  restoreNoteVersion,
  updateNote,
  RevisionConflictError,
  computeContentHash,
} from "../modules/note/service.ts";

const databaseUrl = process.env.NOTE_VERSION_RESTORE_TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "NOTE_VERSION_RESTORE_TEST_DATABASE_URL is required for the note version restore integration test",
  );
}

const sql = postgres(databaseUrl, { max: 2 });
const serviceSql = postgres(databaseUrl, { max: 2 });
const serviceDatabase = drizzle(serviceSql, { schema });

test.after(async () => {
  const closeResults = await Promise.allSettled([
    sql.end({ timeout: 5 }),
    serviceSql.end({ timeout: 5 }),
  ]);
  const failures = closeResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to close note restore PostgreSQL clients");
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────

async function withTestSql<T>(
  operation: (connection: Sql) => Promise<T>,
): Promise<T> {
  return operation(sql);
}

async function withServiceTransaction<T>(
  operation: (transaction: ApiTransaction) => Promise<T>,
): Promise<T> {
  return serviceDatabase.transaction(operation);
}

interface SeedResult {
  workspaceId: string;
  userId: string;
  noteId: string;
  v1Id: string;
  v2Id: string;
}

async function seedWorkspaceNoteWithTwoVersions(
  tx: Sql,
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
    VALUES (${v1Id}, ${noteId}, ${workspaceId}, 1, ${tx.json(v1Content)}, ${v1Hash}, ${userId})
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
    VALUES (${v2Id}, ${noteId}, ${workspaceId}, 2, ${tx.json(v2Content)}, ${v2Hash}, ${userId})
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
  tx: Sql,
  workspaceId: string,
  userId: string,
  noteId: string,
) {
  await tx`DELETE FROM search_documents WHERE workspace_id = ${workspaceId}`;
  // 密封版本受三层触发器保护（blocks 不可变 / 版本字段不可改 / 不可直接删除），
  // 唯一放行路径是 depth>1 的级联删除：先删 notes，让版本与 blocks 级联清理。
  await tx`DELETE FROM notes WHERE id = ${noteId}`;
  await tx`DELETE FROM note_blocks WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await tx`DELETE FROM users WHERE id = ${userId}`;
}

// ─── Tests ───────────────────────────────────────────────────────────────

test("restore: switches currentVersionId to target version without creating a new version", async () => {
  await withTestSql(async (tx) => {
    const { workspaceId, userId, noteId, v1Id, v2Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // Restore to v1
      const result = await withServiceTransaction((serviceTx) =>
        restoreNoteVersion(serviceTx, noteId, v1Id, workspaceId, userId)
      );

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
      const result2 = await withServiceTransaction((serviceTx) =>
        restoreNoteVersion(serviceTx, noteId, v2Id, workspaceId, userId)
      );
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
  await withTestSql(async (tx) => {
    const { workspaceId, userId, noteId, v1Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // currentVersionId is v2Id, but we pass v1Id as baseVersionId
      await assert.rejects(
        () => withServiceTransaction((serviceTx) =>
          restoreNoteVersion(
            serviceTx,
            noteId,
            v1Id,
            workspaceId,
            userId,
            "wrong-base-version-id",
          )
        ),
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
  await withTestSql(async (tx) => {
    const { workspaceId, userId, noteId, v1Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // Insert a search document for the note (simulating existing index)
      await tx`
        INSERT INTO search_documents (workspace_id, object_type, object_id, title, body, metadata, indexed_at)
        VALUES (${workspaceId}, 'note', ${noteId}, 'Old Title', 'old body', '{}', NOW())
      `;

      await withServiceTransaction((serviceTx) =>
        restoreNoteVersion(serviceTx, noteId, v1Id, workspaceId, userId)
      );

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
  await withTestSql(async (tx) => {
    const { workspaceId, userId, noteId, v1Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // Soft-delete the note
      await tx`UPDATE notes SET deleted_at = NOW() WHERE id = ${noteId}`;

      const result = await withServiceTransaction((serviceTx) =>
        restoreNoteVersion(serviceTx, noteId, v1Id, workspaceId, userId)
      );
      assert.equal(result, null, "restoring a soft-deleted note should return null");
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("restore: non-existent target version returns null", async () => {
  await withTestSql(async (tx) => {
    const { workspaceId, userId, noteId } = await seedWorkspaceNoteWithTwoVersions(tx);
    const fakeVersionId = randomUUID();

    try {
      const result = await withServiceTransaction((serviceTx) =>
        restoreNoteVersion(serviceTx, noteId, fakeVersionId, workspaceId, userId)
      );
      assert.equal(result, null, "restoring to a non-existent version should return null");
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("restore: auto title is re-derived from restored version content", async () => {
  await withTestSql(async (tx) => {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const noteId = randomUUID();
    const v1Id = randomUUID();
    const v2Id = randomUUID();

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
    // Note has an auto title "v2 Title" that was derived from v2 content
    await tx`
      INSERT INTO notes (id, workspace_id, title, title_source, created_by)
      VALUES (${noteId}, ${workspaceId}, 'v2 Title', 'auto', ${userId})
    `;

    // v1 has a heading "v1 Heading"
    const v1Content = { blocks: [{ type: "heading", content: "# v1 Heading" }] };
    const v1Hash = computeContentHash(v1Content);
    await tx`
      INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${v1Id}, ${noteId}, ${workspaceId}, 1, ${tx.json(v1Content)}, ${v1Hash}, ${userId})
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
      VALUES (${v2Id}, ${noteId}, ${workspaceId}, 2, ${tx.json(v2Content)}, ${v2Hash}, ${userId})
    `;
    await tx`
      INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
      VALUES (${v2Id}, ${workspaceId}, 0, 'heading', '# v2 Heading')
    `;
    await tx`
      UPDATE notes SET current_version_id = ${v2Id} WHERE id = ${noteId}
    `;

    try {
      const result = await withServiceTransaction((serviceTx) =>
        restoreNoteVersion(serviceTx, noteId, v1Id, workspaceId, userId)
      );

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
  await withTestSql(async (tx) => {
    const { workspaceId, userId, noteId, v1Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // Set title to manual
      await tx`UPDATE notes SET title = 'My Manual Title', title_source = 'manual' WHERE id = ${noteId}`;

      const result = await withServiceTransaction((serviceTx) =>
        restoreNoteVersion(serviceTx, noteId, v1Id, workspaceId, userId)
      );

      assert.ok(result);
      assert.equal(result!.note.title, "My Manual Title", "manual title should not be overwritten");
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

test("canUpdateVersionInPlace: sealed version blocks in-place update", async () => {
  await withTestSql(async (tx) => {
    const { workspaceId, userId, noteId, v2Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // Seal v2 — sealed versions block in-place update (V2: replaces old
      // superseded learning_cards check which is no longer applicable).
      await tx`UPDATE note_versions SET sealed_at = NOW() WHERE id = ${v2Id}`;

      // Attempt autosave (isAutosave=true) — should fall back to creating v3
      // because the current version is sealed.
      const result = await withServiceTransaction((serviceTx) =>
        updateNote(serviceTx, noteId, workspaceId, userId, {
          blocks: [{ type: "paragraph", content: "updated content" }],
          baseVersionId: v2Id,
          isAutosave: true,
        })
      );

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

/**
 * 回归（2026-09-18）：改动**既有块的自动保存**整条链路。
 *
 * `updateVersionInPlace` 用一条 `UPDATE ... FROM (unnest(...))` 把同一顺序号上
 * 内容发生变化的块批量写回。这段 SQL 曾把列类型写进 unnest 的列定义列表
 * （`AS ord(id uuid, type text, ...)`），而 PostgreSQL 不接受「多参数 unnest() +
 * 列定义列表」，直接抛
 *   UNNEST() with multiple arguments cannot have a column definition list
 * → 每次「改已有段落」的自动保存都是 500（生产日志 8/9 次 PATCH 全 500）。
 *
 * 上面那条 sealed 用例走的是「降级新建版本」分支，**永远碰不到这段 UPDATE**，
 * 所以旧写法一路漏到线上。本用例专门钉住原地更新分支。
 */
test("autosave in place: editing an existing block writes back without a new version", async () => {
  await withTestSql(async (tx) => {
    const { workspaceId, userId, noteId, v2Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      // v2 未密封 → 允许原地更新，且顺序号 0 的块内容确实变了 → 命中批量 UPDATE。
      const result = await withServiceTransaction((serviceTx) =>
        updateNote(serviceTx, noteId, workspaceId, userId, {
          blocks: [
            { type: "paragraph", content: "autosaved edit" },
            { type: "paragraph", content: "second block" },
          ],
          baseVersionId: v2Id,
          isAutosave: true,
        })
      );

      assert.ok(result, "in-place autosave should return a result");
      assert.equal(result!.version.id, v2Id, "in-place autosave must not create a new version");
      assert.equal(result!.version.versionNo, 2, "in-place autosave keeps version 2");

      const blocks = await tx<{ ordinal: number; content: string }[]>`
        SELECT ordinal, content FROM note_blocks WHERE version_id = ${v2Id} ORDER BY ordinal
      `;
      // postgres-js 返回的行不是普通对象，直接 deepEqual 会因为原型不同而假失败。
      assert.deepEqual(
        blocks.map((block) => ({ ordinal: block.ordinal, content: block.content })),
        [
          { ordinal: 0, content: "autosaved edit" },
          { ordinal: 1, content: "second block" },
        ],
        "changed block is rewritten and the new block is inserted",
      );

      const versionCount = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM note_versions WHERE note_id = ${noteId}
      `;
      assert.equal(versionCount[0].count, 2, "in-place autosave adds no version row");

      // 版本快照与块表必须一致：原地更新的语义是二者同步改写。
      const [versionRow] = await tx<{ content_json: { blocks: Array<{ content: string }> } }[]>`
        SELECT content_json FROM note_versions WHERE id = ${v2Id}
      `;
      assert.deepEqual(
        versionRow.content_json.blocks.map((block) => block.content),
        ["autosaved edit", "second block"],
        "content_json follows the in-place block rewrite",
      );
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});
