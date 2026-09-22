// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionAgentNode, CompanionAgentNodes } from "../../app/companion-agent-nodes";
import {
  CompanionAgentRail,
  companionAgentRailVisible,
} from "./companion-agent-rail";

afterEach(cleanup);

function toolNode(overrides: Partial<CompanionAgentNode> = {}): CompanionAgentNode {
  return {
    key: "tool:call-1",
    kind: "tool",
    label: "正在翻你的笔记",
    state: "succeeded",
    toolName: "companion_search_notes",
    summary: null,
    proposalId: null,
    ...overrides,
  };
}

const TOOL_NODES: CompanionAgentNodes = [toolNode()];
const THINKING_ONLY: CompanionAgentNodes = [toolNode({
  key: "status:0", kind: "thinking", label: "在想你上一句", toolName: null,
})];

describe("companionAgentRailVisible", () => {
  it("本轮调用过工具且气泡在屏时才挂轨道", () => {
    expect(companionAgentRailVisible(TOOL_NODES, true)).toBe(true);
  });

  it("气泡不在屏就不挂轨道——轨道不许比气泡活得久", () => {
    // 这条就是 2026-09-22 用户报的"工具气泡不会自动消失"：以前轨道自己计时退场，
    // `stopped`/`failed` 两个分支压根没设那个计时器，气泡收走之后摘要永久挂在头顶。
    expect(companionAgentRailVisible(TOOL_NODES, false)).toBe(false);
  });

  it("没调用过工具的一轮不挂轨道，哪怕气泡在屏", () => {
    expect(companionAgentRailVisible(THINKING_ONLY, true)).toBe(false);
    expect(companionAgentRailVisible([], true)).toBe(false);
  });
});

describe("CompanionAgentRail", () => {
  it("回合结束后只塌成摘要行，不自计时退场", () => {
    vi.useFakeTimers();
    try {
      render(<CompanionAgentRail nodes={TOOL_NODES} progress={null} turnState="done" />);
      expect(screen.getByRole("status", { name: "Mao 正在做的事" })).toBeTruthy();
      act(() => { vi.advanceTimersByTime(500); });
      expect(screen.getByText("1 次工具")).toBeTruthy();
      // 曾经这里有个 5.4s 的 `expired`：整条轨道自己消失，与气泡何时走无关。
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(screen.getByRole("status", { name: "Mao 正在做的事" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("气泡退场时轨道带 data-leaving，交给 CSS 与它同一拍淡出", () => {
    render(<CompanionAgentRail nodes={TOOL_NODES} progress={null} turnState="done" leaving />);
    const rail = screen.getByRole("status", { name: "Mao 正在做的事" });
    expect(rail.getAttribute("data-leaving")).toBe("true");
  });
});
