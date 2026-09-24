import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { pmNodesToNoteBlocks } from "@ailearn/shared/note-doc-schema";
import type { NoteDocStreamEventV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { noteBlockTypeV1Schema, type NoteBlockProjectionV1 } from "@ailearn/shared/note-projection-contracts";
import { createCommandId, createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";

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
/**
 * 草稿并回文档时用的来源标签。它必须**不是** `REMOTE_ORIGIN`：那份草稿是"我上次敲的、
 * 还没交出去的"，并进来之后要能重新变成待提交的增量（见下面 `record` 里那条判据），
 * 否则恢复出来的字只是画在屏幕上，永远交不上去。
 */
const DRAFT_ORIGIN = "draft";
/** 连着几帧会一帧一帧地来，逐帧回读会把编辑区打回原形，所以合并成一次。 */
const RELOAD_DEBOUNCE_MS = 400;
/**
 * 草稿落盘的节拍，比自动保存（界面那 1.2 秒）**快一半**：自动保存要等一次往返，而草稿
 * 要挡的正是"往返还没回来就刷新/崩溃"那一段，比它慢就等于没做。与自动保存同一种节拍
 * ——停笔才写，不是每次按键。
 */
const DRAFT_SAVE_DEBOUNCE_MS = 600;

// 渲染进程没有 `Buffer`（那是主进程那一侧的类型环境），所以自己走 btoa/atob。
/**
 * 逐字节 `binary += String.fromCharCode(byte)` 每加一字节都要重造一遍整条字符串，
 * 长度上是 **O(n²)**；而 `b64` 是**每个本地更新**（每个按键的事务）和 `decodeUpdate`
 * 校验每个远端帧都要走的。分块 `apply` 之后总代价变成线性，32768 是 spread 参数上限内
 * 的标准安全块。同样的形状在 `run-voice-input.tsx` / `use-companion-voice-input.ts`
 * 里早就用了，这里只是没跟上。
 */
const B64_CHUNK = 0x8000;
const b64 = (bytes: Uint8Array): string => {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += B64_CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + B64_CHUNK)));
  }
  return btoa(parts.join(""));
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

/**
 * 这份草稿里有没有当前文档还不知道的操作。有 = 它比屏幕上这一份新，要接回来。
 *
 * 判据是**状态向量**，不是时间戳：草稿那份时间来自本机、屏幕这一份来自服务端，比大小
 * 只会在两边时钟偏了的时候判反，而判反的两种后果都不小（把旧草稿接回来 = 凭空复活；
 * 把新草稿当旧的丢掉 = 用户敲的字没了）。yjs 的时钟是每个客户端一条单调计数，状态向量
 * 能精确回答"草稿里这些操作我是不是都有了"，与墙上时间无关。
 *
 * 草稿自己的状态向量从**增量本身**读（`encodeStateVectorFromUpdate`），不把它 apply 到
 * 一份空文档上再问：增量引用的结构在那份起点里，空文档上 apply 会因为缺依赖被挂起，
 * 于是每一份草稿都被判成"什么都没有"——这个功能会静默失效（这条正是用例抓出来的）。
 *
 * 于是"提交成功、只是清草稿那一步没走完"的那一份在这里正好被判成旧的：不恢复，顺手
 * 清掉——否则每次打开这篇都会说一句"恢复了草稿"，而它其实已经在服务端了。
 */
function draftAddsAnything(doc: Y.Doc, update: Uint8Array): boolean {
  try {
    const known = Y.decodeStateVector(Y.encodeStateVector(doc));
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update))) {
      if ((known.get(client) ?? 0) < clock) return true;
    }
    return false;
  } catch {
    // 解不开的一份草稿当"没有"：半条更新并进文档比丢掉它更坏。
    return false;
  }
}

const projectableBlockTypes = new Set<string>(noteBlockTypeV1Schema.options);

/**
 * 文档 → 读投影的块。认不出的类型**当段落画**而不是丢掉那块：那可能只是这份文档里有
 * 对端那一版客户端新增的块类型，因为一个标签没认出来就不画人家写的字，是最坏的一种"保守"。
 *
 * 单独导出是为了让跨进程向量的对拍用例能跑到**这一条**解码路径本身（编辑器那一侧与
 * 服务端那一侧各解一遍同一串字节），而不是在测试里抄一份。
 */
export function projectBlocks(doc: Y.Doc): NoteBlockProjectionV1[] {
  const json = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(FRAGMENT_KEY)) as { content?: unknown[] };
  return pmNodesToNoteBlocks((json.content ?? []) as never).map((block, ordinal) => ({
    ordinal,
    type: projectableBlockTypes.has(block.type) ? block.type as NoteBlockProjectionV1["type"] : "paragraph",
    content: block.content,
  }));
}

