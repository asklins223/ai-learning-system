import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CompanionHistoryArchive } from "./CompanionHistoryArchive";
import { COMPANION_HISTORY_FIXTURES } from "./history-fixtures";
import {
  adaptProductionHistoryMessage,
  historyEntryText,
  historyReferenceState,
  parseProductionBlocks,
} from "./history-model";

const selected = COMPANION_HISTORY_FIXTURES[0];
const conversations = COMPANION_HISTORY_FIXTURES.map((conversation) => ({
  id: conversation.id,
  title: conversation.title,
  createdAt: conversation.createdAt,
  lastMessageAt: conversation.lastMessageAt,
  messageCount: conversation.entries.length,
}));

function renderArchive(onSelect = vi.fn(), onLoadEarlier = vi.fn()) {
  render(
    <CompanionHistoryArchive
      conversations={conversations}
      selectedId={selected.id}
      entries={selected.entries}
      onSelect={onSelect}
      source="prototype"
      limitationNote="开发预览不会修改账户数据。"
      historyPage={{
        loadedCount: 5,
        totalCount: 8,
        hasEarlier: true,
        onLoadEarlier,
      }}
    />,
  );
  return { onSelect, onLoadEarlier };
}

describe("CompanionHistoryArchive", () => {
  it("定位为只读档案，并明确标记原型数据", () => {
    renderArchive();

    expect(screen.getByRole("heading", { name: "伴星交互档案" })).toBeTruthy();
    expect(screen.getByText("开发预览 · 非账户数据")).toBeTruthy();
    expect(screen.getAllByText("只读记录").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /新对话/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /发送/ })).toBeNull();
    expect(screen.queryByPlaceholderText(/问问题|发送消息/)).toBeNull();
    expect(document.querySelector(".history-index__portrait img")).toBeNull();
  });

  it("展示语音、主动介入、行动、结果、路由、错误与恢复结构", () => {
    renderArchive();

    expect(screen.getByText("语音转写")).toBeTruthy();
    expect(screen.getByText("已确认转写")).toBeTruthy();
    expect(screen.getAllByText("主动介入").length).toBeGreaterThan(0);
    expect(screen.getByText("创建 LearningRun")).toBeTruthy();
    expect(screen.getByText("LearningRun 结果")).toBeTruthy();
    expect(screen.getByRole("link", { name: /进入 3 分钟学习旅程/ })).toBeTruthy();
    expect(screen.getByText("STAR_PROJECTION_DELAYED")).toBeTruthy();
    expect(screen.getByText("星图显影已恢复")).toBeTruthy();
  });

  it("按类型和文本检索当前时间线", () => {
    renderArchive();

    fireEvent.click(screen.getByRole("button", { name: /异常与恢复/ }));
    expect(screen.getByText("STAR_PROJECTION_DELAYED")).toBeTruthy();
    expect(screen.getByText("星图显影已恢复")).toBeTruthy();
    expect(screen.queryByText("创建 LearningRun")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^全部/ }));
    fireEvent.change(screen.getByPlaceholderText("搜索这段记录的内容、状态或引用"), {
      target: { value: "长期线索" },
    });
    expect(screen.getByText(/间隔制造了真实提取难度/)).toBeTruthy();
    expect(screen.queryByText("STAR_PROJECTION_DELAYED")).toBeNull();
  });

  it("切换对话只触发外部读取选择，不创建新会话", () => {
    const { onSelect } = renderArchive();
    fireEvent.click(screen.getByRole("button", { name: /第一次进入：认识学习路径/ }));
    expect(onSelect).toHaveBeenCalledWith("preview-onboarding");
  });

  it("为更早记录保留真实分页入口，不伪称已经完整读取", () => {
    const { onLoadEarlier } = renderArchive();
    expect(screen.getByText("这段对话还有更早记录")).toBeTruthy();
    expect(screen.getByText("已显示 5 / 8 条")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "载入更早记录" }));
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("把管理能力明确展示为待接线，并提供日期、Run、来源筛选", () => {
    renderArchive();

    expect(screen.getByText("精确筛选")).toBeTruthy();
    expect(screen.getByLabelText("日期")).toBeTruthy();
    expect(screen.getByLabelText("Learning Run")).toBeTruthy();
    expect(screen.getByLabelText("来源")).toBeTruthy();
    expect(screen.getByRole("button", { name: /导出/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /删除/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /召回桌宠/ })).toHaveProperty("disabled", true);
  });

  it("优先按 role 标识 actor，用户动作不会被写成伴星行动", () => {
    render(
      <CompanionHistoryArchive
        conversations={[conversations[0]]}
        selectedId={conversations[0].id}
        onSelect={vi.fn()}
        source="production"
        entries={[{
          id: "user-action",
          role: "user",
          kind: "action",
          seq: 1,
          createdAt: "2026-08-13T02:00:00.000Z",
          blocks: [{ type: "text", text: "我确认稍后再做" }],
        }]}
      />,
    );

    expect(screen.getByText("操作确认")).toBeTruthy();
    expect(screen.queryByText("伴星行动")).toBeNull();
  });

  it("历史 Markdown 下调标题并阻止远程图片自动加载", () => {
    render(
      <CompanionHistoryArchive
        conversations={[conversations[0]]}
        selectedId={conversations[0].id}
        onSelect={vi.fn()}
        source="production"
        entries={[{
          id: "remote-image",
          role: "assistant",
          kind: "text",
          seq: 1,
          createdAt: "2026-08-13T02:00:00.000Z",
          blocks: [{ type: "text", text: "# 子标题\n\n![追踪图](https://example.com/tracker.png)" }],
        }]}
      />,
    );

    expect(screen.getByRole("heading", { name: "子标题", level: 2 })).toBeTruthy();
    expect(screen.getByText("远程图片未自动加载：追踪图")).toBeTruthy();
    expect(document.querySelector('img[src="https://example.com/tracker.png"]')).toBeNull();
  });
});

