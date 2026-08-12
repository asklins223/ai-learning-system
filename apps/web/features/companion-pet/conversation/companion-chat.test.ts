import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCompanionSseChunk } from "./fetch-sse.ts";
import { mapCompanionSseEvent } from "./companion-chat-client.ts";

const RUN_ID = "123e4567-e89b-12d3-a456-426614174001";
const CONV = "123e4567-e89b-12d3-a456-426614174000";

test("SSE 解析：单事件 LF", () => {
  const { events, buffer, fatal } = parseCompanionSseChunk(
    "",
    `id: ${CONV}:1\nevent: companion\ndata: {"type":"assistant.status","payload":{"status":"thinking"}}\n\n`,
  );
  assert.equal(fatal, null);
  assert.equal(buffer, "");
  assert.equal(events.length, 1);
  assert.equal(events[0].id, `${CONV}:1`);
  assert.equal(events[0].event, "companion");
  assert.equal(events[0].data, '{"type":"assistant.status","payload":{"status":"thinking"}}');
});

test("SSE 解析：CRLF 与 comment heartbeat 忽略", () => {
  const { events, fatal } = parseCompanionSseChunk(
    "",
    `: heartbeat 1234567\r\nevent: companion\r\ndata: {"type":"assistant.delta","payload":{"textDelta":"你"}}\r\n\r\n`,
  );
  assert.equal(fatal, null);
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{"type":"assistant.delta","payload":{"textDelta":"你"}}');
});

test("SSE 解析：跨 chunk 缓冲拼接", () => {
  const first = parseCompanionSseChunk("", `id: ${CONV}:2\nevent: companion\nda`);
  assert.equal(first.events.length, 0);
  assert.ok(first.buffer.length > 0);
  const second = parseCompanionSseChunk(first.buffer, `ta: {"type":"assistant.final"}\n\n`);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].data, '{"type":"assistant.final"}');
});

test("SSE 解析：多 id / 多 data 行 / 未知字段 → fatal", () => {
  assert.equal(
    parseCompanionSseChunk("", `id: a\nid: b\nevent: companion\ndata: x\n\n`).fatal?.kind,
    "multiple_ids",
  );
  assert.equal(
    parseCompanionSseChunk("", `event: companion\ndata: a\ndata: b\n\n`).fatal?.kind,
    "multiple_data_lines",
  );
  assert.equal(
    parseCompanionSseChunk("", `retry: 500\n\n`).fatal,
    null,
  );
  // 2026-08-12：retry: 是 SSE 规范字段（api 事件流开头发送），不再是
  // unknown；真正的未知字段（如 foo:）仍应 fatal。
  assert.equal(
    parseCompanionSseChunk("", `foo: bar\nevent: companion\ndata: x\n\n`).fatal?.kind,
    "unknown_field",
  );
});

test("SSE 解析：多事件一包", () => {
  const { events, fatal } = parseCompanionSseChunk(
    "",
    `id: ${CONV}:1\nevent: companion\ndata: {"type":"a"}\n\nid: ${CONV}:2\nevent: companion\ndata: {"type":"b"}\n\n`,
  );
  assert.equal(fatal, null);
  assert.equal(events.length, 2);
  assert.equal(events[1].id, `${CONV}:2`);
});

test("SSE 解析：单事件 wire 超限 → fatal，而不是静默丢事件", () => {
  const result = parseCompanionSseChunk(
    "",
    `event: companion\ndata: ${"你".repeat(80)}\n\n`,
    128,
  );
  assert.equal(result.fatal?.kind, "too_large");
  assert.equal(result.events.length, 0);
});

test("事件映射：delta 累积 → final 完整 text + 旧 generation consume-only", () => {
  const base = { runId: RUN_ID, generation: 1 };
  const d1 = mapCompanionSseEvent({
    event: { id: `${CONV}:3`, type: "assistant.delta", runId: RUN_ID, generation: 1, payload: { appendFrom: 0, textDelta: "你好" } },
    ...base,
    accumulatedText: "",
  })!;
  assert.equal(d1.dispatch.text, "你好");
  assert.equal(d1.accumulatedText, "你好");

  const d2 = mapCompanionSseEvent({
    event: { id: `${CONV}:4`, type: "assistant.delta", runId: RUN_ID, generation: 1, payload: { appendFrom: 2, textDelta: "世界" } },
    ...base,
    accumulatedText: d1.accumulatedText,
  })!;
  assert.equal(d2.accumulatedText, "你好世界");

  const final = mapCompanionSseEvent({
    event: { id: `${CONV}:5`, type: "assistant.final", runId: RUN_ID, generation: 1, payload: { messageId: "m1", textSha256: "a".repeat(64) } },
    ...base,
    accumulatedText: d2.accumulatedText,
  })!;
  assert.equal(final.dispatch.type, "assistant.final");
  assert.equal(final.dispatch.text, "你好世界");
  assert.equal(final.dispatch.messageId, "m1");

  // 旧 generation run event → null（consume-only；真实 SSE runId/generation 在顶层）
  const stale = mapCompanionSseEvent({
    event: { id: `${CONV}:9`, type: "assistant.delta", runId: "other-run", generation: 0, payload: { textDelta: "x" } },
    ...base,
    accumulatedText: "你好世界",
  });
  assert.equal(stale, null);
});

