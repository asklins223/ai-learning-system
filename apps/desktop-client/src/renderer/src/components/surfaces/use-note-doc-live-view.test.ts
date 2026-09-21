// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNoteDocLiveView } from "./use-note-doc-live-view";

const NOTE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "55555555-5555-5555-8555-555555555555";

type Listener = (event: { data: unknown }) => void;
let listeners: Listener[];
let subscribe: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;
let presence: ReturnType<typeof vi.fn>;

function installApi() {
  listeners = [];
  subscribe = vi.fn(async () => ({ ok: true, data: { subscriptionId: "sub-1" } }));
  unsubscribe = vi.fn(async () => ({ ok: true, data: { closed: true } }));
  presence = vi.fn(async () => ({ ok: true, data: { shared: true } }));
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
    note: { doc: { presence } },
  };
}

const emit = (data: unknown) => act(() => { for (const listener of listeners) listener({ data }); });

const frame = (noteId: string, event: Record<string, unknown>) => ({
  kind: "note_doc_event",
  noteId,
  event,
});

beforeEach(() => {
  vi.useFakeTimers();
  installApi();
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { ailearn?: unknown }).ailearn;
});

describe("笔记协同的实时视图订阅", () => {
  it("personal 空间不订阅，也不广播在场：那里本来就没有长连接", async () => {
    const onRemoteChange = vi.fn();
    const { result } = renderHook(() => useNoteDocLiveView(NOTE_ID, false, onRemoteChange, "Asklins"));
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(subscribe).not.toHaveBeenCalled();
    expect(presence).not.toHaveBeenCalled();
    expect(result.current.presencePeers).toEqual([]);
  });

  it("订阅上就报一次自己的名字；卸载时不报空（离场跟着连接走）", async () => {
    const { unmount } = renderHook(() => useNoteDocLiveView(NOTE_ID, true, () => undefined, "Asklins"));
    await act(async () => { vi.advanceTimersByTime(0); });
    // 名字是广播出去的，不是查名册查出来的：对端看到的必须是你自己报的那个。
    expect(presence).toHaveBeenCalledTimes(1);
    expect(presence).toHaveBeenLastCalledWith(expect.objectContaining({
      noteId: NOTE_ID,
      state: JSON.stringify({ name: "Asklins" }),
    }));
    unmount();
    await act(async () => { vi.advanceTimersByTime(0); });
    // 实测（2026-09-22，两个真客户端）：报空串不越过对端，关掉连接才会。而连接
    // 是不是该关，归主进程按订阅数判——这里再报一次只会在"另一个窗口还开着同一篇"
    // 时说出一句假话。
    expect(presence).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("没有显示名也照样在场：不报的话人数比头像多出一个来历不明的人", async () => {
    renderHook(() => useNoteDocLiveView(NOTE_ID, true, () => undefined, null));
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(presence).toHaveBeenLastCalledWith(expect.objectContaining({
      state: JSON.stringify({ name: "" }),
    }));
  });

  it("正文帧立刻留下那一份可画的内容，回读仍然照叫醒（帧比回读新）", async () => {
    const onRemoteChange = vi.fn();
    const { result } = renderHook(() => useNoteDocLiveView(NOTE_ID, true, onRemoteChange));
    await act(async () => { vi.advanceTimersByTime(0); });

    act(() => {
      emit(frame(NOTE_ID, {
        type: "blocks",
        blocks: [
          { ordinal: 0, type: "paragraph", content: "别人刚敲的那段" },
          // 客户端版本差一档时，认不出的块类型要落回段落，不能整块不画。
          { ordinal: 1, type: "callout", content: "这台机器还不认识的块" },
        ],
        title: "别人改的标题",
        titleSource: "auto",
      }));
    });
    // 帧一到就有：读的那一屏不必等回读，也不必等作者那次自动保存进 API。
    expect(result.current.remoteView).toEqual({
      blocks: [
        { ordinal: 0, type: "paragraph", content: "别人刚敲的那段" },
        { ordinal: 1, type: "paragraph", content: "这台机器还不认识的块" },
      ],
      title: "别人改的标题",
      titleSource: "auto",
    });
    // 回读仍然是叫醒的（版本号、时间、权限只能从服务端那份记录来）。
    expect(onRemoteChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(600); });
    expect(onRemoteChange).toHaveBeenCalledTimes(1);
  });

  it("换一篇时上一帧的正文不留在那一屏上", async () => {
    const { result, rerender } = renderHook(({ noteId }) => useNoteDocLiveView(noteId, true, () => undefined), {
      initialProps: { noteId: NOTE_ID },
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    act(() => {
      emit(frame(NOTE_ID, { type: "blocks", blocks: [{ ordinal: 0, type: "paragraph", content: "上一篇的" }], title: "上一篇", titleSource: "auto" }));
    });
    expect(result.current.remoteView?.title).toBe("上一篇");
    rerender({ noteId: OTHER_ID });
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(result.current.remoteView).toBeNull();
  });

  it("正文帧只叫醒一次回读：连着的三帧合并成一次", async () => {
    const onRemoteChange = vi.fn();
    renderHook(() => useNoteDocLiveView(NOTE_ID, true, onRemoteChange));
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0][0].topic).toEqual({ kind: "noteDoc", noteId: NOTE_ID });

    const blocks = { type: "blocks", blocks: [{ ordinal: 0, type: "paragraph", content: "别人写的" }], title: "标题", titleSource: "auto" };
    emit(frame(NOTE_ID, blocks));
    emit(frame(NOTE_ID, blocks));
    emit(frame(NOTE_ID, blocks));
    expect(onRemoteChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(600); });
    expect(onRemoteChange).toHaveBeenCalledTimes(1);
  });

  it("别篇笔记的帧不算数（切换笔记时旧流的尾帧不能刷新这一篇）", async () => {
    const onRemoteChange = vi.fn();
    renderHook(() => useNoteDocLiveView(NOTE_ID, true, onRemoteChange));
    await act(async () => { vi.advanceTimersByTime(0); });
    emit(frame(OTHER_ID, { type: "blocks", blocks: [], title: "", titleSource: "auto" }));
    act(() => { vi.advanceTimersByTime(600); });
    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it("在场名单从帧里取：报得出名字的带名字，报不出的留空而不是把那个人丢掉", async () => {
    const { result } = renderHook(() => useNoteDocLiveView(NOTE_ID, true, () => undefined));
    await act(async () => { vi.advanceTimersByTime(0); });

    act(() => {
      emit(frame(NOTE_ID, {
        type: "presence",
        states: [
          { clientId: 7, state: { name: " 小琳 " } },
          { clientId: 8, state: { editing: true } },
          { clientId: 9, state: "not-an-object" },
        ],
      }));
    });
    expect(result.current.presencePeers).toEqual([
      { clientId: 7, name: "小琳" },
      { clientId: 8, name: null },
      { clientId: 9, name: null },
    ]);

    act(() => {
      emit(frame(NOTE_ID, { type: "presence", states: [] }));
    });
    expect(result.current.presencePeers).toEqual([]);
  });

  it("只读态与失败原因从帧里取，供界面说真话", async () => {
    const { result } = renderHook(() => useNoteDocLiveView(NOTE_ID, true, () => undefined));
    await act(async () => { vi.advanceTimersByTime(0); });

    act(() => {
      emit(frame(NOTE_ID, { type: "status", status: "authenticated", authorizedScope: "readonly" }));
    });
    expect(result.current.authorizedScope).toBe("readonly");

    act(() => {
      emit(frame(NOTE_ID, { type: "status", status: "failed", reason: "oversize" }));
    });
    expect(result.current.failure).toBe("oversize");
  });

  it("卸载时退订", async () => {
    const { unmount } = renderHook(() => useNoteDocLiveView(NOTE_ID, true, () => undefined));
    await act(async () => { vi.advanceTimersByTime(0); });
    unmount();
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(unsubscribe).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.anything(),
      subscriptionId: "sub-1",
    }));
  });
});
