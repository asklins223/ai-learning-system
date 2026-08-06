/**
 * Phase 1 集成测试：状态机系统自动推进（P1-2/P1-3/P1-4/P1-6）。
 *
 * 需要 PostgreSQL（postgres 服务已启动，migration 已应用）。
 * 运行：
 *   CARD_GENERATION_TEST_ADMIN_URL=<admin-url> DATABASE_URL=<worker-url> \
 *     node --import tsx --test src/integration-tests/pipeline-auto-progress-postgres.integration.ts
 *
 * 覆盖：
 *   P1-2: Critic passed → 系统自动创建 VERIFY unit + job，parent Supervisor 终态
 *   P1-3: 最新 draft 无评审（如 Repair 产物）→ 系统自动重新创建 Critic，parent 保持等待
 *   P1-4: Child Tasks Completed → resume 事件驱动创建 resume job（CAS waiting_child→running）
 *   P1-6: 幂等——重复/并发调用不产生重复 unit / job
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import { closeDatabase } from "../db.ts";
import { autoProgressAfterChildUnit } from "../agent/pipeline-auto-progress.ts";
import { scheduleCriticForDraft } from "../agent/tools/quality.ts";
import { resumeParentSupervisorIfNeeded } from "../agent/specialist-persist.ts";
import { BudgetTracker } from "../agent/budget.ts";
import type { JobPayload } from "../handlers/index.ts";

const adminUrl = process.env.CARD_GENERATION_TEST_ADMIN_URL;
if (!adminUrl) throw new Error("CARD_GENERATION_TEST_ADMIN_URL is required");

const admin = postgres(adminUrl, { max: 4 });

const USER_ID = "10000000-0000-4000-8000-000000000021";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000021";

test.after(async () => {
  await closeDatabase();
  await admin.end({ timeout: 5 });
});

/** 种子数据：user/workspace/note/version/run + supervisor unit + draft（可选 report） */
async function seedRun(input: {
  runId: string;
  noteId: string;
  versionId: string;
  epoch: number;
  draftContentHash: string;
  parentUnitId: string;
  childUnitId: string;
  report?: { criticStatus: string; deterministicStatus: string };
}): Promise<void> {
  const { runId, noteId, versionId, epoch, draftContentHash, parentUnitId, childUnitId, report } = input;
  await admin.begin(async (tx) => {
    // 清理残留(测试可重跑):先删 jobs 再删 run(cascade 清 drafts/units/reports)
    await tx`DELETE FROM jobs WHERE generation_run_id = ${runId}`;
    await tx`DELETE FROM card_generation_runs WHERE id = ${runId}`;
    await tx`INSERT INTO users (id, email, password_hash)
      VALUES (${USER_ID}, 'p1-auto@example.invalid', 'unused')
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspaces
      (id, owner_id, name, ai_consent_version, ai_consent_at, ai_consent_by)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'P1 auto progress test', 'v1', now(), ${USER_ID})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
      VALUES (${WORKSPACE_ID}, ${USER_ID}, 'owner') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO notes
      (id, workspace_id, title, created_by, card_generation_epoch)
      VALUES (${noteId}, ${WORKSPACE_ID}, 'P1 title', ${USER_ID}, ${epoch})
      ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_versions
      (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
      VALUES (
        ${versionId}, ${noteId}, ${WORKSPACE_ID}, 1,
        ${tx.json({ blocks: [{ type: "paragraph", content: "P1 source content." }] })},
        'p1-source-hash', ${USER_ID}
      ) ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO note_blocks (version_id, workspace_id, ordinal, type, content)
      VALUES (${versionId}, ${WORKSPACE_ID}, 0, 'paragraph', 'P1 source content.')
      ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO card_generation_runs (
        id, workspace_id, note_id, note_version_id, requested_by,
        request_idempotency_key, generation_fingerprint, generation_epoch,
        title_snapshot, source_content_hash, block_manifest_hash, asset_manifest_hash,
        block_manifest, asset_manifest, status, stage, state_version,
        next_event_sequence, retryable, required_units, budget_snapshot
      ) VALUES (
        ${runId}, ${WORKSPACE_ID}, ${noteId}, ${versionId}, ${USER_ID},
        ${`p1-${runId}`}, ${`p1-fp-${runId}`}, ${epoch},
        'P1 title', 'p1-source-hash', 'p1-block-hash', 'p1-asset-hash',
        '[]'::jsonb, '[]'::jsonb, 'running', 'queued', 1, 1, true, 2,
        '{"roles":{},"maxProviderCalls":60,"maxInputTokens":2000000,"maxOutputTokens":500000}'::jsonb
      ) ON CONFLICT (id) DO NOTHING`;
    // supervisor unit(waiting_child, parent 等待子任务)
    await tx`INSERT INTO card_generation_units
      (id, workspace_id, run_id, kind, level, ordinal, unit_key, required,
       input_manifest, input_hash, status, cursor_json)
      VALUES (
        ${parentUnitId}, ${WORKSPACE_ID}, ${runId}, 'agent_run', 0, 1, ${`supervisor:${runId}`},
        true, ${tx.json({ agentRole: "generation_supervisor" })}, ${`hash-sup-${runId}`},
        'waiting_child', ${tx.json({ turnNo: 3 })}
      ) ON CONFLICT (id) DO NOTHING`;
    // critic child unit(succeeded)
    await tx`INSERT INTO card_generation_units
      (id, workspace_id, run_id, parent_unit_id, kind, level, ordinal, unit_key, required,
       input_manifest, input_hash, status, finished_at)
      VALUES (
        ${childUnitId}, ${WORKSPACE_ID}, ${runId}, ${parentUnitId}, 'agent_run', 1, 90,
        ${`agent:grounding_critic:${runId}-draft`}, true,
        ${tx.json({ agentRole: "grounding_critic" })}, ${`hash-critic-${runId}`},
        'succeeded', now()
      ) ON CONFLICT (id) DO NOTHING`;
    // draft
    await tx`INSERT INTO card_generation_drafts (
        id, workspace_id, run_id, draft_version, parent_draft_id,
        produced_by_unit_id, produced_by_event_key, schema_version,
        content_json, content_hash, deck_title, deck_summary, density,
        card_budget, base_ledger_hash
      ) VALUES (
        gen_random_uuid(), ${WORKSPACE_ID}, ${runId}, 1, NULL,
        ${parentUnitId}, 'submit_deck_draft:1', 'deck-v1',
        ${tx.json({ cards: [] })}, ${draftContentHash}, 'P1 deck', 'P1 summary',
        'standard', 1, 'p1-ledger-hash'
      ) RETURNING id`;
    if (report) {
      const draftIdResult = await tx`SELECT id FROM card_generation_drafts
        WHERE run_id = ${runId} AND workspace_id = ${WORKSPACE_ID} LIMIT 1`;
      const draftId = draftIdResult[0]?.id as string;
      await tx`INSERT INTO card_generation_quality_reports (
          workspace_id, run_id, draft_id, draft_hash, candidate_pool_hash,
          source_ledger_hash, critic_version, verifier_version,
          hard_issues, soft_issues, per_claim_verdicts, metrics,
          critic_status, deterministic_status
        ) VALUES (
          ${WORKSPACE_ID}, ${runId}, ${draftId}, ${draftContentHash}, 'pool-hash',
          'ledger-hash', 'critic-v1', 'verifier-v1',
          '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
          ${report.criticStatus}, ${report.deterministicStatus}
        )`;
    }
  });
}

