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

function installApi() {
  listeners = [];
  subscribe = vi.fn(async () => ({ ok: true, data: { subscriptionId: "sub-1" } }));
  unsubscribe = vi.fn(async () => ({ ok: true, data: { closed: true } }));
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
  it("personal 空间不订阅：那里本来就没有长连接", async () => {
    const onRemoteChange = vi.fn();
    const { result } = renderHook(() => useNoteDocLiveView(NOTE_ID, false, onRemoteChange));
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(subscribe).not.toHaveBeenCalled();
    expect(result.current.presenceCount).toBe(0);
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

  it("presence 与只读态从帧里取，供界面说真话", async () => {
    const { result } = renderHook(() => useNoteDocLiveView(NOTE_ID, true, () => undefined));
    await act(async () => { vi.advanceTimersByTime(0); });

    act(() => {
      emit(frame(NOTE_ID, { type: "presence", states: [{ clientId: 7, state: { editing: true } }] }));
    });
    expect(result.current.presenceCount).toBe(1);

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
