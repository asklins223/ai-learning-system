// @vitest-environment jsdom

/**
 * F47 的跨层判据：**服务端那一页有几条，界面就必须列出几条**。
 *
 * 这条链路此前没有任何用例覆盖，所以它能"全绿而功能完全不可用"——审计当场量到的
 * 是界面「0 / 0 条 · 没有找到」，而同一时刻服务端对同参请求返回 `total=5`。
 * 复现的条件是真实的：StrictMode（main.tsx 就这么挂的，effect 会跑两遍）、
 * 异步 40ms 才回来的页、连打三个键，以及"同一次输入只发一条请求"。
 *
 * 断言分三层，缺一层就有一条静默失效的路：
 *  1. 只发一条请求——同参发两条正是审计日志里的读数，响应归属错了就会互相覆盖；
 *  2. 行数等于页里的条数（不是"大于 0"，那样空页与半页都能绿）；
 *  3. 进度读数 `N / N 条` 与 `total` 同源。
 */
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GatewayResultV1, SessionContextV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../app/room-store";
import { SearchSurface } from "./search-surface";

const TITLES = ["阿里云百炼", "IndexTTS 语音合成", "TTS 笔记", "TTS 对比", "理解 TTS"];

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
  };
}

function ok<T>(data: T): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "search-test",
    correlationId: "search-test",
    schemaRevision: "desktop-ipc-v1",
  };
}

/** 与服务端 `apps/api/src/modules/search/service.ts` 返回的行同形。 */
function serverPage() {
  const items = TITLES.map((title, index) => ({
    objectType: index < 2 ? "source" : index < 4 ? "note" : "objective",
    objectId: `33333333-3333-4333-8333-33333333333${index}`,
    title,
    snippet: `…${title}…`,
    indexedAt: "2026-09-22T07:22:05.460Z",
    href: `/x/${index}`,
    matchCount: 1,
  }));
  return { items, total: items.length, nextCursor: null };
}

function installApi() {
  const calls: string[] = [];
  const api = {
    auth: { getState: vi.fn(async () => ok(session())) },
    search: {
      global: vi.fn(async (input: { query: string }) => {
        calls.push(input.query);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return ok(serverPage());
      }),
    },
    note: {
      get: vi.fn(async () => ok({
        noteId: "33333333-3333-4333-8333-333333333333",
        title: TITLES[2],
        sourceId: null,
        currentVersionId: "44444444-4444-4444-8444-444444444444",
        currentVersion: { versionNo: 1, updatedAt: "2026-09-22T07:22:05.460Z", contentHash: "h", blocks: [{ ordinal: 1, type: "paragraph", content: "TTS 笔记正文" }] },
      })),
    },
    source: { get: vi.fn() },
    objective: { get: vi.fn(), list: vi.fn(async () => ok({ items: [], total: 0, nextCursor: null })) },
  };
  Object.defineProperty(window, "ailearn", { configurable: true, value: api });
  return { api, calls };
}

beforeEach(() => {
  useRoomStore.setState({ searchQuery: "", searchTypeFilter: "all", searchWeakOnly: false });
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  Reflect.deleteProperty(Element.prototype, "scrollTo");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  useRoomStore.setState({ searchQuery: "", searchTypeFilter: "all", searchWeakOnly: false, hudPage: "home" });
  vi.restoreAllMocks();
});

describe("全局搜索 · 界面必须与服务端同一页同量", () => {
  it("输入 TTS：只发一条请求，五行全部列出，进度读数与 total 同源", async () => {
    const { calls } = installApi();
    render(<StrictMode><SearchSurface /></StrictMode>);

    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "T" } });
    fireEvent.change(box, { target: { value: "TT" } });
    fireEvent.change(box, { target: { value: "TTS" } });

    const list = await screen.findByRole("listbox", { name: "搜索结果" });
    const rows = await waitFor(() => {
      const found = list.querySelectorAll("[role='option']");
      expect(found.length).toBe(TITLES.length);
      return found;
    });
    // 每一行都在，而不是"有几行算几行"。
    for (const title of TITLES) expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    // 进度读数与那 5 条同源（`items.length / total`）。同一句还出现在 aria-live
    // 状态行里，所以这里量的是列表里那一处可见读数。
    expect(rows.length).toBe(serverPage().total);
    expect(within(list).getByText("5 / 5 条")).toBeTruthy();
    // 三个键只发一条：同参发两条会让响应归属参与竞争（审计日志里的读数）。
    expect(calls).toEqual(["TTS"]);
  });
});