/**
 * 一个远端协作者。名字与"他在改第几块"都来自对端自己广播的 awareness 状态，
 * 不是查名册查出来的，也不是本机替他猜的。
 */
export type NoteDocPeer = { clientId: number; name: string | null; block: number | null };

/**
 * awareness 那一份状态只有一个形状：名字 + 当前光标所在的块（`null` = 不在任何块里）。
 * 报块是为了"别人也在写这一段"这句话有出处——它必须是一句文字，不能只靠颜色，
 * 也必须是**对端自己说的**，否则界面会在别人早就离开之后还挂着那个提示。
 */
const presenceState = (name: string | null, block: number | null): string =>
  JSON.stringify({ name: (name ?? "").slice(0, 40), block });

/** 对端的形状不归这里管：认不出的就当没有，而不是整帧丢掉（丢了会凭空少一个人）。 */
function peerBlock(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

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
   * 上一次没交出去的那几个字接回来了（非空 = 已经并进这份文档，且写进本机的那一份
   * 时间是这个）。界面据此说一句"草稿已恢复"；确认交出去之后它自己变回 `null`。
   */
  restoredDraft: { savedAt: string } | null;
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
  /** 本机光标进了哪一块（`null` = 离开正文）。换块才报一次，认不出的对端读成没有。 */
  setLocalBlock: (block: number | null) => void;
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
  const [restoredDraft, setRestoredDraft] = useState<{ savedAt: string } | null>(null);
  const pendingRef = useRef<string[]>([]);
  /** 最近一次写下去的那份草稿（合并后的 base64）：同一份不重复落盘。 */
  const draftWrittenRef = useRef<string | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blockRef = useRef<number | null>(null);
  const presenceNameRef = useRef(presenceName);
  presenceNameRef.current = presenceName;
  const changeRef = useRef(onRemoteChange);
  changeRef.current = onRemoteChange;

  /**
   * 把此刻还没交出去的那几个增量落到本机（草稿）。
   *
   * 写的是**合并过的一条增量**，不是整篇正文：正文存成本地副本，恢复时就得覆盖，而覆盖
   * 会抹掉对端在这期间写进文档的字（那正是这一批要消灭的形状）；增量走 CRDT 合并，
   * 别人的部分一个字不动。
   */
  const saveDraft = useCallback(async (targetNoteId: string | null, updates: readonly string[]): Promise<void> => {
    const docApi = window.ailearn?.note?.doc;
    if (!targetNoteId || updates.length === 0 || !docApi?.draftSave) return;
    let merged: string;
    try {
      merged = b64(Y.mergeUpdates(updates.map((item) => unB64(item))));
    } catch {
      // 合并都合不起来的一份东西不该落盘：写下去只会让下一次打开读回一份解不开的草稿。
      return;
    }
    // 同一份不重复写：自动保存失败重试的那段时间里，每次停笔都重写一遍是白写的。
    if (merged === draftWrittenRef.current) return;
    draftWrittenRef.current = merged;
    try {
      await docApi.draftSave({
        meta: createRequestMeta(epochRef?.current ?? undefined),
        noteId: targetNoteId,
        update: merged,
      });
    } catch {
      // 写不进去只是"这一次没保住"，不该把编辑器上的字或自动保存带塌：那条路照旧，
      // 下一次停笔还会再试。
      draftWrittenRef.current = null;
    }
  }, [epochRef]);

  /** 停笔 `DRAFT_SAVE_DEBOUNCE_MS` 之后落一次盘；每敲一下只是把这次定时器往后推。 */
  const armDraftSave = useCallback((): void => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null;
      void saveDraft(targetRef.current, pendingRef.current);
    }, DRAFT_SAVE_DEBOUNCE_MS);
  }, [saveDraft]);

  /**
   * 清草稿：确认交出去之后调（判据见 `flush`）。写不下去/清不掉都不影响正文——
   * 接回来的时候还会再判一次"它是不是已经并进这份文档了"（`draftAddsAnything`），
   * 所以一份没清掉的旧草稿不会变成"每次打开都提示恢复"。
   */
  const clearDraft = useCallback((targetNoteId: string): void => {
    draftWrittenRef.current = null;
    setRestoredDraft(null);
    const docApi = window.ailearn?.note?.doc;
    if (!docApi?.draftClear) return;
    void docApi.draftClear({
      meta: createRequestMeta(epochRef?.current ?? undefined),
      noteId: targetNoteId,
    }).catch(() => undefined);
  }, [epochRef]);

  /**
   * 读回这一篇在本机的草稿。读不到（没有、主进程还没这条通道、身份不全、那一条坏了）
   * 一律当没有：少接回一份草稿只是少了"上次没交出去的字"，而误接一份不该接的会把
   * 别人的正文并进这一篇——两种错的代价不对称。
   */
  const readDraft = useCallback(async (
    docApi: NonNullable<typeof window.ailearn>["note"]["doc"],
    targetNoteId: string,
  ): Promise<{ update: string; savedAt: string } | null> => {
    if (!docApi.draftGet) return null;
    try {
      const response = await docApi.draftGet({ meta: createRequestMeta(epochRef?.current ?? undefined), noteId: targetNoteId });
      return response.ok ? response.data.draft : null;
    } catch {
      return null;
    }
  }, [epochRef]);

  const targetRef = useRef<string | null>(noteId);
  if (noteId !== null && targetRef.current !== noteId) {
    // 只有"真的换了一篇"才丢掉这份文档。`noteId` 短暂为空是这一屏在重新读取
    // （保存之后那次回读就会这样），不是换篇——跟着一起清会把**本机还没交出去的字**
    // 也清掉，症状是刚敲的几句在每次自动保存之后凭空没了（实窗量到过一次）。
    const previousNoteId = targetRef.current;
    const switching = previousNoteId !== null;
    targetRef.current = noteId;
    if (switching) {
      // 换篇之前先把上一篇没交出去的那几个增量落到本机。卸载那一次保存要等这次渲染
      // 提交之后才跑，而那时下面已经把 `pendingRef` 清空了——所以必须在这儿先写，
      // 否则"切一篇笔记"就是这条路上唯一会丢字的地方。
      void saveDraft(previousNoteId, pendingRef.current);
      // 先丢再建：反过来的话这一次渲染里"新的那一篇"仍然读到上一篇的正文，那一屏
      // 会把上一篇印在下一篇上（这条被用例抓到过一次，症状就是换篇后块数不减）。
      docRef.current?.destroy();
      docRef.current = null;
      pendingRef.current = [];
      blockRef.current = null;
      draftWrittenRef.current = null;
      setDirty(false);
      setSeeded(false);
      setRestoredDraft(null);
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
      // 本机改动一出现就把草稿那次落盘重新计时：这条路上丢字的窗口是"最后一次停笔到
      // 自动保存成功之间"，所以草稿要比自动保存更早写下去。
      armDraftSave();
      // 本地改动也要推进那份投影的"版本号"：只靠 `setDirty(true)` 会漏——一次保存里
      // `setLocalTitle` 刚把它置真，`flush` 立刻又置假，React 批量之后状态值没变，
      // 一次渲染都不发生，投影 memo 于是交出**改写之前**的旧标题（实测量到的正是
      // "标题交出去了，屏幕却又回到别人那一份"）。
      setRevision((value) => value + 1);
      setDirty(true);
    };
    doc.on("update", record);
    return () => { doc.off("update", record); };
  }, [armDraftSave, doc]);

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
      .then(async (response) => {
        if (disposed || !response.ok) return;
        const bytes = decodeUpdate(response.data.update);
        if (bytes) Y.applyUpdate(doc, bytes, REMOTE_ORIGIN);
        if (response.workspaceEpoch && epochRef) epochRef.current = response.workspaceEpoch;
        // 本机草稿：上一次没交出去、主进程那份里也没有的那几个操作。并回来用的是
        // `DRAFT_ORIGIN`（不是 `REMOTE_ORIGIN`），于是它们重新变成"待提交的增量"——
        // 自动保存照旧会把它们送出去，而不是只画在屏幕上的一份死文本。
        //
        // **只在它比这份文档新时才接**：判据见 `draftAddsAnything`。已经并进去过的那一份
        // 在这里被判成旧的，顺手清掉，于是不会有"每次打开都提示恢复了草稿"这种假象。
        const draft = await readDraft(docApi, noteId);
        if (disposed) return;
        if (draft) {
          const draftBytes = decodeUpdate(draft.update);
          if (draftBytes && draftAddsAnything(doc, draftBytes)) {
            Y.applyUpdate(doc, draftBytes, DRAFT_ORIGIN);
            setRestoredDraft({ savedAt: draft.savedAt });
          } else {
            clearDraft(noteId);
          }
        }
        setSeeded(true);
        setRevision((value) => value + 1);
      })
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [clearDraft, doc, noteId, readDraft]);

  /**
   * 卸载（换页、切空间、刷新）时把还压着的那几个增量写下去。刷新是这条路上唯一没有
   * "下一次停笔"的场景——渲染进程一没，只有已经落到盘上的那一份还在，所以这里不能
   * 只靠那个 debounce。
   */
  useEffect(() => () => {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    void saveDraft(targetRef.current, pendingRef.current);
  }, [saveDraft]);

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
            block: peerBlock(peer.state.block),
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
        void api.note.doc.presence({ meta: meta(), noteId, state: presenceState(presenceName, blockRef.current) }).catch(() => undefined);
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

  // 报块与报名字是同一条 awareness，换块就重发一次整份（不是加一个键）：awareness 的
  // 本机上传统一是替换，两边各写半份迟早会拼出"有名没块"或"有块没名"。
  const setLocalBlock = useCallback((block: number | null): void => {
    if (blockRef.current === block) return;
    blockRef.current = block;
    const api = window.ailearn;
    if (!api?.note?.doc?.presence || !noteId) return;
    void api.note.doc
      .presence({ meta: createRequestMeta(epochRef?.current ?? undefined), noteId, state: presenceState(presenceNameRef.current, block) })
      .catch(() => undefined);
  }, [noteId]);

  const flush = useCallback(async (): Promise<"stream" | "uploaded" | "queued" | "unchanged" | null> => {
    const api = window.ailearn;
    if (!api || !noteId || !api.note?.doc?.syncUpdate || pendingRef.current.length === 0) return null;
    // 交出去的是**这一刻**攒下的那几条。往返期间敲进来的字会继续往队尾堆，所以回执
    // 回来时不能整条清空——那正是"敲了五六行、只存下来一点点"的另一半：一次自动保存
    // 要等一次服务端往返（实测 40–170ms，慢的时候更久），这期间敲的字被清出队列，
    // 既没交出去、也不再算"未提交"，而同一刻清掉的草稿本来是它们唯一的副本。
    const submittedCount = pendingRef.current.length;
    const merged = Y.mergeUpdates(pendingRef.current.map((item) => unB64(item)));
    const submitted = await api.note.doc.syncUpdate({
      meta: createRequestMeta(epochRef?.current ?? undefined),
      // 必须是 `createCommandId` 那一种：IPC 边界上 `commandIdSchema` 是不带冒号的
      // opaque id，自己拼 `note-doc:<uuid>:<ts>` 会被整条拒成 invalid_request——而那件事
      // 在渲染层读起来跟"什么都没改"一模一样（见下面那句 throw）。
      commandId: createCommandId("note-doc"),
      noteId,
      update: b64(merged),
    });
    if (submitted.workspaceEpoch && epochRef) epochRef.current = submitted.workspaceEpoch;
    // 被拒要喊出来，不能当成"没改动"：吞掉的失败在屏上只剩一个永远下不来的「草稿」。
    const via = unwrapGatewayResult(submitted).via;
    // queued 要留着这一批：没网时它们是"改完还没交出去"的全部内容，清了就是丢掉。
    if (via && via !== "queued") {
      // 只摘掉这一次真的交出去的那几条（队列是按时间追加的，交出去的是前 `submittedCount` 条）。
      pendingRef.current = pendingRef.current.slice(submittedCount);
      blockRef.current = null;
      // 队列空了才叫干净：往返期间敲的字还在队里，那时它仍然是「草稿」。
      setDirty(pendingRef.current.length > 0);
      // 草稿只在**队列空了**的时候清，判据与上面清 `pendingRef` 用的是**同一个** `via`：
      //  - `uploaded`：服务端回了 revision，已经落盘；
      //  - `stream`：增量并进了主进程那份共享文档、由 provider 送出去（界面这一侧从此
      //    不再是它唯一的副本）；
      //  - `unchanged`：那份文档本来就已经有这几个操作。
      // `queued`（没网，只攒在本机）与 null（什么都没交）不算——那几句字此刻只有本机
      // 这一份草稿，留着才对。留着也不会变成"旧的盖新的"：接回来走 CRDT 合并，而且
      // 重挂载时还会先判一次"是不是已经并进这份文档了"。队里还有没交出去的（上面那次
      // 往返期间敲的）同理：它们是草稿里唯一的那一份，清掉就真没了。
      if (pendingRef.current.length === 0) clearDraft(noteId);
    }
    return via;
  }, [clearDraft, noteId]);

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
    restoredDraft,
    flush,
    setLocalTitle,
    setLocalBlock,
    ...projection,
  };
}