test("事件映射：error → turn.failed", () => {
  const r = mapCompanionSseEvent({
    event: { id: `${CONV}:6`, type: "error", runId: RUN_ID, generation: 1, payload: { code: "PROVIDER_UNAVAILABLE", recoverable: true } },
    runId: RUN_ID,
    generation: 1,
    accumulatedText: "",
  })!;
  assert.equal(r.dispatch.type, "turn.failed");
  assert.equal(r.dispatch.code, "PROVIDER_UNAVAILABLE");
});

test("事件映射：服务端 envelope 的 runId/generation 在顶层时正确拦截旧 run", () => {
  const current = mapCompanionSseEvent({
    event: {
      id: `${CONV}:7`,
      type: "assistant.delta",
      runId: RUN_ID,
      generation: 2,
      payload: { textDelta: "当前回复" },
    },
    runId: RUN_ID,
    generation: 2,
    accumulatedText: "",
  });
  assert.equal(current?.dispatch.text, "当前回复");

  const stale = mapCompanionSseEvent({
    event: {
      id: `${CONV}:8`,
      type: "assistant.delta",
      runId: "123e4567-e89b-12d3-a456-426614174099",
      generation: 1,
      payload: { textDelta: "旧回复" },
    },
    runId: RUN_ID,
    generation: 2,
    accumulatedText: "当前回复",
  });
  assert.equal(stale, null);
});

test("事件映射：异步 action.completed/failed 保留结果与消费游标", () => {
  const completed = mapCompanionSseEvent({
    event: {
      id: `${CONV}:10`,
      type: "action.completed",
      runId: null,
      generation: 0,
      payload: {
        actionRunId: RUN_ID,
        resultRef: "run:1",
        route: { kind: "review" },
        safeSummary: "已打开复习页",
      },
    },
    runId: RUN_ID,
    generation: 1,
    accumulatedText: "",
  });
  assert.equal(completed?.dispatch.type, "action.completed");
  assert.equal(completed?.dispatch.safeSummary, "已打开复习页");

  const failed = mapCompanionSseEvent({
    event: {
      id: `${CONV}:11`,
      type: "action.failed",
      runId: null,
      generation: 0,
      payload: { actionRunId: RUN_ID, code: "ACTION_STALE", recoverable: true },
    },
    runId: RUN_ID,
    generation: 1,
    accumulatedText: "",
  });
  assert.equal(failed?.dispatch.type, "action.failed");
  assert.equal(failed?.dispatch.code, "ACTION_STALE");
});

test("事件映射：非法 action route 被丢弃，不进入导航适配器", () => {
  const mapped = mapCompanionSseEvent({
    event: {
      id: `${CONV}:12`,
      type: "action.completed",
      runId: null,
      generation: 0,
      payload: {
        actionRunId: RUN_ID,
        route: { kind: "conversation", conversationId: "not-a-uuid" },
        safeSummary: "已完成",
      },
    },
    runId: RUN_ID,
    generation: 1,
    accumulatedText: "",
  });
  assert.equal(mapped?.dispatch.type, "action.completed");
  assert.equal(mapped?.dispatch.route, null);
});

test("voice.segment.ready 映射为 voice.segments（单段）", () => {
  const mapped = mapCompanionSseEvent({
    event: {
      id: "c:5",
      type: "voice.segment.ready",
      conversationId: "123e4567-e89b-12d3-a456-426614174000",
      payload: { segmentId: "a".repeat(64), ordinal: 2, text: "这是第二段。", textSha256: "b".repeat(64) },
    },
    runId: "run-1",
    generation: 1,
    accumulatedText: "",
  });
  assert.ok(mapped, "应映射");
  assert.equal(mapped?.dispatch.type, "voice.segments");
  if (mapped?.dispatch.type === "voice.segments") {
    assert.equal(mapped.dispatch.conversationId, "123e4567-e89b-12d3-a456-426614174000");
    assert.equal(mapped.dispatch.segment?.ordinal, 2);
    assert.equal(mapped.dispatch.segment?.text, "这是第二段。");
  }
});

test("事件映射：非法 voice segment 不进入播放队列", () => {
  const mapped = mapCompanionSseEvent({
    event: {
      id: "c:6",
      type: "voice.segment.ready",
      conversationId: CONV,
      payload: {
        segmentId: "not-a-hash",
        ordinal: 0,
        text: "x".repeat(161),
        textSha256: "not-a-hash",
      },
    },
    runId: RUN_ID,
    generation: 1,
    accumulatedText: "",
  });
  assert.equal(mapped, null);
});

test("事件映射：非法 action run 不进入动作结果状态", () => {
  const mapped = mapCompanionSseEvent({
    event: {
      id: "c:7",
      type: "action.completed",
      runId: null,
      generation: 0,
      payload: { actionRunId: "not-a-uuid", safeSummary: "已完成" },
    },
    runId: RUN_ID,
    generation: 1,
    accumulatedText: "",
  });
  assert.equal(mapped, null);
});
