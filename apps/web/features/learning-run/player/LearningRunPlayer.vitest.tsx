import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { ThemeProvider } from "@/components/ThemeProvider";
import { LEARNING_RUN_DEMO_SCENARIOS } from "../demo-fixtures";
import type { LearningRunPublicV1 } from "../contracts";
import { LearningRunPlayer } from "./LearningRunPlayer";

afterEach(cleanup);

function renderPlayer(run: LearningRunPublicV1, onIntent = vi.fn()) {
  render(
    <ThemeProvider>
      <LearningRunPlayer run={run} onIntent={onIntent} />
    </ThemeProvider>,
  );
  return onIntent;
}

function snapshot(scenarioId: string, frameId: string): LearningRunPublicV1 {
  const scenario = LEARNING_RUN_DEMO_SCENARIOS.find((item) => item.scenarioId === scenarioId);
  const frame = scenario?.frames.find((item) => item.frameId === frameId);
  if (!frame) throw new Error(`Missing fixture ${scenarioId}/${frameId}`);
  return frame.snapshot;
}

describe("LearningRunPlayer", () => {
  it("呈现精确任务，并让换方式、跳过和声明不会一步可达", () => {
    renderPlayer(snapshot("card-text", "active-text"));

    expect(screen.getByRole("heading", { name: /为什么主动回忆/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /换个方式/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /先跳过/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /我确实不会/ })).toBeTruthy();
  });

  it("锁定文字回答时只提交用户原文", () => {
    const onIntent = renderPlayer(snapshot("card-text", "active-text"));
    const textbox = screen.getByRole("textbox", { name: "用你自然的表达回答" });
    fireEvent.change(textbox, { target: { value: "因为主动提取会强化记忆线索。" } });
    fireEvent.click(screen.getByRole("button", { name: /锁定并提交回答/ }));

    expect(onIntent).toHaveBeenCalledWith({
      kind: "submit_text",
      text: "因为主动提取会强化记忆线索。",
    });
  });

  it("查看提示前明确确认降级为练习", () => {
    const onIntent = renderPlayer(snapshot("card-text", "active-text"));
    fireEvent.click(screen.getByRole("button", { name: /给我一点提示/ }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("查看提示后，本题只记为练习")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "降为练习并查看" }));
    expect(onIntent).toHaveBeenCalledWith({ kind: "request_hint", level: 1 });
  });

  it("排序任务提供无需拖拽的点选与键盘路径", () => {
    const onIntent = renderPlayer(snapshot("review-voice", "active-ordering"));

    fireEvent.click(screen.getByRole("button", { name: /先合上材料/ }));
    fireEvent.click(screen.getByRole("button", { name: /对照材料/ }));
    fireEvent.click(screen.getByRole("button", { name: /隔一段时间/ }));
    const submit = screen.getByRole("button", { name: /锁定这个顺序/ });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    expect(onIntent).toHaveBeenCalledWith({
      kind: "submit_ordering",
      orderedTokenIds: ["recall", "compare", "repeat"],
    });
  });

  it("修复任务以选项式填空提交明确的问题句与替换项", () => {
    const onIntent = renderPlayer(snapshot("review-voice", "active-repair"));
    fireEvent.click(screen.getByLabelText(/重复阅读会让内容越来越熟悉/));
    fireEvent.click(screen.getByLabelText(/看着熟悉依赖材料提供线索/));
    fireEvent.click(screen.getByRole("button", { name: /提交修复方案/ }));

    expect(onIntent).toHaveBeenCalledWith({
      kind: "submit_repair",
      elementId: "s1",
      replacementOptionId: "opt-c",
    });
  });

  it("复述题可用说法与理由完成，不要求输入长文本", () => {
    const onIntent = renderPlayer(snapshot("low-friction-intents", "active-paraphrase-choice"));
    fireEvent.click(screen.getByLabelText(/每次把答案从脑中找出来/));
    fireEvent.click(screen.getByRole("button", { name: "保留了主动从记忆中找答案" }));
    fireEvent.click(screen.getByRole("button", { name: "说明了对下一次访问的影响" }));
    fireEvent.click(screen.getByRole("button", { name: /锁定这组理解/ }));
    expect(onIntent).toHaveBeenCalledWith({ kind: "submit_choice_with_rationale", choiceId: "c1", rationaleIds: ["r1", "r2"] });
  });

  it("举例题用具体场景行动与线索形成 Artifact", () => {
    const onIntent = renderPlayer(snapshot("low-friction-intents", "active-example-scenario"));
    fireEvent.click(screen.getByLabelText(/合上笔记，先说出定义再核对/));
    fireEvent.click(screen.getByRole("button", { name: "先离开原材料" }));
    fireEvent.click(screen.getByRole("button", { name: "主动尝试说出答案" }));
    fireEvent.click(screen.getByRole("button", { name: /提交这个应用判断/ }));
    expect(onIntent).toHaveBeenCalledWith({ kind: "submit_scenario", choiceId: "close-recall", cueIds: ["cue-no-source", "cue-retrieve"] });
  });

  it("应用题可通过关系连接完成", () => {
    const onIntent = renderPlayer(snapshot("low-friction-intents", "active-apply-relation"));
    fireEvent.click(screen.getByRole("button", { name: /看着熟悉，合上后说不出/ }));
    fireEvent.click(screen.getByRole("button", { name: "therefore" }));
    fireEvent.click(screen.getByRole("button", { name: /锁定这条关系/ }));
    expect(onIntent).toHaveBeenCalledWith({ kind: "submit_relation", fromNodeId: "signal", toNodeId: "target-recall", edgeKind: "therefore" });
  });

  it("部分与不可评估结果提供和下一步文案一致的 CTA", () => {
    const partialIntent = renderPlayer(snapshot("result-semantics", "result-partial"));
    fireEvent.click(screen.getByRole("button", { name: /30 秒补上缺失点/ }));
    expect(partialIntent).toHaveBeenCalledWith({ kind: "checkpoint_primary" });

    const notAssessableIntent = vi.fn();
    renderPlayer(snapshot("result-semantics", "result-not_assessable"), notAssessableIntent);
    expect(screen.getByRole("button", { name: "重新录制" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "换成两三句话" })).toBeTruthy();
  });

  it("声明不会不承诺 UI 尚未获授权的调度变化", () => {
    renderPlayer(snapshot("card-text", "active-text"));
    expect(screen.getByText("只记录当前选择，不承诺自动改期")).toBeTruthy();
  });

  it("评估和 Commit 期间不提前展示复习结果", () => {
    renderPlayer(snapshot("card-text", "assessing"));
    expect(screen.getByRole("heading", { name: "正在独立评估你的回答" })).toBeTruthy();
    expect(screen.queryByText(/已安排复习/)).toBeNull();
    expect(screen.getByRole("button", { name: "先离开，完成后告诉我" })).toBeTruthy();
  });

  it("提示后结果只声明练习完成和零调度副作用", () => {
    renderPlayer(snapshot("result-semantics", "result-practice_completed"));
    expect(screen.getByText("练习完成")).toBeTruthy();
    expect(screen.getByText("复习安排没有改变")).toBeTruthy();
    expect(screen.getByText(/提示后练习不会改变正式掌握状态/)).toBeTruthy();
    expect(screen.queryByText(/已经掌握/)).toBeNull();
  });

  it("提示激活态仍要求用户完成回答，并明确只记为练习", () => {
    renderPlayer(snapshot("card-text", "active-text-hint"));
    expect(screen.getByText("一级提示 · 本题已降为练习")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "用你自然的表达回答" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /锁定并提交回答/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /你已经借助提示/ })).toBeNull();
  });
});
