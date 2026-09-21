import { useEffect, useRef, useState } from "react";
import type { NoteDocStreamEventV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { createRequestMeta } from "../../app/desktop-client";

/** 一帧远端正文之后等多久才去回读：连着敲会一帧一帧地来，逐帧刷新会把编辑区打回原形。 */
const RELOAD_DEBOUNCE_MS = 400;

/** 一个远端协作者。名字来自对端自己广播的 awareness 状态，不是查名册查出来的。 */
export type NoteDocPeer = {
  clientId: number;
  /** 对端没告诉自己是谁时为 null——界面落回一枚无名印章，不编一个名字出来。 */
  name: string | null;
};

export type NoteDocLiveView = {
  /** 谁还开着这一篇（不含自己）。人数就是这一排的长度，不再另存一个数——两个真相迟早会对不上。 */
  presencePeers: NoteDocPeer[];
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
  /**
   * 广播给同处这一篇的人看的名字。没有显示名时传 null：对端看到一枚无名印章，
   * 而不是被编一个名字，也不是整个人从人数里消失。
   */
  presenceName: string | null = null,
): NoteDocLiveView {
  const [state, setState] = useState<NoteDocLiveView>({ presencePeers: [], authorizedScope: null, failure: null });
  const changeRef = useRef(onRemoteChange);
  changeRef.current = onRemoteChange;

  useEffect(() => {
    const api = window.ailearn;
    if (!noteId || !enabled || !api) {
      setState({ presencePeers: [], authorizedScope: null, failure: null });
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
        const peers = event.states.map((peer) => ({
          clientId: peer.clientId,
          // awareness 状态是对端自己写的字符串，形状不归这里管：认不出的就无名，
          // 而不是整帧丢掉（丢掉会让头像凭空少一个人）。
          name: typeof peer.state.name === "string" && peer.state.name.trim() ? peer.state.name.trim() : null,
        }));
        setState((previous) => ({ ...previous, presencePeers: peers }));
        return;
      }
      setState((previous) => ({
        ...previous,
        ...(event.status === "failed" ? { failure: event.reason ?? "connection_lost" } : {}),
        ...(event.authorizedScope ? { authorizedScope: event.authorizedScope } : {}),
      }));
    };

    const publishPresence = (here: boolean) => {
      void api.note.doc.presence({
        meta: createRequestMeta(),
        noteId,
        // 空串 = 我离开了这一篇（主进程那一侧据此把 awareness 本地状态清掉）。
        // 没有显示名也照样报名字为空：不报的话这一行的人数会比头像多出一个来历不明的
        // 位置，而"有人在看却没名字"比"这个人凭空不算"更贴合事实。
        // 整条 JSON 远小于 awareness 的 2KB 上限；上限由主进程那条检查守着，这里不重复一套数。
        state: here ? JSON.stringify({ name: (presenceName ?? "").slice(0, 40) }) : "",
      }).catch(() => undefined);
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
        publishPresence(true);
      } catch {
        // 订阅不通只是看不到实时帧，正文本身仍由读路径保证。
      }
    };
    void subscribe();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribeEvent?.();
      publishPresence(false);
      if (subscriptionId) {
        void api.subscriptions.unsubscribe({ meta: createRequestMeta(), subscriptionId }).catch(() => undefined);
      }
    };
  }, [noteId, enabled, presenceName]);

  return state;
}
