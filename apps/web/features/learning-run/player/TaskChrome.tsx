import { Icon } from "@/components/ui/icons";
import type { LearningTaskPublicV1 } from "../contracts";

const INTENT_LABEL: Record<LearningTaskPublicV1["intent"], string> = {
  recall: "回忆",
  paraphrase: "用自己的话",
  explain: "解释机制",
  example: "举例",
  apply: "应用",
  boundary: "边界辨析",
  procedure: "重建步骤",
  relate: "建立关联",
  repair: "修复理解",
};

const PURPOSE_LABEL: Record<LearningTaskPublicV1["purpose"], string> = {
  formal: "独立证明",
  facet: "局部证据",
  diagnostic: "诊断练习",
  practice: "辅助练习",
};

const TRUST_LABEL: Record<LearningTaskPublicV1["trustCeiling"], string> = {
  mastery_eligible: "可形成正式理解证据",
  facet_eligible: "最多形成局部证据",
  diagnostic_only: "只用于定位问题",
  practice_only: "只记录为练习",
  not_assessable: "当前不可评估",
};

export function TaskChrome({ task }: { task: LearningTaskPublicV1 }) {
  return (
    <div className="learning-run-task-chrome">
      <div className="learning-run-task-chrome__chips">
        <span className="learning-run-kicker-chip">
          <Icon.Target aria-hidden="true" />
          {INTENT_LABEL[task.intent]}
        </span>
        <span className={`learning-run-purpose-chip is-${task.purpose}`}>
          {PURPOSE_LABEL[task.purpose]}
        </span>
        <span className="learning-run-estimate">
          约 {task.estimatedActiveSeconds} 秒
        </span>
      </div>

      <p className="learning-run-task-chrome__label">{task.title}</p>
      <h1>{task.prompt}</h1>
      <div className="learning-run-task-chrome__target">
        <Icon.Compass aria-hidden="true" />
        <span>
          <small>这次要证明</small>
          <strong>{task.targetSummary}</strong>
        </span>
      </div>
      {task.hint ? (
        <aside className="learning-run-task-hint" role="note">
          <span><Icon.Sparkle aria-hidden="true" />一级提示 · 本题已降为练习</span>
          <p>{task.hint}</p>
        </aside>
      ) : null}
      <p className="learning-run-trust-note">
        <Icon.Lock aria-hidden="true" />
        {TRUST_LABEL[task.trustCeiling]} · 提交前不揭示对错
      </p>
    </div>
  );
}
