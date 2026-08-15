"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/icons";
import type {
  LearningCardRevealContentV2,
  PublicLearningCardPreviewV2,
} from "@/features/card-generation-v2/contracts/ui-contracts";
import { LifecycleActions, type LearningCardLifecycleActionV2 } from "./lifecycle-actions/LifecycleActions";
import { PublicCardFront } from "./public-card/PublicCardFront";
import { LearningCardReveal } from "./reveal/LearningCardReveal";
import {
  learningCardInteractionLabels,
  learningCardInteractionRendererRegistry,
} from "./renderers/InteractionRendererRegistry";

type StateActionIntent = "open_schedule" | "open_replacement" | "refresh" | "return";

interface ActiveLearningCardV2Props {
  card: PublicLearningCardPreviewV2;
  capability?: "preview" | "available";
  /** Reveal receipt/content is deliberately separate from the answer-free public Card DTO. */
  initialReveal?: LearningCardRevealContentV2 | null;
  initialRevealError?: string | null;
  onReveal: (cardId: string) => Promise<LearningCardRevealContentV2>;
  onStartLearning: (context: {
    cardId: string;
    objectiveId: string;
    exposureId: string | null;
  }) => void;
  onStateAction?: (context: { cardId: string; intent: StateActionIntent }) => void;
  onLifecycleAction?: (action: LearningCardLifecycleActionV2) => void;
}

type RevealState =
  | { status: "hidden" }
  | { status: "loading" }
  | { status: "revealed"; content: LearningCardRevealContentV2 }
  | { status: "error"; message: string };

interface CardPresentation {
  label: string;
  detail: string;
  action: { intent: PublicLearningCardPreviewV2["primaryAction"]["intent"]; label: string };
  blocked: boolean;
  tone: string;
}

function resolvePresentation(card: PublicLearningCardPreviewV2): CardPresentation {
  if (card.lifecycle.status === "archived") {
    return {
      label: card.lifecycle.label || "已归档",
      detail: card.lifecycle.detail || "这张卡已退出学习队列，只保留历史记录。",
      action: { intent: "return", label: "返回学习卡库" },
      blocked: true,
      tone: "archived",
    };
  }
  if (card.lifecycle.status === "superseded") {
    return {
      label: card.lifecycle.label || "已有新版",
      detail: card.lifecycle.detail || "学习目标已迁移到新版卡片。",
      action: { intent: "open_replacement", label: "查看新版学习卡" },
      blocked: true,
      tone: "superseded",
    };
  }
  if (card.freshness.status === "stale_presentation") {
    return {
      label: card.freshness.label || "内容需要刷新",
      detail: card.freshness.detail || "当前呈现已失效，刷新前不会展示答案或开始新学习。",
      action: { intent: "refresh", label: "刷新学习卡内容" },
      blocked: true,
      tone: "stale",
    };
  }

  switch (card.personalState.status) {
    case "in_progress":
      return { label: card.personalState.label, detail: card.personalState.detail, action: { intent: "continue", label: "继续本次学习" }, blocked: false, tone: "progress" };
    case "review_due":
      return { label: card.personalState.label, detail: card.personalState.detail, action: { intent: "review", label: "开始到期复习" }, blocked: false, tone: "due" };
    case "initial_validation_deferred":
      return { label: card.personalState.label, detail: card.personalState.detail, action: { intent: "open_schedule", label: "查看首次验证安排" }, blocked: false, tone: "deferred" };
    case "initial_validation_ready":
      return { label: card.personalState.label, detail: card.personalState.detail, action: { intent: "start", label: "开始首次验证" }, blocked: false, tone: "ready" };
    case "review_scheduled":
      return { label: card.personalState.label, detail: card.personalState.detail, action: { intent: "open_schedule", label: "查看复习安排" }, blocked: false, tone: "scheduled" };
    case "idle":
      return { label: card.personalState.label, detail: card.personalState.detail, action: { intent: "start", label: "开始自由练习" }, blocked: false, tone: "idle" };
  }
}

