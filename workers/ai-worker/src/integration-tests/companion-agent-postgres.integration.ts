/**
 * Companion Agent 运行时实库集成测试（方案《将 AI 伴星升级为可扩展 Agent》§1–§6）。
 *
 * 覆盖 Agent loop 的真实 DB 编排（provider 用 mock，不产生外部模型调用）：
 * - 模型不调工具 → 单步、零工具审计行；
 * - 模型调工具 → 有限循环、审计行落库、`agent.tool` SSE 事件符合共享合同；
 *   （判据是 `tool_call_count`，不是曾经那个"选中了哪个技能/哪种执行模式"的读数——
 *    技能层已整条删除，工具面每轮全给。）
 * - 确认续跑：run 停在 waiting_for_confirmation 并冻结 proposal → 带 proposalId 重新入队 →
 *   loadContinuation 回填结果 → 同一次 run 产出最终答复（不做新用户对话）；
 * - 执行预算耗尽：agent_elapsed_ms 已达 120s → 直接终结，不再调用 provider；
 * - epoch 失效：run 冻结的 epoch 与当前不一致 → 拒绝执行且零副作用。
 *
 * 这些是方案验收清单里"确认后继续同一次 run""超过预算安全终止""global off/epoch
 * 变化拒绝迟到结果"的实库证据。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
process.env.DATABASE_URL ??= CONN;
// 强制 mock provider：验证 DB 编排与预算/fence，不产生外部模型调用或费用。
delete process.env.TOKENRHYTHM_API_KEY;
/**
 * 2026-09-15 修复：本用例此前会**继承开发者的真实平台配置**
 * （AI_PLATFORMS_CONFIG → config/ai-platforms.json），于是
 * resolveAIGovernanceContext 判定 anyExternalNonMock=true 并要求 workspace 签署
 * AI 同意书；fixture 没有签，companion-dialogue 的同意门（HEAD 既有行为，
 * 会 markCompanionRunFailed("AI_CONSENT_REQUIRED")）就把 8 个用例里的 5 个打挂。
 * 本用例测的是 agent 编排，不是 provider 接线，因此与其他 worker 集成测试一样
 * 把平台配置钉成 mock（mock 在治理层天然豁免同意门），从而与环境无关。
 */
delete process.env.AI_PLATFORMS_CONFIG;
process.env.COMPANION_DIALOGUE_V1_ENABLED = "true";

const sql = postgres(CONN, { max: 2 });

after(async () => {
  await sql.end({ timeout: 2 }).catch(() => undefined);
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase();
});

const { runCompanionDialogue } = await import("../handlers/companion-dialogue.ts");
const { ensureAgentToolCall, loadContinuation } = await import("../handlers/companion-agent-runtime.ts");
const { companionStreamEventV1Schema, getCompanionAgentTool } = await import("@ailearn/shared");

