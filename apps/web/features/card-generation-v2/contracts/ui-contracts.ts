export type CardLearningGoalV2 =
  | "remember"
  | "understand"
  | "apply"
  | "exam";

export type CardDetailThresholdV2 = "concise" | "balanced" | "deep";

export type CardStrategyV2 =
  | "recall"
  | "cloze"
  | "compare"
  | "sequence"
  | "why"
  | "boundary"
  | "application";

export interface GenerationControlsDraftV2 {
  sourceScope: "selection" | "section" | "whole_note";
  learningGoal: CardLearningGoalV2;
  detailThreshold: CardDetailThresholdV2;
  hardMaxCards: number | null;
  preferredStrategies: CardStrategyV2[];
}

export type CandidateReviewStateV2 =
  | "ready"
  | "kept"
  | "rechecking"
  | "rejected";

export interface CandidateMergeEligibilityV2 {
  /** Opaque semantic group supplied by the future V2 review service. */
  semanticGroupId: string;
  /** User-facing reason that these candidates may be combined. */
  rationale: string;
}

export interface CandidateReviewItemV2 {
  candidateId: string;
  revision: number;
  /** 2026-08-16：keep/reject 提交服务端所需（服务端 CAS 校验 revisionHash）。 */
  revisionHash: string;
  objective: string;
  prompt: string;
  reason: string;
  sourceLabel: string;
  knowledgeForm: string;
  strategyLabel: string;
  estimatedSeconds: number;
  selected: boolean;
  reviewState: CandidateReviewStateV2;
  mergeEligibility?: CandidateMergeEligibilityV2;
}

export interface CandidateRevealContentV2 {
  candidateId: string;
  revision: number;
  exposureId: string;
  answer: string;
  explanation: string;
  evidencePreview: string;
}

export interface CandidateSetSummaryV2 {
  sourceLabel: string;
  sourceVersion: number;
  atomCount: number;
  candidateCount: number;
  supportOnlyCount: number;
  mergedCount: number;
  estimatedReviewSeconds: number;
}

export interface ZeroCardResultV2 {
  title: string;
  explanation: string;
  reasonLabel: string;
  decisions: Array<{ label: string; value: string }>;
  coveredCard?: { cardId: string; title: string };
}

interface PublicLearningCardInteractionBaseV2 {
  /** Optional source context. It must never contain answer-bearing material. */
  context?: string;
  cue?: string;
  prompt: string;
}

export interface PublicRecallInteractionV2
  extends PublicLearningCardInteractionBaseV2 {
  kind: "recall";
  scratchpadPlaceholder: string;
  reflectionPrompts?: string[];
}

export interface PublicClozeInteractionV2
  extends PublicLearningCardInteractionBaseV2 {
  kind: "cloze";
  passage: Array<
    | { kind: "text"; text: string }
    | {
        kind: "blank";
        blankId: string;
        label: string;
        width: "short" | "medium" | "long";
      }
  >;
}

export interface PublicCompareInteractionV2
  extends PublicLearningCardInteractionBaseV2 {
  kind: "compare";
  subjects: [
    { subjectId: string; label: string },
    { subjectId: string; label: string },
  ];
  dimensions: Array<{ dimensionId: string; label: string; prompt: string }>;
}

export interface PublicSequenceInteractionV2
  extends PublicLearningCardInteractionBaseV2 {
  kind: "sequence";
  /** Display order is intentionally shuffled; canonical order is reveal-only. */
  steps: Array<{ stepId: string; label: string }>;
}

export interface PublicWhyInteractionV2
  extends PublicLearningCardInteractionBaseV2 {
  kind: "why";
  /** Unordered nodes. Causal edges are deliberately absent from the public DTO. */
  nodes: Array<{ nodeId: string; label: string }>;
  chainSlotCount: number;
}

export interface PublicBoundaryInteractionV2
  extends PublicLearningCardInteractionBaseV2 {
  kind: "boundary";
  cases: Array<{ caseId: string; statement: string }>;
  labels: {
    within: string;
    outside: string;
  };
}

export interface PublicApplyInteractionV2
  extends PublicLearningCardInteractionBaseV2 {
  kind: "application";
  scenario: string;
  options: Array<{
    optionId: string;
    label: string;
    description: string;
  }>;
}

/**
 * Answer-free interaction shown on an active card. It is only the card default:
 * a LearningRun may substitute another interaction while keeping the objectiveId.
 */
export type PublicLearningCardInteractionV2 =
  | PublicRecallInteractionV2
  | PublicClozeInteractionV2
  | PublicCompareInteractionV2
  | PublicSequenceInteractionV2
  | PublicWhyInteractionV2
  | PublicBoundaryInteractionV2
  | PublicApplyInteractionV2;

/** Server-authored, orthogonal axes. The client only resolves their display priority. */
export type LearningCardLifecycleV2 = "active" | "archived" | "superseded";

export type LearningCardLearningStateV2 =
  | "initial_validation_ready"
  | "initial_validation_deferred"
  | "in_progress"
  | "review_due"
  | "review_scheduled"
  | "idle";

export type LearningCardFreshnessV2 =
  | "current"
  | "source_outdated"
  | "stale_presentation";

export interface PublicLearningCardPreviewV2 {
  cardId: string;
  objectiveId: string;
  objective: {
    statement: string;
    publicSummary: string;
  };
  front: PublicLearningCardInteractionV2;
  lifecycle: {
    status: LearningCardLifecycleV2;
    label: string;
    detail: string;
    replacementCardId?: string;
  };
  freshness: {
    status: LearningCardFreshnessV2;
    label: string;
    detail: string;
    sourceVersion?: number;
  };
  personalState: {
    status: LearningCardLearningStateV2;
    label: string;
    detail: string;
  };
  primaryAction: {
    intent: "start" | "continue" | "review" | "open_schedule" | "open_replacement" | "refresh" | "return";
    label: string;
  };
}

export interface LearningCardRevealContentV2 {
  exposureId: string;
  exposedAt: string;
  exposurePolicyVersion: string;
  canonicalAnswer: string;
  explanation: string;
  misconception: string;
  evidence: Array<{
    evidenceId: string;
    sourceLabel: string;
    preview: string;
  }>;
  practice: {
    label: string;
    explanation: string;
    primaryActionLabel: string;
  };
}
