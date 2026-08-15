/**
 * 方案 20 §21.4 / C34 — legacy multi-keypoint Card 迁移集成测试（R35）。
 *
 * - key point UUID 保留为 stable objective ID（alias 就绪）；
 * - 不伪造 V2 canonical answer（rubric-evidence 结构强制 → needs_regeneration）；
 * - 迁移事件审计 + 幂等重放；
 * - 已有 active V2 objective → v2_active noop；旧卡非 active → 不迁移。
 *
 * 运行（从仓库根）：
 *   DATABASE_URL_API="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
 *   node --import workers/ai-worker/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 \
 *     apps/api/src/integration-tests/card-generation-v2-c34-legacy-migration.integration.ts
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR
  ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL_API ??= ADMIN_URL;

const admin = postgres(ADMIN_URL, { max: 2 });

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const NOTE_ID = randomUUID();
const NOTE_VERSION_ID = randomUUID();

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`c34-${USER_ID}@example.invalid`}, 'unused') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'C34 migration', 'v1', now(), ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'c34', ${USER_ID}, 1) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${NOTE_VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1, '{}'::jsonb, 'c34-hash', ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
  });
});

after(async () => {
  await admin`DELETE FROM card_generation_cutover_events WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM learning_objectives_v2 WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM card_key_points WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM learning_cards WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM note_versions WHERE id = ${NOTE_VERSION_ID}`.catch(() => undefined);
  await admin`DELETE FROM notes WHERE id = ${NOTE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspaces WHERE id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM users WHERE id = ${USER_ID}`.catch(() => undefined);
  await admin.end({ timeout: 5 });
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase().catch(() => undefined);
});

test("C34：multi-keypoint 迁移 — alias 保留 + 不伪造答案 + 事件审计 + 幂等 + v2_active noop", async () => {
  const { withWorkspaceTransaction } = await import("../db/client.ts");
  const { migrateLegacyMultiKeypointCardV2 } = await import(
    "../modules/card-generation-v2/legacy-migration-service.ts"
  );

  // 旧卡 + 2 个 key point（UUID 即 stable objective ID）
  const cardId = randomUUID();
  const kp1 = randomUUID();
  const kp2 = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json)
      VALUES (${cardId}, ${NOTE_VERSION_ID}, ${WORKSPACE_ID}, 'active', '{}'::jsonb)`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text, segment_ref)
      VALUES (${kp1}, ${cardId}, ${WORKSPACE_ID}, 1, 'claim1', 'quote1', '{"type":"text"}'::jsonb),
             (${kp2}, ${cardId}, ${WORKSPACE_ID}, 2, 'claim2', 'quote2', '{"type":"text"}'::jsonb)`;
  });

  const ctx = { workspaceId: WORKSPACE_ID, userId: USER_ID };
  const first = await withWorkspaceTransaction(ctx, (tx) =>
    migrateLegacyMultiKeypointCardV2(tx, ctx, cardId));

  assert.equal(first.replayed, false);
  assert.equal(first.cardStatus, "active");
  assert.equal(first.keyPoints.length, 2, "must migrate both key points");
  for (const kp of first.keyPoints) {
    assert.equal(kp.objectiveId, kp.keyPointId, "key point UUID must be the stable objective ID");
    assert.equal(kp.status, "alias_ready", "no V2 objective yet → alias ready");
    assert.equal(kp.action, "needs_regeneration",
      "must not fabricate a V2 canonical answer (rubric-evidence structure forbids it)");
  }

  // 事件审计恰一条
  const events = await admin`
    SELECT event_type, payload FROM card_generation_cutover_events
    WHERE workspace_id = ${WORKSPACE_ID} AND event_type = 'legacy_card_migration'`;
  assert.equal(events.length, 1, "exactly one migration event");
  assert.equal(events[0].payload.cardId, cardId);
  assert.equal(Number(events[0].payload.keyPointCount), 2);

  // 幂等重放：不重复写事件，决策一致
  const replay = await withWorkspaceTransaction(ctx, (tx) =>
    migrateLegacyMultiKeypointCardV2(tx, ctx, cardId));
  assert.equal(replay.replayed, true, "replay must be idempotent");
  const eventsAfter = await admin`
    SELECT count(*)::int AS n FROM card_generation_cutover_events
    WHERE workspace_id = ${WORKSPACE_ID} AND event_type = 'legacy_card_migration'`;
  assert.equal(eventsAfter[0].n, 1, "replay must not duplicate the migration event");

  // 已有 active V2 objective（objective_id = kp1）→ v2_active noop
  await admin`
    INSERT INTO learning_objectives_v2
      (workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
       semantic_target_fingerprint, lifecycle, lifecycle_epoch, current_objective_revision_id, current_revision)
    VALUES (${WORKSPACE_ID}, ${kp1}, 'c34', 'sem-id-v1', ${"a".repeat(64)}, 'active', 1, ${randomUUID()}, 1)`;
  const afterV2 = await withWorkspaceTransaction(ctx, (tx) =>
    migrateLegacyMultiKeypointCardV2(tx, ctx, cardId));
  assert.equal(afterV2.replayed, true, "replay after v2 objective creation");
  const kp1Entry = afterV2.keyPoints.find((k) => k.keyPointId === kp1);
  const kp2Entry = afterV2.keyPoints.find((k) => k.keyPointId === kp2);
  assert.equal(kp1Entry?.status, "v2_active", "existing active V2 objective → noop");
  assert.equal(kp1Entry?.action, "noop");
  assert.equal(kp2Entry?.status, "alias_ready", "other key point still alias ready");

  // 旧卡非 active → 不迁移
  await admin`UPDATE learning_cards SET status = 'archived' WHERE id = ${cardId}`;
  const afterArchive = await withWorkspaceTransaction(ctx, (tx) =>
    migrateLegacyMultiKeypointCardV2(tx, ctx, cardId));
  assert.ok(afterArchive.keyPoints.every((k) => k.status === "card_not_active"),
    "archived legacy card must not migrate");
});

test("C35：legacy_unreviewed 判定 — legacy-migration 来源且无 review 记录 → practice_only 前置（不伪造 V2 eligibility）", async () => {
  const { withWorkspaceTransaction } = await import("../db/client.ts");
  const { detectLegacyUnreviewedV2 } = await import(
    "../modules/card-generation-v2/target-snapshot-adapter.ts"
  );
  const ctx = { workspaceId: WORKSPACE_ID, userId: USER_ID };

  const legacyObjId = randomUUID();
  const normalObjId = randomUUID();
  await admin.begin(async (tx) => {
    // review_schedules.key_point_id FK → card_key_points：先建 alias 行（archived 宿主卡）
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json)
      VALUES (${randomUUID()}, ${NOTE_VERSION_ID}, ${WORKSPACE_ID}, 'archived', '{}'::jsonb)`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text, segment_ref)
      VALUES (${legacyObjId}, (SELECT id FROM learning_cards WHERE workspace_id = ${WORKSPACE_ID} AND status = 'archived' ORDER BY created_at DESC LIMIT 1), ${WORKSPACE_ID}, 1, 'legacy', 'legacy', '{"type":"text"}'::jsonb)`;
    await tx`INSERT INTO learning_objectives_v2
      (workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
       semantic_target_fingerprint, lifecycle, lifecycle_epoch, current_objective_revision_id, current_revision)
      VALUES (${WORKSPACE_ID}, ${legacyObjId}, 'legacy-migration:legacy-card-1', 'sem-id-v1', ${"a".repeat(64)}, 'active', 1, ${randomUUID()}, 1),
             (${WORKSPACE_ID}, ${normalObjId}, 'candidate:some-candidate', 'sem-id-v1', ${"b".repeat(64)}, 'active', 1, ${randomUUID()}, 1)`;
  });

  // legacy-migration 来源 + 无 review_schedules → true
  const detected = await withWorkspaceTransaction(ctx, (tx) =>
    detectLegacyUnreviewedV2(tx, WORKSPACE_ID, legacyObjId));
  assert.equal(detected, true, "legacy-migration objective without review must be unreviewed");

  // 非 legacy 来源 → false
  const normal = await withWorkspaceTransaction(ctx, (tx) =>
    detectLegacyUnreviewedV2(tx, WORKSPACE_ID, normalObjId));
  assert.equal(normal, false, "candidate-origin objective must not be legacy-unreviewed");

  // 不存在的 objective → false
  const missing = await withWorkspaceTransaction(ctx, (tx) =>
    detectLegacyUnreviewedV2(tx, WORKSPACE_ID, randomUUID()));
  assert.equal(missing, false, "missing objective must not be legacy-unreviewed");

  // 有 review_schedules 记录（key_point_id=objectiveId）→ false（已被正式 review）
  await admin`
    INSERT INTO review_schedules
      (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, key_point_id)
    VALUES (${randomUUID()}, ${WORKSPACE_ID}, ${USER_ID}, 'key_point', ${legacyObjId}, 'completed',
            now(), 2, ${legacyObjId})`;
  const afterReview = await withWorkspaceTransaction(ctx, (tx) =>
    detectLegacyUnreviewedV2(tx, WORKSPACE_ID, legacyObjId));
  assert.equal(afterReview, false, "reviewed legacy objective must not be unreviewed");
});
