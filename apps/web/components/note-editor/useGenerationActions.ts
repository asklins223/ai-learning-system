/**
 * PERF-04 拆分（第十二轮）：生成动作逻辑提取为自定义 Hook。
 *
 * 从 NoteEditor.tsx 提取 4 个生成卡动作函数：
 * - generateCard：提交新的生成任务
 * - cancelGenerationRun：取消正在运行的生成任务
 * - retryGenerationRun：从失败检查点重新排队
 * - restartGenerationRun：按当前 AI 设置创建全新生成任务
 */

import type { Dispatch, RefObject, SetStateAction } from "react";
import { api } from "@/lib/api";
import type { CardGenerationRunView } from "@/lib/api";
import {
  type GenerationPhase,
  type GenerationResolutionAction,
  type GenerationState,
  type ImageUploadView,
} from "./note-editor-types";
import {
  isActiveGenerationRun,
  generationResolutionErrorMessage,
} from "./note-editor-utils";

/** 冲突数据类型（与 NoteEditor 内部一致） */
interface ConflictData {
  serverTitle: string;
  serverTitleSource?: "auto" | "manual";
  serverSource: string;
  serverVersionNo: number;
}

/** 幂等键类型 */
interface RequestKey {
  versionId: string;
  key: string;
}
interface RunRequestKey {
  runId: string;
  key: string;
}

/** V2 生成控件草稿（来自 GenerationControls，映射到 §9.1 CreateRequest）。 */
export interface GenerationControlDraftInputV2 {
  sourceScope: "selection" | "section" | "whole_note";
  learningGoal: "remember" | "understand" | "apply" | "exam";
  detailThreshold: "concise" | "balanced" | "deep";
  hardMaxCards: number | null;
  preferredStrategies: Array<"recall" | "cloze" | "compare" | "sequence" | "why" | "boundary" | "application">;
}

/** useGenerationActions 的上下文参数 */
export interface GenerationActionsContext {
  // ── 当前状态值 ──
  noteId: string;
  uploadingCount: number;
  imageUploads: ImageUploadView[];
  generationRunId: string | null;
  generationRun: CardGenerationRunView | null;
  generationResolutionAction: GenerationResolutionAction;
  cancellingGeneration: boolean;
  /**
   * B1（计划 §2.4）：是否复用了已有 succeeded run（而非新创建）。
   * 为 true 时前端展示"内容未变，已复用上次结果"提示并提供"强制重新生成"入口。
   */
  generationReused: boolean;

  // ── 状态设置器 ──
  setGenState: Dispatch<SetStateAction<GenerationState>>;
  setGenMessage: Dispatch<SetStateAction<string | null>>;
  setGenerationRun: Dispatch<SetStateAction<CardGenerationRunView | null>>;
  setGenerationRunId: Dispatch<SetStateAction<string | null>>;
  setGenerationVersionNo: Dispatch<SetStateAction<number | null>>;
  setGenerationPhase: Dispatch<SetStateAction<GenerationPhase>>;
  setGenerationOverlayDismissed: Dispatch<SetStateAction<boolean>>;
  setInspectorOpen: Dispatch<SetStateAction<boolean>>;
  setCancellingGeneration: Dispatch<SetStateAction<boolean>>;
  setGenerationResolutionAction: Dispatch<SetStateAction<GenerationResolutionAction>>;
  setGenerationResolutionError: Dispatch<SetStateAction<string | null>>;
  setGenerationFailureDialogOpen: Dispatch<SetStateAction<boolean>>;
  /** B1：设置复用状态 */
  setGenerationReused: Dispatch<SetStateAction<boolean>>;

