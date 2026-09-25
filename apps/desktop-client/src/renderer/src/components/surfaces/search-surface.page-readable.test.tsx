// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SessionContextV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { GatewayResultV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { DesktopSearchItem } from "@ailearn/shared/desktop-surface-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchSurface } from "./search-surface";
import { useRoomStore } from "../../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 「全局查找」这一屏登记给伴星读的是什么（39d W2-7）。
 *
 * 这一页最容易被她说漏的不是结果数，而是**这一屏是被筛过的**：类型筛选、
 * "证据不足"那颗标签、以及"只读到第几页"这三件事任何一个没登记，她都会把
 * "屏幕上这 3 条"讲成"你一共只有 3 条"。所以 `filters` 与读取深度那一行
 * 是这一组用例的重点，而不是附带。
 *
 * 每条都同时读 DOM 与 store：视图字段写错**不会红**。
 */

const NOTE_ID = "55555555-5555-4555-8555-555555555555";

function session(): SessionContextV1 {
  return {
    version: 1,
    status: "authenticated",
    user: { userId: "11111111-1111-4111-8111-111111111111", email: "reader@example.com" },
    workspace: {
      version: 1,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      name: "理解空间",
      role: "owner",
      workspaceType: "personal",
      isPersonal: true,
      workspaceEpoch: 7,
    },
    membership: { role: "owner" },
    capabilities: null,
    workspaceEpoch: 7,
    credentialPersistence: "memory",
  } as unknown as SessionContextV1;
}

function ok<T>(data: T): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "search-readable-test",
    correlationId: "search-readable-test",
    schemaRevision: "desktop-ipc-v1",
  } as unknown as GatewayResultV1<T>;
}

function item(objectType: DesktopSearchItem["objectType"], title: string): DesktopSearchItem {
  return {
    objectType,
    objectId: NOTE_ID,
    title,
    snippet: "…命中的一句…",
    indexedAt: "2026-09-01T00:00:00.000Z",
    href: `/notes/${NOTE_ID}`,
    matchCount: 2,
  };
}

function installApi(options: {
  items?: DesktopSearchItem[];
  total?: number;
  nextCursor?: string | null;
} = {}) {
  const api = {
    auth: { getState: vi.fn(async () => ok(session())) },
    search: {
      global: vi.fn(async () => ok({
        items: options.items ?? [item("note", "间隔重复那一章"), item("source", "记忆研究综述")],
        total: options.total ?? 5,
        nextCursor: options.nextCursor ?? null,
      })),
    },
    note: {
      get: vi.fn(async () => ok({
        noteId: NOTE_ID,
        title: "间隔重复那一章",
        sourceId: null,
        currentVersionId: "66666666-6666-4666-8666-666666666666",
        currentVersion: {
          versionId: "66666666-6666-4666-8666-666666666666",
          blocks: [{ id: "block-0", type: "paragraph", content: "先给一个定义，再给一个例子。" }],
        },
      })),
    },
    source: { get: vi.fn(async () => ok({ source: { id: NOTE_ID, title: "记忆研究综述", status: "ready" }, segments: [] })) },
    objective: {
      get: vi.fn(),
      list: vi.fn(async () => ok({ items: [], total: 0, nextCursor: null })),
    },
  };
  Object.defineProperty(window, "ailearn", { configurable: true, value: api });
  return api;
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

function filterValue(label: string): string | undefined {
  return publishedView()?.filters?.find((entry) => entry.label === label)?.value;
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  Reflect.deleteProperty(Element.prototype, "scrollTo");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  useRoomStore.setState({
    searchQuery: "",
    searchTypeFilter: "all",
    searchWeakOnly: false,
    hudPage: "home",
    pageReadableView: null,
  });
  vi.restoreAllMocks();
});

async function renderWithQuery(query: string, expectItems = 2) {
  useRoomStore.setState({ searchQuery: query });
  render(<SearchSurface />);
  // 会话确认与搜索返回之间有一帧"还没有命中"，那是页面自己的瞬时状态（下一帧就被
  // 覆盖）。等到**这一屏稳定成要看的那一态**再取视图，否则断言读到的是中间帧。
  await waitFor(() => expect(publishedView()).not.toBeNull());
  await waitFor(() => expect(publishedView()?.items?.length ?? 0).toBe(expectItems));
}

