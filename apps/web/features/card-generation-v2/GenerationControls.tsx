"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/icons";
import { CardLimitStepper } from "./components/CardLimitStepper";
import { CustomScopePicker } from "./components/CustomScopePicker";
import type {
  CardDetailThresholdV2,
  CardLearningGoalV2,
  CardStrategyV2,
  GenerationControlsDraftV2,
} from "./contracts/ui-contracts";

const GOALS: Array<{
  value: CardLearningGoalV2;
  label: string;
  hint: string;
}> = [
  { value: "understand", label: "理解并能解释", hint: "默认 · 抓住机制与关系" },
  { value: "remember", label: "记住关键事实", hint: "名称、顺序与准确表述" },
  { value: "apply", label: "能够应用", hint: "边界、判断与迁移" },
  { value: "exam", label: "考试复习", hint: "关键目标与易混点" },
];

const DETAILS: Array<{ value: CardDetailThresholdV2; label: string }> = [
  { value: "concise", label: "精简" },
  { value: "balanced", label: "平衡" },
  { value: "deep", label: "深入" },
];

const STRATEGIES: Array<{ value: CardStrategyV2; label: string }> = [
  { value: "recall", label: "回忆" },
  { value: "cloze", label: "填空" },
  { value: "compare", label: "比较" },
  { value: "sequence", label: "顺序" },
  { value: "why", label: "原因" },
  { value: "boundary", label: "边界" },
  { value: "application", label: "应用" },
];

export interface GenerationControlsProps {
  value: GenerationControlsDraftV2;
  noteVersion: number;
  sourceLabel?: string;
  selectionAvailable?: boolean;
  disabled?: boolean;
  submitLabel?: string;
  onChange: (next: GenerationControlsDraftV2) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  capability: "preview" | "available";
}

function updateSet(
  values: CardStrategyV2[],
  value: CardStrategyV2,
): CardStrategyV2[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

export function GenerationControls({
  value,
  noteVersion,
  sourceLabel = "整篇笔记",
  selectionAvailable = false,
  disabled = false,
  submitLabel = "分析哪些内容值得练",
  onChange,
  onSubmit,
  onCancel,
  capability,
}: GenerationControlsProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <section className="card-v2-controls" aria-labelledby="card-v2-controls-title">
      <header className="card-v2-controls__header">
        <div className="card-v2-controls__mark" aria-hidden="true">
          <Icon.Sparkle />
        </div>
        <div>
          <p className="card-v2-controls__eyebrow">价值优先生成</p>
          <h2 id="card-v2-controls-title">先决定什么值得学</h2>
          <p>系统会合并碎片、过滤低价值内容，也可能建议 0 张卡。</p>
        </div>
      </header>

      <div className="card-v2-controls__source" aria-label="生成来源">
        <Icon.FileText />
        <span>
          <strong>{sourceLabel}</strong>
          <small>基于已保存版本 v{noteVersion}</small>
        </span>
        <CustomScopePicker
          value={value.sourceScope}
          selectionAvailable={selectionAvailable}
          disabled={disabled}
          onChange={(sourceScope) => onChange({
            ...value,
            sourceScope,
          })}
        />
      </div>

      <fieldset className="card-v2-controls__fieldset">
        <legend>你希望以后能做到什么？</legend>
        <div className="card-v2-controls__goal-grid">
          {GOALS.map((goal) => (
            <label
              className="card-v2-controls__goal"
              data-selected={value.learningGoal === goal.value || undefined}
              key={goal.value}
            >
              <input
                type="radio"
                name="card-learning-goal"
                value={goal.value}
                checked={value.learningGoal === goal.value}
                disabled={disabled}
                onChange={() => onChange({ ...value, learningGoal: goal.value })}
              />
              <span>
                <strong>{goal.label}</strong>
                <small>{goal.hint}</small>
              </span>
              <span className="card-v2-controls__radio" aria-hidden="true" />
            </label>
          ))}
        </div>
      </fieldset>

      <div className="card-v2-controls__detail-row">
        <div>
          <strong>细节倾向</strong>
          <small>只改变纳入门槛，不要求凑卡数</small>
        </div>
        <div className="card-v2-controls__segments" aria-label="细节倾向">
          {DETAILS.map((detail) => (
            <button
              type="button"
              key={detail.value}
              aria-pressed={value.detailThreshold === detail.value}
              disabled={disabled}
              onClick={() => onChange({ ...value, detailThreshold: detail.value })}
            >
              {detail.label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="card-v2-controls__advanced-toggle"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((open) => !open)}
      >
        <span>高级设置</span>
        <small>
          {value.hardMaxCards === null ? "智能数量" : `最多 ${value.hardMaxCards} 张`}
          {" · 可选卡片策略"}
        </small>
        <Icon.Chevron aria-hidden="true" />
      </button>

      {advancedOpen && (
        <div className="card-v2-controls__advanced">
          <div className="card-v2-controls__max">
            <span>
              <strong>最多生成</strong>
              <small>这是硬上限，不是目标数量</small>
            </span>
            <CardLimitStepper
              value={value.hardMaxCards}
              max={12}
              disabled={disabled}
              onChange={(hardMaxCards) => onChange({ ...value, hardMaxCards })}
            />
          </div>

          <fieldset className="card-v2-controls__strategy-fieldset">
            <legend>偏好的练习结构 <small>系统仍会按内容选择</small></legend>
            <div className="card-v2-controls__chips">
              {STRATEGIES.map((strategy) => (
                <label key={strategy.value}>
                  <input
                    type="checkbox"
                    checked={value.preferredStrategies.includes(strategy.value)}
                    disabled={disabled}
                    onChange={() => onChange({
                      ...value,
                      preferredStrategies: updateSet(
                        value.preferredStrategies,
                        strategy.value,
                      ),
                    })}
                  />
                  <span>{strategy.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}

      {capability === "preview" && (
        <p className="card-v2-controls__capability" role="note">
          <Icon.Warn aria-hidden="true" />
          这是 Card V2 接口预览。当前生产生成器尚未支持这些设置，提交动作已安全关闭。
        </p>
      )}

      <footer className="card-v2-controls__footer">
        <div>
          <strong>
            {value.hardMaxCards === null ? "智能数量" : `最多 ${value.hardMaxCards} 张`}
          </strong>
          <span>可能为 0 · 不自动启用</span>
        </div>
        <div className="card-v2-controls__actions">
          {onCancel && (
            <button type="button" className="card-v2-button card-v2-button--quiet" onClick={onCancel}>
              取消
            </button>
          )}
          <button
            type="button"
            className="card-v2-button card-v2-button--primary"
            disabled={disabled || capability === "preview"}
            onClick={onSubmit}
          >
            <Icon.Sparkle aria-hidden="true" />
            {submitLabel}
          </button>
        </div>
      </footer>
    </section>
  );
}
