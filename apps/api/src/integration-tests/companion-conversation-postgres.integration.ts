/**
 * P2 — companion conversation 原子 turn create 集成测试（03 §8.1）。
 *
 * 真实 Postgres：seed workspace/user/dialogue conversation（RLS context 内）→
 * createCompanionTurn 全流程断言 → 幂等（key/clientMessageId）→ active run
 * 规则（RUN_ALREADY_ACTIVE / supersede）。无 DB 时抛错（fail closed）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";

process.env.AUTH_SURFACE_MANIFEST_SECRET ??= "integration-test-secret";

const databaseUrl = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL_API 未配置——companion:postgres 集成测试要求真实 Postgres");
}
const sql = postgres(databaseUrl, { max: 2 });

import { createCompanionTurn } from "../modules/companion-conversation/turn-service.ts";
import { cancelCompanionRun } from "../modules/companion-conversation/companion-cancel.ts";
import {
  ensureCompanionInbox,
  listCompanionMessages,
} from "../modules/companion-conversation/companion-conversations-service.ts";
import { openCompanionEventStream } from "../modules/companion-conversation/companion-events.ts";
import { exportCompanionDataStream } from "../modules/companion-conversation/companion-export.ts";
import { transcribeCompanionDialogueAudio } from "../modules/learning-sessions/companion-voice-service.ts";
import { execFileSync } from "node:child_process";
import { closeDatabase } from "../db/client.ts";

async function collectCompanionExport(args: { workspaceId: string; userId: string }) {
  const ndjson: string[] = [];
  const result = await exportCompanionDataStream(args, (line) => {
    ndjson.push(line);
  });
  return result.ok ? { ok: true as const, ndjson } : result;
}

test.after(async () => {
  // postgres-js 的 end() 在 Node 21+ 下 socket close 偶发不 resolve；用 race 限时兜底。
  // 同时关闭测试自建池与 api 全局池（后者因 import turn-service 而存在，不关则
  // 文件级测试进程 event loop 非空 → 文件级 testTimeoutFailure）。
  await Promise.race([
    (async () => {
      await sql.end({ timeout: 5 }).catch(() => {});
      await closeDatabase().catch(() => {});
    })(),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
});

async function seedConversation(): Promise<{
  workspaceId: string;
  userId: string;
  conversationId: string;
  cleanup: () => Promise<void>;
}> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const conversationId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO users (id, email, password_hash, role) VALUES (${userId}, ${`test-${userId.slice(0, 8)}@example.test`}, 'test-hash', 'owner')`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, ${`test-ws-${workspaceId.slice(0, 8)}`}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
    await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
             VALUES (${conversationId}, ${workspaceId}, ${userId}, 'dialogue', '新对话', 'placeholder', 'active')`;
  });
  const cleanup = async () => {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM companion_proactive_deliveries WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM companion_tts_outcomes WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM companion_stream_events WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM companion_turn_runs WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id = ${conversationId}`;
      await tx`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM companion_conversations WHERE id = ${conversationId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      await tx`DELETE FROM users WHERE id = ${userId}`;
    });
  };
  return { workspaceId, userId, conversationId, cleanup };
}

function turnBody(clientMessageId: string) {
  return {
    version: 1,
    clientMessageId,
    inputKind: "text",
    blocks: [{ type: "text", text: "请给我讲一下光合作用" }],
    sourceSurface: "pet",
  };
}

test("P2 原子 turn create：user message + run + turn.accepted event + job + counters", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    const clientMessageId = randomUUID();
    const result = await createCompanionTurn({
      workspaceId,
      userId,
      conversationId,
      idempotencyKey: randomUUID(),
      body: turnBody(clientMessageId),
    });
    assert.equal(result.statusCode, 202);
    const body = result.body as {
      userMessageId: string;
      runId: string;
      generation: number;
      eventCursor: number;
    };
    assert.equal(body.generation, 1);
    assert.equal(body.eventCursor, 1);

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const message = await tx`SELECT seq, role, kind, blocks, client_message_id FROM companion_messages WHERE id = ${body.userMessageId}`;
      const run = await tx`SELECT generation, status, idempotency_key_hash, job_id FROM companion_turn_runs WHERE id = ${body.runId}`;
      const event = await tx`SELECT seq, type, payload FROM companion_stream_events WHERE conversation_id = ${conversationId} AND seq = ${body.eventCursor}`;
      const conv = await tx`SELECT next_message_seq, next_event_seq, next_generation, title, title_source FROM companion_conversations WHERE id = ${conversationId}`;
      const job = run[0]?.job_id
        ? await tx`SELECT type, payload FROM jobs WHERE id = ${run[0].job_id}`
        : [];
      return { message, run, event, conv, job };
    });
    assert.equal(Number(rows.message[0].seq), 1);
    assert.equal(rows.message[0].role, "user");
    assert.equal(rows.message[0].kind, "text");
    assert.equal(rows.message[0].client_message_id, clientMessageId);
    assert.equal(rows.run[0].status, "accepted");
    assert.equal(rows.event[0].type, "turn.accepted");
    assert.equal(Number(rows.conv[0].next_message_seq), 2);
    assert.equal(Number(rows.conv[0].next_event_seq), 2);
    assert.equal(Number(rows.conv[0].next_generation), 2);
    assert.equal(rows.conv[0].title_source, "auto", "首条消息应生成 auto title");
    assert.equal(rows.job[0].type, "companion_agent");
  } finally {
    await cleanup();
  }
});

test("P2 幂等：同 Idempotency-Key 同 body 返回同一 run；不同 body → 409", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    const key = randomUUID();
    const first = await createCompanionTurn({
      workspaceId, userId, conversationId, idempotencyKey: key,
      body: turnBody(randomUUID()),
    });
    const firstRunId = (first.body as { runId: string }).runId;
    const replay = await createCompanionTurn({
      workspaceId, userId, conversationId, idempotencyKey: key,
      body: (first.body as { clientMessageId?: string }) && turnBody((first.body as { clientMessageId?: string }).clientMessageId ?? randomUUID()),
    });
    assert.equal(replay.statusCode, 200);
    assert.equal((replay.body as { runId: string }).runId, firstRunId);

    await assert.rejects(
      createCompanionTurn({
        workspaceId, userId, conversationId, idempotencyKey: key,
        body: { ...turnBody(randomUUID()), blocks: [{ type: "text", text: "不同的内容" }] },
      }),
      (err: { code?: string }) => err.code === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await cleanup();
  }
});

test("P2 幂等：同 clientMessageId 同 body（不同 key）返回同一 run", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    const clientMessageId = randomUUID();
    const first = await createCompanionTurn({
      workspaceId, userId, conversationId, idempotencyKey: randomUUID(),
      body: turnBody(clientMessageId),
    });
    const replay = await createCompanionTurn({
      workspaceId, userId, conversationId, idempotencyKey: randomUUID(),
      body: turnBody(clientMessageId),
    });
    assert.equal(replay.statusCode, 200);
    assert.equal((replay.body as { runId: string }).runId, (first.body as { runId: string }).runId);
  } finally {
    await cleanup();
  }
});

test("P2 active run 规则：无 supersedesGeneration → 409；正确 supersede → 新 run + 旧 run superseded + cancelled event", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    const first = await createCompanionTurn({
      workspaceId, userId, conversationId, idempotencyKey: randomUUID(),
      body: turnBody(randomUUID()),
    });
    const firstGen = (first.body as { generation: number }).generation;

    // 无 supersedesGeneration → RUN_ALREADY_ACTIVE
    await assert.rejects(
      createCompanionTurn({
        workspaceId, userId, conversationId, idempotencyKey: randomUUID(),
        body: turnBody(randomUUID()),
      }),
      (err: { code?: string }) => err.code === "RUN_ALREADY_ACTIVE",
    );

    // 错误 supersedesGeneration：有 active run 时 active 校验优先 → RUN_ALREADY_ACTIVE
    // （STALE_GENERATION 仅在无 active run 时比较 latest generation 触发）
    await assert.rejects(
      createCompanionTurn({
        workspaceId, userId, conversationId, idempotencyKey: randomUUID(),
        body: { ...turnBody(randomUUID()), supersedesGeneration: 99 },
      }),
      (err: { code?: string }) => err.code === "RUN_ALREADY_ACTIVE",
    );

    // 正确 supersede
    const second = await createCompanionTurn({
      workspaceId, userId, conversationId, idempotencyKey: randomUUID(),
      body: { ...turnBody(randomUUID()), supersedesGeneration: firstGen },
    });
    assert.equal(second.statusCode, 202);
    const secondGen = (second.body as { generation: number }).generation;
    assert.equal(secondGen, 2);

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const oldRun = await tx`SELECT status FROM companion_turn_runs WHERE id = ${(first.body as { runId: string }).runId}`;
      const cancelled = await tx`SELECT type FROM companion_stream_events WHERE conversation_id = ${conversationId} AND type = 'turn.cancelled'`;
      const activeRuns = await tx`SELECT count(*)::int AS n FROM companion_turn_runs WHERE conversation_id = ${conversationId} AND status IN ('accepted','running','cancel_requested')`;
      return { oldRun, cancelled, activeRuns };
    });
    assert.equal(rows.oldRun[0].status, "superseded");
    assert.equal(rows.cancelled.length, 1);
    assert.equal(rows.activeRuns[0].n, 1, "active run 至多一条");
  } finally {
    await cleanup();
  }
});

test("P2 cancel：active run 202 取消 + turn.cancelled event；终态幂等 200", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    const created = await createCompanionTurn({
      workspaceId, userId, conversationId,
      idempotencyKey: randomUUID(),
      body: turnBody(randomUUID()),
    });
    const body = created.body as { runId: string; generation: number };

    const cancelBody = { version: 1, generation: body.generation, reason: "user" as const };
    const cancelled = await cancelCompanionRun({ workspaceId, userId, runId: body.runId, body: cancelBody });
    assert.equal(cancelled.statusCode, 202);
    assert.equal(cancelled.body.status, "cancelled");

    // 再次 cancel → 幂等 200
    const again = await cancelCompanionRun({ workspaceId, userId, runId: body.runId, body: cancelBody });
    assert.equal(again.statusCode, 200);

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const run = await tx`SELECT status, finished_at FROM companion_turn_runs WHERE id = ${body.runId}`;
      const cancelledEvents = await tx`SELECT seq, type, payload FROM companion_stream_events WHERE conversation_id = ${conversationId} AND type = 'turn.cancelled'`;
      return { run, cancelledEvents };
    });
    assert.equal(rows.run[0].status, "cancelled");
    assert.ok(rows.run[0].finished_at != null);
    assert.equal(rows.cancelledEvents.length, 1);
    const payload = rows.cancelledEvents[0].payload;
    assert.equal(payload.reason, "user");
  } finally {
    await cleanup();
  }
});

test("P2 SSE：replay turn.accepted + after 推进 + INVALID_CURSOR/CURSOR_EXPIRED", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    const created = await createCompanionTurn({
      workspaceId, userId, conversationId,
      idempotencyKey: randomUUID(),
      body: turnBody(randomUUID()),
    });
    const acceptedSeq = (created.body as { eventCursor: number }).eventCursor;

    const chunks: string[] = [];
    const abortRef: { fn: (() => void) | null } = { fn: null };
    let closed = false;
    const result = await openCompanionEventStream({
      workspaceId, userId, conversationId,
      afterRaw: "0", lastEventId: null,
      writer: {
        write: (c) => { chunks.push(c); return true; },
        onAbort: (cb: () => void) => { abortRef.fn = cb; },
        close: () => { closed = true; },
      },
    });
    assert.equal(result.statusCode, 200);
    if ("stream" in result) {
      result.stream.start();
      assert.equal(chunks.length, 1, "replay 应含 turn.accepted");
      assert.ok(chunks[0].includes(`id: ${conversationId}:${acceptedSeq}`));
      assert.ok(chunks[0].includes("event: companion"));
      assert.ok(chunks[0].includes("turn.accepted"));
      // abort 清理（释放 slot）
      if (abortRef.fn != null) abortRef.fn();
      assert.equal(closed, true);
    }

    // after > latest → 400 INVALID_CURSOR
    const tooFar = await openCompanionEventStream({
      workspaceId, userId, conversationId,
      afterRaw: "9999", lastEventId: null,
      writer: { write: () => {}, onAbort: () => {}, close: () => {} },
    });
    assert.equal(tooFar.statusCode, 400);
    if ("error" in tooFar) assert.equal(tooFar.error.code, "INVALID_CURSOR");

    // 造缺口：把 turn.accepted 过期 + 手动写一条未过期 seq=2 → after=0 → 409 CURSOR_EXPIRED
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`UPDATE companion_stream_events SET expires_at = now() - interval '1 hour' WHERE conversation_id = ${conversationId}`;
      await tx`INSERT INTO companion_stream_events (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
               VALUES (${conversationId}, 2, ${workspaceId}, ${userId}, NULL, 0, 0, 'character.cue', ${{ cue: { type: "idle" } } as never}, now() + interval '1 hour')`;
    });
    const expired = await openCompanionEventStream({
      workspaceId, userId, conversationId,
      afterRaw: "0", lastEventId: null,
      writer: { write: () => {}, onAbort: () => {}, close: () => {} },
    });
    assert.equal(expired.statusCode, 409);
    if ("error" in expired) assert.equal(expired.error.code, "CURSOR_EXPIRED");
  } finally {
    await cleanup();
  }
});

test("P2 SSE：连接限制——同 conversation 第 4 条连接 429", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    const aborts: (() => void)[] = [];
    const openOne = () => openCompanionEventStream({
      workspaceId, userId, conversationId,
      afterRaw: "0", lastEventId: null,
      writer: {
        write: () => {},
        onAbort: (cb) => aborts.push(cb),
        close: () => {},
      },
    });
    const r1 = await openOne();
    const r2 = await openOne();
    const r3 = await openOne();
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200);
    assert.equal(r3.statusCode, 200);
    // openCompanionEventStream() 在首个 DB await 前就注册 onAbort（释放 slot 的回调）
    for (const r of [r1, r2, r3]) if ("stream" in r) r.stream.start();
    const r4 = await openOne();
    assert.equal(r4.statusCode, 429);
    if ("error" in r4) assert.equal(r4.error.code, "TOO_MANY_CONNECTIONS");
    // 释放后重新可开
    for (const cb of aborts) cb();
    const r5 = await openOne();
    assert.equal(r5.statusCode, 200);
    if ("stream" in r5) r5.stream.start();
    for (const cb of aborts) cb();
  } finally {
    await cleanup();
  }
});

test("P2 §6.2：inbox ensure 幂等唯一 + 无副作用", async () => {
  const { workspaceId, userId, cleanup } = await seedConversation();
  const inboxIds: string[] = [];
  try {
    const first = await ensureCompanionInbox({ workspaceId, userId });
    assert.equal(first.statusCode, 201);
    const body = first.body as { id: string; kind: string; title: string; titleSource: string };
    assert.equal(body.kind, "inbox");
    assert.equal(body.title, "伴星消息");
    assert.equal(body.titleSource, "system");
    inboxIds.push(body.id);

    const second = await ensureCompanionInbox({ workspaceId, userId });
    assert.equal(second.statusCode, 200);
    assert.equal((second.body as { id: string }).id, body.id, "幂等返回同一 inbox");

    // 无消息/事件/run 副作用
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const events = await tx`SELECT count(*)::int AS n FROM companion_stream_events WHERE conversation_id = ${body.id}`;
      const messages = await tx`SELECT count(*)::int AS n FROM companion_messages WHERE conversation_id = ${body.id}`;
      return { events: events[0].n, messages: messages[0].n };
    });
    assert.equal(rows.events, 0);
    assert.equal(rows.messages, 0);
  } finally {
    if (inboxIds.length > 0) {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        await tx`SELECT set_config('app.user_id', ${userId}, true)`;
        for (const id of inboxIds) {
          await tx`DELETE FROM companion_stream_events WHERE conversation_id = ${id}`;
          await tx`DELETE FROM companion_messages WHERE conversation_id = ${id}`;
          await tx`DELETE FROM companion_turn_runs WHERE conversation_id = ${id}`;
          await tx`DELETE FROM companion_conversations WHERE id = ${id}`;
        }
      });
    }
    await cleanup();
  }
});

test("P2 §6.4：messages 历史（升序 + beforeSeq 分页）", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    const created = await createCompanionTurn({
      workspaceId, userId, conversationId,
      idempotencyKey: randomUUID(),
      body: turnBody(randomUUID()),
    });
    assert.equal(created.statusCode, 202);

    const history = await listCompanionMessages({
      workspaceId, userId, conversationId, limit: 50, beforeSeq: null,
    });
    assert.equal(history.statusCode, 200);
    const items = history.body.items as { role: string; seq: number }[];
    assert.ok(items.length >= 1);
    assert.equal(items[0].role, "user", "升序返回（第一条为最早的 user message）");
    const seqs = items.map((m) => m.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq 升序");

    // beforeSeq 分页：取 seq=1 之前 → 空
    const before = await listCompanionMessages({
      workspaceId, userId, conversationId, limit: 50, beforeSeq: 1,
    });
    assert.equal(before.body.items.length, 0);
  } finally {
    await cleanup();
  }
});

test("P2 §12：export NDJSON（manifest 首行/footer 末行/hash/counts + active turn 409）", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    // 无 active turn → 导出成功
    const created = await createCompanionTurn({
      workspaceId, userId, conversationId,
      idempotencyKey: randomUUID(),
      body: turnBody(randomUUID()),
    });
    assert.equal(created.statusCode, 202);
    const runId = (created.body as { runId: string }).runId;
    // 先把 run 置终态（superseded）以便导出（否则 active turn 409）
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`UPDATE companion_turn_runs SET status = 'succeeded' WHERE id = ${runId}`;
    });

    const result = await collectCompanionExport({ workspaceId, userId });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const lines = result.ndjson;
    assert.ok(lines.length >= 3, "manifest + ≥1 record + footer");
    const first = JSON.parse(lines[0]);
    assert.equal(first.kind, "manifest", "manifest 必须首行");
    assert.equal(first.format, "companion-export-ndjson-v1");
    assert.equal(first.workspaceId, workspaceId);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.kind, "footer", "footer 必须末行");
    assert.ok(last.counts.conversations >= 1);
    assert.ok(last.counts.messages >= 1);
    assert.equal(last.counts.actionProposals, 0);

    // recordsSha256：manifest 至 footer 前一行止的原始 bytes（每行含 LF）
    const { createHash } = await import("node:crypto");
    const recordsBytes = Buffer.from(lines.slice(0, -1).map((l) => `${l}\n`).join(""), "utf8");
    const expectedHash = createHash("sha256").update(recordsBytes).digest("hex");
    assert.equal(last.recordsSha256, expectedHash, "footer recordsSha256 可验证");

    // 输出中不得出现 assistant delta/正文外的内部字段（简单检查 message record 结构）
    for (const line of lines.slice(1, -1)) {
      const record = JSON.parse(line);
      assert.ok(record.version === 1);
      assert.ok(["conversation", "message"].includes(record.kind));
    }
  } finally {
    await cleanup();
  }
});

test("P2 §12：export 有 active turn → 409 RUN_ALREADY_ACTIVE", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    const created = await createCompanionTurn({
      workspaceId, userId, conversationId,
      idempotencyKey: randomUUID(),
      body: turnBody(randomUUID()),
    });
    assert.equal(created.statusCode, 202);
    const result = await collectCompanionExport({ workspaceId, userId });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.statusCode, 409);
      assert.equal(result.code, "RUN_ALREADY_ACTIVE");
    }
  } finally {
    await cleanup();
  }
});

// 原 "dialogue flag off 时 P1 路径不受影响" 用例只断言环境变量不等于 "true"
// （同义反复：不碰 preHandler，也不碰任何产品行为），且在本仓库
// docker-compose.dev.yml 默认开启该 flag 的机器上必然失败。已由
// modules/companion-conversation/routes.test.ts 取代——那里直接覆盖
// requireCompanionDialogue 的 404 fail-closed 契约。
function makeTestAudio(durationSeconds: number): Buffer {
  return execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
    "-t", String(durationSeconds), "-c:a", "pcm_s16le", "-f", "wav", "pipe:1",
  ]);
}

test("P3 §11.2：companion transcribe（真实 ffprobe + mock ASR）→ 201 + pending artifact", async () => {
  const { workspaceId, userId, cleanup } = await seedConversation();
  try {
    const result = await transcribeCompanionDialogueAudio({
      workspaceId, userId,
      audio: makeTestAudio(0.5),
      filename: "ptt.wav",
      asrProvider: { transcribe: async () => ({ text: "我要复习光合作用" }) },
      asrProviderName: "mock",
      asrModel: "mock-v1",
      language: "zh-CN",
    });
    assert.equal(result.statusCode, 201);
    const body = result.body;
    assert.ok(body.voiceArtifactId);
    assert.ok(body.durationMs >= 400 && body.durationMs <= 700, `durationMs=${body.durationMs}`);
    assert.match(body.transcriptSha256, /^[a-f0-9]{64}$/);
    assert.ok(body.expiresAt);

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT status, conversation_id, message_id, attached_at, transcript_sha256, duration_ms, raw_audio_persisted
                FROM companion_voice_artifacts WHERE id = ${body.voiceArtifactId}`;
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].conversation_id, null, "pending 未绑定 conversation");
    assert.equal(rows[0].message_id, null);
    assert.equal(rows[0].attached_at, null);
    assert.equal(rows[0].transcript_sha256, body.transcriptSha256);
    assert.equal(rows[0].raw_audio_persisted, false);
  } finally {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM companion_voice_artifacts WHERE workspace_id = ${workspaceId}`;
    });
    await cleanup();
  }
});

test("P3 §11.2：duration 过短（0.1s wav）→ 415 VOICE_UNSUPPORTED_FORMAT；垃圾字节同样 415", async () => {
  const { workspaceId, userId, cleanup } = await seedConversation();
  try {
    await assert.rejects(
      transcribeCompanionDialogueAudio({
        workspaceId, userId,
        audio: makeTestAudio(0.1),
        filename: "short.wav",
        asrProvider: { transcribe: async () => ({ text: "x" }) },
        asrProviderName: "mock",
        asrModel: "mock-v1",
      }),
      (err: { code?: string; statusCode?: number }) =>
        err.code === "VOICE_UNSUPPORTED_FORMAT" && err.statusCode === 415,
    );
    await assert.rejects(
      transcribeCompanionDialogueAudio({
        workspaceId, userId,
        audio: Buffer.from("garbage-not-audio-".repeat(30)),
        filename: "bad.bin",
        asrProvider: { transcribe: async () => ({ text: "x" }) },
        asrProviderName: "mock",
        asrModel: "mock-v1",
      }),
      (err: { code?: string }) => err.code === "VOICE_UNSUPPORTED_FORMAT",
    );
    // 失败路径不写 artifact
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return tx`SELECT count(*)::int AS n FROM companion_voice_artifacts WHERE workspace_id = ${workspaceId}`;
    });
    assert.equal(rows[0].n, 0, "duration/格式失败不得写入 artifact");
  } finally {
    await cleanup();
  }
});

async function seedVoiceArtifact(workspaceId: string, userId: string, text: string, opts?: {
  status?: string;
  expiresInMs?: number;
}): Promise<{ voiceArtifactId: string; transcriptSha256: string }> {
  const { sha256Utf8V1 } = await import("@ailearn/shared/content-hash");
  const transcriptSha256 = sha256Utf8V1(text);
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + (opts?.expiresInMs ?? 3_600_000));
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO companion_voice_artifacts
             (id, workspace_id, user_id, status, transcript_sha256, asr_provider, asr_model,
              language, duration_ms, raw_audio_persisted, expires_at)
             VALUES (${id}, ${workspaceId}, ${userId}, ${opts?.status ?? "pending"},
                     ${transcriptSha256}, 'mock', 'mock-v1', 'zh-CN', 500, false,
                     ${expiresAt.toISOString()})`;
  });
  return { voiceArtifactId: id, transcriptSha256 };
}

test("P3 §11.2：voice transcript turn 提交 → 202 + artifact attached 绑定", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    const text = "我要复习光合作用";
    const { voiceArtifactId } = await seedVoiceArtifact(workspaceId, userId, text);
    const created = await createCompanionTurn({
      workspaceId, userId, conversationId,
      idempotencyKey: randomUUID(),
      body: {
        version: 1,
        clientMessageId: randomUUID(),
        inputKind: "voice_transcript",
        blocks: [{ type: "text", text }],
        sourceSurface: "pet",
        voiceArtifactId,
      },
    });
    assert.equal(created.statusCode, 202);
    const userMessageId = (created.body as { userMessageId: string }).userMessageId;

    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const artifact = await tx`SELECT status, conversation_id, message_id, attached_at FROM companion_voice_artifacts WHERE id = ${voiceArtifactId}`;
      const message = await tx`SELECT kind FROM companion_messages WHERE id = ${userMessageId}`;
      return { artifact: artifact[0], message: message[0] };
    });
    assert.equal(rows.artifact.status, "attached");
    assert.equal(rows.artifact.conversation_id, conversationId);
    assert.equal(rows.artifact.message_id, userMessageId);
    assert.ok(rows.artifact.attached_at != null);
    assert.equal(rows.message.kind, "voice_transcript");

    // 同一 artifact 二次提交 → 409 IDEMPOTENCY_CONFLICT（先把第一次 run 置终态，
    // 让 active-run 规则不抢先拦截，验证 artifact 只绑一次）
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`UPDATE companion_turn_runs SET status = 'succeeded' WHERE conversation_id = ${conversationId}`;
    });
    await assert.rejects(
      createCompanionTurn({
        workspaceId, userId, conversationId,
        idempotencyKey: randomUUID(),
        body: {
          version: 1, clientMessageId: randomUUID(), inputKind: "voice_transcript",
          blocks: [{ type: "text", text }], sourceSurface: "pet", voiceArtifactId,
        },
      }),
      (err: { code?: string }) => err.code === "IDEMPOTENCY_CONFLICT",
    );
  } finally {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM companion_voice_artifacts WHERE workspace_id = ${workspaceId}`;
    });
    await cleanup();
  }
});

test("P3 §11.2：voice 提交的 hash 不匹配 → 400；过期 → 409；不存在 → 404", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    // hash 不匹配
    const a = await seedVoiceArtifact(workspaceId, userId, "原始transcript");
    await assert.rejects(
      createCompanionTurn({
        workspaceId, userId, conversationId,
        idempotencyKey: randomUUID(),
        body: {
          version: 1, clientMessageId: randomUUID(), inputKind: "voice_transcript",
          blocks: [{ type: "text", text: "篡改的transcript" }], sourceSurface: "pet",
          voiceArtifactId: a.voiceArtifactId,
        },
      }),
      (err: { code?: string }) => err.code === "INVALID_REQUEST",
    );
    // 过期
    const b = await seedVoiceArtifact(workspaceId, userId, "过期transcript", { expiresInMs: -1000 });
    await assert.rejects(
      createCompanionTurn({
        workspaceId, userId, conversationId,
        idempotencyKey: randomUUID(),
        body: {
          version: 1, clientMessageId: randomUUID(), inputKind: "voice_transcript",
          blocks: [{ type: "text", text: "过期transcript" }], sourceSurface: "pet",
          voiceArtifactId: b.voiceArtifactId,
        },
      }),
      (err: { code?: string }) => err.code === "IDEMPOTENCY_CONFLICT",
    );
    // 不存在
    await assert.rejects(
      createCompanionTurn({
        workspaceId, userId, conversationId,
        idempotencyKey: randomUUID(),
        body: {
          version: 1, clientMessageId: randomUUID(), inputKind: "voice_transcript",
          blocks: [{ type: "text", text: "x" }], sourceSurface: "pet",
          voiceArtifactId: randomUUID(),
        },
      }),
      (err: { code?: string }) => err.code === "NOT_FOUND",
    );
  } finally {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`DELETE FROM companion_voice_artifacts WHERE workspace_id = ${workspaceId}`;
    });
    await cleanup();
  }
});

test("P3 §11.3：Companion TTS 合成（strict ref 重读 event）", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  try {
    // seed run + voice.segment.ready event
    const runId = randomUUID();
    const gen = 1;
    const text = "这是可朗读的助手回复内容。";
    const segmentId = createHash("sha256").update(`${runId}:1:${text}`, "utf8").digest("hex");
    const textSha256 = createHash("sha256").update(text, "utf8").digest("hex");
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const userMsgId = randomUUID();
      await tx`INSERT INTO companion_messages
               (id, conversation_id, workspace_id, user_id, role, seq, run_id, kind, blocks, content_sha256)
               VALUES (${userMsgId}, ${conversationId}, ${workspaceId}, ${userId}, 'user', 1, ${runId}, 'text',
                       ${[{ type: "text", text: "用户问题" }] as never},
                       ${"0".repeat(64)})`;
      await tx`INSERT INTO companion_turn_runs
               (id, conversation_id, workspace_id, user_id, user_message_id, status, generation,
                idempotency_key_hash, request_body_hash, started_at)
               VALUES (${runId}, ${conversationId}, ${workspaceId}, ${userId}, ${userMsgId}, 'running',
                       ${gen}, ${"0".repeat(64)}, ${"0".repeat(64)}, ${new Date().toISOString()})`;
      await tx`INSERT INTO companion_stream_events
               (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch,
                type, payload, expires_at)
               VALUES (${conversationId}, 100, ${workspaceId}, ${userId}, ${runId}, ${gen}, 0,
                       'voice.segment.ready',
                       ${{
                         // 这一段 seed 以前是 V1 形状（text/textSha256），而服务重读时
                         // 按 V2 strict 合同校验 → 直接 409 UNSUPPORTED_CONTRACT，
                         // 于是这条用例其实一直在测"被拒"，从没走到合成那一步。
                         version: 2, segmentId, ordinal: 1,
                         displayText: text, displayStart: 0, displayEnd: text.length,
                         synthesisText: text, synthesisTextSha256: textSha256,
                         cue: { version: 1, intent: "explain", emotion: "neutral", intensity: 0.5 },
                       } as never},
                       ${new Date(Date.now() + 3_600_000).toISOString()})`;
    });

    const { synthesizeCompanionTtsSegment } = await import("../modules/learning-sessions/companion-voice-service.ts");

    // 成功：合成文本来自 event（客户端不可指定）
    let synthesizedText = "";
    const ok = await synthesizeCompanionTtsSegment({
      workspaceId, userId,
      ref: { conversationId, runId, generation: gen, ordinal: 1, segmentId },
      synthesize: async (t) => {
        synthesizedText = t;
        return { audio: Buffer.from("MP3-DATA"), engine: "qwen" as const };
      },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(synthesizedText, text);
    assert.equal(Buffer.from(ok.audio as Uint8Array).toString(), "MP3-DATA");

    // 引擎失败：以前往外抛 → companion 分支的路由没有 try/catch → 客户端拿到 500，
    // 表现为"她突然不出声"且没有任何原因。现在必须是可降级的 502 + 一条 failed 记录。
    const failed = await synthesizeCompanionTtsSegment({
      workspaceId, userId,
      ref: { conversationId, runId, generation: gen, ordinal: 1, segmentId },
      synthesize: async () => {
        throw new Error("edge-tts 500 BrokenPipeError");
      },
    });
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.error?.code, "TTS_FAILED");

    // 逐段结果必须留痕（0246）：ok 带引擎与字节数，failed 带错误分类。
    // "她经常没声音"从今往后是一个能查的数，而不是用户的复述。
    const outcomes = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return await tx`
        SELECT outcome, coalesce(error_code, '') AS error_code, coalesce(engine, '') AS engine,
               coalesce(bytes, -1) AS bytes
        FROM companion_tts_outcomes WHERE run_id = ${runId} ORDER BY ordinal, created_at
      `;
    }) as Array<{ outcome: string; error_code: string; engine: string; bytes: number }>;
    const okRow = outcomes.find((row) => row.outcome === "ok");
    assert.ok(okRow, "成功的合成要留下一行 ok");
    assert.equal(okRow.engine, "qwen");
    assert.equal(okRow.bytes, 8);
    const failedRow = outcomes.find((row) => row.outcome === "failed");
    assert.ok(failedRow, "引擎失败要留下一行 failed");
    assert.equal(failedRow.error_code, "Error");

    // segmentId 不匹配 → 400
    const bad = await synthesizeCompanionTtsSegment({
      workspaceId, userId,
      ref: { conversationId, runId, generation: gen, ordinal: 1, segmentId: "a".repeat(64) },
      synthesize: async () => ({ audio: Buffer.from("x") }),
    });
    assert.equal(bad.statusCode, 400);

    // event 不存在 → 404
    const missing = await synthesizeCompanionTtsSegment({
      workspaceId, userId,
      ref: { conversationId, runId, generation: gen, ordinal: 2, segmentId: "b".repeat(64) },
      synthesize: async () => ({ audio: Buffer.from("x") }),
    });
    assert.equal(missing.statusCode, 404);

    // run 非 running/succeeded（cancelled）→ 409 TURN_CANCELLED
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      await tx`UPDATE companion_turn_runs SET status = 'cancelled' WHERE id = ${runId}`;
    });
    const cancelled = await synthesizeCompanionTtsSegment({
      workspaceId, userId,
      ref: { conversationId, runId, generation: gen, ordinal: 1, segmentId },
      synthesize: async () => ({ audio: Buffer.from("x") }),
    });
    assert.equal(cancelled.statusCode, 409);
    assert.equal(cancelled.error?.code, "TURN_CANCELLED");
  } finally {
    await cleanup();
  }
});

/**
 * 0247：客户端播没播成，服务端要知道（抱怨 #4「语音经常没声音」的下半场）。
 *
 * 固定的是三件事：① 播放结局落在 stage='playback'，与合成的那一半分得开
 * （两阶段的 duration_ms 不同义，混在一起算分位数就是假数）；② 同一段重发只有一条
 * （弱网重试/刷新补报不该把"播过"变成三条）；③ 同一段的 synth 行与 playback 行**必须
 * 能共存**——唯一索引是 partial 的，写错成全局唯一会让合成记录把播放记录挤掉。
 */
