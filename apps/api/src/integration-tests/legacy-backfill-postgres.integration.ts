/**
 * E17 backfill 集成测试（真实 postgres，文档 16 §16.3）。
 *
 * 覆盖：旧 Session 多 Episode 拆 Run（active/completed/stale/cancelled 语义）
 * → backfill 幂等（重跑不重复）→ 对账报告（迁移/跳过计数）→ 孤儿引用计数。
 *
 * 运行：DATABASE_URL_API="postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/legacy-backfill-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const {
  backfillLegacySessionsToRuns,
  verifyLegacyRunReconciliation,
  projectEpisodeToRun,
} = await import("../modules/learning-runs/legacy-backfill.ts");

after(async () => {
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

test("E17：旧多 Episode Session 拆 Run（语义正确）+ 幂等 + 对账", async () => {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const keyPointId = randomUUID();
  const cardId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`e17-it-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, 'e17-ws', ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    const noteId = randomUUID();
    const noteVersionId = randomUUID();
    await tx`INSERT INTO notes (id, workspace_id, title, created_by, created_at, updated_at, title_source, card_generation_epoch)
             VALUES (${noteId}, ${workspaceId}, 'note', ${userId}, now(), now(), 'placeholder', 0)`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, created_by, created_at, content_hash, updated_at)
             VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1, '{}', ${userId}, now(), 'nh-1', now())`;
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json, created_at, updated_at)
             VALUES (${cardId}, ${noteVersionId}, ${workspaceId}, 'active', '{"version":1}', now(), now())`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text)
             VALUES (${keyPointId}, ${cardId}, ${workspaceId}, 1, '遗忘曲线', '间隔重复。')`;
  });
  const sessionId = randomUUID();
  const activeEpisodeId = randomUUID();
  const completedEpisodeId = randomUUID();
  const staleEpisodeId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO learning_sessions (id, workspace_id, user_id, origin, origin_ref, intent, status)
             VALUES (${sessionId}, ${workspaceId}, ${userId}, 'card', ${JSON.stringify({ type: "card", id: cardId })}, 'stabilize', 'active')`;
    await tx`INSERT INTO learning_episodes (
               id, session_id, workspace_id, user_id, key_point_id, origin, origin_ref, intent,
               formal_eligibility_kind, formal_plan, scheduling_decision,
               episode_target_fingerprint, content_exposure_key, rubric_targets, allowed_modalities,
               max_turns, assistance_policy_version, rubric_policy_version, scene_policy_version,
               assessment_policy_version, mastery_policy_version, scheduler_policy_version,
               provider_policy_version, commit_policy_version, provider_config_id, model_id,
               required_capability_ids, capability_snapshot_hash, runtime_epoch_snapshot,
               episode_epoch, budget_envelope_ref, budget_envelope_hash, plan_hash,
               processing_phase, status
             ) VALUES (
               ${activeEpisodeId}, ${sessionId}, ${workspaceId}, ${userId}, ${keyPointId}, 'card',
               ${JSON.stringify({ type: "card", id: cardId })}, 'stabilize',
               'practice', ${JSON.stringify({ kind: "practice", requiredProbeIds: [] })},
               ${JSON.stringify({ decisionRef: "d1", decisionHash: "h1", authorizedAction: "no_effect", prioritySource: "user_selected", policyVersion: "v1", policyEpoch: 1, reasonCodes: [] })},
               'fp1', 'ck1', '[]', '{}', 1, 'apv', 'rpv', 'spv', 'aspv', 'mpv', 'scpv',
               'ppv', 'cpv', 'pc', 'm1', '{}', 'ch1', 1, 1, 'br1', 'bh1', 'ph1',
               'awaiting_response', 'active'
             )`;
    await tx`INSERT INTO learning_episodes (
               id, session_id, workspace_id, user_id, key_point_id, origin, origin_ref, intent,
               formal_eligibility_kind, formal_plan, scheduling_decision,
               episode_target_fingerprint, content_exposure_key, rubric_targets, allowed_modalities,
               max_turns, assistance_policy_version, rubric_policy_version, scene_policy_version,
               assessment_policy_version, mastery_policy_version, scheduler_policy_version,
               provider_policy_version, commit_policy_version, provider_config_id, model_id,
               required_capability_ids, capability_snapshot_hash, runtime_epoch_snapshot,
               episode_epoch, budget_envelope_ref, budget_envelope_hash, plan_hash,
               processing_phase, status
             ) VALUES (
               ${completedEpisodeId}, ${sessionId}, ${workspaceId}, ${userId}, ${keyPointId}, 'card',
               ${JSON.stringify({ type: "card", id: cardId })}, 'stabilize',
               'practice', ${JSON.stringify({ kind: "practice", requiredProbeIds: [] })},
               ${JSON.stringify({ decisionRef: "d2", decisionHash: "h2", authorizedAction: "no_effect", prioritySource: "user_selected", policyVersion: "v1", policyEpoch: 1, reasonCodes: [] })},
               'fp2', 'ck2', '[]', '{}', 1, 'apv', 'rpv', 'spv', 'aspv', 'mpv', 'scpv',
               'ppv', 'cpv', 'pc', 'm1', '{}', 'ch2', 1, 1, 'br2', 'bh2', 'ph2',
               'committed', 'completed'
             )`;
    await tx`INSERT INTO learning_episodes (
               id, session_id, workspace_id, user_id, key_point_id, origin, origin_ref, intent,
               formal_eligibility_kind, formal_plan, scheduling_decision,
               episode_target_fingerprint, content_exposure_key, rubric_targets, allowed_modalities,
               max_turns, assistance_policy_version, rubric_policy_version, scene_policy_version,
               assessment_policy_version, mastery_policy_version, scheduler_policy_version,
               provider_policy_version, commit_policy_version, provider_config_id, model_id,
               required_capability_ids, capability_snapshot_hash, runtime_epoch_snapshot,
               episode_epoch, budget_envelope_ref, budget_envelope_hash, plan_hash,
               processing_phase, status
             ) VALUES (
               ${staleEpisodeId}, ${sessionId}, ${workspaceId}, ${userId}, ${keyPointId}, 'card',
               ${JSON.stringify({ type: "card", id: cardId })}, 'stabilize',
               'practice', ${JSON.stringify({ kind: "practice", requiredProbeIds: [] })},
               ${JSON.stringify({ decisionRef: "d3", decisionHash: "h3", authorizedAction: "no_effect", prioritySource: "user_selected", policyVersion: "v1", policyEpoch: 1, reasonCodes: [] })},
               'fp3', 'ck3', '[]', '{}', 1, 'apv', 'rpv', 'spv', 'aspv', 'mpv', 'scpv',
               'ppv', 'cpv', 'pc', 'm1', '{}', 'ch3', 1, 1, 'br3', 'bh3', 'ph3',
               'stale', 'stale'
             )`;
  });

  try {
    const scope = { workspaceId, userId };
    const report = await withWorkspaceTransaction(scope, (tx) =>
      backfillLegacySessionsToRuns(tx, workspaceId),
    );
    assert.equal(report.migrated, 3, "三个 Episode 拆成三个 Run");
    assert.equal(report.orphanEpisodes, 0);

    // 语义：active → active；completed → completed；stale → stale；
    // 同 session ordinal 递增（历史页还原旧顺序）。
    const runs = await sql`
      SELECT phase, legacy_episode_id, legacy_ordinal FROM learning_runs WHERE workspace_id = ${workspaceId}
    `;
    const byLegacy = new Map(runs.map((r) => [r.legacy_episode_id, r]));
    assert.equal(byLegacy.get(activeEpisodeId)?.phase, "active");
    assert.equal(byLegacy.get(completedEpisodeId)?.phase, "completed");
    assert.equal(byLegacy.get(staleEpisodeId)?.phase, "stale");
    const ordinals = runs.map((r) => r.legacy_ordinal).sort((a, b) => a - b);
    assert.deepEqual(ordinals, [1, 2, 3], "同 session ordinal 递增编号");

    // 幂等：重跑不新增。
    const again = await withWorkspaceTransaction(scope, (tx) =>
      backfillLegacySessionsToRuns(tx, workspaceId),
    );
    assert.equal(again.migrated, 0);
    assert.equal(again.skippedExisting, 3);
    const runCount = await sql`SELECT count(*)::int AS n FROM learning_runs WHERE workspace_id = ${workspaceId}`;
    assert.equal(runCount[0].n, 3, "backfill 幂等");

    // 对账。
    const reconciliation = await withWorkspaceTransaction(scope, (tx) =>
      verifyLegacyRunReconciliation(tx, workspaceId),
    );
    assert.equal(reconciliation.migratedRuns, 3);
  } finally {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM learning_runs WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_episodes WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_sessions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM card_key_points WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_cards WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  }
});

test("E17 纯函数：projectEpisodeToRun 语义投影", () => {
  const base = {
    id: "e1", sessionId: "s1", workspaceId: "w", userId: "u", keyPointId: "k",
    origin: "card", originRef: {}, intent: "stabilize", createdAt: new Date(),
  };
  assert.deepEqual(
    projectEpisodeToRun({ ...base, status: "active", processingPhase: "awaiting_response" }),
    { phase: "active", result: null, terminalReasonCode: null },
  );
  assert.deepEqual(
    projectEpisodeToRun({ ...base, status: "completed", processingPhase: "assessment_complete" }),
    { phase: "completed", result: null, terminalReasonCode: null },
  );
  assert.deepEqual(
    projectEpisodeToRun({ ...base, status: "stale", processingPhase: "stale" }),
    { phase: "stale", result: null, terminalReasonCode: "target_fingerprint_changed" },
  );
  assert.equal(
    projectEpisodeToRun({ ...base, status: "draft", processingPhase: "preparing" }),
    null,
    "draft 不可解释 → 跳过",
  );
});
