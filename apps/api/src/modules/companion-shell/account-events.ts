/**
 * Account-wide Companion revocation SSE.
 *
 * This stream is intentionally small and content-free: it only carries the
 * account epoch fence needed to stop a desktop/browser surface after global
 * off. The durable account row remains the source of truth; PostgreSQL
 * LISTEN/NOTIFY is only the low-latency wake path and reconnect bootstrap is
 * checked before the stream starts.
 */

import { getCompanionOverview } from "./service.ts";
import {
  subscribeCompanionAccountEvents,
  type CompanionAccountNotifyPayload,
} from "../companion-conversation/companion-notify.ts";

const SLOTS_PER_ACCOUNT_USER = 6;
const accountSlots = new Map<string, number>();

function acquireAccountSlot(userId: string): boolean {
  const count = accountSlots.get(userId) ?? 0;
  if (count >= SLOTS_PER_ACCOUNT_USER) return false;
  accountSlots.set(userId, count + 1);
  return true;
}

function releaseAccountSlot(userId: string): void {
  const count = accountSlots.get(userId) ?? 0;
  if (count <= 1) accountSlots.delete(userId);
  else accountSlots.set(userId, count - 1);
}

export type AccountCursorResolution =
  | { ok: true; after: number }
  | { ok: false; code: "INVALID_CURSOR" };

export function resolveAccountCursor(args: {
  afterRaw: string | null | undefined;
  lastEventId: string | null | undefined;
  userId: string;
}): AccountCursorResolution {
  let after: number | null = null;
  if (args.afterRaw != null && args.afterRaw !== "") {
    const n = Number(args.afterRaw);
    if (!Number.isInteger(n) || n < 0) return { ok: false, code: "INVALID_CURSOR" };
    after = n;
  }
  if (args.lastEventId != null && args.lastEventId !== "") {
    const match = /^([0-9a-fA-F-]{36}):(\d+)$/.exec(args.lastEventId);
    if (!match || match[1].toLowerCase() !== args.userId.toLowerCase()) {
      return { ok: false, code: "INVALID_CURSOR" };
    }
    const n = Number(match[2]);
    if (!Number.isInteger(n) || n < 0) return { ok: false, code: "INVALID_CURSOR" };
    after = after == null ? n : Math.max(after, n);
  }
  return { ok: true, after: after ?? 0 };
}

export function formatCompanionAccountGlobalOffSse(args: {
  userId: string;
  epoch: number;
}): string {
  return [
    `id: ${args.userId}:${args.epoch}`,
    "event: companion.account",
    `data: ${JSON.stringify({
      version: 1,
      type: "account.global_off",
      userId: args.userId,
      epoch: args.epoch,
    })}`,
    "",
    "",
  ].join("\n");
}

export interface CompanionAccountEventStreamWriter {
  write(chunk: string): void;
  onAbort(cb: () => void): void;
  close(): void;
}

export type CompanionAccountEventStreamResult =
  | { statusCode: 200; stream: { start(): void } }
  | { statusCode: 400 | 429 | 500; error: { code: string; message: string } };

export async function openCompanionAccountEventStream(args: {
  workspaceId: string;
  userId: string;
  afterRaw: string | null | undefined;
  lastEventId: string | null | undefined;
  writer: CompanionAccountEventStreamWriter;
}): Promise<CompanionAccountEventStreamResult> {
  const resolved = resolveAccountCursor({
    afterRaw: args.afterRaw,
    lastEventId: args.lastEventId,
    userId: args.userId,
  });
  if (!resolved.ok) {
    return { statusCode: 400, error: { code: "INVALID_CURSOR", message: "invalid account cursor" } };
  }
  if (!acquireAccountSlot(args.userId)) {
    return { statusCode: 429, error: { code: "TOO_MANY_CONNECTIONS", message: "account SSE connection limit reached" } };
  }

  let unsubscribe: (() => void) | null = null;
  try {
    // Read after subscribing so an event committed during this bootstrap is
    // buffered instead of being lost between the query and LISTEN fan-out.
    let started = false;
    let closed = false;
    let lastSentEpoch = resolved.after;
    let pending: CompanionAccountNotifyPayload[] = [];
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const writeIfNew = (payload: CompanionAccountNotifyPayload) => {
      if (closed || payload.userId !== args.userId || payload.epoch <= lastSentEpoch) return;
      args.writer.write(formatCompanionAccountGlobalOffSse(payload));
      lastSentEpoch = payload.epoch;
    };

    unsubscribe = subscribeCompanionAccountEvents(args.userId, (payload) => {
      if (!started) pending.push(payload);
      else writeIfNew(payload);
    });

    const currentAccount = (await getCompanionOverview(args.userId, args.workspaceId)).account;
    const initialEpoch =
      !currentAccount.globalEnabled && currentAccount.epoch > resolved.after
        ? currentAccount.epoch
        : null;

    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      unsubscribe?.();
      pending = [];
      releaseAccountSlot(args.userId);
      args.writer.close();
    };
    // 2026-08-11：onAbort 在返回前注册（幂等 close）——此前只在 start() 内注册，
    // open() 返回后、start() 前连接断开时（Node 'close' 已触发不再回调）
    // close() 永不执行 → 每账号连接槽位与 NOTIFY 订阅泄漏，可被耗尽导致 429。
    args.writer.onAbort(close);

    return {
      statusCode: 200,
      stream: {
        start() {
          if (started || closed) return;
          started = true;
          if (initialEpoch != null) writeIfNew({ userId: args.userId, epoch: initialEpoch });
          for (const payload of pending) writeIfNew(payload);
          pending = [];
          // Send a frame immediately. Besides keeping direct connections
          // alive, this makes upstream fetch/rewrite layers flush the SSE
          // headers instead of waiting for the first 15-second heartbeat or
          // a business event.
          if (!closed) args.writer.write(`: heartbeat ${Date.now()}\n\n`);
          heartbeatTimer = setInterval(() => {
            if (!closed) args.writer.write(`: heartbeat ${Date.now()}\n\n`);
          }, 15_000);
          args.writer.onAbort(close);
        },
      },
    };
  } catch {
    unsubscribe?.();
    releaseAccountSlot(args.userId);
    return { statusCode: 500, error: { code: "INTERNAL_ERROR", message: "account event stream failed" } };
  }
}