async function seedBase(): Promise<{ workspaceId: string; userId: string }> {
  const ws = randomUUID();
  const uid = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${uid}, ${`agent-${uid.slice(0, 8)}@x.test`}, 'h', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${ws}, ${"w" + ws.slice(0, 8)}, ${uid})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${ws}, ${uid}, 'owner')`;
  });
  return { workspaceId: ws, userId: uid };
}

interface Fixture {
  runId: string;
  conversationId: string;
  userMessageId: string;
  cleanup: () => Promise<void>;
}

async function seedAgentRun(
  ws: string,
  uid: string,
  opts: {
    userText: string;
    runStatus?: string;
    accountEpoch?: number;
    runAccountEpoch?: number;
    agentElapsedMs?: number;
  },
): Promise<Fixture> {
  const runId = randomUUID();
  const cid = randomUUID();
  const userMessageId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${cid}, ${ws}, ${uid}, 'dialogue', 'agent', 'auto', 'active')`;
    await tx`INSERT INTO companion_messages
               (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
             VALUES (${userMessageId}, ${cid}, ${ws}, ${uid}, 'user', 1, 'text',
                     ${tx.json([{ type: "text", text: opts.userText }])}, ${"0".repeat(64)})`;
    await tx`INSERT INTO companion_turn_runs
               (id, conversation_id, workspace_id, user_id, user_message_id, generation, status,
                idempotency_key_hash, request_body_hash, account_epoch, agent_elapsed_ms)
             VALUES (${runId}, ${cid}, ${ws}, ${uid}, ${userMessageId}, 1, ${opts.runStatus ?? "accepted"},
                     ${"a".repeat(64)}, ${"b".repeat(64)},
                     ${opts.runAccountEpoch ?? 0}, ${opts.agentElapsedMs ?? 0})`;
    await tx`UPDATE companion_conversations SET next_message_seq = 3, next_event_seq = 100 WHERE id = ${cid}`;
    // account state 决定 agent_settings(permissionLevel) 与 epoch
    await tx`INSERT INTO user_companion_account_state (user_id, epoch, global_enabled)
             VALUES (${uid}, ${opts.accountEpoch ?? 0}, true)
             ON CONFLICT (user_id) DO UPDATE SET epoch = EXCLUDED.epoch, global_enabled = true`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`DELETE FROM companion_agent_tool_calls WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_agent_steps WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_action_proposals WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id = ${cid}`;
      // turn_runs 必须早于 messages：user_message_id 外键指向 companion_messages。
      await tx`DELETE FROM companion_turn_runs WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_conversations WHERE id = ${cid}`;
      await tx`DELETE FROM user_companion_account_state WHERE user_id = ${uid}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
      await tx`DELETE FROM users WHERE id = ${uid}`;
    });
  };
  return { runId, conversationId: cid, userMessageId, cleanup };
}

function invoke(ws: string, uid: string, payload: Record<string, unknown>) {
  return runCompanionDialogue({
    id: randomUUID(),
    payload,
    workspaceId: ws,
    requestedBy: uid,
    leaseToken: "fixture-lease",
    signal: new AbortController().signal,
  });
}

async function readState(ws: string, uid: string, f: Fixture) {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    const run = await tx`SELECT status, permission_level, step_count, tool_call_count,
                                agent_elapsed_ms, waiting_proposal_id, last_event_seq
                         FROM companion_turn_runs WHERE id = ${f.runId}`;
    const assistant = await tx`SELECT id FROM companion_messages
                               WHERE conversation_id = ${f.conversationId} AND role = 'assistant'`;
    const events = await tx`SELECT type, payload, seq, conversation_id, workspace_id, run_id,
                                   generation, account_epoch, created_at
                            FROM companion_stream_events
                            WHERE conversation_id = ${f.conversationId} ORDER BY seq`;
    const toolCalls = await tx`SELECT tool_call_id, name, status, result_safe_summary
                               FROM companion_agent_tool_calls WHERE run_id = ${f.runId}`;
    const steps = await tx`SELECT step_no, kind, status, request_hash
                           FROM companion_agent_steps WHERE run_id = ${f.runId} ORDER BY step_no`;
    const proposals = await tx`SELECT id, status, origin, risk_class, agent_tool_call_id,
                                      expires_at > now() AS live
                               FROM companion_action_proposals WHERE conversation_id = ${f.conversationId}`;
    return {
      run: run[0],
      assistant,
      events,
      toolCalls,
      steps,
      proposals,
    };
  });
}

test("Agent：闲聊轮次正常收尾——有终态答复、不乱冻结确认", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "你好呀" });
  try {
    await invoke(workspaceId, userId, { runId: f.runId });
    const s = await readState(workspaceId, userId, f);

    assert.equal(s.run.status, "succeeded");
    // 这里**不再断言"闲聊不该调工具"**：工具面每轮全给（方案 29 §4.1），
    // 调不调是模型的选择。把"零工具"当不变量会反向逼系统去做无用调用——
    // 那正是 §8 作废"零工具率"这个指标时说过的同一件事。
    // 仍然要钉住的是：审计行数与 run 上的计数一致，且一句"你好呀"不许冻结任何确认。
    assert.equal(s.toolCalls.length, Number(s.run.tool_call_count), "工具审计行数必须等于 run 计数");
    assert.equal(s.proposals.length, 0, "闲聊不得冻结确认提案");
    assert.equal(s.assistant.length, 1, "产出 assistant 答复");
    const types = s.events.map((e) => (e as { type: string }).type);
    assert.ok(types.includes("assistant.final"), "闲聊也必须给出终态答复");
    // 有工具调用时才有 agent.tool 帧，且帧数与审计行数同源（不各自数一套）。
    const toolEventCalls = new Set(s.events
      .filter((e) => (e as { type: string }).type === "agent.tool")
      .map((e) => (e.payload as { tool?: { toolCallId?: string } })?.tool?.toolCallId));
    assert.equal(toolEventCalls.size, s.toolCalls.length, "工具事件覆盖的调用必须与审计行同一批");
    assert.ok(s.steps.length >= 1, "记录 model 步骤");
    assert.equal(s.steps[0].kind, "model");
    assert.ok(s.steps[0].request_hash, "步骤记录 request hash");
  } finally {
    await f.cleanup();
  }
});

test("Agent：工具循环的审计行与 agent.tool SSE 事件符合共享合同", async () => {
  const { workspaceId, userId } = await seedBase();
  // mock provider 会被指示调用 companion_read_context；工具面每轮全给，
  // 不再有"要命中哪个技能才拿得到它"这一步。
  const f = await seedAgentRun(workspaceId, userId, { userText: "看一下我的学习进度" });
  try {
    await invoke(workspaceId, userId, { runId: f.runId });
    const s = await readState(workspaceId, userId, f);

    assert.equal(s.run.status, "succeeded");
    assert.ok(s.run.step_count >= 2, "工具之后的回合才算一步完整的循环");
    assert.ok(s.run.tool_call_count >= 1, "至少执行一次工具");
    assert.ok(s.toolCalls.length >= 1, "工具调用写入审计表");
    assert.equal(s.toolCalls[0].status, "succeeded");
    assert.equal(s.toolCalls[0].name, "companion_read_context");
    assert.equal(s.assistant.length, 1, "循环结束后产出最终答复");

    const toolEvents = s.events.filter((e) => (e as { type: string }).type === "agent.tool");
    assert.ok(toolEvents.length >= 2, "agent.tool 至少有 requested + succeeded");

    // SSE 合同：每个 agent.* 事件都必须能被共享（strict）schema 解析。
    // 这里补齐 envelope 字段后校验 payload，等于端到端验证 §6 的事件合同。
    for (const event of toolEvents) {
      const parsed = companionStreamEventV1Schema.safeParse({
        version: 1,
        eventId: `${event.conversation_id}:${event.seq}`,
        seq: Number(event.seq),
        workspaceId: event.workspace_id,
        conversationId: event.conversation_id,
        runId: event.run_id,
        generation: event.generation,
        accountEpoch: event.account_epoch,
        createdAt: new Date(event.created_at).toISOString(),
        type: event.type,
        payload: event.payload,
      });
      assert.equal(parsed.success, true, `${event.type} 事件必须符合共享 SSE 合同`);
    }
    const toolPayload = toolEvents[toolEvents.length - 1].payload as { tool: { safeLabel: string } };
    assert.ok(toolPayload.tool.safeLabel.length > 0, "工具事件只暴露安全标签");
  } finally {
    await f.cleanup();
  }
});

test("Agent 确认续跑：带 proposalId 重新入队 → 同一次 run 回填结果并产出最终答复", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "看一下我的学习进度" });
  try {
    // 造出"已确认"的现场：run 停在等待确认、冻结工具调用与 proposal（decision=confirm）
    const proposalId = randomUUID();
    const stepId = randomUUID();
    const toolCallId = "call_confirmed_1";
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO companion_agent_steps
                 (id, workspace_id, user_id, conversation_id, run_id, step_no, kind, status)
               VALUES (${stepId}, ${workspaceId}, ${userId}, ${f.conversationId}, ${f.runId}, 1, 'model', 'waiting')`;
      await tx`INSERT INTO companion_agent_tool_calls
                 (id, workspace_id, user_id, conversation_id, run_id, step_id, tool_call_id, name,
                  tool_version, arguments, arguments_sha256, risk_class, status, proposal_id,
                  result_safe_summary)
               VALUES (${randomUUID()}, ${workspaceId}, ${userId}, ${f.conversationId}, ${f.runId}, ${stepId},
                       ${toolCallId}, 'companion_start_learning', '1.0.0',
                       '{}'::jsonb, ${"c".repeat(64)}, 'consequential', 'succeeded', ${proposalId},
                       '已开始学习')`;
      await tx`INSERT INTO companion_action_proposals
                 (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
                  payload, payload_sha256, title, target_summary, impact_summary, status, decision,
                  decided_at, idempotency_key_hash, expires_at, origin, agent_run_id, agent_tool_call_id,
                  agent_tool_version, risk_class)
               VALUES (${proposalId}, ${workspaceId}, ${userId}, ${f.conversationId}, ${f.userMessageId}, 1,
                       ${tx.json({ kind: "start_learning_run" })}, ${"d".repeat(64)},
                       '开始学习', '开始学习', '会改变学习状态', 'succeeded', 'confirm', now(),
                       ${"e".repeat(64)}, now() + interval '5 minutes', 'agent_tool', ${f.runId},
                       ${toolCallId}, '1.0.0', 'consequential')`;
      await tx`UPDATE companion_turn_runs
               SET status = 'waiting_for_confirmation', waiting_proposal_id = ${proposalId},
                   permission_level = 'guided', step_count = 1, tool_call_count = 1
               WHERE id = ${f.runId}`;
    });

    // 与 API 侧决定端点等价的续跑入队：payload 带 proposalId
    await invoke(workspaceId, userId, { runId: f.runId, proposalId });
    const s = await readState(workspaceId, userId, f);

    assert.equal(s.run.status, "succeeded", "续跑必须把同一次 run 带到终态");
    assert.equal(s.run.waiting_proposal_id, null, "终态清空挂起指针");
    assert.equal(s.assistant.length, 1, "续跑产出 assistant 答复");
    assert.equal(s.run.permission_level, "guided", "续跑沿用本轮冻结的权限档，不重读设置");
    assert.ok(Number(s.run.step_count) >= 2, "步骤计数在原基础上继续累计，不重置");
    const types = s.events.map((e) => (e as { type: string }).type);
    assert.ok(types.includes("assistant.final"), "续跑以 assistant.final 结束");
  } finally {
    await f.cleanup();
  }
});