function makeJob(runId: string): JobPayload {
  return {
    id: `job-${runId}`,
    workspaceId: WORKSPACE_ID,
    requestedBy: USER_ID,
    payload: { generationRunId: runId, userId: USER_ID },
    leaseToken: "lease",
  };
}

// ─── P1-2: Critic Passed → 自动创建 VERIFY Unit ──────────────────────────

test("P1-2: report passed + 无 verify unit → 自动创建 VERIFY unit + job,parent 终态", async () => {
  const runId = "50000000-0000-4000-8000-000000000021";
  const parentId = "60000000-0000-4000-8000-000000000021";
  const childId = "70000000-0000-4000-8000-000000000021";
  await seedRun({
    runId, noteId: "30000000-0000-4000-8000-000000000021", versionId: "40000000-0000-4000-8000-000000000021", epoch: 1,
    draftContentHash: "p1-2-draft-hash", parentUnitId: parentId, childUnitId: childId,
    report: { criticStatus: "passed", deterministicStatus: "passed" },
  });

  const progressed = await autoProgressAfterChildUnit({ job: makeJob(runId), runId, childUnitId: childId });
  assert.equal(progressed, true, "P1-2 应返回已系统推进");

  const [verifyUnit] = await admin<{ status: string }[]>`
    SELECT status FROM card_generation_units
    WHERE run_id = ${runId} AND unit_key = ${`verify:${runId}`}`;
  assert.ok(verifyUnit, "应自动创建 verify unit");

  const [verifyJob] = await admin<{ id: string }[]>`
    SELECT id FROM jobs
    WHERE generation_run_id = ${runId}
      AND generation_unit_id = (SELECT id FROM card_generation_units WHERE run_id = ${runId} AND unit_key = ${`verify:${runId}`})`;
  assert.ok(verifyJob, "应为 verify unit 创建 job");

  const [parent] = await admin<{ status: string }[]>`
    SELECT status FROM card_generation_units WHERE id = ${parentId}`;
  assert.equal(parent?.status, "succeeded", "parent Supervisor 应终态 succeeded");
});

