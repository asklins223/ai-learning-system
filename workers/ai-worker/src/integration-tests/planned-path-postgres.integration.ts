/**
 * Phase 3 集成测试:Planned Specialist DAG unit 创建幂等(遗留项②)。
 *
 * 需要 PostgreSQL(migration 0073 已应用)。运行:
 *   CARD_GENERATION_TEST_ADMIN_URL=<admin-url> DATABASE_URL=<worker-url> \
 *     node --import tsx --test src/integration-tests/planned-path-postgres.integration.ts
 *
 * 覆盖:
 *   - createPlannedSpecialistUnit 幂等(同 bundle+rv → 同 id)
 *   - specialist 完成后重复调用 → status 恢复 pending(重跑)
 *   - createPlannedComposeUnit 幂等
 *   - 多 wave ordinal 不撞 identityUnique(ordinal=30+wave*100+idx)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { closeDatabase } from "../db.ts";
import { createPlannedComposeUnit, createPlannedSpecialistUnit } from "../agent/unit-helpers.ts";
import type { JobPayload } from "../handlers/index.ts";
import type { AgentJobPayload } from "../agent/types.ts";

const adminUrl = process.env.CARD_GENERATION_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("CARD_GENERATION_TEST_ADMIN_URL is required");

const admin = postgres(adminUrl, { max: 4 });

const USER_ID = "10000000-0000-4000-8000-000000000023";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000023";
const RUN_ID = "50000000-0000-4000-8000-000000000091";
const PLAN_UNIT_ID = "60000000-0000-4000-8000-000000000091";

const job: JobPayload = {
  id: "70000000-0000-4000-8000-000000000091",
  type: "execute_card_agent_turn",
  workspaceId: WORKSPACE_ID,
  requestedBy: USER_ID,
  payload: {},
  leaseToken: "it-lease",
} as unknown as JobPayload;

const payload: AgentJobPayload = {
  generationRunId: RUN_ID,
  agentUnitId: PLAN_UNIT_ID,
  turnNo: 1,
  inputHash: "planned-path-it",
};

test.after(async () => {
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

async function seed(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`DELETE FROM card_generation_units WHERE run_id = ${RUN_ID}`;
    await tx`DELETE FROM card_generation_runs WHERE id = ${RUN_ID}`;
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'p3-planned@example.invalid', 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces
      (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'P3 planned test', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO notes
      (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES ('30000000-0000-4000-8000-000000000091', ${WORKSPACE_ID}, 't', ${USER_ID}, 1)
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES ('40000000-0000-4000-8000-000000000091', '30000000-0000-4000-8000-000000000091',
        ${WORKSPACE_ID}, 1, '{"blocks":[]}'::jsonb, 'h', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO card_generation_runs (
        id, workspace_id, note_id, note_version_id, requested_by,
        request_idempotency_key, generation_fingerprint, generation_epoch,
        title_snapshot, source_content_hash, block_manifest_hash, asset_manifest_hash,
        block_manifest, asset_manifest, status, stage, state_version,
        next_event_sequence, retryable, required_units, budget_snapshot
      ) VALUES (
        ${RUN_ID}, ${WORKSPACE_ID}, '30000000-0000-4000-8000-000000000091',
        '40000000-0000-4000-8000-000000000091', ${USER_ID},
        'p3-planned-it', 'p3-planned-fp', 1, 't', 'h', 'b', 'a',
        '[]'::jsonb, '[]'::jsonb, 'queued', 'queued', 1, 1, true, 1,
        ${admin.json({ roles: {}, maxProviderCalls: 10, maxInputTokens: 1000, maxOutputTokens: 1000, maxEmbeddingTokens: 0, maxParallelTasks: 0, runDeadline: "2030-01-01T00:00:00.000Z", costCap: 0 })}
      ) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO card_generation_units
      (id, workspace_id, run_id, kind, level, ordinal, unit_key, required,
       input_manifest, input_hash, status)
      VALUES (${PLAN_UNIT_ID}, ${WORKSPACE_ID}, ${RUN_ID}, 'supervisor_plan', 0, 10,
        ${`plan:${RUN_ID}`}, true, '{}'::jsonb, 'h', 'pending')
      ON CONFLICT (id) DO NOTHING`;
  });
}

test("createPlannedSpecialistUnit 幂等:同 bundle+rv → 同 id", async () => {
  await seed();
  const input = {
    planVersion: 1,
    bundleId: "b1",
    specialist: "text_extractor" as const,
    extractionFocus: "机器学习",
    relatedBundleIds: [] as string[],
    waveNo: 0,
    bundleOrdinal: 0,
    replanVersion: 1,
  };
  const first = await createPlannedSpecialistUnit(job, payload, PLAN_UNIT_ID, input);
  const second = await createPlannedSpecialistUnit(job, payload, PLAN_UNIT_ID, input);
  assert.equal(first, second, "幂等:同 unitKey 复用");
  const [row] = await admin`SELECT kind, ordinal, status FROM card_generation_units WHERE id = ${first}`;
  assert.equal(row.kind, "planned_specialist");
  assert.equal(row.ordinal, 30, "wave0/idx0 → ordinal 30");
});

test("specialist 完成后重复调用 → status 恢复 pending(重跑)", async () => {
  await seed();
  const input = {
    planVersion: 1,
    bundleId: "b2",
    specialist: "code_extractor" as const,
    extractionFocus: "代码",
    relatedBundleIds: [] as string[],
    waveNo: 0,
    bundleOrdinal: 1,
    replanVersion: 1,
  };
  const unitId = await createPlannedSpecialistUnit(job, payload, PLAN_UNIT_ID, input);
  await admin`UPDATE card_generation_units SET status = 'succeeded', finished_at = now() WHERE id = ${unitId}`;
  const again = await createPlannedSpecialistUnit(job, payload, PLAN_UNIT_ID, input);
  assert.equal(again, unitId, "同 unitKey 复用");
  const [row] = await admin`SELECT status FROM card_generation_units WHERE id = ${unitId}`;
  assert.equal(row.status, "pending", "非 pending 状态重置为 pending");
});

test("多 wave ordinal 不撞 identityUnique(wave1 idx99 → 30+100+99)", async () => {
  await seed();
  const input = {
    planVersion: 1,
    bundleId: "b3",
    specialist: "vision_specialist" as const,
    extractionFocus: "图片",
    relatedBundleIds: [] as string[],
    waveNo: 1,
    bundleOrdinal: 99,
    replanVersion: 1,
  };
  const unitId = await createPlannedSpecialistUnit(job, payload, PLAN_UNIT_ID, input);
  const [row] = await admin`SELECT ordinal FROM card_generation_units WHERE id = ${unitId}`;
  assert.equal(row.ordinal, 229, "30+1*100+99=229(不与 wave0 的 30-130 撞)");
});

test("createPlannedComposeUnit 幂等", async () => {
  await seed();
  const first = await createPlannedComposeUnit(job, payload);
  const second = await createPlannedComposeUnit(job, payload);
  assert.equal(first, second, "compose unit 幂等");
  const [row] = await admin`SELECT kind, ordinal FROM card_generation_units WHERE id = ${first}`;
  assert.equal(row.kind, "planned_compose");
  assert.equal(row.ordinal, 200);
});
