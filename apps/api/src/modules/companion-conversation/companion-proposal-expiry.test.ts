/**
 * Companion proposal TTL / 账号世代回收单测。
 *
 * 方案 §5 硬要求：确认过期、账号关闭或 epoch 变化时必须**不执行工具**并把 run
 * 置为终态。回归点是 run 终结语句必须跟在每一类回收之后——漏掉它 run 会永久停在
 * waiting_for_confirmation，而 companion_turn_runs 的 active partial unique index
 * 会拒绝该 conversation 的后续 turn（用户卡在恒 409）。
 *
 * 这里用记录型假 tx 断言语句序列与绑定参数，不依赖真实数据库；真实 RLS/并发语义
 * 由 Postgres 集成套件覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  invalidateSupersededRunProposals,
  reclaimExpiredCompanionProposals,
} from "./companion-proposal-expiry.ts";

interface Captured {
  text: string;
  params: unknown[];
}

/** 从 drizzle SQL 模板还原可读 SQL 文本与绑定参数。 */
function capture(query: unknown): Captured {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  const text: string[] = [];
  const params: unknown[] = [];
  for (const chunk of chunks) {
    // 字面量 SQL 是 StringChunk（value 为字符串数组）；绑定参数是裸值。
    const value = (chunk as { value?: unknown } | null | undefined)?.value;
    if (Array.isArray(value)) {
      text.push(value.join(""));
    } else if (chunk !== null && typeof chunk === "object") {
      text.push("?");
      params.push(value);
    } else {
      text.push("?");
      params.push(chunk);
    }
  }
  return { text: text.join("").replace(/\s+/g, " ").trim(), params };
}

function makeTx(responder: (sql: Captured, index: number) => unknown) {
  const statements: Captured[] = [];
  const tx = {
    async execute(query: unknown) {
      const captured = capture(query);
      statements.push(captured);
      return responder(captured, statements.length - 1);
    },
  };
  return { tx, statements };
}

const TTL_UPDATE = /^UPDATE companion_action_proposals SET status = 'expired'/;
const STALE_UPDATE = /^UPDATE companion_action_proposals p SET status = 'expired'/;

test("过期回收：TTL 与账号世代两类都终结挂起 run 和冻结的工具调用", async () => {
  const { tx, statements } = makeTx((sqlText) => {
    if (TTL_UPDATE.test(sqlText.text) || STALE_UPDATE.test(sqlText.text)) return [{ id: "p1" }];
    if (/MAX\(epoch\)/.test(sqlText.text)) return [{ epoch: 0 }];
    if (/UPDATE companion_conversations/.test(sqlText.text)) return [{ next_event_seq: "5" }];
    return [];
  });

  const reclaimed = await reclaimExpiredCompanionProposals(tx as never, {
    workspaceId: "w1",
    userId: "u1",
    conversationId: "c1",
  });

  assert.equal(reclaimed, 2, "TTL 与 epoch 两类各回收 1 条");

  const toolCallUpdates = statements.filter((s) => /^UPDATE companion_agent_tool_calls/.test(s.text));
  assert.equal(toolCallUpdates.length, 2, "每一类都要把等待确认的工具调用置为 expired");
  for (const statement of toolCallUpdates) {
    assert.match(statement.text, /status = 'expired'/);
    assert.match(statement.text, /status = 'waiting_confirmation'/, "只动等待确认的行");
  }

  const runUpdates = statements.filter((s) => /^UPDATE companion_turn_runs/.test(s.text));
  assert.equal(runUpdates.length, 2, "每一类都要把挂起 run 置为终态，否则 conversation 被 409 锁死");
  const errorCodes = runUpdates.map((s) => s.params.find((p) => typeof p === "string"));
  assert.deepEqual(errorCodes, ["ACTION_EXPIRED", "ACTION_STALE"]);
  for (const statement of runUpdates) {
    assert.match(statement.text, /status = 'failed'/);
    assert.match(statement.text, /status = 'waiting_for_confirmation'/);
  }

  // 事件必须如实下发，客户端才能撤掉确认卡片
  const expiredEvents = statements.filter((s) => /^INSERT INTO companion_stream_events/.test(s.text));
  assert.equal(expiredEvents.length, 2);
});

test("过期回收：无过期/无失效时零副作用（不写事件、不动 run）", async () => {
  const { tx, statements } = makeTx(() => []);

  const reclaimed = await reclaimExpiredCompanionProposals(tx as never, {
    workspaceId: "w1",
    userId: "u1",
    conversationId: "c1",
  });

  assert.equal(reclaimed, 0);
  assert.equal(statements.some((s) => /^UPDATE companion_turn_runs/.test(s.text)), false);
  assert.equal(statements.some((s) => /^UPDATE companion_agent_tool_calls/.test(s.text)), false);
  assert.equal(statements.some((s) => /INSERT INTO companion_stream_events/.test(s.text)), false);
});

test("supersede 作废：过期该 run 的冻结工具调用与 pending proposal", async () => {
  const { tx, statements } = makeTx(() => []);

  await invalidateSupersededRunProposals(tx as never, { runId: "run-1" });

  assert.equal(statements.length, 2);
  assert.match(statements[0].text, /^UPDATE companion_agent_tool_calls/);
  assert.match(statements[0].text, /status IN \('requested', 'executing', 'waiting_confirmation'\)/);
  assert.match(statements[1].text, /^UPDATE companion_action_proposals/);
  assert.match(statements[1].text, /agent_run_id = \? AND status = 'pending'/);
  assert.deepEqual(statements[1].params, ["run-1"]);
});
