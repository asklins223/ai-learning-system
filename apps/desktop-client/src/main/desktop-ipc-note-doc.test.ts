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
import * as Y from "yjs";
import { emptyNoteDoc, projectNoteBlocks, writeNoteBlocks } from "./test-support/note-doc-test-doc";
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

/** 一条真实的本机增量：主进程只看 base64 规范形，不看内容，所以这里不编字符串。 */
/** 服务端起点的那份编码：带一个真的正文块，好让"读到的是服务端那份"这类断言
 * 能解出字来验，而不是只看字符串不为空。 */
const bodyUpdate = (): string => {
  const doc = emptyNoteDoc();
  writeNoteBlocks(doc, [{ type: "paragraph", content: "正文" }]);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
};
const decodedBody = (update: string): string => {
  const doc = emptyNoteDoc();
  Y.applyUpdate(doc, Buffer.from(update, "base64"));
  const body = projectNoteBlocks(doc).map((block) => block.content).join("");
  doc.destroy();
  return body;
};

const makeUpdate = (key: string): string => {
  const doc = new Y.Doc();
  doc.getMap("probe").set(key, key);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
};

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
    applyLocal: vi.fn(() => "AA==" as string | null),
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
    update: bodyUpdate(),
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
    // 真 `BrowserWindow` 一定有 `on`（M16 在它上面绑可见性事件），假窗口少这个
    // 方法会让产品代码在测试里抛 TypeError——那是替身没跟齐，不是缺陷。
    on: () => undefined,
    isVisible: () => true,
    isMinimized: () => false,
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
    syncNoteDocUpdate: syncViaGateway,
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
    // 同一条增量走两头：`makeUpdate` 每次的 client id 不同，分两次调就会
    // 期望值与实发值不等（那量的就不再是"帧到没到"了）。
    const peerUpdate = makeUpdate("peer");
    await onEvent({ noteId: NOTE_ID, type: "update", update: peerUpdate });
    expect(send).toHaveBeenCalledTimes(1);
    const [channel, payload] = send.mock.calls[0];
    expect(channel).toBe(DESKTOP_IPC_CHANNELS.subscriptionsEvent);
    expect(payload).toMatchObject({
      kind: "note_doc_event",
      workspaceEpoch: WORKSPACE_EPOCH,
      data: {
        kind: "note_doc_event",
        noteId: NOTE_ID,
        event: { type: "update", update: peerUpdate },
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

    const written = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncUpdate)(event, {
      meta,
      commandId: "command-upload-1",
      noteId: NOTE_ID,
      update: makeUpdate("a"),
    });
    expect(written).toMatchObject({ ok: true, data: { via: "uploaded", revision: 11 } });
    expect(syncViaGateway).toHaveBeenCalledWith(NOTE_ID, expect.any(String), meta.requestId);
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
    const written = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncUpdate)(event, {
      meta,
      commandId: "command-readonly-write",
      noteId: NOTE_ID,
      update: makeUpdate("m"),
    });
    expect(written).toMatchObject({ ok: true, data: { via: "uploaded" } });
    expect(syncViaGateway).toHaveBeenCalledTimes(1);
    expect(streamHandle.applyLocal).not.toHaveBeenCalled();
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

    const written = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncUpdate)(event, {
      meta,
      commandId: "command-stream-1",
      noteId: NOTE_ID,
      update: makeUpdate("a"),
    });
    expect(written).toMatchObject({ ok: true, data: { via: "stream", revision: null } });
    expect(streamHandle.applyLocal).toHaveBeenCalledWith(expect.any(String));
    expect(uploadNoteDocUpdate).not.toHaveBeenCalled();
  });

  it("连接掉了之后写入退回 HTTP，重连鉴权后再回到流", async () => {
    // 可写的那句答复只在鉴权那一刻来一次，而连接会掉。掉了还留着 `read-write`，写入就
    // 继续并进那条**发不出去**的文档：provider 的 `send` 在 socket 不是 open 时静默丢弃
    // （`readyState === Open` 才发），界面上照样"● 已写入，正在同步"，而正文只活在主进程
    // 那份内存文档里——离开这一篇（transport 被销毁）就没了。所以掉线必须让 `via` 变回
    // `uploaded`（HTTP 那条同一个增量口，服务端一样收到）。
    const { event, watchNoteDocument, syncViaGateway, uploadNoteDocUpdate } = await setup({
      workspaceType: "collaborative",
      role: "owner",
    });
    await handler(DESKTOP_IPC_CHANNELS.subscriptionsSubscribe)(event, {
      meta,
      topic: { kind: "noteDoc", noteId: NOTE_ID },
    });
    await settle();
    const onEvent = watchNoteDocument.mock.calls[0][1] as (e: unknown) => void | Promise<void>;
    await onEvent({ noteId: NOTE_ID, type: "status", status: "authenticated", authorizedScope: "read-write" });

    // 正向对照：连着的时候确实走流。
    const onStream = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncUpdate)(event, {
      meta,
      commandId: "command-before-drop",
      noteId: NOTE_ID,
      update: makeUpdate("before-drop"),
    });
    expect(onStream).toMatchObject({ ok: true, data: { via: "stream" } });

    await onEvent({ noteId: NOTE_ID, type: "status", status: "disconnected" });
    const afterDrop = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncUpdate)(event, {
      meta,
      commandId: "command-after-drop",
      noteId: NOTE_ID,
      update: makeUpdate("after-drop"),
    });
    expect(afterDrop).toMatchObject({ ok: true, data: { via: "uploaded" } });
    expect(syncViaGateway).toHaveBeenCalledTimes(1);
    expect(uploadNoteDocUpdate).not.toHaveBeenCalled();

    // 重连并再次鉴权之后回到流那条路：掉一次不等于永久退化。
    await onEvent({ noteId: NOTE_ID, type: "status", status: "authenticated", authorizedScope: "read-write" });
    const reconnected = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncUpdate)(event, {
      meta,
      commandId: "command-after-reconnect",
      noteId: NOTE_ID,
      update: makeUpdate("after-reconnect"),
    });
    expect(reconnected).toMatchObject({ ok: true, data: { via: "stream" } });
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

    const written = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncUpdate)(event, {
      meta,
      commandId: "command-no-scope-yet",
      noteId: NOTE_ID,
      update: makeUpdate("a"),
    });
    expect(written).toMatchObject({ ok: true, data: { via: "uploaded" } });
    expect(streamHandle.applyLocal).not.toHaveBeenCalled();
    expect(syncViaGateway).toHaveBeenCalledTimes(1);
  });

  it("编辑起点是视图（blocks + 标题），编码不出主进程", async () => {
    const { event, getNoteDocState } = await setup({ workspaceType: "collaborative", role: "owner" });
    const state = await handler(DESKTOP_IPC_CHANNELS.noteDocState)(event, { meta, noteId: NOTE_ID });
    expect(state).toMatchObject({ ok: true, data: { revision: 3 } });
    // 起点现在**就是**那份编码：渲染进程要拿它建自己的文档，不给就等于让界面自己拼一棵树。
    expect(String(JSON.stringify(state))).toContain("update");

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

  it("超限的提交不进 gateway：空增量与超上限的增量都在入口被拒", async () => {
    const { event, uploadNoteDocUpdate } = await setup({ workspaceType: "personal", role: "owner" });
    const empty = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncUpdate)(event, {
      meta,
      commandId: "command-empty",
      noteId: NOTE_ID,
      update: "",
    });
    const oversized = await handler(DESKTOP_IPC_CHANNELS.noteDocSyncUpdate)(event, {
      meta,
      commandId: "command-oversize",
      noteId: NOTE_ID,
      update: "A".repeat(4 * 1024 * 1024 + 8),
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
    expect(decodedBody(requireData(opened).update as string)).toContain("正文");

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
    await handler(DESKTOP_IPC_CHANNELS.noteDocSyncUpdate)(event, {
      meta,
      commandId: "command-sync-persist",
      noteId: NOTE_ID,
      update: makeUpdate("offline"),
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

  // ─── 本机草稿（刷新/崩溃不丢字）────────────────────────────────────

  it("草稿的键由主进程按当前身份拼：另一个空间那一格读不到", async () => {
    const store = new MemoryNoteDocCacheStore();
    const { event } = await setup({ workspaceType: "personal", role: "owner", noteDocCache: store });
    // 先读过一次起点才有可挂的那一条（草稿不凭空建条目）。
    await handler(DESKTOP_IPC_CHANNELS.noteDocState)(event, { meta, noteId: NOTE_ID });

    const update = makeUpdate("draft");
    const saved = await handler(DESKTOP_IPC_CHANNELS.noteDocDraftSave)(event, { meta, noteId: NOTE_ID, update });
    expect(saved).toMatchObject({ ok: true, data: { saved: true } });

    // 界面只报了 noteId，三段键是这里按会话拼的。少了 workspaceId，另一个空间里同名的
    // 那一篇就能把这里的字复活过去——正是批次 1 立这条键要防的跨空间正文缝合。
    expect(await store.getDraft(cacheKey)).toMatchObject({ update });
    expect(await store.getDraft({ ...cacheKey, workspaceId: "44444444-4444-4444-8444-444444444444" })).toBeNull();
    expect(await store.getDraft({ ...cacheKey, subjectId: "88888888-8888-4888-8888-888888888888" })).toBeNull();

    const read = await handler(DESKTOP_IPC_CHANNELS.noteDocDraftGet)(event, { meta, noteId: NOTE_ID });
    expect(read).toMatchObject({ ok: true, data: { draft: { update } } });

    const cleared = await handler(DESKTOP_IPC_CHANNELS.noteDocDraftClear)(event, { meta, noteId: NOTE_ID });
    expect(cleared).toMatchObject({ ok: true, data: { cleared: true } });
    expect(await handler(DESKTOP_IPC_CHANNELS.noteDocDraftGet)(event, { meta, noteId: NOTE_ID }))
      .toMatchObject({ ok: true, data: { draft: null } });
    // 清草稿只清草稿：本机那份文档还在（下一句仍能读回正文的起点）。
    expect(await store.get(cacheKey)).not.toBeNull();
  });

  it("没有本机那一份文档时草稿不收：凭空造一条会让编辑器接一棵没有祖先的树", async () => {
    const store = new MemoryNoteDocCacheStore();
    const { event } = await setup({ workspaceType: "personal", role: "owner", noteDocCache: store });
    const saved = await handler(DESKTOP_IPC_CHANNELS.noteDocDraftSave)(event, {
      meta,
      noteId: NOTE_ID,
      update: makeUpdate("draft"),
    });
    expect(saved).toMatchObject({ ok: true, data: { saved: false } });
    expect(await store.get(cacheKey)).toBeNull();
  });
});
