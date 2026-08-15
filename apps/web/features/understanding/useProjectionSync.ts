/**
 * useProjectionSync：checkpoint-aware 投影拉取 hook（文档 16 §15 客户端语义）。
 *
 * - 拉取带本地保存的 minimumCheckpoint；202 → 保持旧数据（pending，按
 *   retryAfter 稍后重试），绝不拿旧图冒充新图；
 * - 200 → 更新投影 + 保存新 checkpoint token；
 * - delta 显影：changeSetId 只作显影注释；本地 receipt 同设备只播一次。
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  createLocalDeltaReceiptStore,
  loadCheckpointToken,
  MAX_PROJECTION_PAGES,
  mergeProjectionPages,
  parseProjectionResponse,
  saveCheckpointToken,
  saveProjectionCheckpoint,
  shouldAnimateDelta,
} from "./projection-client";

export interface ProjectionSyncState {
  status: "idle" | "loading" | "ready" | "pending" | "error";
  checkpointToken: string | null;
  data: unknown | null;
  error: string | null;
}

export interface ProjectionSync {
  state: ProjectionSyncState;
  refresh: () => Promise<void>;
  /** 显影判定 + 标记 receipt（同设备一次）。 */
  animateDeltaOnce: (changeSetId: string) => boolean;
}

export function useProjectionSync(
  userId: string,
  deviceSessionId: string,
  enabled: boolean = true,
): ProjectionSync {
  const [state, setState] = useState<ProjectionSyncState>({
    status: "idle",
    checkpointToken: null,
    data: null,
    error: null,
  });
  const receiptStoreRef = useRef<ReturnType<typeof createLocalDeltaReceiptStore> | null>(null);
  if (receiptStoreRef.current === null && typeof window !== "undefined") {
    receiptStoreRef.current = createLocalDeltaReceiptStore(window.localStorage);
  }
  const inFlightRef = useRef(false);
  // F17（round4）：放弃在途分页（userId 变化/卸载）——用 abort controller +
  // generation。底层 GET 传 signal 可中止；generation 变化即放弃本轮 setState。
  const abortRef = useRef<AbortController | null>(null);
  const activeGenerationRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || inFlightRef.current) return;
    inFlightRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;
    // F17：本轮 refresh 的意图身份——userId 变化/新一轮/卸载时 bump，用来
    // 让旧用户在途响应不再落地（避免跨用户瞬时投影 + 卸载后继续打向已卸载组件）。
    const myGeneration = (activeGenerationRef.current += 1);
    setState((prev) => ({ ...prev, status: "loading", error: null }));
    try {
      const minimumCheckpoint = typeof window !== "undefined"
        ? loadCheckpointToken(window.localStorage, userId)
        : null;
      // 游标分页循环（§15.2 slice.continuationToken）：直到无 continuation 才
      // 算完整；任一分页 202 → 整体 pending（保持旧投影，不冒充新图）。
      let continuation: string | undefined;
      const pages: unknown[] = [];
      let pending = false;
      for (let page = 0; page < MAX_PROJECTION_PAGES; page += 1) {
        // F17：每次 await 后查取消/用户未变，放弃在途分页。
        if (signal.aborted || activeGenerationRef.current !== myGeneration) return;
        const response = await api.getUnderstandingProjection({
          lens: "current_target",
          minimumCheckpoint: minimumCheckpoint ?? undefined,
          ...(continuation ? { continuation } : {}),
        }, signal);
        if (signal.aborted || activeGenerationRef.current !== myGeneration) return;
        const parsed = parseProjectionResponse(response.payload, response.httpStatus);
        if (parsed.status === "pending") {
          pending = true;
          break;
        }
        pages.push(parsed.data);
        const token = (parsed.data as {
          slice?: { continuationToken?: string | null } | null;
        } | null)?.slice?.continuationToken ?? null;
        if (!token) {
          continuation = undefined;
          break;
        }
        continuation = token;
      }
      if (pending) {
        if (signal.aborted || activeGenerationRef.current !== myGeneration) return;
        // 202：保持旧投影，不冒充新图（§15.2）。
        setState((prev) => ({
          ...prev,
          status: "pending",
          error: null,
        }));
        return;
      }
      if (continuation) {
        throw new Error("投影分页超过上限，未完整加载");
      }
      const merged = mergeProjectionPages(pages);
      if (merged === null) {
        throw new Error("投影响应形状非法");
      }
      const checkpointToken = (merged as {
        checkpoint?: { token?: string | null } | null;
      } | null)?.checkpoint?.token ?? null;
      if (typeof window !== "undefined") {
        saveCheckpointToken(window.localStorage, userId, checkpointToken);
        // P7 星图发起 Run：保存完整 checkpoint（workspaceId/userId/token/
        // capturedAt）供 star_map origin 基线使用。
        const checkpoint = (merged as {
          checkpoint?: { version?: number; workspaceId?: string; userId?: string; token?: string; capturedAt?: string } | null;
        } | null)?.checkpoint;
        if (
          checkpoint
          && checkpoint.version === 1
          && typeof checkpoint.workspaceId === "string"
          && typeof checkpoint.userId === "string"
          && typeof checkpoint.token === "string"
          && typeof checkpoint.capturedAt === "string"
        ) {
          saveProjectionCheckpoint(window.localStorage, userId, {
            version: 1,
            workspaceId: checkpoint.workspaceId,
            userId: checkpoint.userId,
            token: checkpoint.token,
            capturedAt: checkpoint.capturedAt,
          });
        }
      }
      if (signal.aborted || activeGenerationRef.current !== myGeneration) return;
      setState({
        status: "ready",
        checkpointToken,
        data: merged,
        error: null,
      });
    } catch (err) {
      if (signal.aborted || activeGenerationRef.current !== myGeneration) return;
      setState((prev) => ({
        ...prev,
        status: "error",
        error: err instanceof Error ? err.message : "投影不可用",
      }));
    } finally {
      // F17：仅当仍是同代（中途未发生 userId 变化/新一轮/卸载）才释放 inFlight，
      // 避免旧 run 的 finally 覆盖新一轮 refresh 的 inFlight 标记。
      if (activeGenerationRef.current === myGeneration) inFlightRef.current = false;
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [enabled, userId]);

  useEffect(() => {
    // F17：卸载清理——放弃在途分页。userId 变化/卸载时 effect 重跑，
    // 先 bump generation + abort，再释放 inFlight 让新 refresh 立即执行。
    return () => {
      activeGenerationRef.current += 1;
      abortRef.current?.abort();
      inFlightRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const animateDeltaOnce = useCallback((changeSetId: string): boolean => {
    const store = receiptStoreRef.current;
    if (!store) return false;
    const should = shouldAnimateDelta(store, {
      userId,
      deviceSessionId,
      changeSetId,
    });
    if (should) store.mark(userId, deviceSessionId, changeSetId);
    return should;
  }, [userId, deviceSessionId]);

  // F22（round5）：返回对象用 useMemo 稳定化（依赖均为稳定字段：state 引用、
  // 两个 useCallback），避免每次渲染重建导致下游 effect（如 graph delta
  // 显影）在无关 state 不变时仍每渲重跑。API 契约不变。
  return useMemo(
    () => ({ state, refresh, animateDeltaOnce }),
    [state, refresh, animateDeltaOnce],
  );
}
