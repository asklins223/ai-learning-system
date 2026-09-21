import { useEffect, useRef, useState } from "react";
import type { NoteDocStreamEventV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { createRequestMeta } from "../../app/desktop-client";

/** 一帧远端正文之后等多久才去回读：连着敲会一帧一帧地来，逐帧刷新会把编辑区打回原形。 */
const RELOAD_DEBOUNCE_MS = 400;

export type NoteDocLiveView = {
  /** 同一篇笔记上还有几个人在写（含只读观看者按服务端判定，这里只数 presence）。 */
  presenceCount: number;
  /** 服务端给的读写范围；`null` = 还没有状态帧（personal 空间本来就不会有）。 */
  authorizedScope: "read-write" | "readonly" | null;
  /** 连接被拒/超帧等失败原因；非空时界面该说"这次看不到别人的改动"。 */
  failure: string | null;
};

/**
 * 订阅一篇笔记的协同流，把"别人改了"变成一个回读动作（批次 4.4）。
 *
 * 为什么不把帧里的 blocks 直接写进编辑器：`reload()` 之后走的是既有那条回读效应，
 * 它已经带着"作者手上有未提交的改动时不替换正文"的判断（那是自动保存那条路径上
 * 反复验证过的守卫）。新帧另开一条写入编辑器的路，等于把同一个判断写第二遍，
 * 两遍迟早不一致 —— 而这里丢掉一次刷新只是少看一眼，写错一次是丢字。
 *
 * 流是渐进增强：订阅失败不报错、不重试，回读与切换页面仍会拿到最新内容。
 */
export function useNoteDocLiveView(
  noteId: string | null,
  /** 只有协作空间才可能有流：personal 不建连（决定 7b），订阅它只是白占一条订阅。 */
  enabled: boolean,
  onRemoteChange: () => void,
): NoteDocLiveView {
  const [state, setState] = useState<NoteDocLiveView>({ presenceCount: 0, authorizedScope: null, failure: null });
  const changeRef = useRef(onRemoteChange);
  changeRef.current = onRemoteChange;

  useEffect(() => {
    const api = window.ailearn;
    if (!noteId || !enabled || !api) {
      setState({ presenceCount: 0, authorizedScope: null, failure: null });
      return undefined;
    }
    let disposed = false;
    let subscriptionId: string | null = null;
    let unsubscribeEvent: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handle = (event: NoteDocStreamEventV1) => {
      if (disposed) return;
      if (event.type === "blocks") {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; changeRef.current(); }, RELOAD_DEBOUNCE_MS);
        return;
      }
      if (event.type === "presence") {
        setState((previous) => ({ ...previous, presenceCount: event.states.length }));
        return;
      }
      setState((previous) => ({
        ...previous,
        ...(event.status === "failed" ? { failure: event.reason ?? "connection_lost" } : {}),
        ...(event.authorizedScope ? { authorizedScope: event.authorizedScope } : {}),
      }));
    };

    const subscribe = async () => {
      try {
        const response = await api.subscriptions.subscribe({
          meta: createRequestMeta(),
          topic: { kind: "noteDoc", noteId },
        });
        if (disposed || !response.ok) return;
        subscriptionId = response.data.subscriptionId;
        unsubscribeEvent = api.subscriptions.onEvent(subscriptionId, (frame) => {
          // 信封里已经是判别联合：先看 kind 再看 noteId，不需要任何 cast。
          const payload = frame.data;
          if (payload.kind !== "note_doc_event" || payload.noteId !== noteId) return;
          handle(payload.event);
        });
      } catch {
        // 订阅不通只是看不到实时帧，正文本身仍由读路径保证。
      }
    };
    void subscribe();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribeEvent?.();
      if (subscriptionId) {
        void api.subscriptions.unsubscribe({ meta: createRequestMeta(), subscriptionId }).catch(() => undefined);
      }
    };
  }, [noteId, enabled]);

  return state;
}
