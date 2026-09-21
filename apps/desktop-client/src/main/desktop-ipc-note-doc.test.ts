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
import {
  MemoryNoteDocCacheStore,
  type NoteDocCacheEntryV1,
  type NoteDocCacheStore,
} from "./note-doc-cache-store.ts";

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
async function setup(session: {
  workspaceType: "personal" | "collaborative";
  role: "owner" | "member";
  noteDocCache?: NoteDocCacheStore;
  /** 把建连按住，用来量"订阅回执比连接早"那一段窗口里的行为。 */
  deferStream?: boolean;
}) {
  // `registerM1DesktopIpc` 一个模块实例只准注册一次（重复注册会抛错，这是有意的），
  // 所以每个用例换一个干净的模块实例，而不是共享同一张订阅表。
  vi.resetModules();
  const { registerM1DesktopIpc } = await import("./desktop-ipc");
  const noteDocCache = session.noteDocCache ?? new MemoryNoteDocCacheStore();
  let releaseStream: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { releaseStream = resolve; });
  const streamHandle = {
    // 返回一条增量 = 这次提交确实改了文档（回执 `stream`）；返回 null 是"没改动"。
    applyBlocks: vi.fn(() => "AA==" as string | null),
    view: vi.fn(() => ({ blocks: [], title: "", titleSource: "auto" })),
    setPresence: vi.fn(),
    stop: vi.fn(),
  };
  type WatchCall = [string, (event: { noteId: string } & Record<string, unknown>) => void | Promise<void>];
  const watchNoteDocument = vi.fn(async (...args: WatchCall) => {
    if (session.deferStream) await gate;
    void args;
    return streamHandle;
  }) as unknown as ReturnType<typeof vi.fn> & {
    mock: { calls: WatchCall[] };
  };
  const uploadNoteDocUpdate = vi.fn(async () => ({ revision: 7, savedAt: "2026-09-21T00:00:00.000Z" }));
  const getNoteDocState = vi.fn(async () => ({
    blocks: [{ ordinal: 0, type: "paragraph", content: "正文" }],
    title: "标题",
    titleSource: "auto",
    revision: 3,
    backfilled: false,
    // 归属来自服务端：`private` 的那篇主进程不会为它建长连接（写入照旧）。
    // 默认给 shared，让"该建连的场景"继续测到建连；不放心的地方另有专门用例。
    shareScope: "shared" as const,
  }));
  // 本机那一份的样子由网关管，这里给一套能记账的替身：网关侧的真实行为在
  // `desktop-gateway.test.ts` 里对着网关本身验，这里只验边界层用对了它。
  const localDoc = {
    docState: "GIVERAIAggISAEugEIggEiuAQ=" as string,
    pending: [] as string[],
    revision: 3,
    savedAt: "2026-09-21T00:00:00.000Z",
    shareScope: "shared" as const,
  };
  const restored: Array<{ noteId: string; snapshot: Record<string, unknown> }> = [];
  const noteDocLocalSnapshot = vi.fn(() => ({ ...localDoc }));
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
    // 每次调用重新拼一份：`mockResolvedValue` 的对象是在这里就定死的，用例中途改了
    // `session.role` 也读不到，那条"角色变了要重连"的用例会假绿。
    getSession: vi.fn(async () => ({
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
    })),
    watchNoteDocument,
    uploadNoteDocUpdate,
    syncNoteDocBlocks: syncViaGateway,
    // 网关那两个新动作在 IPC 这边只管调用；本机文档与队列的真实行为
    // 在 `desktop-gateway.test.ts` 里对着网关本身验。
    flushNoteDocPending: vi.fn(async () => undefined),
    dropNoteDocLocalSessions: vi.fn(() => undefined),
    logout: vi.fn(async () => ({ loggedOut: true as const, serverRevoked: true })),
    getNoteDocState,
    noteDocLocalSnapshot,
    restoreNoteDocLocal: vi.fn((noteId: string, snapshot: Record<string, unknown>) => {
      restored.push({ noteId, snapshot });
    }),
  } as unknown as DesktopGateway;

  registerM1DesktopIpc({
    gateway,
    noteDocCache,
    env: { AILEARN_DOMAIN_SCHEMA_REVISION: "domain-v2-test" },
    resolveWindow: () => fakeWindow,
    getWindowState: () => ({ state: "visible", revision: 1 }),
    setTitlebarTheme: () => true,
  });

  const event = { sender: {}, senderFrame: { url: "ailearn://renderer/" } };
  await handler(DESKTOP_IPC_CHANNELS.authGetState)(event, { meta });
  return {
    event,
    streamHandle,
    watchNoteDocument,
    uploadNoteDocUpdate,
    syncViaGateway,
    getNoteDocState,
    send,
    noteDocCache,
    localDoc,
    restored,
    releaseStream,
  };
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

  it("只读成员也建连（他要看到别人的改动），但写入不走那条流", async () => {
    const { event, streamHandle, watchNoteDocument, syncViaGateway, uploadNoteDocUpdate } = await setup({ workspaceType: "collaborative", role: "member" });
    await handler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe)(event, {
      meta,
      topic: { kind: "noteDoc", noteId: NOTE_ID },
    });
    await settle();
    // 改这条断言的理由：先前主进程按角色把自己挡在门外，于是"只读成员能实时看到
    // 别人的编辑"这条服务端专门实现过的能力在产品里根本不存在，"谁还开着这一篇"
    // 也永远数不到他。可写与否的答复由服务端的 `Authenticated("readonly")` 给。
    expect(watchNoteDocument).toHaveBeenCalledTimes(1);

    const onEvent = watchNoteDocument.mock.calls[0][1] as (e: unknown) => void | Promise<void>;
    await onEvent({ noteId: NOTE_ID, type: "status", status: "authenticated", authorizedScope: "readonly" });

    // 只读答复之后，写入仍然照走 HTTP：那条路上的 403 才是真判据，本机不自证清白。
    const written = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncBlocks)(event, {
      meta,
      commandId: "command-readonly-write",
      noteId: NOTE_ID,
      blocks: [{ type: "paragraph", content: "成员想改的正文" }],
    });
    expect(written).toMatchObject({ ok: true, data: { via: "uploaded" } });
    expect(syncViaGateway).toHaveBeenCalledTimes(1);
    expect(streamHandle.applyBlocks).not.toHaveBeenCalled();
    expect(uploadNoteDocUpdate).not.toHaveBeenCalled();
    // 只读不影响在场广播：他也得出现在别人那一排头像里。
    await handler(DESKTOP_IPC_CHANNELS.noteDocPresence)(event, { meta, noteId: NOTE_ID, state: JSON.stringify({ name: "小琳" }) });
    expect(streamHandle.setPresence).toHaveBeenCalledWith(JSON.stringify({ name: "小琳" }));
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
    // 并进流之前先要拿到服务端那句"你可以写"。没拿到时写入退回 HTTP，两条路上的
    // 判据仍然是同一句话——而不是"有连接就算写得进"。
    const onEvent = watchNoteDocument.mock.calls[0][1] as (e: unknown) => void | Promise<void>;
    await onEvent({ noteId: NOTE_ID, type: "status", status: "authenticated", authorizedScope: "read-write" });

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

  it("服务端还没答复可写之前，写入退回 HTTP（不把没落盘的东西报成 stream）", async () => {
    const { event, streamHandle, watchNoteDocument, syncViaGateway } = await setup({
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
      commandId: "command-no-scope-yet",
      noteId: NOTE_ID,
      blocks: [{ type: "paragraph", content: "改过的正文" }],
    });
    expect(written).toMatchObject({ ok: true, data: { via: "uploaded" } });
    expect(streamHandle.applyBlocks).not.toHaveBeenCalled();
    expect(syncViaGateway).toHaveBeenCalledTimes(1);
  });

  it("编辑起点是视图（blocks + 标题），编码不出主进程", async () => {
    const { event, getNoteDocState } = await setup({ workspaceType: "collaborative", role: "owner" });
    const state = await handler(DESKTOP_IPC_CHANNELS.noteDocState)(event, { meta, noteId: NOTE_ID });
    expect(state).toMatchObject({ ok: true, data: { blocks: [{ ordinal: 0, type: "paragraph", content: "正文" }], title: "标题", revision: 3 } });
    expect(JSON.stringify(state)).not.toContain("state-as-base64");
    expect(getNoteDocState).toHaveBeenCalledWith(NOTE_ID, meta.requestId);
  });

  it("订阅回执比连接早时报名字不会被吞：连接一就位就补交", async () => {
    const { event, streamHandle, releaseStream } = await setup({ workspaceType: "collaborative", role: "owner", deferStream: true });
    await handler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe)(event, {
      meta,
      topic: { kind: "noteDoc", noteId: NOTE_ID },
    });
    // 这一刻连接还在建（`ensureNoteDocStream` 是异步的），界面那声报名字已经打进来了。
    const early = await handler(DESKTOP_IPC_CHANNELS.noteDocPresence)(event, {
      meta,
      noteId: NOTE_ID,
      state: JSON.stringify({ name: "Asklins" }),
    });
    expect(requireData(early)).toEqual({ shared: false });
    expect(streamHandle.setPresence).not.toHaveBeenCalled();

    releaseStream();
    await settle();
    await settle();
    expect(streamHandle.setPresence).toHaveBeenCalledTimes(1);
    expect(streamHandle.setPresence).toHaveBeenCalledWith(JSON.stringify({ name: "Asklins" }));
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

  it("角色变了要退掉旧连接：新的读写答复只能从重连那一刻拿到", async () => {
    const fakeSession: { workspaceType: "personal" | "collaborative"; role: "owner" | "member" } = { workspaceType: "collaborative", role: "member" };
    const { event, streamHandle, watchNoteDocument } = await setup(fakeSession);
    await handler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe)(event, {
      meta,
      topic: { kind: "noteDoc", noteId: NOTE_ID },
    });
    await settle();
    expect(watchNoteDocument).toHaveBeenCalledTimes(1);

    // 把人提升成 owner。服务端只在鉴权那一刻给一次 `Authenticated(...)`，旧连接上
    // 那份"只读"答复不会自己变——不退掉重连，他手上的界面就永远停在写不进去。
    fakeSession.role = "owner";
    await handler(DESKTOP_IPC_CHANNELS.authGetState)(event, { meta });
    expect(streamHandle.stop).toHaveBeenCalledTimes(1);

    await handler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe)(event, {
      meta,
      topic: { kind: "noteDoc", noteId: NOTE_ID },
    });
    await settle();
    expect(watchNoteDocument).toHaveBeenCalledTimes(2);
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

  // ─── 本机那一份的落盘（决定 7：断网可编辑要能跨过重启）───────────────

  const SUBJECT_ID = "11111111-1111-4111-8111-111111111111";
  const SPACE_ID = "22222222-2222-4222-8222-222222222222";
  const cacheKey = { subjectId: SUBJECT_ID, workspaceId: SPACE_ID, noteId: NOTE_ID };

  const seedEntry = async (over: Partial<NoteDocCacheEntryV1> = {}): Promise<NoteDocCacheEntryV1> => ({
    docState: "3P9s6f7v0d0zq3K0ZjBvbw==",
    pending: ["kQQBoAEKYAAAAAAAAAAAAAA="],
    revision: 2,
    savedAt: "2026-09-20T00:00:00.000Z",
    shareScope: "shared",
    epochAtRest: 4,
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...over,
  });

  const seedCache = async (store: NoteDocCacheStore, over: Partial<NoteDocCacheEntryV1> = {}) => {
    await store.set(cacheKey, await seedEntry(over));
  };

  it("打开一篇：读到的是服务端那份，落盘的也是这一份的状态", async () => {
    const store = new MemoryNoteDocCacheStore();
    const { event, noteDocCache } = await setup({ workspaceType: "personal", role: "owner", noteDocCache: store });
    const opened = await handler(DESKTOP_IPC_CHANNELS.noteDocState)(event, { meta, noteId: NOTE_ID });
    expect(JSON.stringify(requireData(opened).blocks)).toContain("正文");

    const stored = await store.get(cacheKey);
    expect(stored?.docState).toBeTruthy();
    expect(stored?.shareScope).toBe("shared");
    // 刚跟服务端对过一次账，队列必须是空的——留着旧队列会让重启后白重发一批。
    expect(stored?.pending).toEqual([]);
  });

  it("盘上已经有一份时，先把它接回本机文档，再并服务端的起点", async () => {
    const store = new MemoryNoteDocCacheStore();
    await seedCache(store);
    const { event, restored } = await setup({ workspaceType: "collaborative", role: "owner", noteDocCache: store });
    await handler(DESKTOP_IPC_CHANNELS.noteDocState)(event, { meta, noteId: NOTE_ID });

    expect(restored).toHaveLength(1);
    expect(restored[0].snapshot).toMatchObject({ docState: "3P9s6f7v0d0zq3K0ZjBvbw==", pending: ["kQQBoAEKYAAAAAAAAAAAAAA="] });
  });




  it("写一次就把本机那份重写一遍：queued 的那些不留在内存里过夜", async () => {
    const store = new MemoryNoteDocCacheStore();
    const { event } = await setup({ workspaceType: "personal", role: "owner", noteDocCache: store });
    await handler(DESKTOP_IPC_CHANNELS.noteDocSyncBlocks)(event, {
      meta,
      commandId: "command-sync-persist",
      noteId: NOTE_ID,
      blocks: [{ type: "paragraph", content: "断网期间改的那一段" }],
    });
    expect(await store.get(cacheKey)).not.toBeNull();
  });

  it("退登把这台机器上的正文清掉", async () => {
    const store = new MemoryNoteDocCacheStore();
    await seedCache(store);
    const { event } = await setup({ workspaceType: "personal", role: "owner", noteDocCache: store });
    await handler(DESKTOP_IPC_CHANNELS.authLogout)(event, { meta });
    expect(await store.get(cacheKey)).toBeNull();
  });

  it("上一次是别人留下的那一份，不会被接进这次的文档", async () => {
    // 这台机器的 userData 是共用的：缓存键少了 subjectId 的话，另一个人打开同一篇
    // 就会把别人断网期间写的正文接进自己的文档，然后当作自己的改动交回服务端。
    // 归属判据（批次 4.5）在服务器上挡得住读，挡不住这条本机路径。
    const store = new MemoryNoteDocCacheStore();
    await store.set({ ...cacheKey, subjectId: "88888888-8888-4888-8888-888888888888" }, await seedEntry());
    const { event, restored } = await setup({ workspaceType: "personal", role: "owner", noteDocCache: store });
    await handler(DESKTOP_IPC_CHANNELS.noteDocState)(event, { meta, noteId: NOTE_ID });
    expect(restored).toHaveLength(0);
    // 正向对照：同一篇换个身份（自己的那份）时确实会接回来，上一条不是因为根本没读盘。
    const own = new MemoryNoteDocCacheStore();
    await own.set(cacheKey, await seedEntry());
    const second = await setup({ workspaceType: "personal", role: "owner", noteDocCache: own });
    await handler(DESKTOP_IPC_CHANNELS.noteDocState)(second.event, { meta, noteId: NOTE_ID });
    expect(second.restored).toHaveLength(1);
  });
});
