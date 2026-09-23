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

  /**
   * 工具节点的 `label` 装的是服务端下发的 `definition.description` —— 那是**给模型看的**
   * 工具说明。轨道与头顶那句都过 `nodeLabel()` 换成给人看的那句话，这一份以前是裸渲染
   * `node.label`（2026-09-23 真窗口截图：过程里明晃晃写着"**只在用户问自己学了多久时
   * 调用**；她跟你打招呼时不要调"），于是同一步在轨道上是「正在看你的学习数据」、
   * 在记录里是一份工具文档。
   */
  it("工具节点说给人听的那句话，不把模型看的工具说明吐到界面上", () => {
    const modelFacing = "读取学习数据统计：今天/本周学了多久、到期复习数。**只在用户问进度时调用**";
    render(<CompanionRunTraceView trace={traceWith({
      key: "tool:stats", kind: "tool", label: modelFacing, state: "succeeded",
      toolName: "companion_get_learning_stats", summary: "今日 39 分钟", proposalId: null,
    })} />);
    expect(screen.getByText("正在看你的学习数据")).toBeTruthy();
    expect(screen.queryByText(modelFacing)).toBeNull();
    expect(document.body.textContent).not.toContain("只在用户问进度时调用");
  });

  it("认不出的工具不猜语义，统一说「正在处理…」", () => {
    render(<CompanionRunTraceView trace={traceWith({
      key: "tool:odd", kind: "tool", label: "companion_do_something_new 的说明文字", state: "succeeded",
      toolName: "companion_do_something_new", summary: null, proposalId: null,
    })} />);
    expect(screen.getByText("正在处理…")).toBeTruthy();
    expect(document.body.textContent).not.toContain("companion_do_something_new");
  });
});

function traceWith(node: CompanionRunTrace["nodes"][number]): CompanionRunTrace {
  return {
    summary: {
      version: 1,
      runId: "11111111-1111-4111-8111-111111111111",
      status: "succeeded",
      generation: 1,
      stepCount: 1,
      toolCallCount: 1,
      maxSteps: 4,
      maxToolCalls: 4,
      assistantMessageId: "22222222-2222-4222-8222-222222222222",
      nodeCount: 1,
    },
    nodes: [node],
  };
}
