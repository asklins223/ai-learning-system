/**
 * IPC 通道覆盖对账（doc 34 L1）。
 *
 * 为什么需要这一份而不是再多写几个用例：`ailearn.v1.note.doc.syncTitle` 曾经
 * **契约、preload 转发、网关实现三样齐备，唯独主进程没有 `installHandler`**，
 * 于是渲染层那一句 `window.ailearn.note.doc.syncTitle(...)` 直接 reject，
 * 界面上只剩"重命名未确认"那句兜底话。而它当时的"消费者"是一个 `vi.fn()` 替身——
 * 替身不会去找 handler，所以测试是绿的。
 *
 * 这里断言的是**集合相等**，不是"某个函数被调用过"：契约里声明的每一个通道，
 * 要么在主进程被 `ipcMain.handle` 注册，要么出现在下面那份**写明理由的出站/事件通道名单**里。
 * 名单本身也被断言"确实以那种方式绑定了"，所以它不能慢慢腐烂成一条随手加的豁免。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import type { DesktopGateway } from "./desktop-gateway";
import { MemoryNoteDocCacheStore } from "./note-doc-cache-store.ts";

type InvokeHandler = (
  event: { readonly sender: unknown; readonly senderFrame?: { readonly url: string } },
  input: unknown,
) => Promise<GatewayResultV1<unknown>>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>();
  const listeners = new Set<string>();
  return {
    handlers,
    listeners,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string) => {
      listeners.add(channel);
    }),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {
    static getAllWindows(): never[] {
      return [];
    }
  },
  ipcMain: { handle: electronMock.handle, on: electronMock.on },
  session: { defaultSession: { on: vi.fn(() => true) } },
  app: { on: vi.fn(), whenReady: () => Promise.resolve() },
  nativeTheme: { themeSource: "system", on: vi.fn() },
}));

/**
 * 不走 `ipcMain.handle` 的通道，逐条给理由。**这三条之外不该再有第四条**：
 * 新增一条 invoke 通道却忘了注册，就会像 L1 那样静默 reject。
 */
const NON_INVOKE_CHANNELS: Record<string, string> = {
  [DESKTOP_IPC_CHANNELS.contractGetSnapshot]: "同步取快照，走 `ipcMain.on` + sendSync",
  [DESKTOP_IPC_CHANNELS.subscriptionsEvent]: "主进程 → renderer 的出站事件，用 `webContents.send`",
};

const meta: RequestMetaV1 = {
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  requestId: "request-channel-coverage",
  correlationId: "correlation-channel-coverage",
  clientStartedAt: "2026-09-22T00:00:00.000Z",
  workspaceEpoch: 9,
} as RequestMetaV1;

const NOTE_ID = "33333333-3333-4333-8333-333333333333";

/** 只给到"注册期不会碰网关"的最小替身：这里测的是边界层有没有口，不是网关行为。 */
function stubGateway(overrides: Partial<DesktopGateway> = {}): DesktopGateway {
  return {
    getDeploymentConfig: () => undefined,
    // 带一个已认证的会话快照：`assertEpoch` 认的是主进程当前那一份 epoch，
    // 而它是读会话时才立起来的——没有会话，所有带 epoch 的通道都会回 `stale_workspace`。
    getSession: vi.fn(async () => ({
      version: 1,
      status: "authenticated",
      user: { userId: "11111111-1111-4111-8111-111111111111", email: "me@example.com" },
      workspace: {
        version: 1,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        name: "空间",
        role: "owner",
        workspaceType: "collaborative",
        isPersonal: false,
        workspaceEpoch: 9,
      },
      membership: { role: "owner" },
      capabilities: null,
      workspaceEpoch: 9,
      credentialPersistence: "memory",
    })),
    flushNoteDocPending: vi.fn(async () => undefined),
    dropNoteDocLocalSessions: vi.fn(() => undefined),
    // `null` = 网关此刻没有本机那一份，`persistNoteDocLocal` 据此直接返回。
    // 本机文档与落盘的真实行为在 `desktop-gateway.test.ts` 里对着网关验，
    // 这里只验边界层：通道通不通、schema 挡不挡、参数有没有原样交出去。
    noteDocLocalSnapshot: vi.fn(() => null),
    syncNoteDocTitle: vi.fn(async () => ({
      via: "uploaded" as const,
      revision: 11,
      savedAt: "2026-09-22T00:00:00.000Z",
    })),
    ...overrides,
  } as unknown as DesktopGateway;
}

