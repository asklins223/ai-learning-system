/**
 * P2 companion SSE wake-up listener（03 §5.4）。
 *
 * - API 每进程只保留一个 PostgreSQL LISTEN 连接（conversation channel
 *   `ailearn_companion_events_v1` + account channel
 *   `ailearn_companion_account_v1`），再 fan-out 到本进程 subscriber；
 * - NOTIFY payload 只含 conversationId/maxSeq，不含正文；
 * - postgres-js 的 listen 在断线后自动重连并重新 LISTEN；
 * - NOTIFY 只是低延迟 wake hint——SSE 每连接另有 1s durable poll 兜底。
 */

import postgres from "postgres";

const CHANNEL = "ailearn_companion_events_v1";
export const COMPANION_ACCOUNT_NOTIFY_CHANNEL = "ailearn_companion_account_v1";

export interface CompanionNotifyPayload {
  conversationId: string;
  maxSeq: number;
}

export interface CompanionAccountNotifyPayload {
  userId: string;
  epoch: number;
}

type Subscriber = (payload: CompanionNotifyPayload) => void;
type AccountSubscriber = (payload: CompanionAccountNotifyPayload) => void;

const subscribersByConversation = new Map<string, Set<Subscriber>>();
const accountSubscribersByUser = new Map<string, Set<AccountSubscriber>>();
let notifyConnection: postgres.Sql | null = null;
let started = false;

function fanOut(payload: CompanionNotifyPayload): void {
  const set = subscribersByConversation.get(payload.conversationId);
  if (!set || set.size === 0) return;
  for (const cb of set) {
    try {
      cb(payload);
    } catch {
      // subscriber 异常不得影响其他订阅者或 listener 本身
    }
  }
}

function fanOutAccount(payload: CompanionAccountNotifyPayload): void {
  const set = accountSubscribersByUser.get(payload.userId);
  if (!set || set.size === 0) return;
  for (const cb of set) {
    try {
      cb(payload);
    } catch {
      // subscriber 异常不得影响其他订阅者或 listener 本身
    }
  }
}

/** 启动进程级单 listener（幂等）。connectionString 由调用方传入（api 连接串）。 */
export function startCompanionNotifyListener(connectionString: string): void {
  if (started) return;
  started = true;
  const sql = postgres(connectionString, { max: 1 });
  notifyConnection = sql;
  void sql
    .listen(CHANNEL, (message: string) => {
      try {
        const parsed = JSON.parse(message) as Partial<CompanionNotifyPayload>;
        if (typeof parsed.conversationId === "string" && typeof parsed.maxSeq === "number") {
          fanOut(parsed as CompanionNotifyPayload);
        }
      } catch {
        // 畸形 payload 忽略（NOTIFY 只作 hint）
      }
    })
    .then(() => sql.listen(COMPANION_ACCOUNT_NOTIFY_CHANNEL, (message: string) => {
      try {
        const parsed = JSON.parse(message) as Partial<CompanionAccountNotifyPayload>;
        if (
          typeof parsed.userId === "string" &&
          typeof parsed.epoch === "number" &&
          Number.isInteger(parsed.epoch) &&
          parsed.epoch >= 0
        ) {
          fanOutAccount(parsed as CompanionAccountNotifyPayload);
        }
      } catch {
        // 畸形 payload 忽略（NOTIFY 只作 hint）
      }
    }))
    .catch((err: unknown) => {
      // 初始 LISTEN 失败：启动失败不应导致进程崩溃——SSE 的 poll 兜底仍可工作。
      // 必须显式 end() 释放底层 postgres 连接，否则该连接在进程生命周期内泄漏。
      started = false;
      notifyConnection = null;
      console.warn("[companion] NOTIFY listener start failed", err);
      void sql.end().catch(() => undefined);
    });
}

export function subscribeCompanionEvents(
  conversationId: string,
  cb: Subscriber,
): () => void {
  let set = subscribersByConversation.get(conversationId);
  if (!set) {
    set = new Set();
    subscribersByConversation.set(conversationId, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) subscribersByConversation.delete(conversationId);
  };
}

/**
 * 2026-08-11：优雅关闭——NOTIFY listener 的 postgres 连接若不显式 end，
 * socket 保持事件循环非空，app.close() 完成后进程永不退出（编排器只能
 * SIGKILL，"优雅关闭"名存实亡）。幂等；重复调用安全。
 */
export function stopCompanionNotifyListener(): void {
  void notifyConnection?.end({ timeout: 1 }).catch(() => {});
  notifyConnection = null;
  started = false;
  subscribersByConversation.clear();
  accountSubscribersByUser.clear();
}

/** 测试用：重置单例（仅测试进程调用）。 */
export function resetCompanionNotifyListenerForTests(): void {
  void notifyConnection?.end({ timeout: 1 }).catch(() => {});
  notifyConnection = null;
  started = false;
  subscribersByConversation.clear();  accountSubscribersByUser.clear();
}

/** 测试用：向当前进程 fan-out 一条通知（模拟 NOTIFY 到达）。 */
export function emitCompanionNotifyForTests(payload: CompanionNotifyPayload): void {
  fanOut(payload);
}

export function subscribeCompanionAccountEvents(
  userId: string,
  cb: AccountSubscriber,
): () => void {
  let set = accountSubscribersByUser.get(userId);
  if (!set) {
    set = new Set();
    accountSubscribersByUser.set(userId, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) accountSubscribersByUser.delete(userId);
  };
}

/** 测试用：模拟一条跨进程账号 epoch 通知。 */
export function emitCompanionAccountNotifyForTests(payload: CompanionAccountNotifyPayload): void {
  fanOutAccount(payload);
}
