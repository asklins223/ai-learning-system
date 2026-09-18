// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GatewayResultV1, SessionContextV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { DesktopSearchItem } from "@ailearn/shared/desktop-surface-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../app/room-store";
import { SearchSurface } from "./search-surface";

/**
 * The search desk's regressions were all about what the reader is shown versus
 * what the server said: a preview that never reached the match, a filter that
 * silently stopped filtering, and a cursor that restarted the search. These
 * tests pin the client half of the keyset contract — the cursor is opaque and is
 * handed back verbatim.
 */

const NOTE_ID = "44444444-4444-4444-8444-444444444444";
const WEAK_OBJECTIVE_ID = "55555555-5555-4555-8555-555555555555";
const STRONG_OBJECTIVE_ID = "66666666-6666-4666-8666-666666666666";

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

function noteItem(): DesktopSearchItem {
  return {
    objectType: "note",
    objectId: NOTE_ID,
    title: "一份很长的笔记",
    snippet: "…索引片段里的 Needle…",
    indexedAt: "2026-09-01T00:00:00.000Z",
    href: `/notes/${NOTE_ID}`,
    matchCount: 1,
  };
}

function objectiveItem(objectiveId: string, title: string): DesktopSearchItem {
  return {
    objectType: "objective",
    objectId: objectiveId,
    title,
    snippet: "…",
    indexedAt: "2026-09-01T00:00:00.000Z",
    href: `/learning-objectives/${objectiveId}`,
    matchCount: 1,
  };
}

/** Forty paragraphs with the match near the end, so a first-N window misses it. */
function longNote() {
  return {
    noteId: NOTE_ID,
    title: "一份很长的笔记",
    sourceId: null,
    currentVersionId: "77777777-7777-4777-8777-777777777777",
    currentVersion: {
      versionId: "77777777-7777-4777-8777-777777777777",
      blocks: Array.from({ length: 40 }, (_, index) => ({
        id: `block-${index}`,
        type: "paragraph",
        content: index === 35 ? "第三十六段才提到 Needle 这个关键词。" : `第 ${index + 1} 段普通正文。`,
      })),
    },
  };
}

