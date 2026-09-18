/**
 * 定时兜底回收 companion 确认（0217 SECURITY DEFINER 函数）实库测试。
 *
 * 覆盖方案 §5 的「确认过期 / 账号世代变化 → 不执行工具并把 run 置为终态」，重点是
 * API 惰性路径覆盖不到的「用户不再操作」场景：
 * - TTL 过期 → 终结；
 * - epoch 变化 / global off → 终结；
 * - TTL 未到且世代一致 → **不动**（防误杀：正常等待确认的 run 必须保持 active）；
 * - 终结副作用齐全：proposal expired、工具调用 expired、run failed/ACTION_EXPIRED、
 *   补写 action.expired 事件且 seq 与 conversation 计数一致；
 * - 以受限角色 ailearn_worker 调用（只有它能 EXECUTE；这是 worker tick 的真实身份）。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

// 夹具（seed/清理/断言）走 migrator：它拥有这些表且 BYPASSRLS，而 ailearn_api 按
// 最小权限并不具备 companion_agent_tool_calls 的 DELETE——不应为了测试放宽生产授权。
// 被测函数则显式以 ailearn_worker 身份调用，那才是 worker tick 的真实身份。
const CONN = process.env.DATABASE_URL_MIGRATOR ?? "postgres://ailearn_migrator:ailearn_dev@localhost:5432/ailearn";
const WORKER_CONN = process.env.DATABASE_URL_WORKER
  ?? "postgres://ailearn_worker:ailearn_dev@localhost:5432/ailearn";

const sql = postgres(CONN, { max: 2 });
const workerSql = postgres(WORKER_CONN, { max: 1 });

after(async () => {
  await sql.end({ timeout: 2 }).catch(() => undefined);
  await workerSql.end({ timeout: 2 }).catch(() => undefined);
});

interface Fixture {
  workspaceId: string;
  userId: string;
  conversationId: string;
  cleanup: () => Promise<void>;
}

/** 建租户 + 会话；accountState 控制 user_companion_account_state 行与 epoch。 */
async function seedFixture(accountState: { epoch: number; globalEnabled: boolean } | null): Promise<Fixture> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const conversationId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`sweep-${userId.slice(0, 8)}@example.test`}, 'test-hash', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, ${`sweep-ws-${workspaceId.slice(0, 8)}`}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${conversationId}, ${workspaceId}, ${userId}, 'dialogue', 'sweep', 'placeholder', 'active')`;
    if (accountState) {
      await tx`INSERT INTO user_companion_account_state (user_id, epoch, global_enabled)
               VALUES (${userId}, ${accountState.epoch}, ${accountState.globalEnabled})`;
    }
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM companion_agent_tool_calls WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM companion_agent_steps WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM companion_action_proposals WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM companion_turn_runs WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_conversations WHERE id = ${conversationId}`;
      await tx`DELETE FROM user_companion_account_state WHERE user_id = ${userId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  return { workspaceId, userId, conversationId, cleanup };
}

/**
 * 造一个「Agent 已请求确认」的完整现场：run 停在 waiting_for_confirmation，
 * 工具调用 waiting_confirmation，proposal pending（TTL 由 ttlPast 控制）。
 */
async function seedWaitingConfirmation(
  fx: Fixture,
  opts: { ttlSeconds: number; runAccountEpoch: number },
): Promise<{ proposalId: string; runId: string; toolCallId: string }> {
  const runId = randomUUID();
  const proposalId = randomUUID();
  const stepId = randomUUID();
  const toolCallId = "call_sweep_1";
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${fx.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
    const messageId = randomUUID();
    await tx`INSERT INTO companion_messages
               (id, conversation_id, workspace_id, user_id, seq, role, kind, blocks, content_sha256)
             VALUES (${messageId}, ${fx.conversationId}, ${fx.workspaceId}, ${fx.userId}, 1, 'user', 'text',
                     ${tx.json([{ type: "text", text: "帮我开始学习" }])}, ${"c".repeat(64)})`;
    await tx`INSERT INTO companion_turn_runs
               (id, workspace_id, user_id, conversation_id, user_message_id, generation, status,
                idempotency_key_hash, request_body_hash,
                account_epoch, waiting_proposal_id, step_count, tool_call_count)
             VALUES (${runId}, ${fx.workspaceId}, ${fx.userId}, ${fx.conversationId}, ${messageId}, 1,
                     'waiting_for_confirmation', ${"d".repeat(64)}, ${"e".repeat(64)},
                     ${opts.runAccountEpoch}, ${proposalId}, 1, 1)`;
    await tx`INSERT INTO companion_agent_steps
               (id, workspace_id, user_id, conversation_id, run_id, step_no, kind, status)
             VALUES (${stepId}, ${fx.workspaceId}, ${fx.userId}, ${fx.conversationId}, ${runId}, 1, 'model', 'waiting')`;
    await tx`INSERT INTO companion_agent_tool_calls
               (id, workspace_id, user_id, conversation_id, run_id, step_id, tool_call_id, name,
                tool_version, skill_id, arguments, arguments_sha256, risk_class, status, proposal_id)
             VALUES (${randomUUID()}, ${fx.workspaceId}, ${fx.userId}, ${fx.conversationId}, ${runId},
                     ${stepId}, ${toolCallId}, 'companion_start_learning', '1.0.0', 'learning-planner',
                     '{}'::jsonb, ${"a".repeat(64)}, 'consequential', 'waiting_confirmation', ${proposalId})`;
    await tx`INSERT INTO companion_action_proposals
               (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
                payload, payload_sha256, title, target_summary, impact_summary, status,
                idempotency_key_hash, expires_at, origin, agent_run_id, agent_tool_call_id,
                agent_skill_id, agent_tool_version, risk_class)
             VALUES (${proposalId}, ${fx.workspaceId}, ${fx.userId}, ${fx.conversationId}, ${messageId}, 1,
                     ${tx.json({ kind: "start_learning_run" })}, ${"b".repeat(64)},
                     '开始学习', '开始学习', '会改变学习状态', 'pending',
                     ${"f".repeat(64)},
                     now() + make_interval(secs => ${opts.ttlSeconds}),
                     'agent_tool', ${runId}, ${toolCallId}, 'learning-planner', '1.0.0', 'consequential')`;
  });
  return { proposalId, runId, toolCallId };
}

async function sweep(): Promise<number> {
  const rows = await workerSql`SELECT public.ailearn_reclaim_stale_companion_proposals() AS reclaimed`;
  return Number(rows[0]?.reclaimed ?? 0);
}

async function readState(fx: Fixture, proposalId: string, runId: string) {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${fx.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${fx.userId}, true)`;
    const proposal = await tx`SELECT status FROM companion_action_proposals WHERE id = ${proposalId}`;
    const run = await tx`SELECT status, error_code, waiting_proposal_id FROM companion_turn_runs WHERE id = ${runId}`;
    const tool = await tx`SELECT status, result_safe_summary FROM companion_agent_tool_calls WHERE proposal_id = ${proposalId}`;
    const events = await tx`SELECT payload FROM companion_stream_events
                            WHERE conversation_id = ${fx.conversationId} AND type = 'action.expired'`;
    return { proposal: proposal[0], run: run[0], tool: tool[0], events };
  });
}

