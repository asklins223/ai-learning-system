import type { LearningRunAllowedActionV2, LearningRunPublicV1 } from "@ailearn/shared";

/**
 * Project only server-authorized action templates. The renderer must consume
 * this exact union; it must never infer an action from phase or local state.
 */
export function buildLearningRunAllowedActionsV2(view: LearningRunPublicV1): LearningRunAllowedActionV2[] {
  const actions: LearningRunAllowedActionV2[] = [];
  const task = view.activeTask;

  if (view.phase === "active") {
    actions.push(
      { version: 2, kind: "pause" },
      { version: 2, kind: "skip_run", confirmationRequired: true },
      { version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true },
    );
    if (task) {
      actions.push({ version: 2, kind: "skip_task", taskId: task.taskId, confirmationRequired: true });
      for (let level = 1; level <= task.assistancePolicy.hintLevels; level += 1) {
        actions.push({ version: 2, kind: "request_hint", level: level as 1 | 2 | 3 });
      }
      for (const alternative of task.availableAlternatives) {
        actions.push({ version: 2, kind: "switch_variant", alternativeId: alternative.alternativeId });
      }
    }
  } else if (view.phase === "paused") {
    actions.push(
      { version: 2, kind: "resume" },
      { version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true },
    );
  } else if (view.phase === "checkpoint") {
    if (view.checkpoint?.kind === "partial") actions.push({ version: 2, kind: "finish_current_evidence" });
    if (view.checkpoint?.kind === "not_assessable") actions.push({ version: 2, kind: "finish_without_commit" });
    for (const followupId of view.checkpoint?.allowedFollowupIds ?? []) {
      actions.push({ version: 2, kind: "activate_followup", followupId });
    }
    actions.push({ version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true });
  } else if (view.phase === "recoverable_error") {
    if (view.failure?.stage === "prepare") actions.push({ version: 2, kind: "retry_prepare" });
    if (view.failure?.stage === "assessment" && view.activeAssessment) {
      actions.push({ version: 2, kind: "retry_assessment", assessmentId: view.activeAssessment.assessmentId });
    }
    if (view.failure?.stage === "commit") actions.push({ version: 2, kind: "retry_commit" });
    actions.push({ version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true });
  } else if (view.phase === "assessing" || view.phase === "committing") {
    actions.push({ version: 2, kind: "end", abandonLockedEvidence: true, confirmationRequired: true });
  } else if (view.phase === "preparing") {
    actions.push({ version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true });
  }

  return actions;
}