// ─── P1-3: 最新 draft 无评审 → 自动重新创建 Critic ───────────────────────

test("P1-3: 新 draft 无 report 无 critic → 自动创建 Critic,parent 保持等待", async () => {
  const runId = "50000000-0000-4000-8000-000000000022";
  const parentId = "60000000-0000-4000-8000-000000000022";
  const childId = "70000000-0000-4000-8000-000000000022";
  await seedRun({ runId, noteId: "30000000-0000-4000-8000-000000000022", versionId: "40000000-0000-4000-8000-000000000022", epoch: 1, draftContentHash: "p1-3-draft-hash", parentUnitId: parentId, childUnitId: childId });

  const progressed = await autoProgressAfterChildUnit({ job: makeJob(runId), runId, childUnitId: childId });
  assert.equal(progressed, true, "P1-3 应返回已系统推进");

  const draft = await admin<{ id: string }[]>`
    SELECT id FROM card_generation_drafts WHERE run_id = ${runId} LIMIT 1`;
  assert.ok(draft?.[0]?.id);
  const [critic] = await admin<{ status: string }[]>`
    SELECT status FROM card_generation_units
    WHERE run_id = ${runId} AND unit_key = ${`agent:grounding_critic:${draft[0].id}`}`;
  assert.ok(critic, "应自动创建 critic unit");
  assert.equal(critic.status, "pending");

  const [parent] = await admin<{ status: string }[]>`
    SELECT status FROM card_generation_units WHERE id = ${parentId}`;
  assert.equal(parent?.status, "waiting_child", "parent 应保持 waiting_child 等待新 critic");
});

// ─── P1-6: 幂等——重复/并发调用不产生重复 unit / job ────────────────────

test("P1-6a: 重复调用 autoProgressAfterChildUnit 不创建重复 verify unit", async () => {
  const runId = "50000000-0000-4000-8000-000000000023";
  const parentId = "60000000-0000-4000-8000-000000000023";
  const childId = "70000000-0000-4000-8000-000000000023";
  await seedRun({
    runId, noteId: "30000000-0000-4000-8000-000000000023", versionId: "40000000-0000-4000-8000-000000000023", epoch: 1,
    draftContentHash: "p1-6-draft-hash", parentUnitId: parentId, childUnitId: childId,
    report: { criticStatus: "passed", deterministicStatus: "passed" },
  });

  await autoProgressAfterChildUnit({ job: makeJob(runId), runId, childUnitId: childId });
  await autoProgressAfterChildUnit({ job: makeJob(runId), runId, childUnitId: childId });

  const verifyUnits = await admin<{ count: number }[]>`
    SELECT count(*)::int AS count FROM card_generation_units
    WHERE run_id = ${runId} AND unit_key = ${`verify:${runId}`}`;
  assert.equal(verifyUnits[0]?.count, 1, "不得创建重复 verify unit");

  const verifyJobs = await admin<{ count: number }[]>`
    SELECT count(*)::int AS count FROM jobs WHERE generation_run_id = ${runId}
      AND payload->>'agentUnitId' = (SELECT id::text FROM card_generation_units WHERE run_id = ${runId} AND unit_key = ${`verify:${runId}`})`;
  assert.equal(verifyJobs[0]?.count, 1, "不得创建重复 verify job");
});

