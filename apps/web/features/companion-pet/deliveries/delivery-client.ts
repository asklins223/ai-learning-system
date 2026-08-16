/**
 * Durable delivery 消费客户端（文档 16 §14.3）。
 *
 * Pet 窗口订阅 inbox SSE（Last-Event-ID 续传）→ claim display lease
 * （跨设备单租约）→ 展示 → ACK（displayed/acted/dismissed/snoozed）。
 * 只在 Electron 桌面端使用；浏览器路径不消费（桌宠默认不做 web 端）。
 */

import {
  assistantDeliveryV2Schema,
  type AssistantDeliveryV2,
} from "@ailearn/shared";
import { getCsrfToken } from "@/lib/api";
import { parseCompanionSseChunk } from "../conversation/fetch-sse";

export const INBOX_LAST_EVENT_ID_KEY = "pet:inbox:lastEventId";
export const PET_DEVICE_SESSION_ID_KEY = "pet:deviceSessionId";

export function deviceSessionId(): string {
  if (typeof window === "undefined") return "browser";
  let stored = window.localStorage.getItem(PET_DEVICE_SESSION_ID_KEY);
  if (!stored) {
    stored = crypto.randomUUID();
    window.localStorage.setItem(PET_DEVICE_SESSION_ID_KEY, stored);
  }
  return stored;
}

export function leaseToken(): string {
  return crypto.randomUUID();
}

export function readInboxCursor(): number {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(INBOX_LAST_EVENT_ID_KEY);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function persistInboxCursor(sequence: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(INBOX_LAST_EVENT_ID_KEY, String(sequence));
}

export class DeliveryClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DeliveryClientError";
    this.status = status;
    this.code = code;
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function mutation(
  url: string,
  body: unknown,
  label: string,
): Promise<unknown> {
  const csrf = getCsrfToken();
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await readJson(response);
  if (!response.ok) {
    const code =
      typeof json === "object" && json && "error" in json && typeof json.error === "string"
        ? json.error
        : "DELIVERY_REQUEST_FAILED";
    throw new DeliveryClientError(response.status, code, `${label}失败`);
  }
  return json;
}

export async function claimDeliveryLease(
  deliveryId: string,
  input: { deviceSessionId: string; leaseToken: string },
): Promise<AssistantDeliveryV2> {
  const json = await mutation(
    `/api/companion/deliveries/${encodeURIComponent(deliveryId)}/lease`,
    {
      version: 2,
      deviceSessionId: input.deviceSessionId,
      leaseToken: input.leaseToken,
      idempotencyKey: `lease:${deliveryId}:${input.leaseToken}`,
    },
    "展示确认",
  );
  const parsed = assistantDeliveryV2Schema.safeParse(json);
  if (!parsed.success) throw new DeliveryClientError(502, "INVALID_DELIVERY", "交付响应非法");
  return parsed.data;
}

export async function ackDelivery(
  deliveryId: string,
  input: {
    inboxSequence: number;
    deviceSessionId: string;
    leaseToken: string;
    transition: "displayed" | "acted" | "dismissed" | "snoozed";
    snoozedUntil?: string;
  },
): Promise<AssistantDeliveryV2 | null> {
  const json = await mutation(
    `/api/companion/deliveries/${encodeURIComponent(deliveryId)}/ack`,
    {
      version: 2,
      deliveryId,
      inboxSequence: input.inboxSequence,
      deviceSessionId: input.deviceSessionId,
      leaseToken: input.leaseToken,
      transition: input.transition,
      snoozedUntil: input.snoozedUntil,
      idempotencyKey: `ack:${deliveryId}:${input.leaseToken}:${input.transition}`,
    },
    "消息确认",
  );
  const parsed = assistantDeliveryV2Schema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data;
}

export interface InboxSseCallbacks {
  onDelivery(delivery: AssistantDeliveryV2): void;
  onError(err: { kind: "auth" | "server" | "network" | "fatal_parse" }): void;
  onOpen?(): void;
}

/**
 * 打开 inbox SSE 并解析 assistant.delivery 事件。
 * 不重试；断开后由调用方按 cursor 重连。返回最终已确认的 sequence。
 */
export async function openInboxSse(args: {
  after: number;
  signal: AbortSignal;
  callbacks: InboxSseCallbacks;
  idleTimeoutMs?: number;
}): Promise<void> {
  const idleTimeoutMs = args.idleTimeoutMs ?? 60_000;
  const url = new URL("/api/companion/deliveries/inbox/stream", window.location.origin);
  url.searchParams.set("after", String(args.after));
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  const local = new AbortController();
  const onExternalAbort = (): void => {
    if (!local.signal.aborted) local.abort(args.signal.reason);
  };
  args.signal.addEventListener("abort", onExternalAbort, { once: true });

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleFired = false;
  const armIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      local.abort(new Error("inbox sse idle timeout"));
      args.callbacks.onError({ kind: "network" });
    }, idleTimeoutMs);
  };
  const disarmIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };

  try {
    armIdle();
    const response = await fetch(url.toString(), {
      credentials: "same-origin",
      headers,
      signal: local.signal,
    });
    if (response.status === 401 || response.status === 403) {
      args.callbacks.onError({ kind: "auth" });
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
    args.callbacks.onOpen?.();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const reader = response.body?.getReader();
    if (!reader) {
      args.callbacks.onError({ kind: "network" });
      return;
    }
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) armIdle();
      let text: string;
      try {
        text = decoder.decode(value, { stream: true });
      } catch {
        args.callbacks.onError({ kind: "fatal_parse" });
        await reader.cancel().catch(() => {});
        return;
      }
      const parsed = parseCompanionSseChunk(buffer, text, 64 * 1024);
      buffer = parsed.buffer;
      if (parsed.fatal) {
        args.callbacks.onError({ kind: "fatal_parse" });
        await reader.cancel().catch(() => {});
        return;
      }
      for (const event of parsed.events) {
        if (event.event !== "assistant.delivery") continue;
        if (!event.id) continue;
        try {
          const delivery = assistantDeliveryV2Schema.safeParse(JSON.parse(event.data));
          if (!delivery.success) {
            args.callbacks.onError({ kind: "fatal_parse" });
            await reader.cancel().catch(() => {});
            return;
          }
          args.callbacks.onDelivery(delivery.data);
        } catch {
          args.callbacks.onError({ kind: "fatal_parse" });
          await reader.cancel().catch(() => {});
          return;
        }
      }
    }
    try {
      decoder.decode();
    } catch {
      args.callbacks.onError({ kind: "fatal_parse" });
      await reader.cancel().catch(() => {});
      return;
    }
    if (buffer.trim().length > 0) {
      args.callbacks.onError({ kind: "fatal_parse" });
      return;
    }
    if (!args.signal.aborted && !idleFired) args.callbacks.onError({ kind: "network" });
  } catch {
    if (!args.signal.aborted && !idleFired) args.callbacks.onError({ kind: "network" });
  } finally {
    disarmIdle();
    args.signal.removeEventListener("abort", onExternalAbort);
  }
}

