import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_CONTRACT_VERSION,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import { sourceImageGetResultV1Schema } from "@ailearn/shared/source-image-contracts";
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
  requestId: "request-source-image-ipc",
  correlationId: "correlation-source-image-ipc",
  clientStartedAt: "2026-09-17T00:00:00.000Z",
};

const sourceImageObjectKey =
  "33333333-3333-4333-8333-333333333333/sources/44444444-4444-4444-8444-444444444444/55555555-5555-4555-8555-555555555555.png";

const imageRequest = { version: 1 as const, objectKey: sourceImageObjectKey };

const imageResult = sourceImageGetResultV1Schema.parse({
  version: 1,
  mimeType: "image/png",
  imageBase64: "iVBORw0KGgo=",
  byteLength: 8,
});

function requiredHandler(channel: string): InvokeHandler {
  const handler = electronMock.handlers.get(channel);
  if (!handler) throw new Error(`missing IPC handler for ${channel}`);
  return handler;
}

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

describe("source image desktop IPC", () => {
  it("serves in-app image bytes behind the strict request and result schemas", async () => {
    const getSourceImage = vi.fn().mockResolvedValue(imageResult);
    const gateway = {
      getDeploymentConfig: () => undefined,
      getSession: vi.fn().mockResolvedValue(session()),
      getSourceImage,
    } as unknown as DesktopGateway;

    registerM1DesktopIpc({
      gateway,
      env: { AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
      resolveWindow: () => ({} as never),
      getWindowState: () => ({ state: "visible", revision: 1 }),
      setTitlebarTheme: () => true,
    });

    const event = { sender: {}, senderFrame: { url: "ailearn://renderer/" } };
    await requiredHandler(DESKTOP_IPC_CHANNELS.authGetState)(event, { meta });
    const scopedMeta = { ...meta, workspaceEpoch: 9 };

    const result = await requiredHandler(DESKTOP_IPC_CHANNELS.sourceImageGet)(event, {
      meta: scopedMeta,
      request: imageRequest,
    });
    expect(result).toMatchObject({ ok: true, data: imageResult, workspaceEpoch: 9 });
    expect(getSourceImage).toHaveBeenCalledWith(imageRequest, meta.requestId);

    // 地址形状在 main 边界就要被拦住：外链、data URI、路径遍历与未登记目录都到不了
    // gateway，通道因此不可能被当成任意路径代理。
    for (const objectKey of [
      "https://i0.hdslb.com/bfs/article/a.png",
      "data:image/png;base64,iVBORw0KGgo=",
      "22222222-2222-4222-8222-222222222222/sources/../../etc/passwd",
      "22222222-2222-4222-8222-222222222222/secrets/44444444-4444-4444-8444-444444444444/55555555-5555-4555-8555-555555555555.png",
      "22222222-2222-4222-8222-222222222222/sources/44444444-4444-4444-8444-444444444444/55555555-5555-4555-8555-555555555555.svg",
    ]) {
      const rejected = await requiredHandler(DESKTOP_IPC_CHANNELS.sourceImageGet)(event, {
        meta: scopedMeta,
        request: { version: 1, objectKey },
      });
      expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    // 未经声明的额外字段同样被拒（strictObject）。
    const extraKey = await requiredHandler(DESKTOP_IPC_CHANNELS.sourceImageGet)(event, {
      meta: scopedMeta,
      request: { ...imageRequest, absolutePath: "/data/ailearn" },
    });
    expect(extraKey).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(getSourceImage).toHaveBeenCalledTimes(1);

    // 另一个工作区的 epoch 不再回图：这是"换了工作区还在读旧图"的唯一防线。
    const staleEpoch = await requiredHandler(DESKTOP_IPC_CHANNELS.sourceImageGet)(event, {
      meta: { ...meta, workspaceEpoch: 3 },
      request: imageRequest,
    });
    expect(staleEpoch).toMatchObject({ ok: false, error: { code: "stale_workspace" } });
    expect(getSourceImage).toHaveBeenCalledTimes(1);

    // gateway 返回合同之外的 mime 时，output schema 必须 fail closed，不把原样
    // payload 交给渲染层。
    getSourceImage.mockResolvedValueOnce({ ...imageResult, mimeType: "image/svg+xml" });
    const unsafeOutput = await requiredHandler(DESKTOP_IPC_CHANNELS.sourceImageGet)(event, {
      meta: scopedMeta,
      request: imageRequest,
    });
    expect(unsafeOutput).toMatchObject({
      ok: false,
      error: { code: "unsupported_contract" },
      workspaceEpoch: 9,
    });
  });
});
