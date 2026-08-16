/**
 * P5 §9 固定测试：worker companion_action handler（慢动作真实状态）。
 * - start_session：创建 learning_session + 恰好一条 durable result 消息 +
 *   run succeeded + action.completed event；
 * - 非 accepted run：跳过（不执行、不重复 result）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
// The handler imports the worker DB module, which resolves DATABASE_URL (or
// DATABASE_URL_WORKER), while this fixture client historically used the
// separate DATABASE_URL_API name. Keep both clients on the same database in
// host-side runs; otherwise the handler silently falls back to the Docker-only
// hostname `postgres` and the test waits on DNS until the runner times out.
process.env.DATABASE_URL ??= CONN;
const sql = postgres(CONN, { max: 2 });

after(async () => {
  await sql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase();
});

const { runCompanionAction } = await import("../handlers/companion-action.ts");

async function seedRun(
  ws: string,
  uid: string,
  cid: string,
  payload: Record<string, unknown>,
  prepareLearning = true,
): Promise<{ runId: string; proposalId: string; cleanup: () => Promise<void> }> {
  const runId = randomUUID();
  const proposalId = randomUUID();
  const userMsg = randomUUID();
  const cardId = String(payload.cardId ?? randomUUID());
  const keyPointId = String(payload.keyPointId ?? randomUUID());
  const noteId = randomUUID();
  const noteVersionId = randomUUID();
  const blockId = randomUUID();
  const evidenceId = randomUUID();
  const generationRunId = randomUUID();
  const cardSetId = randomUUID();
  const sessionId = randomUUID();
  const episodeId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    if (prepareLearning) {
      await tx`INSERT INTO notes (id, workspace_id, title, created_by)
               VALUES (${noteId}, ${ws}, 'Worker fixture note', ${uid})`;
      await tx`INSERT INTO note_versions
               (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
               VALUES (${noteVersionId}, ${noteId}, ${ws}, 1, ${tx.json({ blocks: [] })}, 'fixture-note-hash', ${uid})`;
      await tx`UPDATE notes SET current_version_id = ${noteVersionId} WHERE id = ${noteId}`;
      await tx`INSERT INTO note_blocks (id, version_id, workspace_id, ordinal, type, content)
               VALUES (${blockId}, ${noteVersionId}, ${ws}, 0, 'paragraph', 'Worker fixture evidence')`;
      await tx`INSERT INTO card_generation_runs
               (id, workspace_id, note_id, note_version_id, request_idempotency_key,
                generation_fingerprint, generation_epoch, title_snapshot,
                source_content_hash, block_manifest_hash, asset_manifest_hash)
               VALUES (${generationRunId}, ${ws}, ${noteId}, ${noteVersionId}, ${`fixture-${generationRunId}`},
                       ${`fixture-fingerprint-${generationRunId}`}, 1, 'Worker fixture card',
                       'source', 'blocks', 'assets')`;
      await tx`INSERT INTO learning_card_sets
               (id, workspace_id, note_id, note_version_id, generation_run_id, status, title, summary)
               VALUES (${cardSetId}, ${ws}, ${noteId}, ${noteVersionId}, ${generationRunId},
                       'active', 'Worker fixture card set', 'Worker fixture')`;
      await tx`INSERT INTO learning_cards
               (id, note_version_id, workspace_id, card_set_id, generation_run_id,
                scope, scope_key, ordinal, status, schema_json)
               VALUES (${cardId}, ${noteVersionId}, ${ws}, ${cardSetId}, ${generationRunId},
                       'overview', ${`fixture-${cardId}`}, 0, 'active',
                       ${tx.json({ title: "Worker fixture card", summary: "Worker fixture" })})`;
      await tx`INSERT INTO card_key_points
               (id, card_id, workspace_id, ordinal, claim, quote_text)
               VALUES (${keyPointId}, ${cardId}, ${ws}, 0, 'Worker fixture claim', 'Worker fixture quote')`;
      await tx`INSERT INTO evidences
               (id, workspace_id, key_point_id, block_id, block_ordinal, quote_text,
                alignment, alignment_score, alignment_method)
               VALUES (${evidenceId}, ${ws}, ${keyPointId}, ${blockId}, 0,
                       'Worker fixture evidence', 'aligned', 100, 'exact')`;
      await tx`INSERT INTO learning_sessions
               (id, workspace_id, user_id, origin, origin_ref, intent, status)
               VALUES (${sessionId}, ${ws}, ${uid}, 'now',
                       ${tx.json({ type: "key_point", id: keyPointId })},
                       'stabilize', 'active')`;
      await tx`INSERT INTO learning_episodes
               (id, session_id, workspace_id, user_id, key_point_id, origin, origin_ref, intent,
                formal_eligibility_kind, formal_plan, scheduling_decision,
                episode_target_fingerprint, content_exposure_key, rubric_targets,
                allowed_modalities, max_turns, assistance_policy_version, rubric_policy_version,
                scene_policy_version, assessment_policy_version, mastery_policy_version,
                scheduler_policy_version, provider_policy_version, commit_policy_version,
                provider_config_id, model_id, required_capability_ids, capability_snapshot_hash,
                runtime_epoch_snapshot, episode_epoch, budget_envelope_ref, budget_envelope_hash,
                plan_hash, status, processing_phase)
               VALUES (${episodeId}, ${sessionId}, ${ws}, ${uid}, ${keyPointId}, 'now',
                       ${tx.json({ type: "key_point", id: keyPointId })}, 'stabilize',
                       'initial_validation', ${tx.json({ kind: "practice", requiredProbeIds: [] })},
                       ${tx.json({
                         decisionRef: "fixture",
                         decisionHash: "fixture",
                         authorizedAction: "create_initial",
                         prioritySource: "user_selected",
                         policyVersion: "fixture",
                         policyEpoch: 0,
                         reasonCodes: [],
                       })},
                       'fixture-target', 'fixture-exposure', ${tx.json([])},
                       ARRAY['text_or_mixed'], 8, 'fixture', 'fixture', 'fixture', 'fixture',
                       'fixture', 'fixture', 'fixture', 'fixture', 'fixture-provider', 'fixture-model',
                       ARRAY[]::text[], 'fixture-capabilities', 0, 1, 'fixture-budget',
                       'fixture-budget-hash', 'fixture-plan', 'active', 'awaiting_response')`;
    }
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${cid}, ${ws}, ${uid}, 'dialogue', '会话', 'auto', 'active')`;
    await tx`INSERT INTO companion_messages (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
             VALUES (${userMsg}, ${cid}, ${ws}, ${uid}, 'user', 1, 'action',
                     ${tx.json([{ type: "text", text: "开始学习" }])}, ${"0".repeat(64)})`;
    await tx`INSERT INTO companion_action_proposals
             (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
              payload, payload_sha256, title, target_summary, impact_summary, status,
              idempotency_key_hash, expires_at)
             VALUES (${proposalId}, ${ws}, ${uid}, ${cid}, ${userMsg}, 1,
                     ${tx.json(payload as never)}, ${"a".repeat(64)},
                     '开始学习', '一小段学习目标', '完成后更新进度', 'accepted',
                     ${"b".repeat(64)}, now() + interval '30 minutes')`;
    await tx`INSERT INTO companion_action_runs (id, workspace_id, user_id, conversation_id, proposal_id, status)
             VALUES (${runId}, ${ws}, ${uid}, ${cid}, ${proposalId}, 'accepted')`;
    await tx`UPDATE companion_conversations SET next_message_seq = 2, next_event_seq = 1 WHERE id = ${cid}`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`UPDATE companion_action_proposals SET action_run_id = NULL WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_action_runs WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_action_proposals WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM assistant_deliveries WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM learning_sessions WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM evidences WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM card_key_points WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM learning_cards WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM learning_card_sets WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM card_generation_runs WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_conversations WHERE id = ${cid}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
      await tx`DELETE FROM users WHERE id = ${uid}`;
    });
  };
  return { runId, proposalId, cleanup };
}

async function seedBase(): Promise<{ workspaceId: string; userId: string }> {
  const ws = randomUUID();
  const uid = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${uid}, ${"t-" + uid.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${ws}, ${"w" + ws.slice(0, 8)}, ${uid})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${uid}, 'owner')`;
  });
  return { workspaceId: ws, userId: uid };
}

test("P5 §6.8：start_session → learning_session + 恰好一条 result + run succeeded + event", async () => {
  const { workspaceId, userId } = await seedBase();
  const cid = randomUUID();
  const s = await seedRun(workspaceId, userId, cid, {
    kind: "start_session", origin: "now", cardId: randomUUID(), keyPointId: randomUUID(),
  });
  try {
    await runCompanionAction({ payload: { actionRunId: s.runId }, workspaceId, requestedBy: userId });

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const run = await tx`SELECT status, result_message_id FROM companion_action_runs WHERE id = ${s.runId}`;
      const proposal = await tx`SELECT status FROM companion_action_proposals WHERE id = ${s.proposalId}`;
      const results = await tx`SELECT kind, blocks FROM companion_messages WHERE conversation_id = ${cid} AND kind = 'result'`;
      const sessions = await tx`SELECT intent, status FROM learning_sessions WHERE workspace_id = ${workspaceId}`;
      const events = await tx`SELECT type FROM companion_stream_events WHERE conversation_id = ${cid} AND type = 'action.completed'`;
      const routes = await tx`SELECT route FROM companion_action_runs WHERE id = ${s.runId}`;
      const deliveries = await tx`SELECT kind, payload_ref FROM assistant_deliveries WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
      return { run: run[0], proposal: proposal[0], results, sessions, events, routes, deliveries };
    });
    assert.equal(rows.run.status, "succeeded");
    assert.equal(rows.proposal.status, "succeeded");
    assert.ok(rows.run.result_message_id, "result_message_id 已写");
    assert.equal(rows.results.length, 1, "恰好一条 result 消息");
    assert.ok(rows.sessions.length >= 1, "learning_session 已创建");
    assert.equal(rows.sessions[0].intent, "stabilize");
    assert.equal(rows.routes[0].route.kind, "learning_session");
    assert.equal(rows.events.length, 1, "action.completed event");
    assert.equal(rows.deliveries.length, 1, "action_result delivery 已投递");
    assert.equal(rows.deliveries[0].kind, "action_result");
    assert.equal(rows.deliveries[0].payload_ref.actionRunId, s.runId, "action_result payloadRef 指向 actionRunId");

    // 成功后的重复 job 只能被 run 状态 fence 跳过，不能创建第二个 session/result/delivery。
    await runCompanionAction({ payload: { actionRunId: s.runId }, workspaceId, requestedBy: userId });
    const repeat = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const results = await tx`SELECT count(*)::int AS c FROM companion_messages WHERE conversation_id = ${cid} AND kind = 'result'`;
      const sessions = await tx`SELECT count(*)::int AS c FROM learning_sessions WHERE workspace_id = ${workspaceId}`;
      const deliveries = await tx`SELECT count(*)::int AS c FROM assistant_deliveries WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND kind = 'action_result'`;
      return { results: results[0].c, sessions: sessions[0].c, deliveries: deliveries[0].c };
    });
    assert.equal(repeat.results, 1);
    assert.equal(repeat.sessions, 1);
    assert.equal(repeat.deliveries, 1, "重复 job 不重复投递 action_result");
  } finally {
    await s.cleanup();
  }
});

test("P5 §6.8：非 accepted run 跳过（不执行不重复）", async () => {
  const { workspaceId, userId } = await seedBase();
  const cid = randomUUID();
  const s = await seedRun(
    workspaceId,
    userId,
    cid,
    { kind: "start_session", origin: "now", cardId: randomUUID(), keyPointId: randomUUID() },
    false,
  );
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`UPDATE companion_action_runs SET status = 'cancelled' WHERE id = ${s.runId}`;
    });
    await runCompanionAction({ payload: { actionRunId: s.runId }, workspaceId, requestedBy: userId });
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const results = await tx`SELECT count(*)::int AS c FROM companion_messages WHERE conversation_id = ${cid} AND kind = 'result'`;
      const sessions = await tx`SELECT count(*)::int AS c FROM learning_sessions WHERE workspace_id = ${workspaceId}`;
      return { results: results[0].c, sessions: sessions[0].c };
    });
    assert.equal(rows.results, 0, "无 result 消息");
    assert.equal(rows.sessions, 0, "无 session 副作用");
  } finally {
    await s.cleanup();
  }
});
