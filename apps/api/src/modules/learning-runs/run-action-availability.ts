import type { LearningRunAllowedActionV2, LearningRunPublicV1 } from "@ailearn/shared";

/**
 * retry_assessment 可重新入队的 assessment 状态：tick 的失败路径把它收尾为
 * failed；prepare 事务整体回滚时退回 queued；Critic 写回事务回滚时停在
 * running。三者在状态下都允许重新排队（processAssessmentCommand 只处理
 * queued，重试即先回到 queued）。
 */
const RETRYABLE_ASSESSMENT_STATUSES: ReadonlyArray<NonNullable<LearningRunPublicV1["activeAssessment"]>["status"]> = [
  "queued",
  "running",
  "failed",
];

/**
 * Project only server-authorized action templates. The renderer must consume
 * this exact union; it must never infer an action from phase or local state.
 */
export function buildLearningRunAllowedActionsV2(view: LearningRunPublicV1): LearningRunAllowedActionV2[] {
  const actions: LearningRunAllowedActionV2[] = [];
  const task = view.activeTask;

  if (view.phase === "active") {
    // 2026-09-20 实走复盘 #12：active 阶段曾经同时提供 skip_run / end / skip_task
    // 三个"无痕离开"，其中 skip_run 与 skip_task 产生逐字节相同的终态，而
    // 「暂时不会」是另一种真实作答结果。三个近义出口堆在菜单里，用户分不清也
    // 不需要分。现在只剩：不想做 → 稍后再做；不会做 → 暂时不会（提交侧）。
    // end 在其他阶段仍是唯一出口（paused / checkpoint / recoverable_error /
    // assessing / committing / preparing），照旧签发。
    actions.push(
      { version: 2, kind: "pause" },
      { version: 2, kind: "skip_run", confirmationRequired: true },
    );
    if (task) {
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
    // H1（2026-08-24 审查）：只有「确实可重试」的 assessment 才宣告
    // retry_assessment——completed/not_assessable 的评估重试必然 409，投影与
    // 状态机必须一致（tick 失败路径会把 queued/running 收尾为 failed）。
    if (
      view.failure?.stage === "assessment"
      && view.activeAssessment
      && RETRYABLE_ASSESSMENT_STATUSES.includes(view.activeAssessment.status)
    ) {
      actions.push({ version: 2, kind: "retry_assessment", assessmentId: view.activeAssessment.assessmentId });
    }
    if (view.failure?.stage === "commit") actions.push({ version: 2, kind: "retry_commit" });
    // H4（2026-08-24 审查）：recoverable_error 的 end 必须被 applyAction 接受
    // （阶段无在锁证据，无需 abandonLockedEvidence）。
    actions.push({ version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true });
  } else if (view.phase === "assessing" || view.phase === "committing") {
    actions.push({ version: 2, kind: "end", abandonLockedEvidence: true, confirmationRequired: true });
  } else if (view.phase === "preparing") {
    actions.push({ version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true });
  }

  return actions;
}
