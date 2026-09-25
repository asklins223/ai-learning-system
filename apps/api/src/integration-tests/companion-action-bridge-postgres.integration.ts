/**
 * P5 §6.7 固定测试：learning menu context adapter（只读）。
 * - 无 learning 数据 → resume/start 候选 null（菜单项 disabled）+ revision 稳定；
 * - 有 active learning run → resume 候选非 null（payload sha256 合法）；
 * - 同数据两次调用 contextRevision 相同（稳定 revision）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { companionGroundedTutorGrantV1Schema } from "@ailearn/shared";
import { sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { canonicalJsonV1 } from "@ailearn/shared/content-hash";
import { addV2ObjectiveToWorkspace, addV2ObjectiveWithoutCard, seedObjectiveNoteEvidence, cleanupWorkspaceTables } from "./helpers/v2-card-fixture.ts";
import { withWorkspaceTransaction } from "../db/client.ts";

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

const { resolveCompanionLearningContext, createCompanionLearningRunContextGrant, getCompanionLearningRunContext } = await import(
  "../modules/companion-conversation/learning-action-bridge.ts"
);
const { createRunV2 } = await import("../modules/learning-runs/run-service.ts");
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
  const cleanup = () => cleanupWorkspaceTables(sql, ws, uid);
  return { workspaceId: ws, userId: uid, cleanup };
}

test("P5 §6.7：无 learning 数据 → resume/start 候选 null（disabled）+ revision 稳定", async () => {
  const { workspaceId, userId, cleanup } = await seedBase();
  try {
    const ctx = await resolveCompanionLearningContext({ workspaceId, userId });
    assert.equal(ctx.version, 1);
    assert.match(ctx.contextRevision, /^[a-f0-9]{64}$/);
    assert.equal(ctx.learningRunResumeCandidate, null);
    assert.equal(ctx.learningRunStartCandidate, null);
    // 同数据两次调用 revision 相同（稳定）
    const ctx2 = await resolveCompanionLearningContext({ workspaceId, userId });
    assert.equal(ctx2.contextRevision, ctx.contextRevision);
  } finally {
    await cleanup();
  }
});

test("P5 §6.7：有进行中 learning run → learning_run_resume 候选非 null（payload sha256 合法）", async () => {
  const { workspaceId, userId, cleanup } = await seedBase();
  // 2026-08-23 对齐：桥接已切 V2（Plan 23 CS-05/CS-06）——候选从
  // learning_objectives_v2 派生当前 LearningRun 候选。
  const obj = await addV2ObjectiveToWorkspace(sql, workspaceId, userId, {
    objectiveStatement: "resume 候选测试目标",
    publicSummary: "resume",
    front: { cue: "resume", prompt: "什么是 resume？" },
  });
  try {
    await withWorkspaceTransaction(
      { workspaceId, userId },
      async (tx) =>
        createRunV2(tx, { workspaceId, userId, request: {
          originV2: { kind: "card", cardId: obj.cardId, objectiveId: obj.objectiveId },
          goal: "stabilize",
          idempotencyKey: `p5-resume-${workspaceId.slice(0, 8)}`,
        } }),
    );
    const ctx = await resolveCompanionLearningContext({ workspaceId, userId });
    assert.ok(ctx.learningRunResumeCandidate, "learning_run_resume 候选应存在");
    if (ctx.learningRunResumeCandidate) {
      assert.equal(ctx.learningRunResumeCandidate.candidateId, "learning_run_resume");
      assert.match(ctx.learningRunResumeCandidate.payloadSha256, /^[a-f0-9]{64}$/);
      assert.ok(ctx.learningRunResumeCandidate.title.length >= 1);
    }
  } finally {
    await cleanup();
  }
});

test("P5 §6.7：menu proposal create 原子（双消息 + proposal pending + action.proposed）", async () => {
  const { workspaceId, userId, cleanup } = await seedBase();
  // 2026-08-23 对齐：候选从 V2 objective 派生（learning_run_start）。
  await addV2ObjectiveToWorkspace(sql, workspaceId, userId, {
    objectiveStatement: "menu proposal 测试目标",
    publicSummary: "menu",
    front: { cue: "menu", prompt: "什么是 menu？" },
  });
  try {
    const { createCompanionMenuProposal } = await import(
      "../modules/companion-conversation/learning-action-bridge.ts"
    );
    const ctx = await resolveCompanionLearningContext({ workspaceId, userId });
    assert.ok(ctx.learningRunStartCandidate, "learning_run_start 候选存在");
    const result = await createCompanionMenuProposal({
      workspaceId, userId,
      body: {
        version: 1,
        clientMessageId: randomUUID(),
        candidateId: "learning_run_start",
        expectedContextRevision: ctx.contextRevision,
        expectedPayloadSha256: ctx.learningRunStartCandidate!.payloadSha256,
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
          version: 1, clientMessageId: randomUUID(), candidateId: "learning_run_start",
          expectedContextRevision: "f".repeat(64),
          expectedPayloadSha256: ctx.learningRunStartCandidate!.payloadSha256,
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

async function seedOpenReviewProposal(ws: string, uid: string, cid: string): Promise<{
  proposalId: string;
  conversationId: string;
  payloadSha256: string;
  cleanup: () => Promise<void>;
}> {
  const proposalId = randomUUID();
  const userMsg = randomUUID();
  const payloadSha256 = sha256Utf8V1(canonicalJsonV1({ kind: "open_review" }));
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
                     ${payloadSha256},
                     '复习', '今日复习', '打开复习页', 'pending', ${"b".repeat(64)},
                     now() + interval '30 minutes')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`DELETE FROM companion_messages WHERE action_ref IS NOT NULL AND workspace_id = ${ws}`;
      await tx`DELETE FROM companion_action_proposals WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM companion_conversations WHERE workspace_id = ${ws}`;
    });
  };
  return { proposalId, conversationId: cid, payloadSha256, cleanup };
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
      workspaceId, userId, proposalId: s1.proposalId, decision: "reject",
      expectedPayloadSha256: s1.payloadSha256, idempotencyKey: randomUUID(),
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
    // 同步 succeeded response 本身就是完成证明。
    const s2 = await seedOpenReviewProposal(workspaceId, userId, cid);
    const confirmed = await decideCompanionProposal({
      workspaceId, userId, proposalId: s2.proposalId, decision: "confirm",
      expectedPayloadSha256: s2.payloadSha256, idempotencyKey: randomUUID(),
    }) as { status: string; route: { kind: string } | null };
    assert.equal(confirmed.status, "succeeded");
    // route.kind 是 AllowedMainRouteV1 枚举（"review"），不是 proposal kind。
    assert.equal(confirmed.route?.kind, "review");
    const events = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT type, payload FROM companion_stream_events WHERE conversation_id = ${cid} AND type = 'action.decision' ORDER BY seq`;
    });
    assert.ok(events.some((e) => e.type === "action.decision"), "action.decision event");
    await s2.cleanup();
  } finally {
    await baseCleanup();
  }
});

test("P5 §6.6：confirm learning_run_start 动作 → 同步建 Run succeeded（resultRef=runId）", async () => {
  const { workspaceId, userId, cleanup } = await seedBase();
  // V2 候选（learning_run_start）不需要预置旧过程表。
  const obj = await addV2ObjectiveToWorkspace(sql, workspaceId, userId, {
    objectiveStatement: "confirm 动作测试目标",
    publicSummary: "confirm",
    front: { cue: "confirm", prompt: "什么是 confirm？" },
  });
  try {
    const { createCompanionMenuProposal, decideCompanionProposal } = await import(
      "../modules/companion-conversation/learning-action-bridge.ts"
    );
    const ctx = await resolveCompanionLearningContext({ workspaceId, userId });
    const created = await createCompanionMenuProposal({
      workspaceId, userId,
      body: {
        version: 1, clientMessageId: randomUUID(), candidateId: "learning_run_start",
        expectedContextRevision: ctx.contextRevision,
        expectedPayloadSha256: ctx.learningRunStartCandidate!.payloadSha256,
        sourceSurface: "pet",
      },
      idempotencyKey: randomUUID(),
    }) as { proposal: { proposalId: string } };
    const decided = await decideCompanionProposal({
      workspaceId, userId, proposalId: created.proposal.proposalId,
      decision: "confirm",
      expectedPayloadSha256: ctx.learningRunStartCandidate!.payloadSha256,
      idempotencyKey: randomUUID(),
    }) as { status: string; resultRef?: string };
    assert.equal(decided.status, "succeeded");
    // 2026-08-23 实证对齐：V2 learning_run_start 的 confirm 同步创建
    // LearningRun（succeeded + resultRef=runId）在同一事务内完成。
    assert.equal(decided.status, "succeeded");
    const resultRef = (decided as { resultRef?: string }).resultRef;
    assert.ok(resultRef, "resultRef 应携带新 LearningRun id");
    const newRuns = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT phase, origin->>'objectiveId' AS objective_id FROM learning_runs WHERE id = ${resultRef}`;
    });
    assert.equal(newRuns[0]?.phase, "active", "同步创建的 run 应已 active");
    assert.equal(newRuns[0]?.objective_id, obj.objectiveId);
  } finally {
    await cleanup();
  }
});

test("P5 §6.7：LearningRun context grant 签发（HMAC + 5min TTL）", async () => {
  const { workspaceId, userId, cleanup } = await seedBase();
  const obj = await addV2ObjectiveToWorkspace(sql, workspaceId, userId, {
    objectiveStatement: "context-grant 测试",
    publicSummary: "grant",
    front: { cue: "grant", prompt: "什么是 grant？" },
  });
  try {
    const run = await withWorkspaceTransaction(
      { workspaceId, userId },
      async (tx) => createRunV2(tx, {
        workspaceId,
        userId,
        request: {
          originV2: { kind: "card", cardId: obj.cardId, objectiveId: obj.objectiveId },
          goal: "stabilize",
          idempotencyKey: `grant-${workspaceId.slice(0, 8)}`,
        },
      }),
    );
    const pageContext = await getCompanionLearningRunContext({ workspaceId, userId, runId: run.runId });
    const context = pageContext.body as { contextRevision: string; taskId: string };
    const grant = await createCompanionLearningRunContextGrant({
      workspaceId,
      userId,
      runId: run.runId,
      body: {
        version: 1,
        pageInstanceId: randomUUID(),
        taskId: context.taskId,
        contextRevision: context.contextRevision,
      },
    });
    const parsedGrant = companionGroundedTutorGrantV1Schema.safeParse(grant);
    assert.equal(parsedGrant.success, true, "grant 必须符合共享合同");
    const typedGrant = grant as { runId: string; snapshotId: string; taskId: string; expiresAt: string; signature: string; version: number };
    assert.equal(typedGrant.version, 1);
    assert.equal(typedGrant.runId, run.runId);
    assert.equal(typedGrant.taskId, context.taskId);
    assert.ok(typedGrant.snapshotId);
    assert.match(typedGrant.signature, /^[a-f0-9]{64}$/, "HMAC-SHA256 签名");
    const ttlMs = new Date(typedGrant.expiresAt).getTime() - Date.now();
    assert.ok(ttlMs <= 5 * 60_000 && ttlMs > 4 * 60_000, "5min TTL");
  } finally {
    await cleanup();
  }
});

/**
 * W4-2（2026-09-25）：**没有卡的目标也必须进她那一侧的候选，而且她代开的那一轮真开得起来。**
 *
 * 这一条要挡的事故形状：入口在 `action-resolver` 那边放开了，桥接这一侧却还留着
 * "origin 一定是 card" 的假设。那种半放开最阴——两边各自的用例都绿，症状是
 * "用户在页面上点得到，伴星说这个我开不了"。所以断言分三段：候选在不在、
 * 候选带的是哪一种 origin、她确认之后**库里那一行**的 origin 是什么。
 */
