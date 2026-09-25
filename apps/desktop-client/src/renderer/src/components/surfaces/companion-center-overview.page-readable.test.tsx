// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionCenterOverview } from "./companion-center-overview";
import {
  companionActivityTimelineV1Schema,
  companionDailySummaryV1Schema,
  companionHistoryPageV1Schema,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { useRoomStore } from "../../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 伴星中心「概览」这一块登记给伴星读的是什么（39d W2-7 的最后一块）。
 *
 * 这一屏是三块各露一行，`state` 一律是"这一行属于屏上哪个小标题"：
 * 日记摘录挂在「原文摘录」下面，它的小标题就是「原文摘录」而不是「最近一篇日记」。
 * **要点开才看得到的内容一条都不登记**（整篇日记的其余段落、第 3 件以后的便签），
 * 但露出的那一行上写着"N 件"，所以那个数原样进 `metrics`。
 */

const noop = () => undefined;

function daily(overrides: Record<string, unknown> = {}) {
  return companionDailySummaryV1Schema.parse({
    version: 1,
    date: "2026-09-24",
    status: "generated",
    generatedAt: "2026-09-24T21:00:00.000Z",
    failureReason: null,
    blocks: [{ type: "text", text: "今天把第三章的反例补上了一条。" }],
    memory: null,
    ...overrides,
  });
}

function delivery(id: number, label: string) {
  return {
    version: 1,
    deliveryId: `77777777-7777-4777-8777-00000000000${id}`,
    inboxSequence: id,
    state: "delivered",
    kind: "message",
    label,
    target: { kind: "none" },
    expired: false,
    createdAt: `2026-09-2${4 - id}T00:00:00.000Z`,
    expiresAt: "2026-10-24T00:00:00.000Z",
  };
}

function timeline(deliveries: ReturnType<typeof delivery>[]) {
  return companionActivityTimelineV1Schema.parse({
    version: 1,
    items: deliveries,
    nextCursor: 0,
    serverTime: "2026-09-25T00:00:00.000Z",
  });
}

function history(items: Array<Record<string, unknown>> = []) {
  return companionHistoryPageV1Schema.parse({ version: 1, items, nextCursor: null });
}

function assistantReply(text: string) {
  return {
    version: 1,
    messageId: "88888888-8888-4888-8888-888888888888",
    role: "assistant",
    kind: "text",
    blocks: [{ type: "text", text }],
    runId: null,
    createdAt: "2026-09-24T10:00:00.000Z",
    editedAt: null,
  };
}

type OverviewProps = Parameters<typeof CompanionCenterOverview>[0];

function renderOverview(props: Partial<OverviewProps> = {}) {
  const base: OverviewProps = {
    companionName: "小满",
    diary: { ok: true, value: daily() },
    history: { ok: true, value: history([assistantReply("惯性那一章还缺一个反例。")]) },
    activity: { ok: true, value: timeline([delivery(1, "第三章那段还缺一个反例"), delivery(2, "要不要把这条补进笔记")]) },
    onContinue: noop,
    onGo: noop,
  };
  render(<CompanionCenterOverview {...base} {...props} />);
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

function titles(): (string | null)[] {
  return [...document.querySelectorAll(".companion-overview h3, .companion-overview__excerpt-label")]
    .map((node) => node.textContent);
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
});

describe("伴星中心 · 概览：三块各露一行，没露出的不登记", () => {
  it("摘录、两条便签、最近回复都逐字对上，`state` 是各自行上方那个小标题", () => {
    renderOverview();
    const view = publishedView()!;
    expect(view.pageId).toBe("companion");
    expect(view.title).toBe("伴星中心");
    const excerpt = document.querySelector(".companion-overview__excerpt")?.textContent;
    const pendingLabels = [...document.querySelectorAll(".companion-overview__pending li span")]
      .map((node) => node.textContent);
    const reply = document.querySelector(".companion-overview__reply")?.textContent;
    expect(excerpt).toBeTruthy();
    expect(pendingLabels).toHaveLength(2);
    expect(view.items?.map((entry) => entry.label)).toEqual([excerpt, ...pendingLabels, reply]);
    expect(view.items?.map((entry) => entry.state)).toEqual(["原文摘录", "需要你回应", "需要你回应", "最近的对话"]);
    expect(view.items?.[0].state).toBe(document.querySelector(".companion-overview__excerpt-label")?.textContent);
    expect(titles()).toContain("最近一篇日记");
  });

  it("待回应的件数与日记日期取自屏上那两格，不自己算", () => {
    renderOverview();
    const view = publishedView()!;
    expect(view.metrics).toEqual([
      { label: "待回应", value: document.querySelector(".companion-overview__pending .companion-overview__section-head > span:last-of-type")?.textContent ?? "" },
      { label: "最近日记", value: document.querySelector(".companion-overview__diary time")?.textContent ?? "" },
    ]);
    expect(view.metrics?.[0].value).toBe("2 件");
  });

  it("只露两条：第三条便签不登记，但计数说的是全部", () => {
    renderOverview({
      activity: {
        ok: true,
        value: timeline([delivery(1, "第一条"), delivery(2, "第二条"), delivery(3, "第三条")]),
      },
    });
    const view = publishedView()!;
    const labels = view.items?.map((entry) => entry.label) ?? [];
    expect(labels).not.toContain("第三条");
    expect(labels).toContain("第一条");
    expect(labels).toContain("第二条");
    expect(view.metrics?.find((entry) => entry.label === "待回应")?.value).toBe("3 件");
    expect(document.body.textContent).toContain("查看全部 3 件");
  });

  it("三块都读不到：登记的是屏上那三句，计数那一格不出现", () => {
    renderOverview({
      diary: { ok: false, message: "服务不可用" },
      history: { ok: false, message: "服务不可用" },
      activity: { ok: false, message: "服务不可用" },
    });
    const view = publishedView()!;
    expect(view.items?.map((entry) => entry.label)).toEqual([
      "日记暂时读不到。你仍可以继续交流。",
      "动态暂时读不到。",
      "对话记录暂时读不到。",
    ]);
    expect(view.items?.map((entry) => entry.label)).toEqual(
      [...document.querySelectorAll(".companion-overview__state")].map((node) => node.textContent),
    );
    // 三块都读不到 ⇒ 没有一格写着计数或日期，就不发 `metrics`（不硬凑一个空数组）。
    expect(view.metrics).toBeUndefined();
  });

  it("日记以图片开篇：登记的是屏上那句提示，不假装读到了正文", () => {
    renderOverview({
      diary: { ok: true, value: daily({ blocks: [{ type: "image", url: "/api/uploads/11111111-1111-4111-8111-111111111111/notes/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.jpg", label: "板书照片" }] }) },
    });
    const view = publishedView()!;
    const state = document.querySelector(".companion-overview__diary .companion-overview__state")?.textContent;
    expect(state).toBe("这篇日记以图片开篇，打开后可按原顺序阅读。");
    expect(view.items?.[0].label).toBe(state);
    expect(view.items?.[0].state).toBe("最近一篇日记");
  });
});
