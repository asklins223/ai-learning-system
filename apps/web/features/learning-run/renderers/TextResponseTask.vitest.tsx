import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { TextResponseTask } from "./TextResponseTask";
import type { LearningTaskPublicV1 } from "../contracts";

afterEach(cleanup);

function textTask(): LearningTaskPublicV1 & {
  interaction: Extract<LearningTaskPublicV1["interaction"], { kind: "text_response" }>;
} {
  return {
    taskId: "t-text",
    sequence: 1,
    intent: "explain",
    purpose: "formal",
    title: "解释机制",
    prompt: "为什么主动回忆有效？",
    targetSummary: "说明主动提取的机制",
    interaction: {
      kind: "text_response",
      maxChars: 600,
      placeholder: "先说清最关键因果",
    },
    alternatives: [],
    trustCeiling: "mastery_eligible",
    estimatedActiveSeconds: 58,
    status: "active",
    revision: 1,
  };
}

describe("TextResponseTask 提交 busy-lock（round3 F#7）", () => {
  it("空文本禁用提交；输入后提交一次发一条 submit_text", () => {
    const onIntent = vi.fn();
    render(<TextResponseTask task={textTask()} onIntent={onIntent} />);

    const submit = screen.getByRole("button", { name: "锁定并提交回答" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("先说清最关键因果"), {
      target: { value: "因为主动回忆会强化提取线索" },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(submit);
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent).toHaveBeenCalledWith({
      kind: "submit_text",
      text: "因为主动回忆会强化提取线索",
    });
  });

  it("快速双击提交按钮只发出一次 submit intent（busy-lock 防重）", () => {
    const onIntent = vi.fn();
    render(<TextResponseTask task={textTask()} onIntent={onIntent} />);

    fireEvent.change(screen.getByPlaceholderText("先说清最关键因果"), {
      target: { value: "主动回忆强化记忆线索" },
    });
    const submit = screen.getByRole("button", { name: "锁定并提交回答" });
    // 双击：第二次点击时 submitting 已置位，按钮被 disabled，不应再发 intent。
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(onIntent).toHaveBeenCalledTimes(1);
  });

  it("提交后按钮进入 disabled 锁定态（显示“正在提交…”）", () => {
    render(<TextResponseTask task={textTask()} onIntent={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("先说清最关键因果"), {
      target: { value: "提交后锁定" },
    });
    const submit = screen.getByRole("button", { name: "锁定并提交回答" });
    fireEvent.click(submit);
    expect(screen.getByRole("button", { name: "正在提交…" })).toBeTruthy();
  });

  it("task 对象身份变化后复位 busy-lock，按钮可再次提交（round4 F22）", () => {
    const onIntent = vi.fn();
    const first = textTask();
    const { rerender } = render(<TextResponseTask task={first} onIntent={onIntent} />);

    fireEvent.change(screen.getByPlaceholderText("先说清最关键因果"), {
      target: { value: "提交时锁定" },
    });
    fireEvent.click(screen.getByRole("button", { name: "锁定并提交回答" }));
    // 提交后处于锁定态
    expect(screen.getByRole("button", { name: "正在提交…" })).toBeTruthy();

    // 同一渲染树仅 task 身份变化（revision bump / 变体轮转）
    const next = textTask();
    const nextTask = { ...next, taskId: "t-text", revision: next.revision + 1 };
    rerender(<TextResponseTask task={nextTask} onIntent={onIntent} />);

    // 复位：按钮回到可提交态
    fireEvent.change(screen.getByPlaceholderText("先说清最关键因果"), {
      target: { value: "再次提交" },
    });
    const submit = screen.getByRole("button", { name: "锁定并提交回答" });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    expect(onIntent).toHaveBeenCalledWith({ kind: "submit_text", text: "再次提交" });
  });
});