describe("全局查找：她读到的与屏幕上的是同一份", () => {
  it("计数、读取深度、类型、关键词、逐条结果全部与 DOM 逐字相同", async () => {
    installApi();
    await renderWithQuery("间隔");
    // 这一屏有两句话会换位置：索引那格的「已到读取上限」与预览那格的「等待一次选择」。
    // 预览要真读一次才会把登记换过来，并发跑文件时来得及错开——所以**先等目标态再取快照**
    // （等的是"到了那一句"，不是"发过东西"；真出现"屏上换了、那一格没换"这条会超时红）。
    await waitFor(() => expect(publishedView()?.notice).toMatch(/已到读取上限/));

    const view = publishedView()!;
    expect(view.pageId).toBe("search");
    expect(view.title).toBe(screen.getByRole("heading", { level: 1 }).textContent);
    // 页签那一格的计数（同时也是无障碍播报的那一句）。
    expect(view.statusLine).toBe(document.querySelector(".index-progress span")?.textContent);
    expect(view.metrics).toEqual([
      { label: "结果", value: document.querySelector(".index-progress span")?.textContent ?? "" },
      { label: "读取深度", value: document.querySelector(".index-depth")?.textContent ?? "" },
    ]);
    expect(filterValue("类型")).toBe(document.querySelector(".hud-picker__value")?.textContent);
    expect(filterValue("关键词")).toBe(screen.getByRole("searchbox").getAttribute("value") ?? (screen.getByRole("searchbox") as HTMLInputElement).value);
    expect(view.items?.map((entry) => entry.ordinal)).toEqual([1, 2]);
    expect(view.items?.map((entry) => entry.label)).toEqual(
      [...document.querySelectorAll(".index-card b")].map((node) => node.textContent),
    );
    expect(view.items?.map((entry) => entry.state)).toEqual(
      [...document.querySelectorAll(".index-card .kind")].map((node) => node.textContent),
    );
    // 第一条结果是自动选中的，所以这一屏最后那句话是"读到哪儿了"（页签下面那一格）。
    // 第一条结果是自动选中的，所以这一屏最后那句话是"读到哪儿了"（页签下面那一格）。
    expect(view.notice).toBe(screen.getByText(/已到读取上限/).textContent);
  });

  it("开着「证据不足」时，那颗标签的文案（含 + 号）逐字进 filters", async () => {
    installApi();
    await renderWithQuery("间隔", 2);
    const chip = screen.getByRole("button", { name: /^证据不足/ });
    fireEvent.click(chip);
    // 标签上那个数要等目标状态读回来才有，视图与屏上必须一起到位才算同源。
    await waitFor(() => expect(filterValue("证据不足筛选")).toBe(
      screen.getByRole("button", { name: /^证据不足/ }).textContent,
    ));
  });

  it("没有输入关键词：登记的是空态那一句，不带任何结果", async () => {
    installApi();
    useRoomStore.setState({ searchQuery: "" });
    render(<SearchSurface />);
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.items).toBeUndefined();
    expect(view.notice).toBe(
      `${screen.getByText("输入关键词开始查找").textContent}：${screen.getByText(/^来源、笔记与学习卡共用/).textContent}`,
    );
    expect(filterValue("关键词")).toBeUndefined();
  });

  it("一条都没搜到：说的是屏上那句「没有找到」，含关键词本身", async () => {
    installApi({ items: [], total: 0 });
    await renderWithQuery("不存在的词", 0);
    const view = publishedView()!;
    expect(view.items).toBeUndefined();
    expect(view.notice).toBe(screen.getByText(/没有找到/).textContent + "：" + "可以换一个关键词，或把类型切回全部。");
    expect(view.statusLine).toBe(screen.getByText(/没有找到/).textContent);
  });

  it("工作区还没确认之前不登记（她不能读到上一次查找的残留）", async () => {
    let releaseSession: (value: unknown) => void = () => undefined;
    Object.defineProperty(window, "ailearn", {
      configurable: true,
      value: {
        auth: { getState: vi.fn(() => new Promise((resolve) => { releaseSession = resolve; })) },
        search: { global: vi.fn(async () => ok({ items: [], total: 0, nextCursor: null })) },
        note: { get: vi.fn() },
        source: { get: vi.fn() },
        objective: { get: vi.fn(), list: vi.fn() },
      },
    });
    useRoomStore.setState({ searchQuery: "间隔" });
    const { unmount } = render(<SearchSurface />);
    await waitFor(() => expect(screen.getByText("正在确认工作区")).not.toBeNull());
    expect(publishedView()).toBeNull();
    releaseSession(ok(session()));
    await waitFor(() => expect(publishedView()).not.toBeNull());
    unmount();
    expect(publishedView()).toBeNull();
  });
});
