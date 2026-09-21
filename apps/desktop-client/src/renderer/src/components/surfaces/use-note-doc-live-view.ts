import { useEffect, useRef, useState } from "react";
import type { NoteDocStreamEventV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { noteBlockTypeV1Schema, type NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import { createRequestMeta } from "../../app/desktop-client";

/** 一帧远端正文之后等多久才去回读：连着敲会一帧一帧地来，逐帧刷新会把编辑区打回原形。 */
const RELOAD_DEBOUNCE_MS = 400;

const projectableBlockTypes = new Set<string>(noteBlockTypeV1Schema.options);

/**
 * 帧里的块 → 读投影的块。认不出的类型**当段落画**而不是丢掉那块：那边可能只是
 * 比这台机器新的一版客户端 added 了一种块，把人家写的字因为一个标签没认出来而
 * 不画，是最坏的一种"保守"。
 */
function toProjectedBlocks(blocks: readonly { ordinal: number; type: string; content: string }[]): NoteBlockProjectionV1[] {
  return blocks.map((block) => ({
    ordinal: block.ordinal,
    type: projectableBlockTypes.has(block.type) ? block.type as NoteBlockProjectionV1["type"] : "paragraph",
    content: block.content,
  }));
}

/** 一个远端协作者。名字来自对端自己广播的 awareness 状态，不是查名册查出来的。 */
export type NoteDocPeer = {
  clientId: number;
  /** 对端没告诉自己是谁时为 null——界面落回一枚无名印章，不编一个名字出来。 */
  name: string | null;
};

/** 帧里那份正文：块形状与读投影一致，界面可以直接画。 */
export type NoteDocRemoteView = {
  blocks: NoteBlockProjectionV1[];
  title: string;
  titleSource: string;
};

export type NoteDocLiveView = {
  /** 谁还开着这一篇（不含自己）。人数就是这一排的长度，不再另存一个数——两个真相迟早会对不上。 */
  presencePeers: NoteDocPeer[];
  /**
   * 最近一帧的正文，`null` = 这一次运行还没收到过别人的改动。
   *
   * 为什么界面要拿它：实窗量过（2026-09-22，两个真窗口）自动保存落在本机 debounce
   * 之后（作者敲完 **3.5 秒** 才进 API），而这一帧是改动一进活文档就发出来的——
   * 也就是说帧比服务端那条 HTTP 读**新**。原来只把帧当"叫醒一次回读"的信号，回读
   * 读到的是还没刷新的那一份，于是读的人看到的是上一次的正文，而且没有第二帧来纠它。
   * 阅读态没有本地未提交内容，这一份就是能画出来的最新一份。
   */
  remoteView: NoteDocRemoteView | null;
  /** 服务端给的读写范围；`null` = 还没有状态帧（personal 空间本来就不会有）。 */
  authorizedScope: "read-write" | "readonly" | null;
  /** 连接被拒/超帧等失败原因；非空时界面该说"这次看不到别人的改动"。 */
  failure: string | null;
};

/**
 * 订阅一篇笔记的协同流（批次 4.4）。两件事，别混成一件：
 *
 * 1. **把最近一帧的正文交给界面**（`remoteView`）。阅读态手上没有未提交的东西，
 *    这一帧就是能画出来的最新一份——它比"叫醒一次 HTTP 回读"新，因为回读要等
 *    作者那台机器把自动保存发出去、再等服务端把活文档刷进投影（实窗量到 3.5 秒）。
 * 2. **仍然叫醒一次回读**。回读拿的是服务端那份记录：版本号、时间、权限、来源片段
 *    这些只能从它来；而编辑器里如果有作者还没交出去的字，替换与否仍由既有那条
 *    回读效应判（那是自动保存那条路径上反复验证过的守卫），界面不另开一条写编辑器的路。
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
  const [state, setState] = useState<NoteDocLiveView>({ presencePeers: [], remoteView: null, authorizedScope: null, failure: null });
  const changeRef = useRef(onRemoteChange);
  changeRef.current = onRemoteChange;
  // 换了一篇就在**这一次渲染里**把上一帧丢掉，不等副作用跑完：读的那一屏现在是直接画
  // `remoteView` 的，留一帧的功夫就会把上一篇的正文印在下一篇上（实测这条能红）。
  const targetRef = useRef<string | null>(noteId);
  if (targetRef.current !== noteId) {
    targetRef.current = noteId;
    setState({ presencePeers: [], remoteView: null, authorizedScope: null, failure: null });
  }

  useEffect(() => {
    const api = window.ailearn;
    if (!noteId || !enabled || !api) {
      setState({ presencePeers: [], remoteView: null, authorizedScope: null, failure: null });
      return undefined;
    }
    let disposed = false;
    let subscriptionId: string | null = null;
    let unsubscribeEvent: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handle = (event: NoteDocStreamEventV1) => {
      if (disposed) return;
      if (event.type === "blocks") {
        // 先留下这一帧，再叫醒回读：顺序反了的话，回读那一下若比帧慢（服务端还在
        // debounce 里），界面上就是一句"刷新过了"却还画着旧正文。
        setState((previous) => ({
          ...previous,
          remoteView: {
            blocks: toProjectedBlocks(event.blocks),
            title: event.title,
            titleSource: event.titleSource,
          },
        }));
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

    const publishPresence = () => {
      void api.note.doc.presence({
        meta: createRequestMeta(),
        noteId,
        // 没有显示名也照样报名字为空：不报的话这一行的人数会比头像多出一个来历不明的
        // 位置，而"有人在看却没名字"比"这个人凭空不算"更贴合事实。
        // 整条 JSON 远小于 awareness 的 2KB 上限；上限由主进程那条检查守着，这里不重复一套数。
        state: JSON.stringify({ name: (presenceName ?? "").slice(0, 40) }),
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
        publishPresence();
      } catch {
        // 订阅不通只是看不到实时帧，正文本身仍由读路径保证。
      }
    };
    void subscribe();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribeEvent?.();
      // 离场不在这里报。实测（2026-09-22，两个真客户端）：把本机 awareness 报成空串
      // 并不会传到对端——那一排头像要等这条连接关掉才会少掉一个人。而连接的生死归
      // 主进程按订阅数管：这是最后一个订阅时，退订就把连接关了，对端随即看到我离开；
      // 还有别的窗口开着同一篇时，我确实还开着，报空反而是假话。
      if (subscriptionId) {
        void api.subscriptions.unsubscribe({ meta: createRequestMeta(), subscriptionId }).catch(() => undefined);
      }
    };
  }, [noteId, enabled, presenceName]);

  return state;
}
