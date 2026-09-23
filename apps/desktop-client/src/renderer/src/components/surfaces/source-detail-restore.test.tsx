// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceDetailSurface } from "./source-detail-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 「恢复来源」这颗按钮（审计 F08）。
 *
 * 病是这么来的：归档那条路的提示语写着"可在已归档页签找到"，而**没有回去的路**——
 * 数据一直在（只是 `status=archived`），界面上唯一的后果却是"再也不能从它开始笔记"。
 * 「归档」在别处都是可撤销的日常词，这里却是一次单向操作。
 *
 * 这里钉四件事：只有已归档的来源才摆这颗按钮；按下去真的打到那条通道；
 * **回执照实说恢复成了哪一档**（有片段 → ready，没有 → draft）；成员只读时没有入口。
 */

const SOURCE_ID = "00000000-0000-4000-8000-0000000000bb";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 7, data });

function sourceWith(status: string) {
  return {
    id: SOURCE_ID,
    workspaceId: WORKSPACE_ID,
    type: "text",
    title: "惯性那一章",
    origin: null,
    status,
    createdBy: USER_ID,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    noteCount: 0,
    cardCount: 0,
    metadata: null,
  };
}

function installApi(options: {
  status?: string;
  allowed?: boolean;
  restore?: ReturnType<typeof vi.fn>;
} = {}) {
  const status = options.status ?? "archived";
  const allowed = options.allowed ?? true;
  const api = {
    auth: {
      getState: vi.fn(async () => ok({
        status: "authenticated",
        workspace: { workspaceId: WORKSPACE_ID, name: "理解空间" },
        workspaceEpoch: 7,
      })),
    },
    capabilities: {
      get: vi.fn(async () => ok({
        actionCapabilities: {
          "source.update": allowed ? "allowed" : "forbidden",
          "source.archive": allowed ? "allowed" : "forbidden",
          "source.createNote": allowed ? "allowed" : "forbidden",
        },
      })),
    },
    source: {
      get: vi.fn(async () => ok({ source: sourceWith(status), segments: [] })),
      listNotes: vi.fn(async () => ok({ items: [], total: 0, nextCursor: null, snapshotAt: "2026-09-22T00:00:00.000Z" })),
      archive: vi.fn(async () => ok({ sourceId: SOURCE_ID, status: "archived" })),
      reparse: vi.fn(async () => ok({ sourceId: SOURCE_ID, status: "draft" })),
      restore: options.restore ?? vi.fn(async () => ok({ sourceId: SOURCE_ID, status: "ready", alreadyActive: false })),
    },
    learningRun: { list: vi.fn(async () => ok({ items: [], total: 0 })) },
  };
  Object.defineProperty(window, "ailearn", { value: api, configurable: true });
  return api;
}

function mountAt(status?: string, allowed?: boolean, restore?: ReturnType<typeof vi.fn>) {
  const api = installApi({ status, allowed, restore });
  useRoomStore.setState({ activeSourceId: SOURCE_ID });
  render(<SourceDetailSurface />);
  return api;
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ activeSourceId: null });
});

describe("来源详情的「恢复来源」（审计 F08）", () => {
  it("已归档的来源：这颗按钮在，按下去真的恢复了一次，并回读状态", async () => {
    const api = mountAt("archived");
    const button = await screen.findByRole("button", { name: /恢复来源/ });
    // 反面：已经在归档态里，就不该再摆一颗「归档」（点了也只会 204 重复写一次）。
    expect(screen.queryByRole("button", { name: /^归档$/ })).toBeNull();
    const readsBefore = api.source.get.mock.calls.length;

    fireEvent.click(button);

    await waitFor(() => expect(api.source.restore).toHaveBeenCalledTimes(1));
    const call = api.source.restore.mock.calls[0][0] as { sourceId: string };
    expect(call.sourceId).toBe(SOURCE_ID);
    // 回执照实说恢复成了哪一档：有片段 → ready。
    await screen.findByText(/已把《惯性那一章》恢复到来源列表，之前解析好的片段都还在/);
    // 恢复之后要回读：屏上那些"已归档"的说法不能留着。
    await waitFor(() => expect(api.source.get.mock.calls.length).toBeGreaterThan(readsBefore));
  });

  it("恢复成 draft 时如实说「还没有正文片段」，不假装完整可用", async () => {
    const restore = vi.fn(async () => ok({ sourceId: SOURCE_ID, status: "draft", alreadyActive: false }));
    mountAt("archived", true, restore);

    fireEvent.click(await screen.findByRole("button", { name: /恢复来源/ }));

    await screen.findByText(/已把《惯性那一章》恢复到来源列表；它还没有正文片段，可以重新解析/);
  });

  it("本来就没归档（幂等）：说「本来就没有归档」，不说「已恢复」", async () => {
    const restore = vi.fn(async () => ok({ sourceId: SOURCE_ID, status: "ready", alreadyActive: true }));
    mountAt("archived", true, restore);

    fireEvent.click(await screen.findByRole("button", { name: /恢复来源/ }));

    await screen.findByText("这份来源本来就没有归档。");
  });

  it("没归档的来源不摆这颗按钮：它不是可归档那一档的逆操作", async () => {
    mountAt("ready");
    await screen.findByText("惯性那一章");
    expect(screen.queryByRole("button", { name: /恢复来源/ })).toBeNull();
    // 反面：这一档该摆的是「归档」本身。
    expect(screen.getByRole("button", { name: /^归档$/ })).toBeTruthy();
  });

  it("成员只读：不摆这颗按钮（写判据在服务端，界面不伪装入口）", async () => {
    mountAt("archived", false);
    await screen.findByText("惯性那一章");
    expect(screen.queryByRole("button", { name: /恢复来源/ })).toBeNull();
  });
});
