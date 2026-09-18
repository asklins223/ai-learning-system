// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteLibrarySurface } from "./note-library-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 笔记库在多数据与边界情况下的合同：
 * - "全部"用服务端总数，其余筛选在没读完时把数字标成下限；
 * - 笔记全被删除时，回收站仍然可达（否则恢复路径死锁）；
 * - 回收站视图里搜索与时间筛选不再假装可用，也不会在后台空跑整库；
 * - 回收站翻页不再把整份列表换成 loading 卡；
 * - 重命名不会把读者从已翻到的页数上打回第一页。
 *
 * 注意：书架/索引的选择按会话保存在模块作用域里（这是产品行为），所以需要书架的
 * 用例必须排在最前面，其余用例从索引视图继续。
 */

const NOTE = (id: string, title: string) => ({
  id,
  title,
  titleSource: "manual",
  currentVersionId: `${id}-v1`,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

function stubGateway(options: {
  readonly live?: readonly ReturnType<typeof NOTE>[];
  readonly liveTotal?: number;
  readonly liveNextCursor?: string | null;
  readonly trashed?: readonly ReturnType<typeof NOTE>[];
  readonly trashedTotal?: number;
  readonly trashedNextCursor?: string | null;
}) {
  const state = {
    liveCalls: 0,
    trashedCalls: 0,
    saveCalls: 0,
    cursorsSeen: [] as (string | undefined)[],
  };
  const gateway = {
    contract: { enabledRoutes: ["note.library", "note.detail"] },
    auth: {
      getState: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { status: "authenticated" as const, workspace: { workspaceId: "w-1" } },
      })),
    },
    capabilities: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          actionCapabilities: { "note.create": "allowed", "note.delete": "allowed", "note.restore": "allowed", "note.save": "allowed" },
          featureAvailability: {},
        },
      })),
    },
    note: {
      list: vi.fn(async (input: { trashed?: boolean; cursor?: string; limit?: number }) => {
        state.cursorsSeen.push(input.cursor);
        if (input.trashed) {
          state.trashedCalls += 1;
          // The page's own count read asks for a single row.
          if (input.limit === 1 && !input.cursor) {
            return { ok: true as const, workspaceEpoch: 1, data: { items: (options.trashed ?? []).slice(0, 1), nextCursor: null, total: options.trashedTotal ?? 0 } };
          }
          return {
            ok: true as const,
            workspaceEpoch: 1,
            data: {
              items: options.trashed ?? [],
              nextCursor: options.trashedNextCursor ?? null,
              total: options.trashedTotal ?? (options.trashed ?? []).length,
            },
          };
        }
        state.liveCalls += 1;
        return {
          ok: true as const,
          workspaceEpoch: 1,
          data: {
            items: options.live ?? [],
            nextCursor: options.liveNextCursor ?? null,
            total: options.liveTotal ?? (options.live ?? []).length,
          },
        };
      }),
      get: vi.fn(async (input: { noteId: string }) => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          noteId: input.noteId,
          title: "笔记",
          sourceId: null,
          currentVersionId: `${input.noteId}-v1`,
          permissions: { canEdit: true, canSave: true },
          currentVersion: { versionId: `${input.noteId}-v1`, versionNo: 1, updatedAt: new Date().toISOString(), contentHash: "h", blocks: [{ ordinal: 1, type: "paragraph", content: "正文" }] },
        },
      })),
      save: vi.fn(async () => {
        state.saveCalls += 1;
        return { ok: true as const, workspaceEpoch: 1, data: { noteId: "n1", savedAt: new Date().toISOString(), isAutosave: false } };
      }),
      delete: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { noteId: "n1", status: "deleted" } })),
      restore: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { noteId: "n1", status: "restored" } })),
    },
    source: { get: vi.fn(async () => ({ ok: false as const, workspaceEpoch: 1, error: { code: "not_found", message: "no source" } })) },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return { gateway, state };
}

/** The index is one level below the shelf; a later test starts wherever the last left off. */
async function openIndex() {
  const shelfAll = screen.queryByRole("button", { name: /全部笔记/ });
  if (shelfAll) fireEvent.click(shelfAll);
  await waitFor(() => expect(screen.getByRole("search")).toBeTruthy());
}

async function openTrash() {
  await openIndex();
  fireEvent.click(screen.getByRole("button", { name: "回收站" }));
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ activeNoteRef: null, recentNoteId: null, surface: null, returnTarget: null });
});

