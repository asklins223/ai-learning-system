/**
 * Phase 3 集成测试:card_generation_plans 不可变仓库(P3-1)。
 *
 * 需要 PostgreSQL(postgres 服务已启动,migration 0069 已应用)。
 * 运行:
 *   CARD_GENERATION_TEST_ADMIN_URL=<admin-url> DATABASE_URL=<worker-url> \
 *     node --import tsx --test src/integration-tests/plan-repository-postgres.integration.ts
 *
 * 覆盖:
 *   - 只插入语义:同 run 多次 insert → version 1,2,3(不 UPDATE)
 *   - contentHash 内容寻址与 B1 规则一致(sha256(JSON.stringify()))
 *   - loadLatestPlan 返回最新版
 *   - 并发插入:唯一约束 + 重试 → 不产生重复 version
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import postgres from "postgres";
import { closeDatabase, withWorkerWorkspaceTransaction } from "../db.ts";
import { insertPlanRecord, loadLatestPlan, computePlanContentHash } from "../agent/plan-repository.ts";
import type { GenerationPlan } from "@ailearn/shared";

const adminUrl = process.env.CARD_GENERATION_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("CARD_GENERATION_TEST_ADMIN_URL is required");

const admin = postgres(adminUrl, { max: 4 });

const USER_ID = "10000000-0000-4000-8000-000000000022";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000022";
const RUN_ID = "50000000-0000-4000-8000-000000000090";

test.after(async () => {
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

function plan(documentIntent: string): GenerationPlan {
  return {
    schemaVersion: "1",
    documentIntent,
    learningFocus: ["监督学习"],
    bundleTasks: [
      { bundleId: "b1", specialist: "text_extractor", extractionFocus: "监督学习", relatedBundleIds: [], expectedDecisionKinds: ["candidate"] },
    ],
    compositionStrategy: { density: "standard", cardBudget: 3 },
  };
}

async function seedRun(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`DELETE FROM card_generation_plans WHERE run_id = ${RUN_ID}`;
    await tx`DELETE FROM card_generation_runs WHERE id = ${RUN_ID}`;
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'p3-plan@example.invalid', 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces
      (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'P3 plan test', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO notes
      (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES ('30000000-0000-4000-8000-000000000090', ${WORKSPACE_ID}, 'P3 plan title', ${USER_ID}, 1)
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES ('40000000-0000-4000-8000-000000000090', '30000000-0000-4000-8000-000000000090',
        ${WORKSPACE_ID}, 1, '{}', 'p3-plan-version-hash', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO card_generation_runs (
        id, workspace_id, note_id, note_version_id, requested_by,
        request_idempotency_key, generation_fingerprint, generation_epoch,
        title_snapshot, source_content_hash, block_manifest_hash, asset_manifest_hash,
        block_manifest, asset_manifest, status, stage, state_version,
        next_event_sequence, retryable, required_units
      ) VALUES (
        ${RUN_ID}, ${WORKSPACE_ID},
        '30000000-0000-4000-8000-000000000090',
        '40000000-0000-4000-8000-000000000090', ${USER_ID},
        ${`p3-${RUN_ID}`}, ${`p3-fp-${RUN_ID}`}, 1,
        'P3 plan title', 'p3-source-hash', 'p3-block-hash', 'p3-asset-hash',
        '[]'::jsonb, '[]'::jsonb, 'running', 'queued', 1, 1, true, 1
      ) ON CONFLICT (id) DO NOTHING`;
  });
}

test("P3-1: 只插入语义——同 run 多次 insert 产生递增 version,不覆盖", async () => {
  await seedRun();
  const unitId = "60000000-0000-4000-8000-000000000090";

  const r1 = await withWorkerWorkspaceTransaction({ workspaceId: WORKSPACE_ID, userId: USER_ID }, (tx) =>
    insertPlanRecord(tx, { workspaceId: WORKSPACE_ID, runId: RUN_ID, plan: plan("意图 v1"), producedByUnitId: unitId, producedByEventKey: "plan.initial" }));
  const r2 = await withWorkerWorkspaceTransaction({ workspaceId: WORKSPACE_ID, userId: USER_ID }, (tx) =>
    insertPlanRecord(tx, { workspaceId: WORKSPACE_ID, runId: RUN_ID, plan: plan("意图 v2"), producedByUnitId: unitId, producedByEventKey: "plan.replan" }));

  assert.equal(r1.version, 1);
  assert.equal(r2.version, 2);
  assert.notEqual(r1.contentHash, r2.contentHash, "内容不同 hash 不同");

  const latest = await withWorkerWorkspaceTransaction({ workspaceId: WORKSPACE_ID, userId: USER_ID }, (tx) =>
    loadLatestPlan(tx, RUN_ID));
  assert.equal(latest?.version, 2);
  assert.equal(latest?.plan.documentIntent, "意图 v2");

  const rows = await admin`SELECT version, produced_by_event_key FROM card_generation_plans WHERE run_id = ${RUN_ID} ORDER BY version`;
  assert.equal(rows.length, 2, "旧 version 保留(不可变)");
  assert.deepEqual(rows.map((r) => r.produced_by_event_key), ["plan.initial", "plan.replan"]);
});

test("P3-1: 相同内容 hash 稳定且与 B1 规则一致(sha256(JSON.stringify()))", () => {
  const h1 = computePlanContentHash(plan("意图 v1"));
  const h2 = computePlanContentHash(plan("意图 v1"));
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);

  // 与 B1 规则一致:sha256(JSON.stringify(value)),无键排序
  const expected = createHash("sha256").update(JSON.stringify(plan("意图 v1")), "utf8").digest("hex");
  assert.equal(h1, expected);
});

test("P3-1: 并发插入不产生重复 version(唯一约束 + 重试)", async () => {
  await seedRun();
  const unitId = "60000000-0000-4000-8000-000000000091";

  // 3 个独立事务并行(各自 set_config workspace_id + 独立连接),触发唯一约束冲突→重试
  const results = await Promise.all([
    withWorkerWorkspaceTransaction({ workspaceId: WORKSPACE_ID, userId: USER_ID }, (tx) =>
      insertPlanRecord(tx, { workspaceId: WORKSPACE_ID, runId: RUN_ID, plan: plan("并发 A"), producedByUnitId: unitId, producedByEventKey: "plan.a" })),
    withWorkerWorkspaceTransaction({ workspaceId: WORKSPACE_ID, userId: USER_ID }, (tx) =>
      insertPlanRecord(tx, { workspaceId: WORKSPACE_ID, runId: RUN_ID, plan: plan("并发 B"), producedByUnitId: unitId, producedByEventKey: "plan.b" })),
    withWorkerWorkspaceTransaction({ workspaceId: WORKSPACE_ID, userId: USER_ID }, (tx) =>
      insertPlanRecord(tx, { workspaceId: WORKSPACE_ID, runId: RUN_ID, plan: plan("并发 C"), producedByUnitId: unitId, producedByEventKey: "plan.c" })),
  ]);

  const versions = results.map((r) => r.version).sort();
  assert.deepEqual(versions, [1, 2, 3], "并发下 version 不重复");
});
