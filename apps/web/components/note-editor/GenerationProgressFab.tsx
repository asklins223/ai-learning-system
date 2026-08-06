"use client";

/**
 * Phase B/C：生成进度悬浮按钮（右下角）。
 *
 * 弹窗被隐藏（用户点了"隐藏进度，继续编辑"）后，显示在笔记编辑区
 * 右下角；点击重新打开进度弹窗。生成任务结束时自动消失。
 *
 * 视觉沿用现有弹窗的 evidence/轨道语言，保持低调不遮挡编辑区。
 */

import { Icon } from "@/components/ui/icons";

export interface GenerationProgressFabProps {
  /** 是否有需要展示进度的生成任务（flag 开启 + run 存在时） */
  show: boolean;
  /** 点击重新打开进度弹窗 */
  onOpen: () => void;
  /** 当前阶段标签（如 "提炼卡片"） */
  stageLabel: string;
}

export function GenerationProgressFab({ show, onOpen, stageLabel }: GenerationProgressFabProps) {
  if (!show) return null;
  return (
    <button
      type="button"
      className="generation-progress-fab"
      onClick={onOpen}
      aria-label={`查看生成进度（${stageLabel}）`}
      title="查看生成进度"
    >
      <span className="generation-progress-fab-orbit" aria-hidden="true" />
      <Icon.Sparkle aria-hidden="true" />
      <span className="generation-progress-fab-label">{stageLabel}</span>
    </button>
  );
}