describe("NoteLibrarySurface · 边界与多数据", () => {
  it("书架用服务端总数，筛选计数在没读完时标成下限", async () => {
    const { state } = stubGateway({
      live: [NOTE("n1", "笔记一")],
      liveTotal: 137,
      liveNextCursor: "cursor-2",
    });
    render(<NoteLibrarySurface />);

    // 书架：主卡是最近打开/最近更新的那篇，"全部笔记"用的是服务端总数。
    await waitFor(() => expect(screen.getByRole("button", { name: /全部笔记 · 137/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /全部笔记 · 137/ }));

    // 索引：全部 = 137；"今天"只统计已读部分，因此带 "+"。
    await waitFor(() => expect(screen.getByRole("button", { name: /全部 137/ })).toBeTruthy());
    expect(screen.getByRole("button", { name: /今天 1\+/ })).toBeTruthy();

    // 切到时间筛选会自动读完剩余页，而不是只筛已加载的那一页。
    fireEvent.click(screen.getByRole("button", { name: /近 7 天/ }));
    await waitFor(() => expect(state.cursorsSeen.filter(Boolean).length).toBeGreaterThan(0));
  });

  it("笔记全在回收站时，空态仍然给出去回收站的路", async () => {
    stubGateway({ live: [], trashed: [NOTE("t1", "被删的笔记")], trashedTotal: 3 });
    render(<NoteLibrarySurface />);

    await waitFor(() => expect(screen.getByText("笔记都在回收站里")).toBeTruthy());
    expect(screen.getByText(/回收站里有 3 篇/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "打开回收站" }));
    await waitFor(() => expect(screen.getByText("被删的笔记")).toBeTruthy());
    expect(screen.getByRole("button", { name: "返回笔记" })).toBeTruthy();
  });

  it("回收站视图里不渲染搜索与时间筛选，也不在后台空跑整库", async () => {
    const { state } = stubGateway({
      live: [NOTE("n1", "笔记一")],
      liveTotal: 137,
      liveNextCursor: "cursor-2",
      trashed: [NOTE("t1", "被删的笔记")],
      trashedTotal: 1,
    });
    render(<NoteLibrarySurface />);

    await waitFor(() => expect(screen.getByText("笔记一")).toBeTruthy());
    await openTrash();
    await waitFor(() => expect(screen.getByText("被删的笔记")).toBeTruthy());

    expect(screen.queryByRole("search")).toBeNull();
    expect(screen.queryByRole("group", { name: "按更新时间筛选" })).toBeNull();
    // 回收站打开后不会再读活笔记列表：没有任何筛选能在后台把 137 篇走完。
    const callsWhileInTrash = state.liveCalls;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(state.liveCalls).toBe(callsWhileInTrash);
  });

  it("回收站翻页保留已读列表，只在按钮上表示进行中", async () => {
    const { state } = stubGateway({
      live: [NOTE("n1", "笔记一")],
      trashed: [NOTE("t1", "被删的笔记")],
      trashedTotal: 2,
      trashedNextCursor: "trash-cursor-2",
    });
    render(<NoteLibrarySurface />);

    await waitFor(() => expect(screen.getByText("笔记一")).toBeTruthy());
    await openTrash();
    await waitFor(() => expect(screen.getByText("被删的笔记")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /加载更多/ }));
    await waitFor(() => expect(state.trashedCalls).toBeGreaterThan(1));
    // 列表与按钮都还在，没有被整块 loading 卡替换。
    expect(screen.getByText("被删的笔记")).toBeTruthy();
    expect(screen.getByRole("button", { name: /加载更多/ })).toBeTruthy();
  });

  it("重命名不会把读者打回第一页", async () => {
    const { state } = stubGateway({
      live: [NOTE("n1", "笔记一")],
      liveTotal: 2,
      liveNextCursor: "cursor-2",
    });
    render(<NoteLibrarySurface />);

    await waitFor(() => expect(screen.getByText("笔记一")).toBeTruthy());
    await openIndex();
    await waitFor(() => expect(screen.getByText("加载更多（已读 1 / 2）")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    const input = await waitFor(() => screen.getByLabelText("新的笔记标题"));
    fireEvent.change(input, { target: { value: "新标题" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(state.saveCalls).toBe(1));
    // 分页游标还在：重命名之后仍然是"已读 1 / 2"，而不是被重置成整库第一页。
    await waitFor(() => expect(screen.getByText("加载更多（已读 1 / 2）")).toBeTruthy());
  });
});
