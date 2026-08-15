import { Icon } from "@/components/ui/icons";
import type { LearningRunPublicV1, LearningRunUiIntentV1 } from "../contracts";

const RESULT_TONE = {
  demonstrated: "success",
  partial: "warning",
  needs_repair: "danger",
  not_assessable: "neutral",
  practice_completed: "evidence",
  skipped: "neutral",
  declared_unable: "warning",
} as const;

type ResultViewProps = {
  run: LearningRunPublicV1;
  onIntent: (intent: LearningRunUiIntentV1) => void;
};

export function ResultView({ run, onIntent }: ResultViewProps) {
  const result = run.result;
  if (!result) return null;
  const tone = RESULT_TONE[result.outcome];
  const scheduleChanged = result.scheduleImpact.kind !== "none";
  const canRepair = result.outcome === "partial" || result.outcome === "needs_repair";
  const canRetryInput = result.outcome === "not_assessable";

  return (
    <section className={`learning-run-result is-${tone}`} aria-labelledby="learning-run-result-title">
      <div className="learning-run-result__hero">
        <span className="learning-run-result-mark" aria-hidden="true">
          {result.outcome === "demonstrated" ? <Icon.Check /> : result.outcome === "needs_repair" ? <Icon.Warn /> : <Icon.Sparkle2 />}
        </span>
        <div>
          <span className="learning-run-state-eyebrow">{result.eyebrow}</span>
          <h1 id="learning-run-result-title">{result.title}</h1>
          <p>{result.summary}</p>
        </div>
      </div>

      <div className="learning-run-result__grid">
        <section className="learning-run-result-panel">
          <span className="learning-run-result-panel__icon is-success"><Icon.Check aria-hidden="true" /></span>
          <div>
            <h2>这次证明了什么</h2>
            {result.demonstratedFacets.length > 0 ? (
              <ul>{result.demonstratedFacets.map((facet) => <li key={facet}>{facet}</li>)}</ul>
            ) : (
              <p>本轮没有形成可确认的正式理解证据。</p>
            )}
          </div>
        </section>

        <section className="learning-run-result-panel">
          <span className="learning-run-result-panel__icon is-warning"><Icon.Target aria-hidden="true" /></span>
          <div>
            <h2>还缺什么</h2>
            {result.gapFacets.length > 0 ? (
              <ul>{result.gapFacets.map((facet) => <li key={facet}>{facet}</li>)}</ul>
            ) : (
              <p>本轮目标已经覆盖，不需要追加题目。</p>
            )}
          </div>
        </section>
      </div>

      <section className={`learning-run-schedule-impact ${scheduleChanged ? "has-change" : "no-change"}`}>
        <span aria-hidden="true">{scheduleChanged ? <Icon.Review /> : <Icon.Lock />}</span>
        <div>
          <small>{scheduleChanged ? "复习安排已确认" : "复习安排没有改变"}</small>
          <strong>{result.scheduleImpact.kind === "none" ? "保持原计划" : result.scheduleImpact.dueLabel}</strong>
          <p>{result.scheduleImpact.explanation}</p>
        </div>
      </section>

      <div className="learning-run-next-step">
        <span>下一步</span>
        <p>{result.nextStep}</p>
      </div>

      <div className="learning-run-result__actions">
        {canRepair ? (
          <button className="learning-run-button is-primary" type="button" onClick={() => onIntent({ kind: "checkpoint_primary" })}>
            {result.outcome === "partial" ? "用 30 秒补上缺失点" : "做一个正反例修补"}
            <Icon.Arrow aria-hidden="true" />
          </button>
        ) : null}
        {canRetryInput ? (
          <>
            <button className="learning-run-button is-secondary" type="button" onClick={() => onIntent({ kind: "switch_variant", alternativeId: "text" })}>
              换成两三句话
            </button>
            <button className="learning-run-button is-primary" type="button" onClick={() => onIntent({ kind: "retry" })}>
              重新录制
              <Icon.Refresh aria-hidden="true" />
            </button>
          </>
        ) : null}
        <button className={`learning-run-button ${canRepair || canRetryInput ? "is-secondary" : "is-primary"}`} type="button" onClick={() => onIntent({ kind: "back" })}>
          {run.returnLabel}
          {!canRepair && !canRetryInput ? <Icon.Arrow aria-hidden="true" /> : null}
        </button>
      </div>
      <p className="learning-run-result__stop-note">本轮到这里结束，不会自动开始下一题。</p>
    </section>
  );
}
