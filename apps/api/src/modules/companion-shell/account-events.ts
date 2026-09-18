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
  /** 返回 false 表示 socket 背压/已关闭；void 仅兼容不暴露写状态的测试 writer。 */
  write(chunk: string): boolean | void;
  onAbort(cb: () => void): void;
  close(): void;
}

export type CompanionAccountEventStreamResult =
  | { statusCode: 200; stream: { start(): void; close(): void } }
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
  // 修复（2026-09 后端审查）：close 提升到 try 外，使 catch 也能复用同一幂等
  // 释放路径（避免失败路径二次 releaseAccountSlot，削弱每用户 6 连接上限）。
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pending: CompanionAccountNotifyPayload[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    unsubscribe?.();
    pending = [];
    releaseAccountSlot(args.userId);
    args.writer.close();
  };
  try {
    // Read after subscribing so an event committed during this bootstrap is
    // buffered instead of being lost between the query and LISTEN fan-out.
    let started = false;
    let lastSentEpoch = resolved.after;

    const writeIfNew = (payload: CompanionAccountNotifyPayload): void => {
      if (closed || payload.userId !== args.userId || payload.epoch <= lastSentEpoch) return;
      if (args.writer.write(formatCompanionAccountGlobalOffSse(payload)) === false) {
        close();
        return;
      }
      lastSentEpoch = payload.epoch;
    };

    unsubscribe = subscribeCompanionAccountEvents(args.userId, (payload) => {
      if (!started) pending.push(payload);
      else writeIfNew(payload);
    });

    // R7（round-3 审计）：onAbort(close) 必须在第一个可中断的 await
    // （getCompanionOverview 的 DB 读）之前注册。原实现先 await 再 onAbort，
    // 若客户端在 await 期间断开，Node 的 'close' 已被消费、不再回调后注册的
    // 监听器 → close() 永不执行 → 账号槽位（每进程 6）与 NOTIFY 订阅永久泄漏
    // → 触发 429。close 幂等（closed 守卫），即使先于 subscribe/start 触发也安全
    // （unsubscribe/Pending 均可空）。
    args.writer.onAbort(close);

    const currentAccount = (await getCompanionOverview(args.userId, args.workspaceId)).account;
    const initialEpoch =
      !currentAccount.globalEnabled && currentAccount.epoch > resolved.after
        ? currentAccount.epoch
        : null;

    return {
      statusCode: 200,
      stream: {
        start() {
          if (started || closed) return;
          started = true;
          if (initialEpoch != null) writeIfNew({ userId: args.userId, epoch: initialEpoch });
          for (const payload of pending) {
            if (closed) break;
            writeIfNew(payload);
          }
          pending = [];
          // Send a frame immediately. Besides keeping direct connections
          // alive, this makes upstream fetch/rewrite layers flush the SSE
          // headers instead of waiting for the first 15-second heartbeat or
          // a business event.
          if (!closed && args.writer.write(`: heartbeat ${Date.now()}\n\n`) === false) close();
          if (closed) return;
          heartbeatTimer = setInterval(() => {
            if (!closed && args.writer.write(`: heartbeat ${Date.now()}\n\n`) === false) close();
          }, 15_000);
        },
        close,
      },
    };
  } catch {
    // 修复（2026-09 后端审查）：失败路径必须走 close()——它带 closed 幂等守卫
    // 并负责 unsubscribe/清 pending/释放槽位。此前 catch 里手动 release 后再等
    // req.raw 的 'close' 事件（500 响应后仍会触发）二次 release，把每用户计数
    // 递减到低于真实连接数，6 连接上限被削弱。
    close();
    return { statusCode: 500, error: { code: "INTERNAL_ERROR", message: "account event stream failed" } };
  }
}
