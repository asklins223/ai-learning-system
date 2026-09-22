// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { act, renderHook } from "@testing-library/react";
import { useNoteDocLiveView } from "./use-note-doc-live-view";

const NOTE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "55555555-5555-5555-8555-555555555555";

type Listener = (event: { data: unknown }) => void;
let listeners: Listener[];
let subscribe: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;
let presence: ReturnType<typeof vi.fn>;
let syncUpdate: ReturnType<typeof vi.fn>;
let state: ReturnType<typeof vi.fn>;

// 渲染层的类型环境没有 node 类型（运行时其实有），所以这里用 btoa，与被测代码同一条路。
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...Array.from(bytes)));

/** 一份带这两段的起点（正文是 `content` 这个 Y.XmlFragment，与两端同一形状）。 */
function seedUpdate(): string {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("content");
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText("第一段")]);
  fragment.insert(0, [paragraph]);
  doc.getMap("meta").set("title", "起点标题");
  doc.getMap("meta").set("titleSource", "auto");
  return b64(Y.encodeStateAsUpdate(doc));
}

/** 另一个人在远端写的一条增量：一段认得、一段是这台机器还不认识的块类型。 */
function peerUpdate(): string {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("content");
  const known = new Y.XmlElement("paragraph");
  known.insert(0, [new Y.XmlText("别人刚敲的那段")]);
  const unknown = new Y.XmlElement("callout");
  unknown.insert(0, [new Y.XmlText("这台机器还不认识的块")]);
  fragment.insert(0, [known, unknown]);
  doc.getMap("meta").set("title", "别人改的标题");
  return b64(Y.encodeStateAsUpdate(doc));
}

function installApi(seed = seedUpdate()) {
  listeners = [];
  subscribe = vi.fn(async () => ({ ok: true, data: { subscriptionId: "sub-1" } }));
  unsubscribe = vi.fn(async () => ({ ok: true, data: { closed: true } }));
  presence = vi.fn(async () => ({ ok: true, data: { shared: true } }));
  syncUpdate = vi.fn(async () => ({ ok: true, data: { via: "stream", revision: null, savedAt: "2026-09-22T00:00:00.000Z" } }));
  state = vi.fn(async () => ({ ok: true, data: { update: seed, revision: 3, backfilled: false, shareScope: "shared" } }));
  (window as unknown as { ailearn: unknown }).ailearn = {
    subscriptions: {
      subscribe,
      unsubscribe,
      onEvent: (_id: string, listener: Listener) => {
        listeners.push(listener);
        return () => {
          listeners = listeners.filter((entry) => entry !== listener);
        };
      },
    },
    note: { doc: { presence, state, syncUpdate } },
  };
  return { syncUpdate };
}

const settle = async () => { await act(async () => { vi.advanceTimersByTime(0); }); };
const emit = (data: unknown) => act(() => { for (const listener of listeners) listener({ data }); });
const frame = (noteId: string, event: Record<string, unknown>) => ({ kind: "note_doc_event", noteId, event });

beforeEach(() => { vi.useFakeTimers(); installApi(); });
afterEach(() => { vi.useRealTimers(); });

