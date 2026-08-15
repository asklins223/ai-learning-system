import { Icon } from "@/components/ui/icons";
import type { LearningRunPublicV1, LearningRunUiIntentV1 } from "../contracts";

type AssessmentProgressProps = {
  run: LearningRunPublicV1;
  onIntent: (intent: LearningRunUiIntentV1) => void;
};

export function AssessmentProgress({ run, onIntent }: AssessmentProgressProps) {
  const committing = run.phase === "committing";
  const title = committing ? "正在确认最终学习记录" : "正在独立评估你的回答";
  const detail = run.activeAssessment?.statusDetail
    ?? (committing
      ? "评估已经完成。只有学习记录和复习安排都确认后，页面才会显示最终结果。"
      : "回答已经锁定，不能重复提交。评估只读取你的原始回答和冻结的评分标准。 ");

  return (
    <section className="learning-run-state-card is-processing" aria-labelledby="learning-run-processing-title">
      <div className="learning-run-orbit" aria-hidden="true">
        <span />
        <i />
        <b />
      </div>
      <div className="learning-run-state-card__copy">
        <span className="learning-run-state-eyebrow">
          {committing ? "结果尚未生成" : "回答已安全锁定"}
        </span>
        <h1 id="learning-run-processing-title">{title}</h1>
        <p>{detail}</p>
      </div>
      <ol className="learning-run-processing-steps" aria-label="处理进度">
        <li className="is-complete"><Icon.Check aria-hidden="true" /><span>回答已锁定</span></li>
        <li className={committing ? "is-complete" : "is-active"}>
          {committing ? <Icon.Check aria-hidden="true" /> : <span className="learning-run-processing-dot" aria-hidden="true" />}
          <span>独立评估</span>
        </li>
        <li className={committing ? "is-active" : ""}>
          <span className="learning-run-processing-dot" aria-hidden="true" />
          <span>确认记录</span>
        </li>
      </ol>
      <div className="learning-run-state-card__actions">
        <button
          className="learning-run-button is-secondary"
          type="button"
          onClick={() => onIntent({ kind: "leave_while_waiting" })}
        >
          先离开，完成后告诉我
        </button>
      </div>
      <p className="learning-run-state-footnote">等待不会占用三分钟主动练习预算。</p>
    </section>
  );
}

