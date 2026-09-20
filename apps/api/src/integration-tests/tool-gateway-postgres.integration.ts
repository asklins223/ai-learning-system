/**
 * 方案 16 §18.1 工具网关纵切集成测试（postgres）。
 *
 * 覆盖：通用工具 proposal 创建（校验/幂等）→ confirm 后确定性执行——
 * pause_learning_run（真实暂停）、request_hint_level（exposure-first）、
 * switch_task_variant（变体切换）、defer_review（展示层，不动 official
 * dueAt）、plan_understanding_route（真实 RoutePlan）、focus_graph_node
 * （导航 succeeded + route）、记忆候选 confirm/reject（revision CAS）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { createLearningRunForTest, seedV2Fixture } from "./helpers/v2-card-fixture.ts";

// 测试专用 checkpoint 密钥（同 AUTH_SURFACE_MANIFEST_SECRET 模式；模块级
// 读取发生在 import 时，必须在动态 import 前设置）。
process.env.PROJECTION_CHECKPOINT_SECRET ??= "tool-gateway-integration-checkpoint-secret";
process.env.AUTH_SURFACE_MANIFEST_SECRET ??= "tool-gateway-integration-test-secret";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
const sql = postgres(CONN, { max: 2 });

after(async () => {
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

const { createCompanionToolProposal, decideCompanionProposal } = await import(
  "../modules/companion-conversation/learning-action-bridge.ts"
);
const { closeDatabase } = await import("../db/client.ts");
const { withWorkspaceTransaction } = await import("../db/client.ts");
const { upsertMemory } = await import("../modules/companion-conversation/memory-service.ts");
const { issueCheckpointToken } = await import("../modules/understanding/projection-checkpoint.ts");
const { CompanionConversationError } = await import("../modules/companion-conversation/turn-service.ts");

interface Seeded {
  workspaceId: string;
  userId: string;
  cardId: string;
  keyPointId: string;
  cleanup: () => Promise<void>;
}

async function seedBase() : Promise<Seeded> {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "工具网关纵切测试要点",
    publicSummary: "遗忘曲线",
    front: { cue: "遗忘曲线", prompt: "什么是遗忘曲线？" },
  });
  return {
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    cardId: fixture.cardId,
    keyPointId: fixture.objectiveId,
    cleanup: fixture.cleanup,
  };
}

async function createActiveRun(seeded: Seeded) {
  const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
  const run = await withWorkspaceTransaction(scope, async (tx) =>
    createLearningRunForTest(tx, {
      ...scope,
      request: {
        originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
        goal: "stabilize",
        requestedTimeBudgetSeconds: 120,
        idempotencyKey: randomUUID(),
      },
    }),
  );
  assert.equal(run.phase, "active");
  return run;
}

async function createToolProposal(
  seeded: Seeded,
  payload: { kind: string; [key: string]: unknown },
  opts: { title?: string; idempotencyKey?: string; clientMessageId?: string; sourceSurface?: "pet" | "main" } = {},
): Promise<{
  proposalId: string;
  conversationId: string;
  payloadSha256: string;
  status: string;
}> {
  const result = (await createCompanionToolProposal({
    workspaceId: seeded.workspaceId,
    userId: seeded.userId,
    body: {
      version: 1,
      clientMessageId: opts.clientMessageId ?? randomUUID(),
      payload,
      title: opts.title ?? "工具动作",
      targetSummary: "执行一次工具动作",
      impactSummary: "完成后更新对应业务状态",
      sourceSurface: opts.sourceSurface ?? "pet",
    },
    idempotencyKey: opts.idempotencyKey ?? randomUUID(),
  })) as {
    proposal: { proposalId: string; status: string; payloadSha256: string };
    conversationId: string;
  };
  assert.equal(result.proposal.status, "pending");
  return {
    proposalId: result.proposal.proposalId,
    conversationId: result.conversationId,
    payloadSha256: result.proposal.payloadSha256,
    status: result.proposal.status,
  };
}

async function confirmProposal(seeded: Seeded, proposalId: string, expectedPayloadSha256: string) {
  return decideCompanionProposal({
    workspaceId: seeded.workspaceId,
    userId: seeded.userId,
    proposalId,
    decision: "confirm",
    idempotencyKey: randomUUID(),
    expectedPayloadSha256,
  }) as Promise<{
    status: string;
    resultRef: string | null;
    route: { kind: string; keyPointId?: string; lens?: string; restoreRun?: string } | null;
    safeSummary: string | null;
  }>;
}

test("§18.1：tool proposal create——校验/原子落库/幂等重放/异 body 冲突", async () => {
  const seeded = await seedBase();
  try {
    const keyPointId = seeded.keyPointId;
    // 非法 payload → 400 INVALID_REQUEST（不落库）
    await assert.rejects(
      () =>
        createCompanionToolProposal({
          workspaceId: seeded.workspaceId,
          userId: seeded.userId,
          body: {
            version: 1,
            clientMessageId: randomUUID(),
            payload: { kind: "focus_graph_node" } as never,
            title: "t",
            targetSummary: "s",
            impactSummary: "i",
            sourceSurface: "pet",
          },
          idempotencyKey: randomUUID(),
        }),
      (err: unknown) =>
        err instanceof CompanionConversationError && err.code === "INVALID_REQUEST",
    );

    const idempotencyKey = randomUUID();
    const clientMessageId = randomUUID();
    const payload = { kind: "focus_graph_node", keyPointId, lens: "evidence" };
    const first = await createToolProposal(seeded, payload, { idempotencyKey, clientMessageId });
    // 幂等重放：同 key 同 body（含 clientMessageId）→ 同 proposalId
    const replay = await createToolProposal(seeded, payload, { idempotencyKey, clientMessageId });
    assert.equal(replay.proposalId, first.proposalId);
    // 异 body 同 key → 409
    await assert.rejects(
      () =>
        createToolProposal(seeded, { kind: "focus_graph_node", keyPointId, lens: "provenance" }, { idempotencyKey }),
      (err: unknown) =>
        err instanceof CompanionConversationError && err.code === "IDEMPOTENCY_CONFLICT",
    );

    // 双消息 + proposal + action.proposed 事件落库
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const msgs = await tx`SELECT role, kind FROM companion_messages
        WHERE conversation_id = ${first.conversationId} ORDER BY seq`;
      const ev = await tx`SELECT type FROM companion_stream_events
        WHERE conversation_id = ${first.conversationId} AND type = 'action.proposed'`;
      return { msgs, ev };
    });
    assert.equal(rows.msgs.length, 2);
    assert.equal(rows.msgs[0].role, "user");
    assert.equal(rows.msgs[1].role, "assistant");
    assert.equal(rows.ev.length, 1);
  } finally {
    await seeded.cleanup();
  }
});

test("§18.1：main 发起 proposal → inbox 投递 proposal；confirm → 投递 action_result", async () => {
  const seeded = await seedBase();
  try {
    const keyPointId = seeded.keyPointId;
    const proposal = await createToolProposal(
      seeded,
      { kind: "focus_graph_node", keyPointId, lens: "evidence" },
      { sourceSurface: "main" },
    );

    // main 发起的 proposal 需要推送到 pet inbox。
    const proposalDeliveries = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      return tx`SELECT kind, payload_ref FROM assistant_deliveries
        WHERE workspace_id = ${seeded.workspaceId} AND user_id = ${seeded.userId}
          AND dedupe_key = ${`proposal:${proposal.proposalId}`}`;
    });
    assert.equal(proposalDeliveries.length, 1, "proposal delivery 已投递");
    assert.equal(proposalDeliveries[0].kind, "proposal");
    assert.equal(proposalDeliveries[0].payload_ref.proposalId, proposal.proposalId);

    const result = await confirmProposal(seeded, proposal.proposalId, proposal.payloadSha256);
    assert.equal(result.status, "succeeded");
    const actionDeliveries = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      return tx`SELECT kind, payload_ref FROM assistant_deliveries
        WHERE workspace_id = ${seeded.workspaceId} AND user_id = ${seeded.userId}
          AND dedupe_key = ${`action_result:${proposal.proposalId}`}`;
    });
    assert.equal(actionDeliveries.length, 1, "action_result delivery 已投递");
    assert.equal(actionDeliveries[0].kind, "action_result");
    assert.equal(actionDeliveries[0].payload_ref.proposalId, proposal.proposalId);
  } finally {
    await seeded.cleanup();
  }
});

test("§18.1：focus_graph_node——confirm 导航同步 succeeded + route", async () => {
  const seeded = await seedBase();
  try {
    const keyPointId = seeded.keyPointId;
    const proposal = await createToolProposal(seeded, { kind: "focus_graph_node", keyPointId, lens: "evidence" });
    const result = await confirmProposal(seeded, proposal.proposalId, proposal.payloadSha256);
    assert.equal(result.status, "succeeded");
    assert.equal(result.route?.kind, "star_map");
    assert.equal(result.route?.keyPointId, keyPointId);
    assert.equal(result.route?.lens, "evidence");
    assert.equal(result.resultRef, null);
    const actionDeliveries = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      return tx`SELECT kind, payload_ref FROM assistant_deliveries
        WHERE workspace_id = ${seeded.workspaceId} AND user_id = ${seeded.userId}
          AND dedupe_key = ${`action_result:${proposal.proposalId}`}`;
    });
    assert.equal(actionDeliveries.length, 1, "pet 发起 confirm 也会投递 action_result");
    assert.equal(actionDeliveries[0].payload_ref.proposalId, proposal.proposalId);
  } finally {
    await seeded.cleanup();
  }
});

test("§18.1：restore_graph_viewport / open_conversation_history——导航同步 succeeded", async () => {
  const seeded = await seedBase();
  try {
    const run = await createActiveRun(seeded);
    const restore = await createToolProposal(seeded, { kind: "restore_graph_viewport", runId: run.runId });
    const restoreResult = await confirmProposal(seeded, restore.proposalId, restore.payloadSha256);
    assert.equal(restoreResult.status, "succeeded");
    assert.equal(restoreResult.route?.kind, "star_map");
    assert.equal(restoreResult.route?.restoreRun, run.runId);

    const history = await createToolProposal(seeded, { kind: "open_conversation_history" });
    const historyResult = await confirmProposal(seeded, history.proposalId, history.payloadSha256);
    assert.equal(historyResult.status, "succeeded");
    assert.equal(historyResult.route?.kind, "conversation");
  } finally {
    await seeded.cleanup();
  }
});

test("§18.1：pause_learning_run——confirm 真实暂停 Run + resultRef=runId", async () => {
  const seeded = await seedBase();
  try {
    const run = await createActiveRun(seeded);
    const proposal = await createToolProposal(seeded, { kind: "pause_learning_run", runId: run.runId });
    const result = await confirmProposal(seeded, proposal.proposalId, proposal.payloadSha256);
    assert.equal(result.status, "succeeded");
    assert.equal(result.resultRef, run.runId);
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      return tx`SELECT phase FROM learning_runs WHERE id = ${run.runId}`;
    });
    assert.equal(rows[0].phase, "paused");
  } finally {
    await seeded.cleanup();
  }
});

test("§18.1：request_hint_level——confirm 后 exposure-first（事件 + revision 递增）", async () => {
  const seeded = await seedBase();
  try {
    const run = await createActiveRun(seeded);
    assert.ok(run.activeTask, "active task present");
    const proposal = await createToolProposal(seeded, {
      kind: "request_hint_level",
      runId: run.runId,
      taskId: run.activeTask!.taskId,
      level: 1,
    });
    const result = await confirmProposal(seeded, proposal.proposalId, proposal.payloadSha256);
    assert.equal(result.status, "succeeded");
    assert.equal(result.resultRef, run.runId);
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const ev = await tx`SELECT event_type, payload FROM learning_run_events
        WHERE run_id = ${run.runId} AND event_type = 'learning_task.hint_requested'`;
      const runRow = await tx`SELECT revision FROM learning_runs WHERE id = ${run.runId}`;
      return { ev, revision: Number(runRow[0].revision) };
    });
    assert.equal(rows.ev.length, 1);
    assert.ok(rows.revision > 1);
  } finally {
    await seeded.cleanup();
  }
});

test("§18.1：switch_task_variant——confirm 切换 active variant", async () => {
  const seeded = await seedBase();
  try {
    const run = await createActiveRun(seeded);
    assert.ok(run.activeTask, "active task present");
    assert.ok(run.activeTask!.availableAlternatives.length >= 1);
    const alternativeId = run.activeTask!.availableAlternatives[0].alternativeId;
    const proposal = await createToolProposal(seeded, {
      kind: "switch_task_variant",
      runId: run.runId,
      taskId: run.activeTask!.taskId,
      alternativeId,
    });
    const result = await confirmProposal(seeded, proposal.proposalId, proposal.payloadSha256);
    assert.equal(result.status, "succeeded");
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      return tx`SELECT status FROM learning_task_variants WHERE id = ${alternativeId}`;
    });
    assert.equal(rows[0].status, "active");
  } finally {
    await seeded.cleanup();
  }
});

test("§18.1：defer_review——只写展示层，不改 official dueAt；generation 不匹配 409", async () => {
  const seeded = await seedBase();
  try {
    const scheduleId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      await tx`INSERT INTO review_schedules
               (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at, interval_days, generation)
               VALUES (${scheduleId}, ${seeded.workspaceId}, ${seeded.userId}, 'card', ${seeded.cardId},
                       'pending', now() + interval '2 days', 1, 0)`;
    });
    const deferredUntil = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const proposal = await createToolProposal(seeded, {
      kind: "defer_review",
      scheduleId,
      scheduleGeneration: 0,
      deferredUntil,
      reasonCode: "user_requested",
    });
    const result = await confirmProposal(seeded, proposal.proposalId, proposal.payloadSha256);
    assert.equal(result.status, "succeeded");
    assert.equal(result.resultRef, scheduleId);
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      return tx`SELECT user_deferred_until, next_review_at, status FROM review_schedules WHERE id = ${scheduleId}`;
    });
    assert.ok(rows[0].user_deferred_until !== null, "展示层延后已写");
    assert.equal(rows[0].status, "pending", "schedule 未被消费");
    assert.equal(
      new Date(rows[0].user_deferred_until).getTime(),
      new Date(deferredUntil).getTime(),
    );

    // generation 不匹配 → 409 ACTION_STALE
    const staleProposal = await createToolProposal(seeded, {
      kind: "defer_review",
      scheduleId,
      scheduleGeneration: 1,
      deferredUntil,
      reasonCode: "temporary_unavailable",
    });
    await assert.rejects(
      () => confirmProposal(seeded, staleProposal.proposalId, staleProposal.payloadSha256),
      (err: unknown) =>
        err instanceof CompanionConversationError && err.code === "ACTION_STALE",
    );
  } finally {
    await seeded.cleanup();
  }
});

test("§18.1：plan_understanding_route——confirm 创建真实 RoutePlan + resultRef=routePlanId", async () => {
  const seeded = await seedBase();
  try {
    const token = issueCheckpointToken({
      workspaceId: seeded.workspaceId,
      userId: seeded.userId,
      lastCanonicalEventId: null,
      lastPracticeEventId: null,
      capturedAt: new Date().toISOString(),
    });
    assert.ok(token, "checkpoint token 已签发（测试密钥在位）");
    const proposal = await createToolProposal(seeded, {
      kind: "plan_understanding_route",
      request: {
        version: 1,
        intent: "repair_gap",
        targetKeyPointId: seeded.keyPointId,
        maxSteps: 3,
        lens: "current_target",
        filter: { showArchived: false },
        expectedCheckpointToken: token!,
        idempotencyKey: `tg-plan-${randomUUID()}`,
      },
    });
    const result = await confirmProposal(seeded, proposal.proposalId, proposal.payloadSha256);
    assert.equal(result.status, "succeeded");
    assert.ok(result.resultRef, "resultRef = routePlanId");
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      return tx`SELECT intent FROM understanding_route_plans WHERE id = ${result.resultRef}`;
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].intent, "repair_gap");
  } finally {
    await seeded.cleanup();
  }
});

test("§18.1：记忆候选 confirm/reject——revision CAS；stale revision 409", async () => {
  const seeded = await seedBase();
  try {
    // 候选记忆由已落地的写入路径产生（worker memory-extractor 与本测试使用的是
    // 同一个 upsertMemory 入口）。propose_memory_candidate proposal 已删除：它要求
    // 调用方提供由服务端在创建事务内生成的 sourceMessageId，任何 producer 都无法
    // 满足，因此不再作为候选记忆的来源。
    const memory = await withWorkspaceTransaction(
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      (tx) => upsertMemory(tx, { workspaceId: seeded.workspaceId, userId: seeded.userId }, {
        kind: "preference",
        content: "喜欢在安静时段学习",
        sourceEventId: `memory-extract:${randomUUID()}:0`,
        candidate: true,
      }),
    );
    const memoryId = memory.memoryItemId;
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      return tx`SELECT candidate, user_confirmed, updated_at FROM assistant_memory_items WHERE id = ${memoryId}`;
    });
    assert.equal(rows[0].candidate, true);
    assert.equal(rows[0].user_confirmed, false);
    const revision = new Date(rows[0].updated_at).getTime();

    // 正确 revision → 确认成功
    const confirmProposalRow = await createToolProposal(seeded, {
      kind: "confirm_or_reject_memory",
      memoryId,
      revision,
      decision: "confirm",
    });
    const confirmed = await confirmProposal(seeded, confirmProposalRow.proposalId, confirmProposalRow.payloadSha256);
    assert.equal(confirmed.status, "succeeded");
    const after = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      return tx`SELECT candidate, user_confirmed FROM assistant_memory_items WHERE id = ${memoryId}`;
    });
    assert.equal(after[0].candidate, false);
    assert.equal(after[0].user_confirmed, true);

    // stale revision → 409 ACTION_STALE
    const staleProposal = await createToolProposal(seeded, {
      kind: "delete_assistant_memory",
      memoryId,
      revision: revision - 1,
    });
    await assert.rejects(
      () => confirmProposal(seeded, staleProposal.proposalId, staleProposal.payloadSha256),
      (err: unknown) =>
        err instanceof CompanionConversationError && err.code === "ACTION_STALE",
    );
  } finally {
    await seeded.cleanup();
  }
});
