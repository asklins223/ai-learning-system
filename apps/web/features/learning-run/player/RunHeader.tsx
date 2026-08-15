import { memo } from "react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import type { LearningRunPublicV1, LearningRunUiIntentV1 } from "../contracts";

const PHASE_LABEL: Record<LearningRunPublicV1["phase"], string> = {
  preparing: "准备中",
  active: "进行中",
  assessing: "评估中",
  checkpoint: "检查点",
  committing: "确认结果",
  paused: "已暂停",
  completed: "已完成",
  ended: "已结束",
  skipped: "已跳过",
  cancelled: "已取消",
  stale: "已过期",
  recoverable_error: "需要处理",
};

// F#11（round3）：终态 phase 集合提升为模块级常量——原实现每渲内联新建数组。
const TERMINAL_PHASES: ReadonlyArray<LearningRunPublicV1["phase"]> = [
  "completed",
  "ended",
  "skipped",
  "cancelled",
  "stale",
];

type RunHeaderProps = {
  run: LearningRunPublicV1;
  onIntent: (intent: LearningRunUiIntentV1) => void;
};

// 第八轮 🟠B-1：RunHeader 包 memo，用默认浅比较。调用方在草稿击键期间
// 只变更 drafts state，run（=uiSnapshot 稳定引用）与 onIntent（useCallback
// 稳定）均不变 → memo 跳过 RunHeader 重渲，补上「drafts 隔离」对 header
// 的覆盖（昂贵 renderer 已被 ActiveTaskView memo 保护）。
export const RunHeader = memo(function RunHeader({ run, onIntent }: RunHeaderProps) {
  const canPause = run.phase === "active";
  const canResume = run.phase === "paused";
  const terminal = TERMINAL_PHASES.includes(run.phase);

  return (
    <header className="learning-run-header" data-electron-drag-region>
      <div className="learning-run-header__inner">
        <button
          className="learning-run-header__back"
          type="button"
          onClick={() => onIntent({ kind: "back" })}
        >
          <Icon.Arrow aria-hidden="true" />
          <span>{run.returnLabel}</span>
        </button>

        <div className="learning-run-header__identity" aria-label="当前微旅程">
          <span>{run.originLabel}</span>
          <strong>三分钟微旅程</strong>
        </div>

        <div className="learning-run-header__tools">
          <span className={`learning-run-phase-chip is-${run.phase}`}>
            <i aria-hidden="true" />
            {PHASE_LABEL[run.phase]}
          </span>
          {canPause ? (
            <button
              className="learning-run-icon-button"
              type="button"
              onClick={() => onIntent({ kind: "pause" })}
              aria-label="暂停本轮"
              title="暂停本轮"
            >
              <PauseIcon />
            </button>
          ) : null}
          {canResume ? (
            <button
              className="learning-run-icon-button"
              type="button"
              onClick={() => onIntent({ kind: "resume" })}
              aria-label="继续本轮"
              title="继续本轮"
            >
              <Icon.Play aria-hidden="true" />
            </button>
          ) : null}
          {!terminal ? (
            <button
              className="learning-run-icon-button"
              type="button"
              onClick={() => onIntent({ kind: "end" })}
              aria-label="结束本轮"
              title="结束本轮"
            >
              <Icon.Close aria-hidden="true" />
            </button>
          ) : null}
          <ThemeToggle className="learning-run-theme-toggle" size="sm" />
        </div>
      </div>
    </header>
  );
});

function PauseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 5v14M16 5v14" />
    </svg>
  );
}

