export type LearningRunPhaseV1 =
  | "preparing"
  | "active"
  | "assessing"
  | "checkpoint"
  | "committing"
  | "paused"
  | "completed"
  | "ended"
  | "skipped"
  | "cancelled"
  | "stale"
  | "recoverable_error";

export type LearningRunOriginV1 =
  | "card"
  | "review"
  | "star_map"
  | "today"
  | "onboarding";

export type LearningTaskIntentV1 =
  | "recall"
  | "paraphrase"
  | "explain"
  | "example"
  | "apply"
  | "boundary"
  | "procedure"
  | "relate"
  | "repair";

export type LearningTaskPurposeV1 =
  | "formal"
  | "facet"
  | "diagnostic"
  | "practice";

export type LearningTrustClassV1 =
  | "mastery_eligible"
  | "facet_eligible"
  | "diagnostic_only"
  | "practice_only"
  | "not_assessable";

export type LearningTaskInteractionV1 =
  | {
      kind: "text_response";
      maxChars: number;
      placeholder: string;
    }
  | {
      kind: "voice_teachback";
      maxSeconds: number;
      language: string;
      availability?: "available" | "permission_denied" | "unavailable";
    }
  // P4 结构化交互形状与 wire 合同（shared learning-run-contracts §12.2）对齐。
  | {
      kind: "ordering";
      publicTokenIds: string[];
      publicTokenLabels?: Record<string, string>;
    }
  | {
      kind: "repair";
      publicElementIds: string[];
      allowedOperationKinds: Array<"move" | "replace" | "remove" | "insert">;
      replacementOptionIds: string[];
      publicElementLabels?: Record<string, string>;
      replacementOptionLabels?: Record<string, string>;
    }
  | {
      kind: "relation";
      publicNodeIds: string[];
      allowedEdgeKinds: Array<string>;
      publicNodeLabels?: Record<string, string>;
    }
  | {
      kind: "structured_bundle";
      parts: Array<{
        partId: string;
        interaction:
          | { kind: "ordering"; publicTokenIds: string[] }
          | { kind: "relation_canvas"; publicNodeIds: string[]; allowedEdgeKinds: string[] }
          | { kind: "repair"; publicElementIds: string[]; allowedOperationKinds: Array<"move" | "replace" | "remove" | "insert">; replacementOptionIds: string[] };
        partTrustCeiling: "practice_only";
        qualificationProfileHash: string | null;
        labels?: Record<string, string>;
      }>;
    }
  | {
      kind: "choice_with_rationale";
      choices: Array<{ id: string; label: string; detail?: string }>;
      rationales: Array<{ id: string; label: string }>;
      minRationales: number;
    }
  | {
      kind: "scenario";
      scenario: string;
      choices: Array<{ id: string; label: string; consequence: string }>;
      cues: Array<{ id: string; label: string }>;
      minCues: number;
    };

export type LearningTaskDraftV1 =
  | { kind: "text_response"; text: string }
  | { kind: "voice_teachback"; transcript: string }
  | { kind: "ordering"; orderedTokenIds: string[] }
  | { kind: "repair"; elementId: string | null; replacementOptionId: string | null }
  | { kind: "relation"; fromNodeId: string | null; toNodeId: string | null; edgeKind: string | null }
  | { kind: "choice_with_rationale"; choiceId: string | null; rationaleIds: string[] }
  | { kind: "scenario"; choiceId: string | null; cueIds: string[] }
  // §5.3/§12.3 structured_bundle：part 只保存在 draft，全部完成才一次提交。
  | {
      kind: "structured_bundle";
      partAnswers: Array<
        | { kind: "ordering"; orderedTokenIds: string[] }
        | { kind: "relation"; edges: Array<{ fromNodeId: string; toNodeId: string; edgeKind: string }> }
        | { kind: "repair"; operations: Array<{ op: string; elementId: string; replacementOptionId: string }> }
      >;
    };

export type LearningTaskAlternativeV1 = {
  alternativeId: string;
  label: string;
  detail: string;
  interactionKind: LearningTaskInteractionV1["kind"];
  trustCeiling: LearningTrustClassV1;
};

