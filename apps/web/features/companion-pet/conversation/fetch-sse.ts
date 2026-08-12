/**
 * P2 fetch-SSE client（03 §5.3）。
 *
 * - 无新依赖；credentials: "same-origin"、Accept: text/event-stream、query `after`，
 *   可带合法 Last-Event-ID；
 * - 先检查 status/content-type，再以 fatal UTF-8 TextDecoder 解析 CRLF/LF；
 * - 只接受 `event: companion`、单个 id 和单行 data；单 event wire data 最大 64KiB；
 *   未知字段/多 id/非法 UTF-8/超限 → fatal（调用方关闭并 snapshot）；
 * - 错误分支：409 → cursor_expired（snapshot）、400 → invalid_cursor、
 *   401/403 → auth（bootstrap）、429 → rate_limited（尊重 Retry-After）、
 *   5xx/network → server/network（backoff）；
 * - 任何分支都不得重新 POST turn（重连只继续 SSE cursor）。
 */

export interface ParsedSseEvent {
  id: string | null;
  event: string;
  data: string;
}

export type SseParseFatal =
  | { kind: "too_large" }
  | { kind: "multiple_ids" }
  | { kind: "multiple_data_lines" }
  | { kind: "unknown_field" };

/**
 * 增量 SSE 解析（纯函数，可单测）。事件以空行分隔；只解析 id/event/data/comment 行。
 * 返回本块产出的完整事件 + 剩余 buffer；fatal 表示 wire 违规（单事件超 64KiB、
 * 多 id、多 data 行、未知字段）。
 */
export function parseCompanionSseChunk(
  buffer: string,
  chunk: string,
  maxEventBytes = 64 * 1024,
): { events: ParsedSseEvent[]; buffer: string; fatal: SseParseFatal | null } {
  const combined = buffer + chunk;
  const events: ParsedSseEvent[] = [];
  let cursor = 0;
  let lineStart = 0;
  let current: { id: string | null; event: string; data: string | null } | null = null;
  let currentWireBytes = 0;
  const encoder = new TextEncoder();

  function flushEvent(end: number): void {
    if (!current) return;
    if (current.data === null) {
      // 无 data 行的事件（如纯 comment 事件）忽略
      current = null;
      return;
    }
    events.push({ id: current.id, event: current.event, data: current.data });
    current = null;
    currentWireBytes = 0;
    void end;
  }

  while (cursor < combined.length) {
    const nl = combined.indexOf("\n", cursor);
    const lineEnd = nl === -1 ? combined.length : nl;
    let rawLine = combined.slice(lineStart, lineEnd);
    if (rawLine.endsWith("\r")) rawLine = rawLine.slice(0, -1); // CRLF
    if (nl === -1) {
      const incompleteBytes = encoder.encode(combined.slice(lineStart)).byteLength;
      if (currentWireBytes + incompleteBytes > maxEventBytes) {
        return { events, buffer: combined.slice(lineStart), fatal: { kind: "too_large" } };
      }
      break; // 不完整行——留在 buffer
    }

    if (rawLine === "") {
      flushEvent(lineEnd);
    } else if (rawLine.startsWith(":")) {
      // comment（heartbeat）
    } else if (rawLine.startsWith("retry:")) {
      // 2026-08-12（对话送达失败修复）：SSE 规范标准字段 `retry:`（重连
      // 延迟提示）——api 在事件流开头发送 `retry: 1500`。此前未识别被
      // 当作 unknown_field → fatal_parse → 前端误判连接失败（"这次没有
      // 成功送达"）。此处忽略该字段（重连策略由外层连接管理决定）。
    } else if (rawLine.startsWith("id:")) {
      const value = rawLine.slice(3).trim();
      if (!current) current = { id: null, event: "", data: null };
      if (current.id !== null) {
        // 多 id → fatal（§5.3：只接受单个 id）
        return { events, buffer: combined.slice(lineEnd + 1), fatal: { kind: "multiple_ids" } };
      }
      current.id = value;
    } else if (rawLine.startsWith("event:")) {
      const value = rawLine.slice(6).trim();
      if (!current) current = { id: null, event: "", data: null };
      current.event = value;
    } else if (rawLine.startsWith("data:")) {
      const value = rawLine.startsWith("data: ") ? rawLine.slice(6) : rawLine.slice(5);
      if (!current) current = { id: null, event: "", data: null };
      if (current.data !== null) {
        return { events, buffer: combined.slice(lineEnd + 1), fatal: { kind: "multiple_data_lines" } };
      }
      current.data = value;
    } else {
      return { events, buffer: combined.slice(lineEnd + 1), fatal: { kind: "unknown_field" } };
    }

    if (current && rawLine !== "") {
      currentWireBytes += encoder.encode(combined.slice(lineStart, lineEnd + 1)).byteLength;
      if (currentWireBytes > maxEventBytes) {
        return { events, buffer: combined.slice(lineEnd + 1), fatal: { kind: "too_large" } };
      }
    }

    cursor = lineEnd + 1;
    lineStart = cursor;
  }

  return { events, buffer: combined.slice(lineStart), fatal: null };
}

export type CompanionSseErrorKind =
  | "cursor_expired"
  | "invalid_cursor"
  | "auth"
  | "rate_limited"
  | "network"
  | "server"
  | "fatal_parse";

