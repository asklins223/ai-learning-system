// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryPanel } from "./companion-center-panels";
import type { CompanionMemoryItemV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import { useRoomStore } from "../../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 伴星中心「记忆」这一块登记给伴星读的是什么（39d W2-7）。
 *
 * 这一块是 W2-7 里唯一**不在挂着 `useHudPage` 的那个组件里**登记的屏：清单
 * （候选优先、时间倒序，再按类型/固定/关键词筛）是 `MemoryPanel` 自己算的，
 * 壳层只拿着未筛的那一批。所以登记只能落在面板——落在壳层就得把那段筛选再抄一遍，
 * 那是"同一个数两个来源"（守卫 `page-readable-registration.test.ts` 的
 * `PUBLISHED_BY_PANEL` 认的就是这条路，而且要同时核对"面板真发＋壳层真引"）。
 */

const okSection = <T,>(value: T) => ({ ok: true as const, value });

/** 夹具形状照**服务端合同**（`companionMemoryItemV1Schema`），不是照组件用到哪几个字段。 */
function memory(id: string, content: string, overrides: Partial<CompanionMemoryItemV1> = {}): CompanionMemoryItemV1 {
  return {
    memoryItemId: id,
    kind: "preference",
    content,
    sourceEventId: null,
    sourceSessionId: null,
    userStated: false,
    userConfirmed: true,
    candidate: false,
    importance: 0.6,
    confidence: 0.9,
    scope: "workspace",
    pinned: false,
    archived: false,
    dismissedAt: null,
    conflictGroup: null,
    embeddingStatus: "ready",
    sourceType: "confirmed",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

const noop = () => undefined;

type MemoryPanelProps = Parameters<typeof MemoryPanel>[0];

function renderPanel(props: Partial<MemoryPanelProps> = {}) {
  const items = [
    memory("m-1", "喜欢先给结论再讲理由"),
    memory("m-2", "这周在啃音色的跨语言迁移", { kind: "episodic", candidate: true, updatedAt: "2026-09-24T00:00:00.000Z" }),
  ];
  const base = {
    section: { ok: true as const, value: { version: 2 as const, items } },
    items,
    focus: null,
    query: "",
    kind: "all",
    pinFilter: "all",
    busy: null,
    error: null,
    notice: null,
    confirmDelete: false,
    createOpen: false,
    createContent: "",
    createKind: "preference",
    correctionOpen: false,
    correctionContent: "",
    onQuery: noop,
    onKind: noop,
    onPinFilter: noop,
    onFocus: noop,
    onAction: noop,
    onConfirmDelete: noop,
    onCreateOpen: noop,
    onCreateContent: noop,
    onCreateKind: noop,
    onCreate: noop,
    onSummarize: noop,
    onCorrectionOpen: noop,
    onCorrectionContent: noop,
    onCorrect: noop,
    onRetry: noop,
  } satisfies MemoryPanelProps;
  render(<MemoryPanel {...base} {...props} />);
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

function filterValue(label: string): string | undefined {
  return publishedView()?.filters?.find((entry) => entry.label === label)?.value;
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
});

describe("伴星中心 · 记忆：登记的清单就是屏上露出的那份", () => {
  it("条目的顺序、正文与「类型· 状态」都与 DOM 逐字相同（候选排在最前）", async () => {
    renderPanel();
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.pageId).toBe("companion");
    expect(view.title).toBe("伴星中心");

    const rows = [...document.querySelectorAll(".companion-record-list > button")];
    expect(rows).toHaveLength(2);
    // 候选那条排在最前——这条顺序正是"面板自己筛的"这件事的证据。
    expect(rows[0].querySelector("strong")?.textContent).toBe("这周在啃音色的跨语言迁移");
    expect(view.items?.map((entry) => entry.label)).toEqual(
      rows.map((row) => row.querySelector("strong")?.textContent),
    );
    expect(view.items?.map((entry) => entry.ordinal)).toEqual([1, 2]);
    // `<span>` 上屏的是「类型· 状态 · 相对时间」（第一段与第二段之间只有一个空格）；
    // **最后那段相对时间随钟漂移，不进载荷**（合同：多久之前一律服务端从 issuedAt 算）。
    expect(rows[0].querySelector("span")?.textContent).toContain(" · ");
    expect(view.items?.[0].state).toBe(rows[0].querySelector("span")?.textContent?.split(" · ")[0]);
    expect(view.items?.[0].state).not.toMatch(/前|刚刚|今天/);
    expect(view.statusLine).toBeUndefined();
  });

  it("筛到什么都不剩时，说的是屏上那句空态而不是省略", async () => {
    renderPanel({ query: "对不上的词" });
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.items).toBeUndefined();
    expect(filterValue("关键词")).toBe("对不上的词");
    expect(view.notice).toBe(
      `${document.querySelector(".companion-section-state strong")?.textContent}：${document.querySelector(".companion-section-state span")?.textContent}`,
    );
  });

  it("列表读不到时：登记的是那一格的原话，条目清空", async () => {
    renderPanel({ section: { ok: false, message: "伴星数据暂时不可用" } });
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.statusLine).toBe(document.querySelector(".companion-section-state strong")?.textContent);
    expect(view.items).toBeUndefined();
    expect(view.notice).toBe(`${view.statusLine}：伴星数据暂时不可用`);
  });

  it("筛选下拉当前选中的那几个词进 filters（屏上就是那几个词）", async () => {
    renderPanel({ kind: "preference", pinFilter: "candidate" });
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const triggers = [...document.querySelectorAll(".companion-select > button span")].map((node) => node.textContent);
    expect(triggers.length).toBeGreaterThan(1);
    expect(filterValue("类型")).toBe(triggers[0]);
    expect(filterValue("状态")).toBe(triggers[1]);
  });
});
