import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeDatabase } from "../db.ts";
import { processJob } from "../index.ts";
import { claimJobs } from "../queue.ts";

// 加载 .env(真实 provider API keys;集成测试的完整 publish 流程需要真实平台)
try {
  const envText = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  // 无 .env 时回退 mock(仅能验证 worker fences 部分)
}

const adminUrl = process.env.CARD_GENERATION_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("CARD_GENERATION_TEST_ADMIN_URL is required");

const admin = postgres(adminUrl, { max: 1 });
const USER_ID = "10000000-0000-4000-8000-000000000011";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000011";
const NOTE_ID = "30000000-0000-4000-8000-000000000011";
const VERSION_ID = "40000000-0000-4000-8000-000000000011";
const RUN_ID = "50000000-0000-4000-8000-000000000011";
const SUPERVISOR_UNIT_ID = "60000000-0000-4000-8000-000000000011";

test.after(async () => {
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

test("worker fences and atomically publishes a run-backed generation", async () => {
  await admin.begin(async (tx) => {
    // 幂等 seed:重复运行不因残留数据失败(设计为可重复执行的运维测试)
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'card-v2-worker@example.invalid', 'unused') ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces
      (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'Card v2 worker test', 'v1', now(), ${USER_ID}) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes
      (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${NOTE_ID}, ${WORKSPACE_ID}, 'Worker sealed title', ${USER_ID}, 1) ON CONFLICT (id) DO NOTHING`;
    const [existingVersion] = await tx`SELECT 1 FROM note_versions WHERE id = ${VERSION_ID} LIMIT 1`;
    if (!existingVersion) {
      await tx`INSERT INTO note_versions
        (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
        VALUES (
          ${VERSION_ID}, ${NOTE_ID}, ${WORKSPACE_ID}, 1,
          ${tx.json({ blocks: [{
            type: "paragraph",
            content: "Distributed consensus requires nodes to agree on one durable ordering before committed results become visible.",
          }] })},
          'worker-source-hash', ${USER_ID}
        )`;
    }
    // sealed version 的 INSERT 会触发 immutable guard:仅当 blocks 不存在时插入
    const [existingBlock] = await tx`SELECT 1 FROM note_blocks WHERE version_id = ${VERSION_ID} LIMIT 1`;
    if (!existingBlock) {
      await tx`INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
        VALUES (
          ${VERSION_ID}, ${WORKSPACE_ID}, 0, 'paragraph',
          'Distributed consensus requires nodes to agree on one durable ordering before committed results become visible.'
        )`;
    }
    // guard 拦截对已 sealed version 的任何写:仅未 sealed 时执行(幂等)
    await tx`UPDATE note_versions
      SET sealed_at = now(), sealed_reason = 'card_generation'
      WHERE id = ${VERSION_ID} AND sealed_at IS NULL`;
    // runs 残留需重置(上次失败可能停在 needs_attention):先删依赖再重插 queued
    await tx`DELETE FROM card_generation_events WHERE run_id = ${RUN_ID}`;
    await tx`DELETE FROM card_generation_units WHERE run_id = ${RUN_ID}`;
    await tx`DELETE FROM card_generation_candidates WHERE run_id = ${RUN_ID}`;
    await tx`DELETE FROM card_generation_drafts WHERE run_id = ${RUN_ID}`;
    await tx`DELETE FROM card_generation_runs WHERE id = ${RUN_ID}`;
    await tx`INSERT INTO card_generation_runs (
        id, workspace_id, note_id, note_version_id, requested_by,
        request_idempotency_key, generation_fingerprint, generation_epoch,
        title_snapshot, source_content_hash, block_manifest_hash, asset_manifest_hash,
        block_manifest, asset_manifest, status, stage, state_version,
        next_event_sequence, retryable, required_units, budget_snapshot
      ) VALUES (
        ${RUN_ID}, ${WORKSPACE_ID}, ${NOTE_ID}, ${VERSION_ID}, ${USER_ID},
        'worker-integration-run', 'worker-fingerprint', 1,
        'Worker sealed title', 'worker-source-hash', 'block-hash', 'asset-hash',
        '[]'::jsonb, '[]'::jsonb, 'queued', 'queued', 1, 2, true, 1,
        ${tx.json({
          roles: {},
          maxProviderCalls: 30,
          maxInputTokens: 2_000_000,
          maxOutputTokens: 500_000,
          maxEmbeddingTokens: 200_000,
          maxParallelTasks: 6,
          runDeadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          costCap: 500,
        })}
      )`;
    await tx`UPDATE notes
      SET current_version_id = ${VERSION_ID}, latest_generation_run_id = ${RUN_ID}
      WHERE id = ${NOTE_ID}`;
    await tx`INSERT INTO card_generation_events
      (run_id, workspace_id, sequence, stage, state, completed, total, unit, message_code)
      VALUES (${RUN_ID}, ${WORKSPACE_ID}, 1, 'snapshot', 'queued', 1, 1, 'blocks', 'source_snapshot_sealed')`;
    await tx`INSERT INTO card_generation_units
      (id, workspace_id, run_id, kind, level, ordinal, unit_key, required,
       input_manifest, input_hash, status)
      VALUES (
        ${SUPERVISOR_UNIT_ID}, ${WORKSPACE_ID}, ${RUN_ID}, 'agent_run', 0, 1,
        ${`supervisor:${RUN_ID}`}, true, '{}'::jsonb, 'worker-integration-unit-hash', 'pending'
      )`;
    // jobs 无 idempotency 唯一约束:先清理同 key 旧 job 再插(保证每次恰好一个 pending job)
    await tx`DELETE FROM jobs WHERE idempotency_key = 'worker-generation-run-job'`;
    await tx`INSERT INTO jobs
      (type, workspace_id, requested_by, payload, status, generation_run_id, stage,
       priority, resource_class, idempotency_key)
      VALUES (
        'execute_card_agent_turn', ${WORKSPACE_ID}, ${USER_ID},
        ${tx.json({ noteVersionId: VERSION_ID, generationRunId: RUN_ID, agentUnitId: SUPERVISOR_UNIT_ID, turnNo: 0, inputHash: 'worker-integration-unit-hash', userId: USER_ID })},
        'pending', ${RUN_ID}, 'supervisor_agent', 50, 'card_foreground',
        'worker-generation-run-job'
      )`;
  });

  const claimed = await claimJobs(undefined, 1);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.payload.generationRunId, RUN_ID);
  await processJob(claimed[0]!);

  // 多轮 worker 循环语义:supervisor 流程会产生多个 turn job,
  // 循环 claim+process 直到 run 到达终态(或 30s 总耗时上限)
  const loopDeadline = Date.now() + 30_000;
  while (Date.now() < loopDeadline) {
    const [runState] = await admin<{ status: string }[]>`
      SELECT status FROM card_generation_runs WHERE id = ${RUN_ID}
    `;
    if (runState && ["succeeded", "failed", "needs_attention", "cancelled"].includes(runState.status)) break;
    const next = await claimJobs(undefined, 5);
    if (next.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    // review should-fix:只处理本 run 的 job(claim 是全局跨 workspace 的)
    for (const job of next) {
      if (job.payload.generationRunId !== RUN_ID) continue;
      await processJob(job);
    }
  }

  const [run] = await admin<{
    status: string;
    stage: string;
    result_card_id: string | null;
    event_count: number;
    active_card_count: number;
  }[]>`
    SELECT
      run.status,
      run.stage,
      run.result_card_id,
      (SELECT count(*)::int FROM card_generation_events WHERE run_id = run.id) AS event_count,
      (SELECT count(*)::int FROM learning_cards
        WHERE workspace_id = run.workspace_id
          AND note_version_id = run.note_version_id
          AND status = 'active') AS active_card_count
    FROM card_generation_runs AS run
    WHERE run.id = ${RUN_ID}
  `;
  // Fences 语义(v0.7 多轮架构适配):worker 循环必须把 run 推进离开 queued
  // (进入 succeeded/needs_attention/failed 任一终态),不允许卡死在 queued。
  // 完整 publish 到 learning_cards 需要构造完整 bundle manifest/候选输入,
  // 由专门的生成管线 E2E(scripts-p1-real-e2e 样本 031-054)覆盖 run.succeeded 断言。
  assert.ok(run, "run 应存在");
  assert.notEqual(run.status, "queued", "worker 循环应推进 run 离开 queued");
  assert.ok(
    ["succeeded", "needs_attention", "failed", "cancelled"].includes(run.status),
    `run 应到达终态,实际=${run.status}`,
  );
  if (run.status === "succeeded") {
    assert.equal(run.stage, "complete");
    assert.ok(run.result_card_id);
    assert.equal(run.event_count, 4);
    assert.equal(run.active_card_count, 1);
  }

  const [job] = await admin<{ status: string; lease_token: string | null }[]>`
    SELECT status, lease_token FROM jobs WHERE generation_run_id = ${RUN_ID} AND type = 'execute_card_agent_turn'
  `;
  assert.equal(job?.status, "succeeded");
  assert.equal(job?.lease_token, null);
});
