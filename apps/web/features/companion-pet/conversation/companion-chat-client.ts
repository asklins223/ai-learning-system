/**
 * P2 companion chat client（Pet 侧，03 §6.1/§8.1/§5.3）。
 *
 * - ensureDialogue：首次发送前创建 dialogue conversation（§6.1），进程内缓存 id；
 * - submitTurn：POST /api/companion/conversations/:id/turns（Idempotency-Key 必填），
 *   202 返回 runId/generation/eventCursor；
 * - streamEvents：openCompanionSse 订阅（cursor 从 eventCursor 起），按事件回调
 *   reducer 事件；内部累积 delta 文本，assistant.final 时给出完整 text 与 hash；
 * - 断线/错误只上报（由调用方决定 snapshot/重连），从不重新 POST turn。
 */

import { openCompanionSse, type CompanionSseErrorKind } from "./fetch-sse.ts";
import { getCsrfToken } from "../../../lib/api.ts";
import {
  cancelCompanionRunResponseV1Schema,
  companionCharacterCueV1Schema,
  companionConversationSnapshotV1Schema,
  createCompanionTurnResponseV1Schema,
  type CompanionCharacterCueV1,
  type CompanionConversationSnapshotV1,
  type CompanionPageContextV1,
  type CancelCompanionRunResponseV1,
  type CreateCompanionTurnResponseV1,
} from "@ailearn/shared";
import {
  allowedMainRouteV1Schema,
  type AllowedMainRouteV1,
} from "@ailearn/shared";

export type SubmitCompanionTurnBody = CreateCompanionTurnResponseV1;

export interface CompanionChatClientV1 {
  ensureDialogue(): Promise<string>;
  /** Refresh-safe recovery: read the scoped durable dialogue snapshot, if any. */
  restoreDialogue(signal?: AbortSignal): Promise<CompanionConversationSnapshotV1 | null>;
  cancelRun(args: {
    runId: string;
    generation: number;
    signal?: AbortSignal;
  }): Promise<{ statusCode: number; body: CancelCompanionRunResponseV1 }>;
  submitTurn(args: {
    conversationId: string;
    text: string;
    voiceArtifactId?: string;
    clientMessageId: string;
    idempotencyKey: string;
    sourceSurface?: "pet" | "main" | "web_fallback";
    context?: CompanionPageContextV1;
    signal?: AbortSignal;
  }): Promise<{ statusCode: number; body: SubmitCompanionTurnBody }>;
  streamEvents(args: {
    conversationId: string;
    after: number;
    runId: string;
    generation: number;
    /** Action events are opt-in; the confirmation card owns their watcher. */
    includeActionEvents?: boolean;
    /** Durable preview already present in a recovery snapshot. */
    initialText?: string;
    signal: AbortSignal;
    onDispatch(event: CompanionSseMappedDispatch): void;
    onError?(kind: CompanionSseErrorKind, exhausted?: boolean): void;
  }): void;
}

type CompanionScope = { userId: string; workspaceId: string };

const cachedConversationIds = new Map<string, string>();
const inFlightConversationIds = new Map<string, Promise<string>>();

const DIALOGUE_STORAGE_PREFIX = "ailearn:companion:dialogue:v1:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function companionMutationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const csrf = getCsrfToken();
  return csrf ? { ...extra, "x-csrf-token": csrf } : extra;
}

function scopeKey(scope?: CompanionScope): string {
  return scope ? `${scope.userId}:${scope.workspaceId}` : "anonymous-scope";
}

function storageKey(scopeKeyValue: string): string {
  return `${DIALOGUE_STORAGE_PREFIX}${scopeKeyValue}`;
}

function readStoredConversationId(scopeKeyValue: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(storageKey(scopeKeyValue));
    return value && UUID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function rememberConversationId(scopeKeyValue: string, conversationId: string): void {
  cachedConversationIds.set(scopeKeyValue, conversationId);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(scopeKeyValue), conversationId);
  } catch {
    // Storage is an optimization only; the in-memory cache remains authoritative.
  }
}

export function resetCompanionChatClientCache(scope?: CompanionScope): void {
  const key = scopeKey(scope);
  cachedConversationIds.delete(key);
  inFlightConversationIds.delete(key);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(storageKey(key));
    } catch {
      // Ignore unavailable storage.
    }
  }
}