/** 按 payloadRef 生成保守展示（当前确定性最小闭环；模型表达层接好后替换）。 */
export function deliverySummary(delivery: AssistantDeliveryV2): { title: string; body: string } {
  switch (delivery.kind) {
    case "system_event": {
      const eventId = delivery.payloadRef.kind === "system_event"
        ? delivery.payloadRef.systemEventId
        : "";
      const text = delivery.payloadRef.kind === "system_event"
        ? delivery.payloadRef.text
        : undefined;
      if (text) return { title: "伴星提醒", body: text };
      if (eventId.startsWith("run.completed:")) {
        const runId = eventId.slice("run.completed:".length);
        return runId
          ? { title: "一次学习已结算完成", body: "刚才的巩固已有结果，可以查看。" }
          : { title: "学习结算完成", body: "刚才的巩固已有结果。" };
      }
      return { title: "伴星消息", body: "有一条新的消息。" };
    }
    case "message":
      return { title: "伴星消息", body: "伴星给你留了一条消息。" };
    case "proposal":
      return { title: "操作建议", body: "伴星有一个操作建议，等待你的确认。" };
    case "action_result":
      return { title: "操作已完成", body: "刚才的操作已经完成。" };
    case "proactive_cue": {
      const text = delivery.payloadRef.kind === "proactive_cue"
        ? delivery.payloadRef.text
        : undefined;
      return { title: "伴星提醒", body: text ?? "伴星想提醒你一件事。" };
    }
    case "memory_candidate":
      return { title: "记忆待确认", body: "伴星记住了一条新信息，等待你确认。" };
    default:
      return { title: "伴星消息", body: "有一条新的消息。" };
  }
}

/** system_event run.completed 的 runId 提取（无则 null）。 */
export function deliveryRunRef(delivery: AssistantDeliveryV2): string | null {
  if (delivery.kind !== "system_event") return null;
  const eventId = delivery.payloadRef.kind === "system_event"
    ? delivery.payloadRef.systemEventId
    : "";
  if (!eventId.startsWith("run.completed:")) return null;
  const runId = eventId.slice("run.completed:".length);
  return /^[0-9a-f-]{36}$/i.test(runId) ? runId : null;
}

export type { AssistantDeliveryV2 };
