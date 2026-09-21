import { describe, expect, it } from "vitest";
import {
  appendCompanionAgentNode,
  buildCompanionRunTraces,
  companionRunTraceExpired,
  countAgentToolCalls,
  visibleAgentNodes,
  type CompanionAgentNodes,
} from "./companion-agent-nodes";

/**
 * 这些用例固定的是"轨道不会越长越长"这条契约：同一个工具调用/技能/状态迁移只能占一行。
 * 它们是方案 §1 行为表里 `agent.tool` 那行的可执行版本（`agent.skill` 随技能层删除）。
 */

function fold(events: readonly { eventType: string; payload: unknown }[]): CompanionAgentNodes {
  return events.reduce<CompanionAgentNodes>((nodes, event) => appendCompanionAgentNode(nodes, event), []);
}

const tool = (status: string, extra: Record<string, unknown> = {}) => ({
  eventType: "agent.tool",
  payload: {
    tool: {
      toolCallId: "call-1",
      name: "companion_open_card",
      status,
      safeLabel: "翻开你的笔记",
      ...extra,
    },
  },
});

describe("companion agent node stream", () => {
  it("keeps one row per tool call across its whole status lifecycle", () => {
    const nodes = fold([tool("requested"), tool("executing"), tool("succeeded", { safeSummary: "已打开 3 张卡片" })]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      key: "tool:call-1",
      kind: "tool",
      toolName: "companion_open_card",
      state: "succeeded",
      summary: "已打开 3 张卡片",
    });
    expect(countAgentToolCalls(nodes)).toBe(1);
  });

  it("rewrites the trailing status row instead of stacking status lines", () => {
    const nodes = fold([
      { eventType: "assistant.status", payload: { status: "thinking", safeLabel: "我先结合当前页面想一想" } },
      { eventType: "assistant.status", payload: { status: "acting", safeLabel: "我去翻一下你的笔记" } },
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "acting", label: "我去翻一下你的笔记" });
  });

  it("maps protocol states onto the five rail visuals", () => {
    expect(fold([tool("blocked")])[0].state).toBe("failed");
    expect(fold([tool("expired")])[0].state).toBe("cancelled");
    expect(fold([tool("waiting_confirmation")])[0].state).toBe("waiting_confirmation");
    expect(fold([tool("requested")])[0].state).toBe("running");
    expect(fold([tool("executing")])[0].state).toBe("running");
  });

  it("drops frames it cannot verify instead of inventing a label", () => {
    const nodes = fold([
      { eventType: "agent.tool", payload: { tool: { toolCallId: "c", name: "n", status: "succeeded" } } },
      { eventType: "agent.tool", payload: { tool: { name: "n", safeLabel: "x" } } },
      { eventType: "assistant.status", payload: { status: "thinking" } },
      { eventType: "assistant.delta", payload: { textDelta: "hi" } },
    ]);
    expect(nodes).toHaveLength(0);
  });

  it("collapses the overflow into a hidden counter", () => {
    const nodes = fold([tool("succeeded"), tool("succeeded"), tool("succeeded"), tool("succeeded")].map((event, index) => ({
      ...event,
      payload: { tool: { toolCallId: `call-${index}`, name: "n", status: "succeeded", safeLabel: `第 ${index} 步` } },
    })));
    const { hiddenCount, visible } = visibleAgentNodes(nodes);
    expect(hiddenCount).toBe(1);
    expect(visible.map((node) => node.label)).toEqual(["第 1 步", "第 2 步", "第 3 步"]);
    expect(countAgentToolCalls(nodes)).toBe(4);
  });
});

describe("companion run traces (历史过程留痕)", () => {
  const summary = (over: Record<string, unknown> = {}) => ({
    version: 1 as const,
    runId: "7f0a1a2e-0000-4000-8000-000000000001",
    status: "succeeded",
    generation: 3,
    mode: "hybrid" as const,
    stepCount: 3,
    toolCallCount: 2,
    maxSteps: 8,
    maxToolCalls: 12,
    assistantMessageId: "7f0a1a2e-0000-4000-8000-0000000000aa",
    nodeCount: 2,
    ...over,
  });

  it("aligns nodes to a run by runId and reuses the live reducer", () => {
    const traces = buildCompanionRunTraces([summary()], [
      { version: 1, seq: 4, runId: summary().runId, type: "agent.tool", payload: tool("requested").payload },
      { version: 1, seq: 5, runId: summary().runId, type: "agent.tool", payload: tool("succeeded").payload },
      { version: 1, seq: 6, runId: null, type: "assistant.status", payload: { status: "thinking", safeLabel: "x" } },
    ]);
    expect(traces).toHaveLength(1);
    // 同一个 toolCallId 的两条事件在历史里也只是一行——与实时链路同一个函数。
    expect(traces[0].nodes).toHaveLength(1);
    expect(traces[0].nodes[0]).toMatchObject({ key: "tool:call-1", state: "succeeded" });
    expect(companionRunTraceExpired(traces[0])).toBe(false);
  });

  it("tells 'expired' apart from 'this turn had no process'", () => {
    const expired = buildCompanionRunTraces([summary({ nodeCount: 0 })], []);
    expect(companionRunTraceExpired(expired[0])).toBe(true);
    // single_step 闲聊：没有步数也没有节点 —— 是"没有过程"，不是"过期"。
    const chitchat = buildCompanionRunTraces([summary({ stepCount: 0, toolCallCount: 0, nodeCount: 0, mode: "single_step" })], []);
    expect(companionRunTraceExpired(chitchat[0])).toBe(false);
  });
});