export type LearningTaskPublicV1 = {
  taskId: string;
  sequence: number;
  intent: LearningTaskIntentV1;
  purpose: LearningTaskPurposeV1;
  title: string;
  prompt: string;
  targetSummary: string;
  hint?: string;
  interaction: LearningTaskInteractionV1;
  alternatives: LearningTaskAlternativeV1[];
  trustCeiling: LearningTrustClassV1;
  estimatedActiveSeconds: number;
  status: "pending" | "active" | "answered" | "skipped" | "completed" | "stale";
  revision: number;
};

export type LearningAssessmentPublicV1 = {
  assessmentId: string;
  status: "queued" | "running" | "completed" | "not_assessable" | "failed";
  statusDetail: string;
};

export type LearningRunOutcomeV1 =
  | "demonstrated"
  | "partial"
  | "needs_repair"
  | "not_assessable"
  | "practice_completed"
  | "skipped"
  | "declared_unable";

export type LearningScheduleImpactV1 =
  | { kind: "none"; explanation: string }
  | { kind: "created"; dueLabel: string; explanation: string }
  | { kind: "rescheduled"; dueLabel: string; explanation: string };

export type LearningRunResultV1 = {
  outcome: LearningRunOutcomeV1;
  eyebrow: string;
  title: string;
  summary: string;
  demonstratedFacets: string[];
  gapFacets: string[];
  scheduleImpact: LearningScheduleImpactV1;
  nextStep: string;
};

export type LearningRunFailureV1 = {
  stage: "prepare" | "assessment" | "commit";
  title: string;
  detail: string;
  retryLabel: string;
};

export type LearningRunPublicV1 = {
  runId: string;
  origin: LearningRunOriginV1;
  originLabel: string;
  returnLabel: string;
  keyPointTitle: string;
  keyPointContext: string;
  phase: LearningRunPhaseV1;
  timeBudgetSeconds: number;
  plannedActiveSeconds: number;
  activeSecondsUsed: number;
  progressLabel: string;
  activeTask: LearningTaskPublicV1 | null;
  activeAssessment: LearningAssessmentPublicV1 | null;
  checkpoint:
    | null
    | {
        kind: "partial" | "not_assessable" | "skipped_task";
        title: string;
        detail: string;
        primaryAction: string;
      };
  failure: LearningRunFailureV1 | null;
  result: LearningRunResultV1 | null;
  revision: number;
};

export type LearningRunUiIntentV1 =
  | { kind: "back" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "end" }
  | { kind: "leave_while_waiting" }
  | { kind: "retry" }
  | { kind: "create_fresh_run" }
  | { kind: "switch_variant"; alternativeId: string }
  | { kind: "request_hint"; level: 1 }
  | { kind: "skip_task" }
  | { kind: "declare_unable" }
  | { kind: "submit_text"; text: string }
  | { kind: "submit_voice"; transcript: string; correctionMethod?: "none" | "re_recorded" | "manual_text_edit" }
  | { kind: "submit_ordering"; orderedTokenIds: string[] }
  | { kind: "submit_repair"; elementId: string; replacementOptionId: string }
  | { kind: "submit_choice_with_rationale"; choiceId: string; rationaleIds: string[] }
  | { kind: "submit_scenario"; choiceId: string; cueIds: string[] }
  | { kind: "submit_relation"; fromNodeId: string; toNodeId: string; edgeKind: string }
  | {
      kind: "submit_structured_bundle";
      partAnswers: Array<
        | { kind: "ordering"; orderedTokenIds: string[] }
        | { kind: "relation"; edges: Array<{ fromNodeId: string; toNodeId: string; edgeKind: string }> }
        | { kind: "repair"; operations: Array<{ op: string; elementId: string; replacementOptionId: string }> }
      >;
    }
  | { kind: "checkpoint_primary" }
  | { kind: "finish_checkpoint" };

export type LearningRunUiSourceV1 = {
  snapshot: LearningRunPublicV1;
  dispatch: (intent: LearningRunUiIntentV1) => void;
};
