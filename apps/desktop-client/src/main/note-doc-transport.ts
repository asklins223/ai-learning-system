import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import WebSocketPolyfill from "ws";
import { NOTE_DOC_FRAME_MAX_BASE64_CHARS, type NoteDocStreamEventV1 } from "@ailearn/shared/desktop-ipc-contracts";

/**
 * 笔记协同的本机传输（批次 4.3）。
 *
 * 为什么连接在**主进程**而不是渲染进程：渲染进程直连 WS 被三层硬拦截挡死——
 * `sandbox: true` + `contextIsolation: true`、CSP `connect-src 'self' blob:`，
 * 最硬的是 `session.defaultSession.webRequest.onBeforeRequest` 对 `<all_urls>`
 * 无条件 cancel 白名单外的请求（WS 握手同样被吞）。主进程不受这三条约束，
 * 而且 session token 本来就只在这里。
 *
 * 这里只做一件事：把一篇笔记的 Y.Doc 接在两个方向上——服务端来的增量编码成 base64
 * 交给上层（再经 IPC 转发），界面进来的 base64 增量喂回文档。CRDT 的合并与幂等是
 * Yjs 的事，本模块不理解正文。
 *
 * 一条连接只服务一篇笔记：Hocuspocus v4 的文档名在协议首条消息里，服务端按文档逐条
 * 鉴权，所以"多篇共用一条 socket"要另开 provider 才有意义。先按"开哪篇连哪篇"做，
 * 切空间时整片停掉。
 */

/** 服务端的 WS 路由（`apps/api/src/modules/note/collaboration.ts`）。 */
export const NOTE_DOC_WS_PATH = "/note-doc";
/** 文档名前缀，必须与服务端的 NOTE_DOC_PREFIX 一致。 */
export const NOTE_DOC_PREFIX = "note:";
/**
 * 单帧 base64 上限由 `@ailearn/shared/desktop-ipc-contracts` 给（`NOTE_DOC_FRAME_MAX_BASE64_CHARS`）：
 * 主进程与 IPC 两侧必须是同一个数，否则这里放行、那里拒收，症状是一条更新静默消失。
 * 服务端一次增量限 2MB 原始字节（≈2.7M 字符），4M 字符够装下"整篇文档的当前状态"
 * （订阅后的第一帧就是它）。超帧**不**静默截断：那会留下半篇正文，所以改成报 oversize，
 * 让渲染层退回 HTTP 整篇重读一次。
 */
/** presence 走 awareness，状态由界面自定义；给 2KB 足够放"谁在编辑"。 */
export const NOTE_DOC_PRESENCE_MAX_CHARS = 2048;

/** 一条笔记的连接句柄；`stop()` 之后所有方法都变成空操作。 */
export type NoteDocWatchHandle = {
  applyLocalUpdate: (update: string, ack: string) => void;
  currentState: () => string;
  setPresence: (state: string) => void;
  stop: () => void;
};

/**
 * 本机事件 → 过 IPC 的那份形状。
 *
 * 两个方向的增量在这里合成同一个 `update`：渲染层的文档是 CRDT，收到自己刚发出去的那条
 * 是无操作，所以不需要为"回声"另设类型。反过来说，**不**合并的话就得让界面理解
 * "哪种更新该写进队列、哪种不该"，那是同一个判断放到了两处。
 */
export function toNoteDocStreamEvent(event: NoteDocTransportEvent): NoteDocStreamEventV1 | null {
  switch (event.type) {
    case "remote_update":
    case "local_update":
      return { type: "update", update: event.update };
    case "presence":
      return { type: "presence", states: event.states };
    case "status":
      return { type: "status", status: event.status, ...(event.authorizedScope ? { authorizedScope: event.authorizedScope } : {}), ...(event.reason ? { reason: event.reason } : {}) };
    default:
      return null;
  }
}

/** 真实现。工厂本身无状态，所以共用一个模块级实例就够了。 */
export const defaultNoteDocTransport: NoteDocTransport = createHocuspocusNoteDocTransport();

export type NoteDocConnectionStatus =
  | "connecting"
  | "connected"
  | "authenticated"
  | "disconnected"
  | "failed";

/** 服务端拒绝时的理由。服务端对三种拒绝给的是同一个笼统理由，这里如实照抄。 */
export type NoteDocFailureReason = "permission_denied" | "oversize" | "invalid_update" | "connection_lost";

export type NoteDocTransportEvent =
  /** 来自服务端的增量：要广播给**所有**窗口（包括本机别的那个窗口）。 */
  | { type: "remote_update"; update: string }
  /** 来自某个窗口的增量：provider 已经把它送给服务端了，这里只负责发给同机其它窗口。 */
  | { type: "local_update"; update: string; ack: string }
  | { type: "presence"; states: NoteDocPresenceState[] }
  | { type: "status"; status: NoteDocConnectionStatus; authorizedScope?: "read-write" | "readonly"; reason?: NoteDocFailureReason };

export type NoteDocPresenceState = { clientId: number; state: Record<string, unknown> };