async function register(gateway: DesktopGateway = stubGateway()) {
  // `registerM1DesktopIpc` 一个模块实例只准注册一次（重复注册抛错是有意的），
  // 所以每个用例换一份干净的模块实例。
  vi.resetModules();
  const { registerM1DesktopIpc } = await import("./desktop-ipc");
  const fakeWindow = {
    isDestroyed: () => false,
    once: () => undefined,
    webContents: { isDestroyed: () => false, once: () => undefined, send: vi.fn() },
  } as never;
  registerM1DesktopIpc({
    gateway,
    noteDocCache: new MemoryNoteDocCacheStore(),
    env: { AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => fakeWindow,
    getWindowState: () => ({ state: "visible", revision: 1 }),
    setTitlebarTheme: () => true,
  });
  const event = { sender: {}, senderFrame: { url: "ailearn://renderer/" } };
  // 先读一次状态，把主进程的 activeWorkspaceEpoch 立起来（与笔记协同那份集测同一口径）。
  await electronMock.handlers.get(DESKTOP_IPC_CHANNELS.authGetState)!(event, { meta });
  return { event, gateway };
}

function requireData(result: GatewayResultV1<unknown>): Record<string, unknown> {
  if (!result.ok) throw new Error(`IPC 调用失败：${JSON.stringify(result.error)}`);
  return result.data as Record<string, unknown>;
}

describe("IPC 通道覆盖对账", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.listeners.clear();
    electronMock.handle.mockClear();
    electronMock.on.mockClear();
  });

  it("契约里每一条通道都有归属：注册成 handler，或在写明理由的出站名单里", async () => {
    await register();
    const declared = Object.values(DESKTOP_IPC_CHANNELS);
    const registered = electronMock.handlers;

    const unaccounted = declared.filter(
      (channel) => !registered.has(channel) && !(channel in NON_INVOKE_CHANNELS),
    );
    const exemptedButActuallyRegistered = Object.keys(NON_INVOKE_CHANNELS).filter((channel) =>
      registered.has(channel),
    );
    const exemptedNotBoundAnywhere = Object.keys(NON_INVOKE_CHANNELS).filter(
      (channel) => !registered.has(channel) && !electronMock.listeners.has(channel)
        && !channel.endsWith(".event"),
    );

    // 三条断言分别对应三种"名单开始说谎"的方式。
    expect(
      { unaccounted },
      `这些通道在契约里声明了、主进程却没注册 handler（新通道忘了注册就是这个形状）：${unaccounted.join(", ")}`,
    ).toEqual({ unaccounted: [] });
    expect(exemptedButActuallyRegistered).toEqual([]);
    expect(exemptedNotBoundAnywhere).toEqual([]);
  });

  it("声明数与归属数相等：加一条通道却不注册、也不进名单，这里就会红", async () => {
    await register();
    const declaredCount = Object.keys(DESKTOP_IPC_CHANNELS).length;
    expect(electronMock.handlers.size + Object.keys(NON_INVOKE_CHANNELS).length).toBe(declaredCount);
  });

  it("`note.doc.syncTitle` 这条曾经没人注册：现在它真的能打到网关并带回出口", async () => {
    const gateway = stubGateway();
    const { event } = await register(gateway);
    const channel = DESKTOP_IPC_CHANNELS.noteDocSyncTitle;
    const handler = electronMock.handlers.get(channel);
    if (!handler) throw new Error(`channel ${channel} 没有注册处理器（这就是 L1 报的那个洞）`);

    const result = await handler(event, {
      meta,
      commandId: "note-rename-1",
      noteId: NOTE_ID,
      title: "改过的名字",
      titleSource: "manual",
    });

    expect(requireData(result)).toEqual({
      via: "uploaded",
      revision: 11,
      savedAt: "2026-09-22T00:00:00.000Z",
    });
    const syncNoteDocTitle = gateway.syncNoteDocTitle as unknown as ReturnType<typeof vi.fn>;
    expect(syncNoteDocTitle).toHaveBeenCalledWith(NOTE_ID, "改过的名字", "manual", meta.requestId);
  });

  it("改名口在本机就被 schema 挡住：空标题与多带字段都过不去，不去敲网关", async () => {
    const gateway = stubGateway();
    const { event } = await register(gateway);
    const handler = electronMock.handlers.get(DESKTOP_IPC_CHANNELS.noteDocSyncTitle);
    expect(handler).toBeTruthy();
    const syncNoteDocTitle = gateway.syncNoteDocTitle as unknown as ReturnType<typeof vi.fn>;

    const emptyTitle = await handler!(event, {
      meta,
      commandId: "note-rename-2",
      noteId: NOTE_ID,
      title: "",
      titleSource: "manual",
    });
    const extraField = await handler!(event, {
      meta,
      commandId: "note-rename-3",
      noteId: NOTE_ID,
      title: "可以",
      titleSource: "manual",
      body: "不该存在的字段",
    } as never);

    expect(emptyTitle.ok).toBe(false);
    expect(extraField.ok).toBe(false);
    expect(syncNoteDocTitle).not.toHaveBeenCalled();
  });
});
