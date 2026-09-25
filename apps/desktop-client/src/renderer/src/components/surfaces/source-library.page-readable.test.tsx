// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceLibrarySurface } from "./source-library-surface";
import { useRoomStore } from "../../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 「来源库」这一屏登记给伴星读的是什么（39d W2-7）。
 *
 * 每一条都**同时读 DOM 与 store**：只断言 store 会放过"登记了一份屏幕上没有的东西"，
 * 而这种错按 `usePageReadableView` 的性质根本不会红（推送那句是 `.catch(() => undefined)`，
 * 服务端 strict 整份拒，工具端只报"这一页没有可读内容"）。
 *
 * 这里最要命的一处是**页签与搜索词**：这一屏默认是"全部"，但切到「已归档」或搜一个词之后，
 * 屏上那份清单已经不是库的全部。她要是把筛过的 3 份说成"库里有 3 份"，就是替系统撒了谎。
 */

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

function source(id: string, title: string, status: string, noteCount: number) {
  return {
    id,
    title,
    type: "url",
    status,
    origin: `https://example.com/${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    noteCount,
    cardProgress: { pendingReviewRuns: 0, activeObjectives: 0 },
  };
}

function installApi(listed: { items: ReturnType<typeof source>[]; total: number }) {
  const gateway = {
    contract: { enabledRoutes: ["source.library"] },
    auth: {
      getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "w-1" } })),
    },
    capabilities: {
      get: vi.fn(async () => ok({ actionCapabilities: { "source.create": "allowed" }, featureAvailability: {} })),
    },
    source: {
      list: vi.fn(async (input: { status?: string }) => ok(
        input.status === "archived"
          ? { items: [], total: 0, nextCursor: null }
          : { ...listed, nextCursor: null },
      )),
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return gateway;
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

function rowTitles(): (string | null)[] {
  return [...document.querySelectorAll(".source-sheet strong")].map((node) => node.textContent);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ pageReadableView: null });
});

describe("来源库：她读到的与屏幕上的是同一份", () => {
  it("标题、待处理那一句、页签、逐条清单全部与 DOM 逐字相同", async () => {
    installApi({
      items: [source("s-1", "记忆研究综述", "ready", 2), source("s-2", "间隔重复论文", "processing", 0)],
      total: 2,
    });
    render(<SourceLibrarySurface />);
    await waitFor(() => expect(document.querySelectorAll(".source-sheet").length).toBe(2));
    await waitFor(() => expect(publishedView()).not.toBeNull());

    const view = publishedView()!;
    expect(view.pageId).toBe("sources");
    expect(view.title).toBe(screen.getByRole("heading", { level: 1 }).textContent);
    // 采集栏顶部 `<b>` 那一句：1 份在处理 ⇒ 屏上说的是"待处理"，登记里也得是同一句。
    const head = document.querySelector(".capture-strip p[role='status'] b") ?? screen.getByText(/份待处理|没有待处理/);
    expect(view.statusLine).toBe(head.textContent);
    expect(view.statusLine).toBe("1 份待处理");
    expect(view.metrics).toEqual([
      { label: "待处理明细", value: "1 份正在解析" },
    ]);
    // 「共 2 份来源」这一支此刻**不在屏上**（屏上那行是明细），所以也不许进她的读数。
    expect(view.metrics?.some((metric) => metric.value.includes("份来源"))).toBe(false);

    expect(view.items?.map((entry) => entry.ordinal)).toEqual([1, 2]);
    expect(view.items?.map((entry) => entry.label)).toEqual(rowTitles());
    const firstRowState = document.querySelectorAll(".source-sheet .source-state .tag")[0]?.textContent;
    expect(view.items?.[0]?.state).toBe(firstRowState);
    expect(view.filters?.[0]).toEqual({ label: "页签", value: "全部 2" });
  });

  it("切到「已归档」：页签跟着屏上一起改，清单换成空态那一句", async () => {
    installApi({ items: [source("s-1", "记忆研究综述", "ready", 1)], total: 1 });
    render(<SourceLibrarySurface />);
    await waitFor(() => expect(publishedView()).not.toBeNull());
    expect(publishedView()!.filters?.[0]?.value).toBe("全部 1");

    fireEvent.click(screen.getByRole("button", { name: /^已归档/ }));
    await waitFor(() => expect(publishedView()!.filters?.[0]?.value).toMatch(/^已归档/));
    const view = publishedView()!;
    // 页签文案与按钮上那一句逐字相同（含计数），不是另拼一份。
    expect(view.filters?.[0]?.value).toBe(
      screen.getByRole("button", { name: /^已归档/ }).textContent,
    );
    expect(view.items).toBeUndefined();
    expect(view.notice).toBe(
      `${screen.getByText("这个状态还没有来源").textContent}：${screen.getByText(/^把状态切回/).textContent}`,
    );
  });

  it("库是空的：登记的是空态那一句，不是零条清单", async () => {
    installApi({ items: [], total: 0 });
    render(<SourceLibrarySurface />);
    await waitFor(() => expect(publishedView()).not.toBeNull());
    const view = publishedView()!;
    expect(view.statusLine).toBe("没有待处理的材料");
    expect(view.items).toBeUndefined();
    expect(view.notice).toContain("来源库还是空的");
    expect(view.notice).toBe(
      `${screen.getByText("来源库还是空的").textContent}：${screen.getByText(/^用左边的采集栏/).textContent}`,
    );
  });

  it("第一次读取没回来之前不登记，卸载时槽位让开", async () => {
    // 这一页读**不止一次** `source.list`：默认索引按游标走到底、已归档另一趟。
    // 扣住其中任何一趟，投影就永远回不来——所以"放行"之后每一趟都立刻给同一份数据。
    const pending: ((value: unknown) => void)[] = [];
    let released = false;
    const listed = ok({ items: [source("s-1", "记忆研究综述", "ready", 0)], total: 1, nextCursor: null });
    window.ailearn = {
      contract: { enabledRoutes: ["source.library"] },
      auth: {
        getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "w-1" } })),
      },
      capabilities: {
        get: vi.fn(async () => ok({ actionCapabilities: { "source.create": "allowed" }, featureAvailability: {} })),
      },
      source: {
        list: vi.fn(() => {
          if (released) return Promise.resolve(listed);
          return new Promise((resolve) => {
            pending.push(resolve);
          });
        }),
      },
    } as unknown as typeof window.ailearn;
    const { unmount } = render(<SourceLibrarySurface />);
    await waitFor(() => expect(screen.getByText("正在读取来源库")).not.toBeNull());
    expect(publishedView()).toBeNull();
    released = true;
    for (const resolve of pending) resolve(listed);
    await waitFor(() => expect(publishedView()).not.toBeNull());
    unmount();
    expect(publishedView()).toBeNull();
  });
});
