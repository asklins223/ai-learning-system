import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentExecutionSummary, formatAgentExecutionSummary, EXECUTION_SUMMARY_EVENT_CAP } from "../agent/event-summary.ts";
import type { EventSummaryEntry } from "../agent/context-builder.ts";

function ev(overrides: Partial<EventSummaryEntry> & { eventType: string }): EventSummaryEntry {
  return { agentRole: null, turnNo: 1, toolName: null, safeDetails: {}, createdAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

test("P4-5: 摘要统计 completed/failed tool calls", () => {
  const events = [
    ev({ eventType: "tool_result", safeDetails: { success: true }, toolName: "get_run_manifest" }),
    ev({ eventType: "tool_result", safeDetails: { success: true }, toolName: "submit_deck_draft" }),
    ev({ eventType: "tool_result", safeDetails: { success: false }, toolName: "request_repair" }),
  ];
  const s = buildAgentExecutionSummary(events);
  assert.equal(s.completedToolCalls, 2);
  assert.equal(s.failedToolCalls, 1);
  assert.equal(s.truncated, false);
});

test("P4-5: child tasks 与 latest decision 提取", () => {
  const events = [
    ev({ eventType: "child_task_created", safeDetails: { taskId: "t1", status: "pending" }, createdAt: "2026-01-01T00:00:01.000Z" }),
    ev({ eventType: "decision", safeDetails: { eventKey: "d1", summary: "批准候选 A" }, createdAt: "2026-01-01T00:00:02.000Z" }),
    ev({ eventType: "latest_decision", safeDetails: { eventKey: "d2", summary: "需要修复" }, createdAt: "2026-01-01T00:00:03.000Z" }),
  ];
  const s = buildAgentExecutionSummary(events);
  assert.equal(s.childTasks.length, 1);
  assert.equal(s.childTasks[0]?.taskId, "t1");
  assert.equal(s.latestDecision?.eventKey, "d2", "保留最新决策(时间靠后覆盖)");
  assert.equal(s.latestDecision?.summary, "需要修复");
});

test("P4-5: 超过上限标记 truncated", () => {
  const events = Array.from({ length: EXECUTION_SUMMARY_EVENT_CAP + 5 }, (_, i) =>
    ev({ eventType: "tool_result", safeDetails: { success: i % 2 === 0 } }));
  const s = buildAgentExecutionSummary(events);
  assert.equal(s.truncated, true);
  assert.equal(s.completedToolCalls, Math.ceil((EXECUTION_SUMMARY_EVENT_CAP + 5) / 2));
});

test("P4-5: formatAgentExecutionSummary 紧凑文本", () => {
  const s = buildAgentExecutionSummary([
    ev({ eventType: "tool_result", safeDetails: { success: true } }),
    ev({ eventType: "child_task_created", safeDetails: { taskId: "t1", status: "succeeded" } }),
    ev({ eventType: "latest_decision", safeDetails: { eventKey: "d1", summary: "进入 VERIFY" } }),
  ]);
  const text = formatAgentExecutionSummary(s);
  assert.ok(text.includes("已完成工具调用: 1"));
  assert.ok(text.includes("t1(succeeded)"));
  assert.ok(text.includes("最新决策: 进入 VERIFY"));
  assert.ok(!text.includes("截断"));
});

test("P4-5: 空事件摘要", () => {
  const s = buildAgentExecutionSummary([]);
  assert.equal(s.completedToolCalls, 0);
  assert.equal(s.failedToolCalls, 0);
  assert.equal(s.childTasks.length, 0);
  assert.equal(s.latestDecision, null);
  assert.equal(s.truncated, false);
});