export type NoteDocTransportHandle = {
  /** 把界面产生的增量喂给文档。origin 打上 ack，避免回灌给同一个窗口。 */
  applyLocalUpdate: (update: string, ack: string) => void;
  /** 当前文档的完整状态；刚打开的编辑器用它打底。 */
  currentState: () => string;
  /** 本窗口的 presence（空串 = 离开）。 */
  setPresence: (state: string) => void;
  close: () => void;
};

export type NoteDocTransportInput = {
  url: string;
  documentName: string;
  token: string;
  onEvent: (event: NoteDocTransportEvent) => void;
};

export type NoteDocTransport = (input: NoteDocTransportInput) => NoteDocTransportHandle;

/**
 * apiOrigin → WS origin。
 *
 * 只接受 http/https，且**只取配置里的源**：不接受界面传进来的地址，否则那就是一台
 * 由界面决定目标的出站连接器。
 */
export function noteDocStreamUrl(apiOrigin: string): string {
  let url: URL;
  try {
    url = new URL(apiOrigin);
  } catch {
    throw new Error("note_doc_origin_invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("note_doc_origin_invalid");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = NOTE_DOC_WS_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Electron 主进程的 Node 未必有全局 WebSocket（Node 22.4 起才有），所以显式给实现。 */
function webSocketConstructor(): unknown {
  const globalCtor = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof globalCtor === "function" ? globalCtor : WebSocketPolyfill;
}

function toPresenceStates(raw: Iterable<[number, Record<string, unknown>]>, localClientId: number): NoteDocPresenceState[] {
  const states: NoteDocPresenceState[] = [];
  for (const [clientId, state] of raw) {
    if (clientId === localClientId) continue;
    if (!state || typeof state !== "object") continue;
    states.push({ clientId, state });
  }
  return states;
}

export function createHocuspocusNoteDocTransport(): NoteDocTransport {
  return ({ url, documentName, token, onEvent }) => {
    const doc = new Y.Doc();
    // WebSocketPolyfill 只在 `HocuspocusProviderWebsocket` 的配置上，provider 的配置联合
    // 类型不收它（运行时是透传的）。所以显式组合两者，而不是塞一个会被静默忽略的字段、
    // 也不是给配置加 cast：少了这条，Electron 主进程在没有全局 WebSocket 的 Node 构建上
    // 会连不出去。
    const websocket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: webSocketConstructor() });
    const provider = new HocuspocusProvider({
      url,
      name: documentName,
      document: doc,
      token,
      websocketProvider: websocket,
    });
    let closed = false;
    const emit = (event: NoteDocTransportEvent): void => {
      if (!closed) onEvent(event);
    };

    provider.on("status", ({ status }: { status: string }) => {
      emit({
        type: "status",
        status: status === "connecting" ? "connecting" : status === "connected" ? "connected" : "disconnected",
      });
    });
    provider.on("authenticated", () => {
      // `authorizedScope` 是服务端给的（`Authenticated("readonly")`），不是本地推断的。
      // 界面把编辑器禁成只读，依据就是这个字段。
      emit({ type: "status", status: "authenticated", authorizedScope: provider.authorizedScope });
    });
    provider.on("authenticationFailed", () => {
      emit({ type: "status", status: "failed", reason: "permission_denied" });
    });
    provider.on("close", () => emit({ type: "status", status: "disconnected" }));

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoded = Buffer.from(update).toString("base64");
      if (encoded.length > NOTE_DOC_FRAME_MAX_BASE64_CHARS) {
        emit({ type: "status", status: "failed", reason: "oversize" });
        return;
      }
      if (origin === provider) {
        emit({ type: "remote_update", update: encoded });
        return;
      }
      if (typeof origin === "string" && origin.startsWith("ack:")) {
        emit({ type: "local_update", update: encoded, ack: origin.slice(4) });
      }
      // 其他 origin（本机自己直接改了文档）不转发：这条通道的写入只有一个入口。
    });

    const emitPresence = (): void => {
      emit({ type: "presence", states: toPresenceStates(provider.awareness?.getStates() ?? [], doc.clientID) });
    };
    provider.awareness?.on("update", emitPresence);

    return {
      applyLocalUpdate: (update, ack) => {
        const bytes = Buffer.from(update, "base64");
        // `Buffer.from(_, 'base64')` 会静默吃掉非法字符，所以解码结果不能当合法性用。
        if (bytes.toString("base64") !== update) throw new Error("note_doc_update_not_base64");
        Y.applyUpdate(doc, bytes, `ack:${ack}`);
      },
      currentState: () => Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
      setPresence: (state) => {
        if (state.length > NOTE_DOC_PRESENCE_MAX_CHARS) throw new Error("note_doc_presence_too_large");
        if (!provider.awareness) return;
        provider.awareness.setLocalState(state.length === 0 ? null : safeParsePresence(state));
      },
      close: () => {
        if (closed) return;
        closed = true;
        provider.awareness?.setLocalState(null);
        // provider 不自带 socket（manageSocket=false），所以 destroy 不会替我关掉连接。
        provider.destroy();
        websocket.destroy();
        doc.destroy();
      },
    };
  };
}

/**
 * presence 只允许"对象"，且解不开就当没有。
 *
 * awareness 会被广播给同文档的其他人，所以这里不能让任意字符串穿过去：界面那边
 * 拿到什么形状，取决于这台机器上谁写了什么。
 */
function safeParsePresence(state: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(state);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
