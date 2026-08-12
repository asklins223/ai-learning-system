import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCompanionCursor,
  formatCompanionSse,
} from "./companion-events.ts";

const CONVERSATION_ID = "123e4567-e89b-12d3-a456-426614174000";

test("cursor 解析：无参 → after=0", () => {
  const r = resolveCompanionCursor({ afterRaw: null, lastEventId: null, conversationId: CONVERSATION_ID });
  assert.deepEqual(r, { ok: true, after: 0 });
});

test("cursor 解析：after 合法/非法", () => {
  assert.deepEqual(resolveCompanionCursor({ afterRaw: "42", lastEventId: null, conversationId: CONVERSATION_ID }), { ok: true, after: 42 });
  assert.equal(resolveCompanionCursor({ afterRaw: "-1", lastEventId: null, conversationId: CONVERSATION_ID }).ok, false);
  assert.equal(resolveCompanionCursor({ afterRaw: "1.5", lastEventId: null, conversationId: CONVERSATION_ID }).ok, false);
  assert.equal(resolveCompanionCursor({ afterRaw: "abc", lastEventId: null, conversationId: CONVERSATION_ID }).ok, false);
});

test("cursor 解析：Last-Event-ID 格式/跨 conversation", () => {
  assert.deepEqual(
    resolveCompanionCursor({ afterRaw: null, lastEventId: `${CONVERSATION_ID}:7`, conversationId: CONVERSATION_ID }),
    { ok: true, after: 7 },
  );
  assert.equal(
    resolveCompanionCursor({ afterRaw: null, lastEventId: "not-a-cursor", conversationId: CONVERSATION_ID }).ok,
    false,
  );
  assert.equal(
    resolveCompanionCursor({ afterRaw: null, lastEventId: "other-conversation:7", conversationId: CONVERSATION_ID }).ok,
    false,
  );
});

test("cursor 解析：after 与 Last-Event-ID 并存取较大者（§5.3）", () => {
  const r = resolveCompanionCursor({ afterRaw: "3", lastEventId: `${CONVERSATION_ID}:10`, conversationId: CONVERSATION_ID });
  assert.deepEqual(r, { ok: true, after: 10 });
  const r2 = resolveCompanionCursor({ afterRaw: "12", lastEventId: `${CONVERSATION_ID}:10`, conversationId: CONVERSATION_ID });
  assert.deepEqual(r2, { ok: true, after: 12 });
});

test("SSE 格式化：id/event/data 与 envelope 字段", () => {
  const row = {
    conversation_id: CONVERSATION_ID,
    seq: "3",
    run_id: "123e4567-e89b-12d3-a456-426614174001",
    generation: 2,
    account_epoch: 0,
    created_at: new Date("2026-08-11T00:00:00.000Z"),
    type: "assistant.delta",
    payload: { appendFrom: 0, textDelta: "你" },
  };
  const sse = formatCompanionSse(row);
  assert.ok(sse.startsWith(`id: ${CONVERSATION_ID}:3\nevent: companion\n`));
  const dataLine = sse.split("\n").find((l) => l.startsWith("data: "))!;
  const parsed = JSON.parse(dataLine.slice(6));
  assert.equal(parsed.seq, 3);
  assert.equal(parsed.runId, row.run_id);
  assert.equal(parsed.generation, 2);
  assert.equal(parsed.type, "assistant.delta");
  assert.deepEqual(parsed.payload, { appendFrom: 0, textDelta: "你" });
});