export interface CompanionSseCallbacks {
  onEvent(event: {
    id: string;
    type: string;
    payload: unknown;
    conversationId?: string;
    runId?: string | null;
    generation?: number;
    /** 2026-08-11：账户世代（epoch≥1 时 reducer 据此拒绝 global off 前的迟到事件） */
    accountEpoch?: number;
  }): void;
  onError(error: { kind: CompanionSseErrorKind; retryAfterMs?: number }): void;
  /** 连接成功建立且 200 SSE 已确认后回调（用于重置调用方重试预算）。 */
  onOpen?: () => void;
}

const MAX_SINGLE_EVENT_WIRE_BYTES = 64 * 1024;

/**
 * 打开 SSE 流并持续解析事件。
 * - 200 text/event-stream → 逐事件回调；
 * - 409 → cursor_expired；400 → invalid_cursor；401/403 → auth；
 *   429 → rate_limited（Retry-After）；其余非 200 → server；
 * - fetch/读取异常 → network；
 * - 解析 fatal → fatal_parse（调用方应关闭并 snapshot）。
 * 本函数不重试、不重提 turn；重连由调用方按 cursor 策略驱动。
 */
export async function openCompanionSse(args: {
  conversationId: string;
  after: number;
  lastEventId: string | null;
  signal: AbortSignal;
  callbacks: CompanionSseCallbacks;
}): Promise<void> {
  const url = new URL(`/api/companion/conversations/${args.conversationId}/events`, window.location.origin);
  url.searchParams.set("after", String(args.after));
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (args.lastEventId) headers["Last-Event-ID"] = args.lastEventId;

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      credentials: "same-origin",
      headers,
      signal: args.signal,
    });
  } catch {
    args.callbacks.onError({ kind: "network" });
    return;
  }

  if (response.status === 409) {
    args.callbacks.onError({ kind: "cursor_expired" });
    return;
  }
  if (response.status === 400) {
    args.callbacks.onError({ kind: "invalid_cursor" });
    return;
  }
  if (response.status === 401 || response.status === 403) {
    args.callbacks.onError({ kind: "auth" });
    return;
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "0") * 1000;
    args.callbacks.onError({ kind: "rate_limited", retryAfterMs: Number.isFinite(retryAfter) ? retryAfter : 0 });
    return;
  }
  if (!response.ok) {
    args.callbacks.onError({ kind: "server" });
    return;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    args.callbacks.onError({ kind: "server" });
    return;
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = response.body?.getReader();
  if (!reader) {
    args.callbacks.onError({ kind: "network" });
    return;
  }
  // 200 SSE 已确认：调用方重置重试预算（连接成功本身证明服务端健康，
  // 与是否立刻有事件无关）。
  args.callbacks.onOpen?.();

  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let text: string;
      try {
        text = decoder.decode(value, { stream: true });
      } catch {
        args.callbacks.onError({ kind: "fatal_parse" }); // 非法 UTF-8
        await reader.cancel().catch(() => {});
        return;
      }
      const parsed = parseCompanionSseChunk(buffer, text, MAX_SINGLE_EVENT_WIRE_BYTES);
      buffer = parsed.buffer;
      if (parsed.fatal) {
        args.callbacks.onError({ kind: "fatal_parse" });
        await reader.cancel().catch(() => {});
        return;
      }
      for (const event of parsed.events) {
        if (event.event !== "companion") continue; // 只接受 event: companion
        if (!event.id) continue;
        try {
          const envelope = JSON.parse(event.data) as {
            type?: string;
            payload?: unknown;
            conversationId?: string;
            runId?: string | null;
            generation?: number;
            accountEpoch?: number;
          };
          if (typeof envelope.type !== "string" || envelope.payload === undefined) {
            args.callbacks.onError({ kind: "fatal_parse" });
            await reader.cancel().catch(() => {});
            return;
          }
          args.callbacks.onEvent({
            id: event.id,
            type: envelope.type,
            payload: envelope.payload,
            conversationId: envelope.conversationId,
            runId: envelope.runId,
            generation: envelope.generation,
            // 2026-08-11 修复：透传 accountEpoch——此前丢弃导致账户 epoch≥1
            //（曾 global off 后恢复）时 reducer 把事件判 stale，流式对话卡 thinking。
            accountEpoch: envelope.accountEpoch,
          });
        } catch {
          args.callbacks.onError({ kind: "fatal_parse" });
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }
    // TextDecoder buffers an incomplete multi-byte sequence while streaming.
    // Flush it explicitly so a truncated/invalid UTF-8 response cannot be
    // silently downgraded to a reconnectable network error.
    try {
      decoder.decode();
    } catch {
      args.callbacks.onError({ kind: "fatal_parse" });
      await reader.cancel().catch(() => {});
      return;
    }
    // A strict companion event must end with the SSE blank line. Treat a
    // truncated tail as a wire error instead of dropping the final event.
    if (buffer.trim().length > 0) {
      args.callbacks.onError({ kind: "fatal_parse" });
      return;
    }
    if (!args.signal.aborted) args.callbacks.onError({ kind: "network" });
  } catch {
    if (!args.signal.aborted) args.callbacks.onError({ kind: "network" });
  }
}