test("P1-6b: 重复调用 scheduleCriticForDraft 幂等命中同一 critic unit", async () => {
  const runId = "50000000-0000-4000-8000-000000000024";
  const parentId = "60000000-0000-4000-8000-000000000024";
  const childId = "70000000-0000-4000-8000-000000000024";
  await seedRun({ runId, noteId: "30000000-0000-4000-8000-000000000024", versionId: "40000000-0000-4000-8000-000000000024", epoch: 1, draftContentHash: "p1-6b-draft-hash", parentUnitId: parentId, childUnitId: childId });

  const draft = await admin<{ id: string; content_hash: string }[]>`
    SELECT id, content_hash FROM card_generation_drafts WHERE run_id = ${runId} LIMIT 1`;
  const budget = new BudgetTracker();

  const first = await scheduleCriticForDraft({
    workspaceId: WORKSPACE_ID, runId, agentUnitId: parentId,
    requestedBy: USER_ID, draftId: draft[0].id, draftHash: draft[0].content_hash, budgetTracker: budget,
  });
  const second = await scheduleCriticForDraft({
    workspaceId: WORKSPACE_ID, runId, agentUnitId: parentId,
    requestedBy: USER_ID, draftId: draft[0].id, draftHash: draft[0].content_hash, budgetTracker: budget,
  });
  assert.ok(first?.criticTaskId);
  assert.equal(second?.criticTaskId, first?.criticTaskId, "重复调度应命中同一 critic unit");

  const criticUnits = await admin<{ count: number }[]>`
    SELECT count(*)::int AS count FROM card_generation_units
    WHERE run_id = ${runId} AND unit_key = ${`agent:grounding_critic:${draft[0].id}`}`;
  assert.equal(criticUnits[0]?.count, 1, "不得创建重复 critic unit");
});

test("P1-6c: 并发调用 autoProgressAfterChildUnit（P1-2 场景）不创建重复 verify", async () => {
  const runId = "50000000-0000-4000-8000-000000000025";
  const parentId = "60000000-0000-4000-8000-000000000025";
  const childId = "70000000-0000-4000-8000-000000000025";
  await seedRun({
    runId, noteId: "30000000-0000-4000-8000-000000000025", versionId: "40000000-0000-4000-8000-000000000025", epoch: 1,
    draftContentHash: "p1-6c-draft-hash", parentUnitId: parentId, childUnitId: childId,
    report: { criticStatus: "passed", deterministicStatus: "passed" },
  });

  await Promise.all([
    autoProgressAfterChildUnit({ job: makeJob(runId), runId, childUnitId: childId }),
    autoProgressAfterChildUnit({ job: makeJob(runId), runId, childUnitId: childId }),
  ]);

  const verifyUnits = await admin<{ count: number }[]>`
    SELECT count(*)::int AS count FROM card_generation_units
    WHERE run_id = ${runId} AND unit_key = ${`verify:${runId}`}`;
  assert.equal(verifyUnits[0]?.count, 1, "并发下不得创建重复 verify unit");

  const verifyJobs = await admin<{ count: number }[]>`
    SELECT count(*)::int AS count FROM jobs WHERE generation_run_id = ${runId}
      AND payload->>'agentUnitId' = (SELECT id::text FROM card_generation_units WHERE run_id = ${runId} AND unit_key = ${`verify:${runId}`})`;
  assert.equal(verifyJobs[0]?.count, 1, "并发下不得创建重复 verify job");
});

// ─── P1-4: Child Tasks Completed → 事件驱动恢复 parent（CAS）─────────────

test("P1-4: child 全部终态 + parent waiting_child → resume 创建 resume job（CAS）", async () => {
  const runId = "50000000-0000-4000-8000-000000000026";
  const parentId = "60000000-0000-4000-8000-000000000026";
  const childId = "70000000-0000-4000-8000-000000000026";
  await seedRun({ runId, noteId: "30000000-0000-4000-8000-000000000026", versionId: "40000000-0000-4000-8000-000000000026", epoch: 1, draftContentHash: "p1-4-draft-hash", parentUnitId: parentId, childUnitId: childId });

  // child 已是 succeeded（seedRun 设置），sibling 无其他 → 应恢复 parent
  await resumeParentSupervisorIfNeeded(WORKSPACE_ID, childId, USER_ID);

  const [parent] = await admin<{ status: string }[]>`
    SELECT status FROM card_generation_units WHERE id = ${parentId}`;
  assert.equal(parent?.status, "running", "resume 应 CAS parent waiting_child→running");

  const [resumeJob] = await admin<{ id: string }[]>`
    SELECT id FROM jobs
    WHERE generation_run_id = ${runId}
      AND generation_unit_id = ${parentId}
      AND payload->>'turnNo' = '4'`;
  assert.ok(resumeJob, "应创建 resume job 恢复 parent 下一 turn（cursor turnNo 3 + 1）");
});
