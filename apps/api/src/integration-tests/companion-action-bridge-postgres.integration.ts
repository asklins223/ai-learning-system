/**
 * P5 §6.7 固定测试：learning menu context adapter（只读）。
 * - 无 learning 数据 → resume/start 候选 null（菜单项 disabled）+ revision 稳定；
 * - 有 active learning_session → resume 候选非 null（payload sha256 合法）；
 * - 同数据两次调用 contextRevision 相同（稳定 revision）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { companionGroundedTutorGrantV1Schema } from "@ailearn/shared";
import { sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { canonicalJsonV1 } from "@ailearn/shared/content-hash";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
const sql = postgres(CONN, { max: 2 });

// P5 §6.7 context-grant 签发依赖 AUTH_SURFACE_MANIFEST_SECRET（runbook P5 输入
// Gate）。测试验证的是 HMAC 逻辑本身，不是部署配置——未设置时注入测试专用
// secret，保证集成测试可复现（不依赖外部环境）。
process.env.AUTH_SURFACE_MANIFEST_SECRET ??= "companion-action-bridge-integration-test-secret";

after(async () => {
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

const { resolveCompanionLearningContext, getCompanionLearningSessionContext } = await import(
  "../modules/companion-conversation/learning-action-bridge.ts"
);
const { closeDatabase } = await import("../db/client.ts");

async function seedBase(): Promise<{ workspaceId: string; userId: string; cleanup: () => Promise<void> }> {
  const ws = randomUUID();
  const uid = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${uid}, ${"t-" + uid.slice(0, 8) + "@x.test"}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${ws}, ${"w" + ws.slice(0, 8)}, ${uid})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${uid}, 'owner')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`DELETE FROM learning_episodes WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM learning_sessions WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_messages WHERE action_ref IS NOT NULL AND workspace_id = ${ws}`;
      await tx`UPDATE companion_action_proposals SET action_run_id = NULL WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_action_runs WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_action_proposals WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM learning_episodes WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM learning_sessions WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM card_key_points WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM learning_cards WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM note_versions WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM notes WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_conversations WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
      await tx`DELETE FROM users WHERE id = ${uid}`;
    });
  };
  return { workspaceId: ws, userId: uid, cleanup };
}

test("P5 §6.7：无 learning 数据 → resume/start 候选 null（disabled）+ revision 稳定", async () => {
  const { workspaceId, userId, cleanup } = await seedBase();
  try {
    const ctx = await resolveCompanionLearningContext({ workspaceId, userId });
    assert.equal(ctx.version, 1);
    assert.match(ctx.contextRevision, /^[a-f0-9]{64}$/);
    assert.equal(ctx.resumeCandidate, null);
    assert.equal(ctx.startCandidate, null);
    // 同数据两次调用 revision 相同（稳定）
    const ctx2 = await resolveCompanionLearningContext({ workspaceId, userId });
    assert.equal(ctx2.contextRevision, ctx.contextRevision);
  } finally {
    await cleanup();
  }
});

test("P5 §6.7：有 active learning_session → resume 候选非 null（payload sha256 合法）", async () => {
  const { workspaceId, userId, cleanup } = await seedBase();
  try {
    const sessionId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO learning_sessions
               (id, workspace_id, user_id, origin, origin_ref, intent, status)
               VALUES (${sessionId}, ${workspaceId}, ${userId}, 'card',
                       ${{ cardId: randomUUID() } as never}, 'resume', 'active')`;
    });
    const ctx = await resolveCompanionLearningContext({ workspaceId, userId });
    assert.ok(ctx.resumeCandidate, "resume 候选应存在");
    if (ctx.resumeCandidate) {
      assert.equal(ctx.resumeCandidate.candidateId, "resume_current");
      assert.match(ctx.resumeCandidate.payloadSha256, /^[a-f0-9]{64}$/);
      assert.ok(ctx.resumeCandidate.title.length >= 1);
    }
  } finally {
    await cleanup();
  }
});

test("P5 §6.7：menu proposal create 原子（双消息 + proposal pending + action.proposed）", async () => {
  const { workspaceId, userId, cleanup } = await seedBase();
  try {
    const sessionId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO learning_sessions
               (id, workspace_id, user_id, origin, origin_ref, intent, status)
               VALUES (${sessionId}, ${workspaceId}, ${userId}, 'card',
                       ${{ cardId: randomUUID() } as never}, 'resume', 'active')`;
    });
    const { createCompanionMenuProposal } = await import(
      "../modules/companion-conversation/learning-action-bridge.ts"
    );
    const ctx = await resolveCompanionLearningContext({ workspaceId, userId });
    assert.ok(ctx.resumeCandidate, "resume 候选存在");
    const result = await createCompanionMenuProposal({
      workspaceId, userId,
      body: {
        version: 1,
        clientMessageId: randomUUID(),
        candidateId: "resume_current",
        expectedContextRevision: ctx.contextRevision,
        expectedPayloadSha256: ctx.resumeCandidate!.payloadSha256,
        sourceSurface: "pet",
      },
      idempotencyKey: randomUUID(),
    });
    const r = result as {
      conversationId: string; userMessageId: string; assistantMessageId: string;
      proposal: { proposalId: string; status: string }; eventCursor: number;
    };
    assert.ok(r.conversationId);
    assert.equal(r.proposal.status, "pending");
    assert.ok(r.eventCursor >= 1);

    // 双消息 + action_ref + event 落库
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const msgs = await tx`SELECT id, role, kind, action_ref FROM companion_messages
                            WHERE conversation_id = ${r.conversationId} ORDER BY seq`;
      const events = await tx`SELECT type FROM companion_stream_events
                              WHERE conversation_id = ${r.conversationId} AND type = 'action.proposed'`;
      const proposals = await tx`SELECT status FROM companion_action_proposals WHERE id = ${r.proposal.proposalId}`;
      return { msgs, events, proposals };
    });
    assert.equal(rows.msgs.length, 2, "双消息（user action + assistant action）");
    // §3.3：assistant confirmation 消息 kind='action' 且带 action_ref block。
    assert.equal(rows.msgs[1].kind, "action");
    assert.equal(rows.msgs[1].action_ref, r.proposal.proposalId, "assistant confirmation 带 action_ref");
    assert.equal(rows.events.length, 1, "action.proposed event");
    assert.equal(rows.proposals[0].status, "pending");

    // revision 不匹配 → 409 CONTEXT_STALE（与 payload 不匹配的 ACTION_STALE 区分）
    await assert.rejects(
      createCompanionMenuProposal({
        workspaceId, userId,
        body: {
          version: 1, clientMessageId: randomUUID(), candidateId: "resume_current",
          expectedContextRevision: "f".repeat(64),
          expectedPayloadSha256: ctx.resumeCandidate!.payloadSha256,
          sourceSurface: "pet",
        },
        idempotencyKey: randomUUID(),
      }),
      (err: { code?: string }) => err.code === "CONTEXT_STALE",
    );
  } finally {
    await cleanup();
  }
});

async function seedOpenReviewProposal(ws: string, uid: string, cid: string): Promise<{ proposalId: string; conversationId: string; cleanup: () => Promise<void> }> {
  const proposalId = randomUUID();
  const userMsg = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${cid}, ${ws}, ${uid}, 'dialogue', '会话', 'auto', 'active')`;
    await tx`INSERT INTO companion_messages (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
             VALUES (${userMsg}, ${cid}, ${ws}, ${uid}, 'user', 1, 'action',
                     ${{ blocks: [{ type: "text", text: "打开复习" }] } as never}, ${"0".repeat(64)})`;
    await tx`INSERT INTO companion_action_proposals
             (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
              payload, payload_sha256, title, target_summary, impact_summary, status,
              idempotency_key_hash, expires_at)
             VALUES (${proposalId}, ${ws}, ${uid}, ${cid}, ${userMsg}, 1,
                     ${{ kind: "open_review" } as never},
                     ${sha256Utf8V1(canonicalJsonV1({ kind: "open_review" }))},
                     '复习', '今日复习', '打开复习页', 'pending', ${"b".repeat(64)},
                     now() + interval '30 minutes')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`DELETE FROM companion_messages WHERE action_ref IS NOT NULL AND workspace_id = ${ws}`;
      await tx`DELETE FROM companion_action_runs WHERE workspace_id = ${ws}`;
      await tx`UPDATE companion_action_proposals SET action_run_id = NULL WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_action_runs WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_action_proposals WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_conversations WHERE workspace_id = ${ws}`;
    });
  };
  return { proposalId, conversationId: cid, cleanup };
}

test("P5 §6.6：reject 原子零副作用；confirm 纯导航同步 succeeded + action.decision", async () => {
  const { workspaceId, userId, cleanup: baseCleanup } = await seedBase();
  const cid = randomUUID();
  try {
    const s1 = await seedOpenReviewProposal(workspaceId, userId, cid);
    const { decideCompanionProposal } = await import(
      "../modules/companion-conversation/learning-action-bridge.ts"
    );
    // reject → 200 rejected + decision 落库
    const rejected = await decideCompanionProposal({
      workspaceId, userId, proposalId: s1.proposalId, decision: "reject", idempotencyKey: randomUUID(),
    }) as { status: string };
    assert.equal(rejected.status, "rejected");
    const row = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT status, decision FROM companion_action_proposals WHERE id = ${s1.proposalId}`;
    });
    assert.equal(row[0].status, "rejected");
    assert.equal(row[0].decision, "reject");
    await s1.cleanup();

    // confirm 纯导航（open_review）→ 200 succeeded + action.decision event。
    // §6.6/合同 1018：纯导航不创建 action run（action.completed 要求
    // actionRunId 非空），同步 succeeded response 本身就是完成证明。
    const s2 = await seedOpenReviewProposal(workspaceId, userId, cid);
    const confirmed = await decideCompanionProposal({
      workspaceId, userId, proposalId: s2.proposalId, decision: "confirm", idempotencyKey: randomUUID(),
    }) as { status: string; route: { kind: string } | null };
    assert.equal(confirmed.status, "succeeded");
    // route.kind 是 AllowedMainRouteV1 枚举（"review"），不是 proposal kind。
    assert.equal(confirmed.route?.kind, "review");
    const events = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT type, payload FROM companion_stream_events WHERE conversation_id = ${cid} AND type IN ('action.decision', 'action.completed') ORDER BY seq`;
    });
    assert.ok(events.some((e) => e.type === "action.decision"), "action.decision event");
    assert.equal(events.some((e) => e.type === "action.completed"), false, "纯导航不得伪造 action.completed（无 action run）");
    await s2.cleanup();
  } finally {
    await baseCleanup();
  }
});

test("P5 §6.6：confirm session 动作 → 202 accepted + action run + companion_action job", async () => {
  const { workspaceId, userId, cleanup } = await seedBase();
  try {
    const sessionId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO learning_sessions (id, workspace_id, user_id, origin, origin_ref, intent, status)
               VALUES (${sessionId}, ${workspaceId}, ${userId}, 'card', ${{ cardId: randomUUID() } as never}, 'resume', 'active')`;
    });
    const { createCompanionMenuProposal, decideCompanionProposal } = await import(
      "../modules/companion-conversation/learning-action-bridge.ts"
    );
    const ctx = await resolveCompanionLearningContext({ workspaceId, userId });
    const created = await createCompanionMenuProposal({
      workspaceId, userId,
      body: {
        version: 1, clientMessageId: randomUUID(), candidateId: "resume_current",
        expectedContextRevision: ctx.contextRevision,
        expectedPayloadSha256: ctx.resumeCandidate!.payloadSha256,
        sourceSurface: "pet",
      },
      idempotencyKey: randomUUID(),
    }) as { proposal: { proposalId: string } };
    const decided = await decideCompanionProposal({
      workspaceId, userId, proposalId: created.proposal.proposalId,
      decision: "confirm", idempotencyKey: randomUUID(),
    }) as { status: string; actionRunId: string | null };
    assert.equal(decided.status, "accepted");
    assert.ok(decided.actionRunId);
    const runs = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT status FROM companion_action_runs WHERE id = ${decided.actionRunId}`;
    });
    assert.equal(runs[0].status, "accepted");
    const jobs = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT type FROM jobs WHERE payload->>'actionRunId' = ${decided.actionRunId}`;
    });
    assert.ok(jobs.length >= 1, "companion_action job 已创建");
    assert.equal(jobs[0].type, "companion_action");
  } finally {
    await cleanup();
  }
});

test("P5 §6.7：context-grants 签发（HMAC + 5min TTL + episode 解引用）", async () => {
  const { workspaceId, userId, cleanup } = await seedBase();
  try {
    const cardId = randomUUID();
    const kpId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO notes (id, workspace_id, title, created_by) VALUES (${randomUUID()}, ${workspaceId}, '笔记', ${userId})`;
      await tx`INSERT INTO note_versions (id, note_id, workspace_id, version_no, content_json, created_by, content_hash)
               VALUES (${randomUUID()}, (SELECT id FROM notes WHERE workspace_id = ${workspaceId} LIMIT 1), ${workspaceId}, 1, ${{} as never}, ${userId}, ${"0".repeat(64)})`;
      await tx`INSERT INTO learning_cards (id, note_version_id, workspace_id, status, schema_json)
               VALUES (${cardId}, (SELECT id FROM note_versions WHERE workspace_id = ${workspaceId} LIMIT 1), ${workspaceId}, 'active', ${{} as never})`;
      await tx`INSERT INTO card_key_points (id, card_id, workspace_id, ordinal, claim, quote_text)
               VALUES (${kpId}, ${cardId}, ${workspaceId}, 1, '要点', '引用')`;
    });
    const sessionId = randomUUID();
    const episodeId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO learning_sessions (id, workspace_id, user_id, origin, origin_ref, intent, status)
               VALUES (${sessionId}, ${workspaceId}, ${userId}, 'card', ${{ cardId } as never}, 'resume', 'active')`;
      await tx`INSERT INTO learning_episodes
               (id, session_id, workspace_id, user_id, key_point_id, origin, origin_ref, intent,
                formal_eligibility_kind, formal_plan, scheduling_decision, episode_target_fingerprint,
                content_exposure_key, rubric_targets, max_turns,
                assistance_policy_version, rubric_policy_version, scene_policy_version,
                assessment_policy_version, mastery_policy_version, scheduler_policy_version,
                provider_policy_version, commit_policy_version, provider_config_id, model_id,
                capability_snapshot_hash, runtime_epoch_snapshot, episode_epoch,
                budget_envelope_ref, budget_envelope_hash, plan_hash, status, processing_phase)
               VALUES (${episodeId}, ${sessionId}, ${workspaceId}, ${userId}, ${kpId}, 'card',
                       ${{ cardId, keyPointId: kpId } as never}, 'resume', 'formal',
                       ${{ plan: "p" } as never}, ${{ decision: "d" } as never},
                       'fp', 'cek', ${[] as never}, 1,
                       '1', '1', '1', '1', '1', '1', '1', '1', 'pc', 'm',
                       ${"0".repeat(64)}, 0, 0,
                       'ref', ${"1".repeat(64)}, ${"2".repeat(64)}, 'active', 'awaiting_response')`;
    });
    const { createCompanionContextGrant } = await import(
      "../modules/companion-conversation/learning-action-bridge.ts"
    );
    const pageContext = await getCompanionLearningSessionContext({ workspaceId, userId, sessionId, episodeId });
    const grant = await createCompanionContextGrant({
      workspaceId, userId,
      sessionId,
      body: {
        version: 1,
        pageInstanceId: randomUUID(),
        episodeId,
        contextRevision: (pageContext.body as { contextRevision: string }).contextRevision,
      },
    });
    const parsedGrant = companionGroundedTutorGrantV1Schema.safeParse(grant);
    assert.equal(parsedGrant.success, true, "grant 必须符合共享合同");
    const typedGrant = grant as { grantId: string; sessionId: string; expiresAt: string; signature: string; version: number };
    assert.equal(typedGrant.version, 1);
    assert.equal(typedGrant.sessionId, sessionId, "episode 解引用到 session");
    assert.match(typedGrant.signature, /^[a-f0-9]{64}$/, "HMAC-SHA256 签名");
    const ttlMs = new Date(typedGrant.expiresAt).getTime() - Date.now();
    assert.ok(ttlMs <= 5 * 60_000 && ttlMs > 4 * 60_000, "5min TTL");
  } finally {
    await cleanup();
  }
});
