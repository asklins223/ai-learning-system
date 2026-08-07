/**
 * P4-3/P4-4: Tool 事件批量幂等写入集成测试(真实 postgres)。
 *
 * 运行:
 *   CARD_GENERATION_TEST_ADMIN_URL=<admin-url> DATABASE_URL=<worker-url> \
 *     node --import tsx --test src/integration-tests/tool-events-batch-postgres.integration.ts
 *
 * 覆盖:
 *   - 批量写入 N 行 → N 行落库(单条 INSERT 多行)
 *   - 重复批量(同事件键)→ 不重复(逐行 ON CONFLICT 幂等)
 *   - 组合唯一键 (workspace_id, run_id, event_key):不同 run 同 eventKey 可共存
 *   - 批量不破坏局部恢复:冲突行跳过、其余行照常写入
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { closeDatabase, withWorkerWorkspaceTransaction } from "../db.ts";
import { persistToolRequestEventsBatch, persistToolResultEventsBatch } from "../agent/tool-events-batch.ts";

const adminUrl = process.env.CARD_GENERATION_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("CARD_GENERATION_TEST_ADMIN_URL is required");
const admin = postgres(adminUrl, { max: 4 });

const USER_ID = "10000000-0000-4000-8000-000000000023";
const WS_ID = "20000000-0000-4000-8000-000000000023";
const RUN_ID = "50000000-0000-4000-8000-000000000092";

test.after(async () => {
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

async function seedRun(): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`DELETE FROM card_generation_agent_events WHERE run_id = ${RUN_ID}`;
    await tx`DELETE FROM card_generation_runs WHERE id = ${RUN_ID}`;
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'p4-events@example.invalid', 'unused') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces
      (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WS_ID}, ${USER_ID}, 'P4 events test', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO notes
      (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES ('30000000-0000-4000-8000-000000000092', ${WS_ID}, 'P4 events note', ${USER_ID}, 1)
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES ('40000000-0000-4000-8000-000000000092', '30000000-0000-4000-8000-000000000092',
        ${WS_ID}, 1, '{}', 'p4-version-hash', ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO card_generation_runs (
        id, workspace_id, note_id, note_version_id, requested_by,
        request_idempotency_key, generation_fingerprint, generation_epoch,
        title_snapshot, source_content_hash, block_manifest_hash, asset_manifest_hash,
        block_manifest, asset_manifest, status, stage, state_version,
        next_event_sequence, retryable, required_units
      ) VALUES (
        ${RUN_ID}, ${WS_ID},
        '30000000-0000-4000-8000-000000000092',
        '40000000-0000-4000-8000-000000000092', ${USER_ID},
        'p4-events-run', 'p4-fp', 1, 'P4 events', 'h', 'h', 'h',
        '[]'::jsonb, '[]'::jsonb, 'running', 'queued', 1, 1, true, 1
      ) ON CONFLICT (id) DO NOTHING`;
  });
}

function requestRow(i: number) {
  return {
    workspaceId: WS_ID,
    runId: RUN_ID,
    unitId: null,
    eventKey: `tool_request:key-${i}`,
    eventType: "tool_request" as const,
    agentRole: "generation_supervisor",
    turnNo: 1,
    toolName: "get_run_manifest",
    inputHash: `hash-${i}`,
    safePayload: { args: { page: i } },
  };
}

test("P4-4: 批量写入 3 行落库(单条 INSERT 多行)", async () => {
  await seedRun();
  const written = await withWorkerWorkspaceTransaction({ workspaceId: WS_ID, userId: USER_ID }, (tx) =>
    persistToolRequestEventsBatch(tx, [requestRow(1), requestRow(2), requestRow(3)]));
  assert.equal(written, 3);

  const rows = await admin`SELECT event_key FROM card_generation_agent_events WHERE run_id = ${RUN_ID} AND event_type = 'tool_request' ORDER BY event_key`;
  assert.equal(rows.length, 3);
});

test("P4-3: 重复批量幂等(逐行 ON CONFLICT,不重复)", async () => {
  await seedRun();
  await withWorkerWorkspaceTransaction({ workspaceId: WS_ID, userId: USER_ID }, (tx) =>
    persistToolRequestEventsBatch(tx, [requestRow(1), requestRow(2)]));
  // 重复写入(重跑/重启恢复)
  await withWorkerWorkspaceTransaction({ workspaceId: WS_ID, userId: USER_ID }, (tx) =>
    persistToolRequestEventsBatch(tx, [requestRow(1), requestRow(2), requestRow(3)]));

  const [count] = await admin<{ count: number }[]>`
    SELECT count(*)::int AS count FROM card_generation_agent_events
    WHERE run_id = ${RUN_ID} AND event_type = 'tool_request'`;
  assert.equal(count?.count, 3, "1/2 冲突跳过,3 新写入(批量不破坏局部恢复)");
});

test("P4-3: 组合唯一键 (workspace_id, run_id, event_key)", async () => {
  await seedRun();
  // 清理上次运行残留的 RUN2(093)(seedRun 只清 092)
  const RUN2_ID = "50000000-0000-4000-8000-000000000093";
  await admin`DELETE FROM card_generation_agent_events WHERE run_id = ${RUN2_ID}`;
  await admin`DELETE FROM card_generation_runs WHERE id = ${RUN2_ID}`;
  await withWorkerWorkspaceTransaction({ workspaceId: WS_ID, userId: USER_ID }, (tx) =>
    persistToolRequestEventsBatch(tx, [requestRow(1)]));
  // 不同 run 同 eventKey:直接 SQL 验证组合键允许共存(用 RUN2 插入同 event_key)
  await admin`INSERT INTO card_generation_runs (
      id, workspace_id, note_id, note_version_id, requested_by,
      request_idempotency_key, generation_fingerprint, generation_epoch,
      title_snapshot, source_content_hash, block_manifest_hash, asset_manifest_hash,
      block_manifest, asset_manifest, status, stage, state_version,
      next_event_sequence, retryable, required_units
    ) VALUES (
      ${RUN2_ID}, ${WS_ID},
      '30000000-0000-4000-8000-000000000092',
      '40000000-0000-4000-8000-000000000092', ${USER_ID},
      'p4-events-run2', 'p4-fp2', 2, 'P4 events', 'h', 'h', 'h',
      '[]'::jsonb, '[]'::jsonb, 'running', 'queued', 1, 1, true, 1
    ) ON CONFLICT (id) DO NOTHING`;
  await admin`INSERT INTO card_generation_agent_events
    (workspace_id, run_id, event_key, event_type, agent_role, turn_no, tool_name, safe_payload)
    VALUES (${WS_ID}, ${RUN2_ID}, 'tool_request:key-1',
      'tool_request', 'generation_supervisor', 1, 'get_run_manifest', '{}'::jsonb)`;
  const [count] = await admin<{ count: number }[]>`
    SELECT count(*)::int AS count FROM card_generation_agent_events WHERE event_key = 'tool_request:key-1'`;
  assert.equal(count?.count, 2, "组合唯一键:不同 run 同 eventKey 共存");
});

test("P4-3: tool_result 批量写入与幂等", async () => {
  await seedRun();
  const rows = [1, 2].map((i) => ({
    workspaceId: WS_ID,
    runId: RUN_ID,
    unitId: null,
    eventKey: `tool_result:key-${i}`,
    eventType: "tool_result" as const,
    agentRole: "generation_supervisor",
    turnNo: 1,
    toolName: "get_run_manifest",
    inputHash: `hash-${i}`,
    outputHash: `out-${i}`,
    safePayload: { success: true, result: { ok: true } },
    errorCode: null,
  }));
  await withWorkerWorkspaceTransaction({ workspaceId: WS_ID, userId: USER_ID }, (tx) =>
    persistToolResultEventsBatch(tx, rows));
  await withWorkerWorkspaceTransaction({ workspaceId: WS_ID, userId: USER_ID }, (tx) =>
    persistToolResultEventsBatch(tx, rows));

  const [count] = await admin<{ count: number }[]>`
    SELECT count(*)::int AS count FROM card_generation_agent_events
    WHERE run_id = ${RUN_ID} AND event_type = 'tool_result'`;
  assert.equal(count?.count, 2, "重复批量幂等,不重复");
});
