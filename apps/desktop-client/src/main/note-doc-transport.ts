import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import WebSocketPolyfill from "ws";
import { NOTE_DOC_UPDATE_MAX_CHARS, type NoteDocStreamEventV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { createNoteDocState, type NoteDocState } from "./note-doc-state.ts";

/**
 * 笔记协同的本机传输（4.3 建立；4.4 起它持有文档，provider 只是文档的一个出口）。
 *
 * 为什么连接在**主进程**而不是渲染进程：渲染进程直连 WS 被三层硬拦截挡死 ——
 * `sandbox: true` + `contextIsolation: true`、CSP `connect-src 'self' blob:`，最硬的是
 * `session.defaultSession.webRequest.onBeforeRequest` 对 `<all_urls>` 无条件 cancel
 * 白名单外的请求（WS 握手同样被吞）。主进程不受这三条约束，而且 session token 只在
 * 这里。
 *
 * 4.4 的两处关键变化：
 *  1. **文档归 `note-doc-state` 管**。不是为了整洁 —— personal 空间按门控不建长连接，
 *     却同样要编辑、同样要交出 CRDT 增量；文档长在 provider 里的话，personal 就没地方
 *     做差分。
 *  2. **过 IPC 的形状从 yjs 增量换成 blocks**。界面今天就是块形状的，让它为了看别人的
 *     改动再装一套 CRDT 是不必要的负担；合并、去重、幂等留在主进程这份文档里做。
 *
 * 一条连接只服务一篇笔记：Hocuspocus v4 的文档名在协议首条消息里、服务端按文档逐条
 * 鉴权，所以多篇共用一条 socket 要各自开 provider 才有意义。切空间时整片停掉。
 */

/** 服务端的 WS 路由（`apps/api/src/modules/note/collaboration.ts`）。 */
export const NOTE_DOC_WS_PATH = "/note-doc";
/** 文档名前缀，必须与服务端的 NOTE_DOC_PREFIX 一致。 */
export const NOTE_DOC_PREFIX = "note:";
/** presence 走 awareness，状态由界面自定义；2KB 足够放"谁在编辑"。 */
export const NOTE_DOC_PRESENCE_MAX_CHARS = 2048;

export type NoteDocConnectionStatus =
  | "connecting"
  | "connected"
  | "authenticated"
  | "disconnected"
  | "failed";

/** 服务端拒绝时的理由。三种拒绝在服务端是同一个笼统理由，这里如实照抄。 */
export type NoteDocFailureReason = "permission_denied" | "oversize" | "invalid_update" | "connection_lost";

export type NoteDocPresenceState = { clientId: number; state: Record<string, unknown> };

export type NoteDocTransportEvent =
  /**
   * 别人写进来的那一条增量。
   *
   * 下行交的是**增量本身**而不是投影结果：界面那一侧持有同一份文档，收到就 apply，
   * 编辑器自己重画。以前这里发的是 blocks，于是界面要再拼一份"我看到的正文"，
   * 那份拷贝落后于文档时就把对端的字算成了自己删掉的（批次 C 的立项理由）。
   */
  | { type: "update"; update: string }
  | { type: "presence"; states: NoteDocPresenceState[] }
  | { type: "status"; status: NoteDocConnectionStatus; authorizedScope?: "read-write" | "readonly"; reason?: NoteDocFailureReason };

/** 网关包一层后交给 IPC 的句柄：`stop()` 之后所有方法都是空操作。 */
export type NoteDocWatchHandle = {
  /** 把界面本机的增量并进影子文档；返回该上行出去的合并增量，`null` = 文档一个字没动。 */
  applyLocal: (update: string) => string | null;
  setPresence: (state: string) => void;
  stop: () => void;
};

export type NoteDocTransportHandle = {
  /** 把界面本机的增量并进文档；返回这次产生的 yjs 增量（什么都没变则 null）。 */
  applyLocal: (update: string) => string | null;
  seed: (update: string) => void;
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
 * 只接受 http/https，且**只取配置里的源**：不接受界面传进来的地址，否则那就是一台由
 * 界面决定目标的出站连接器。
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

function toPresenceStates(
  raw: Iterable<[number, Record<string, unknown>]>,
  localClientId: number,
): NoteDocPresenceState[] {
  const states: NoteDocPresenceState[] = [];
  for (const [clientId, state] of raw) {
    if (clientId === localClientId) continue;
    if (state && typeof state === "object") states.push({ clientId, state });
  }
  return states;
}

export function createHocuspocusNoteDocTransport(): NoteDocTransport {
  return ({ url, documentName, token, onEvent }) => {
    const state: NoteDocState = createNoteDocState();
    // WebSocketPolyfill 只在 `HocuspocusProviderWebsocket` 的配置上（provider 的配置联合
    // 类型不收它，运行时才透传）。所以显式组合两者，而不是塞一个会被静默忽略的字段、
    // 也不是给配置加 cast：少了它，在没有全局 WebSocket 的 Electron 构建上连不出去。
    const websocket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: webSocketConstructor() });
    const provider = new HocuspocusProvider({
      url,
      name: documentName,
      document: state.doc,
      token,
      websocketProvider: websocket,
    });
    // 来源标签必须在收发之前登记。判错的后果不对称：把远端写进来的更新当成本机的，
    // 就会被原样发回去（回声）。
    state.attachRemoteOrigin(provider);
    // **这两行不能省。** provider 只有在"自己造 socket"时才 `manageSocket=true`
    // （见 dist 里 `setConfiguration`），这里传的是外部的，于是它既不 `attach()`
    // （不把监听挂到 socket 上）也不 `connect()`（不发起握手）——症状不是报错，而是
    // "连接看起来建好了，永远没有内容"，一个字节都没收发过。服务端那侧的集测用的是
    // 服务端自己的连接，所以桌面这一侧从 4.3 建立到补这条为止一直没红过。
    provider.attach();
    websocket.connect();

    let closed = false;
    const emit = (event: NoteDocTransportEvent): void => {
      if (!closed) onEvent(event);
    };
    // 只把**别人写的**那几条转给界面：本机的刚从界面来，回它一份是回声；provider 自己
    // 的合并帧也不是"对面改了字"。判据是 origin——`attachRemoteOrigin` 登记的就是它。
    state.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (closed || origin !== provider) return;
      // 上限与 IPC 两侧共用 contracts 里那个数：一边放行一边拒收的症状是一帧静默消失。
      if (update.length * 1.34 > NOTE_DOC_UPDATE_MAX_CHARS) {
        // 超帧**不**截断（那会让界面看到半篇正文），改报 oversize，让界面退回 HTTP 重读。
        emit({ type: "status", status: "failed", reason: "oversize" });
        return;
      }
      emit({ type: "update", update: Buffer.from(update).toString("base64") });
    });

    provider.on("status", ({ status }: { status: string }) => {
      emit({
        type: "status",
        status: status === "connecting" ? "connecting" : status === "connected" ? "connected" : "disconnected",
      });
    });
    provider.on("authenticated", () => {
      // `authorizedScope` 是服务端给的（`Authenticated("readonly")`），不是本机推断的；
      // 界面把编辑器禁成只读，依据就是这个字段。
      emit({ type: "status", status: "authenticated", authorizedScope: provider.authorizedScope });
    });
    provider.on("authenticationFailed", () => {
      emit({ type: "status", status: "failed", reason: "permission_denied" });
    });
    provider.on("close", () => emit({ type: "status", status: "disconnected" }));

    const emitPresence = (): void => {
      emit({ type: "presence", states: toPresenceStates(provider.awareness?.getStates() ?? [], state.doc.clientID) });
    };
    provider.awareness?.on("update", emitPresence);

    return {
      applyLocal: (update) => state.applyLocal(update),
      seed: (update) => state.seed(update),
      setPresence: (presence) => {
        if (presence.length > NOTE_DOC_PRESENCE_MAX_CHARS) throw new Error("note_doc_presence_too_large");
        if (!provider.awareness) return;
        provider.awareness.setLocalState(presence.length === 0 ? null : safeParsePresence(presence));
      },
      close: () => {
        if (closed) return;
        closed = true;
        provider.awareness?.setLocalState(null);
        // provider 不自带 socket（manageSocket=false），所以它的 destroy 不会替我关连接。
        provider.destroy();
        websocket.destroy();
        state.dispose();
      },
    };
  };
}

/**
 * presence 只允许对象形状，解不开就当没有。
 *
 * awareness 会广播给同一篇文档上的其他人，所以不能让任意字符串穿过去：否则别人拿到的
 * 样子取决于这台机器上谁写了什么。
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

/** 真实现。工厂本身无状态，共用一个模块级实例就够。 */
export const defaultNoteDocTransport: NoteDocTransport = createHocuspocusNoteDocTransport();

/**
 * 本机事件 → 过 IPC 的那份形状。集中一处好与 contracts 对齐；返回 null 表示这个事件
 * 不属于界面 —— 未知类型一律不透传，宁可不显示也不把没约定的东西送过进程边界。
 */
export function toNoteDocStreamEvent(event: NoteDocTransportEvent): NoteDocStreamEventV1 | null {
  switch (event.type) {
    case "update":
      return { type: "update", update: event.update };
    case "presence":
      return { type: "presence", states: event.states };
    case "status":
      return {
        type: "status",
        status: event.status,
        ...(event.authorizedScope ? { authorizedScope: event.authorizedScope } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
      };
    default:
      return null;
  }
}
