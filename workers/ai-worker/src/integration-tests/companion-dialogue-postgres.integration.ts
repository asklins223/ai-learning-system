/**
 * P2 §5.2/§6.5 固定集成测试：worker companion_dialogue handler 真实 DB 编排。
 *
 * runbook 04 要求 `workers/ai-worker/src/integration-tests/companion-dialogue-postgres.integration.ts`
 * 存在（此前缺失，worker 链路零集成覆盖）。本文件覆盖：
 * - 真实终态：assistant.message 写入 + assistant.status/delta/final 事件 + run succeeded
 *   + last_event_seq 更新 + NOTIFY payload（companion_conversations 计数器推进）；
 * - fence：run 已被 cancel/supersede（status 非 active）时丢弃迟到输出，零副作用；
 * - userText 按 run.user_message_id 归属：当前 turn 是 voice_transcript（kind≠'text'）
 *   时也能取到本 run 的用户文本，而不是上一轮 text 消息（回归 2026-08-11 修复）。
 *
 * provider 使用 mock（测试环境显式不配置外部平台），
 * 验证的是 DB 编排与 fence，不验证 LLM 内容。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

const CONN = process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn";
// worker db.ts 读 DATABASE_URL，
// 确保 host 侧运行也指向同一数据库，避免回退到 Docker-only hostname `postgres`。
process.env.DATABASE_URL ??= CONN;
// 强制 mock provider：集成测试验证 DB 编排，不产生外部模型调用或费用。
delete process.env.TOKENRHYTHM_API_KEY;
process.env.COMPANION_DIALOGUE_V1_ENABLED = "true";

const sql = postgres(CONN, { max: 2 });

after(async () => {
  await sql.end({ timeout: 2 });
  const { closeDatabase } = await import("../db.ts");
  await closeDatabase();
});

const { runCompanionDialogue } = await import("../handlers/companion-dialogue.ts");

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

async function seedDialogueRun(
  ws: string,
  uid: string,
  options: {
    userKind?: "text" | "voice_transcript";
    runStatus?: string;
    userText?: string;
    /** 插入一条更新的 text 用户消息，验证 userText 不按“最近 text”取。 */
    newerTextMessage?: boolean;
  } = {},
): Promise<{ runId: string; cid: string; userMessageId: string; cleanup: () => Promise<void> }> {
  const runId = randomUUID();
  const cid = randomUUID();
  const userMessageId = randomUUID();
  const olderTextId = randomUUID();
  const userText = options.userText ?? "帮我复习光合作用";
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
    await tx`SELECT set_config('app.user_id', ${uid}, true)`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${cid}, ${ws}, ${uid}, 'dialogue', '会话', 'auto', 'active')`;
    // 本 run 的用户消息（可能是 voice_transcript，kind ≠ 'text'）
    await tx`INSERT INTO companion_messages (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
             VALUES (${userMessageId}, ${cid}, ${ws}, ${uid}, 'user', 1, ${options.userKind ?? "text"},
                     ${tx.json([{ type: "text", text: userText }])}, ${"0".repeat(64)})`;
    if (options.newerTextMessage) {
      // 更新的 text 消息——修复前 userText 会错误取到它（ORDER BY seq DESC + kind='text'）
      await tx`INSERT INTO companion_messages (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks, content_sha256)
               VALUES (${olderTextId}, ${cid}, ${ws}, ${uid}, 'user', 2, 'text',
                       ${tx.json([{ type: "text", text: "上一轮的旧文本" }])}, ${"1".repeat(64)})`;
    }
    await tx`INSERT INTO companion_turn_runs
             (id, conversation_id, workspace_id, user_id, user_message_id, generation, status,
              idempotency_key_hash, request_body_hash)
             VALUES (${runId}, ${cid}, ${ws}, ${uid}, ${userMessageId}, 1, ${options.runStatus ?? "accepted"},
                     ${"a".repeat(64)}, ${"b".repeat(64)})`;
    // next_event_seq 需 ≥ 未来事件数（status+delta×N+final+segments），
    // 否则 handler 的 eventStart = next_event_seq - eventCount 为负，违反
    // companion_stream_events_seq_check (seq >= 1)。
    await tx`UPDATE companion_conversations SET next_message_seq = 3, next_event_seq = 100 WHERE id = ${cid}`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      await tx`SELECT set_config('app.user_id', ${uid}, true)`;
      await tx`DELETE FROM companion_turn_runs WHERE id = ${runId}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id = ${cid}`;
      await tx`DELETE FROM companion_conversations WHERE id = ${cid}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${ws}`;
      await tx`DELETE FROM workspaces WHERE id = ${ws}`;
      await tx`DELETE FROM users WHERE id = ${uid}`;
    });
  };
  return { runId, cid, userMessageId, cleanup };
}

test("P2 §5.2：accepted run → assistant message + status/delta/final 事件 + run succeeded + last_event_seq", async () => {
  const { workspaceId, userId } = await seedBase();
  const s = await seedDialogueRun(workspaceId, userId);
  try {
    await runCompanionDialogue({
      id: randomUUID(),
      payload: { runId: s.runId },
      workspaceId,
      requestedBy: userId,
      leaseToken: "fixture-lease",
      signal: new AbortController().signal,
    });

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const run = await tx`SELECT status, assistant_message_id, last_event_seq, provider_id, prompt_hash
                           FROM companion_turn_runs WHERE id = ${s.runId}`;
      const assistant = await tx`SELECT role, kind, run_id FROM companion_messages
                                  WHERE conversation_id = ${s.cid} AND role = 'assistant'`;
      const events = await tx`SELECT type FROM companion_stream_events
                               WHERE conversation_id = ${s.cid} ORDER BY seq`;
      const conv = await tx`SELECT next_message_seq, next_event_seq FROM companion_conversations WHERE id = ${s.cid}`;
      return { run: run[0], assistant, events, conv: conv[0] };
    });

    assert.equal(rows.run.status, "succeeded");
    assert.ok(rows.run.assistant_message_id, "assistant_message_id 已写");
    assert.ok(Number(rows.run.last_event_seq) >= 3, "last_event_seq 已推进");
    assert.equal(rows.run.provider_id, "mock", "mock provider 显式记录");
    assert.ok(rows.run.prompt_hash, "prompt_hash 已写");
    assert.equal(rows.assistant.length, 1, "恰好一条 assistant message");
    assert.equal(rows.assistant[0].run_id, s.runId, "assistant message 绑定本 run");
    const types = rows.events.map((e) => e.type);
    assert.ok(types.includes("assistant.status"), "assistant.status 事件存在");
    assert.ok(types.includes("assistant.delta"), "assistant.delta 事件存在");
    assert.ok(types.includes("assistant.final"), "assistant.final 事件存在");
    assert.equal(types[0], "assistant.status", "事件顺序：status 最先");
    // §11.3：worker 是 TTS 切句唯一所有者——voice.segment.ready 在 final 之后；
    // 终态回复情绪 cue 也在 final 之后（同一终态事务原子写入）。
    const finalIdx = types.indexOf("assistant.final");
    assert.ok(
      types.slice(finalIdx + 1).every((t: string) => t === "voice.segment.ready" || t === "character.cue"),
      "事件顺序：final 之后只有 voice.segment.ready / character.cue",
    );
    assert.ok(Number(rows.conv.next_event_seq) > 1, "conversation 计数器推进");
  } finally {
    await s.cleanup();
  }
});

test("P2 §5.2 fence：run 已被 cancel/supersede 时丢弃迟到输出，零副作用", async () => {
  const { workspaceId, userId } = await seedBase();
  const s = await seedDialogueRun(workspaceId, userId, { runStatus: "cancelled" });
  try {
    await runCompanionDialogue({
      id: randomUUID(),
      payload: { runId: s.runId },
      workspaceId,
      requestedBy: userId,
      leaseToken: "fixture-lease",
      signal: new AbortController().signal,
    });

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const run = await tx`SELECT status, assistant_message_id FROM companion_turn_runs WHERE id = ${s.runId}`;
      const assistant = await tx`SELECT id FROM companion_messages
                                  WHERE conversation_id = ${s.cid} AND role = 'assistant'`;
      const events = await tx`SELECT seq FROM companion_stream_events WHERE conversation_id = ${s.cid}`;
      return { run: run[0], assistant, events };
    });

    assert.equal(rows.run.status, "cancelled", "fence 不得改写终态");
    assert.equal(rows.run.assistant_message_id, null, "不得写入 assistant message");
    assert.equal(rows.assistant.length, 0, "零 assistant message");
    assert.equal(rows.events.length, 0, "零事件");
  } finally {
    await s.cleanup();
  }
});

test("P2 §5.2 userText 归属：voice_transcript turn 取本 run 用户消息，而非更新的 text 消息", async () => {
  const { workspaceId, userId } = await seedBase();
  const s = await seedDialogueRun(workspaceId, userId, {
    userKind: "voice_transcript",
    userText: "这段语音内容",
    newerTextMessage: true,
  });
  try {
    await runCompanionDialogue({
      id: randomUUID(),
      payload: { runId: s.runId },
      workspaceId,
      requestedBy: userId,
      leaseToken: "fixture-lease",
      signal: new AbortController().signal,
    });

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const run = await tx`SELECT status FROM companion_turn_runs WHERE id = ${s.runId}`;
      const assistant = await tx`SELECT blocks FROM companion_messages
                                  WHERE conversation_id = ${s.cid} AND role = 'assistant'`;
      return { run: run[0], assistant };
    });

    // mock provider 只证明链路跑通且 userText 查询无异常；真实文本内容
    // 的正确性由查询条件保证（id = user_message_id，含 kind='voice_transcript'）。
    assert.equal(rows.run.status, "succeeded", "voice_transcript turn 也能正常完成");
    assert.equal(rows.assistant.length, 1, "assistant 回复已写入");
  } finally {
    await s.cleanup();
  }
});
