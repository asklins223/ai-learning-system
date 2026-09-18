// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayResultV1,
  SessionContextV1,
  WorkspaceSummaryV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import { HudAccountMenu } from "./HudAccountMenu";
import { SPACE_MENU_REFRESH_EVENT } from "./space-menu-events";

/**
 * Holds the three behaviours the menu owes its rows: joining stays inside the
 * menu and names the joined space (ADR-0009 — join is not switch), a background
 * refresh never blanks readable rows, and the current space's row reads as
 * disabled rather than silently swallowing clicks.
 */

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
});

function ok<T>(data: T, workspaceEpoch?: number): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "request-menu-test",
    correlationId: "correlation-menu-test",
    schemaRevision: "desktop-ipc-v1",
    ...(workspaceEpoch ? { workspaceEpoch } : {}),
  };
}

function workspace(id: string, name: string, type: "personal" | "collaborative"): WorkspaceSummaryV1 {
  return { version: 1, workspaceId: id, name, role: "owner", workspaceType: type, isPersonal: type === "personal" };
}

function session(workspaceId: string): SessionContextV1 {
  return {
    version: 1,
    status: "authenticated",
    user: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" },
    workspace: { ...workspace(workspaceId, "个人书房", "personal"), workspaceEpoch: 1 },
    membership: { role: "owner" },
    capabilities: null,
    workspaceEpoch: 1,
    credentialPersistence: "memory",
  };
}

const CURRENT = workspace("11111111-2222-4222-8222-222222222222", "个人书房", "personal");
const OTHER = workspace("11111111-3333-4333-8333-333333333333", "海岸研究室", "collaborative");
const JOINED = workspace("11111111-4444-4444-8444-444444444444", "山顶读书会", "collaborative");

function installApi(api: unknown) {
  Object.defineProperty(window, "ailearn", { configurable: true, value: api });
}

async function renderMenu(props: { readonly onSwitched?: () => void } = {}) {
  render(<HudAccountMenu notice={null} {...props} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /个人书房/ })).toBeTruthy());
}

describe("HudAccountMenu", () => {
  it("keeps the rows mounted while a background refresh is in flight", async () => {
    let releaseList: ((value: GatewayResultV1<{ workspaces: WorkspaceSummaryV1[] }>) => void) | undefined;
    installApi({
      auth: { getState: vi.fn().mockResolvedValue(ok(session(CURRENT.workspaceId), 1)) },
      workspace: {
        list: vi.fn()
          .mockResolvedValueOnce(ok({ workspaces: [CURRENT, OTHER] }, 1))
          .mockImplementationOnce(() => new Promise((resolve) => { releaseList = resolve; })),
      },
    });

    await renderMenu();
    await act(async () => { window.dispatchEvent(new Event(SPACE_MENU_REFRESH_EVENT)); });
    // 刷新挂起中：行还在，替换成「正在读取」整卡就是本轮修掉的闪烁。
    expect(screen.getByRole("button", { name: /海岸研究室/ })).toBeTruthy();
    expect(screen.getByText("正在更新列表……")).toBeTruthy();

    releaseList!(ok({ workspaces: [CURRENT, OTHER, JOINED] }, 2));
    await waitFor(() => expect(screen.getByRole("button", { name: /山顶读书会/ })).toBeTruthy());
  });

  it("keeps stale rows when a background refresh fails, with a retry", async () => {
    installApi({
      auth: { getState: vi.fn().mockResolvedValue(ok(session(CURRENT.workspaceId), 1)) },
      workspace: {
        list: vi.fn()
          .mockResolvedValueOnce(ok({ workspaces: [CURRENT, OTHER] }, 1))
          .mockRejectedValueOnce(new Error("refresh intentionally broken")),
      },
    });

    await renderMenu();
    await act(async () => { window.dispatchEvent(new Event(SPACE_MENU_REFRESH_EVENT)); });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("button", { name: /海岸研究室/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("joins without leaving the menu, names the joined space, and never reports a switch", async () => {
    const onSwitched = vi.fn();
    const joinWorkspace = vi.fn().mockResolvedValue(ok(session(CURRENT.workspaceId), 2));
    installApi({
      auth: {
        getState: vi.fn().mockResolvedValue(ok(session(CURRENT.workspaceId), 1)),
        joinWorkspace,
      },
      workspace: {
        list: vi.fn()
          .mockResolvedValueOnce(ok({ workspaces: [CURRENT, OTHER] }, 1))
          .mockResolvedValueOnce(ok({ workspaces: [CURRENT, OTHER, JOINED] }, 2)),
        switch: vi.fn(),
      },
    });

    await renderMenu();
    fireEvent.change(screen.getByLabelText("协作空间邀请码"), { target: { value: "invite-token-1" } });
    fireEvent.submit((screen.getByRole("button", { name: "加入" }) as HTMLButtonElement).form!);

    await waitFor(() => expect(screen.getByText(/已加入「山顶读书会」/)).toBeTruthy());
    expect(joinWorkspace).toHaveBeenCalledTimes(1);
    expect(onSwitched).not.toHaveBeenCalled();
    // 菜单没有收起：新行可以直接点进。
    expect(screen.getByRole("button", { name: /山顶读书会/ })).toBeTruthy();
    expect(screen.getByLabelText("协作空间邀请码")).toBeTruthy();
  });

  it("disables the current space's row and marks it as the active one", async () => {
    installApi({
      auth: { getState: vi.fn().mockResolvedValue(ok(session(CURRENT.workspaceId), 1)) },
      workspace: { list: vi.fn().mockResolvedValue(ok({ workspaces: [CURRENT, OTHER] }, 1)) },
    });

    await renderMenu();
    const currentRow = screen.getByRole("button", { name: /个人书房/ });
    expect(currentRow).toHaveProperty("disabled", true);
    expect(currentRow.getAttribute("data-current")).toBe("true");
    expect(currentRow.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: /海岸研究室/ })).toHaveProperty("disabled", false);
  });
});
