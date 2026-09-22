import * as Y from "yjs";
import { Hocuspocus } from "@hocuspocus/server";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket as WsSocket, RawData } from "ws";
import { and, eq } from "drizzle-orm";
import { noteDocumentStates, notes } from "@ailearn/shared/db-schema/note";
import { logger } from "../../lib/logger.ts";
import { db, withWorkspaceTransaction } from "../../db/client.ts";
import { decodeToken } from "../identity/service.ts";
import { isWorkspaceOwner } from "../identity/middleware.ts";
import {
  loadNoteDoc,
  persistNoteDoc,
  resolveNoteDocFlushTarget,
} from "./document-state.ts";
import { snapshotOf } from "./doc-fragment.ts";
import { visibleNotesCondition } from "./visibility.ts";

/**
 * 笔记协同的服务端（批次 4.2）。
 *
 * 一条连接能不能改，判据**只有服务端一份**：`onAuthenticate` 从 token 解出 session，
 * `isWorkspaceOwner` 决定 `connectionConfig.readOnly`，服务端此后一律拒收该连接的更新。
 * 界面隐藏按钮不是权限，客户端说什么都不算——这跟这次审查里"服务端可写、UI 判只读"
 * 那类分裂是同一个问题的两面。
 *
 * 一条 WS 可以服务多篇笔记：文档名来自协议首条消息而不是 URL 路径，所以每次换文档都会
 * 重跑一遍 `onAuthenticate`，"这篇笔记属于我当前这个空间"是逐文档判的。
 *
 * 空间切换的 epoch 不在这里判——它是客户端 IPC 的概念（服务端 `workspaceEpoch` 恒为 1），
 * 由批次 1 收口的 `assertEpoch` 在主进程边界挡，本机缓存键 `(workspaceId, epoch, noteId)`
 * 负责切换后不串正文。
 *
 * 持久化按决定 6 是 snapshot-on-idle：`debounce` 之后再落盘，不追每一次按键。
 * 落盘同时把文档投影成当前版本的 `note_blocks` 行，关系表因此只有一个生产者。
 */

export type NoteDocContext = {
  userId: string;
  workspaceId: string;
  noteId: string;
  versionId: string;
  readOnly: boolean;
};

export const NOTE_DOC_PREFIX = "note:";

export function documentNameForNote(noteId: string): string {
  return `${NOTE_DOC_PREFIX}${noteId}`;
}

export function noteIdFromDocumentName(documentName: string): string {
  return documentName.startsWith(NOTE_DOC_PREFIX) ? documentName.slice(NOTE_DOC_PREFIX.length) : "";
}

/**
 * 取 session token。
 *
 * v4 的 token 不在 HTTP 头上：客户端先连上 WS、再在协议里发一条 Auth 消息把 token
 * 交给服务端，所以主判据是 `onAuthenticate` 的 `token` 形参。请求头只是兜底——
 * 反向代理可能注入 Authorization，而那是同一条已鉴权通道，不是第三条判据。
 */
