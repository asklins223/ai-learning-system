import * as Y from "yjs";

/**
 * 一篇笔记在**主进程**的那一份文档（批次 4.4 建立，C2 之后它是影子文档）。
 *
 * 界面持有文档、编辑器直接写它；主进程留着一份的原因不是"它也负责改正文"，而是三件
 * 只有主进程能做的事：provider 要一个 `Y.Doc` 才发得出去、断线时增量要有地方攒、
 * 重启时那一份要从磁盘接回来。
 *
 * **这里不再有"把 blocks 差分进文档"那条路**（原来叫 `submitBlocks`）。那条路要求交上来
 * 的一方先持有一份文本拷贝、再由这里替它算增量——拷贝一旦落后于文档，算出来的就是
 * "我把对端刚写的字删了"（批次 A 的对照用例量到的正是它）。现在增量由编辑器所在的
 * 文档产生，这一层只转手。
 *
 * 一条连接只服务一篇笔记；`dispose` 之外不管排队：`applyLocal` 把这次产生的增量交回
 * 调用方，由调用方决定去向（有连接给 provider，没连接上送或自己留着重试）。队列放在
 * 这里就会有两份待发送状态——provider 一份、这里一份，重连时没人说得清哪份是准的。
 *
 * 来源标签是这里唯一的判据：origin 等于远端出口那个值的算别人写的，其余算本机的。
 * 判错的后果不对称——把远端的更新当本机，就会原样再发回去（回声）。
 */

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const unB64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

/** base64 必须是"编码回去一模一样"的那一种：`Buffer.from(_, "base64")` 会静默吃掉非法字符，留下半条更新。 */
function decodeUpdate(text: string): Uint8Array {
  const bytes = unB64(text);
  if (b64(bytes) !== text) throw new Error("note_doc_update_not_base64");
  return bytes;
}

export type NoteDocState = {
  /** 交给 provider 的那个文档；生命周期由本对象管。 */
  readonly doc: Y.Doc;
  /** 声明"哪个 origin 算远端"（provider 实例创建之后调一次）。 */
  attachRemoteOrigin: (origin: unknown) => void;
  /** 载入服务端给的那份状态（`doc-state` 或 WS 首帧）。打底算远端：它是服务端的现状，不该再被送回服务端。 */
  seed: (update: string) => void;
  /** 应用一条远端增量。 */
  applyRemote: (update: string) => void;
  /**
   * 界面本机改了什么：并进影子文档，返回这次产生的增量（没动一下就返回 null）。
   *
   * "没动"必须是**测出来**的而不是猜的：只有拿到 null，界面才能报"未改动"而不是
   * "已写入、正在同步"——后者会让人以为一次什么都没发生的提交真的出去了。
   */
  applyLocal: (update: string) => string | null;
  /**
   * 只改标题：写进文档的 `meta`，于是它和正文走同一条上行路。
   *
   * 为什么要有这一句而不是留着"只改标题、正文一个字都不动"那个 blocks 缺省的表达：
   * 标题的事实源本来就是这份文档的 `meta`（服务端落盘时也从这里抄进 `notes.title`），
   * 再开一条只传标题的通道就会出现"界面以为改了、文档里还是旧的"。
   */
  applyTitle: (title: string, titleSource: string) => string | null;
  /** 整份状态编出来，给本机落盘用（重启后靠它接着差分）。这**不是**一条待发送增量。 */
  encodeState: () => string;
  dispose: () => void;
};

/** 把几条本机增量合成一条（重发时一次往返交完；Yjs 的合并是纯状态运算）。 */
export function mergeNoteDocUpdates(updates: readonly string[]): string {
  const bytes = updates.map((update) => Buffer.from(update, "base64"));
  return Buffer.from(Y.mergeUpdates(bytes)).toString("base64");
}

/** 标题住在文档的 `meta` 里，键名与服务端那份一致。 */
export function readNoteTitle(doc: Y.Doc): { title: string; titleSource: string } | null {
  const meta = doc.getMap<unknown>("meta");
  const title = meta.get("title");
  if (typeof title !== "string") return null;
  return { title, titleSource: String(meta.get("titleSource") ?? "auto") };
}

/** 先比再写：`Y.Map.set` 对相同值也记一次操作，于是"名字没改"会白上一次送。 */
function applyTitleToDoc(doc: Y.Doc, title: string, titleSource: string): Uint8Array[] {
  const produced: Uint8Array[] = [];
  const listener = (update: Uint8Array, origin: unknown): void => {
    if (origin === LOCAL_ORIGIN) produced.push(update);
  };
  doc.on("update", listener);
  try {
    const meta = doc.getMap<unknown>("meta");
    doc.transact(() => {
      if (meta.get("title") !== title) meta.set("title", title);
      if (meta.get("titleSource") !== titleSource) meta.set("titleSource", titleSource);
    }, LOCAL_ORIGIN);
  } finally {
    doc.off("update", listener);
  }
  return produced;
}

/** 本机改动的 origin 标签：provider 与这里用同一个值判"该不该上行"。 */
const LOCAL_ORIGIN = "local";

export function createNoteDocState(): NoteDocState {
  const doc = new Y.Doc();
  /** provider 实例：它的 origin 就是"这条不是我写的"的判据。 */
  let remoteOrigin: unknown = null;

  /**
   * 以 `origin` 为标签应用一条增量，并收集**这一次**产生的本机增量。
   *
   * 判据只有 origin 一个：不等于 `LOCAL_ORIGIN` 的一律不算本机改动（provider 写进来的、
   * 打底那份都是），所以不会把远端的原样再发回去。旧的 `collecting` 布尔 + 模块级监听
   * 是同一件事的两种表达，留着就会有一句"两处说法"的判据。
   */
  const apply = (update: string, origin: unknown): Uint8Array[] => {
    const produced: Uint8Array[] = [];
    const listener = (incoming: Uint8Array, incomingOrigin: unknown): void => {
      if (incomingOrigin === LOCAL_ORIGIN) produced.push(incoming);
    };
    doc.on("update", listener);
    try {
      Y.applyUpdate(doc, decodeUpdate(update), origin);
    } finally {
      doc.off("update", listener);
    }
    return produced;
  };

  return {
    doc,
    attachRemoteOrigin: (origin) => {
      remoteOrigin = origin;
    },
    seed: (update) => {
      apply(update, remoteOrigin ?? null);
    },
    applyRemote: (update) => {
      apply(update, remoteOrigin ?? null);
    },
    applyTitle: (title, titleSource) => {
      const produced = applyTitleToDoc(doc, title, titleSource);
      if (produced.length === 0) return null;
      return b64(Y.mergeUpdates(produced));
    },
    applyLocal: (update) => {
      // LOCAL_ORIGIN 这个标签要让 provider 认得出"这是我该送出去的"：它按 origin 决定
      // 是否上行，缺了它就变成"改了但没发"。
      const produced = apply(update, LOCAL_ORIGIN);
      if (produced.length === 0) return null;
      return b64(Y.mergeUpdates(produced));
    },
    encodeState: () => b64(Y.encodeStateAsUpdate(doc)),
    dispose: () => {
      doc.destroy();
    },
  };
}
