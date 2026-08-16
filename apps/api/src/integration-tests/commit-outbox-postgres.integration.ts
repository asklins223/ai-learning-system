/**
 * commit_requested outbox 全链路集成测试（真实 Postgres）。
 *
 * 链路：评估已完成（learning_assessment_reports 落库 + episode
 * processing_phase='assessment_complete'）→ outbox 入队 commit_requested
 * → API claim（0109 SECURITY DEFINER 函数）→ processCommitOutboxJob
 * （stabilizeEpisode：Pg repo + Pg Commit executor）→ commit 应用
 * （learning_outbox_events canonical + review_schedules + episode 终态
 * completed/committed）→ committed_change_display proactive 触发
 * （companion_action_ledger 记录）。
 *
 * 环境：DATABASE_URL_API（容器内 postgres）；无 DB 时 skip。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL_API 未配置——commit-outbox 集成测试要求真实 Postgres");
}
const sql = postgres(databaseUrl, { max: 2 });

after(async () => {
  await sql.end().catch(() => undefined);
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase().catch(() => undefined);
});

import {
  claimCommitRequested,
  markCommitOutboxProcessed,
  processCommitOutboxJob,
} from "../modules/learning-sessions/commit-outbox.ts";

async function seedCommitFixture() {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const cardId = randomUUID();
  const keyPointId = randomUUID();
  const sessionId = randomUUID();
  const episodeId = randomUUID();
  const probeId = randomUUID();
  const artifactId = randomUUID();
  const fingerprint = "fp-commit-outbox-it";

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role)
             VALUES (${userId}, ${`commit-it-${userId.slice(0, 8)}@example.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id)
             VALUES (${workspaceId}, ${`ws-${workspaceId.slice(0, 8)}`}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role)
             VALUES (${workspaceId}, ${userId}, 'owner')`;
    const noteId = randomUUID();
    const noteVersionId = randomUUID();
    await tx`INSERT INTO notes (id, workspace_id, title, created_by, created_at, updated_at, title_source, card_generation_epoch)
             VALUES (${noteId}, ${workspaceId}, 'note', ${userId}, now(), now(), 'placeholder', 0)`;
    await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, created_by, created_at, content_hash, updated_at)
             VALUES (${noteVersionId}, ${noteId}, ${workspaceId}, 1, ${tx.json({ blocks: [] })}, ${userId}, now(), 'nh-1', now())`;
    await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json, created_at, updated_at)
             VALUES (${cardId}, ${noteVersionId}, ${workspaceId}, 'active', ${tx.json({ version: 1 })}, now(), now())`;
    await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text)
             VALUES (${keyPointId}, ${cardId}, ${workspaceId}, 1, 'claim', 'quote')`;
    await tx`INSERT INTO learning_sessions (id, workspace_id, user_id, origin, origin_ref, intent, status, created_at, updated_at)
             VALUES (${sessionId}, ${workspaceId}, ${userId}, 'card',
                     ${JSON.stringify({ type: "card", id: cardId })}, 'stabilize', 'active', now(), now())`;
    await tx`INSERT INTO learning_episodes (
               id, session_id, workspace_id, user_id, key_point_id, origin, origin_ref, intent,
               formal_eligibility_kind, formal_plan, scheduling_decision,
               episode_target_fingerprint, content_exposure_key, rubric_targets, allowed_modalities,
               max_turns, assistance_policy_version, rubric_policy_version, scene_policy_version,
               assessment_policy_version, mastery_policy_version, scheduler_policy_version,
               provider_policy_version, commit_policy_version, provider_config_id, model_id,
               required_capability_ids, capability_snapshot_hash, runtime_epoch_snapshot,
               episode_epoch, budget_envelope_ref, budget_envelope_hash, plan_hash,
               status, created_at, updated_at, processing_phase
             ) VALUES (
               ${episodeId}, ${sessionId}, ${workspaceId}, ${userId}, ${keyPointId},
               'card', ${JSON.stringify({ type: "card", id: cardId })}, 'stabilize',
               'formal', ${JSON.stringify({ kind: "voice_mastery", requiredProbeIds: [probeId] })},
               ${JSON.stringify({
                 decisionRef: "dr-1", decisionHash: "dh-1", authorizedAction: "create_initial",
                 policyVersion: "v1", policyEpoch: 1, inputScheduleId: null,
                 reasonCodes: [], decisionSource: "scheduler", intervalDays: 1,
               })},
               ${fingerprint}, 'cek-1',
               ${JSON.stringify([{ rubricItemId: "r1", required: true, facet: "recall" }])},
               '{"voice"}', 10, 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1',
               'pc-1', 'm-1', '{}', 'csh-1', 1, 1, 'ber-1', 'beh-1', 'ph-1',
               'active', now(), now(), 'assessment_complete'
             )`;
    await tx`INSERT INTO learning_session_probes (
               id, session_id, episode_id, workspace_id, user_id, sequence,
               public_scene_contract_id, public_payload_hash,
               private_solution_id, private_solution_hash,
               scene_safety_report_id, scene_safety_report_hash,
               template_trust_ceiling, disclosure_profile_hash, status,
               created_at, updated_at
             ) VALUES (
               ${probeId}, ${sessionId}, ${episodeId}, ${workspaceId}, ${userId}, 1,
               'sc-1', ${`pub-${probeId}`}, 'sol-1', ${`solh-${probeId}`},
               'ssr-1', ${`ssrh-${probeId}`}, 'mastery_eligible', 'dp-1', 'active',
               now(), now()
             )`;
    await tx`INSERT INTO learning_response_artifacts (
               id, session_id, episode_id, key_point_id, probe_id, workspace_id, user_id,
               public_scene_contract_id, public_payload_hash, private_solution_id,
               private_solution_hash, scene_safety_report_hash, disclosure_profile_hash,
               input_schema_hash, modality, content_hash, payload, assistance_snapshot,
               effective_trust_class, episode_target_fingerprint, content_exposure_key,
               requested_trust_class, template_trust_ceiling, trust_policy_version,
               trust_reason_codes, status, revision, created_at, updated_at, answer_locked_at
             ) VALUES (
               ${artifactId}, ${sessionId}, ${episodeId}, ${keyPointId}, ${probeId},
               ${workspaceId}, ${userId}, 'sc-1', 'pp-1', 'sol-1', 'ps-1', 'ssr-1',
               'dp-1', 'ish-1', 'voice', 'ch-1',
               ${JSON.stringify({ text: "answer" })},
               ${JSON.stringify({ contentAssisted: false })},
               'mastery_eligible', ${fingerprint}, 'cek-1',
               'mastery_eligible', 'mastery_eligible', 'v1',
               '{}', 'locked', 1, now(), now(), now()
             )`;
    await tx`INSERT INTO learning_assessment_reports (
               id, session_id, episode_id, workspace_id, user_id,
               critic_version, reducer_version, assessment_source,
               rubric_assessments, report_hash, decision_hash, created_at
             ) VALUES (
               ${randomUUID()}, ${sessionId}, ${episodeId}, ${workspaceId}, ${userId},
               'critic-v1', 'rubric-session-reducer-v2', 'critic',
               ${JSON.stringify([{
                 rubricItemId: "r1", verdict: "covered",
                 responseBindings: [{ responseArtifactId: artifactId }],
                 evidenceRefIds: [], assessmentSource: "critic",
                 rationale: "ok", confidence: 1,
               }])},
               'rh-1', 'dech-1', now()
             )`;
    // companion account：默认开启 + active presence 档（committed_change_display
    // 的 allowedPresenceLevels=["moderate","active"] 允许）。
    await tx`INSERT INTO user_companion_account_state (id, user_id, revision, epoch, global_enabled, presence)
             VALUES (${randomUUID()}, ${userId}, 1, 1, true, ${tx.json({ presence: "active" })})`;
    // commit_requested 入队（模拟 worker persist 后的同事务写入）
    await tx`INSERT INTO learning_session_processing_outbox (
               workspace_id, user_id, session_id, episode_id, command_type,
               payload, idempotency_key
             ) VALUES (
               ${workspaceId}, ${userId}, ${sessionId}, ${episodeId}, 'commit_requested',
               ${JSON.stringify({ sessionId, episodeId, artifactId })},
               ${`commit:${sessionId}:${episodeId}`}
             )
             ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`;
  });

  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM companion_invitation_ledger WHERE user_id = ${userId}`;
      await tx`DELETE FROM companion_conversations WHERE user_id = ${userId}`;
      await tx`DELETE FROM learning_session_processing_outbox WHERE episode_id = ${episodeId}`;
      await tx`DELETE FROM learning_outbox_events WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM review_schedules WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM learning_assessment_reports WHERE episode_id = ${episodeId}`;
      await tx`DELETE FROM learning_response_artifacts WHERE episode_id = ${episodeId}`;
      await tx`DELETE FROM learning_episodes WHERE id = ${episodeId}`;
      await tx`DELETE FROM learning_session_probes WHERE episode_id = ${episodeId}`;
      await tx`DELETE FROM learning_sessions WHERE id = ${sessionId}`;
      await tx`DELETE FROM user_companion_account_state WHERE user_id = ${userId}`;
      await tx`DELETE FROM card_key_points WHERE id = ${keyPointId}`;
      await tx`DELETE FROM learning_cards WHERE id = ${cardId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };

  return {
    workspaceId, userId, cardId, keyPointId, sessionId, episodeId, probeId, artifactId,
    cleanup,
  };
}

test("commit_requested 全链路：claim → stabilize → commit 应用 → episode 终态 → proactive 触发", async () => {
  const fixture = await seedCommitFixture();
  try {
    // 1. claim（SECURITY DEFINER 跨 workspace）
    const job = await claimCommitRequested("it-worker", 60_000, new Date());
    assert.ok(job, "claim 应拿到 commit_requested 行");
    assert.equal(job?.episodeId, fixture.episodeId);
    assert.equal(job?.artifactId, fixture.artifactId);

    // 2. 消费编排
    const outcome = await processCommitOutboxJob(job!);
    assert.equal(outcome, "committed", "评估完成的 voice episode 应提交成功");

    // 3. episode 终态（0098：completed ⇒ committed）
    const epRows = await sql`SELECT status, processing_phase FROM learning_episodes WHERE id = ${fixture.episodeId}`;
    assert.equal(epRows[0]?.status, "completed");
    assert.equal(epRows[0]?.processing_phase, "committed");

    // 4. canonical outbox event 落库（voice → validation.event；review → reviewed）
    const outboxRows = await sql`SELECT event_type FROM learning_outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
    assert.ok(outboxRows.length > 0, "commit 应写 canonical learning_outbox_events");
    const eventTypes = outboxRows.map((r) => String(r.event_type));
    assert.ok(
      eventTypes.some((e) => e.includes("reviewed") || e.includes("validation")),
      `含 canonical 事件，实际: ${eventTypes.join(",")}`,
    );

    // 5. schedule 生效（create_initial）
    const scheduleRows = await sql`SELECT count(*)::int AS n FROM review_schedules WHERE workspace_id = ${fixture.workspaceId} AND status = 'pending'`;
    assert.equal(Number(scheduleRows[0]?.n), 1, "create_initial 应产生恰好一条 pending schedule");

    // 6. committed_change_display proactive 触发（ledger 生效）
    const ledgerRows = await sql`SELECT count(*)::int AS n FROM companion_invitation_ledger WHERE user_id = ${fixture.userId}`;
    assert.ok(Number(ledgerRows[0]?.n) >= 1, "commit 应用后应产生 proactive ledger 记录");

    // 7. markProcessed（幂等闭环）
    await markCommitOutboxProcessed(job!.id, "it-worker");
    const outboxState = await sql`SELECT processed_at IS NOT NULL AS done FROM learning_session_processing_outbox WHERE id = ${job!.id}`;
    assert.equal(outboxState[0]?.done, true);
  } finally {
    await fixture.cleanup().catch(() => undefined);
  }
});

test("commit_requested：claim 无候选 → null（不炸）", async () => {
  const job = await claimCommitRequested("it-worker", 60_000, new Date());
  assert.ok(job === null || typeof job.episodeId === "string");
});
