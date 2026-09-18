/**
 * agent turn 契约：reasoning 句柄透传。
 *
 * 背景：部分模型（deepseek 思考模式）要求把上一轮的 reasoning 原样回传，
 * 否则多轮工具循环第二步 400。契约因此增加 provider 不透明的 reasoning 句柄：
 * `AgentTurnResult.reasoning` 产出 → `AgentTurnRequest.messages[].reasoning` 回传。
 * 本文件锁定该字段的存在、透传与边界（未知字段被剥离、句柄上限）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentTurnRequestSchema,
  agentTurnResultSchema,
} from "./card-agent-contracts.ts";

const HANDLE = {
  id: "rs_1",
  type: "reasoning",
  status: "completed",
  summary: [],
  encrypted_content: "opaque-handle",
};

function request(assistant: Record<string, unknown>) {
  return {
    role: "companion_agent",
    systemPrompt: "sys",
    messages: [
      { role: "user", content: "北京天气？" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_weather", arguments: {} }], ...assistant },
      { role: "tool", toolCallId: "call_1", content: "{}" },
    ],
    tools: [],
    maxTokens: 700,
    temperature: 0.9,
  };
}

test("agentTurnResultSchema: 接受 provider 不透明 reasoning 句柄", () => {
  const parsed = agentTurnResultSchema.parse({
    content: null,
    toolCalls: [{ id: "call_1", name: "get_weather", arguments: {} }],
    finishReason: "tool_calls",
    reasoning: [HANDLE],
    usage: null,
    providerRequestId: "resp_1",
  });
  assert.deepEqual(parsed.reasoning, [HANDLE]);
});

test("agentTurnResultSchema: reasoning 可选（无思考模型不产出）", () => {
  const parsed = agentTurnResultSchema.parse({
    content: "hi",
    toolCalls: [],
    finishReason: "stop",
    usage: null,
    providerRequestId: null,
  });
  assert.equal(parsed.reasoning, undefined);
});

test("agentTurnRequestSchema: assistant 消息的 reasoning 句柄原样保留", () => {
  const parsed = agentTurnRequestSchema.parse(request({ reasoning: [HANDLE] }));
  const assistant = parsed.messages[1];
  assert.deepEqual(assistant.reasoning, [HANDLE]);
});

test("agentTurnRequestSchema: 句柄字段不被裁剪（不透明记录整体透传）", () => {
  const custom = { anything: "provider-private", nested: { a: [1, 2] } };
  const parsed = agentTurnRequestSchema.parse(request({ reasoning: [custom] }));
  assert.deepEqual(parsed.messages[1].reasoning, [custom]);
});

test("agentTurnRequestSchema: 未传 reasoning 时不含该字段", () => {
  const parsed = agentTurnRequestSchema.parse(request({}));
  assert.equal(parsed.messages[1].reasoning, undefined);
});

test("agentTurnRequestSchema: 句柄数量上限 4（与 toolCalls 对齐）", () => {
  assert.throws(() => agentTurnRequestSchema.parse(request({ reasoning: Array(5).fill(HANDLE) })));
});
