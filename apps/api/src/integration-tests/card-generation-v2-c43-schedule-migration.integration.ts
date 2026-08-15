/**
 * 方案 20 C43 — legacy pending Schedule 三路迁移集成测试（R35）。
 *
 * upgrade（保留 ID/generation/dueAt）：V1 卡 active / V2 objective active；
 * blocked（可见不可 consume）：目标卡非 active；
 * invalid（带 reason 关闭）：目标引用缺失 → cancelled + reason_code。
 *
 * 运行（从仓库根）：
 *   DATABASE_URL_API="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
 *   node --import workers/ai-worker/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 \
 *     apps/api/src/integration-tests/card-generation-v2-c43-schedule-migration.integration.ts
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

async function insertSchedule(input: {
  subjectType: "card" | "key_point";
  subjectId: string;
  keyPointId?: string;
  status?: string;
}) {
  const id = randomUUID();
  await admin`
    INSERT INTO review_schedules
      (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, key_point_id, generation)
    VALUES (${id}, ${WORKSPACE_ID}, ${USER_ID}, ${input.subjectType}, ${input.subjectId},
            ${input.status ?? "pending"}, now() + interval '1 day', 2, ${input.keyPointId ?? null}, 3)`;
  return id;
}

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`c43-${USER_ID}@example.invalid`}, 'unused') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'C43 migration', 'v1', now(), ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'c43', ${USER_ID}, 1) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${NOTE_VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1, '{}'::jsonb, 'c43-hash', ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
      VALUES (${randomUUID()}, ${NOTE_VERSION_ID}, ${WORKSPACE_ID}, 'paragraph', 'c43', 1) ON CONFLICT (id) DO NOTHING`;
  });
});

after(async () => {
  await admin`DELETE FROM review_schedules WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM card_key_points WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM learning_cards WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM learning_cards_v2 WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM learning_objectives_v2 WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM notes WHERE id = ${NOTE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspaces WHERE id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM users WHERE id = ${USER_ID}`.catch(() => undefined);
  await admin.end({ timeout: 5 });
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase().catch(() => undefined);
});

test("C43：三路迁移 — upgrade 保留 ID/generation/dueAt；blocked 标记；invalid 带 reason 关闭；幂等", async () => {
  const { withWorkspaceTransaction } = await import("../db/client.ts");
  const { migrateLegacyPendingSchedulesV2 } = await import(
    "../modules/review/schedule-migration.ts"
  );

  // ── 场景 a：V1 卡 active → upgrade ──────────────────────────────────
  const cardA = randomUUID();
  const kpA = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json)
      VALUES (${cardA}, ${NOTE_VERSION_ID}, ${WORKSPACE_ID}, 'active', '{}'::jsonb)`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text, segment_ref)
      VALUES (${kpA}, ${cardA}, ${WORKSPACE_ID}, 1, 'claimA', 'quoteA', '{"type":"text"}'::jsonb)`;
  });
  const scheduleA = await insertSchedule({ subjectType: "key_point", subjectId: kpA, keyPointId: kpA });

  // ── 场景 b：V1 卡 archived → blocked ────────────────────────────────
  const cardB = randomUUID();
  const kpB = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json)
      VALUES (${cardB}, ${NOTE_VERSION_ID}, ${WORKSPACE_ID}, 'archived', '{}'::jsonb)`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text, segment_ref)
      VALUES (${kpB}, ${cardB}, ${WORKSPACE_ID}, 1, 'claimB', 'quoteB', '{"type":"text"}'::jsonb)`;
  });
  const scheduleB = await insertSchedule({ subjectType: "key_point", subjectId: kpB, keyPointId: kpB });

  // ── 场景 c：目标缺失 → invalid（cancelled + reason）──────────────────
  const scheduleC = await insertSchedule({ subjectType: "card", subjectId: randomUUID() });

  // ── 场景 d：V2 objective（alias keyPointId）→ upgrade ───────────────
  const objectiveId = randomUUID();
  const cardD = randomUUID();
  const aliasHostCardId = randomUUID();
  await admin.begin(async (tx) => {
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json)
      VALUES (${aliasHostCardId}, ${NOTE_VERSION_ID}, ${WORKSPACE_ID}, 'archived', '{}'::jsonb)`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text, segment_ref)
      VALUES (${objectiveId}, ${aliasHostCardId}, ${WORKSPACE_ID}, 1, 'alias', 'alias', '{"type":"text"}'::jsonb)`;
    await tx`INSERT INTO learning_objectives_v2 (workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version, semantic_target_fingerprint, lifecycle, lifecycle_epoch, current_objective_revision_id, current_revision)
      VALUES (${WORKSPACE_ID}, ${objectiveId}, 'c43', 'sem-id-v1', ${"a".repeat(64)}, 'active', 1, ${randomUUID()}, 1)`;
    await tx`INSERT INTO learning_cards_v2 (workspace_id, card_id, objective_id, card_revision, current_publication_revision, lifecycle, front, public_summary, knowledge_form, strategy, presentation_hash)
      VALUES (${WORKSPACE_ID}, ${cardD}, ${objectiveId}, 1, 1, 'active', '{"cue":"c"}'::jsonb, 'summary', 'fact', 's', ${"b".repeat(64)})`;
  });
  const scheduleD = await insertSchedule({ subjectType: "key_point", subjectId: objectiveId, keyPointId: objectiveId });

  // ── 执行迁移 ────────────────────────────────────────────────────────
  const ctx = { workspaceId: WORKSPACE_ID, userId: USER_ID };
  const first = await withWorkspaceTransaction(ctx, (tx) =>
    migrateLegacyPendingSchedulesV2(tx, WORKSPACE_ID));
  assert.equal(first.total, 4, "must process 4 pending schedules");
  assert.equal(first.upgraded, 2, "a + d must upgrade (V1 active + V2 active)");
  assert.equal(first.blocked, 1, "b must block (card archived)");
  assert.equal(first.invalid, 1, "c must invalid (target missing)");
  assert.equal(first.invalidReasons["card_target_missing"], 1, "invalid reason must be card_target_missing");

  // 行级断言
  const rowA = await admin`SELECT status, reason_code, interval_days, generation, next_review_at FROM review_schedules WHERE id = ${scheduleA}`;
  assert.equal(rowA[0].status, "pending", "upgrade must keep pending");
  assert.equal(Number(rowA[0].interval_days), 2, "upgrade must preserve intervalDays");
  assert.equal(Number(rowA[0].generation), 3, "upgrade must preserve generation");
  assert.ok(rowA[0].next_review_at, "upgrade must preserve dueAt");
  assert.equal(rowA[0].reason_code, null, "upgrade must not rewrite reason_code");

  const rowB = await admin`SELECT status, reason_code FROM review_schedules WHERE id = ${scheduleB}`;
  assert.equal(rowB[0].status, "pending", "blocked must stay pending (visible)");
  assert.equal(rowB[0].reason_code, "migrated_blocked", "blocked must be marked");

  const rowC = await admin`SELECT status, reason_code FROM review_schedules WHERE id = ${scheduleC}`;
  assert.equal(rowC[0].status, "cancelled", "invalid must be closed");
  assert.ok(String(rowC[0].reason_code).startsWith("migrated_invalid:"), "invalid must carry reason");

  const rowD = await admin`SELECT status FROM review_schedules WHERE id = ${scheduleD}`;
  assert.equal(rowD[0].status, "pending", "V2 objective schedule must upgrade (kept pending)");

  // 幂等：再跑 → invalid 不再计入；upgrade/blocked 判定稳定
  const second = await withWorkspaceTransaction(ctx, (tx) =>
    migrateLegacyPendingSchedulesV2(tx, WORKSPACE_ID));
  assert.equal(second.total, 3, "second run must see only pending (a/b/d)");
  assert.equal(second.upgraded, 2, "second run upgrade stable");
  assert.equal(second.blocked, 1, "second run blocked stable");
  assert.equal(second.invalid, 0, "second run must not re-close invalid");
  const rowC2 = await admin`SELECT status FROM review_schedules WHERE id = ${scheduleC}`;
  assert.equal(rowC2[0].status, "cancelled", "invalid schedule stays cancelled");
});
