/**
 * PERF-04 拆分（第十三轮）：生成任务轮询逻辑提取为自定义 Hook。
 *
 * 从 NoteEditor.tsx 提取以下功能：
 * - pollGenerationRun()：轮询 CardGenerationRun 状态
 * - 刷新恢复 effect：页面加载时恢复正在运行的生成任务
 */

import { useCallback, useEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { api, ApiError } from "@/lib/api";
import type { CardGenerationRunView } from "@/lib/api";
/** 2026-08-11：轮询连续失败上限（达到即停止，防无限重试） */
const MAX_POLL_CONSECUTIVE_FAILURES = 10;
import {
  type GenerationPhase,
  type GenerationState,
  type SavingState,
} from "./note-editor-types";
import {
  isActiveGenerationRun,
} from "./note-editor-utils";

/** useGenerationPolling 的上下文参数 */
export interface GenerationPollingContext {
  // ── 基础信息 ──
  noteId: string;
  noteVersionId: string;
  versionNo: number;
  generationRunStorageKey: string;
  initialGenerationStatus: {
    state: GenerationState;
    message?: string | null;
    generatedVersionId?: string | null;
  };

  // ── Refs ──
  mountedRef: RefObject<boolean>;
  generationRunRef: RefObject<number>;
  noteDeletedRef: RefObject<boolean>;

  // ── 状态值 ──
  generationRunId: string | null;
  generationRunRecoveryResolved: boolean;

  // ── 状态设置器 ──
  setGenState: Dispatch<SetStateAction<GenerationState>>;
  setGenMessage: Dispatch<SetStateAction<string | null>>;
  setGenerationRun: Dispatch<SetStateAction<CardGenerationRunView | null>>;
  setGenerationRunId: Dispatch<SetStateAction<string | null>>;
  setGenerationVersionNo: Dispatch<SetStateAction<number | null>>;
  setGenerationPhase: Dispatch<SetStateAction<GenerationPhase>>;
  setGeneratedVersionId: Dispatch<SetStateAction<string | null>>;
  setSaving: Dispatch<SetStateAction<SavingState>>;
  setGenerationRunRecoveryResolved: Dispatch<SetStateAction<boolean>>;

  // ── 回调 ──
  applyGenerationRun: (run: CardGenerationRunView) => void;
  rememberGenerationRun: (run: {
    runId: string;
    noteVersionId: string;
    versionNo: number;
    sequence: number;
  }) => void;
  forgetGenerationRun: () => void;
}

/** 从 useGenerationPolling 返回的接口 */
export interface GenerationPollingControls {
  pollGenerationRun: (activeRunId: string, pollToken: number) => Promise<void>;
}

/**
 * 生成任务轮询 Hook。
 *
 * 轮询 CardGenerationRun 状态。页面刷新时自动恢复正在运行的生成任务状态。
 * 返回 pollGenerationRun 供 useGenerationActions 使用。
 */
export function useGenerationPolling(ctx: GenerationPollingContext): GenerationPollingControls {
  const {
    noteVersionId,
    generationRunStorageKey,
    mountedRef,
    generationRunRef,
    setGenState,
    setGenMessage,
    setGenerationRun,
    setGenerationRunId,
    setGenerationRunRecoveryResolved,
    applyGenerationRun,
    forgetGenerationRun,
  } = ctx;

  // ── 轮询 CardGenerationRun ───────────────────────────────────────

  const pollGenerationRun = useCallback(async (activeRunId: string, pollToken: number) => {
    let pollDelay = 0;
    let consecutiveReadFailures = 0;

    while (pollToken === generationRunRef.current && mountedRef.current) {
      if (pollDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, pollDelay));
        if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      }

      const controller = new AbortController();
      const watchdog = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const run = await api.getCardGenerationRun(activeRunId, controller.signal);
        if (pollToken !== generationRunRef.current || !mountedRef.current) return;
        // R10（D5）：轮询从瞬时失败恢复后清除陈旧错误消息。
        // applyGenerationRun 的 announce 只在 run 推进时覆盖消息；
        // 若 run 停在同状态，旧的"暂时无法同步"会残留，这里主动清除。
        if (consecutiveReadFailures > 0) {
          setGenMessage(null);
          consecutiveReadFailures = 0;
        }
        applyGenerationRun(run);
        if (!isActiveGenerationRun(run.status)) return;
      } catch (error) {
        if (pollToken !== generationRunRef.current || !mountedRef.current) return;
        consecutiveReadFailures += 1;
        // 2026-08-11：失败累计上限——此前无上限，网络/5xx 长期故障时按
        // 1.5s/5s 无限重试（仅换消息文案）。达到上限停止轮询并提示手动刷新。
        if (consecutiveReadFailures >= MAX_POLL_CONSECUTIVE_FAILURES) {
          setGenMessage("生成进度同步失败次数过多，请刷新页面查看最新状态。");
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          forgetGenerationRun();
          setGenerationRun(null);
          setGenerationRunId(null);
          setGenState("idle");
          setGenMessage("生成任务已不存在，可以重新生成当前保存版本。");
          return;
        }
        if (consecutiveReadFailures === 1) {
          setGenMessage("暂时无法同步生成进度；任务仍在后台运行，你可以继续编辑。");
        }
      } finally {
        window.clearTimeout(watchdog);
      }

      pollDelay = document.visibilityState === "hidden" ? 5000 : 1500;
    }
  }, [
    applyGenerationRun, forgetGenerationRun, generationRunRef, mountedRef,
    setGenerationRun, setGenerationRunId, setGenState, setGenMessage,
  ]);

  // ── 刷新恢复 effect ────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const recover = async () => {
      let storedRunId: string | null = null;
      try {
        const raw = window.localStorage.getItem(generationRunStorageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as { runId?: unknown };
          if (typeof parsed.runId === "string" && parsed.runId) {
            storedRunId = parsed.runId;
          }
        }
      } catch {
        // Fall through to the server-side latest lookup.
      }

      try {
        let recoveredRun: CardGenerationRunView | null = null;
        if (storedRunId) {
          try {
            recoveredRun = await api.getCardGenerationRun(storedRunId, controller.signal);
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) throw error;
            forgetGenerationRun();
          }
        }
        if (!recoveredRun) {
          const latest = await api.getLatestCardGenerationRun(noteVersionId, controller.signal);
          recoveredRun = latest.run;
        }
        if (cancelled || !mountedRef.current) return;
        if (recoveredRun) {
          applyGenerationRun(recoveredRun);
          if (isActiveGenerationRun(recoveredRun.status)) {
            const pollToken = generationRunRef.current + 1;
            generationRunRef.current = pollToken;
            void pollGenerationRun(recoveredRun.runId, pollToken);
          }
        }
      } catch {
        // Recovery failed; user can manually trigger generation.
      } finally {
        if (!cancelled && mountedRef.current) {
          setGenerationRunRecoveryResolved(true);
        }
      }
    };

    void recover();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    applyGenerationRun, forgetGenerationRun, generationRunStorageKey,
    noteVersionId, pollGenerationRun, mountedRef, generationRunRef,
    setGenerationRunRecoveryResolved,
  ]);

  // ── 兼容恢复 effect 已删除 ──────────────────────────────────────
  // V1 getCardGenerationStatus 端点已删除；V2 run 恢复 effect（上方）已覆盖
  // 所有运行时场景。旧版 job-based generation 不再支持。

  return { pollGenerationRun };
}