function bearerFrom(headers: Headers): string {
  const raw = headers.get("authorization") ?? "";
  return raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export const noteCollaboration = new Hocuspocus<NoteDocContext>({
  // 决定 6：空闲后落一次整份快照，不写 update log。
  debounce: 2_000,
  quiet: true,
  // 单副本约束（决定 6）：doc 常驻本进程内存，多副本需要外部 pubsub。
  // 扩到多副本之前必须先在这里换成共享 store，见 docs/ 的扩展前置说明。

  async onAuthenticate({ documentName, token, requestHeaders, connectionConfig }) {
    const credential = token || bearerFrom(requestHeaders);
    const session = credential ? await decodeToken(credential) : null;
    if (!session) {
      // 抛错即拒绝该文档。不给"匿名也能连上看看"的余地。
      throw new Error("unauthorized");
    }
    const noteId = noteIdFromDocumentName(documentName);
    if (!noteId) throw new Error("bad_document_name");

    const note = await db.query.notes.findFirst({
      where: eq(notes.id, noteId),
      columns: { id: true, workspaceId: true, currentVersionId: true, deletedAt: true, shareScope: true },
    });
    if (!note || note.workspaceId !== session.workspaceId || note.deletedAt !== null) {
      // 空间不符一律按"不存在"处理：跨空间探测不该从错误信息里得到答案。
      throw new Error("note_not_found");
    }
    if (!note.currentVersionId) throw new Error("note_has_no_version");
    // 批次 4.5：实时连接只服务「已共享给空间」的笔记。仅自己可见的那篇不广播，
    // 但**照样能编辑**（写入内核不看这一位，走 HTTP 上送那条同一个口）——门控关的是
    // 传输，不是写入。理由与拒绝的措辞都跟"没权限"同一类，不给探测留缝。
    if (note.shareScope !== "shared") throw new Error("not_shareable");

    const readOnly = !isWorkspaceOwner(session);
    // 只读要写进 connectionConfig，不是自己挡消息：服务端会据此回一条
    // `Authenticated("readonly")` 让客户端知道自己只读，之后同步/更新一律回
    // `SyncStatus(false)`（否定确认）。在 `beforeHandleMessage` 里抛错会断整条
    // 连接，那等于把"只读成员能实时看到别人的编辑"这条要求一起杀掉。
    connectionConfig.readOnly = readOnly;

    return {
      userId: session.userId,
      workspaceId: session.workspaceId,
      noteId: note.id,
      versionId: note.currentVersionId,
      readOnly,
    };
  },

  async onLoadDocument({ document, context }) {
    // 把库里的状态灌进 Hocuspocus 已经建好的 doc，而不是换一个 doc 出去。
    const { doc } = await withWorkspaceTransaction(
      { workspaceId: context.workspaceId, userId: context.userId },
      (tx) => loadNoteDoc(tx, {
        workspaceId: context.workspaceId,
        noteId: context.noteId,
        userId: context.userId,
      }),
    );
    Y.applyUpdate(document, Y.encodeStateAsUpdate(doc));
    doc.destroy();
  },

  // v4 的落盘钩子给的是 `lastContext`（最后一个活跃连接的上下文），不是 `context`。
  async onStoreDocument({ document, lastContext }) {
    const context = lastContext;
    const next = snapshotOf(document);
    await withWorkspaceTransaction(
      { workspaceId: context.workspaceId, userId: context.userId },
      async (tx) => {
        // 内容没变就一个字节都不写。Hocuspocus 的直连 disconnect 会**无条件**跑这个
        // 钩子，离线队列重放同一条 update、或连上又断开都会进来一次；不挡这里的话
        // revision 凭空 +1，而正文的行被重写一遍。
        const stored = await tx.query.noteDocumentStates.findFirst({
          where: and(
            eq(noteDocumentStates.noteId, context.noteId),
            eq(noteDocumentStates.workspaceId, context.workspaceId),
          ),
          columns: { state: true },
        });
        if (stored && sameBytes(Uint8Array.from(stored.state), next)) return;

        // 落盘与投影全套都交给 `persistNoteDoc`——它是唯一一处"文档写回关系表"的地方：
        // 正文的行、当前版本的快照、标题、更新时间、搜索投影一次过。自动保存以前是
        // 按行写的那条路，那条路一停，这里少投一样就是一个不报错的错位。
        const versionId = await resolveNoteDocFlushTarget(tx, {
          workspaceId: context.workspaceId,
          noteId: context.noteId,
          userId: context.userId,
        }, document);
        await persistNoteDoc(tx, {
          workspaceId: context.workspaceId,
          noteId: context.noteId,
          userId: context.userId,
        }, document, versionId);
      },
    );
  },
});

export type NoteCollaboration = typeof noteCollaboration;

/**
 * WS 通道本身（批次 4.2）。
 *
 * 为什么它是**一个独立插件**、而不是挂在 `noteRoutes` 里：那条链顶部有
 * `preHandler: requireSession`，而 v4 的 token 不在升级请求头上——它在握手完成之后的
 * 第一条 Auth 消息里（浏览器、Electron 和 Node 的 WebSocket 都不允许自定请求头）。
 * 让那道钩子覆盖这条路由，等于每个合法客户端都在升级阶段吃 401。
 *
 * 少一道闸不等于没人看门：鉴权之前服务端一个字节正文都不发（同步消息全进
 * `incomingMessageQueue` 排队），队列本身有字节/条数/待鉴权文档数三重上限。判据仍然
 * 只有一份，就是 `onAuthenticate`，而且它按文档逐条判——换一篇笔记就要重新过一遍。
 */
export async function noteCollaborationRoutes(app: FastifyInstance) {
  await app.register(websocket);
  app.get("/note-doc", { websocket: true }, (socket, request) => {
    handleNoteDocConnection(socket, request.raw);
  });
}

/**
 * 交给 Fastify 的 websocket 路由：升级由 `@fastify/websocket` 完成，握手后本函数把
 * `ws` 的 socket 接到本服务上。
 *
 * Hocuspocus v4 的 `handleConnection` **只负责往外发**：入向帧要由宿主接线，
 * `handleMessage`/`handleClose` 的注释原文是 "Call this from your integration"
 * （内置 Server 用的是 crossws 适配器，那里替它接好了）。漏接的失败模式非常安静——
 * 客户端连上、状态 connected、什么正文也收不到，服务端也不报错。
 */
function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function handleNoteDocConnection(socket: WsSocket, request: import("node:http").IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    // IncomingHttpHeaders 的值可以是 number 或数组，逐个收成字符串才能进 Headers。
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  const host = headers.get("host") ?? "localhost";
  const url = new URL(request.url ?? "/", `http://${host}`);
  const webRequest = new Request(url, { method: "GET", headers });
  const client = noteCollaboration.handleConnection(socket, webRequest, {} as NoteDocContext);
  socket.on("message", (data: RawData) => client.handleMessage(toBytes(data)));
  socket.on("close", (code: number, reason: Buffer) =>
    client.handleClose({ code, reason: reason.toString("utf8") }),
  );
  socket.on("error", () => client.handleClose({ code: 1011, reason: "socket_error" }));
  return client;
}

/**
 * 上送一条 yjs 增量（批次 4.3 的 HTTP 通道，personal 空间与离线队列重连走这里）。
 *
 * 为什么不另写一套"读快照→改→存"：那正是这次要消灭的第二事实源。`openDirectConnection`
 * 拿到的是**同一份内存文档**——如果这篇笔记此刻有 WS 连接在用，增量直接并进活的文档并
 * 广播出去；如果没有，它按 `onLoadDocument` 从库里补齐后再并。两条路之后都只经过
 * `onStoreDocument` 这一个落盘口，投影仍然是同一个函数。
 *
 * 幂等：重放同一条 update 时 Yjs 判定为已存在，文档没变 → 不落盘 → revision 不动。
 * 离线队列可以放心按序重发。
 */
export async function applyUploadedDocUpdate(input: {
  workspaceId: string;
  userId: string;
  noteId: string;
  update: Uint8Array;
}): Promise<
  | { status: "ok"; revision: number; savedAt: string }
  | { status: "not_found" }
  | { status: "no_version" }
> {
  const scope = { workspaceId: input.workspaceId, userId: input.userId };
  const note = await withWorkspaceTransaction(scope, (tx) =>
    tx.query.notes.findFirst({
      where: and(
        eq(notes.id, input.noteId),
        eq(notes.workspaceId, input.workspaceId),
        visibleNotesCondition(input.userId),
      ),
      columns: { currentVersionId: true, deletedAt: true },
    }),
  );
  if (!note || note.deletedAt !== null) return { status: "not_found" };
  if (!note.currentVersionId) return { status: "no_version" };

  const context: NoteDocContext = {
    userId: input.userId,
    workspaceId: input.workspaceId,
    noteId: input.noteId,
    versionId: note.currentVersionId,
    // 可写性由路由上的 `requireOwner` 判（与 `onAuthenticate` 同一个谓词）；走到这里
    // 就是可写。这里不再判第二次，否则又多一套可能互相矛盾的判据。
    readOnly: false,
  };

  const connection = await noteCollaboration.openDirectConnection(documentNameForNote(input.noteId), context);
  try {
    await connection.transact((document) => {
      Y.applyUpdate(document, input.update);
    });
  } finally {
    // `disconnect` 才是"落盘"这一步：它会跑 storeDocumentHooks，并且只在没有任何
    // WS 连接时才卸载文档，所以并进来的增量不会把在线协作者的文档踢掉。
    await connection.disconnect();
  }

  const [stored, flushedNote] = await Promise.all([
    withWorkspaceTransaction(scope, (tx) =>
      tx.query.noteDocumentStates.findFirst({
        where: and(
          eq(noteDocumentStates.noteId, input.noteId),
          eq(noteDocumentStates.workspaceId, input.workspaceId),
        ),
        columns: { revision: true },
      })),
    withWorkspaceTransaction(scope, (tx) =>
      tx.query.notes.findFirst({
        where: and(eq(notes.id, input.noteId), visibleNotesCondition(input.userId)),
        columns: { updatedAt: true },
      })),
  ]);
  return {
    status: "ok",
    revision: Number(stored?.revision ?? 0),
    // 落盘口现在会刷新 `notes.updated_at`，所以这个时间是服务端给的，不是本机猜的。
    savedAt: (flushedNote?.updatedAt ?? new Date()).toISOString(),
  };
}

/**
 * 关停：先把 debounce 窗口里没落盘的快照刷出去，再断开所有连接，最后等文档真的卸载。
 *
 * 顺序不能反：直接断连接会把窗口内的最后一次编辑丢掉——那正是审查里"静默销毁用户内容"
 * 要防的事。等到 `documents` 清空才算完，因为 Hocuspocus 在落盘出错时会**故意**把文档
 * 留在内存里（"Document stays in memory to avoid data loss"），计数归零就是"全部落盘
 * 成功"的可观测证据；不归零说明有快照没写进去，必须报出来而不是安静退出。
 */
export async function closeNoteCollaboration(timeoutMs = 5_000): Promise<void> {
  noteCollaboration.flushPendingStores();
  noteCollaboration.closeConnections();
  const deadline = Date.now() + timeoutMs;
  while (noteCollaboration.getDocumentsCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const stuck = noteCollaboration.getDocumentsCount();
  if (stuck > 0) {
    logger.error({ stuck }, `笔记协同有 ${stuck} 篇文档没能落盘卸载，最后一段编辑可能丢失`);
  }
}

/** 供测试与运维：当前被本进程持有的文档数与连接数（单副本约束的可观测点）。 */
export function collaborationLoad(): { documents: number; connections: number } {
  return {
    documents: noteCollaboration.getDocumentsCount(),
    connections: noteCollaboration.getConnectionsCount(),
  };
}
