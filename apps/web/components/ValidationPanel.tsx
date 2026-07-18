"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/icons";
import type { ValidationFeedback, ValidationOutcome } from "@/lib/api";

export type { ValidationOutcome };

export interface ValidationQuestion {
  type: "explain" | "example" | "apply";
  prompt: string;
  refClaim: string;
  refQuote: string;
  keyPointId?: string;
}

export type { ValidationFeedback };

const TYPE_LABEL: Record<ValidationQuestion["type"], string> = {
  explain: "解释",
  example: "举例",
  apply: "应用",
};

const ANSWER_LIMIT = 500;

export function ValidationPanel({
  questions,
  evidenceQuote,
  onSubmit,
  busy = false,
  feedback = null,
  initialAnswer = "",
  initialKeyPointId = null,
  nextReviewAt = null,
  onOpenEvidence,
}: {
  questions: ValidationQuestion[];
  evidenceQuote: string;
  onSubmit?: (answer: string, q: ValidationQuestion) => Promise<ValidationFeedback> | ValidationFeedback;
  busy?: boolean;
  feedback?: ValidationFeedback | null;
  initialAnswer?: string;
  initialKeyPointId?: string | null;
  nextReviewAt?: string | null;
  onOpenEvidence?: (keyPointId: string) => void;
}) {
  const initialQuestion =
    questions.find(
      (question) => question.keyPointId === initialKeyPointId,
    ) ?? questions[0];
  const initialQuestionKey = initialQuestion
    ? getQuestionKey(initialQuestion)
    : "";
  const [currentQuestionKey, setCurrentQuestionKey] = useState(
    initialQuestionKey,
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    initialQuestionKey && initialAnswer
      ? { [initialQuestionKey]: initialAnswer }
      : {},
  );
  const [dirtyDrafts, setDirtyDrafts] = useState<Record<string, boolean>>(
    {},
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFeedback, setActiveFeedback] = useState<ValidationFeedback | null>(feedback);

  useEffect(() => {
    setActiveFeedback(feedback);
  }, [feedback]);

  useEffect(() => {
    if (!initialAnswer) return;
    const matchingQuestion =
      questions.find(
        (question) => question.keyPointId === initialKeyPointId,
      ) ?? (!initialKeyPointId ? questions[0] : undefined);
    if (!matchingQuestion) return;
    const matchingKey = getQuestionKey(matchingQuestion);
    if (!dirtyDrafts[matchingKey]) {
      setDrafts((current) => ({
        ...current,
        [matchingKey]: initialAnswer,
      }));
    }
  }, [dirtyDrafts, initialAnswer, initialKeyPointId, questions]);

  useEffect(() => {
    if (questions.length === 0) return;
    const stillExists = questions.some(
      (question) => getQuestionKey(question) === currentQuestionKey,
    );
    if (stillExists) return;

    const fallback =
      questions.find(
        (question) => question.keyPointId === initialKeyPointId,
      ) ?? questions[0];
    setCurrentQuestionKey(getQuestionKey(fallback));
    setActiveFeedback(
      fallback.keyPointId === initialKeyPointId ? feedback : null,
    );
    setError(null);
  }, [
    currentQuestionKey,
    feedback,
    initialKeyPointId,
    questions,
  ]);

  if (questions.length === 0) return null;

  const matchedIndex = questions.findIndex(
    (question) => getQuestionKey(question) === currentQuestionKey,
  );
  const currentIdx = matchedIndex >= 0 ? matchedIndex : 0;
  const q = questions[currentIdx];
  const questionKey = getQuestionKey(q);
  const answer = drafts[questionKey] ?? "";
  const visibleFeedback =
    currentQuestionKey === questionKey ? activeFeedback : null;
  const isSubmitting = busy || pending;
  const activeEvidenceQuote = q.refQuote || evidenceQuote;

  async function submit() {
    if (!answer.trim() || !onSubmit || isSubmitting) return;
    setPending(true);
    setError(null);
    try {
      const result = await onSubmit(answer, q);
      setActiveFeedback(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  function nextQuestion() {
    const nextIndex = (currentIdx + 1) % questions.length;
    const next = questions[nextIndex] ?? questions[0];
    setError(null);
    setActiveFeedback(null);
    setCurrentQuestionKey(getQuestionKey(next));
  }

  return (
    <section className="ref-validation-panel" aria-labelledby="ref-validation-title" data-ui="validation-panel">
      <header className="ref-validation-header">
        <div className="ref-validation-heading">
          <span className="ref-validation-bulb" aria-hidden="true">
            <ValidationBulb />
          </span>
          <h2 id="ref-validation-title" className="ref-validation-title">
            验证理解
          </h2>
        </div>

        <div className="ref-validation-actions">
          <span className="ref-validation-progress">
            {currentIdx + 1} / {questions.length}
            <b>{TYPE_LABEL[q.type]}</b>
          </span>
          <button
            type="button"
            className="ref-validation-refresh"
            onClick={nextQuestion}
            disabled={isSubmitting || questions.length < 2}
            aria-label="换一道验证题"
            title="换一道验证题"
          >
            <Icon.Refresh aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="ref-validation-body">
        <section className="ref-validation-question" aria-labelledby="ref-validation-question-title">
          <p id="ref-validation-question-title" className="ref-validation-question-text">
            {q.prompt}
          </p>
          <span className="ref-validation-knowledge-tag" title={q.refClaim}>
            知识点：{q.refClaim}
          </span>
        </section>

        <div className="ref-validation-answer-field">
          <label className="ref-validation-answer-label" htmlFor="ref-validation-answer">
            我的回答
          </label>
          <div className="ref-validation-textarea-wrap">
            <textarea
              id="ref-validation-answer"
              value={answer}
              onChange={(event) => {
                const nextAnswer = event.target.value;
                setDrafts((current) => ({
                  ...current,
                  [questionKey]: nextAnswer,
                }));
                setDirtyDrafts((current) => ({
                  ...current,
                  [questionKey]: true,
                }));
                if (visibleFeedback) setActiveFeedback(null);
              }}
              placeholder="用你自己的话回答…"
              rows={4}
              maxLength={ANSWER_LIMIT}
              disabled={isSubmitting}
              className="ref-validation-textarea"
              aria-describedby="ref-validation-count"
            />
            <span id="ref-validation-count" className="ref-validation-count">
              {answer.length}/{ANSWER_LIMIT}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={isSubmitting || !answer.trim() || !onSubmit}
          className="ref-validation-submit"
        >
          <SendIcon />
          <span>{isSubmitting ? "判断中…" : "提交回答"}</span>
        </button>

        {error && (
          <p className="ref-validation-error" role="alert">
            {error}
          </p>
        )}

        {visibleFeedback ? (
          <FeedbackView feedback={visibleFeedback} />
        ) : (
          <div className="ref-validation-feedback-empty" aria-live="polite">
            <span className="ref-validation-feedback-empty-dot" aria-hidden="true" />
            <span>{isSubmitting ? "正在核对你的回答…" : "提交回答后查看验证结果"}</span>
          </div>
        )}

        <EvidenceQuote
          quote={activeEvidenceQuote}
          refs={visibleFeedback?.evidenceRefs ?? []}
          keyPointId={q.keyPointId}
          onOpenEvidence={onOpenEvidence}
        />
        <NextReviewCard feedback={visibleFeedback} nextReviewAt={nextReviewAt} />
      </div>
    </section>
  );
}

function getQuestionKey(question: ValidationQuestion): string {
  return (
    question.keyPointId ??
    `${question.type}:${question.prompt}:${question.refClaim}`
  );
}

function FeedbackView({ feedback }: { feedback: ValidationFeedback }) {
  const meta = outcomeMeta(feedback.outcome);
  const hasDetails =
    feedback.coveredPoints.length > 0 ||
    feedback.missingPoints.length > 0 ||
    feedback.misunderstandings.length > 0;

  return (
    <section
      className={`ref-validation-feedback ref-validation-feedback--${meta.tone}`}
      aria-label="验证结果"
      aria-live="polite"
    >
      <div className="ref-validation-feedback-heading">
        <span className="ref-validation-feedback-icon" aria-hidden="true">
          {meta.tone === "positive" ? <Icon.Check /> : <Icon.Warn />}
        </span>
        <div>
          <h3 className="ref-validation-feedback-title">{meta.label}</h3>
          <p className="ref-validation-feedback-confidence">
            判定置信度 {Math.round(feedback.confidence * 100)}%
          </p>
        </div>
      </div>

      <p className="ref-validation-feedback-copy">
        {feedback.feedback || meta.fallback}
      </p>

      {hasDetails && (
        <div className="ref-validation-feedback-details">
          {feedback.coveredPoints.length > 0 && (
            <FeedbackPoints tone="covered" label="已覆盖" items={feedback.coveredPoints} />
          )}
          {feedback.missingPoints.length > 0 && (
            <FeedbackPoints tone="missing" label="待补充" items={feedback.missingPoints} />
          )}
          {feedback.misunderstandings.length > 0 && (
            <FeedbackPoints tone="warning" label="需纠正" items={feedback.misunderstandings} />
          )}
        </div>
      )}
    </section>
  );
}

function FeedbackPoints({
  tone,
  label,
  items,
}: {
  tone: "covered" | "missing" | "warning";
  label: string;
  items: string[];
}) {
  return (
    <div className={`ref-validation-points ref-validation-points--${tone}`}>
      <p className="ref-validation-points-label">{label}</p>
      <ul className="ref-validation-points-list">
        {items.map((item, index) => (
          <li key={`${tone}-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function EvidenceQuote({
  quote,
  refs,
  keyPointId,
  onOpenEvidence,
}: {
  quote: string;
  refs: string[];
  keyPointId?: string;
  onOpenEvidence?: (keyPointId: string) => void;
}) {
  return (
    <section className="ref-validation-evidence" aria-labelledby="ref-validation-evidence-title">
      <h3 id="ref-validation-evidence-title" className="ref-validation-section-title">
        证据引用
      </h3>
      <blockquote className="ref-validation-quote">
        {quote ? `“${quote}”` : "暂无可引用的原文证据"}
      </blockquote>
      {refs.length > 0 && (
        <p className="ref-validation-evidence-refs">参考段落：{refs.join("、")}</p>
      )}
      {keyPointId && onOpenEvidence && (
        <button
          type="button"
          className="ref-validation-evidence-open"
          onClick={() => onOpenEvidence(keyPointId)}
        >
          回到原文
          <Icon.LinkOut aria-hidden="true" />
        </button>
      )}
    </section>
  );
}

function NextReviewCard({ feedback, nextReviewAt }: { feedback: ValidationFeedback | null; nextReviewAt: string | null }) {
  const copy = getReviewCopy(feedback?.outcome, nextReviewAt);

  return (
    <section className="ref-validation-review" aria-labelledby="ref-validation-review-title">
      <h3 id="ref-validation-review-title" className="ref-validation-section-title">
        下一次复习
      </h3>
      <div className="ref-validation-review-card">
        <span className="ref-validation-review-icon" aria-hidden="true">
          <CalendarIcon />
        </span>
        <div className="ref-validation-review-copy">
          <strong>{copy.title}</strong>
          <span>{copy.detail}</span>
        </div>
        <button type="button" className="ref-validation-review-adjust" title="复习计划将在同步后开放调整" disabled>
          调整计划
        </button>
      </div>
    </section>
  );
}

function outcomeMeta(outcome: ValidationOutcome) {
  switch (outcome) {
    case "preliminary_understanding":
      return {
        label: "初步理解",
        tone: "positive" as const,
        fallback: "本次回答已体现对关键概念的初步理解。",
      };
    case "unclear_expression":
      return {
        label: "表达不清",
        tone: "caution" as const,
        fallback: "部分表述还不够明确，建议结合原文证据再说明一次。",
      };
    case "misunderstanding":
      return {
        label: "存在误解",
        tone: "negative" as const,
        fallback: "回答中存在需要纠正的理解，请先回看证据引用。",
      };
    default:
      return {
        label: "暂无法判断",
        tone: "neutral" as const,
        fallback: "现有回答不足以完成判断，可以补充细节后重试。",
      };
  }
}

function getReviewCopy(outcome?: ValidationOutcome, nextReviewAt?: string | null) {
  const schedule = formatScheduledReview(nextReviewAt);
  if (schedule) return schedule;
  switch (outcome) {
    case "preliminary_understanding":
      return { title: "等待计划同步", detail: "验证结果已记录，复习时间将由学习计划安排" };
    case "unclear_expression":
      return { title: "建议再次验证", detail: "回看关键证据后，用自己的话补充说明" };
    case "misunderstanding":
      return { title: "先回看原文", detail: "纠正误解后再进入下一次复习" };
    case "unknown":
      return { title: "等待重新验证", detail: "补充回答后，系统将更新复习安排" };
    default:
      return { title: "尚未安排", detail: "完成本次验证后生成复习建议" };
  }
}

function formatScheduledReview(value?: string | null) {
  if (!value) return null;
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const days = Math.round((targetDay.getTime() - startOfToday.getTime()) / 86_400_000);
  const title = days < 0 ? "复习已到期" : days === 0 ? "今天" : days === 1 ? "明天" : `${days} 天后`;
  const detail = new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(target).replace(/(日)(周)/, "$1 $2");
  return { title, detail };
}

function ValidationBulb() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <path d="M8.1 14.6A6 6 0 1 1 16 14.5c-.9.8-1.3 1.6-1.4 2.5H9.5c-.1-.9-.5-1.7-1.4-2.4Z" />
      <path d="M9.6 20h4.8M9.5 17h5" />
      <path d="M12 1V0M4.9 4.9 3.7 3.7M19.1 4.9l1.2-1.2M2 12H.5M23.5 12H22" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg className="ref-validation-submit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m3 11 18-8-7.5 18-2.2-7.8L3 11Z" />
      <path d="m11.3 13.2 4.4-4.4" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" role="presentation">
      <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
      <path d="M8 3v5M16 3v5M3.5 10h17" />
      <path d="M8 14h3v3H8z" />
    </svg>
  );
}
