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
  // V2: keyPointId is now an alias for objective_id; cardId is learning_cards_v2.card_id
  const objectiveId = String(payload.keyPointId ?? randomUUID());
  const cardId = String(payload.cardId ?? randomUUID());
  const noteId = randomUUID();
  const noteVersionId = randomUUID();
  const objectiveRevisionId = randomUUID();
  const sessionId = randomUUID();
  const episodeId = randomUUID();

  // V2 fixture constants (match v2-card-fixture.ts helpers)
  const SHA256_HEX = "f".repeat(64);
  const TARGET_REVISION_HASH = "e".repeat(64);
  const PRIVATE_PAYLOAD_HASH = "d".repeat(64);
  const PRESENTATION_HASH = "c".repeat(64);
  const PUBLIC_PAYLOAD_HASH = "b".repeat(64);
  const REVEAL_PAYLOAD_HASH = "a".repeat(64);
  const DEFAULT_CANONICAL_ANSWER = JSON.stringify({
    kind: "text",
    unit: { unitId: "u1", text: "Fixture canonical answer" },
  });
  const DEFAULT_LEARNING_SUPPORT = JSON.stringify({ explanation: "Fixture learning support" });
  const DEFAULT_SCORING_RUBRIC = JSON.stringify({ units: [], passingPolicy: {} });

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    if (prepareLearning) {
      // V2: note + note_version
      await tx`INSERT INTO notes (id, workspace_id, title, created_by, card_generation_epoch)
               VALUES (${noteId}, ${ws}, 'Worker fixture note', ${uid}, 1)`;
      await tx`INSERT INTO note_versions
               (id, note_id, workspace_id, version_no, content_json, content_hash, created_by)
               VALUES (${noteVersionId}, ${noteId}, ${ws}, 1, ${tx.json({ blocks: [] })}, 'fixture-note-hash', ${uid})`;
      await tx`UPDATE notes SET current_version_id = ${noteVersionId} WHERE id = ${noteId}`;

      // V2: learning_objectives_v2
      await tx`INSERT INTO learning_objectives_v2
               (id, workspace_id, objective_id, semantic_identity_class_id, semantic_identity_policy_version,
                semantic_target_fingerprint, lifecycle, lifecycle_epoch, current_objective_revision_id, current_revision)
               VALUES (gen_random_uuid(), ${ws}, ${objectiveId}, 'fixture:class', 'sem-id-v1',
                       ${SHA256_HEX}, 'active', 1, ${objectiveRevisionId}, 1)`;

      // V2: learning_objective_revisions_v2
      await tx`INSERT INTO learning_objective_revisions_v2
               (id, workspace_id, objective_revision_id, objective_id, revision, objective_statement, public_summary,
                knowledge_form, preferred_intents, canonical_answer, learning_support, scoring_rubric, relations,
                evidence_bindings, semantic_target_fingerprint, target_revision_hash, private_payload_hash)
               VALUES (gen_random_uuid(), ${ws}, ${objectiveRevisionId}, ${objectiveId}, 1,
                       'Worker fixture claim', 'Worker fixture summary', 'definition', ARRAY['recall'],
                       ${DEFAULT_CANONICAL_ANSWER}::jsonb,
                       ${DEFAULT_LEARNING_SUPPORT}::jsonb,
                       ${DEFAULT_SCORING_RUBRIC}::jsonb,
                       '[]'::jsonb, '[]'::jsonb, ${SHA256_HEX}, ${TARGET_REVISION_HASH}, ${PRIVATE_PAYLOAD_HASH})`;

      // V2: learning_cards_v2
      await tx`INSERT INTO learning_cards_v2
               (id, workspace_id, card_id, objective_id, note_version_id, card_revision, current_publication_revision, lifecycle,
                front, public_summary, knowledge_form, strategy, presentation_hash)
               VALUES (gen_random_uuid(), ${ws}, ${cardId}, ${objectiveId}, ${noteVersionId},
                       1, 1, 'active',
                       ${tx.json({ cue: "Fixture", prompt: "Fixture prompt?" })},
                       'Worker fixture summary', 'definition', 'recall', ${PRESENTATION_HASH})`;

      // V2: learning_card_publication_revisions_v2
      await tx`INSERT INTO learning_card_publication_revisions_v2
               (id, workspace_id, card_id, publication_revision, card_revision, objective_id, objective_revision,
                lifecycle_at_publication, public_payload_hash, reveal_payload_hash)
               VALUES (gen_random_uuid(), ${ws}, ${cardId}, 1, 1, ${objectiveId}, 1, 'active',
                       ${PUBLIC_PAYLOAD_HASH}, ${REVEAL_PAYLOAD_HASH})`;

      // learning_sessions + learning_episodes (schema unchanged; key_point_id = objective_id)
      await tx`INSERT INTO learning_sessions
               (id, workspace_id, user_id, origin, origin_ref, intent, status)
               VALUES (${sessionId}, ${ws}, ${uid}, 'now',
                       ${tx.json({ type: "key_point", id: objectiveId })},
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
               VALUES (${episodeId}, ${sessionId}, ${ws}, ${uid}, ${objectiveId}, 'now',
                       ${tx.json({ type: "key_point", id: objectiveId })}, 'stabilize',
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
      // V2 cleanup: V2 tables instead of V1 card_key_points/learning_cards/learning_card_sets
      await tx`DELETE FROM learning_card_publication_revisions_v2 WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM learning_cards_v2 WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM learning_objective_revisions_v2 WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM learning_objectives_v2 WHERE workspace_id = ${ws}`;
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