test("P5 §6.7：无卡目标也进她的候选，确认后真的开出那一轮（origin=today）", async () => {
  const { workspaceId, userId, cleanup } = await seedBase();
  const objective = await addV2ObjectiveWithoutCard(sql, workspaceId, userId, {
    objectiveStatement: "无卡桥接测试目标",
    publicSummary: "无卡桥接",
  });
  // 零依据的无卡目标会被冻结链 fail closed（那是另一条用例测的行为）；
  // 这一条要的是"能开出去"的那一支，所以把笔记依据种齐。
  await seedObjectiveNoteEvidence(sql, { workspaceId, userId, ...objective });
  try {
    const ctx = await resolveCompanionLearningContext({ workspaceId, userId });
    const candidate = ctx.learningRunStartCandidate;
    assert.ok(candidate, "无卡的 active 目标必须进她的候选（主行动已是 create_run）");
    if (!candidate) return;
    assert.deepEqual(candidate.originV2, { kind: "today", objectiveId: objective.objectiveId });
    // 没有概念名时，那个词取**服务端这一条 action 自己的 label**（不是桥接硬写的一句）。
    assert.equal(candidate.title, "开始学习");

    const { createCompanionMenuProposal, decideCompanionProposal } = await import(
      "../modules/companion-conversation/learning-action-bridge.ts"
    );
    const created = await createCompanionMenuProposal({
      workspaceId, userId,
      body: {
        version: 1, clientMessageId: randomUUID(), candidateId: "learning_run_start",
        expectedContextRevision: ctx.contextRevision,
        expectedPayloadSha256: candidate.payloadSha256,
        sourceSurface: "pet",
      },
      idempotencyKey: randomUUID(),
    }) as { proposal: { proposalId: string } };
    const decided = await decideCompanionProposal({
      workspaceId, userId, proposalId: created.proposal.proposalId,
      decision: "confirm",
      expectedPayloadSha256: candidate.payloadSha256,
      idempotencyKey: randomUUID(),
    }) as { status: string; resultRef?: string };
    assert.equal(decided.status, "succeeded", "她代开无卡那一轮不许被任何一侧悄悄拒掉");
    const resultRef = decided.resultRef;
    assert.ok(resultRef, "resultRef 应携带新 LearningRun id");

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT origin->>'kind' AS origin_kind, origin->>'objectiveId' AS objective_id, phase
                FROM learning_runs WHERE id = ${resultRef}`;
    });
    assert.equal(rows[0]?.origin_kind, "today", "库里那一行记的 origin 必须就是无卡那一种");
    assert.equal(rows[0]?.objective_id, objective.objectiveId);
    assert.equal(rows[0]?.phase, "active");
  } finally {
    await cleanup();
  }
});
