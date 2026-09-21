import * as Y from "yjs";
import {
  projectNoteBlocks,
  readNoteTitle,
  setNoteTitle,
  syncNoteBlocksForEditor,
  type NoteDocBlock,
  type ProjectedNoteBlock,
} from "./note-doc-blocks.ts";

/**
 * 一篇笔记在本机的那份文档（批次 4.4）。
 *
 * 为什么要有这么一个对象，而不是让 WS 传输层自己拿着 `Y.Doc`：**personal 空间按门控
 * 不建长连接**（决定 7b），但它照样要能编辑、照样要把改动以 CRDT 增量的形式交出去。
 * 也就是说"文档 + 攒本地增量"是两条出口共用的部分，provider 只是增量的一个去向：
 *   - 协作空间：本地增量交给 provider，它自己上送并广播；
 *   - personal / 断线：返回的那条增量交给 HTTP 上送口，失败时由调用方留着重试。
 * 之前这两条是同一段代码里的两个 if，现在它们是同一个对象的两个出口。
 *
 * 本对象**不管排队**：`submitBlocks` 把这次产生的增量交回调用方，由调用方决定去向
 * （有连接就交给 provider，没连接就上送或自己留着重试）。队列放这里就会变成"两份
 * 待发送状态"——provider 手里一份、这里一份，断线重连时没人说得清哪份是准的。
 *
 * 来源标签是这里唯一的判据：origin 等于远端出口的那个值 = 别人写的，其余 = 本机写的。
 * 判错的后果不对称——把远端的更新当成本机的，就会原样再发一遍回去（回声）。
 */

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const unB64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

/** 规范的 base64 才收：`Buffer.from(_, 'base64')` 会静默吃掉非法字符，留下半条更新。 */
function decodeUpdate(text: string): Uint8Array {
  const bytes = unB64(text);
  if (b64(bytes) !== text) throw new Error("note_doc_update_not_base64");
  return bytes;
}

export type NoteDocView = {
  blocks: ProjectedNoteBlock[];
  title: string;
  titleSource: string;
};

export type NoteDocState = {
  /** 交给 provider 的那个文档；生命周期由本对象管。 */
  readonly doc: Y.Doc;
  /** 声明"哪个 origin 算远端"（provider 实例创建之后调一次）。 */
  attachRemoteOrigin: (origin: unknown) => void;
  /** 载入服务端给的那份状态（`doc-state` 或 WS 首帧）。 */
  seed: (update: string) => void;
  /** 应用一条远端增量。 */
  applyRemote: (update: string) => void;
  /**
   * 本机改了编辑器：把 blocks 差分并进文档，返回这次产生的增量（没变则 null）。
   *
   * `blocks` 传 `null` 表示**这次只改标题，正文一个字都不动**。空数组不是"没动"，
   * 是"作者把正文删光了"——两者必须是两种表达，否则标题一保存就把笔记清空。
   */
  submitBlocks: (blocks: NoteDocBlock[] | null, title?: { title: string; titleSource: string }) => string | null;
  /** 界面要看的样子：从文档投影，不是从界面状态回推。 */
  view: () => NoteDocView;
  dispose: () => void;
};

/** 把几条本机增量合成一条（重发时一次往返交完；Yjs 的合并是纯状态运算）。 */
export function mergeNoteDocUpdates(updates: readonly string[]): string {
  const bytes = updates.map((update) => Buffer.from(update, "base64"));
  return Buffer.from(Y.mergeUpdates(bytes)).toString("base64");
}

export function createNoteDocState(): NoteDocState {
  const doc = new Y.Doc();
  doc.getMap("meta");
  doc.getArray("blocks");

  let remoteOrigin: unknown = null;
  let collecting = true;
  /** 本次 `collecting` 窗口里攒到的本机增量（合并成一条，一次提交一个操作）。 */
  let batch: Uint8Array[] = [];

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (!collecting || origin === remoteOrigin) return;
    batch.push(update);
  });

  const flushBatch = (): string | null => {
    if (batch.length === 0) return null;
    const merged = Y.mergeUpdates(batch);
    batch = [];
    return b64(merged);
  };

  return {
    doc,
    attachRemoteOrigin: (origin) => {
      remoteOrigin = origin;
    },
    seed: (update) => {
      // 打底算远端：它是服务端的现状，不该再被送回服务端。
      collecting = false;
      try {
        Y.applyUpdate(doc, decodeUpdate(update));
      } finally {
        collecting = true;
      }
    },
    applyRemote: (update) => {
      collecting = false;
      try {
        Y.applyUpdate(doc, decodeUpdate(update));
      } finally {
        collecting = true;
      }
    },
    submitBlocks: (blocks, title) => {
      batch = [];
      doc.transact(() => {
        if (blocks) syncNoteBlocksForEditor(doc, blocks);
        if (title) setNoteTitle(doc, title.title, title.titleSource);
      }, "local");
      return flushBatch();
    },
    view: () => {
      const title = readNoteTitle(doc);
      return {
        blocks: projectNoteBlocks(doc),
        title: title?.title ?? "",
        titleSource: title?.titleSource ?? "auto",
      };
    },
    dispose: () => {
      collecting = false;
      batch = [];
      doc.destroy();
    },
  };
}
