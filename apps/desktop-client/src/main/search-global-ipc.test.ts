/**
 * F47 的主进程这半：`ailearn.v1.search.global` 拿到的页必须**原样穿过** IPC，
 * 而形状不对的页必须**报错**，不能回一页空的。
 *
 * 为什么这条值得单独钉：审计量到界面「0 / 0 条」时，光看界面分不清是
 * "服务端真的没有"还是"这一层把页弄丢了"。这条用例把主进程这一格变成可判定的：
 * 服务端给 5 条，跨过 IPC 就得是 5 条、5 行、`total=5`；给一条坏页（缺 `total`）
 * 就得是 `unsupported_contract`，而不是静默的 `{items:[],total:0}`。
 */
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@ailearn/shared/desktop-ipc-contracts";
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
  };
});

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  ipcMain: { handle: electronMock.handle, on: vi.fn() },
}));

import { registerM1DesktopIpc } from "./desktop-ipc";

const meta: RequestMetaV1 = {
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  requestId: "request-f47",
  correlationId: "correlation-f47",
  clientStartedAt: "2026-09-17T00:00:00.000Z",
};

function session() {
  return {
    version: 1,
    status: "authenticated",
    user: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" },
    workspace: {
      version: 1,
      workspaceId: "22222222-2222-4222-8222-222222222222",
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
  };
}

/** Exactly the row shape `apps/api/src/modules/search/service.ts` returns. */
function serverPage() {
  const items = [
    { objectType: "source", title: "阿里云百炼", objectId: "33333333-3333-4333-8333-333333333331" },
    { objectType: "source", title: "IndexTTS 语音合成", objectId: "33333333-3333-4333-8333-333333333332" },
    { objectType: "note", title: "TTS 笔记", objectId: "33333333-3333-4333-8333-333333333333" },
    { objectType: "note", title: "TTS 对比", objectId: "33333333-3333-4333-8333-333333333334" },
    { objectType: "objective", title: "理解 TTS", objectId: "33333333-3333-4333-8333-333333333335" },
  ].map((row) => ({
    objectType: row.objectType,
    objectId: row.objectId,
    title: row.title,
    snippet: `…${row.title}…`,
    indexedAt: "2026-09-22T07:22:05.460Z",
    href: `/${row.objectType}s/${row.objectId}`,
    matchCount: 1,
  }));
  return { items, total: items.length, nextCursor: null };
}

/**
 * 注册只能发生一次（模块级的 `registrationComplete`）。所以这里注册一份，
 * 每个用例改这同一个 gateway 桩的返回值。
 */
const searchGlobal = vi.fn();

function installGateway() {
  const gateway = {
    getDeploymentConfig: () => undefined,
    getSession: vi.fn().mockResolvedValue(session()),
    searchGlobal,
  } as unknown as DesktopGateway;

  registerM1DesktopIpc({
    gateway,
    env: { AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => ({} as never),
    getWindowState: () => ({ state: "visible", revision: 1 }),
    setTitlebarTheme: () => true,
  });
}

installGateway();

const event = { sender: {}, senderFrame: { url: "ailearn://renderer/" } };

async function search(metaOverride: Partial<RequestMetaV1> = {}) {
  await electronMock.handlers.get(DESKTOP_IPC_CHANNELS.authGetState)?.(event, { meta });
  return electronMock.handlers.get(DESKTOP_IPC_CHANNELS.searchGlobal)?.(event, {
    meta: { ...meta, workspaceEpoch: 9, ...metaOverride },
    query: "TTS",
    limit: 24,
  });
}

describe("ailearn.v1.search.global · 主进程这半", () => {
  it("服务端给 5 条，穿过 IPC 后还是 5 条、5 行、total=5", async () => {
    const page = serverPage();
    searchGlobal.mockResolvedValue(page);

    const result = await search();

    expect(result).toMatchObject({ ok: true });
    const data = (result as { data: { items: Array<{ title: string }>; total: number } }).data;
    expect(data.total).toBe(5);
    expect(data.items).toHaveLength(5);
    // 行序原样保留：第一行就是服务端的第一条。
    expect(data.items.map((item) => item.title)).toEqual(page.items.map((item) => item.title));
  });

  it("形状不对的页报 unsupported_contract，不静默回一页空的", async () => {
    // 少了 `total`：解析失败必须抛，而不是被吞成 {items:[],total:0}。
    searchGlobal.mockResolvedValue({ items: [], nextCursor: null });

    const result = await search();

    expect(result).toMatchObject({ ok: false, error: { code: "unsupported_contract" } });
  });
});
