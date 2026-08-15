/**
 * Inbox 订阅 hook（文档 16 §14.3）：SSE 续传 + 单租约展示 + ACK。
 *
 * 同一时刻最多展示一条（§10.2）；lease 冲突（其他设备展示中）自动跳过；
 * 断线按 Last-Event-ID 续传；401/403 停止，其余错误退避重连。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ackDelivery,
  claimDeliveryLease,
  deviceSessionId,
  leaseToken,
  openInboxSse,
  persistInboxCursor,
  readInboxCursor,
  type AssistantDeliveryV2,
} from "./delivery-client";

export type DeliveryDisplayState =
  | { kind: "idle" }
  | { kind: "claiming" }
  | { kind: "showing"; delivery: AssistantDeliveryV2; leaseToken: string };

export interface UseDeliveryInboxResult {
  display: DeliveryDisplayState;
  dismiss: (snoozeMinutes?: number) => Promise<void>;
  acted: () => Promise<void>;
}

const RECONNECT_MS = 5_000;
const RECONNECT_MAX_MS = 30_000;
const CLAIM_TIMEOUT_MS = 8_000;

export function useDeliveryInbox(enabled: boolean): UseDeliveryInboxResult {
  const [display, setDisplay] = useState<DeliveryDisplayState>({ kind: "idle" });
  const displayRef = useRef<DeliveryDisplayState>({ kind: "idle" });
  const pendingRef = useRef<AssistantDeliveryV2[]>([]);
  const cursorRef = useRef<number>(readInboxCursor());
  const sessionIdRef = useRef<string>(deviceSessionId());
  const claimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // F6：当前 in-flight SSE 的 AbortController——卸载/重连前必须 abort，否则
  // 卸载后残留打开的 SSE 连接 + 卸载后状态更新。
  const streamControllerRef = useRef<AbortController | null>(null);
  // F19：重连退避次数——成功连接（onOpen）后重置，未重置前以其为指数退避基数。
  const reconnectAttemptRef = useRef(0);

  const setDisplayState = useCallback((next: DeliveryDisplayState) => {
    displayRef.current = next;
    setDisplay(next);
  }, []);

  const tryShowNext = useCallback(async () => {
    if (displayRef.current.kind === "showing" || displayRef.current.kind === "claiming") return;
    const next = pendingRef.current.shift();
    if (!next) {
      setDisplayState({ kind: "idle" });
      return;
    }
    // 服务端已过期/终态/被其他设备处理：直接跳过。
    if (next.state === "expired" || next.state === "suppressed"
      || next.state === "acted" || next.state === "dismissed") {
      persistInboxCursor(next.inboxSequence);
      void tryShowNext();
      return;
    }
    setDisplayState({ kind: "claiming" });
    const token = leaseToken();
    let claimed: AssistantDeliveryV2;
    try {
      claimed = await claimDeliveryLease(next.deliveryId, {
        deviceSessionId: sessionIdRef.current,
        leaseToken: token,
      });
    } catch {
      // lease_conflict（其他设备展示中）/过期/网络失败：跳过本条，不阻塞后续。
      persistInboxCursor(next.inboxSequence);
      setDisplayState({ kind: "idle" });
      void tryShowNext();
      return;
    }
    // 展示租约有效期 30s；超时未操作自动视作展示完毕（服务端到期失效）。
    // claim 失败已在 catch 分支 return；此处必定处于 claiming 态。
    if (claimTimerRef.current !== null) clearTimeout(claimTimerRef.current);
    claimTimerRef.current = setTimeout(() => {
      void ackDelivery(claimed.deliveryId, {
        inboxSequence: claimed.inboxSequence,
        deviceSessionId: sessionIdRef.current,
        leaseToken: token,
        transition: "displayed",
      }).catch(() => {}).finally(() => {
        persistInboxCursor(claimed.inboxSequence);
        setDisplayState({ kind: "idle" });
        void tryShowNext();
      });
    }, CLAIM_TIMEOUT_MS);
    setDisplayState({ kind: "showing", delivery: claimed, leaseToken: token });
    // 已展示：ACK displayed（幂等；失败不阻塞展示，由租约到期兜底）。
    void ackDelivery(claimed.deliveryId, {
      inboxSequence: claimed.inboxSequence,
      deviceSessionId: sessionIdRef.current,
      leaseToken: token,
      transition: "displayed",
    }).catch(() => {});
  }, [setDisplayState]);

  const finishCurrent = useCallback(async (transition: "acted" | "dismissed" | "snoozed", snoozeMinutes?: number) => {
    const current = displayRef.current;
    if (current.kind !== "showing") return;
    if (claimTimerRef.current !== null) {
      clearTimeout(claimTimerRef.current);
      claimTimerRef.current = null;
    }
    const { delivery, leaseToken: token } = current;
    const snoozedUntil = transition === "snoozed" && snoozeMinutes
      ? new Date(Date.now() + snoozeMinutes * 60 * 1000).toISOString()
      : undefined;
    await ackDelivery(delivery.deliveryId, {
      inboxSequence: delivery.inboxSequence,
      deviceSessionId: sessionIdRef.current,
      leaseToken: token,
      transition,
      snoozedUntil,
    }).catch(() => {});
    persistInboxCursor(delivery.inboxSequence);
    setDisplayState({ kind: "idle" });
    void tryShowNext();
  }, [setDisplayState, tryShowNext]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = () => {
      if (cancelled) return;
      // F19：指数退避——5s → 10s → 20s → 30s（封顶），成功连接后 onOpen 重置。
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(RECONNECT_MS * (2 ** attempt), RECONNECT_MAX_MS);
      reconnectAttemptRef.current += 1;
      retryTimer = setTimeout(() => { if (!cancelled) void connect(); }, delay);
    };

    const connect = async (): Promise<void> => {
      if (cancelled) return;
      // F6：重连前 abort 前一个 in-flight SSE，避免叠加第二条连接。
      streamControllerRef.current?.abort();
      const controller = new AbortController();
      streamControllerRef.current = controller;
      const signal = controller.signal;
      try {
        await openInboxSse({
          after: cursorRef.current,
          signal,
          callbacks: {
            onOpen: () => {
              // 连接成功：重置退避计数。
              reconnectAttemptRef.current = 0;
              // 清空待处理队列中已被服务端标过期的项（原有语义）。
            },
            onDelivery: (delivery) => {
              if (cancelled || signal.aborted) return;
              cursorRef.current = Math.max(cursorRef.current, delivery.inboxSequence);
              persistInboxCursor(delivery.inboxSequence);
              pendingRef.current.push(delivery);
              void tryShowNext();
            },
            onError: (err) => {
              if (cancelled || signal.aborted) return;
              if (err.kind === "auth") return; // 会话失效：停止订阅（bootstrap 会处理）
              if (streamControllerRef.current === controller) {
                streamControllerRef.current = null;
                controller.abort();
              }
              scheduleReconnect();
            },
          },
        });
      } finally {
        // 流正常结束（服务端关闭/网络断开）：退避重连。
        if (!cancelled && !signal.aborted && streamControllerRef.current === controller) {
          streamControllerRef.current = null;
          scheduleReconnect();
        }
      }
    };

    void connect();
    return () => {
      cancelled = true;
      // F6：卸载时 abort in-flight SSE，并清理重连/鉴权定时器。
      streamControllerRef.current?.abort();
      streamControllerRef.current = null;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (claimTimerRef.current !== null) clearTimeout(claimTimerRef.current);
    };
  }, [enabled, tryShowNext]);

  return {
    display,
    dismiss: (snoozeMinutes) => finishCurrent("dismissed", snoozeMinutes),
    acted: () => finishCurrent("acted"),
  };
}
