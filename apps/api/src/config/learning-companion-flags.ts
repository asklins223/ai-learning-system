/** Server-only rollout gates for the Companion reconstruction. */

export function isLearningSessionV2InternalEnabled(): boolean {
  return process.env.LEARNING_SESSION_V2_INTERNAL === "true";
}

/** Keep canonical mastery/schedule writes separately gated from the UI path. */
export function isLearningSessionCanonicalCommitEnabled(): boolean {
  return process.env.LEARNING_SESSION_CANONICAL_COMMIT_ENABLED === "true";
}

export function learningSessionRolloutDisabledReason(): string {
  if (!isLearningSessionV2InternalEnabled()) {
    return "学习伴星重构路径当前仅供内部验证";
  }
  if (!isLearningSessionCanonicalCommitEnabled()) {
    return "正式学习结果尚未开放；当前仅支持诊断练习";
  }
  return "学习伴星重构路径已开放";
}