  // ── Refs ──
  latestDraftRef: RefObject<{ source: string }>;
  conflictDataRef: RefObject<ConflictData | null>;
  conflictDialogRef: RefObject<HTMLDivElement | null>;
  generationRunRef: RefObject<number>;
  mountedRef: RefObject<boolean>;
  generationLockedRef: RefObject<boolean>;
  savedVersionIdRef: RefObject<string | null>;
  currentVersionNoRef: RefObject<number>;
  generationRequestKeyRef: RefObject<RequestKey | null>;
  generationRestartRequestKeyRef: RefObject<RunRequestKey | null>;
  moreActionsRef: RefObject<HTMLDetailsElement | null>;

  // ── 辅助函数 ──
  flushLatestDraft: () => Promise<boolean>;
  rememberGenerationRun: (run: {
    runId: string;
    noteVersionId: string;
    versionNo: number;
    sequence: number;
  }) => void;
  pollGenerationRun: (activeRunId: string, pollToken: number) => Promise<void>;
  applyGenerationRun: (run: CardGenerationRunView) => void;
  endSession: () => void;

}

/**
 * 生成动作 Hook。
 *
 * 返回 4 个生成卡操作函数。每次渲染重新创建函数实例，
 * 与原 NoteEditor 内的 `async function` 声明行为一致。
 */