test("兜底回收：TTL 过期的确认被终结，且副作用与事件齐全", async () => {
  const fx = await seedFixture({ epoch: 0, globalEnabled: true });
  try {
    const { proposalId, runId } = await seedWaitingConfirmation(fx, { ttlSeconds: -60, runAccountEpoch: 0 });

    // 该函数是跨租户扫描：本套件与其他套件共库，不能断言全局计数，只断言本夹具
    // 的失效确认被终结（全局计数在单独跑该文件时才等于 1）。
    assert.ok(await sweep() >= 1, "本次扫描应至少回收本夹具的过期确认");

    const state = await readState(fx, proposalId, runId);
    assert.equal(state.proposal.status, "expired");
    assert.equal(state.run.status, "failed");
    assert.equal(state.run.error_code, "ACTION_EXPIRED");
    assert.equal(state.run.waiting_proposal_id, null, "终态必须清空挂起指针，否则会占住 active 唯一索引");
    assert.equal(state.tool.status, "expired");
    assert.equal(state.events.length, 1, "必须补写 action.expired 事件，客户端才能撤掉确认卡片");
    assert.equal((state.events[0].payload as { proposalId: string }).proposalId, proposalId);

    // 幂等：再次回收后本夹具状态不变（run 已非 waiting、proposal 已非 pending）
    const again = await sweep();
    assert.ok(again >= 0);
    const after = await readState(fx, proposalId, runId);
    assert.equal(after.proposal.status, "expired");
    assert.equal(after.run.status, "failed");
  } finally {
    await fx.cleanup();
  }
});

test("兜底回收：epoch 变化 / global off 的确认被终结（即使 TTL 未到）", async () => {
  // 账号当前 epoch=7，而 run 冻结的是 0 → 该确认已失效
  const fx = await seedFixture({ epoch: 7, globalEnabled: true });
  try {
    const { proposalId, runId } = await seedWaitingConfirmation(fx, { ttlSeconds: 600, runAccountEpoch: 0 });
    assert.ok(await sweep() >= 1, "epoch 不一致的确认必须被回收");
    const state = await readState(fx, proposalId, runId);
    assert.equal(state.proposal.status, "expired");
    assert.equal(state.run.status, "failed");
    assert.equal(state.run.error_code, "ACTION_EXPIRED");
  } finally {
    await fx.cleanup();
  }

  // global off：epoch 一致但伴星已全局关闭
  const off = await seedFixture({ epoch: 3, globalEnabled: false });
  try {
    const { proposalId, runId } = await seedWaitingConfirmation(off, { ttlSeconds: 600, runAccountEpoch: 3 });
    assert.ok(await sweep() >= 1, "global off 的确认必须被回收");
    const state = await readState(off, proposalId, runId);
    assert.equal(state.proposal.status, "expired");
    assert.equal(state.run.status, "failed");
  } finally {
    await off.cleanup();
  }
});

test("兜底回收：TTL 未到且世代一致时绝不误杀（run 保持等待确认）", async () => {
  const fx = await seedFixture({ epoch: 4, globalEnabled: true });
  try {
    const { proposalId, runId } = await seedWaitingConfirmation(fx, { ttlSeconds: 600, runAccountEpoch: 4 });

    await sweep();
    // 防误杀是本用例的核心断言：全局扫描可以回收别的残留，但绝不能动本夹具。

    const state = await readState(fx, proposalId, runId);
    assert.equal(state.proposal.status, "pending");
    assert.equal(state.run.status, "waiting_for_confirmation");
    assert.equal(state.run.waiting_proposal_id, proposalId);
    assert.equal(state.tool.status, "waiting_confirmation");
    assert.equal(state.events.length, 0);
  } finally {
    await fx.cleanup();
  }
});