describe("history production adapter", () => {
  it("解析 Message V1 的生产内容块、保留引用并拒绝非 HTTPS 外链", () => {
    const blocks = parseProductionBlocks([
      { type: "text", text: "已准备" },
      { type: "code", language: "ts", code: "const ready = true" },
      { type: "citation", label: "笔记", target: { kind: "entity", entityRef: "note:1" } },
      { type: "citation", label: "安全网页", target: { kind: "external_https", href: "https://example.com/source" } },
      { type: "citation", label: "不安全网页", target: { kind: "external_https", href: "javascript:alert(1)" } },
      { type: "action_ref", proposalId: "proposal-1" },
      { type: "result_ref", actionRunId: "run-1" },
      { type: "future_block", payload: "ignored" },
    ]);

    expect(blocks).toHaveLength(6);
    expect(blocks.map((block) => block.type)).toEqual([
      "text",
      "code",
      "citation",
      "citation",
      "action_ref",
      "result_ref",
    ]);
  });

  it("从生产 kind 和 blocks 生成可搜索的只读条目", () => {
    const entry = adaptProductionHistoryMessage({
      id: "message-1",
      role: "assistant",
      kind: "proactive",
      seq: 9,
      blocks: [{ type: "text", text: "该复习了" }],
      createdAt: "2026-08-13T02:00:00.000Z",
    });

    expect(entry.kind).toBe("proactive");
    expect(entry.sourceLabel).toBe("桌面伴星");
    expect(historyEntryText(entry)).toContain("该复习了");
  });

  it("引用状态缺失或未知时保守回退，只有明确终态使用成功视觉", () => {
    expect(historyReferenceState("action")).toMatchObject({ tone: "unknown", label: "状态待确认" });
    expect(historyReferenceState("result", "future_state")).toMatchObject({ tone: "unknown", label: "状态待确认" });
    expect(historyReferenceState("action", "awaiting_authorization")).toMatchObject({ tone: "pending" });
    expect(historyReferenceState("action", "expired")).toMatchObject({ tone: "stopped", label: "提案已过期" });
    expect(historyReferenceState("result", "committed")).toMatchObject({ tone: "success", label: "结果已提交" });
  });
});
