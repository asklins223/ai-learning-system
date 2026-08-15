"use client";

/** 弹窗最小化后的轻量恢复入口。 */

import { Icon } from "@/components/ui/icons";

export interface GenerationProgressFabProps {
  show: boolean;
  onOpen: () => void;
  stageLabel: string;
}

export function GenerationProgressFab({ show, onOpen, stageLabel }: GenerationProgressFabProps) {
  if (!show) return null;
  return (
    <button
      type="button"
      className="generation-progress-fab"
      onClick={onOpen}
      aria-label={`恢复学习卡生成进度：${stageLabel}`}
      title="恢复生成进度"
    >
      <span className="generation-progress-fab-icon" aria-hidden="true">
        <Icon.Card />
        <i />
      </span>
      <span className="generation-progress-fab-copy">
        <small>学习卡生成中</small>
        <strong className="generation-progress-fab-label">{stageLabel}</strong>
      </span>
      <Icon.Chevron className="generation-progress-fab-arrow" aria-hidden="true" />
    </button>
  );
}
