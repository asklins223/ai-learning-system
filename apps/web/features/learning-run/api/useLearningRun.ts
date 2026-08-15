/**
 * useLearningRun：统一 LearningRunPlayer 的生产数据 hook（P3 接线）。
 *
 * 消费 /learning-runs API（§13.1）：
 * - load：GET 快照（ETag/revision）；
 * - dispatch：严格 action union（每次携带当前 revision/epoch CAS）；
 * - submit：原子 submission（202 locked + queued）；
 * - draft：PUT/DELETE（CAS expectedDraftRevision）；
 * - stream：SSE 订阅（Last-Event-ID 重放，断线后重新订阅）；
 * - lease：页面可见且 active 时每 15 秒续租（§13.3）。
 *
 * 前端不自行推断 mastery/schedule：phase/result 一律以服务端 snapshot 为准；
 * 动作冲突（409 stale_run_revision 等）时自动重读快照。
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type {
  CreateLearningRunRequestV1,
  LearningRunActionV1,
  LearningRunPublicV1,
  SubmitTaskArtifactV1,
} from "@ailearn/shared";
import {
  parseSseChunk,
  subscribeLearningRunEvents,
} from "./sse";

export type LearningRunHookStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "streaming";

export interface LearningRunHook {
  snapshot: LearningRunPublicV1 | null;
  status: LearningRunHookStatus;
  error: string | null;
  load: (runId: string) => Promise<void>;
  create: (input: CreateLearningRunRequestV1) => Promise<LearningRunPublicV1>;
  dispatchAction: (action: LearningRunActionV1, idempotencyKey?: string) => Promise<void>;
  submit: (taskId: string, request: Omit<SubmitTaskArtifactV1, "runRevision" | "taskRevision" | "idempotencyKey">) => Promise<void>;
  saveDraft: (taskId: string, input: { variantId: string; variantRevision: number; taskRevision: number; expectedDraftRevision: number | null; payload: unknown; rendererState: unknown }) => Promise<number | null>;
  clearDraft: (taskId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const LEASE_INTERVAL_MS = 15_000;
/** 快照轮询间隔：评估结算延迟可容忍（低频率、轻量 GET）。 */
const POLL_INTERVAL_MS = 2_000;
/** SSE 断线指数退避：起始延迟、封顶延迟；抖动取 ±50% 均匀分布。 */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** SSE 驱动刷新防抖窗口：突发事件合并为一次快照重读。 */
const SSE_REFRESH_DEBOUNCE_MS = 150;

/**
 * 快照浅等比较：仅当 CAS 字段（revision）或影响播放器渲染表面的字段
 * （phase/activeTask.taskId/activeSecondsUsed/result）变化时才认为"已变"。
 * 静态区间（preparing/assessing）服务端数据不变时返回 false，
 * 让调用方复用前一次快照引用，避免每 2s 全量重渲（含 WebGPU LiquidOrb）。
 *
 * result（第八轮 🟡B-2）：按【值】稳定比较而非引用。结算/committing 段服务端
 * 每 2s 返回全新 result 引用，若按引用比较守卫恒 false → 每 2s setSnapshot
 * 重渲并传导到 LiquidOrb。当 result 字段内容未变（同值新引用）时复用前引用，
 * 仅当内容确实变化才判不等。
 */
export function snapshotEqualSurface(
  a: LearningRunPublicV1 | null,
  b: LearningRunPublicV1 | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.revision !== b.revision) return false;
  if (a.phase !== b.phase) return false;
  const at = a.activeTask;
  const bt = b.activeTask;
  if ((at?.taskId ?? null) !== (bt?.taskId ?? null)) return false;
  if (a.activeSecondsUsed !== b.activeSecondsUsed) return false;
  // 终态/结算结果按值稳定比较：null==null；一方 null 一方有值 → 不等；
  // 双方非 null → 递归值比较，值相同（同值新引用）则视为末帧稳定。
  if ((a.result ?? null) !== (b.result ?? null)) {
    if (a.result === null || b.result === null) return false;
    if (!resultStableEqual(a.result, b.result)) return false;
  }
  return true;
}

