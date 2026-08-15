/**
 * PERF-04 拆分（第十四轮）：生成展示计算逻辑提取为自定义 Hook。
 *
 * 从 NoteEditor.tsx 提取以下纯计算逻辑：
 * - generationVisualState：生成视觉状态（idle/generating/success/stale/attention/partial）
 * - generationHeading：生成面板标题文案
 * - genPres：生成状态标签（label + tone）
 * - previewOutlineOpen：预览目录是否展开
 * - generationOverlayTitle：生成遮罩标题
 * - generationOverlayDescription：生成遮罩描述
 *
 * 提取后 NoteEditor.tsx 减少约 100 行内联计算逻辑。
 */

import type { StatusTone } from "@/lib/status-map";
import type {
  GenerationPhase,
  GenerationState,
  PreviewOutlineMode,
} from "./note-editor-types";

/** 冲突数据类型（与 NoteEditor 内部一致） */
interface ConflictData {
  serverTitle: string;
  serverTitleSource?: "auto" | "manual";
  serverSource: string;
  serverVersionNo: number;
}

/** useGenerationPresentation 的上下文参数 */
export interface GenerationPresentationContext {
  // ── 状态值 ──
  genState: GenerationState;
  generationPhase: GenerationPhase;
  generationPartialReady: boolean;
  generationNeedsAttention: boolean;
  generatedIsCurrent: boolean;
  generatedVersionId: string | null;
  isOwner: boolean;
  conflictData: ConflictData | null;
  hasWritableContent: boolean;
  previewOutlineMode: PreviewOutlineMode;
  previewOutlinePeeked: boolean;
}

/** 从 useGenerationPresentation 返回的展示计算结果 */
export interface GenerationPresentation {
  /** 生成视觉状态 */
  visualState:
    | "idle"
    | "generating"
    | "success"
    | "stale"
    | "attention"
    | "partial"
    | "status-error";
  /** 生成面板标题 */
  heading: string;
  /** 生成状态标签 */
  pres: { label: string; tone: StatusTone };
  /** 预览目录是否展开 */
  outlineOpen: boolean;
  /** 生成遮罩标题 */
  overlayTitle: string;
  /** 生成遮罩描述 */
  overlayDescription: string;
}

/**
 * 生成展示计算 Hook。
 *
 * 根据当前生成状态、冲突状态和用户权限，计算用于 UI 展示的
 * 视觉状态、标题文案和状态标签。所有计算为纯函数，无副作用。
 */
export function useGenerationPresentation(
  ctx: GenerationPresentationContext,
): GenerationPresentation {
  const {
    genState,
    generationPhase,
    generationPartialReady,
    generationNeedsAttention,
    generatedIsCurrent,
    generatedVersionId,
    isOwner,
    conflictData,
    hasWritableContent,
    previewOutlineMode,
    previewOutlinePeeked,
  } = ctx;

  // ── 生成视觉状态 ──
  const visualState: GenerationPresentation["visualState"] =
    genState === "status-error"
      ? "status-error"
    : generationPartialReady
      ? "partial"
      : generationNeedsAttention
        ? "attention"
      : genState === "generating" || genState === "checking"
      ? "generating"
      : generatedIsCurrent
        ? "success"
        : generatedVersionId
          ? "stale"
          : "idle";

  // ── 生成面板标题 ──
  const heading =
    visualState === "status-error"
      ? "生成状态待确认"
    : visualState === "partial"
      ? "已保留部分结果"
    : visualState === "attention"
      ? "先处理质量问题"
    : !isOwner
    ? generatedVersionId
      ? "使用现有学习卡"
      : "尚无学习卡"
    : visualState === "success"
      ? "这一版已完成"
      : visualState === "generating"
        ? "正在生成学习卡"
        : visualState === "stale"
          ? "为最新版重新生成"
          : "从当前版本生成";

  // ── 生成状态标签 ──
  const pres: { label: string; tone: StatusTone } =
    visualState === "partial"
      ? { label: "部分结果", tone: "warning" }
      : visualState === "attention"
        ? { label: "需要处理", tone: "warning" }
    : !isOwner
      ? generatedVersionId
        ? { label: "可查看", tone: "success" }
        : { label: "尚未生成", tone: "neutral" }
      : genState === "checking"
        ? { label: "确认中", tone: "running" }
      : genState === "status-error"
        ? { label: "同步异常", tone: "danger" }
      : genState === "generating"
        ? { label: "生成中", tone: "running" }
      : generatedIsCurrent
        ? { label: "已生成", tone: "success" }
        : generatedVersionId
          ? { label: "内容已更新", tone: "warning" }
          : conflictData
            ? { label: "等待处理冲突", tone: "warning" }
            : !hasWritableContent
              ? { label: "等待内容", tone: "neutral" }
              : { label: "尚未生成", tone: "neutral" };

  // ── 预览目录展开状态 ──
  const outlineOpen = previewOutlineMode === "pinned" || previewOutlinePeeked;

  // ── 生成遮罩标题 ──
  const overlayTitle =
    genState === "status-error"
      ? "正在找回生成状态"
    : genState === "checking"
      ? "正在同步生成进度"
    : generationPhase === "saving"
      ? "正在固定本次笔记版本"
      : generationPhase === "queued"
        ? "已经排队，准备理解笔记"
        : "正在提炼这版笔记的关键理解";

  // ── 生成遮罩描述 ──
  const overlayDescription =
    genState === "status-error"
      ? "后台状态暂时不可用；笔记不会被锁定，也不会重复创建任务。"
    : genState === "checking"
      ? "正在与后台恢复连接；你仍然可以继续编辑笔记。"
    : generationPhase === "saving"
      ? "先保存一份不可变来源，确保生成结果始终能回到这版原文。"
      : generationPhase === "queued"
        ? "任务已被接受；开始后会提炼关键理解并核对原文来源。"
        : "正在设计回忆线索，并检查答案是否能由当前笔记支撑。";

  return {
    visualState,
    heading,
    pres,
    outlineOpen,
    overlayTitle,
    overlayDescription,
  };
}
