"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { PetIcon, type PetIconNameV1 } from "../surfaces/PetIcon";
import type {
  PetJourneyPresentationV2,
  PetJourneyUiIntentV2,
} from "./pet-journey-contracts";

export interface PetJourneyPresentationProps {
  presentation: PetJourneyPresentationV2;
  onIntent: (intent: PetJourneyUiIntentV2) => void;
  className?: string;
}

/**
 * Compact journey surface rendered beside the existing Live2D character.
 * This component never renders a character/avatar and never owns dialogue
 * history; it only projects one persisted Pet presentation at a time.
 */
export function PetJourneyPresentation({
  presentation,
  onIntent,
  className,
}: PetJourneyPresentationProps) {
  const cardRef = useRef<HTMLElement>(null);
  const confirmationRejectRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (presentation.kind !== "confirmation") return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    confirmationRejectRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [presentation.kind, presentation.presentationId]);

  if (presentation.kind === "silent") return null;

  const role = presentation.kind === "confirmation"
    ? "dialog"
    : presentation.kind === "recovery"
      ? "alert"
      : "region";
  const live = presentation.kind === "execution" || presentation.kind === "progress"
    ? "polite"
    : undefined;

  return (
    <section
      ref={cardRef}
      className={`pet-journey-card pet-journey-card--${presentation.kind}${className ? ` ${className}` : ""}`}
      data-pet-region="bubble"
      data-presentation-id={presentation.presentationId}
      data-speech-mode={presentation.speechMode}
      data-dismiss-policy={presentation.dismissPolicy}
      data-progress-state={presentation.kind === "progress" ? presentation.progress.state : undefined}
      data-result-outcome={presentation.kind === "result" ? presentation.outcome : undefined}
      role={role}
      aria-modal={presentation.kind === "confirmation" ? "true" : undefined}
      aria-live={live}
      aria-labelledby={`${presentation.presentationId}-message`}
      onKeyDown={presentation.kind === "confirmation"
        ? (event) => handleConfirmationKeyDown(event, cardRef.current, () => onIntent({
            kind: "reject_action",
            proposalId: presentation.proposalId,
          }))
        : undefined}
    >
      <div className="pet-journey-card__tail" aria-hidden="true" />
      <header className="pet-journey-card__header">
        <span className="pet-journey-card__emblem" aria-hidden="true">
          <PetIcon name={iconForPresentation(presentation)} />
        </span>
        <span className="pet-journey-card__context">{presentation.contextLabel}</span>
        {presentation.speechMode === "speak_message" ? (
          <span className="pet-journey-card__speech" title="伴星将朗读同一条历史消息">
            <PetIcon name="volume" />
            <span className="pet-journey-sr-only">将朗读这条消息</span>
          </span>
        ) : null}
      </header>

      <p id={`${presentation.presentationId}-message`} className="pet-journey-card__message">
        {presentation.message}
      </p>

      {presentation.kind === "invitation" ? (
        <div className="pet-journey-invitation">
          <div className="pet-journey-choice-stack" aria-label="选择开始方式">
            {presentation.choices.map((choice) => (
              <button
                key={choice.choiceId}
                type="button"
                className="pet-journey-choice"
                onClick={() => onIntent({
                  kind: "choose_invitation",
                  choiceId: choice.choiceId,
                  branch: choice.branch,
                })}
              >
                <span>
                  <strong>{choice.label}</strong>
                  <small>{choice.description}</small>
                </span>
                <PetIcon name="chevron" />
              </button>
            ))}
          </div>
          <button
            type="button"
            className="pet-journey-text-action"
            onClick={() => onIntent({ kind: "defer_invitation", permitId: presentation.accountPermitId })}
          >
            <PetIcon name="clock" /> {presentation.deferLabel}
          </button>
        </div>
      ) : null}

      {presentation.kind === "preference" ? (
        <div className="pet-journey-preference">
          <div className="pet-journey-step-meta">
            <span>偏好 {presentation.step}/{presentation.stepCount}</span>
            <span>可随时更改</span>
          </div>
          <div className="pet-journey-segments" role="group" aria-label="偏好选项">
            {presentation.choices.map((choice) => (
              <button
                key={choice.choiceId}
                type="button"
                className="pet-journey-segment"
                data-default={choice.value === presentation.defaultValue ? "true" : undefined}
                onClick={() => onIntent({
                  kind: "set_preference",
                  preference: presentation.preference,
                  value: choice.value,
                })}
              >
                <span>
                  <strong>{choice.label}</strong>
                  {choice.recommended ? <i>推荐</i> : null}
                </span>
                {choice.description ? <small>{choice.description}</small> : null}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="pet-journey-text-action"
            onClick={() => onIntent({ kind: "skip_preference", preference: presentation.preference })}
          >
            {presentation.skipLabel}
          </button>
        </div>
      ) : null}

      {presentation.kind === "progress" ? (
        <div className="pet-journey-progress" data-progress-state={presentation.progress.state}>
          <div className="pet-journey-progress__identity">
            <span className="pet-journey-progress__icon" aria-hidden="true">
              <PetIcon name={presentation.progress.state === "ready" ? "check" : presentation.progress.state === "failed" ? "alert" : "spinner"} />
            </span>
            <span>
              <strong>{presentation.progress.statusLabel}</strong>
              <small>{presentation.progress.sourceName}</small>
            </span>
          </div>
          <div
            className="pet-journey-progress__track"
            role="progressbar"
            aria-label={presentation.progress.statusLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={presentation.progress.percent ?? undefined}
            data-indeterminate={presentation.progress.percent === null ? "true" : "false"}
          >
            <i style={presentation.progress.percent === null ? undefined : { width: `${presentation.progress.percent}%` }} />
          </div>
          <p>{presentation.progress.detail}</p>
          {presentation.actions.length ? (
            <div className="pet-journey-actions">
              {presentation.actions.map((action) => (
                <button
                  key={action.actionId}
                  type="button"
                  className={action.primary ? "pet-journey-primary" : "pet-journey-secondary"}
                  onClick={() => onIntent({ kind: "progress_action", actionId: action.actionId, action: action.kind })}
                >
                  {action.label}
                  {action.primary ? <PetIcon name="chevron" /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {presentation.kind === "run_proposal" ? (
        <div className="pet-journey-proposal">
          <div className="pet-journey-proposal__target">
            <span><PetIcon name="study" />巩固目标</span>
            <strong>{presentation.target}</strong>
            <p>{presentation.targetDetail}</p>
          </div>
          <dl className="pet-journey-facts">
            <div><dt>预计</dt><dd>约 {presentation.estimatedMinutes} 分钟</dd></div>
            <div><dt>证明</dt><dd>{presentation.proofBoundary}</dd></div>
            <div><dt>复习</dt><dd>{presentation.scheduleBoundary}</dd></div>
          </dl>
          <div className="pet-journey-actions pet-journey-actions--split">
            <button
              type="button"
              className="pet-journey-secondary"
              onClick={() => onIntent({ kind: "reject_run_proposal", proposalId: presentation.proposalId })}
            >
              {presentation.secondaryLabel}
            </button>
            <button
              type="button"
              className="pet-journey-primary"
              onClick={() => onIntent({ kind: "open_run_proposal", proposalId: presentation.proposalId })}
            >
              {presentation.primaryLabel} <PetIcon name="chevron" />
            </button>
          </div>
        </div>
      ) : null}

      {presentation.kind === "confirmation" ? (
        <div className="pet-journey-confirmation">
          <div className="pet-journey-confirmation__title">
            <span><PetIcon name="card" /></span>
            <span><small>将要执行</small><strong>{presentation.actionName}</strong></span>
          </div>
          <dl className="pet-journey-confirmation__details">
            <div><dt>目标</dt><dd>{presentation.target}</dd></div>
            <div><dt>影响</dt><dd>{presentation.impactSummary}</dd></div>
          </dl>
          <p className="pet-journey-boundary"><PetIcon name="shield" />{presentation.boundaryNote}</p>
          <div className="pet-journey-actions pet-journey-actions--split">
            <button
              ref={confirmationRejectRef}
              type="button"
              className="pet-journey-secondary"
              onClick={() => onIntent({ kind: "reject_action", proposalId: presentation.proposalId })}
            >
              {presentation.rejectLabel}
            </button>
            <button
              type="button"
              className="pet-journey-primary"
              onClick={() => onIntent({ kind: "confirm_action", proposalId: presentation.proposalId })}
            >
              {presentation.confirmLabel} <PetIcon name="chevron" />
            </button>
          </div>
        </div>
      ) : null}

      {presentation.kind === "execution" ? (
        <div className="pet-journey-execution">
          <div className="pet-journey-execution__status">
            <span className="pet-journey-orbit" aria-hidden="true"><i /><i /></span>
            <span><strong>{presentation.statusLabel}</strong><small>{presentation.detail}</small></span>
          </div>
          <ol className="pet-journey-timeline">
            {presentation.steps.map((step) => (
              <li key={step.stepId} data-state={step.state}>
                <i aria-hidden="true">{step.state === "complete" ? <PetIcon name="check" /> : null}</i>
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="pet-journey-text-action"
            onClick={() => onIntent({ kind: "leave_execution", actionRunId: presentation.actionRunId })}
          >
            {presentation.leaveLabel}
          </button>
        </div>
      ) : null}

      {presentation.kind === "result" ? (
        <div className="pet-journey-result" data-outcome={presentation.outcome}>
          <div className="pet-journey-result__headline">
            <span><PetIcon name={presentation.outcome === "demonstrated" ? "check" : "review"} /></span>
            <span><small>本次结果</small><strong>{presentation.outcomeLabel}</strong></span>
          </div>
          <div className="pet-journey-result__proof">
            <span>{resultEvidenceLabel(presentation.outcome)}</span>
            <p>{presentation.proof}</p>
          </div>
          {presentation.gap ? (
            <div className="pet-journey-result__gap">
              <span>下一处缺口</span>
              <p>{presentation.gap}</p>
            </div>
          ) : null}
          <p className="pet-journey-schedule" data-changed={presentation.schedule.changed ? "true" : "false"}>
            <PetIcon name={presentation.schedule.changed ? "clock" : "shield"} />
            {presentation.schedule.label}
          </p>
          <button
            type="button"
            className="pet-journey-primary pet-journey-primary--wide"
            onClick={() => onIntent({
              kind: "result_action",
              resultRef: presentation.resultRef,
              action: presentation.primaryAction.kind,
            })}
          >
            {presentation.primaryAction.label} <PetIcon name="chevron" />
          </button>
        </div>
      ) : null}

      {presentation.kind === "recovery" ? (
        <div className="pet-journey-recovery">
          <div className="pet-journey-recovery__title">
            <span><PetIcon name="alert" /></span>
            <strong>{presentation.title}</strong>
          </div>
          <dl>
            <div><dt>当前影响</dt><dd>{presentation.impact}</dd></div>
            <div><dt>怎么恢复</dt><dd>{presentation.recovery}</dd></div>
          </dl>
          <div className="pet-journey-actions pet-journey-actions--split">
            <button
              type="button"
              className="pet-journey-secondary"
              onClick={() => onIntent({ kind: "dismiss_recovery", errorCode: presentation.errorCode })}
            >
              {presentation.dismissLabel}
            </button>
            {presentation.retryLabel ? (
              <button
                type="button"
                className="pet-journey-primary"
                onClick={() => onIntent({ kind: "retry_recovery", errorCode: presentation.errorCode })}
              >
                {presentation.retryLabel} <PetIcon name="review" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function iconForPresentation(presentation: Exclude<PetJourneyPresentationV2, { kind: "silent" }>): PetIconNameV1 {
  switch (presentation.kind) {
    case "invitation": return "sparkles";
    case "preference": return "settings";
    case "progress": return presentation.progress.state === "failed" ? "alert" : "study";
    case "run_proposal": return "study";
    case "confirmation": return "shield";
    case "execution": return "spinner";
    case "result": return presentation.outcome === "demonstrated" ? "sparkles" : "review";
    case "recovery": return "alert";
  }
}

function resultEvidenceLabel(outcome: Extract<PetJourneyPresentationV2, { kind: "result" }>["outcome"]): string {
  switch (outcome) {
    case "demonstrated": return "已经证明";
    case "partial": return "已确认的部分";
    case "needs_repair": return "当前证据";
    case "practice_completed": return "这次完成了";
    case "skipped": return "本次记录";
    case "declared_unable": return "已记录";
    case "not_assessable": return "可确认的事实";
  }
}

function handleConfirmationKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  card: HTMLElement | null,
  reject: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    reject();
    return;
  }
  if (event.key !== "Tab" || !card) return;
  const focusable = Array.from(card.querySelectorAll<HTMLElement>(
    "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
  ));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