/** result 字段的结构化值比较（结算数据有界、低频，递归比较安全且简单）。 */
function resultStableEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!resultStableEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    const ak = Object.keys(a);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!resultStableEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/** 指数退避（1s→30s）+ 抖动：返回下次重连延迟。 */
function nextBackoffDelay(attempt: number) {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
  // 抖动：±50%。
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

export function useLearningRun(): LearningRunHook {
  const [snapshot, setSnapshot] = useState<LearningRunPublicV1 | null>(null);
  const [status, setStatus] = useState<LearningRunHookStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const snapshotRef = useRef<LearningRunPublicV1 | null>(null);
  const runIdRef = useRef<string | null>(null);
  const streamRef = useRef<{ close: () => void } | null>(null);
  const lastSequenceRef = useRef(0);
  const leaseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const leaseStartedAtRef = useRef<number | null>(null);
  // 快照轮询：SSE 仅作加速（直连跨域受限时静默失败），评估/提交等低频
  // 状态由轮询兜底——同源 rewrite 对 SSE 缓冲时仍能实时看到结算。
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 卸载守卫 + 断线重连定时器句柄（卸载后必须停止，否则重建永不被关闭的 SSE）。
  const mountedRef = useRef(true);
  const reconnectTimerRef = useRef<number | null>(null);
  // SSE 断线重连指数退避游标：连续失败递增，成功订阅事件后重置。
  const reconnectAttemptRef = useRef(0);
  // SSE 驱动刷新的 single-flight + 防抖：在途时跳过；否则合并到防抖窗口。
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const sseRefreshDebounceRef = useRef<number | null>(null);

  // F#7（🟡18）：快照 ref 在 useEffect 中同步，而非渲染期写 ref（纯度过反模式）。
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const stopReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const stopStream = useCallback(() => {
    stopReconnectTimer();
    streamRef.current?.close();
    streamRef.current = null;
  }, [stopReconnectTimer]);

  const stopLease = useCallback(() => {
    if (leaseTimerRef.current) {
      clearInterval(leaseTimerRef.current);
      leaseTimerRef.current = null;
    }
    leaseStartedAtRef.current = null;
  }, []);

  const refresh = useCallback(async () => {
    // 卸载守卫：组件卸载后不再拉取快照（轮询/SSE 已停止，仅"正在飞的
    // 这一次"in-flight GET 会命中——守卫其 resolve 后 setState）。
    if (!mountedRef.current) return;
    const runId = runIdRef.current;
    if (!runId) return;
    // single-flight（F#7 🟠3）：同一时刻在途的 refresh 直接复用，SSE 事件
    // 突发时避免并发 GET 各自 setSnapshot。
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const p = (async () => {
      const next = await api.getLearningRun(runId);
      if (!mountedRef.current) return;
      // 浅等守卫（F#7-1）：CAS 字段与播放器表面字段未变时复用前引用，
      // 避免静态区间每 2s 全量重渲。
      if (snapshotEqualSurface(snapshotRef.current, next)) return;
      setSnapshot(next);
      setStatus("ready");
      setError(null);
    })();
    refreshInFlightRef.current = p;
    try {
      await p;
    } finally {
      refreshInFlightRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    // F7：页面隐藏（切标签/后台）时跳过轮询，镜像 useGenerationPolling.ts，
    // 避免后台标签页每 2s 持续 GET。
    pollTimerRef.current = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refresh().catch(() => {});
    }, POLL_INTERVAL_MS);
  }, [refresh]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const applySnapshot = useCallback((next: LearningRunPublicV1) => {
    // 浅等守卫（F#7-1）：与 applySnapshot 共用同一表面比较，CAS 字段未变即
    // 复用当前引用，避免 dispatchAction/create 返回的同值快照触发无谓重渲。
    if (snapshotEqualSurface(snapshotRef.current, next)) return;
    setSnapshot(next);
    setStatus("ready");
    setError(null);
    if (next.phase === "completed" || next.phase === "ended" || next.phase === "skipped" || next.phase === "cancelled" || next.phase === "stale") {
      // 终态：停止流、轮询与续租。
      stopStream();
      stopPolling();
      stopLease();
    }
  }, [stopStream, stopPolling, stopLease]);

  const startStream = useCallback((runId: string, initialCursor: number) => {
    stopStream();
    // 新订阅：重置指数退避游标与防抖句柄。
    reconnectAttemptRef.current = 0;
    if (sseRefreshDebounceRef.current !== null) {
      clearTimeout(sseRefreshDebounceRef.current);
      sseRefreshDebounceRef.current = null;
    }
    lastSequenceRef.current = initialCursor;
    const connect = () => {
      // 卸载守卫：卸载后不再发起新的 SSE 订阅。
      if (!mountedRef.current) return;
      void subscribeLearningRunEvents(runId, (event) => {
        if (event.sequence > lastSequenceRef.current) {
          lastSequenceRef.current = event.sequence;
        }
        // 领域事件驱动快照重读（不自行推断结果）。F#7（🟠3）：防抖合并
        // 突发事件，避免每事件一次完整 GET。
        if (sseRefreshDebounceRef.current !== null) {
          clearTimeout(sseRefreshDebounceRef.current);
        }
        sseRefreshDebounceRef.current = window.setTimeout(() => {
          sseRefreshDebounceRef.current = null;
          void refresh().catch(() => {});
        }, SSE_REFRESH_DEBOUNCE_MS);
      }, { lastEventId: lastSequenceRef.current })
        .then((subscription) => {
          if (!mountedRef.current) {
            subscription.close();
            streamRef.current = null;
            return;
          }
          streamRef.current = subscription;
          // 成功建立订阅（并已收到至少一次 onEvent 才算健康）即重置退避。
          // open 后无事件也仅是空连接，保持退避游标不变由下一次 catch 决定。
        })
        .catch(() => {
          // 断线：指数退避 + 抖动后重新订阅（Last-Event-ID 重放）。句柄存入
          // ref，卸载时清除，避免卸载后重建永不被关闭的 SSE。
          if (!mountedRef.current) return;
          if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current);
          const delay = nextBackoffDelay(reconnectAttemptRef.current);
          reconnectAttemptRef.current += 1;
          // 防抖句柄在重连等待期间应继续生效：合并事件驱动的重读，避免
          // 重连风暴时叠加触发 refresh 网络风暴。
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            if (runIdRef.current === runId && mountedRef.current) connect();
          }, delay);
        });
    };
    connect();
  }, [refresh, stopStream]);

  const startLease = useCallback((runId: string) => {
    stopLease();
    leaseStartedAtRef.current = Date.now();
    leaseTimerRef.current = setInterval(() => {
      // F4（round4）：卸载后不得继续续租——否则每 15s POST /lease 的
      // 孤儿 interval 永不停止（cleanup 只清"卸载前已建"的定时器）。
      if (!mountedRef.current) {
        stopLease();
        return;
      }
      const startedAt = leaseStartedAtRef.current ?? Date.now();
      leaseStartedAtRef.current = Date.now();
      void api.recordLearningRunActivityLease(runId, {
        deviceSessionId: "web",
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
      }).catch((err: unknown) => {
        // Run 离开 active（评估/结算/结束）后服务端拒绝续租（409
        // invalid_phase）：停止续租，避免每 15s 制造一次 409。
        if (err instanceof ApiError && err.status === 409) {
          stopLease();
        }
      });
    }, LEASE_INTERVAL_MS);
  }, [stopLease]);

  const load = useCallback(async (runId: string) => {
    setStatus("loading");
    setError(null);
    try {
      runIdRef.current = runId;
      const next = await api.getLearningRun(runId);
      // F4：卸载守卫——in-flight GET 在卸载后才返回时，不得再 setState
      // 或新起轮询/SSE/续租定时器（cleanup 已清，此处若再起就是孤儿定时器）。
      if (!mountedRef.current) return;
      applySnapshot(next);
      startStream(runId, next.eventCursor);
      startPolling();
      if (next.phase === "active") startLease(runId);
    } catch (err) {
      if (!mountedRef.current) return;
      setStatus("error");
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [applySnapshot, startStream, startPolling, startLease]);

  const create = useCallback(async (input: CreateLearningRunRequestV1): Promise<LearningRunPublicV1> => {
    setStatus("loading");
    setError(null);
    let created: LearningRunPublicV1;
    try {
      created = await api.createLearningRun(input);
    } catch (err) {
      if (!mountedRef.current) throw err;
      // 创建失败（consent/权限/服务不可用）：显式失败面，绝不静默吞错。
      setStatus("error");
      setError(err instanceof Error ? err.message : "创建本轮学习失败");
      throw err;
    }
    runIdRef.current = created.runId;
    // F4：create 的调用方仍需要返回值，故先返回；卸载后不再 setState/
    // 起定时器（避免卸载后新起轮询/SSE/续租孤儿 timer）。
    if (!mountedRef.current) return created;
    applySnapshot(created);
    startStream(created.runId, created.eventCursor);
    startPolling();
    if (created.phase === "active") startLease(created.runId);
    return created;
  }, [applySnapshot, startStream, startPolling, startLease]);

  const dispatchAction = useCallback(async (action: LearningRunActionV1, idempotencyKey?: string) => {
    const current = snapshotRef.current;
    if (!current) return;
    const key = idempotencyKey ?? crypto.randomUUID();
    try {
      const response = await api.applyLearningRunAction(current.runId, {
        version: 1,
        runRevision: current.revision,
        runtimeEpoch: current.runtimeEpoch,
        action,
        idempotencyKey: key,
      });
      // F4：卸载守卫——禁止 setState-after-unmount。
      if (!mountedRef.current) return;
      applySnapshot(response.snapshot);
    } catch (err) {
      // 409 stale：自动重读最新快照（CAS 冲突后让用户在新 revision 上重试）。
      await refresh().catch(() => {});
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "操作失败");
    }
  }, [refresh, applySnapshot]);

  const submit = useCallback(async (
    taskId: string,
    request: Omit<SubmitTaskArtifactV1, "runRevision" | "taskRevision" | "idempotencyKey">,
  ) => {
    const current = snapshotRef.current;
    if (!current?.activeTask) return;
    const idempotencyKey = crypto.randomUUID();
    await api.submitLearningRunArtifact(current.runId, taskId, {
      ...request,
      runRevision: current.revision,
      taskRevision: current.activeTask.revision,
      idempotencyKey,
    });
    await refresh();
  }, [refresh]);

  const saveDraft = useCallback(async (taskId: string, input: {
    variantId: string;
    variantRevision: number;
    taskRevision: number;
    expectedDraftRevision: number | null;
    payload: unknown;
    rendererState: unknown;
  }): Promise<number | null> => {
    const current = snapshotRef.current;
    if (!current) return null;
    const saved = await api.putLearningRunDraft(current.runId, taskId, {
      version: 1,
      ...input,
      payload: input.payload as never,
      rendererState: input.rendererState as never,
      idempotencyKey: crypto.randomUUID(),
    });
    return saved.draftRevision;
  }, []);

  const clearDraft = useCallback(async (taskId: string) => {
    const current = snapshotRef.current;
    if (!current) return;
    await api.deleteLearningRunDraft(current.runId, taskId);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // F1/FN2：卸载时停止流、轮询与续租，并清除断线重连定时器，
      // 避免卸载后每 2s 持续 GET 及重建永不被关闭的 SSE。
      mountedRef.current = false;
      stopStream();
      stopPolling();
      stopLease();
      if (sseRefreshDebounceRef.current !== null) {
        clearTimeout(sseRefreshDebounceRef.current);
        sseRefreshDebounceRef.current = null;
      }
    };
  }, [stopStream, stopPolling, stopLease]);

  return {
    snapshot,
    status,
    error,
    load,
    create,
    dispatchAction,
    submit,
    saveDraft,
    clearDraft,
    refresh,
  };
}

export { parseSseChunk };
