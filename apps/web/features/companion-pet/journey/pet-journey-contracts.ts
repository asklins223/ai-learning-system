import type { CharacterPresentationStateV1 } from "@ailearn/shared";

/**
 * UI-only projection of the durable assistant message + Journey/ActionRun state.
 * It deliberately contains no free-form tool payload and cannot mutate learning
 * truth by itself. The production binder will translate server contracts into
 * this view model after their context/revision guards pass.
 */
interface PetJourneyPresentationBaseV2 {
  presentationId: string;
  /** References the persisted AssistantMessage rendered/spoken by the Pet. */
  messageId: string;
  message: string;
  contextLabel: string;
  characterPresentation: CharacterPresentationStateV1;
  speechMode: "text_only" | "speak_message";
  dismissPolicy: "auto" | "explicit" | "persistent_until_result";
}

export interface PetJourneyInvitationChoiceV2 {
  choiceId: string;
  label: string;
  branch: "own_material" | "sample" | "self_explore";
  description: string;
}

export interface PetJourneyInvitationPresentationV2 extends PetJourneyPresentationBaseV2 {
  kind: "invitation";
  accountPermitId: string;
  choices: readonly [
    PetJourneyInvitationChoiceV2,
    PetJourneyInvitationChoiceV2,
    PetJourneyInvitationChoiceV2,
  ];
  deferLabel: string;
}

export type PetJourneyPreferenceKeyV2 = "goal" | "intervention_level" | "response_mode";

export interface PetJourneyPreferenceChoiceV2 {
  choiceId: string;
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface PetJourneyPreferencePresentationV2 extends PetJourneyPresentationBaseV2 {
  kind: "preference";
  preference: PetJourneyPreferenceKeyV2;
  step: number;
  stepCount: number;
  choices: readonly PetJourneyPreferenceChoiceV2[];
  defaultValue: string;
  skipLabel: string;
}

export type PetJourneyProgressStateV2 = "waiting" | "processing" | "ready" | "failed";

export interface PetJourneyProgressPresentationV2 extends PetJourneyPresentationBaseV2 {
  kind: "progress";
  progress: {
    state: PetJourneyProgressStateV2;
    sourceName: string;
    statusLabel: string;
    detail: string;
    percent: number | null;
  };
  actions: readonly {
    actionId: string;
    label: string;
    kind: "leave_and_notify" | "open_source" | "retry";
    primary?: boolean;
  }[];
}

export interface PetJourneyRunProposalPresentationV2 extends PetJourneyPresentationBaseV2 {
  kind: "run_proposal";
  proposalId: string;
  target: string;
  targetDetail: string;
  estimatedMinutes: number;
  proofBoundary: string;
  scheduleBoundary: string;
  primaryLabel: string;
  secondaryLabel: string;
}

export interface PetJourneyConfirmationPresentationV2 extends PetJourneyPresentationBaseV2 {
  kind: "confirmation";
  proposalId: string;
  actionName: string;
  target: string;
  impactSummary: string;
  boundaryNote: string;
  confirmLabel: string;
  rejectLabel: string;
}

export interface PetJourneyExecutionStepV2 {
  stepId: string;
  label: string;
  state: "complete" | "active" | "pending";
}

export interface PetJourneyExecutionPresentationV2 extends PetJourneyPresentationBaseV2 {
  kind: "execution";
  actionRunId: string;
  statusLabel: string;
  detail: string;
  steps: readonly PetJourneyExecutionStepV2[];
  leaveLabel: string;
}

export type PetJourneyResultOutcomeV2 =
  | "demonstrated"
  | "partial"
  | "needs_repair"
  | "not_assessable"
  | "practice_completed"
  | "skipped"
  | "declared_unable";

export interface PetJourneyResultPresentationV2 extends PetJourneyPresentationBaseV2 {
  kind: "result";
  resultRef: string;
  outcome: PetJourneyResultOutcomeV2;
  outcomeLabel: string;
  proof: string;
  gap: string | null;
  schedule: {
    changed: boolean;
    label: string;
  };
  primaryAction: {
    actionId: string;
    label: string;
    kind: "return_to_card" | "view_star_change" | "view_evidence";
  };
}

export interface PetJourneyRecoveryPresentationV2 extends PetJourneyPresentationBaseV2 {
  kind: "recovery";
  errorCode: string;
  title: string;
  impact: string;
  recovery: string;
  retryLabel: string | null;
  dismissLabel: string;
}

/**
 * Local suppression state, not an AssistantMessage. `messageId` and free text
 * are intentionally absent: formal answers and DND must not surface a cue.
 */
export interface PetJourneySilentPresentationV2 {
  kind: "silent";
  presentationId: string;
  reason: "formal_answer" | "dnd";
  characterPresentation: "idle";
  resumePolicy: "after_artifact_lock" | "when_availability_online";
}

export type PetJourneyPresentationV2 =
  | PetJourneyInvitationPresentationV2
  | PetJourneyPreferencePresentationV2
  | PetJourneyProgressPresentationV2
  | PetJourneyRunProposalPresentationV2
  | PetJourneyConfirmationPresentationV2
  | PetJourneyExecutionPresentationV2
  | PetJourneyResultPresentationV2
  | PetJourneyRecoveryPresentationV2
  | PetJourneySilentPresentationV2;

export type PetJourneyUiIntentV2 =
  | { kind: "choose_invitation"; choiceId: string; branch: PetJourneyInvitationChoiceV2["branch"] }
  | { kind: "defer_invitation"; permitId: string }
  | { kind: "set_preference"; preference: PetJourneyPreferenceKeyV2; value: string }
  | { kind: "skip_preference"; preference: PetJourneyPreferenceKeyV2 }
  | { kind: "progress_action"; actionId: string; action: PetJourneyProgressPresentationV2["actions"][number]["kind"] }
  | { kind: "open_run_proposal"; proposalId: string }
  | { kind: "reject_run_proposal"; proposalId: string }
  | { kind: "confirm_action"; proposalId: string }
  | { kind: "reject_action"; proposalId: string }
  | { kind: "leave_execution"; actionRunId: string }
  | { kind: "result_action"; resultRef: string; action: PetJourneyResultPresentationV2["primaryAction"]["kind"] }
  | { kind: "retry_recovery"; errorCode: string }
  | { kind: "dismiss_recovery"; errorCode: string }
  | { kind: "dismiss"; presentationId: string };

export function isPetJourneyPresentationVisible(presentation: PetJourneyPresentationV2): boolean {
  return presentation.kind !== "silent";
}

export function validatePetJourneyPresentation(presentation: PetJourneyPresentationV2): readonly string[] {
  const issues: string[] = [];
  if (presentation.kind === "silent") return issues;
  if (!presentation.messageId.trim()) issues.push("messageId is required for visible presentations");
  if (!presentation.message.trim()) issues.push("message is required for visible presentations");
  if (presentation.kind === "invitation" && presentation.choices.length !== 3) {
    issues.push("invitation must expose exactly three equal choices");
  }
  if (presentation.kind === "preference" && presentation.choices.length > 3) {
    issues.push("preference presentation supports at most three short choices");
  }
  if (presentation.kind === "progress" && presentation.progress.percent !== null) {
    if (presentation.progress.percent < 0 || presentation.progress.percent > 100) {
      issues.push("progress percent must be between 0 and 100");
    }
  }
  return issues;
}
