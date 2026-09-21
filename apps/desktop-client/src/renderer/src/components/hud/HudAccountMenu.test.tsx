// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayResultV1,
  SessionContextV1,
  WorkspaceSummaryV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import { HudAccountMenu } from "./HudAccountMenu";
import {
  SPACE_MENU_REFRESH_EVENT,
  takePendingSpaceSwitchReceipt,
} from "./space-menu-events";
import { subscribeGateInvalidation } from "../../app/gate-invalidation";
import { useRoomStore } from "../../app/room-store";

/** 组件通过监听器广播门禁失效，测试订阅一份来断言"创建即进入"真的重验了。 */
const gateInvalidations: string[] = [];
subscribeGateInvalidation((code) => { gateInvalidations.push(code); });

/**
 * Holds the three behaviours the menu owes its rows: joining stays inside the
 * menu and names the joined space (ADR-0009 — join is not switch), a background
 * refresh never blanks readable rows, and the current space's row reads as
 * disabled rather than silently swallowing clicks.
 */

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  useRoomStore.setState({ activeRunId: null });
  gateInvalidations.length = 0;
  takePendingSpaceSwitchReceipt();
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

async function renderMenu(props: { readonly onSwitched?: (workspaceName: string) => void } = {}) {
  render(<HudAccountMenu notice={null} {...props} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /个人书房/ })).toBeTruthy());
}

describe("HudAccountMenu", () => {
  it("每一行都报出身份：个人空间不再只写一个 Personal，成员写明只读", async () => {
    installApi({
      auth: { getState: vi.fn().mockResolvedValue(ok(session(CURRENT.workspaceId), 1)) },
      workspace: {
        list: vi.fn().mockResolvedValue(ok({
          workspaces: [CURRENT, OTHER, { ...JOINED, role: "member" as const }],
        }, 1)),
      },
    });
    await renderMenu();

    const personal = screen.getByRole("button", { name: /个人书房/ });
    expect(personal.textContent).toContain("个人空间 · 所有者");
    expect(personal.textContent).not.toContain("Personal");
    expect(screen.getByRole("button", { name: /海岸研究室/ }).textContent).toContain("协作空间 · 所有者");
    // 「只读」必须是文字：颜色不能是唯一载体，成员更要看得见自己不能改。
    expect(screen.getByRole("button", { name: /山顶读书会/ }).textContent).toContain("成员 · 只读");
  });

  it("creates a collaborative space and enters it via the switch receipt path", async () => {
    const createWorkspace = vi.fn().mockResolvedValue(ok({
      version: 1, workspaceId: OTHER.workspaceId, name: "海岸研究室",
    }, 1));
    installApi({
      auth: { getState: vi.fn().mockResolvedValue(ok(session(CURRENT.workspaceId), 1)) },
      workspace: {
        list: vi.fn().mockResolvedValue(ok({ workspaces: [CURRENT, OTHER] }, 1)),
        create: createWorkspace,
      },
    });
    render(<HudAccountMenu notice={null} onSwitched={() => undefined} />);
    const nameField = await screen.findByLabelText("新协作空间名称");
    fireEvent.change(nameField, { target: { value: "海岸研究室" } });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));

    await waitFor(() => expect(createWorkspace).toHaveBeenCalledTimes(1));
    // 主进程创建后会 switchWorkspace，所以这里必须按"换了空间"处理：停车回执 +
    // 让门禁重验。若不重验，界面会继续用旧空间的 session 上下文发请求。
    expect(takePendingSpaceSwitchReceipt()).toBe("海岸研究室");
    expect(gateInvalidations).toContain("stale_workspace");
  });

  it("surfaces a rejected create instead of failing silently", async () => {
    installApi({
      auth: { getState: vi.fn().mockResolvedValue(ok(session(CURRENT.workspaceId), 1)) },
      workspace: {
        list: vi.fn().mockResolvedValue(ok({ workspaces: [CURRENT] }, 1)),
        create: vi.fn().mockResolvedValue({
          version: 1, ok: false, requestId: "r", correlationId: "c", schemaRevision: "s",
          error: { code: "forbidden", safeMessageKey: "error.forbidden", retry: "never" },
        }),
      },
    });
    render(<HudAccountMenu notice={null} onSwitched={() => undefined} />);
    const nameField = await screen.findByLabelText("新协作空间名称");
    fireEvent.change(nameField, { target: { value: "不该成功的空间" } });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));

    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(takePendingSpaceSwitchReceipt()).toBeNull();
  });


  it("asks twice before switching away from a running formal assessment", async () => {
    // 切换会走门禁失效路径，主进程当场 failClosed 掉正式测评并拆流，store 里的
    // activeRunId 直接被清空——一次点击就能让进行中的测评无声消失。
    const onSwitched = vi.fn();
    const switchWorkspace = vi.fn().mockResolvedValue(ok(session(OTHER.workspaceId), 2));
    installApi({
      auth: { getState: vi.fn().mockResolvedValue(ok(session(CURRENT.workspaceId), 1)) },
      workspace: {
        list: vi.fn().mockResolvedValue(ok({ workspaces: [CURRENT, OTHER] }, 1)),
        switch: switchWorkspace,
      },
    });
    useRoomStore.setState({ activeRunId: "11111111-9999-4999-8999-999999999999" });
    render(<HudAccountMenu notice={null} onSwitched={onSwitched} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /海岸研究室/ })).toBeTruthy());

    const row = screen.getByRole("button", { name: /海岸研究室/ });
    fireEvent.click(row);
    expect(switchWorkspace).not.toHaveBeenCalled();
    expect(onSwitched).not.toHaveBeenCalled();
    expect(screen.getByText("再点确认")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /海岸研究室/ }));
    await waitFor(() => expect(switchWorkspace).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSwitched).toHaveBeenCalledWith("海岸研究室"));
  });

  it("switches on the first click when no assessment is running", async () => {
    const switchWorkspace = vi.fn().mockResolvedValue(ok(session(OTHER.workspaceId), 2));
    installApi({
      auth: { getState: vi.fn().mockResolvedValue(ok(session(CURRENT.workspaceId), 1)) },
      workspace: {
        list: vi.fn().mockResolvedValue(ok({ workspaces: [CURRENT, OTHER] }, 1)),
        switch: switchWorkspace,
      },
    });
    useRoomStore.setState({ activeRunId: null });
    render(<HudAccountMenu notice={null} onSwitched={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /海岸研究室/ })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /海岸研究室/ }));
    await waitFor(() => expect(switchWorkspace).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("再点确认")).toBeNull();
  });
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
