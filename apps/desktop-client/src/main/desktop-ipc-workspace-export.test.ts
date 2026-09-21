import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import type { DesktopGateway } from "./desktop-gateway";

/**
 * The export handler is the only place in the client that writes a file, so it
 * is tested through the real IPC registration: the save dialog and the writer
 * are the mocks, everything between them is production code. What matters is
 * that a cancelled dialog writes nothing, a failed write is not reported as a
 * success, and a body the gateway could not parse never reaches the disk.
 */

type InvokeHandler = (
  event: { readonly sender: unknown; readonly senderFrame?: { readonly url: string } },
  input: unknown,
) => Promise<GatewayResultV1<unknown>>;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, InvokeHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler);
    }),
    showSaveDialog: vi.fn(),
    writeFile: vi.fn(),
  };
});

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  ipcMain: { handle: mocks.handle, on: vi.fn() },
  dialog: { showSaveDialog: mocks.showSaveDialog },
}));

vi.mock("node:fs/promises", () => ({ writeFile: mocks.writeFile }));

/**
 * 导出是工作区作用面的读，而主进程的 `assertEpoch` 已改为 fail-closed：不带 epoch
 * 的请求一律 `stale_workspace`。所以边界必须先建立起来（见 register 里走的一次
 * `auth.getState`，与 desktop-ipc-source-image.test.ts 同一手法），再带 epoch 发请求。
 */
const WORKSPACE_EPOCH = 9;

const meta: RequestMetaV1 = {
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  requestId: "request-workspace-export",
  correlationId: "correlation-workspace-export",
  clientStartedAt: "2026-09-17T00:00:00.000Z",
  workspaceEpoch: WORKSPACE_EPOCH,
};

function sessionStub() {
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
      workspaceEpoch: WORKSPACE_EPOCH,
    },
    membership: { role: "owner" },
    capabilities: null,
    workspaceEpoch: WORKSPACE_EPOCH,
    credentialPersistence: "memory",
  };
}

const event = { sender: {}, senderFrame: { url: "ailearn://renderer/" } };

async function register(gateway: DesktopGateway) {
  vi.resetModules();
  const { registerM1DesktopIpc } = await import("./desktop-ipc");
  registerM1DesktopIpc({
    gateway,
    env: { AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => ({}) as never,
    getWindowState: () => ({ state: "visible", revision: 1 }),
    setTitlebarTheme: () => true,
  });
  // 走一次 auth.getState，让主进程记住当前工作区边界。
  const establish = mocks.handlers.get(DESKTOP_IPC_CHANNELS.authGetState);
  if (!establish) throw new Error("auth.getState channel was not registered");
  await establish(event, { meta });
}

function handler(): InvokeHandler {
  const registered = mocks.handlers.get(DESKTOP_IPC_CHANNELS.workspaceExport);
  if (!registered) throw new Error("workspace export channel was not registered");
  return registered;
}

function gatewayStub(payload: unknown) {
  return {
    getDeploymentConfig: () => undefined,
    getSession: vi.fn().mockResolvedValue(sessionStub()),
    fetchWorkspaceExport: vi.fn().mockResolvedValue(payload),
  } as unknown as DesktopGateway;
}

describe("workspace export IPC", () => {
  beforeEach(() => {
    mocks.showSaveDialog.mockReset();
    mocks.writeFile.mockReset();
  });

  it("writes the server payload to the path the reader picked", async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/tmp/ailearn-workspace.json" });
    mocks.writeFile.mockResolvedValue(undefined);
    await register(gatewayStub({ workspace: { name: "Studio" } }));

    const result = await handler()(event, { meta });

    expect(result).toMatchObject({
      ok: true,
      data: {
        version: 1,
        saved: true,
        canceled: false,
        filePath: "/tmp/ailearn-workspace.json",
      },
    });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const [path, text] = mocks.writeFile.mock.calls[0]!;
    expect(path).toBe("/tmp/ailearn-workspace.json");
    expect(JSON.parse(String(text))).toEqual({ workspace: { name: "Studio" } });
    expect((result as { data: { bytes: number } }).data.bytes).toBe(Buffer.byteLength(String(text), "utf8"));
  });

  it("writes nothing when the reader cancels the save dialog", async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: "" });
    await register(gatewayStub({ workspace: { name: "Studio" } }));

    const result = await handler()(event, { meta });

    expect(result).toMatchObject({ ok: true, data: { saved: false, canceled: true, filePath: null, bytes: 0 } });
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("reports a failed local write instead of claiming success", async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/tmp/ailearn-workspace.json" });
    mocks.writeFile.mockRejectedValueOnce(new Error("EACCES"));
    await register(gatewayStub({ workspace: { name: "Studio" } }));

    const result = await handler()(event, { meta });

    expect(result).toMatchObject({ ok: false, error: { code: "safe_internal_error" } });
  });

  it("refuses the request when the renderer did not state a workspace boundary", async () => {
    // fail-closed 的回归锁：漏传 epoch 曾经是"直接放行"，于是批量采集在循环中途
    // 切空间时，剩余条目会带着新空间的凭据落进新空间。现在缺 epoch 即视为过期。
    await register(gatewayStub({ workspace: { name: "Studio" } }));

    const { workspaceEpoch: _omitted, ...metaWithoutBoundary } = meta;
    const result = await handler()(event, { meta: metaWithoutBoundary });

    expect(result).toMatchObject({ ok: false, error: { code: "stale_workspace" } });
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("refuses the request when it carries another workspace's epoch", async () => {
    await register(gatewayStub({ workspace: { name: "Studio" } }));

    const result = await handler()(event, { meta: { ...meta, workspaceEpoch: WORKSPACE_EPOCH + 1 } });

    expect(result).toMatchObject({ ok: false, error: { code: "stale_workspace" } });
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("refuses to write a file for a body the gateway could not parse", async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: "/tmp/ailearn-workspace.json" });
    await register(gatewayStub(null));

    const result = await handler()(event, { meta });

    expect(result).toMatchObject({ ok: false, error: { code: "unsupported_contract" } });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
  });
});
