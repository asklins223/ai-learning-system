/**
 * 笔记协同的 IPC 契约（批次 4.3 验收）。
 *
 * 为什么必须有这一份：IPC 的事件 `kind` 是一份 `z.enum` 白名单，漏改**不报错**，
 * 只会把事件静默丢掉（计划里的风险 3）。所以这里断言的不是"函数被调用"，而是
 * "一帧真的送到了 renderer 的 send() 上"。顺带钉住门控（决定 7b）与"写入只有一个
 * 正门"这两条：门控判错的表现是多占一条长连接，或者 personal 空间根本没有连接时
 * 写不进去。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const NOTE_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_EPOCH = 9;

const meta: RequestMetaV1 = {
  version: 1,
  contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
  requestId: "request-note-doc",
  correlationId: "correlation-note-doc",
  clientStartedAt: "2026-09-21T00:00:00.000Z",
  workspaceEpoch: WORKSPACE_EPOCH,
} as RequestMetaV1;

function handler(channel: string): InvokeHandler {
  const found = electronMock.handlers.get(channel);
  if (!found) throw new Error(`channel ${channel} 没有注册处理器`);
  return found;
}

/**
 * 一套假 gateway + 假窗口。
 *
 * `workspaceType` / `role` 是门控的两条判据；`send` 收的是 renderer 那一侧真正收到的
 * 事件信封，所以断言落在"送达"而不是"调用"。
 */
