// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CompanionRunTrace } from "../../app/companion-agent-nodes";
import { CompanionRunTraceView } from "./CompanionRunTraceView";

afterEach(cleanup);

describe("CompanionRunTraceView", () => {
  it("默认展开历史执行过程，并用文字呈现每个节点状态", () => {
    const trace: CompanionRunTrace = {
      summary: {
        version: 1,
        runId: "11111111-1111-4111-8111-111111111111",
        status: "waiting_for_confirmation",
        generation: 1,
        stepCount: 2,
        toolCallCount: 1,
        maxSteps: 4,
        maxToolCalls: 4,
        assistantMessageId: "22222222-2222-4222-8222-222222222222",
        nodeCount: 2,
      },
      nodes: [
        { key: "status:1", kind: "acting", label: "整理可执行方案", state: "succeeded", toolName: null, summary: null, proposalId: null },
        { key: "tool:choice", kind: "tool", label: "等待确认设置", state: "waiting_confirmation", toolName: "settings", summary: "需要你确认后才能修改", proposalId: null },
      ],
    };

    const { container } = render(<CompanionRunTraceView trace={trace} />);
    expect(container.querySelector("details")?.open).toBe(true);
    expect(screen.getByText("等待选择 · 2 步 · 1 次工具")).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.getAllByText("等待选择").length).toBeGreaterThan(0);
  });

  it("run 已结束时不会把缺少完成帧的实时节点继续标成进行中", () => {
    const trace: CompanionRunTrace = {
      summary: {
        version: 1,
        runId: "11111111-1111-4111-8111-111111111111",
        status: "succeeded",
        generation: 1,
        stepCount: 1,
        toolCallCount: 0,
        maxSteps: 4,
        maxToolCalls: 4,
        assistantMessageId: "22222222-2222-4222-8222-222222222222",
        nodeCount: 1,
      },
      nodes: [
        { key: "status:0", kind: "thinking", label: "思考中", state: "running", toolName: null, summary: null, proposalId: null },
      ],
    };

    render(<CompanionRunTraceView trace={trace} />);
    expect(screen.getByText("已完成 · 1 步 · 0 次工具")).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.queryByText("进行中")).toBeNull();
  });
});
