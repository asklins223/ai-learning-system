/**
 * 方案 20 §26 C8 — V1 旧 writer 停写 drill 集成测试（真实 postgres，ailearn 角色）。
 *
 * 覆盖（R33）：
 * 1. readiness：无 legacy writer hits + 有 V2 run → `canShutdown=true`；
 * 2. `executeV1WriterShutdown`：cardContentEpoch bump（UPSERT 建行/递增）+
 *    `card_generation_cutover_events` 落账（v1_writer_shutdown +
 *    v1_writer_epoch_bump）——审计闭包可复核；
 * 3. V1 guard：`CARD_GENERATION_V2_ENABLED=true` 且 `CARD_GENERATION_V1_WRITER_ENABLED`
 *    未开 → `createCardGenerationRun` 409 `v1_writer_disabled`（fail closed）；
 *    显式开启 → 放行（V1 run 创建并记录 legacy hit）；
 * 4. blocked 路径：workspace 有 legacy hit → `canShutdown=false`，execute 不执行。
 *
 * 运行（从仓库根）：
 *   DATABASE_URL_API="postgres://ailearn:ailearn_dev@localhost:5432/ailearn" \
 *   node --import workers/ai-worker/node_modules/tsx/dist/loader.mjs --test \
 *     apps/api/src/integration-tests/card-generation-v2-c8-shutdown.integration.ts
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

const CONTENT =
  "机会成本是指为了得到某种东西而必须放弃的其他东西的价值；选择某方案意味着放弃次优方案所能带来的收益。";

let seedVersionCounter = 0;

async function seedNote(title: string, content: string): Promise<{ versionId: string }> {
  const versionId = randomUUID();
  const blockId = randomUUID();
  seedVersionCounter += 1;
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`c8-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'C8 drill', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, ${title}, ${USER_ID}, 1) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (${versionId}, ${NOTE_ID}, ${WORKSPACE_ID}, ${seedVersionCounter}, ${tx.json({ blocks: [{ type: "paragraph", content }] })}, 'c8-hash', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_blocks (id, version_id, workspace_id, type, content, ordinal)
      VALUES (${blockId}, ${versionId}, ${WORKSPACE_ID}, 'paragraph', ${content}, 1)
      ON CONFLICT (id) DO NOTHING`;
  });
  return { versionId };
}

async function createV2Run(versionId: string) {
  const { createGenerationRunV2 } = await import(
    "../modules/card-generation-v2/generation-run-service.ts"
  );
  return createGenerationRunV2(
    { workspaceId: WORKSPACE_ID, userId: USER_ID },
    versionId,
    {
      version: 2,
      noteVersionId: versionId,
      sourceScope: { kind: "whole_note" },
      learningGoal: "understand",
      detailThreshold: "balanced",
      quantity: { kind: "adaptive" },
      clientRequestId: `c8-v2-${randomUUID()}`,
    },
    `c8-v2-key-${randomUUID()}`,
  );
}

before(async () => {
  await admin.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, ${`c8-${USER_ID}@example.invalid`}, 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'C8 drill', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
  });
});

after(async () => {
  await admin`DELETE FROM card_generation_runs_v2 WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM card_generation_runs WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM notes WHERE id = ${NOTE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM workspaces WHERE id = ${WORKSPACE_ID}`.catch(() => undefined);
  await admin`DELETE FROM users WHERE id = ${USER_ID}`.catch(() => undefined);
  await admin.end({ timeout: 5 });
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase().catch(() => undefined);
});

test("C8：readiness → executeV1WriterShutdown（epoch bump + 事件落账）→ V1 guard 停写/放行 → blocked 路径", async () => {
  const { withWorkspaceTransaction } = await import("../db/client.ts");
  const { checkLegacyWriterShutdownReadiness, executeV1WriterShutdown } = await import(
    "../modules/card-generation-v2/shutdown-rc-service.ts"
  );

  // ── 1. 建 V2 run（使 cutover 状态 v2_only：v2_runs>0 且 v1 hits=0）───
  const { versionId } = await seedNote("C8 drill", CONTENT);
  await createV2Run(versionId);

  const ctx = { workspaceId: WORKSPACE_ID, userId: USER_ID };

  // ── 2. readiness：canShutdown=true ────────────────────────────────────
  const readiness = await withWorkspaceTransaction(ctx, (tx) =>
    checkLegacyWriterShutdownReadiness(tx, WORKSPACE_ID));
  assert.equal(readiness.canShutdown, true,
    `无 legacy hits + 有 V2 run 时必须可以停写（blocking: ${readiness.blockingReasons.join(",")}）`);
  assert.equal(readiness.totalHitsLast24Hours, 0);
  assert.equal(readiness.totalHitsLast7Days, 0);

  // ── 3. execute：epoch bump（UPSERT）+ cutover 事件落账 ─────────────────
  const result = await withWorkspaceTransaction(ctx, (tx) =>
    executeV1WriterShutdown(tx, WORKSPACE_ID));
  assert.equal(result.executed, true, "readiness 满足时必须执行停写 drill");
  assert.equal(result.newEpoch, result.previousEpoch + 1);
  const epochRows = await admin`
    SELECT content_epoch FROM card_content_capability_state WHERE workspace_id = ${WORKSPACE_ID}`;
  assert.equal(Number(epochRows[0]?.content_epoch), result.newEpoch,
    "epoch bump 必须持久化（UPSERT 建行）");
  const events = await admin`
    SELECT event_type FROM card_generation_cutover_events
    WHERE workspace_id = ${WORKSPACE_ID} ORDER BY created_at`;
  const eventTypes = events.map((e) => e.event_type as string);
  assert.ok(eventTypes.includes("v1_writer_shutdown"), "必须记录 v1_writer_shutdown 事件");
  assert.ok(eventTypes.includes("v1_writer_epoch_bump"), "必须记录 v1_writer_epoch_bump 事件");

  // ── 4. V1 guard：V2 启用 + V1 writer 未开 → 409 v1_writer_disabled ────
  const { createCardGenerationRun } = await import("../modules/card-generation/service.ts");
  const prevV2 = process.env.CARD_GENERATION_V2_ENABLED;
  const prevV1 = process.env.CARD_GENERATION_V1_WRITER_ENABLED;
  try {
    process.env.CARD_GENERATION_V2_ENABLED = "true";
    delete process.env.CARD_GENERATION_V1_WRITER_ENABLED;
    await assert.rejects(
      createCardGenerationRun(ctx, {
        noteVersionId: versionId,
        idempotencyKey: `c8-v1-blocked-${randomUUID()}`,
      }),
      (err: unknown) => (err as { code?: string }).code === "v1_writer_disabled",
      "V2 启用且 V1 writer 未开时必须 409 v1_writer_disabled",
    );

    // ── 5. 显式开启 V1 writer → 放行（V1 run 创建 + legacy hit 记录）───
    process.env.CARD_GENERATION_V1_WRITER_ENABLED = "true";
    const accepted = await createCardGenerationRun(ctx, {
      noteVersionId: versionId,
      idempotencyKey: `c8-v1-allowed-${randomUUID()}`,
    });
    assert.ok(accepted.runId, "V1 writer 显式开启时必须放行");
    const hits = await admin`
      SELECT count(*)::int AS n FROM card_generation_legacy_writer_hits
      WHERE workspace_id = ${WORKSPACE_ID}`;
    assert.ok(hits[0].n >= 1, "V1 run 创建必须记录 legacy writer hit（探针）");
  } finally {
    if (prevV2 === undefined) delete process.env.CARD_GENERATION_V2_ENABLED;
    else process.env.CARD_GENERATION_V2_ENABLED = prevV2;
    if (prevV1 === undefined) delete process.env.CARD_GENERATION_V1_WRITER_ENABLED;
    else process.env.CARD_GENERATION_V1_WRITER_ENABLED = prevV1;
  }

  // ── 6. blocked 路径：legacy hit 存在 → canShutdown=false，execute 不执行 ──
  const readinessAfterHit = await withWorkspaceTransaction(ctx, (tx) =>
    checkLegacyWriterShutdownReadiness(tx, WORKSPACE_ID));
  assert.equal(readinessAfterHit.canShutdown, false,
    "存在 legacy hit 时必须 blocked");
  assert.ok(readinessAfterHit.blockingReasons.length >= 1);
  const blockedResult = await withWorkspaceTransaction(ctx, (tx) =>
    executeV1WriterShutdown(tx, WORKSPACE_ID));
  assert.equal(blockedResult.executed, false, "blocked 时不得执行停写");
  const eventsAfterBlocked = await admin`
    SELECT count(*)::int AS n FROM card_generation_cutover_events
    WHERE workspace_id = ${WORKSPACE_ID} AND event_type = 'v1_writer_shutdown'`;
  assert.equal(eventsAfterBlocked[0].n, 1, "blocked 执行不得重复落 v1_writer_shutdown 事件");
});