function installApi(options: {
  readonly search?: (input: { query: string; cursor?: string }) => Promise<GatewayResultV1<unknown>>;
  readonly objectiveList?: () => Promise<GatewayResultV1<unknown>>;
} = {}) {
  const searchCalls: { query: string; cursor?: string }[] = [];
  const api = {
    auth: { getState: vi.fn(async () => ok(session())) },
    search: {
      global: vi.fn(async (input: { query: string; cursor?: string }) => {
        searchCalls.push({ query: input.query, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
        if (options.search) return options.search(input);
        return ok({ items: [noteItem()], total: 1, nextCursor: null });
      }),
    },
    note: { get: vi.fn(async () => ok(longNote())) },
    source: { get: vi.fn() },
    objective: {
      get: vi.fn(),
      list: vi.fn(async () => options.objectiveList
        ? options.objectiveList()
        : ok({
            items: [
              { objectiveId: WEAK_OBJECTIVE_ID, personalState: { state: "fragile" } },
              { objectiveId: STRONG_OBJECTIVE_ID, personalState: { state: "validated" } },
            ],
            total: 2,
            nextCursor: null,
          })),
    },
  };
  Object.defineProperty(window, "ailearn", { configurable: true, value: api });
  return { api, searchCalls };
}

beforeEach(() => {
  useRoomStore.setState({ searchQuery: "", searchTypeFilter: "all", searchWeakOnly: false });
  // jsdom has no scrolling implementation; the desk scrolls its own index pane.
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  Reflect.deleteProperty(Element.prototype, "scrollTo");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  // The room store is a module singleton shared by every test file in a worker.
  useRoomStore.setState({ searchQuery: "", searchTypeFilter: "all", searchWeakOnly: false, hudPage: "home" });
  vi.restoreAllMocks();
});

describe("the preview reaches the match", () => {
  it("windows the body around the hit instead of printing the first paragraphs", async () => {
    installApi();
    useRoomStore.setState({ searchQuery: "Needle" });
    render(<SearchSurface />);

    // The match lives in block 36 of 40; a first-six window would show none of it.
    const paragraph = await screen.findByText(/第三十六段才提到/, {}, { timeout: 3000 });
    expect(paragraph.querySelector(".mark")?.textContent).toBe("Needle");
    // …and the index snippet is not repeated when the body already carries it.
    expect(screen.queryByText(/索引片段里的/)).toBeNull();
  });
});

describe("the weak-only filter", () => {
  it("keeps only objectives the server marked as weak", async () => {
    installApi({
      search: async () => ok({
        items: [objectiveItem(WEAK_OBJECTIVE_ID, "脆弱的目标"), objectiveItem(STRONG_OBJECTIVE_ID, "已巩固的目标")],
        total: 2,
        nextCursor: null,
      }),
    });
    useRoomStore.setState({ searchQuery: "目标", searchWeakOnly: true });
    render(<SearchSurface />);

    await screen.findByText("脆弱的目标");
    expect(screen.queryByText("已巩固的目标")).toBeNull();
  });

  it("shows an error instead of unfiltered rows when the objective read fails", async () => {
    installApi({
      objectiveList: async () => { throw new Error("objective service down"); },
      search: async () => ok({
        items: [objectiveItem(WEAK_OBJECTIVE_ID, "脆弱的目标"), objectiveItem(STRONG_OBJECTIVE_ID, "已巩固的目标")],
        total: 2,
        nextCursor: null,
      }),
    });
    useRoomStore.setState({ searchQuery: "目标", searchWeakOnly: true });
    render(<SearchSurface />);

    // A pressed filter that silently stops filtering is worse than an error.
    await screen.findByText("无法核对目标状态");
    expect(screen.queryByText("已巩固的目标")).toBeNull();
  });
});

describe("keyset paging", () => {
  it("hands the opaque cursor back verbatim and never restarts the search", async () => {
    const { searchCalls } = installApi({
      search: async (input) => (input.cursor === undefined
        ? ok({ items: [noteItem()], total: 2, nextCursor: "CURSOR-ONE" })
        : ok({ items: [objectiveItem(WEAK_OBJECTIVE_ID, "第二页")], total: 2, nextCursor: null })),
    });
    useRoomStore.setState({ searchQuery: "Needle" });
    render(<SearchSurface />);

    fireEvent.click(await screen.findByRole("button", { name: "继续读取" }, { timeout: 3000 }));

    await waitFor(() => expect(searchCalls).toHaveLength(2));
    expect(searchCalls[1]).toEqual({ query: "Needle", cursor: "CURSOR-ONE" });
    await screen.findByText("已到末尾");
  });

  it("states the depth before the reader starts paging", async () => {
    installApi({
      search: async () => ok({ items: [noteItem()], total: 100, nextCursor: "CURSOR-ONE" }),
    });
    useRoomStore.setState({ searchQuery: "Needle" });
    render(<SearchSurface />);

    const depth = await screen.findByText(/共 100 条，约 5 页/, {}, { timeout: 3000 });
    expect(depth.textContent).toContain("按更新时间从新到旧顺序读取");
  });

  it("keeps the loaded list and retries the same page when a later page fails", async () => {
    let call = 0;
    const { searchCalls } = installApi({
      search: async () => {
        call += 1;
        if (call === 1) return ok({ items: [noteItem()], total: 5, nextCursor: "CURSOR-ONE" });
        if (call === 2) throw new Error("page read failed");
        return ok({ items: [objectiveItem(WEAK_OBJECTIVE_ID, "第二页")], total: 5, nextCursor: null });
      },
    });
    useRoomStore.setState({ searchQuery: "Needle" });
    render(<SearchSurface />);

    fireEvent.click(await screen.findByRole("button", { name: "继续读取" }, { timeout: 3000 }));

    // The rows already on the paper stay, and the error sits inline with them.
    const alert = await screen.findByRole("alert");
    expect(within(screen.getByRole("listbox")).getByText("一份很长的笔记")).toBeTruthy();

    fireEvent.click(within(alert).getByRole("button", { name: "重试这一页" }));
    await waitFor(() => expect(searchCalls).toHaveLength(3));
    // The retry repeats the failed page, it does not restart from the top.
    expect(searchCalls[2]).toEqual({ query: "Needle", cursor: "CURSOR-ONE" });
  });
});

describe("state that has to survive leaving the page", () => {
  it("reopens with the same query, filter and weak-only toggle", async () => {
    installApi({
      search: async () => ok({
        items: [objectiveItem(WEAK_OBJECTIVE_ID, "脆弱的目标"), objectiveItem(STRONG_OBJECTIVE_ID, "已巩固的目标")],
        total: 2,
        nextCursor: null,
      }),
    });
    useRoomStore.setState({ searchQuery: "Needle", searchTypeFilter: "objective", searchWeakOnly: true });
    const first = render(<SearchSurface />);
    await screen.findByText("脆弱的目标", {}, { timeout: 3000 });

    // TaskSurface remounts the subtree on every navigation (`key={renderedSurface}`).
    first.unmount();
    render(<SearchSurface />);

    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("Needle");
    expect(await screen.findByRole("button", { name: /结果类型：只看目标/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /证据不足/ }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("the result list", () => {
  it("links the input to the listbox it drives", async () => {
    installApi();
    useRoomStore.setState({ searchQuery: "Needle" });
    render(<SearchSurface />);

    const listbox = await screen.findByRole("listbox", {}, { timeout: 3000 });
    expect(screen.getByRole("searchbox").getAttribute("aria-controls")).toBe(listbox.id);
  });
});
