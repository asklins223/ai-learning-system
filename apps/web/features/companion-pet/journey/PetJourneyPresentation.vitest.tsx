import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PetJourneyPresentation } from "./PetJourneyPresentation";
import { getPetJourneyLabTransition } from "./pet-journey-lab-transitions";
import {
  PET_JOURNEY_STORY_FRAMES,
  getPetJourneyStoryFrame,
} from "./pet-journey-fixtures";
import {
  isPetJourneyPresentationVisible,
  validatePetJourneyPresentation,
  type PetJourneyPresentationV2,
} from "./pet-journey-contracts";

function fixture(frameId: string): PetJourneyPresentationV2 {
  return getPetJourneyStoryFrame(frameId).presentation;
}

describe("PetJourneyPresentation", () => {
  it("首邀只显示三个同级路线与一个稍后动作", () => {
    const onIntent = vi.fn();
    render(<PetJourneyPresentation presentation={fixture("first-invitation")} onIntent={onIntent} />);

    expect(screen.getByText("第一次见面")).toBeTruthy();
    expect(screen.getByRole("button", { name: /用我的资料走一遍/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /体验 90 秒示例/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /我先自己看看/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /稍后再问我/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /用我的资料走一遍/ }));
    expect(onIntent).toHaveBeenCalledWith({
      kind: "choose_invitation",
      choiceId: "own-material",
      branch: "own_material",
    });
  });

  it("偏好选择是显式 typed intent，并保留跳过入口", () => {
    const onIntent = vi.fn();
    render(<PetJourneyPresentation presentation={fixture("intervention-preference")} onIntent={onIntent} />);

    fireEvent.click(screen.getByRole("button", { name: /适中/ }));
    expect(onIntent).toHaveBeenCalledWith({
      kind: "set_preference",
      preference: "intervention_level",
      value: "moderate",
    });
    expect(screen.getByRole("button", { name: "使用默认" })).toBeTruthy();
  });

  it("解析等待使用不伪造百分比的 indeterminate progress", () => {
    render(<PetJourneyPresentation presentation={fixture("source-processing")} onIntent={vi.fn()} />);

    const progress = screen.getByRole("progressbar", { name: "正在建立可追溯结构" });
    expect(progress.getAttribute("aria-valuenow")).toBeNull();
    expect(progress.getAttribute("data-indeterminate")).toBe("true");
    expect(screen.getByRole("button", { name: "完成后告诉我" })).toBeTruthy();
  });

  it("材料等待与失败状态不伪造进度，并为失败提供可逆重试", () => {
    const onIntent = vi.fn();
    const waiting = render(<PetJourneyPresentation presentation={fixture("source-waiting")} onIntent={onIntent} />);
    const waitingProgress = screen.getByRole("progressbar", { name: "等待系统开始解析" });
    expect(waitingProgress.getAttribute("aria-valuenow")).toBeNull();
    expect(screen.getByText(/尚未取得处理回执/)).toBeTruthy();
    waiting.unmount();

    render(<PetJourneyPresentation presentation={fixture("source-failed")} onIntent={onIntent} />);
    expect(screen.getByText(/未写入笔记与学习卡/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新尝试" }));
    expect(onIntent).toHaveBeenCalledWith({
      kind: "progress_action",
      actionId: "retry-source",
      action: "retry",
    });
  });

  it("确认卡清楚陈述影响，并在确认前只发 intent", () => {
    const onIntent = vi.fn();
    render(<PetJourneyPresentation presentation={fixture("run-confirmation")} onIntent={onIntent} />);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/不会自动作答/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /确认并打开任务/ }));
    expect(onIntent).toHaveBeenCalledWith({
      kind: "confirm_action",
      proposalId: "proposal-start-run-demo",
    });
  });

  it("确认卡初始聚焦取消，Escape 拒绝，并在卸载后恢复原焦点", () => {
    const onIntent = vi.fn();
    const before = document.createElement("button");
    before.textContent = "打开确认前的按钮";
    document.body.appendChild(before);
    before.focus();

    const view = render(<PetJourneyPresentation presentation={fixture("run-confirmation")} onIntent={onIntent} />);
    const cancel = screen.getByRole("button", { name: "取消" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onIntent).toHaveBeenCalledWith({
      kind: "reject_action",
      proposalId: "proposal-start-run-demo",
    });
    view.unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it("正式作答和 DND 都返回空呈现，杜绝提示泄露", () => {
    const formal = render(<PetJourneyPresentation presentation={fixture("formal-answer-silence")} onIntent={vi.fn()} />);
    expect(formal.container.innerHTML).toBe("");
    formal.unmount();

    const dnd = render(<PetJourneyPresentation presentation={fixture("dnd-suppressed")} onIntent={vi.fn()} />);
    expect(dnd.container.innerHTML).toBe("");
  });

  it("真实结果只显示 fixture 中明确的证明、缺口与调度影响", () => {
    render(<PetJourneyPresentation presentation={fixture("real-result")} onIntent={vi.fn()} />);

    expect(screen.getByText("已证明核心理解")).toBeTruthy();
    expect(screen.getByText(/能解释主动提取/)).toBeTruthy();
    expect(screen.getByText("首次复习已安排在 2 天后")).toBeTruthy();
    expect(screen.getByRole("button", { name: /看看星图变化/ })).toBeTruthy();
  });

  it("非证明结果使用诚实证据标题并覆盖关键退出结果", () => {
    const cases = [
      ["partial-result", "已确认的部分", "部分理解已有证据"],
      ["practice-result", "这次完成了", "已完成一次辅助练习"],
      ["skipped-result", "本次记录", "本次已跳过"],
      ["declared-unable-result", "已记录", "已记录当前困难"],
      ["not-assessable-result", "可确认的事实", "暂不可评估"],
    ] as const;

    for (const [frameId, evidenceLabel, outcomeLabel] of cases) {
      const view = render(<PetJourneyPresentation presentation={fixture(frameId)} onIntent={vi.fn()} />);
      expect(screen.getByText(evidenceLabel)).toBeTruthy();
      expect(screen.getByText(outcomeLabel)).toBeTruthy();
      expect(screen.queryByText("已经证明")).toBeNull();
      view.unmount();
    }
  });

  it("恢复卡说明保留与未发生的副作用", () => {
    render(<PetJourneyPresentation presentation={fixture("recoverable-error")} onIntent={vi.fn()} />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Artifact 已锁定；没有 Commit/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试评估" })).toBeTruthy();
  });

  it("故事页中的拒绝、延期和结果动作都有下一帧或诚实回执", () => {
    const transitions = [
      getPetJourneyLabTransition({ kind: "choose_invitation", choiceId: "self-explore", branch: "self_explore" }, "first-invitation"),
      getPetJourneyLabTransition({ kind: "defer_invitation", permitId: "permit" }, "first-invitation"),
      getPetJourneyLabTransition({ kind: "reject_run_proposal", proposalId: "proposal" }, "run-proposal"),
      getPetJourneyLabTransition({ kind: "result_action", resultRef: "result", action: "view_evidence" }, "not-assessable-result"),
      getPetJourneyLabTransition({ kind: "dismiss_recovery", errorCode: "error" }, "recoverable-error"),
    ];

    for (const transition of transitions) {
      expect(Boolean(transition.targetFrameId || transition.receipt)).toBe(true);
    }
    expect(transitions[0].receipt?.detail).toMatch(/没有接工作区导航/);
    expect(transitions[3].receipt?.detail).toMatch(/没有读取或修改真实学习记录/);
  });

  it("全部故事 fixture 合法、id 唯一，且呈现层不创建头像", () => {
    const ids = new Set<string>();
    for (const [index, frame] of PET_JOURNEY_STORY_FRAMES.entries()) {
      expect(frame.sequence).toBe(index + 1);
      expect(validatePetJourneyPresentation(frame.presentation)).toEqual([]);
      expect(ids.has(frame.presentation.presentationId)).toBe(false);
      ids.add(frame.presentation.presentationId);
      expect(isPetJourneyPresentationVisible(frame.presentation)).toBe(frame.presentation.kind !== "silent");
    }

    const { container } = render(<PetJourneyPresentation presentation={fixture("first-invitation")} onIntent={vi.fn()} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
  });
});