async function setup(session: { workspaceType: "personal" | "collaborative"; role: "owner" | "member" }) {
  // `registerM1DesktopIpc` 一个模块实例只准注册一次（重复注册会抛错，这是有意的），
  // 所以每个用例换一个干净的模块实例，而不是共享同一张订阅表。
  vi.resetModules();
  const { registerM1DesktopIpc } = await import("./desktop-ipc");
  const streamHandle = {
    // 返回一条增量 = 这次提交确实改了文档（回执 `stream`）；返回 null 是"没改动"。
    applyBlocks: vi.fn(() => "AA==" as string | null),
    view: vi.fn(() => ({ blocks: [], title: "", titleSource: "auto" })),
    setPresence: vi.fn(),
    stop: vi.fn(),
  };
  type WatchCall = [string, (event: { noteId: string } & Record<string, unknown>) => void | Promise<void>];
  const watchNoteDocument = vi.fn(async (..._args: WatchCall) => streamHandle) as unknown as ReturnType<typeof vi.fn> & {
    mock: { calls: WatchCall[] };
  };
  const uploadNoteDocUpdate = vi.fn(async () => ({ revision: 7, savedAt: "2026-09-21T00:00:00.000Z" }));
  const getNoteDocState = vi.fn(async () => ({
    blocks: [{ ordinal: 0, type: "paragraph", content: "正文" }],
    title: "标题",
    titleSource: "auto",
    revision: 3,
    backfilled: false,
  }));
  const syncViaGateway = vi.fn(async () => ({ via: "uploaded" as const, revision: 11, savedAt: "2026-09-21T00:00:00.000Z" }));
  const send = vi.fn();
  const fakeWindow = {
    isDestroyed: () => false,
    // 订阅会绑窗口生命周期（closed / destroyed），假窗口也得能被绑。
    once: () => undefined,
    webContents: { isDestroyed: () => false, once: () => undefined, send },
  } as never;

  const gateway = {
    getDeploymentConfig: () => undefined,
    getSession: vi.fn().mockResolvedValue({
      version: 1,
      status: "authenticated",
      user: { userId: "11111111-1111-4111-8111-111111111111", email: "me@example.com" },
      workspace: {
        version: 1,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        name: "空间",
        role: session.role,
        workspaceType: session.workspaceType,
        isPersonal: session.workspaceType === "personal",
        workspaceEpoch: WORKSPACE_EPOCH,
      },
      membership: { role: session.role },
      capabilities: null,
      workspaceEpoch: WORKSPACE_EPOCH,
      credentialPersistence: "memory",
    }),
    watchNoteDocument,
    uploadNoteDocUpdate,
    syncNoteDocBlocks: syncViaGateway,
    // 网关那两个新动作在 IPC 这边只管调用；本机文档与队列的真实行为
    // 在 `desktop-gateway.test.ts` 里对着网关本身验。
    flushNoteDocPending: vi.fn(async () => undefined),
    dropNoteDocLocalSessions: vi.fn(() => undefined),
    getNoteDocState,
  } as unknown as DesktopGateway;

  registerM1DesktopIpc({
    gateway,
    env: { AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => fakeWindow,
    getWindowState: () => ({ state: "visible", revision: 1 }),
    setTitlebarTheme: () => true,
  });

  const event = { sender: {}, senderFrame: { url: "ailearn://renderer/" } };
  await handler(DESKTOP_IPC_CHANNELS.authGetState)(event, { meta });
  return { event, streamHandle, watchNoteDocument, uploadNoteDocUpdate, syncViaGateway, getNoteDocState, send };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 只有成功回执才带 data；失败时把整个信封抖出来，免得用例只留下一句 "data 不存在"。 */
function requireData(result: GatewayResultV1<unknown>): Record<string, unknown> {
  if (!result.ok) throw new Error(`IPC 调用失败：${JSON.stringify(result.error)}`);
  return result.data as Record<string, unknown>;
}

describe("笔记协同的 IPC 通道", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.handle.mockClear();
  });

  it("协作空间的可写成员订阅一篇笔记：建连，且事件真的送达 renderer", async () => {
    const { event, watchNoteDocument, send } = await setup({ workspaceType: "collaborative", role: "owner" });
    const subscribed = await handler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe)(event, {
      meta,
      topic: { kind: "noteDoc", noteId: NOTE_ID },
    });
    const subscriptionId = requireData(subscribed).subscriptionId as string;
    expect(subscriptionId).toBeTruthy();
    await settle();
    expect(watchNoteDocument).toHaveBeenCalledTimes(1);
    expect(watchNoteDocument.mock.calls[0][0]).toBe(NOTE_ID);
    // URL / 文档名由主进程派生，界面传不进来。
    expect(String(watchNoteDocument.mock.calls[0][1])).not.toContain("note:");

    send.mockClear();
    // 这就是风险 3 的那一条：kind 白名单或 payload union 漏一处，下面就是 0 次调用。
    const onEvent = watchNoteDocument.mock.calls[0][1] as (e: unknown) => void | Promise<void>;
    await onEvent({ noteId: NOTE_ID, type: "blocks", blocks: [{ ordinal: 0, type: "paragraph", content: "别人的改动" }], title: "标题", titleSource: "auto" });
    expect(send).toHaveBeenCalledTimes(1);
    const [channel, payload] = send.mock.calls[0];
    expect(channel).toBe(DESKTOP_IPC_CHANNELS.subscriptionsEvent);
    expect(payload).toMatchObject({
      kind: "note_doc_event",
      workspaceEpoch: WORKSPACE_EPOCH,
      data: {
        kind: "note_doc_event",
        noteId: NOTE_ID,
        event: { type: "blocks", blocks: [{ ordinal: 0, type: "paragraph", content: "别人的改动" }], title: "标题", titleSource: "auto" },
      },
    });

    await onEvent({ noteId: NOTE_ID, type: "status", status: "authenticated", authorizedScope: "readonly" });
    expect(send.mock.calls[1][1]).toMatchObject({
      data: { event: { type: "status", status: "authenticated", authorizedScope: "readonly" } },
    });
  });

  it("personal 空间不建长连接，写入改走一次性上送", async () => {
    const { event, watchNoteDocument, syncViaGateway, uploadNoteDocUpdate } = await setup({ workspaceType: "personal", role: "owner" });
    await handler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe)(event, {
      meta,
      topic: { kind: "noteDoc", noteId: NOTE_ID },
    });
    await settle();
    expect(watchNoteDocument).not.toHaveBeenCalled();

    const written = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncBlocks)(event, {
      meta,
      commandId: "command-upload-1",
      noteId: NOTE_ID,
      blocks: [{ type: "paragraph", content: "改过的正文" }],
    });
    expect(written).toMatchObject({ ok: true, data: { via: "uploaded", revision: 11 } });
    expect(syncViaGateway).toHaveBeenCalledWith(NOTE_ID, [{ type: "paragraph", content: "改过的正文" }], undefined, meta.requestId);
  });

  it("协作空间的只读成员同样不建连，写入也拿不到流", async () => {
    const { event, watchNoteDocument, syncViaGateway, uploadNoteDocUpdate } = await setup({ workspaceType: "collaborative", role: "member" });
    await handler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe)(event, {
      meta,
      topic: { kind: "noteDoc", noteId: NOTE_ID },
    });
    await settle();
    expect(watchNoteDocument).not.toHaveBeenCalled();
    // 可写性的判据只在服务端那一处：主进程不自己挡，交给 API 回 403。
    const written = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncBlocks)(event, {
      meta,
      commandId: "command-upload-2",
      noteId: NOTE_ID,
      blocks: [{ type: "paragraph", content: "成员想改的正文" }],
    });
    expect(written).toMatchObject({ ok: true, data: { via: "uploaded" } });
    // 只读成员在主进程这一层不被"再判一次"：那样会变成两套判据。差分与上送照走，
    // 真拒绝由 API 的 requireOwner 给 403。
    expect(syncViaGateway).toHaveBeenCalledTimes(1);
    expect(uploadNoteDocUpdate).not.toHaveBeenCalled();
  });

  it("有连接时写入并进那份文档，不再走 HTTP", async () => {
    const { event, streamHandle, watchNoteDocument, syncViaGateway, uploadNoteDocUpdate } = await setup({
      workspaceType: "collaborative",
      role: "owner",
    });
    await handler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe)(event, {
      meta,
      topic: { kind: "noteDoc", noteId: NOTE_ID },
    });
    await settle();
    expect(watchNoteDocument).toHaveBeenCalledTimes(1);

    const written = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncBlocks)(event, {
      meta,
      commandId: "command-stream-1",
      noteId: NOTE_ID,
      blocks: [{ type: "paragraph", content: "改过的正文" }],
    });
    expect(written).toMatchObject({ ok: true, data: { via: "stream", revision: null } });
    expect(streamHandle.applyBlocks).toHaveBeenCalledWith([{ type: "paragraph", content: "改过的正文" }], undefined);
    expect(uploadNoteDocUpdate).not.toHaveBeenCalled();
  });

  it("编辑起点是视图（blocks + 标题），编码不出主进程", async () => {
    const { event, getNoteDocState } = await setup({ workspaceType: "collaborative", role: "owner" });
    const state = await handler(DESKTOP_IPC_CHANNELS.noteDocState)(event, { meta, noteId: NOTE_ID });
    expect(state).toMatchObject({ ok: true, data: { blocks: [{ ordinal: 0, type: "paragraph", content: "正文" }], title: "标题", revision: 3 } });
    expect(JSON.stringify(state)).not.toContain("state-as-base64");
    expect(getNoteDocState).toHaveBeenCalledWith(NOTE_ID, meta.requestId);
  });

  it("退订之后连接被收掉；同一篇的另一个订阅者还在时不收", async () => {
    const { event, streamHandle } = await setup({ workspaceType: "collaborative", role: "owner" });
    const firstId = requireData(await handler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe)(event, {
      meta,
      topic: { kind: "noteDoc", noteId: NOTE_ID },
    })).subscriptionId as string;
    const secondId = requireData(await handler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe)(event, {
      meta,
      topic: { kind: "noteDoc", noteId: NOTE_ID },
    })).subscriptionId as string;
    expect(secondId).not.toBe(firstId);
    await settle();
    expect(streamHandle.stop).not.toHaveBeenCalled();

    await handler(DESKTOP_IPC_CHANNELS.subscriptionsUnsubscribe)(event, {
      meta,
      subscriptionId: firstId,
    });
    expect(streamHandle.stop).not.toHaveBeenCalled();

    await handler(DESKTOP_IPC_CHANNELS.subscriptionsUnsubscribe)(event, {
      meta,
      subscriptionId: secondId,
    });
    expect(streamHandle.stop).toHaveBeenCalledTimes(1);
  });

  it("超限的提交不进 gateway：空块数组与超块数都在入口被拒", async () => {
    const { event, uploadNoteDocUpdate } = await setup({ workspaceType: "personal", role: "owner" });
    const empty = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncBlocks)(event, {
      meta,
      commandId: "command-empty",
      noteId: NOTE_ID,
      blocks: [],
    });
    const oversized = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncBlocks)(event, {
      meta,
      commandId: "command-oversize",
      noteId: NOTE_ID,
      blocks: Array.from({ length: 2_500 }, () => ({ type: "paragraph", content: "x" })),
    });
    expect(oversized.ok).toBe(false);
    expect(uploadNoteDocUpdate).not.toHaveBeenCalled();
  });
});