/**
 * 造出「已确认」的现场：run 停在等待确认、冻结工具调用与 proposal（decision=confirm）。
 * reasoningHandles 为 null 表示 0218 之前创建的历史行（无句柄）。
 */
async function seedConfirmedProposal(
  ws: string,
  uid: string,
  f: Fixture,
  toolCallId: string,
  reasoningHandles: unknown[] | null,
): Promise<string> {
  const proposalId = randomUUID();
  const stepId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO companion_agent_steps
               (id, workspace_id, user_id, conversation_id, run_id, step_no, kind, status)
             VALUES (${stepId}, ${ws}, ${uid}, ${f.conversationId}, ${f.runId}, 1, 'model', 'waiting')`;
    await tx`INSERT INTO companion_agent_tool_calls
               (id, workspace_id, user_id, conversation_id, run_id, step_id, tool_call_id, name,
                tool_version, arguments, arguments_sha256, risk_class, status, proposal_id,
                result_safe_summary, reasoning_handles)
             VALUES (${randomUUID()}, ${ws}, ${uid}, ${f.conversationId}, ${f.runId}, ${stepId},
                     ${toolCallId}, 'companion_start_learning', '1.0.0',
                     '{}'::jsonb, ${"c".repeat(64)}, 'consequential', 'succeeded', ${proposalId},
                     '已开始学习', ${reasoningHandles === null ? null : tx.json(reasoningHandles as postgres.JSONValue)}::jsonb)`;
    await tx`INSERT INTO companion_action_proposals
               (id, workspace_id, user_id, conversation_id, source_message_id, source_generation,
                payload, payload_sha256, title, target_summary, impact_summary, status, decision,
                decided_at, idempotency_key_hash, expires_at, origin, agent_run_id, agent_tool_call_id,
                agent_tool_version, risk_class)
             VALUES (${proposalId}, ${ws}, ${uid}, ${f.conversationId}, ${f.userMessageId}, 1,
                     ${tx.json({ kind: "start_learning_run" })}, ${"d".repeat(64)},
                     '开始学习', '开始学习', '会改变学习状态', 'succeeded', 'confirm', now(),
                     ${"e".repeat(64)}, now() + interval '5 minutes', 'agent_tool', ${f.runId},
                     ${toolCallId}, '1.0.0', 'consequential')`;
    await tx`UPDATE companion_turn_runs
             SET status = 'waiting_for_confirmation', waiting_proposal_id = ${proposalId},
                 permission_level = 'guided', step_count = 1, tool_call_count = 1
             WHERE id = ${f.runId}`;
  });
  return proposalId;
}

function continuationEvent(ws: string, uid: string, f: Fixture) {
  return {
    // 这些用例只验句柄的写读往返，不执行任何受外发政策管的工具；给一个
    // 什么都不放开的约束集，让"漏传约束"在类型上就暴露，而不是运行期 undefined。
    constraints: {},
    ctx: {
      id: randomUUID(),
      payload: {},
      workspaceId: ws,
      requestedBy: uid,
      leaseToken: "fixture-lease",
      signal: new AbortController().signal,
    },
    read: {
      runId: f.runId,
      conversationId: f.conversationId,
      userId: uid,
      userMessageId: f.userMessageId,
      generation: 1,
      runStatus: "waiting_for_confirmation",
      accountEpoch: 0,
      pageContext: null,
      groundedTutorContext: null,
      userText: "",
      recentMessages: [],
      activeMemories: [],
      hereAndNow: null,
      conversationSummary: null,
      petProfile: null,
      nextMessageSeq: 3,
      nextEventSeq: 100,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

/**
 * 冷启动续跑必须从库里取回 reasoning 句柄（0218）。
 *
 * 同一 job 内多步工具循环靠进程内存透传句柄；但「用户确认 → 新 job」时消息由
 * loadContinuation 从 companion_agent_tool_calls 反建，句柄只在列里可取。
 * 取不回时，要求回传 reasoning 的模型（deepseek 思考模式）会在这一步非重试 400
 * 「The reasoning_text in the thinking mode must be passed back」。
 */
test("Agent 确认续跑：reasoning 句柄落库并在续跑消息中回传（0218）", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "看一下我的学习进度" });
  const handles = [
    { id: "rs_1", type: "reasoning", status: "completed", summary: [], encrypted_content: "enc-1" },
  ];
  try {
    const proposalId = await seedConfirmedProposal(workspaceId, userId, f, "call_rh_1", handles);
    const messages = await loadContinuation(
      continuationEvent(workspaceId, userId, f),
      [{ role: "user", content: "看一下我的学习进度" }],
      proposalId,
    );
    const assistant = messages.find((m) => m.role === "assistant");
    const tool = messages.find((m) => m.role === "tool");
    assert.ok(assistant, "续跑消息必须包含 assistant(toolCalls)");
    assert.ok(tool, "续跑消息必须包含工具结果");
    assert.deepEqual(
      assistant.toolCalls,
      [{ id: "call_rh_1", name: "companion_start_learning", arguments: {} }],
    );
    assert.deepEqual(assistant.reasoning, handles, "句柄必须从列里取回并挂回 assistant 消息");
    assert.equal(tool.toolCallId, "call_rh_1");
    assert.ok(
      messages.indexOf(assistant) < messages.indexOf(tool),
      "assistant 必须排在工具结果之前",
    );
  } finally {
    await f.cleanup();
  }
});

test("Agent 确认续跑：历史行无句柄时不注入 reasoning 字段（0218 之前的数据）", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "看一下我的学习进度" });
  try {
    const proposalId = await seedConfirmedProposal(workspaceId, userId, f, "call_rh_legacy", null);
    const messages = await loadContinuation(
      continuationEvent(workspaceId, userId, f),
      [{ role: "user", content: "看一下我的学习进度" }],
      proposalId,
    );
    const assistant = messages.find((m) => m.role === "assistant");
    assert.ok(assistant, "续跑消息必须包含 assistant(toolCalls)");
    assert.equal(assistant.reasoning, undefined, "NULL 列不得变成空数组或伪造句柄");
  } finally {
    await f.cleanup();
  }
});

test("Agent 工具调用：句柄经真实写入 SQL 落库，形状与读回一致（0218 写读往返）", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, { userText: "开始学习" });
  const handles = [
    { id: "rs_rt", type: "reasoning", status: "completed", summary: [], encrypted_content: "enc-rt" },
  ];
  try {
    const stepId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`INSERT INTO companion_agent_steps
                 (id, workspace_id, user_id, conversation_id, run_id, step_no, kind, status)
               VALUES (${stepId}, ${workspaceId}, ${userId}, ${f.conversationId}, ${f.runId}, 1,
                       'model', 'running')`;
    });
    const definition = getCompanionAgentTool("companion_start_learning");
    assert.ok(definition, "工具定义必须存在");

    // 走生产写入路径（类型检查覆盖不到列名/参数绑定，必须实库往返）
    const record = await ensureAgentToolCall(
      continuationEvent(workspaceId, userId, f),
      stepId,
      definition,
      { id: "call_rt_1", arguments: {} },
      "f".repeat(64),
      handles,
    );
    assert.equal(record.isNew, true, "首次写入必须落新行");

    const stored = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT reasoning_handles FROM companion_agent_tool_calls
                WHERE run_id = ${f.runId} AND tool_call_id = ${"call_rt_1"}`;
    });
    assert.deepEqual(
      stored[0].reasoning_handles,
      handles,
      "写入 SQL 必须把句柄原样存成 jsonb 数组（读回形状与产出一致）",
    );
  } finally {
    await f.cleanup();
  }
});

