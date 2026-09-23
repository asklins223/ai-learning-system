// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceDetailSurface } from "./source-detail-surface";
import { useRoomStore } from "../../app/room-store";

/**
 * 「重新解析」这颗按钮（doc 34 L7）。
 *
 * 病是这么来的：界面上那句"打开来源后可以重新解析"是写给用户的，而**全仓没有
 * 一个对应的端点**——`parse_source` 的 job 被判 `dead` 时只改 `jobs`，
 * `sources.status` 永远停在「处理中」，用户点开来源只看到一句做不到的承诺。
 *
 * 因此这里钉三件事：状态对才出现这颗按钮；按下去真的打到那条通道；
 * 服务端说"已经在排了"时回的是那句话，而不是"再点一次试试"。
 */

const SOURCE_ID = "00000000-0000-4000-8000-0000000000aa";
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
  reparse?: ReturnType<typeof vi.fn>;
} = {}) {
  const status = options.status ?? "failed";
  const allowed = options.allowed ?? true;
  const capability = (name: string) => (allowed ? "allowed" : name === "source.update" ? "forbidden" : "allowed");
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
          "source.update": capability("source.update"),
          "source.archive": allowed ? "allowed" : "forbidden",
          "source.createNote": "allowed",
        },
      })),
    },
    source: {
      get: vi.fn(async () => ok({ source: sourceWith(status), segments: [] })),
      listNotes: vi.fn(async () => ok({ items: [], total: 0, nextCursor: null, snapshotAt: "2026-09-22T00:00:00.000Z" })),
      archive: vi.fn(async () => ok({ sourceId: SOURCE_ID, status: "archived" })),
      reparse: options.reparse ?? vi.fn(async () => ok({ sourceId: SOURCE_ID, status: "draft" })),
    },
    learningRun: { list: vi.fn(async () => ok({ items: [], total: 0 })) },
  };
  Object.defineProperty(window, "ailearn", { value: api, configurable: true });
  return api;
}

function mountAt(status?: string, allowed?: boolean) {
  const api = installApi({ status, allowed });
  useRoomStore.setState({ activeSourceId: SOURCE_ID });
  const view = render(<SourceDetailSurface />);
  return { api, view };
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ activeSourceId: null });
});

describe("来源详情的「重新解析」", () => {
  it("解析失败的来源：这颗按钮在，按下去真的排了一次", async () => {
    const { api } = mountAt("failed");
    const button = await screen.findByRole("button", { name: /重新解析/ });
    fireEvent.click(button);

    await waitFor(() => expect(api.source.reparse).toHaveBeenCalledTimes(1));
    const call = api.source.reparse.mock.calls[0][0] as { sourceId: string };
    expect(call.sourceId).toBe(SOURCE_ID);
    await screen.findByText(/已经排上重新解析了/);
  });

  it("卡在处理中的来源也给出口——那正是 job 被判死后残留的状态", async () => {
    const { api } = mountAt("processing");
    const button = await screen.findByRole("button", { name: /重新解析/ });
    fireEvent.click(button);
    await waitFor(() => expect(api.source.reparse).toHaveBeenCalledTimes(1));
  });

  it("已经解析好的来源不摆这颗按钮：那不是它缺的东西", async () => {
    mountAt("ready");
    await screen.findByText("惯性那一章");
    expect(screen.queryByRole("button", { name: /重新解析/ })).toBeNull();
  });

  it("服务端说「已经有任务在跑」：回的是这句话，不是让用户再点一次", async () => {
    // 交回真实的失败信封：`unwrapGatewayResult` 会按 `error.code` 抛
    // `RendererGatewayError`，界面认的就是那个码——所以这里不能随手 throw 一个字符串。
    const conflict = vi.fn(async () => ({
      ok: false as const,
      workspaceEpoch: 7,
      error: { code: "conflict" as const, safeMessageKey: "error.conflict", retry: "user_action" as const },
    }));
    const api = installApi({ status: "failed", reparse: conflict });
    useRoomStore.setState({ activeSourceId: SOURCE_ID });
    render(<SourceDetailSurface />);
    const button = await screen.findByRole("button", { name: /重新解析/ });
    fireEvent.click(button);

    await waitFor(() => expect(api.source.reparse).toHaveBeenCalled());
    await screen.findByText(/已经有任务在跑/);
    // 反向钉：这句话不能是"重新解析没排上：…"那条通用兜底。
    expect(screen.queryByText(/重新解析没排上/)).toBeNull();
  });

  it("成员只读：不摆这颗按钮（写判据在服务端，界面不伪装入口）", async () => {
    mountAt("failed", false);
    await screen.findByText("惯性那一章");
    expect(screen.queryByRole("button", { name: /重新解析/ })).toBeNull();
  });
});