export function useGenerationActions(ctx: GenerationActionsContext) {
  const {
    uploadingCount,
    imageUploads,
    generationRunId,
    generationRun,
    generationResolutionAction,
    cancellingGeneration,
    setGenState,
    setGenMessage,
    setGenerationRun,
    setGenerationRunId,
    setGenerationVersionNo,
    setGenerationPhase,
    setGenerationOverlayDismissed,
    setInspectorOpen,
    setCancellingGeneration,
    setGenerationResolutionAction,
    setGenerationResolutionError,
    setGenerationFailureDialogOpen,
    setGenerationReused,
    latestDraftRef,
    conflictDataRef,
    conflictDialogRef,
    generationRunRef,
    mountedRef,
    generationLockedRef,
    savedVersionIdRef,
    currentVersionNoRef,
    generationRequestKeyRef,
    generationRestartRequestKeyRef,
    moreActionsRef,
    flushLatestDraft,
    rememberGenerationRun,
    pollGenerationRun,
    applyGenerationRun,
    endSession,
  } = ctx;

  /** 提交新的生成任务 */
  async function generateCard() {
    // 重入守卫：保存+入队握手期间（generationLockedRef）或已有任务在运行时，
    // 拒绝重复提交。ref 在下方同步设置为 true，早于 React 异步重渲染，
    // 因此能拦截同一事件循环内的快速连点。
    if (generationLockedRef.current) return;
    if (uploadingCount > 0) {
      setGenState("idle");
      setGenMessage("请等待图片上传完成，再生成学习卡。");
      return;
    }
    if (
      imageUploads.some((upload) => upload.status === "failed") ||
      latestDraftRef.current.source.includes("](uploading:")
    ) {
      setGenState("idle");
      setGenMessage("请重试或移除上传失败的图片，再生成学习卡。");
      return;
    }
    if (!latestDraftRef.current.source.trim()) {
      setGenState("idle");
      setGenMessage("先写下一些有效内容，再生成学习卡。");
      return;
    }
    if (conflictDataRef.current) {
      setGenState("idle");
      setGenMessage("请先解决内容冲突，再生成学习卡。");
      conflictDialogRef.current?.focus();
      return;
    }
    const pollToken = generationRunRef.current + 1;
    generationRunRef.current = pollToken;
    setInspectorOpen(false);
    moreActionsRef.current?.removeAttribute("open");
    setGenerationRun(null);
    setGenerationRunId(null);
    setGenerationVersionNo(null);
    setGenerationOverlayDismissed(false);
    setGenerationPhase("saving");
    generationLockedRef.current = true;
    setGenState("generating");
    setGenMessage("正在保存当前内容并锁定生成版本…");
    const saved = await flushLatestDraft();
    if (pollToken !== generationRunRef.current || !mountedRef.current) return;
    if (!saved) {
      generationLockedRef.current = false;
      setGenState("idle");
      setGenMessage("当前内容尚未保存，暂时无法生成学习卡。");
      return;
    }

    try {
      const versionId = savedVersionIdRef.current;
      const versionAtGeneration = currentVersionNoRef.current;
      if (!versionId) {
        generationLockedRef.current = false;
        setGenState("idle");
        setGenMessage("尚未保存任何版本，无法生成学习卡。");
        return;
      }
      setGenerationVersionNo(versionAtGeneration);
      setGenMessage(`已锁定 v${versionAtGeneration}，正在提交生成任务…`);

      let requestIdentity = generationRequestKeyRef.current;
      if (!requestIdentity || requestIdentity.versionId !== versionId) {
        requestIdentity = {
          versionId,
          key: `card-generation-${globalThis.crypto.randomUUID()}`,
        };
        generationRequestKeyRef.current = requestIdentity;
      }

      const accepted = await api.createCardGenerationRun({
        noteVersionId: versionId,
        idempotencyKey: requestIdentity.key,
      });
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      if (!accepted.canContinueEditing) {
        throw new Error("服务端尚未确认生成快照，暂时无法恢复编辑。");
      }
      generationRequestKeyRef.current = null;
      generationLockedRef.current = false;
      endSession();

      // B1（计划 §2.4）：内容未变时复用已有 succeeded run。
      // 不启动轮询（run 已终态），展示复用提示并提供"强制重新生成"入口。
      // R6：复用提示由 Overlay 的 reused 横幅承担，不再写 genMessage，
      // 避免同一提示在 live 区重复出现。
      if (accepted.reused) {
        setGenerationReused(true);
        setGenerationRunId(accepted.runId);
        setGenerationVersionNo(accepted.sourceSnapshot.versionNo);
        setGenerationPhase("queued");
        setGenState("generated");
        rememberGenerationRun({
          runId: accepted.runId,
          noteVersionId: accepted.sourceSnapshot.noteVersionId,
          versionNo: accepted.sourceSnapshot.versionNo,
          sequence: 0,
        });
        return;
      }

      setGenerationRunId(accepted.runId);
      setGenerationVersionNo(accepted.sourceSnapshot.versionNo);
      setGenerationPhase("queued");
      setGenState("generating");
      setGenMessage(
        `已封存 v${accepted.sourceSnapshot.versionNo} 并进入队列；你可以继续编辑，新修改会进入下一版本。`,
      );
      rememberGenerationRun({
        runId: accepted.runId,
        noteVersionId: accepted.sourceSnapshot.noteVersionId,
        versionNo: accepted.sourceSnapshot.versionNo,
        sequence: 0,
      });
      void pollGenerationRun(accepted.runId, pollToken);
    } catch (err) {
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      generationLockedRef.current = false;
      setGenState("idle");
      setGenMessage(err instanceof Error ? err.message : "请求失败");
    }
  }

  /** 取消正在运行的生成任务 */
  async function cancelGenerationRun() {
    if (!generationRunId || cancellingGeneration) return;
    const pollToken = generationRunRef.current + 1;
    generationRunRef.current = pollToken;
    setCancellingGeneration(true);
    setGenMessage("正在取消生成任务…");
    try {
      const cancelledRun = await api.cancelCardGenerationRun(generationRunId);
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      applyGenerationRun(cancelledRun);
      if (isActiveGenerationRun(cancelledRun.status)) {
        void pollGenerationRun(cancelledRun.runId, pollToken);
      }
    } catch (error) {
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      setGenMessage(error instanceof Error ? error.message : "取消失败，任务仍在后台运行。");
      void pollGenerationRun(generationRunId, pollToken);
    } finally {
      if (pollToken === generationRunRef.current && mountedRef.current) {
        setCancellingGeneration(false);
      }
    }
  }

  /** 从失败检查点重新排队 */
  async function retryGenerationRun() {
    const run = generationRun;
    if (
      !run ||
      run.status !== "needs_attention" ||
      !run.actions.retryable ||
      generationResolutionAction
    ) {
      return;
    }
    const pollToken = generationRunRef.current + 1;
    generationRunRef.current = pollToken;
    setGenerationResolutionAction("retrying");
    setGenerationResolutionError(null);
    setGenMessage("正在从失败检查点重新排队；不会重复处理已经完成的素材…");
    try {
      const retriedRun = await api.retryCardGenerationRun(run.runId);
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      setGenerationResolutionError(null);
      applyGenerationRun(retriedRun);
      if (isActiveGenerationRun(retriedRun.status)) {
        void pollGenerationRun(retriedRun.runId, pollToken);
      }
    } catch (error) {
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      const message = generationResolutionErrorMessage(error, "重试失败，请稍后再试。");
      setGenerationResolutionAction(null);
      setGenerationResolutionError(message);
      setGenMessage(message);
    }
  }

  /** 按当前 AI 设置创建全新的生成任务 */
  async function restartGenerationRun() {
    const run = generationRun;
    if (
      !run
      || run.status !== "needs_attention"
      || !run.actions.restartable
      || generationResolutionAction
    ) {
      return;
    }
    let requestIdentity = generationRestartRequestKeyRef.current;
    if (!requestIdentity || requestIdentity.runId !== run.runId) {
      requestIdentity = {
        runId: run.runId,
        key: `card-generation-restart-${globalThis.crypto.randomUUID()}`,
      };
      generationRestartRequestKeyRef.current = requestIdentity;
    }

    const pollToken = generationRunRef.current + 1;
    generationRunRef.current = pollToken;
    setGenerationResolutionAction("restarting");
    setGenerationResolutionError(null);
    setGenMessage("正在按当前 AI 设置创建全新的生成任务…");
    try {
      const accepted = await api.createCardGenerationRun({
        noteVersionId: run.noteVersionId,
        idempotencyKey: requestIdentity.key,
      });
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      generationRestartRequestKeyRef.current = null;
      setGenerationFailureDialogOpen(false);
      setGenerationResolutionAction(null);
      setGenerationRun(null);
      setGenerationRunId(accepted.runId);
      setGenerationVersionNo(accepted.sourceSnapshot.versionNo);
      setGenerationPhase("queued");
      setGenState("generating");
      setGenMessage(
        `已按当前 AI 设置重新提交 v${accepted.sourceSnapshot.versionNo} 的生成任务。`,
      );
      rememberGenerationRun({
        runId: accepted.runId,
        noteVersionId: accepted.sourceSnapshot.noteVersionId,
        versionNo: accepted.sourceSnapshot.versionNo,
        sequence: 0,
      });
      void pollGenerationRun(accepted.runId, pollToken);
    } catch (error) {
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      const message = generationResolutionErrorMessage(
        error,
        "重新创建生成任务失败，请稍后再试。",
      );
      setGenerationResolutionAction(null);
      setGenerationResolutionError(message);
      setGenerationFailureDialogOpen(true);
      setGenMessage(message);
    }
  }

  /**
   * B1（计划 §2.4）：强制重新生成。
   * 当上次请求复用了已有 succeeded run 时，用户可点击"强制重新生成"
   * 以 force=true 重新提交，跳过 succeeded run 复用逻辑。
   */
  async function forceRegenerate() {
    if (generationLockedRef.current) return;
    const versionId = savedVersionIdRef.current;
    if (!versionId) {
      setGenMessage("尚未保存任何版本，无法生成学习卡。");
      return;
    }
    const pollToken = generationRunRef.current + 1;
    generationRunRef.current = pollToken;
    setGenerationReused(false);
    setGenerationRun(null);
    setGenerationRunId(null);
    setGenerationOverlayDismissed(false);
    setGenerationPhase("queued");
    generationLockedRef.current = true;
    setGenState("generating");
    setGenMessage("正在强制重新提交生成任务…");

    try {
      let requestIdentity = generationRequestKeyRef.current;
      if (!requestIdentity || requestIdentity.versionId !== versionId) {
        requestIdentity = {
          versionId,
          key: `card-generation-force-${globalThis.crypto.randomUUID()}`,
        };
        generationRequestKeyRef.current = requestIdentity;
      }

      const accepted = await api.createCardGenerationRun({
        noteVersionId: versionId,
        idempotencyKey: requestIdentity.key,
        force: true,
      });
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      if (!accepted.canContinueEditing) {
        throw new Error("服务端尚未确认生成快照，暂时无法恢复编辑。");
      }
      generationRequestKeyRef.current = null;
      generationLockedRef.current = false;
      endSession();
      setGenerationRunId(accepted.runId);
      setGenerationVersionNo(accepted.sourceSnapshot.versionNo);
      setGenerationPhase("queued");
      setGenState("generating");
      setGenMessage(
        `已强制重新提交 v${accepted.sourceSnapshot.versionNo} 的生成任务。`,
      );
      rememberGenerationRun({
        runId: accepted.runId,
        noteVersionId: accepted.sourceSnapshot.noteVersionId,
        versionNo: accepted.sourceSnapshot.versionNo,
        sequence: 0,
      });
      void pollGenerationRun(accepted.runId, pollToken);
    } catch (err) {
      if (pollToken !== generationRunRef.current || !mountedRef.current) return;
      generationLockedRef.current = false;
      setGenState("idle");
      setGenMessage(err instanceof Error ? err.message : "请求失败");
    }
  }

  /**
   * V2（方案 20 §19.1）：价值优先生成。
   * 用真实 api-client 创建 V2 run（带 Idempotency-Key），成功后返回 runId，
   * 由调用方进入“生成过程”等待阶段，不再直接跳转候选审核页。
   * 后端未开启（404/503，V2 路由未注册）时返回 { ok: false }。
   * sourceScope 的 selection/section 细分由上层在 draft 中给出 blockRanges 前
   * 暂以整篇兜底（§9.1 合同已支持，Web 选区采集后续迭代补全）。
   */
  async function generateCardV2(
    draft: GenerationControlDraftInputV2,
  ): Promise<{ ok: true; runId: string } | { ok: false }> {
    const { createV2Client, newV2IdempotencyKey, isV2UnavailableError } = await import(
      "@/features/card-generation-v2/api-client"
    );
    const client = createV2Client();
    const noteVersionId = savedVersionIdRef.current;
    if (!noteVersionId) return { ok: false };
    try {
      const run = await client.createRun(
        {
          version: 2,
          noteVersionId,
          sourceScope: { kind: "whole_note" },
          learningGoal: draft.learningGoal,
          detailThreshold: draft.detailThreshold,
          quantity: draft.hardMaxCards != null
            ? { kind: "adaptive", hardMaxCards: draft.hardMaxCards }
            : { kind: "adaptive" },
          preferredStrategies: draft.preferredStrategies.length > 0 ? draft.preferredStrategies : undefined,
          clientRequestId: `web-${Date.now()}`,
        },
        newV2IdempotencyKey("gen"),
      );
      return { ok: true, runId: run.runId };
    } catch (error) {
      if (isV2UnavailableError(error)) return { ok: false };
      console.error("card-generation-v2 create failed", error);
      // V2 已启用时不能静默回退 V1（V1 writer 在 V2 开启后默认停写）；
      // 直接把 V2 错误展示给用户。
      setGenState("idle");
      setGenMessage(
        error instanceof Error && error.message
          ? error.message
          : "V2 学习卡生成失败，请稍后重试。",
      );
      return { ok: false };
    }
  }

  return {
    generateCard,
    generateCardV2,
    cancelGenerationRun,
    retryGenerationRun,
    restartGenerationRun,
    forceRegenerate,
  };
}
