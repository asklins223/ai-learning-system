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
      ? "暂时无法确认任务状态"
    : visualState === "partial"
      ? "部分结果已就绪"
    : visualState === "attention"
      ? "生成需要处理"
    : !isOwner
    ? generatedVersionId
      ? "查看学习卡"
      : "等待学习卡"
    : visualState === "success"
      ? "学习卡已就绪"
      : visualState === "generating"
        ? "正在生成学习卡"
        : visualState === "stale"
          ? "更新学习卡"
          : "生成学习卡";

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
      ? "暂时无法确认任务状态"
    : genState === "checking"
      ? "正在确认学习卡任务状态"
    : generationPhase === "saving"
      ? "正在锁定当前笔记版本"
      : generationPhase === "queued"
        ? "生成任务已进入队列"
        : "正在提炼关键理解";

  // ── 生成遮罩描述 ──
  const overlayDescription =
    genState === "status-error"
      ? "任务状态暂时不可用；编辑器不会因此保持锁定。"
    : genState === "checking"
      ? "正在与后台重新同步进度；恢复期间仍可继续编辑。"
    : generationPhase === "saving"
      ? "正在保存并封存这一刻的内容；服务端接受任务后立即恢复编辑。"
      : generationPhase === "queued"
        ? "系统正在准备模型与学习材料，很快开始提炼。"
        : "正在从文章中识别关键概念、关系与可验证的学习要点。";

  return {
    visualState,
    heading,
    pres,
    outlineOpen,
    overlayTitle,
    overlayDescription,
  };
}
