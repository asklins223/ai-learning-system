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
import * as Y from "yjs";
import {
  RevisionConflictError,
  restoreNoteVersion,
} from "../modules/note/service.ts";
import {
  editBlockContent,
} from "../modules/note/doc.ts";
import {
  loadNoteDoc,
  persistNoteDoc,
  resolveNoteDocFlushTarget,
} from "../modules/note/document-state.ts";
import { computeContentHash } from "../modules/note/content-hash.ts";
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

/**
 * 走一遍与协同落盘完全相同的路：读文档 → 改 → 挑一个能写的版本 → 投影。
 * 用例因此测的是生产那条落盘口，不是它自己现编的一套写法。
 */
async function flushLikeCollaboration(
  workspaceId: string,
  userId: string,
  noteId: string,
  mutate: (doc: Y.Doc) => void,
): Promise<string> {
  return withServiceTransaction(async (tx) => {
    const scope = { workspaceId, noteId, userId };
    const { doc } = await loadNoteDoc(tx, scope);
    try {
      doc.transact(() => mutate(doc));
      const versionId = await resolveNoteDocFlushTarget(tx, scope, doc);
      await persistNoteDoc(tx, scope, doc, versionId);
      return versionId;
    } finally {
      doc.destroy();
    }
  });
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

/**
 * 落盘口遇到"当前版本已被 seal"（批次 4.4 之后的等价物，替代原来的
 * "canUpdateVersionInPlace 降级新建版本"用例）。
 *
 * 为什么还必须测：`note_blocks` 上的 `note_blocks_sealed_guard` 触发器对已 seal 的版本
 * 改一行就 RAISE(55000)。落盘口不挑版本的话，症状不是报错而是**这篇笔记从此落不了盘**
 * ——Hocuspocus 在落盘抛错时故意把文档留在内存里，内容不丢、也不通知任何人。
 */
test("被 seal 的当前版本：落盘另起一版，不动被引用的那一版", async () => {
  await withTestSql(async (tx) => {
    const { workspaceId, userId, noteId, v2Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      await tx`UPDATE note_versions SET sealed_at = NOW() WHERE id = ${v2Id}`;
      const before = await tx<{ content: string }[]>`
        SELECT content FROM note_blocks WHERE version_id = ${v2Id} ORDER BY ordinal LIMIT 1
      `;

      const target = await flushLikeCollaboration(workspaceId, userId, noteId, (doc) => {
        editBlockContent(doc, 0, "落在被 seal 之后的一次编辑");
      });

      assert.notEqual(target, v2Id, "当前版本被 seal 过时落盘口必须另起一版");
      const after = await tx<{ content: string }[]>`
        SELECT content FROM note_blocks WHERE version_id = ${v2Id} ORDER BY ordinal LIMIT 1
      `;
      assert.equal(after[0].content, before[0].content, "被 seal 版本的行不该被改动");

      const pointer = await tx<{ current_version_id: string }[]>`
        SELECT current_version_id FROM notes WHERE id = ${noteId}
      `;
      assert.equal(pointer[0].current_version_id, target, "指针要跟上落盘实际写入的那一版");
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});

/**
 * 回归（2026-09-18）：改**已有块**这条热路整条链路。
 *
 * 当年 `updateVersionInPlace` 那条 `UPDATE ... FROM (unnest(...))` 把列类型写进了
 * unnest 的列定义列表，PostgreSQL 不接受「多参数 unnest() + 列定义列表」直接抛错，
 * 于是"改一个已有段落"每次 500（生产日志里 8/9 的 PATCH 全 500）。上面那条 sealed
 * 用例走的是"降级新建版本"分支，永远碰不到那段 UPDATE，所以旧写法一路漏到线上。
 *
 * 写路后来换成了"文档 → 投影"，这条用例**测的还是同一件事**：改已有块必须是就地改行，
 * 不能炸、也不该顺手多建一个版本。版本快照则刻意**不**跟着走（它记的是提交那一刻）。
 */
test("就地改一个已有块：改行、不建版、不动版本快照", async () => {
  await withTestSql(async (tx) => {
    const { workspaceId, userId, noteId, v2Id } = await seedWorkspaceNoteWithTwoVersions(tx);

    try {
      const target = await flushLikeCollaboration(workspaceId, userId, noteId, (doc) => {
        editBlockContent(doc, 0, "autosaved edit");
      });
      assert.equal(target, v2Id, "改一个已有块不该建新版本");

      const blocks = await tx<{ ordinal: number; content: string }[]>`
        SELECT ordinal, content FROM note_blocks WHERE version_id = ${v2Id} ORDER BY ordinal
      `;
      // postgres-js 返回的行不是普通对象，直接 deepEqual 会因原型不同而假失败。
      assert.deepEqual(
        blocks.map((block) => ({ ordinal: Number(block.ordinal), content: block.content })),
        [{ ordinal: 0, content: "autosaved edit" }],
        "改过的那块要写上（这一版只有一块正文）",
      );

      const versionCount = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM note_versions WHERE note_id = ${noteId}
      `;
      assert.equal(Number(versionCount[0].count), 2, "就地落盘不该多出版本行");

      const [versionRow] = await tx<{ content_json: { blocks: Array<{ content: string }> } }[]>`
        SELECT content_json FROM note_versions WHERE id = ${v2Id}
      `;
      // 版本快照**不**跟着落盘走：它记的是这一版被提交当时的样子。刷了它，
      // 「提交并确认」就再也判断不出"文档与最新一版不同"，历史停止增长。
      assert.deepEqual(
        versionRow.content_json.blocks.map((block) => block.content),
        ["v2 content"],
        "落盘不该改写已有版本的快照",
      );
    } finally {
      await cleanupWorkspace(tx, workspaceId, userId, noteId);
    }
  });
});
