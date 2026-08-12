/**
 * 完整对话页组件冒烟测试（2026-08-12 重构后建立）。
 *
 * 验证三个 UI 组件的 jsdom 渲染链与关键交互：列表选中回调、
 * 空状态引导、消息气泡 + markdown、流式光标、输入框 Enter 提交。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationMessages } from "./ConversationMessages";
import { ConversationSidebar } from "./ConversationSidebar";
import type { Message } from "./conversation-model";

const userMessage: Message = {
  id: "m-user",
  role: "user",
  seq: 1,
  blocks: [{ type: "text", text: "帮我梳理今天学的内容" }],
  createdAt: "2026-08-12T09:30:00.000Z",
};

const assistantMessage: Message = {
  id: "m-assistant",
  role: "assistant",
  seq: 2,
  blocks: [{ type: "text", text: "好的，**先总结**一下重点：\n\n- 第一点\n- 第二点" }],
  createdAt: "2026-08-12T09:30:05.000Z",
};

describe("ConversationSidebar", () => {
  it("空列表显示引导文案", () => {
    render(<ConversationSidebar conversations={[]} selectedId={null} onSelect={() => {}} onCreate={() => {}} />);
    expect(screen.getByText(/还没有对话/)).toBeTruthy();
  });

  it("列表项展示标题与选中态，点击回调", () => {
    const onSelect = vi.fn();
    render(
      <ConversationSidebar
        conversations={[{ id: "c1", title: "今天学什么", createdAt: "2026-08-12T08:00:00.000Z", lastMessageAt: "2026-08-12T09:00:00.000Z" }]}
        selectedId="c1"
        onSelect={onSelect}
        onCreate={() => {}}
      />,
    );
    const item = screen.getByText("今天学什么");
    expect(item).toBeTruthy();
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith("c1");
  });
});

describe("ConversationMessages", () => {
  it("空状态展示引导与示例问题，点击填入草稿", () => {
    const onSuggestion = vi.fn();
    render(<ConversationMessages messages={[]} sending={false} hasConversation={false} onSuggestion={onSuggestion} />);
    expect(screen.getByText("和伴星聊聊")).toBeTruthy();
    fireEvent.click(screen.getByText("帮我梳理今天学的内容"));
    expect(onSuggestion).toHaveBeenCalledWith("帮我梳理今天学的内容");
  });

  it("渲染 user/assistant 气泡与 markdown 排版", () => {
    render(<ConversationMessages messages={[userMessage, assistantMessage]} sending={false} hasConversation onSuggestion={() => {}} />);
    expect(screen.getByText("帮我梳理今天学的内容")).toBeTruthy();
    // MarkdownPreview 渲染粗体与列表
    expect(screen.getByText("先总结", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("第一点")).toBeTruthy();
  });

  it("流式回复展示生成中光标", () => {
    const streaming: Message = { ...assistantMessage, id: "assistant-run1", blocks: [{ type: "text", text: "正在写" }] };
    render(<ConversationMessages messages={[streaming]} sending hasConversation onSuggestion={() => {}} />);
    expect(document.querySelector(".conversation-caret")).toBeTruthy();
  });
});

describe("ConversationComposer", () => {
  it("空草稿禁用发送，输入后启用并可提交", () => {
    const onSubmit = vi.fn();
    render(<ConversationComposer draft="" sending={false} onChange={() => {}} onSubmit={onSubmit} />);
    const send = document.querySelector(".conversation-composer__send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(screen.getByPlaceholderText(/问问题/), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter 提交草稿，Shift+Enter 不提交", () => {
    const onSubmit = vi.fn();
    render(<ConversationComposer draft="一条消息" sending={false} onChange={() => {}} onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/问问题/), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByPlaceholderText(/问问题/), { key: "Enter", shiftKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
