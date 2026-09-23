/**
 * M16：伴星那两条常连接要跟着窗口可见性收放，而 60 秒一次的 runtime fence 续约**不能**跟着停。
 *
 * 三条断言各自钉住一个容易"看起来对"的错误：
 *  1. 隐藏 → 两条 SSE 各自被停一次；只停这两条。
 *  2. 隐藏期间 fence 仍在续 → 服务端"她此刻在不在"的判断不能因为最小化而失真
 *     （停 fence 等于把"窗口最小化"当成"用户离线"，那是产品语义变更，不是性能优化）。
 *  3. 恢复 → 按**隐藏前那格 inbox 游标**续读，并补发一次 `snapshot_invalidated`
 *     （account 流在隐藏期间丢掉的那一段，例如 epoch 变了，没有别的路径能补回来）。
 *
 * 上一轮踩到的真相写在这里，免得再踩：`authGetState` 失败会被 `installHandler`
 * 咽成 `safe_internal_error`，而老用例根本不 assert 它的返回值——所以"生命周期没跑"
 * 表现为"我的实现不生效"。现在第一句断言就是 `result.ok === true`。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  sessionContextSchema,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import { companionOverviewSchema } from "@ailearn/shared/companion-shell-contracts";
import type { DesktopGateway } from "./desktop-gateway";

type InvokeHandler = (
  event: { readonly sender: unknown; readonly senderFrame?: { readonly url: string } },
  input: unknown,
) => Promise<GatewayResultV1<unknown>>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    }),
    /** 可见性由这里控制：把窗口标成 minimized / 不可见，主进程就该收流。 */
    state: { windows: [] as unknown[], supported: true },
  };
});

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {
    static getAllWindows(): unknown[] {
      if (!electronMock.state.supported) {
        throw new TypeError("getAllWindows unavailable");
      }
      return electronMock.state.windows;
    }
  },
  ipcMain: { handle: electronMock.handle, on: vi.fn() },
}));

import { registerM1DesktopIpc } from "./desktop-ipc";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_EPOCH = 4;

const meta: RequestMetaV1 = {
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  requestId: "request-companion-visibility",
  correlationId: "correlation-companion-visibility",
  clientStartedAt: "2026-09-24T00:00:00.000Z",
};

const overview = companionOverviewSchema.parse({
  account: {
    revision: 3,
    epoch: ACCOUNT_EPOCH,
    globalEnabled: true,
    presence: { presence: "online", updatedAt: "2026-09-24T00:00:00.000Z" },
    interventionLevel: "moderate",
    quietHours: null,
  },
  onboardingStates: [],
});

const session = sessionContextSchema.parse({
  version: 1,
  status: "authenticated",
  user: { userId: USER_ID, email: "owner@example.com", displayName: "Owner" },
  workspace: {
    version: 1,
    workspaceId: WORKSPACE_ID,
    name: "Owner workspace",
    role: "owner",
    workspaceType: "personal",
    isPersonal: true,
    workspaceEpoch: 9,
  },
  membership: { role: "owner" },
  capabilities: null,
  workspaceEpoch: 9,
  credentialPersistence: "memory",
});

type FakeWindow = {
  send: ReturnType<typeof vi.fn>;
  fire: (channel: string) => void;
  setMinimized: (value: boolean) => void;
  setVisible: (value: boolean) => void;
};

