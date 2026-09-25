// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DialoguePanel } from "./companion-center-panels";
import type { CompanionHistoryItemV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { useRoomStore } from "../../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 伴星中心「对话」这一块登记给伴星读的是什么（39d W2-7）。
 *
 * 与记忆那一格的**关键差别**写在生产注释里，这里钉住它：`DialoguePanel` 不做本地
 * 二次筛选，`props.items` 就是服务端按关键词回给这一屏、屏上也就露出这些的那一批。
 * 所以"登记未筛的那一批"在这一格是**对的**，在记忆那一格是错的——两条用例分别盯着。
 */

type DialoguePanelProps = Parameters<typeof DialoguePanel>[0];

function message(id: string, role: CompanionHistoryItemV1["role"], text: string, overrides: Partial<CompanionHistoryItemV1> = {}): CompanionHistoryItemV1 {
  return {
    version: 1,
    messageId: id,
    role,
    kind: "text",
    blocks: [{ type: "text", text }],
    runId: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    editedAt: null,
    ...overrides,
  };
}

const noop = () => undefined;

function renderPanel(props: Partial<DialoguePanelProps> = {}) {
  const base = {
    section: {
      ok: true as const,
      value: { version: 1 as const, items: [], nextCursor: null },
    },
    items: [
      message("11111111-1111-4111-8111-111111111111", "user", "帮我看看第三章还缺什么证据"),
      message("22222222-2222-4222-8222-222222222222", "assistant", "缺一条把惯性与质量分开的反例。\n\n另外课上那句还需要原文。"),
    ],
    cursor: null,
    query: "",
    searching: false,
    loadingMore: false,
    error: null,
    onQuery: noop,
    onSearch: noop,
    onLoadMore: noop,
    onContinue: noop,
    onRetry: noop,
  } satisfies DialoguePanelProps;
  render(<DialoguePanel {...base} {...props} />);
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
});

describe("伴星中心 · 对话：登记的就是这一屏露出的那几条", () => {
  it("说话人字与正文首段与 DOM 逐字相同，顺序按屏幕", () => {
    renderPanel();
    const view = publishedView()!;
    expect(view.pageId).toBe("companion");
    expect(view.title).toBe("伴星中心");
    // 没搜索、没报错、有记录 ⇒ 那一格是空的，就不该有 statusLine。
    expect(view.statusLine).toBeUndefined();
    const rows = [...document.querySelectorAll(".companion-thread article")];
    expect(rows).toHaveLength(2);
    expect(view.items?.map((entry) => entry.ordinal)).toEqual([1, 2]);
    expect(view.items?.map((entry) => entry.state)).toEqual(
      rows.map((row) => row.querySelector("b")?.textContent),
    );
    expect(view.items?.[0].label).toBe(rows[0].querySelector("p")?.textContent);
    // 多段回复只登第一段（屏上是两段 `<p>`，她念第一段就够定位了）。
    expect(view.items?.[1].label).toBe("缺一条把惯性与质量分开的反例。");
    expect(rows[1].querySelectorAll("p")).toHaveLength(2);
    expect(view.filters).toBeUndefined();
  });

  it("搜索时那一格的句子进 statusLine，关键词进 filters", () => {
    renderPanel({ query: "惯性", items: [message("33333333-3333-4333-8333-333333333333", "user", "惯性那一章还缺什么")] });
    const view = publishedView()!;
    expect(view.statusLine).toBe(document.querySelector(".companion-result-status")?.textContent);
    expect(view.statusLine).toBe("找到 1 条对话");
    expect(view.filters).toEqual([{ label: "关键词", value: "惯性" }]);
  });

  it("正在搜索：那一格写什么就登记什么，不是「找到 0 条」", () => {
    renderPanel({ query: "惯性", searching: true, items: [] });
    const view = publishedView()!;
    expect(view.statusLine).toBe(document.querySelector(".companion-result-status")?.textContent);
    expect(view.statusLine).toBe("正在搜索对话");
  });

  it("一条记录都没有：说的是屏上那句空态，不登清单", () => {
    renderPanel({ items: [] });
    const view = publishedView()!;
    expect(view.items).toBeUndefined();
    expect(view.statusLine).toBe(document.querySelector(".companion-section-state strong")?.textContent);
    expect(view.notice).toBe(
      `${document.querySelector(".companion-section-state strong")?.textContent}：${document.querySelector(".companion-section-state span")?.textContent}`,
    );
  });

  it("这一格读不到时只发状态与原因，一行对话都不发", () => {
    renderPanel({ section: { ok: false, message: "伴星数据暂时不可用" } });
    const view = publishedView()!;
    expect(view.statusLine).toBe(document.querySelector(".companion-section-state strong")?.textContent);
    expect(view.items).toBeUndefined();
    expect(view.filters).toBeUndefined();
    expect(view.notice).toBe(`${view.statusLine}：伴星数据暂时不可用`);
  });
});