describe("渲染进程那份文档", () => {
  it("起点到了才交出 fragment，并画着文档里的正文", async () => {
    const { result } = renderHook(() => useNoteDocLiveView(NOTE_ID, true, () => undefined));
    await settle();
    expect(result.current.fragment).toBeTruthy();
    expect(result.current.blocks.map((block) => block.content)).toEqual(["第一段"]);
    expect(result.current.title).toBe("起点标题");
  });

  it("远端一条增量进来就有正文，认不出的块落回段落；回读合并成一次", async () => {
    const onRemoteChange = vi.fn();
    const { result } = renderHook(() => useNoteDocLiveView(NOTE_ID, true, onRemoteChange));
    await settle();
    act(() => { emit(frame(NOTE_ID, { type: "update", update: peerUpdate() })); });

    // 帧一到就有：读的那一屏不必等回读，也不必等作者那次自动保存进 API（实窗量到 3.5 秒）。
    // 起点那一块与这两块并存：CRDT 合并的是操作，不是"谁覆盖了谁"，所以这里问的是
    // 对端那两句都在、顺序由合并决定。
    const contents = result.current.blocks.map((block) => block.content);
    expect(contents).toContain("别人刚敲的那段");
    expect(contents).toContain("这台机器还不认识的块");
    expect(contents).toContain("第一段");
    // 认不出的那个块类型仍然画得出来，只是落回段落。
    expect(result.current.blocks.find((block) => block.content === "这台机器还不认识的块")?.type).toBe("paragraph");
    // 标题不在这里断言：两份副本都往 `meta.title` 写过，赢的那一份由 LWW 按 client id
    // 定，断言"对端的标题赢了"是抛硬币。标题本身的通路另有两条用例守着
    // （起点带进来的那一条，与改名 flush 的那一条）。
    expect(onRemoteChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(600); });
    expect(onRemoteChange).toHaveBeenCalledTimes(1);
  });

  it("本机打的那几个字算待提交；flush 交出去之后归零", async () => {
    const api = installApi();
    const { result } = renderHook(() => useNoteDocLiveView(NOTE_ID, true, () => undefined));
    await settle();
    expect(result.current.dirty).toBe(false);
    expect(await result.current.flush()).toBeNull();

    act(() => {
      const fragment = result.current.fragment!;
      ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(3, "本机补的字");
    });
    expect(result.current.dirty).toBe(true);
    expect(result.current.blocks[0].content).toContain("本机补的字");

    // flush 里有 setState：不在 act 里等它，`result.current` 还是渲染前那一份，
    // 于是"dirty 归零"会红在读不到上，而不是产品没更新。
    let via: string | null = null;
    await act(async () => { via = await result.current.flush(); });
    expect(via).toBe("stream");
    expect(api.syncUpdate).toHaveBeenCalledTimes(1);
    // 交出去的那条必须是**增量**而不是整篇：载荷里不该有起点里那几个字的完整快照。
    const sent = api.syncUpdate.mock.calls[0]![0] as { update: string; commandId: string };
    expect(sent.update.length).toBeLessThan(300);
    // 命令号要过得了 IPC 边界那把尺（`commandIdSchema` 是不带冒号的 opaque id）。
    // 真窗口里踩过：自己拼 `note-doc:<uuid>:<ts>` 被整条拒成 invalid_request，而渲染层
    // 把"被拒"读成"什么都没改"，于是屏上永远是一个下不来的「草稿」。
    expect(sent.commandId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(result.current.dirty).toBe(false);
  });

  it("主进程拒收那一次时要喊出来，不许读成「这台机器什么都没改」", async () => {
    installApi();
    // 装完之后再把那一个口换掉：钩子是在要交的那一刻从 `window.ailearn` 上取的，
    // 只改外面那个变量改不动已经装上去的那一份。
    const refused = vi.fn(async () => ({
      ok: false as const,
      error: { code: "invalid_request" as const, safeMessageKey: "error.invalid_request", retry: "never" as const },
    }));
    ((window as unknown as { ailearn: { note: { doc: { syncUpdate: unknown } } } }).ailearn.note.doc).syncUpdate = refused;
    const { result } = renderHook(() => useNoteDocLiveView(NOTE_ID, true, () => undefined));
    await settle();
    act(() => {
      const fragment = result.current.fragment!;
      ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(3, "被拒的那一次");
    });
    await expect(result.current.flush()).rejects.toThrow();
    // 被拒的这批必须留着：下一次按键还要能再交一次，清了就是那几句话凭空没了。
    expect(result.current.dirty).toBe(true);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("换一篇：上一篇的正文与文档都不留在这一屏上", async () => {
    installApi();
    const { result, rerender } = renderHook(({ noteId }) => useNoteDocLiveView(noteId, true, () => undefined), {
      initialProps: { noteId: NOTE_ID },
    });
    await settle();
    act(() => { emit(frame(NOTE_ID, { type: "update", update: peerUpdate() })); });
    expect(result.current.blocks.map((block) => block.content)).toContain("别人刚敲的那段");

    rerender({ noteId: OTHER_ID });
    await settle();
    // 上一篇那两句一个字都不该留下；这一篇自己的起点（"第一段"）当然要画。
    const after = result.current.blocks.map((block) => block.content);
    expect(after).not.toContain("别人刚敲的那段");
    expect(after).not.toContain("这台机器还不认识的块");
    expect(after).toEqual(["第一段"]);
    expect(result.current.dirty).toBe(false);
  });

  it("noteId 短暂为空（保存后那次回读就会这样）不许把没交出去的字一起清掉", async () => {
    installApi();
    const { result, rerender } = renderHook(({ noteId }: { noteId: string | null }) =>
      useNoteDocLiveView(noteId, true, () => undefined), {
      initialProps: { noteId: NOTE_ID as string | null },
    });
    await settle();
    act(() => {
      const fragment = result.current.fragment!;
      ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(3, "刚敲还没交出去的字");
    });
    expect(result.current.dirty).toBe(true);

    rerender({ noteId: null });
    await settle();
    // 这一屏只是在重新读取，不是换了一篇：字和"还没交出去"这两件事都得活着。
    // 少这一条的症状是实窗量到的"刚写的几句在自动保存之后凭空没了"。
    expect(result.current.dirty).toBe(true);
    expect(result.current.blocks[0]?.content).toContain("刚敲还没交出去的字");

    rerender({ noteId: NOTE_ID });
    await settle();
    expect(result.current.blocks[0]?.content).toContain("刚敲还没交出去的字");
    // 回来之后还要交得出去：`pendingRef` 被清过的话这里 flush 出的是 null。
    let via: string | null = null;
    await act(async () => { via = await result.current.flush(); });
    expect(via).toBe("stream");
  });

  it("订阅回执比连接早时，名字照旧广播得出去；在场人数只认这一排", async () => {
    const { result } = renderHook(() => useNoteDocLiveView(NOTE_ID, true, () => undefined, null));
    await settle();
    act(() => {
      emit(frame(NOTE_ID, { type: "presence", states: [{ clientId: 7, state: { name: "小林" } }, { clientId: 8, state: {} }] }));
    });
    expect(result.current.presencePeers).toEqual([{ clientId: 7, name: "小林" }, { clientId: 8, name: null }]);
  });

  it("personal 空间不订阅：那一格本来就没有长连接", async () => {
    renderHook(() => useNoteDocLiveView(NOTE_ID, false, () => undefined));
    await settle();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