test("0247 TTS 播放结局上报：分阶段、幂等、与合成行共存", async () => {
  const { workspaceId, userId, conversationId, cleanup } = await seedConversation();
  const runId = randomUUID();
  const segmentId = "c".repeat(64);
  const readRows = async () => (await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    return await tx`
      SELECT stage, outcome, coalesce(error_code,'') AS error_code, ordinal, duration_ms
      FROM companion_tts_outcomes WHERE run_id = ${runId} ORDER BY stage, ordinal, created_at
    `;
  })) as Array<{ stage: string; outcome: string; error_code: string; ordinal: number; duration_ms: number | null }>;

  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      const userMsgId = randomUUID();
      await tx`INSERT INTO companion_messages
               (id, conversation_id, workspace_id, user_id, role, seq, run_id, kind, blocks, content_sha256)
               VALUES (${userMsgId}, ${conversationId}, ${workspaceId}, ${userId}, 'user', 1, ${runId}, 'text',
                       ${[{ type: "text", text: "问题" }] as never}, ${"0".repeat(64)})`;
      await tx`INSERT INTO companion_turn_runs
               (id, conversation_id, workspace_id, user_id, user_message_id, status, generation,
                idempotency_key_hash, request_body_hash, started_at)
               VALUES (${runId}, ${conversationId}, ${workspaceId}, ${userId}, ${userMsgId}, 'succeeded',
                       1, ${"0".repeat(64)}, ${"0".repeat(64)}, ${new Date().toISOString()})`;
      // 服务端那一半先有一行（等价于 synthesizeCompanionTtsSegment 落的 ok）。
      await tx`INSERT INTO companion_tts_outcomes
               (workspace_id, user_id, conversation_id, run_id, segment_id, ordinal, outcome,
                engine, duration_ms, bytes, stage)
               VALUES (${workspaceId}, ${userId}, ${conversationId}, ${runId}, ${segmentId}, 1,
                       'ok', 'qwen', 780, 4096, 'synth')`;
    });

    const { recordCompanionTtsPlaybackOutcome } = await import("../modules/learning-sessions/companion-voice-service.ts");
    const ref = { conversationId, runId, generation: 1, ordinal: 1, segmentId };

    await recordCompanionTtsPlaybackOutcome({ workspaceId, userId, ref, reason: "played", durationMs: 1200 });
    // 同一段重发（这次说没播出）——必须被幂等索引吞掉，不能让一行变两行。
    await recordCompanionTtsPlaybackOutcome({ workspaceId, userId, ref, reason: "deadline", durationMs: 4000 });
    // 另一段超时 → 独立一行
    await recordCompanionTtsPlaybackOutcome({
      workspaceId, userId, reason: "deadline", durationMs: 3200,
      ref: { ...ref, ordinal: 2, segmentId: "d".repeat(64) },
    });

    const rows = await readRows();
    const synth = rows.filter((row) => row.stage === "synth");
    const playback = rows.filter((row) => row.stage === "playback");
    assert.equal(synth.length, 1, "合成那一半不受上报影响");
    assert.equal(playback.length, 2, "两段各一条：重发的那次被 partial 唯一索引吞掉");
    assert.equal(playback[0].outcome, "ok", "第一次上报才是这段的结局（不被后来的重发覆盖）");
    assert.equal(playback[0].error_code, "played");
    assert.equal(playback[0].duration_ms, 1200);
    assert.equal(playback[1].outcome, "failed");
    assert.equal(playback[1].error_code, "deadline");
    assert.equal(playback[1].ordinal, 2);

    // 上报写不进去时绝不影响朗读：user_id 外键失败（插入必然被拒）要静默吞掉，
    // 不抛、不冒泡到调用方——这条链路的失败模式只能是"少一行统计"。
    await recordCompanionTtsPlaybackOutcome({
      workspaceId, userId: "00000000-0000-0000-0000-000000000000", ref, reason: "played",
    });
    assert.equal((await readRows()).filter((row) => row.stage === "playback").length, 2);
  } finally {
    await cleanup();
  }
});
