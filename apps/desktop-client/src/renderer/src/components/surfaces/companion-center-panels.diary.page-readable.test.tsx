// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiaryPanel } from "./companion-center-panels";
import { todayIsoDate } from "./companion-diary-day";
import type { CompanionDailySummaryV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { useRoomStore } from "../../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 伴星中心「日记」这一块登记给伴星读的是什么（39d W2-7）。
 *
 * 这一格特殊在**四种屏幕状态共用一个入口**（读取中／读不到／这一天没写／这一天写了），
 * 而 hook 不能走在条件 return 之后——所以登记必须一次算完四种状态，
 * 每种都只说那一刻屏幕上真写着的那句。
 */

type DiaryPanelProps = Parameters<typeof DiaryPanel>[0];

const noop = () => undefined;

function daily(overrides: Partial<CompanionDailySummaryV1> = {}): CompanionDailySummaryV1 {
  return {
    version: 1,
    date: todayIsoDate(),
    status: "generated",
    generatedAt: "2026-09-24T21:00:00.000Z",
    failureReason: null,
    blocks: [
      { type: "text", text: "今天把惯性那一章往前推了一段。" },
      { type: "text", text: "课上那句反例还没有原文撑着。" },
    ],
    memory: null,
    ...overrides,
  } as CompanionDailySummaryV1;
}

function renderPanel(props: Partial<DiaryPanelProps> = {}) {
  const base = {
    section: { ok: true as const, value: daily() },
    loading: false,
    failure: null,
    date: null,
    onDate: noop,
    onMemory: noop,
    onRetry: noop,
    marks: null,
    marksFailure: null,
    onMarksMonth: noop,
  } satisfies DiaryPanelProps;
  render(<DiaryPanel {...base} {...props} />);
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
});

describe("伴星中心 · 日记：只说那一刻屏幕上写着的", () => {
  it("写出来了：正文逐段与 DOM 相同，生成那行与日期胶囊也逐字", () => {
    renderPanel();
    const view = publishedView()!;
    expect(view.pageId).toBe("companion");
    expect(view.title).toBe("伴星中心");
    const prose = [...document.querySelectorAll(".companion-diary-prose")].map((node) => node.textContent);
    expect(prose).toHaveLength(2);
    expect(view.items?.map((entry) => entry.label)).toEqual(prose);
    expect(view.items?.map((entry) => entry.ordinal)).toEqual([1, 2]);
    expect(view.statusLine).toBe(document.querySelector(".companion-diary-entry small")?.textContent);
    expect(view.filters).toEqual([{ label: "日期", value: document.querySelector(".companion-date-pick__trigger span")?.textContent }]);
    expect(view.notice).toBeUndefined();
  });

  it("这一天还没有日记：说的是屏上那句，不登正文", () => {
    renderPanel({ section: { ok: true, value: daily({ status: "not_generated", blocks: [], date: null }) } });
    const view = publishedView()!;
    expect(view.items).toBeUndefined();
    // 逐字，不是"包含"：拼上日期或别的东西就该红。
    expect(view.statusLine).toBe(document.querySelector(".companion-section-state strong")?.textContent);
    expect(view.statusLine).toBe("这一天还没有日记");
    // 这一天没写，但上面那颗日期胶囊还写着 ⇒ 日期仍然进 filters。
    expect(view.filters).toEqual([{ label: "日期", value: document.querySelector(".companion-date-pick__trigger span")?.textContent }]);
    expect(view.notice).toBeUndefined();
  });

  it("这一天没写下来：状态句与那句原因都来自屏幕", () => {
    renderPanel({
      section: {
        ok: true,
        value: daily({ status: "failed", failureReason: "model_unavailable", blocks: [{ type: "text", text: "占位，屏幕上不会显示这一段" }] }),
      },
    });
    const state = document.querySelector(".companion-section-state")!;
    const view = publishedView()!;
    // failed 那一格屏上只有一句标题＋原因：blocks 一条都不许登记（屏幕上是空的）。
    expect(view.items).toBeUndefined();
    expect(view.statusLine).toBe(state.querySelector("strong")?.textContent);
    expect(view.filters).toEqual([{ label: "日期", value: document.querySelector(".companion-date-pick__trigger span")?.textContent }]);
    expect(view.notice).toBe(
      `${state.querySelector("strong")?.textContent}：${state.querySelector("span")?.textContent}`,
    );
    expect(view.notice).toContain("她试了几次没写出来");
  });

  it("整格读不到：只发状态与原因", () => {
    renderPanel({ section: null, failure: "伴星数据暂时不可用" });
    const view = publishedView()!;
    expect(view.statusLine).toBe(document.querySelector(".companion-section-state strong")?.textContent);
    expect(view.items).toBeUndefined();
    expect(view.filters).toBeUndefined();
    expect(view.notice).toBe("日记当前不可用：伴星数据暂时不可用");
  });

  it("第一次读取没回来：说的是「正在读取日记」，不发任何一天的内容", () => {
    renderPanel({ section: null, loading: true, failure: null });
    const view = publishedView()!;
    expect(view.statusLine).toBe(document.querySelector(".companion-section-state strong")?.textContent);
    expect(view.items).toBeUndefined();
  });
});