function makeWindow(): FakeWindow {
  const send = vi.fn();
  const listeners = new Map<string, Array<() => void>>();
  const flag = { minimized: false, visible: true };
  const window = {
    send,
    isDestroyed: () => false,
    isMinimized: () => flag.minimized,
    isVisible: () => flag.visible,
    once: () => undefined,
    on: (channel: string, cb: () => void) => {
      const bucket = listeners.get(channel) ?? [];
      bucket.push(cb);
      listeners.set(channel, bucket);
    },
    fire: (channel: string) => {
      for (const cb of listeners.get(channel) ?? []) cb();
    },
    setMinimized: (value: boolean) => { flag.minimized = value; },
    setVisible: (value: boolean) => { flag.visible = value; },
    webContents: {
      isDestroyed: () => false,
      once: () => undefined,
      on: () => undefined,
      send,
    },
  };
  return window as unknown as FakeWindow;
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function setup(options: { fakeTimers?: boolean } = {}) {
  if (options.fakeTimers) vi.useFakeTimers();
  vi.resetModules();
  electronMock.handlers.clear();
  const window = makeWindow();
  electronMock.state.windows = [window];
  electronMock.state.supported = true;

  const stopAccount = vi.fn();
  const stopInbox = vi.fn();
  const accountEpochCalls: number[] = [];
  const inboxCursorCalls: number[] = [];
  const renewFence = vi.fn(async () => undefined);
  let pushDelivery: ((delivery: { inboxSequence: number }) => void) | null = null;

  const named: Record<string, unknown> = {
    getDeploymentConfig: () => undefined,
    getSession: async () => session,
    getCompanionAccountOverview: async () => overview,
    renewCompanionRuntimeFence: renewFence,
    watchCompanionAccountEvents: async (epoch: number) => {
      accountEpochCalls.push(epoch);
      return stopAccount;
    },
    watchCompanionInboxEvents: async (
      cursor: number,
      cb: (delivery: { inboxSequence: number }) => void,
    ) => {
      inboxCursorCalls.push(cursor);
      pushDelivery = cb;
      return stopInbox;
    },
  };
  // 生命周期之外的调用一律给个会应答的兜底：缺一个方法就会让 authGetState
  // 变成 safe_internal_error，症状看起来像"实现没生效"。
  const gateway = new Proxy(named, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => null;
    },
  }) as unknown as DesktopGateway;

  const { registerM1DesktopIpc: register } = await import("./desktop-ipc");
  register({
    gateway,
    env: { AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => window as never,
    getWindowState: () => ({ version: 1, state: "visible", revision: 1 }) as never,
    setTitlebarTheme: () => true,
  });

  const event = { sender: {}, senderFrame: { url: "ailearn://renderer/" } };
  const call = (channel: string, input: unknown) => {
    const found = electronMock.handlers.get(channel);
    if (!found) throw new Error(`missing IPC handler for ${channel}`);
    return found(event, input);
  };

  const authed = await call(DESKTOP_IPC_CHANNELS.authGetState, { meta });
  expect(authed.ok, `authGetState 必须先成功：${JSON.stringify(authed)}`).toBe(true);
  await call(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe, {
    meta: { ...meta, workspaceEpoch: 9 },
    topic: { kind: "runtime" },
  });
  for (let attempt = 0; inboxCursorCalls.length === 0 && attempt < 40; attempt += 1) {
    if (options.fakeTimers) await vi.advanceTimersByTimeAsync(5);
    else await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(inboxCursorCalls.length, "伴星常连接尚未建立").toBeGreaterThan(0);
  await settle();

  return {
    window,
    call,
    event,
    meta,
    stopAccount,
    stopInbox,
    accountEpochCalls,
    inboxCursorCalls,
    renewFence,
    deliver: async (inboxSequence: number) => {
      pushDelivery?.({ inboxSequence });
      await settle();
    },
  };
}

describe("伴星常连接跟随窗口可见性（M16）", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("订阅 runtime 之后两条流都开着，fence 已续过一次", async () => {
    const s = await setup();
    expect(s.accountEpochCalls).toEqual([ACCOUNT_EPOCH]);
    expect(s.inboxCursorCalls).toEqual([0]);
    expect(s.renewFence).toHaveBeenCalledTimes(1);
    expect(s.stopAccount).not.toHaveBeenCalled();
    expect(s.stopInbox).not.toHaveBeenCalled();
  });

  it("最小化：两条流各自被停一次，而 fence 续约照旧、也不偷开新流", async () => {
    // 定时器必须在 setup 之前就换成假的：fence 的 `setInterval` 是在生命周期里
    // 创建的，先建后换会留下一个真 interval，`advanceTimersByTime` 永远打不到它。
    const s = await setup({ fakeTimers: true });
    try {
      s.window.setMinimized(true);
      s.window.fire("minimize");
      await settle();

      expect(s.stopAccount).toHaveBeenCalledTimes(1);
      expect(s.stopInbox).toHaveBeenCalledTimes(1);
      expect(s.accountEpochCalls).toHaveLength(1);

      const fencesBefore = s.renewFence.mock.calls.length;
      vi.advanceTimersByTime(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(s.renewFence.mock.calls.length).toBeGreaterThan(fencesBefore);
      // 隐藏期间心跳不许把流开回来
      expect(s.accountEpochCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("恢复可见：按隐藏前那格游标续读 inbox，并补发一次 snapshot_invalidated", async () => {
    const s = await setup();
    await s.deliver(17);

    s.window.setVisible(false);
    s.window.fire("hide");
    await settle();
    expect(s.stopInbox).toHaveBeenCalledTimes(1);

    s.window.setVisible(true);
    s.window.fire("show");
    await vi.waitFor(() => {
      if (s.inboxCursorCalls.length < 2) throw new Error("恢复后没重开流");
    }, { timeout: 2000 });
    await settle();

    expect(s.inboxCursorCalls).toEqual([0, 17]);
    expect(s.accountEpochCalls).toEqual([ACCOUNT_EPOCH, ACCOUNT_EPOCH]);
    const invalidated = s.window.send.mock.calls
      .map((call) => call?.[1] as { data?: { kind?: string } } | undefined)
      .filter((payload) => payload?.data?.kind === "snapshot_invalidated");
    expect(invalidated.length).toBeGreaterThan(0);
  });

  it("取不到窗口清单时不收流（读不到判据不许当成隐藏）", async () => {
    const s = await setup();
    electronMock.state.supported = false;
    s.window.setMinimized(true);
    s.window.fire("minimize");
    await settle();

    expect(s.stopAccount).not.toHaveBeenCalled();
    expect(s.stopInbox).not.toHaveBeenCalled();
    electronMock.state.supported = true;
  });
});