function seqFromEventId(id: string): number {
  const match = /:(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

export interface CompanionSseMappedDispatch {
  type:
    | "assistant.status"
    | "assistant.delta"
    | "assistant.final"
    | "character.cue"
    | "turn.cancelled"
    | "turn.failed"
    | "action.completed"
    | "action.failed"
    | "voice.segments";
  seq: number;
  runId: string;
  generation: number;
  conversationId?: string;
  accountEpoch?: number;
  phase?: "thinking" | "streaming";
  text?: string;
  messageId?: string;
  textSha256?: string;
  code?: string;
  recoverable?: boolean;
  actionRunId?: string;
  resultRef?: string | null;
  route?: AllowedMainRouteV1 | null;
  safeSummary?: string;
  /** character.cue：服务端受控表现 cue（§4.4 wire 版）。 */
  cue?: CompanionCharacterCueV1;
  /** voice.segments：单段（§11.3 worker 切句的 voice.segment.ready） */
  segment?: { ordinal: number; segmentId: string; text: string; conversationId?: string };
}

/** 纯函数：SSE 事件 → reducer dispatch（含 delta 累积）；runId 不匹配（旧 generation）返回 null。 */
export function mapCompanionSseEvent(args: {
  event: {
    id: string;
    type: string;
    payload: unknown;
    conversationId?: string;
    runId?: string | null;
    generation?: number;
    accountEpoch?: number;
  };
  runId: string;
  generation: number;
  accumulatedText: string;
}): { dispatch: CompanionSseMappedDispatch; accumulatedText: string } | null {
  const seq = seqFromEventId(args.event.id);
  // L11：SSE envelope 的账号世代（global off 后旧事件由 reducer 拒绝）。
  const accountEpoch = (args.event as { accountEpoch?: number }).accountEpoch ?? 0;
  // 真实 SSE：runId/generation 在事件顶层（companion-events.ts 输出），payload 扁平
  const eventRunId = (args.event as { runId?: string | null }).runId;
  const eventGeneration = (args.event as { generation?: number }).generation;
  const isConversationActionEvent = args.event.type === "action.completed" || args.event.type === "action.failed";
  if (
    !isConversationActionEvent
    && ((eventRunId && eventRunId !== args.runId) ||
      (eventGeneration != null && eventGeneration !== args.generation))
  ) {
    return null; // 旧 generation consume-only
  }
  const payload = (args.event.payload ?? {}) as {
    appendFrom?: number;
    textDelta?: string;
    messageId?: string;
    textSha256?: string;
    status?: string;
    code?: string;
    recoverable?: boolean;
    segmentId?: string;
    ordinal?: number;
    text?: string;
  };
  switch (args.event.type) {
    case "assistant.status":
      return {
        dispatch: {
          type: "assistant.status",
          seq,
          runId: args.runId,
          generation: args.generation,
          accountEpoch,
          phase: payload.status === "thinking" ? "thinking" : "streaming",
        },
        accumulatedText: args.accumulatedText,
      };
    case "assistant.delta": {
      const textDelta = payload.textDelta ?? "";
      return {
        dispatch: {
          type: "assistant.delta",
          seq,
          runId: args.runId,
          generation: args.generation,
          accountEpoch,
          text: textDelta,
        },
        accumulatedText: args.accumulatedText + textDelta,
      };
    }
    case "voice.segment.ready": {
      const v = payload as {
        segmentId?: string;
        ordinal?: number;
        text?: string;
        textSha256?: string;
      };
      if (
        typeof v.ordinal !== "number" ||
        !Number.isInteger(v.ordinal) ||
        v.ordinal < 1 ||
        v.ordinal > 20 ||
        typeof v.segmentId !== "string" ||
        !/^[a-f0-9]{64}$/.test(v.segmentId) ||
        typeof v.text !== "string" ||
        v.text.length < 1 ||
        v.text.length > 160 ||
        typeof v.textSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(v.textSha256)
      ) {
        return null;
      }
      return {
        dispatch: {
          type: "voice.segments",
          seq,
          runId: args.runId,
          generation: args.generation,
          accountEpoch,
          conversationId: args.event.conversationId ?? "",
          segment: {
            ordinal: v.ordinal,
            segmentId: v.segmentId,
            text: v.text,
            conversationId: args.event.conversationId ?? "",
          },
        },
        accumulatedText: args.accumulatedText,
      };
    }
    case "assistant.final":
      return {
        dispatch: {
          type: "assistant.final",
          seq,
          runId: args.runId,
          generation: args.generation,
          accountEpoch,
          messageId: payload.messageId ?? "",
          text: args.accumulatedText,
          textSha256: payload.textSha256 ?? "",
        },
        accumulatedText: args.accumulatedText,
      };
    case "character.cue": {
      // §4.4 wire cue：服务端只下发受控 intent/emotion/intensity；用 wire
      // schema 重新校验（fail closed），事件级 generation 附在 cue 上供 reducer
      // 做过期守卫（不参与 turn seq 排序——cue 是表现层建议，非对话真相）。
      const parsed = companionCharacterCueV1Schema.safeParse((payload as { cue?: unknown }).cue);
      if (!parsed.success) return null;
      return {
        dispatch: {
          type: "character.cue",
          seq,
          runId: args.runId,
          generation: args.generation,
          accountEpoch,
          cue: parsed.data,
        },
        accumulatedText: args.accumulatedText,
      };
    }
    case "turn.cancelled":
      return {
        dispatch: {
          type: "turn.cancelled",
          seq,
          runId: args.runId,
          generation: args.generation,
          accountEpoch,
        },
        accumulatedText: args.accumulatedText,
      };
    case "action.completed": {
      const actionRunId = (payload as { actionRunId?: unknown }).actionRunId;
      const safeSummary = (payload as { safeSummary?: unknown }).safeSummary;
      if (
        typeof actionRunId !== "string" ||
        !UUID_PATTERN.test(actionRunId) ||
        typeof safeSummary !== "string" ||
        safeSummary.length < 1 ||
        safeSummary.length > 240
      ) return null;
      const rawRoute = (payload as { route?: unknown }).route;
      const route = rawRoute == null ? null : allowedMainRouteV1Schema.safeParse(rawRoute);
      return {
        dispatch: {
          type: "action.completed",
          seq,
          runId: args.runId,
          generation: args.generation,
          accountEpoch,
          actionRunId,
          resultRef: (payload as { resultRef?: string | null }).resultRef ?? null,
          route: route === null ? null : route.success ? route.data : null,
          safeSummary,
        },
        accumulatedText: args.accumulatedText,
      };
    }
    case "action.failed": {
      const actionRunId = (payload as { actionRunId?: unknown }).actionRunId;
      const code = (payload as { code?: unknown }).code;
      if (
        typeof actionRunId !== "string" ||
        !UUID_PATTERN.test(actionRunId) ||
        typeof code !== "string" ||
        code.length < 1 ||
        code.length > 80
      ) return null;
      return {
        dispatch: {
          type: "action.failed",
          seq,
          runId: args.runId,
          generation: args.generation,
          accountEpoch,
          actionRunId,
          code,
          recoverable: (payload as { recoverable?: unknown }).recoverable === true,
        },
        accumulatedText: args.accumulatedText,
      };
    }
    case "error":
      return {
        dispatch: {
          type: "turn.failed",
          seq,
          runId: args.runId,
          generation: args.generation,
          code: payload.code ?? "INTERNAL_ERROR",
          recoverable: payload.recoverable ?? true,
        },
        accumulatedText: args.accumulatedText,
      };
    default:
      // Character/action/proactive events have their own consumers. A P2
      // text client must consume the cursor without turning an unknown-but-
      // valid event into a false turn failure.
      return null;
  }
}

export function createCompanionChatClient(scope?: CompanionScope): CompanionChatClientV1 {
  const key = scopeKey(scope);
  return {
    async ensureDialogue(): Promise<string> {
      const cached = cachedConversationIds.get(key) ?? readStoredConversationId(key);
      if (cached) cachedConversationIds.set(key, cached);
      if (cached) return cached;
      const inFlight = inFlightConversationIds.get(key);
      if (inFlight) return inFlight;
      const request = (async () => {
        const response = await fetch("/api/companion/conversations", {
          method: "POST",
          credentials: "same-origin",
          headers: companionMutationHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ version: 1, kind: "dialogue" }),
        });
        if (!response.ok) throw new Error(`ensureDialogue failed: ${response.status}`);
        const body = (await response.json()) as { id?: string };
        if (!body.id || !UUID_PATTERN.test(body.id)) throw new Error("ensureDialogue returned invalid id");
        rememberConversationId(key, body.id);
        return body.id;
      })();
      inFlightConversationIds.set(key, request);
      try {
        return await request;
      } finally {
        inFlightConversationIds.delete(key);
      }
    },

    async restoreDialogue(signal) {
      const cached = cachedConversationIds.get(key) ?? readStoredConversationId(key);
      if (cached) {
        const response = await fetch(`/api/companion/conversations/${cached}`, {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal,
        });
        if (response.status === 404) {
          resetCompanionChatClientCache(scope);
        } else {
          if (!response.ok) throw new Error(`restoreDialogue failed: ${response.status}`);
          const parsed = companionConversationSnapshotV1Schema.safeParse(await response.json());
          if (!parsed.success) throw new Error("restoreDialogue returned an invalid snapshot");
          rememberConversationId(key, parsed.data.conversation.id);
          return parsed.data;
        }
      }

      // A fresh renderer on another tab/device may not have the local id. Do
      // not create a conversation during recovery; only adopt the newest
      // existing active dialogue and let the next submit create one if none exists.
      const listResponse = await fetch(
        "/api/companion/conversations?limit=1&kind=dialogue&status=active",
        {
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal,
        },
      );
      if (!listResponse.ok) throw new Error(`restoreDialogue list failed: ${listResponse.status}`);
      const listBody = await listResponse.json() as { items?: unknown };
      const first = Array.isArray(listBody.items) ? listBody.items[0] : null;
      const conversationId = first && typeof first === "object" && "id" in first && typeof first.id === "string" && UUID_PATTERN.test(first.id)
        ? first.id
        : null;
      if (!conversationId) return null;
      rememberConversationId(key, conversationId);

      const snapshotResponse = await fetch(`/api/companion/conversations/${conversationId}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal,
      });
      if (snapshotResponse.status === 404) {
        resetCompanionChatClientCache(scope);
        return null;
      }
      if (!snapshotResponse.ok) throw new Error(`restoreDialogue snapshot failed: ${snapshotResponse.status}`);
      const parsed = companionConversationSnapshotV1Schema.safeParse(await snapshotResponse.json());
      if (!parsed.success) throw new Error("restoreDialogue returned an invalid snapshot");
      rememberConversationId(key, parsed.data.conversation.id);
      return parsed.data;
    },

    async submitTurn(args) {
      const response = await fetch(`/api/companion/conversations/${args.conversationId}/turns`, {
        method: "POST",
        credentials: "same-origin",
        headers: companionMutationHeaders({
          "Content-Type": "application/json",
          "Idempotency-Key": args.idempotencyKey,
        }),
        body: JSON.stringify({
          version: 1,
          clientMessageId: args.clientMessageId,
          inputKind: args.voiceArtifactId ? "voice_transcript" : "text",
          blocks: [{ type: "text", text: args.text }],
          ...(args.voiceArtifactId ? { voiceArtifactId: args.voiceArtifactId } : {}),
          sourceSurface: args.sourceSurface ?? "pet",
          ...(args.context ? { context: args.context } : {}),
        }),
        signal: args.signal,
      });
      const rawBody = await response.json().catch(() => null);
      if (response.status === 404) resetCompanionChatClientCache(scope);
      const parsed = createCompanionTurnResponseV1Schema.safeParse(rawBody);
      if (response.ok && !parsed.success) throw new Error("submitTurn returned an invalid response");
      return {
        statusCode: response.status,
        body: parsed.success ? parsed.data : rawBody as SubmitCompanionTurnBody,
      };
    },

    async cancelRun(args) {
      const response = await fetch(`/api/companion/runs/${args.runId}/cancel`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: companionMutationHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
        body: JSON.stringify({ version: 1, generation: args.generation, reason: "user" }),
        signal: args.signal,
      });
      const parsed = cancelCompanionRunResponseV1Schema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new Error(`cancelRun failed: ${response.status}`);
      return { statusCode: response.status, body: parsed.data };
    },

    streamEvents(args) {
      let accumulated = args.initialText ?? "";
      let cursor = args.after;
      let lastEventId: string | null = null;

      let retries = 0;
      let eventsSinceOpen = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const open = () => {
        if (args.signal.aborted) return;
        void openCompanionSse({
          conversationId: args.conversationId,
          after: cursor,
          lastEventId,
          signal: args.signal,
          callbacks: {
            onOpen() {
              // 只有"上一次连接收到过至少一个事件"（连接被证明健康）才重置
              // 重试预算；否则"每次 onOpen 后 0 事件立即断开"的空连接循环会
              // 无限重连。长空闲连接由服务端 15s heartbeat 维持，不依赖此重置。
              if (eventsSinceOpen > 0) retries = 0;
              eventsSinceOpen = 0;
            },
            onEvent(event) {
              // A successful event proves the connection is healthy. Do not
              // let transient failures from an earlier connection consume the
              // retry budget for the rest of a long-lived conversation.
              retries = 0;
              eventsSinceOpen += 1;
              const seqNum = seqFromEventId(event.id);
              // Cursor advancement is independent from UI mapping: stale or
              // currently-unhandled action/cue events must be consumed, or a
              // reconnect would replay the same event forever.
              if (seqNum > cursor) cursor = seqNum;
              lastEventId = event.id;
              if (
                !args.includeActionEvents &&
                (event.type === "action.completed" || event.type === "action.failed")
              ) return;
              const mapped = mapCompanionSseEvent({
                event,
                runId: args.runId,
                generation: args.generation,
                accumulatedText: accumulated,
              });
              if (!mapped) return;
              accumulated = mapped.accumulatedText;
              args.onDispatch(mapped.dispatch);
            },
            onError(error) {
              const retryable = ["network", "server", "rate_limited"].includes(error.kind);
              const exhausted = !retryable || retries >= 5;
              args.onError?.(error.kind, exhausted);
              if (args.signal.aborted) return;
              if (!retryable || retries >= 5) return;
              const retryDelay = error.retryAfterMs ?? Math.min(1000 * 2 ** retries, 10_000);
              retries += 1;
              timer = setTimeout(open, retryDelay);
            },
          },
        });
      };

      args.signal.addEventListener("abort", () => {
        if (timer) clearTimeout(timer);
      }, { once: true });
      open();
    },
  };
}
