/**
 * doc 34 L21 §1 —— "当初那段话"真能取回来（0275 冻结副本，端到端）。
 *
 * 这条测的是四件此前分开都不会红的东西：密封写进副本表 → 表在 `ailearn_api` 下可读
 * （GRANT/RLS 都在迁移里，没写对就是运行期 permission denied 或静默 0 行）→
 * 原文被就地改写之后落点判成 drifted → 预览同时给出**现在的文字**与**当初那段**。
 *
 * 存量（0275 之前封的证据）不回填：那条断言在最后，防止有人拿今天的文本去"补副本"。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) throw new Error("需要 DATABASE_URL（夹具要建 user/workspace/note 全链）");
const sql = postgres(ADMIN, { max: 2 });

const { withWorkspaceTransaction } = await import("../db/client.ts");
const { sealEvidenceSnapshotsV2 } = await import("../modules/card-generation-v2/evidence-seal-service.ts");
const { loadEvidencePreviewItems } = await import("../modules/card-generation-v2/evidence-preview.ts");

const workspaceId = randomUUID();
const userId = randomUUID();
const noteId = randomUUID();
const noteVersionId = randomUUID();
const sourceSnapshotId = randomUUID();
const runId = randomUUID();
const blockId = randomUUID();
const ORIGINAL = "间隔重复的关键是在快要忘记的时候复习，而不是在记得的时候。";

before(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`quote-copy-${workspaceId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id, workspace_type)
      VALUES (${workspaceId}, ${`qc-${workspaceId.slice(0, 8)}`}, ${userId}, 'personal')`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by)
      VALUES (${noteId}, ${workspaceId}, 'quote-copy', ${userId})`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1,
        ${tx.json({ blocks: [] })}, 'fixture-hash', ${userId})`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
      VALUES (${blockId}, ${noteVersionId}, ${workspaceId}, 'paragraph', ${ORIGINAL}, 1)`;
  });
});

after(async () => {
  // V2 那套不可变触发器对所有副本行生效，清理必须走那道专门的 GUC（与 v2-card-fixture 同形）。
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.allow_history_mutation', 'on', true)`;
    await tx`DELETE FROM evidence_quote_copies_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM evidence_eligibility_states_v2 WHERE workspace_id = ${workspaceId}`;
    await tx`DELETE FROM evidence_snapshots_v2 WHERE workspace_id = ${workspaceId}`;
  });
  await sql`DELETE FROM evidence_eligibility_states_v2 WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM evidence_snapshots_v2 WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM note_blocks WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
  await sql.end();
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
});

test("密封把原文冻进副本表，ref 指向的就是这条证据自己的 id", async () => {
  await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    sealEvidenceSnapshotsV2(tx, {
      workspaceId,
      runId,
      noteId,
      noteVersionId,
      sourceSnapshotId,
      sourceScope: { kind: "whole_note" },
      blocks: [{ blockId, type: "paragraph", content: ORIGINAL, ordinal: 1 }],
    }));
  // 读回用另一条连接：Drizzle 的事务对象不是 postgres.js 的标签模板客户端。
  const sealed = await sql`
    SELECT evidence_snapshot_id, quote_text, quote_hash
    FROM evidence_quote_copies_v2 WHERE workspace_id = ${workspaceId}
  `;
  assert.equal(sealed.length, 1, `副本行没落库（${sealed.length} 行）——seal service 那一步没生效`);
  assert.equal(sealed[0].quote_text, ORIGINAL);

  const refs = await sql`
    SELECT protected_quote_ref, evidence_snapshot_id FROM evidence_snapshots_v2
    WHERE workspace_id = ${workspaceId} AND source_snapshot_id = ${sourceSnapshotId}
  `;
  assert.equal(refs.length, 1);
  assert.equal(
    refs[0].protected_quote_ref,
    `evidence://snapshot/${refs[0].evidence_snapshot_id}`,
    "ref 又指向一个不存在的对象（L21 §1 的原症状）",
  );
});

test("原文被改写之后，预览同时给出现在的文字与当初那段", async () => {
  const snapshotIds = await sql`
    SELECT evidence_snapshot_id FROM evidence_snapshots_v2
    WHERE workspace_id = ${workspaceId} AND source_snapshot_id = ${sourceSnapshotId}
  `;
  const ids = snapshotIds.map((row) => String(row.evidence_snapshot_id));
  assert.ok(ids.length > 0, "上一条用例没造出证据行");

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    // 等长改写：切片下标仍然落得进去，读侧才会既给出"现在的文字"又给出"当初那段"。
    // （把块改短会让 offsets 越界，那时 preview 是空串——那是 missing/越界那条路，不是这条。）
    await tx`UPDATE note_blocks
      SET content = ${ORIGINAL.replace("快要忘记的时候", "刚好想不起来的时候")}
      WHERE id = ${blockId}`;
  });

  const items = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadEvidencePreviewItems(tx, workspaceId, ids));
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceState, "drifted", "改写没被判成漂移，副本也就永远不会被用到");
  assert.notEqual(items[0].preview, ORIGINAL, "preview 该是改写后的文字");
  assert.ok(items[0].preview.includes("刚好想不起来的时候"), items[0].preview);
  assert.equal(items[0].originalPreview, ORIGINAL, "取不回当初那段——L21 §1 没闭上");
});

test("副本行本身不可变：想改历史必须显式开那道 GUC", async () => {
  await assert.rejects(
    () => sql`UPDATE evidence_quote_copies_v2 SET quote_text = '改写历史' WHERE workspace_id = ${workspaceId}`,
    /immutable_v2_row/,
    "副本可以被静默改写——那这份「当初那段」就不可信了",
  );
});

test("存量证据没有副本：originalPreview 为 null，不许拿今天的文本冒充", async () => {
  const legacySnapshotId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`
      INSERT INTO evidence_snapshots_v2 (
        id, workspace_id, evidence_snapshot_id, evidence_snapshot_hash, source_snapshot_id,
        note_id, block_id, start_offset, end_offset, protected_quote_ref, source_content_hash, modality
      ) VALUES (
        ${randomUUID()}, ${workspaceId}, ${legacySnapshotId}, 'h', ${sourceSnapshotId},
        ${noteId}, ${blockId}, 0, 6, ${`evidence://snapshot/${legacySnapshotId}`}, 'sh', 'text'
      )
    `;
  });
  const items = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    loadEvidencePreviewItems(tx, workspaceId, [legacySnapshotId]));
  assert.equal(items.length, 1);
  assert.notEqual(items[0].sourceState, "located", "夹具内容恰好一致，这条测不到存量路径");
  assert.equal(items[0].originalPreview, null);
});