test("Agent 执行预算：agent_elapsed_ms 已达 120s → 直接终结且不调用 provider", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, {
    userText: "看一下我的学习进度",
    agentElapsedMs: 120_000,
  });
  try {
    await assert.rejects(
      invoke(workspaceId, userId, { runId: f.runId }),
      /execution budget exhausted/,
    );
    const s = await readState(workspaceId, userId, f);
    assert.equal(s.run.status, "failed", "预算耗尽必须失败关闭");
    // 被拒绝的轮次会留下**一条失败兜底答复**（fail-open：不能让用户面对空白），
    // 所以这里钉的是"没有终态答复事件"，而不是"没有 assistant 行"。
    assert.ok(!s.events.some((e) => (e as { type: string }).type === "assistant.final"),
      "被拒绝的执行不得下发终态答复");
    assert.equal(s.toolCalls.length, 0, "不得执行任何工具");
    assert.equal(s.steps.length, 0, "不得开始新步骤");
  } finally {
    await f.cleanup();
  }
});

test("Agent epoch fence：run 冻结的 epoch 与当前不一致 → 拒绝执行且零副作用", async () => {
  const { workspaceId, userId } = await seedBase();
  const f = await seedAgentRun(workspaceId, userId, {
    userText: "看一下我的学习进度",
    runAccountEpoch: 0,
    accountEpoch: 5, // 账号已换代：迟到结果必须被拒绝
  });
  try {
    await assert.rejects(
      invoke(workspaceId, userId, { runId: f.runId }),
      /epoch is stale or globally disabled/,
    );
    const s = await readState(workspaceId, userId, f);
    // 被拒绝的轮次会留下**一条失败兜底答复**（fail-open：不能让用户面对空白），
    // 所以这里钉的是"没有终态答复事件"，而不是"没有 assistant 行"。
    assert.ok(!s.events.some((e) => (e as { type: string }).type === "assistant.final"),
      "被拒绝的执行不得下发终态答复");
    assert.equal(s.toolCalls.length, 0, "epoch 失效时不得执行工具");
    assert.equal(s.proposals.length, 0, "epoch 失效时不得冻结确认");
  } finally {
    await f.cleanup();
  }
});
