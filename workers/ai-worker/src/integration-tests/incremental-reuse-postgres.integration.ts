/**
 * Phase 5 集成测试:Note 版本迭代增量检查(遗留项③)。
 *
 * 需要 PostgreSQL。运行:
 *   CARD_GENERATION_TEST_ADMIN_URL=<admin-url> DATABASE_URL=<worker-url> \
 *     node --import tsx --test src/integration-tests/incremental-reuse-postgres.integration.ts
 *
 * 覆盖(真实版本迭代场景):
 *   - 新 note 首个版本 → hasPrevious=false(全量路径)
 *   - 同 note 第二版本(部分内容变化)→ hasPrevious=true、prevVersionNo=1、
 *     changedSpanCount/unchangedSpanCount/reuseRatio 正确
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { closeDatabase } from "../db.ts";
import { checkIncrementalReuse } from "../agent/incremental-reuse.ts";

const adminUrl = process.env.CARD_GENERATION_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("CARD_GENERATION_TEST_ADMIN_URL is required");

const admin = postgres(adminUrl, { max: 4 });

const USER_ID = "10000000-0000-4000-8000-000000000024";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000024";
const NOTE_ID = "30000000-0000-4000-8000-000000000096";
const V1_ID = "40000000-0000-4000-8000-000000000096";
const V2_ID = "40000000-0000-4000-8000-000000000097";
const RUN_V1 = "50000000-0000-4000-8000-000000000096";
const RUN_V2 = "50000000-0000-4000-8000-000000000097";

const BLOCKS_V1 = [
  { id: "blk-1", ordinal: 0, type: "paragraph", content: "监督学习需要带标签数据。" },
  { id: "blk-2", ordinal: 1, type: "paragraph", content: "回归预测连续值。" },
  { id: "blk-3", ordinal: 2, type: "paragraph", content: "分类预测离散类别。" },
];
const BLOCKS_V2 = [
  { id: "blk-1", ordinal: 0, type: "paragraph", content: "监督学习需要带标签数据。" },
  { id: "blk-2", ordinal: 1, type: "paragraph", content: "回归预测连续值(新增解释)。" },
  { id: "blk-3", ordinal: 2, type: "paragraph", content: "分类预测离散类别。" },
];

test.after(async () => {
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

async function seedRun(runId: string, versionId: string, blocks: typeof BLOCKS_V1): Promise<void> {
  const epoch = versionId === V1_ID ? 1 : 2;
  await admin.begin(async (tx) => {
    await tx`DELETE FROM card_generation_runs WHERE note_id = ${NOTE_ID}`;
    await tx`DELETE FROM note_versions WHERE id = ${versionId}`;
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'p5-reuse@example.invalid', 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces
      (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'P5 reuse test', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO notes
      (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, '增量复用', ${USER_ID}, 1)
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionId}, ${NOTE_ID}, ${WORKSPACE_ID},
        ${versionId === V1_ID ? 1 : 2}, ${tx.json({ blocks })}, ${`hash-${versionId}`}, ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO card_generation_runs (
        id, workspace_id, note_id, note_version_id, requested_by,
        request_idempotency_key, generation_fingerprint, generation_epoch,
        title_snapshot, source_content_hash, block_manifest_hash, asset_manifest_hash,
        block_manifest, asset_manifest, status, stage, state_version,
        next_event_sequence, retryable, required_units, budget_snapshot
      ) VALUES (
        ${runId}, ${WORKSPACE_ID}, ${NOTE_ID}, ${versionId}, ${USER_ID},
        ${`p5-reuse-${runId}`}, ${`p5-fp-${runId}`}, ${epoch}, 't', 'h', 'b', 'a',
        '[]'::jsonb, '[]'::jsonb, 'queued', 'queued', 1, 1, true, 1,
        ${tx.json({ roles: {}, maxProviderCalls: 10, maxInputTokens: 1000, maxOutputTokens: 1000, maxEmbeddingTokens: 0, maxParallelTasks: 0, runDeadline: "2030-01-01T00:00:00.000Z", costCap: 0 })}
      ) ON CONFLICT (id) DO NOTHING`;
  });
}

test("新 note 首版本 → hasPrevious=false(全量路径)", async () => {
  await seedRun(RUN_V1, V1_ID, BLOCKS_V1);
  const info = await checkIncrementalReuse(WORKSPACE_ID, RUN_V1);
  assert.equal(info.hasPrevious, false);
  assert.equal(info.prevVersionNo, null);
  assert.equal(info.reuseRatio, 0);
});

test("第二版本(部分变化)→ hasPrevious=true 且 diff 正确", async () => {
  await seedRun(RUN_V1, V1_ID, BLOCKS_V1);
  await seedRun(RUN_V2, V2_ID, BLOCKS_V2);
  const info = await checkIncrementalReuse(WORKSPACE_ID, RUN_V2);
  assert.equal(info.hasPrevious, true);
  assert.equal(info.prevVersionNo, 1);
  assert.equal(info.changedSpanCount, 1, "blk-2 内容变化");
  assert.equal(info.unchangedSpanCount, 2, "blk-1/blk-3 未变化可复用");
  assert.ok(Math.abs(info.reuseRatio - 2 / 3) < 1e-9, `reuseRatio=${info.reuseRatio}`);
  assert.equal(info.hasChanges, true);
});
