"use client";

import { Icon } from "@/components/ui/icons";

export interface LearningCardActionsProps {
  /** 当前学习卡唯一的主行动。 */
  onStartJourney: () => void;
  /** 打开当前学习卡已有的原文依据。 */
  onViewEvidence: () => void;
  /** 窄屏时让按钮自然堆叠。 */
  compact?: boolean;
}

/**
 * 学习卡的决策区只回答两个问题：现在练什么，以及依据在哪里。
 * 标题、摘要、要点与理解状态均由上方概览和正文负责，避免在这里重复内容。
 */
export function LearningCardActions({
  onStartJourney,
  onViewEvidence,
  compact = false,
}: LearningCardActionsProps) {
  return (
    <section
      aria-labelledby="card-practice-action-title"
      data-ui="lc-learning-card-actions"
      className={`card-detail-learning-actions${compact ? " is-compact" : ""}`}
    >
      <div className="card-detail-learning-actions-copy">
        <span>下一步</span>
        <h2 id="card-practice-action-title">用一次独立回答巩固理解</h2>
        <p>先根据记忆说清楚，再由系统依据这张学习卡完成评估。</p>
      </div>

      <div className="card-detail-learning-actions-buttons">
        <button
          type="button"
          onClick={onStartJourney}
          data-ui="lc-card-primary-action"
          className="card-detail-learning-primary"
        >
          <span>开始巩固练习</span>
          <Icon.Arrow aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onViewEvidence}
          data-ui="lc-card-evidence-action"
          className="card-detail-learning-secondary"
        >
          <Icon.Eye aria-hidden="true" />
          <span>查看原文依据</span>
        </button>
      </div>
    </section>
  );
}
