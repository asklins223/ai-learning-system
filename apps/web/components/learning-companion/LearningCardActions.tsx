"use client";

import { Icon } from "@/components/ui/icons";

export interface LearningCardActionsProps {
  /** 当前学习卡唯一的主行动。 */
  onStartJourney: () => void;
  /** 打开当前学习卡已有的原文依据。 */
  onViewEvidence: () => void;
  /** 窄屏时让按钮自然堆叠。 */
  compact?: boolean;
  /** 仅在统一 LearningRun UI 原型可达时展示多模态承诺。 */
  uiPreview?: boolean;
  /** learning_run_v1 已切流：入口真实可用（文案从"预览"改为正式承诺）。 */
  live?: boolean;
}

/**
 * 学习卡的决策区只回答两个问题：现在练什么，以及依据在哪里。
 * 标题、摘要、要点与理解状态均由上方概览和正文负责，避免在这里重复内容。
 */
export function LearningCardActions({
  onStartJourney,
  onViewEvidence,
  compact = false,
  uiPreview = process.env.NODE_ENV !== "production",
  live = false,
}: LearningCardActionsProps) {
  const showRunCopy = uiPreview || live;
  return (
    <section
      aria-labelledby="card-practice-action-title"
      data-ui="lc-learning-card-actions"
      className={`card-detail-learning-actions${compact ? " is-compact" : ""}`}
    >
      <div className="card-detail-learning-actions-copy">
        <span>{showRunCopy ? "一个要点 · 一次微旅程" : "当前学习卡 · 独立巩固"}</span>
        <h2 id="card-practice-action-title">
          {showRunCopy ? "用三分钟巩固一下" : "巩固这项理解"}
        </h2>
        <p>
          {showRunCopy
            ? "进入后直接开始推荐动作。可以说出来、动手排一排或写两句；提交后由系统独立评估。"
            : "先根据记忆独立回答，再查看判断和原文依据。"}
        </p>
        <ul className="card-detail-learning-actions-facts" aria-label="巩固练习说明">
          {showRunCopy ? (
            <>
              <li><Icon.Review aria-hidden="true" />最多 3 分钟</li>
              <li><Icon.Keyboard aria-hidden="true" />不要求写长文</li>
              <li><Icon.Target aria-hidden="true" />不会自动下一题</li>
            </>
          ) : (
            <>
              <li><Icon.Review aria-hidden="true" />独立作答</li>
              <li><Icon.Target aria-hidden="true" />完成后查看结果</li>
            </>
          )}
        </ul>
      </div>

      <div className="card-detail-learning-actions-buttons">
        <button
          type="button"
          onClick={onStartJourney}
          data-ui="lc-card-primary-action"
          className="card-detail-learning-primary"
        >
          <span>{live ? "开始三分钟巩固" : uiPreview ? "预览这次微旅程" : "开始巩固"}</span>
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