export function ActiveLearningCardV2({
  card,
  capability = "preview",
  initialReveal = null,
  initialRevealError = null,
  onReveal,
  onStartLearning,
  onStateAction,
  onLifecycleAction,
}: ActiveLearningCardV2Props) {
  const [reveal, setReveal] = useState<RevealState>(() => {
    if (initialRevealError) return { status: "error", message: initialRevealError };
    if (initialReveal) return { status: "revealed", content: initialReveal };
    return { status: "hidden" };
  });
  const presentation = resolvePresentation(card);

  const revealAnswer = async () => {
    setReveal({ status: "loading" });
    try {
      const content = await onReveal(card.cardId);
      if (!content.exposureId || !content.exposedAt || !content.exposurePolicyVersion) {
        throw new Error("Exposure 未确认，答案没有显示。");
      }
      setReveal({ status: "revealed", content });
    } catch (error) {
      setReveal({
        status: "error",
        message: error instanceof Error ? error.message : "答案暂时无法安全加载，请稍后重试。",
      });
    }
  };

  const revealedContent = !presentation.blocked && reveal.status === "revealed" ? reveal.content : null;
  const action = revealedContent
    ? { intent: "start" as const, label: revealedContent.practice.primaryActionLabel }
    : presentation.action;
  const InteractionRenderer = learningCardInteractionRendererRegistry[card.front.kind];
  const isLearningAction = action.intent === "start" || action.intent === "continue" || action.intent === "review";

  const performPrimaryAction = () => {
    if (isLearningAction) {
      onStartLearning({
        cardId: card.cardId,
        objectiveId: card.objectiveId,
        exposureId: revealedContent?.exposureId ?? null,
      });
      return;
    }
    onStateAction?.({ cardId: card.cardId, intent: action.intent as StateActionIntent });
  };

  return (
    <article
      className="learning-card-v2"
      aria-busy={reveal.status === "loading"}
      data-revealed={Boolean(revealedContent)}
      data-blocked={presentation.blocked}
      data-state-tone={presentation.tone}
    >
      <header className="learning-card-v2__header">
        <div>
          <p>ACTIVE LEARNING CARD · V2</p>
          <span>一张卡 · 一个稳定学习目标</span>
        </div>
        <span className="learning-card-v2__state" data-status={presentation.tone}>
          <i aria-hidden="true" />{presentation.label}
        </span>
      </header>

      {card.freshness.status === "source_outdated" && (
        <aside className="learning-card-v2__source-banner" role="status">
          <Icon.Refresh />
          <div><strong>{card.freshness.label}</strong><span>{card.freshness.detail}</span></div>
        </aside>
      )}

      {presentation.blocked ? (
        <section className="learning-card-v2__blocked" aria-labelledby="learning-card-v2-blocked-title">
          <span><Icon.Lock /></span>
          <p>当前学习卡</p>
          <h2 id="learning-card-v2-blocked-title">{presentation.label}</h2>
          <div>{presentation.detail}</div>
        </section>
      ) : (
        <PublicCardFront card={card} interactionLabel={learningCardInteractionLabels[card.front.kind]}>
          <InteractionRenderer interaction={card.front} />
        </PublicCardFront>
      )}

      {!presentation.blocked && (
        <section className="learning-card-v2__personal-state" aria-label="个人学习状态">
          <Icon.Bolt />
          <div>
            <strong>{revealedContent ? revealedContent.practice.label : presentation.label}</strong>
            <p>{revealedContent ? revealedContent.practice.explanation : presentation.detail}</p>
          </div>
        </section>
      )}

      {revealedContent && <LearningCardReveal content={revealedContent} capability={capability} />}

      {!presentation.blocked && (
        <div className="learning-card-v2__feedback" aria-live="polite">
          {reveal.status === "loading" && <span><i aria-hidden="true" />正在先记录答案暴露，再安全读取内容…</span>}
          {reveal.status === "error" && <span role="alert"><Icon.Warn />{reveal.message}</span>}
        </div>
      )}

      <footer className="learning-card-v2__actions">
        {!presentation.blocked && !revealedContent && (
          <button
            type="button"
            className="learning-card-v2__reveal-button"
            disabled={reveal.status === "loading"}
            onClick={revealAnswer}
          >
            <Icon.Eye />查看答案
            <small>会进入预习 / Exposure 流程</small>
          </button>
        )}
        <button
          type="button"
          className="card-v2-button card-v2-button--primary learning-card-v2__primary-action"
          disabled={reveal.status === "loading"}
          onClick={performPrimaryAction}
        >
          {action.intent === "refresh" ? <Icon.Refresh /> : action.intent === "open_replacement" ? <Icon.Open /> : <Icon.Play />}
          {action.label}
        </button>
      </footer>

      <LifecycleActions capability={capability} onAction={onLifecycleAction} />
    </article>
  );
}
