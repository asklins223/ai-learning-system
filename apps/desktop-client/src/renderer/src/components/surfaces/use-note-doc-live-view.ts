import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { pmNodesToNoteBlocks } from "@ailearn/shared/note-doc-schema";
import type { NoteDocStreamEventV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { noteBlockTypeV1Schema, type NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import { createRequestMeta } from "../../app/desktop-client";

/**
 * 一篇笔记在**渲染进程**里的那份共享文档（批次 C2）。
 *
 * 为什么文档挪到这里：ProseMirror 的同步插件必须活在有 view 的那一侧，而 view 在这里。
 * 它不在这里时的样子是——界面持有一份 Markdown 字符串、交给主进程去差分，那份字符串
 * 落后于文档时，差分就把对端刚写进来的字算成"我删掉了"（两个真窗口实测过，批次 A 的
 * 对照用例把它钉成了红）。现在编辑器写的就是这份文档本身，界面不再持有拷贝，
 * 也就没有"拷贝落后"这件事。
 *
 * 主进程仍然要一份（provider 得有个 `Y.Doc` 才发得出去、断线时要地方攒、重启时要接回来），
 * 但它那份是**影子**：两侧靠不透明的 yjs 增量互相同步，谁都不是谁的视图。
 *
 * 判"这条是不是本机写的"用 origin：远端帧以 `REMOTE_ORIGIN` 应用，其余（编辑器的事务、
 * 这里写的标题）都算本机。判反的后果不对称——把别人的当成自己的，就会原样发回去（回声）。
 */

const FRAGMENT_KEY = "content";
const REMOTE_ORIGIN = "remote";
/** 连着几帧会一帧一帧地来，逐帧回读会把编辑区打回原形，所以合并成一次。 */
const RELOAD_DEBOUNCE_MS = 400;

// 渲染进程没有 `Buffer`（那是主进程那一侧的类型环境），所以自己走 btoa/atob。
const b64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const unB64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** base64 要"编回去一模一样"才收：`Buffer.from(_, "base64")` 会静默吃掉非法字符，留下半条更新。 */
function decodeUpdate(text: string): Uint8Array | null {
  const bytes = unB64(text);
  return b64(bytes) === text ? bytes : null;
}

const projectableBlockTypes = new Set<string>(noteBlockTypeV1Schema.options);

/**
 * 文档 → 读投影的块。认不出的类型**当段落画**而不是丢掉那块：那可能只是这份文档里有
 * 对端那一版客户端新增的块类型，因为一个标签没认出来就不画人家写的字，是最坏的一种"保守"。
 */
function projectBlocks(doc: Y.Doc): NoteBlockProjectionV1[] {
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(FRAGMENT_KEY)) as { content?: unknown[] };
  return pmNodesToNoteBlocks((json.content ?? []) as never).map((block, ordinal) => ({
    ordinal,
    type: projectableBlockTypes.has(block.type) ? block.type as NoteBlockProjectionV1["type"] : "paragraph",
    content: block.content,
  }));
}

/** 一个远端协作者。名字来自对端自己广播的 awareness 状态，不是查名册查出来的。 */
export type NoteDocPeer = { clientId: number; name: string | null };

export type NoteDocLiveView = {
  /** 谁还开着这一篇（不含自己）。人数就是这一排的长度，不再另存一个数——两个真相迟早对不上。 */
  presencePeers: NoteDocPeer[];
  /** 服务端给的读写范围；`null` = 还没有状态帧（personal 空间本来就不会有）。 */
  authorizedScope: "read-write" | "readonly" | null;
  /** 连接被拒/超帧等失败原因；非空时界面该说"这次看不到别人的改动"。 */
  failure: string | null;
  /** 本机有没有还没交出去的改动。判据是"攒着没发的增量条数"，不是界面自己猜。 */
  dirty: boolean;
  /**
   * 文档此刻的正文（含本机没交出去的部分）。阅读态画的就是这一份——它比 HTTP 回读新，
   * 因为回读要等作者那台机器把自动保存发出去、再等服务端刷进投影（实窗量到 3.5 秒）。
   */
  blocks: NoteBlockProjectionV1[];
  title: string;
  titleSource: string;
  /** 编辑器绑的那个 fragment；`null` = 还没拿到起点，编辑器该等而不是先画一份自己的。 */
  fragment: Y.XmlFragment | null;
  /** 屏幕上写的标题落进文档的 `meta`（标题只有一个事实源，不再另开一条通道）。 */
  setLocalTitle: (title: string, titleSource: "auto" | "manual") => void;
  /** 交出本机攒下的增量；没有可交的就返回 null，界面据此报"未改动"而不是"同步中"。 */
  flush: () => Promise<"stream" | "uploaded" | "queued" | "unchanged" | null>;
};

export function useNoteDocLiveView(
  noteId: string | null,
  /** 只有协作空间才可能有流：personal 不建连（决定 7b），订阅它只是白占一条订阅。 */
  enabled: boolean,
  /** 别人改了字要不要叫醒一次回读：版本、权限、来源片段只能从那次回读拿。 */
  onRemoteChange: () => void,
  /** 广播给同处这一篇的人看的名字；没有显示名时传 null（对端看到一枚无名印章，不编名字）。 */
  presenceName: string | null = null,
  /** 主进程按 epoch 拒收过期请求，所以这里必须带着它、并跟着回执更新。 */
  epochRef?: { current: number | undefined },
): NoteDocLiveView {
  const docRef = useRef<Y.Doc | null>(null);

  const [stream, setStream] = useState<{ peers: NoteDocPeer[]; authorizedScope: "read-write" | "readonly" | null; failure: string | null }>({ peers: [], authorizedScope: null, failure: null });
  const [revision, setRevision] = useState(0);
  const [seeded, setSeeded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const pendingRef = useRef<string[]>([]);
  const changeRef = useRef(onRemoteChange);
  changeRef.current = onRemoteChange;

  const targetRef = useRef<string | null>(noteId);
  if (noteId !== null && targetRef.current !== noteId) {
    // 只有"真的换了一篇"才丢掉这份文档。`noteId` 短暂为空是这一屏在重新读取
    // （保存之后那次回读就会这样），不是换篇——跟着一起清会把**本机还没交出去的字**
    // 也清掉，症状是刚敲的几句在每次自动保存之后凭空没了（实窗量到过一次）。
    const switching = targetRef.current !== null;
    targetRef.current = noteId;
    if (switching) {
      // 先丢再建：反过来的话这一次渲染里"新的那一篇"仍然读到上一篇的正文，那一屏
      // 会把上一篇印在下一篇上（这条被用例抓到过一次，症状就是换篇后块数不减）。
      docRef.current?.destroy();
      docRef.current = null;
      pendingRef.current = [];
      setDirty(false);
      setSeeded(false);
      setStream({ peers: [], authorizedScope: null, failure: null });
    }
  }

  const doc = docRef.current ?? (() => {
    const created = new Y.Doc();
    created.getMap("meta");
    created.getXmlFragment(FRAGMENT_KEY);
    docRef.current = created;
    return created;
  })();


  const meta = () => createRequestMeta(epochRef?.current ?? undefined);

  useEffect(() => {
    const record = (update: Uint8Array, origin: unknown): void => {
      if (origin === REMOTE_ORIGIN) return;
      // 建共享类型时 yjs 也会发一条**零长度**的 update：那不是改动，记上就会让
      // "打开一篇没动过"的笔记一进门就显示未提交，并白上一次送。
      if (update.length === 0) return;
      pendingRef.current.push(b64(update));
      // 本地改动也要推进那份投影的"版本号"：只靠 `setDirty(true)` 会漏——一次保存里
      // `setLocalTitle` 刚把它置真，`flush` 立刻又置假，React 批量之后状态值没变，
      // 一次渲染都不发生，投影 memo 于是交出**改写之前**的旧标题（实测量到的正是
      // "标题交出去了，屏幕却又回到别人那一份"）。
      setRevision((value) => value + 1);
      setDirty(true);
    };
    doc.on("update", record);
    return () => { doc.off("update", record); };
  }, [doc]);

  // 起点：主进程给的那份编码。它已经把本机存着、还没送出去的编辑合并进去了，
  // 所以离线改过的字在这里是"接着改"，不是"被服务端那份覆盖"。
  useEffect(() => {
    const api = window.ailearn;
    if (!noteId || !api) return undefined;
    // 协同口不在（旧的主进程配新的渲染层、或契约降级）时退回"只看回读的那一份"，
    // 而不是让整篇笔记打不开：桌面端没有 HMR，两边版本不齐是现实状态，不是假想。
    const docApi = api.note?.doc;
    if (!docApi?.state) return undefined;
    let disposed = false;
    void docApi.state({ meta: meta(), noteId })
      .then((response) => {
        if (disposed || !response.ok) return;
        const bytes = decodeUpdate(response.data.update);
        if (bytes) Y.applyUpdate(doc, bytes, REMOTE_ORIGIN);
        if (response.workspaceEpoch && epochRef) epochRef.current = response.workspaceEpoch;
        setSeeded(true);
        setRevision((value) => value + 1);
      })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [doc, noteId]);

  useEffect(() => {
    const api = window.ailearn;
    if (!noteId || !enabled || !api) return undefined;
    let disposed = false;
    let subscriptionId: string | null = null;
    let unsubscribeEvent: (() => void) | undefined;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    const handle = (event: NoteDocStreamEventV1): void => {
      if (disposed) return;
      if (event.type === "update") {
        const bytes = decodeUpdate(event.update);
        // 解不开就是这一帧不该动这份文档：半条更新 apply 进去比不 apply 更坏。
        if (!bytes) return;
        Y.applyUpdate(doc, bytes, REMOTE_ORIGIN);
        setRevision((value) => value + 1);
        // 仍然叫醒一次回读：帧给的是正文，版本号、权限、来源片段只能从服务端那条记录拿。
        // 但只叫醒一次——连着的帧合并成一次回读（原来那 400ms 就是这么来的）。
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { reloadTimer = null; changeRef.current(); }, RELOAD_DEBOUNCE_MS);
        return;
      }
      if (event.type === "presence") {
        setStream((previous) => ({
          ...previous,
          peers: event.states.map((peer) => ({
            clientId: peer.clientId,
            // awareness 状态是对端自己写的，形状不归这里管：认不出的就无名，
            // 而不是整帧丢掉（丢掉会让头像凭空少一个人）。
            name: typeof peer.state.name === "string" && peer.state.name.trim() ? peer.state.name.trim() : null,
          })),
        }));
        return;
      }
      setStream((previous) => ({
        peers: previous.peers,
        failure: event.status === "failed" ? event.reason ?? "connection_lost" : previous.failure,
        authorizedScope: event.authorizedScope ?? previous.authorizedScope,
      }));
    };

    const subscribe = async (): Promise<void> => {
      try {
        const response = await api.subscriptions.subscribe({ meta: meta(), topic: { kind: "noteDoc", noteId } });
        if (disposed || !response.ok) return;
        subscriptionId = response.data.subscriptionId;
        unsubscribeEvent = api.subscriptions.onEvent(subscriptionId, (frame) => {
          const payload = frame.data;
          if (payload.kind !== "note_doc_event" || payload.noteId !== noteId) return;
          handle(payload.event);
        });
        // 没有显示名也照样报名字为空：不报的话这一行的人数会比头像多出一个来历不明的位置。
        void api.note.doc.presence({ meta: meta(), noteId, state: JSON.stringify({ name: (presenceName ?? "").slice(0, 40) }) }).catch(() => undefined);
      } catch {
        // 订阅不通只是看不到实时帧，正文本身仍由读路径保证。
      }
    };
    void subscribe();

    return () => {
      disposed = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      unsubscribeEvent?.();
      // 离场不在这里报。实测（两个真客户端）：把本机 awareness 报成空串并不会传到对端——
      // 那一排头像要等这条连接关掉才少一个人。而连接的生死归主进程按订阅数管。
      if (subscriptionId) {
        void api.subscriptions.unsubscribe({ meta: meta(), subscriptionId }).catch(() => undefined);
      }
    };
  }, [doc, enabled, noteId, presenceName]);

  const flush = useCallback(async (): Promise<"stream" | "uploaded" | "queued" | "unchanged" | null> => {
    const api = window.ailearn;
    if (!api || !noteId || !api.note?.doc?.syncUpdate || pendingRef.current.length === 0) return null;
    const merged = Y.mergeUpdates(pendingRef.current.map((item) => unB64(item)));
    const submitted = await api.note.doc.syncUpdate({
      meta: createRequestMeta(epochRef?.current ?? undefined),
      commandId: `note-doc:${noteId}:${Date.now()}`,
      noteId,
      update: b64(merged),
    });
    if (submitted.workspaceEpoch && epochRef) epochRef.current = submitted.workspaceEpoch;
    const written = submitted.ok ? submitted.data.via : null;
    // queued 要留着这一批：没网时它们是"改完还没交出去"的全部内容，清了就是丢掉。
    if (written && written !== "queued") {
      pendingRef.current = [];
      setDirty(false);
    }
    return written;
  }, [noteId]);

  const setLocalTitle = useCallback((title: string, titleSource: "auto" | "manual"): void => {
    const map = doc.getMap<unknown>("meta");
    // 先比再写：`Y.Map.set` 对相同值也记一次操作，于是"名字没改"会白上一次送。
    if (map.get("title") === title && map.get("titleSource") === titleSource) return;
    doc.transact(() => {
      map.set("title", title);
      map.set("titleSource", titleSource);
    });
  }, [doc]);

  const projection = useMemo(() => ({
    blocks: projectBlocks(doc),
    title: String(doc.getMap<unknown>("meta").get("title") ?? ""),
    titleSource: String(doc.getMap<unknown>("meta").get("titleSource") ?? "auto"),
    // 起点没到之前不给编辑器绑：先画一份自己的再合，就又回到"两份内容谁覆盖谁"。
    fragment: seeded ? doc.getXmlFragment(FRAGMENT_KEY) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [doc, seeded, revision, dirty]);

  return {
    presencePeers: stream.peers,
    authorizedScope: stream.authorizedScope,
    failure: stream.failure,
    dirty,
    flush,
    setLocalTitle,
    ...projection,
  };
}
