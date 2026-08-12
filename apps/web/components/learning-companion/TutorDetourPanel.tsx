"use client";

import { useState } from "react";
import type {
  LearningTutorDetour,
  LearningTutorTurnResult,
} from "@/features/companion/api/contracts";

export interface TutorDetourPanelProps {
  detour: LearningTutorDetour;
  result: LearningTutorTurnResult["turn"] | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (question: string) => void;
  onEnd: () => void;
}

export function TutorDetourPanel({
  detour,
  result,
  submitting,
  error,
  onSubmit,
  onEnd,
}: TutorDetourPanelProps) {
  const [question, setQuestion] = useState("");
  const canAsk = detour.status === "active" && detour.turnCount < detour.maxTurns;

  return (
    <section className="card-detail-tutor" aria-labelledby="card-detail-tutor-title" data-ui="tutor-detour">
      <div className="card-detail-tutor-heading">
        <div>
          <span className="card-detail-overview-kicker"><i aria-hidden="true" />一起弄清楚</span>
          <h2 id="card-detail-tutor-title">问一问这张学习卡</h2>
          <p>我只围绕当前卡片和它的原文依据说明，最多陪你走两次。</p>
        </div>
        <span className="card-detail-tutor-count" aria-label={`已说明 ${detour.turnCount} 次，共 ${detour.maxTurns} 次`}>
          {detour.turnCount}/{detour.maxTurns}
        </span>
      </div>

      {result && (
        <div className="card-detail-tutor-result" role="status" aria-live="polite">
          <p>{result.text}</p>
          {result.evidence.length > 0 && (
            <details>
              <summary>查看原文依据</summary>
              <ul>
                {result.evidence.map((item) => <li key={item.evidenceId}>{item.quote}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {error && <p className="card-detail-tutor-error" role="alert">{error}</p>}

      {canAsk ? (
        <form
          className="card-detail-tutor-form"
          onSubmit={(event) => {
            event.preventDefault();
            const value = question.trim();
            if (!value || submitting) return;
            onSubmit(value);
            setQuestion("");
          }}
        >
          <label htmlFor="card-detail-tutor-question">你想先弄清哪一点？</label>
          <textarea
            id="card-detail-tutor-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={2}
            maxLength={4_000}
            placeholder="例如：这句话为什么成立？"
            disabled={submitting}
          />
          <button type="submit" className="btn btn-primary" disabled={submitting || question.trim() === ""}>
            {submitting ? "正在整理…" : result ? "再说明一次" : "开始说明"}
          </button>
        </form>
      ) : (
        <p className="card-detail-tutor-limit">这次说明已经结束，可以回到原航程继续练习。</p>
      )}

      <button type="button" className="btn btn-secondary" onClick={onEnd} disabled={submitting}>
        返回原航程
      </button>
    </section>
  );
}
