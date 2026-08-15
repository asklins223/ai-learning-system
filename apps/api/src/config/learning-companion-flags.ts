/** Server-only rollout gates for the Companion reconstruction. */

export function isLearningSessionV2InternalEnabled(): boolean {
  return process.env.LEARNING_SESSION_V2_INTERNAL === "true";
}

/**
 * learning_run_v1 capability（文档 16 §22.2）：Card/Review create、Player、
 * submission、Assessment/Commit consumer 必须同一次切换原子开启。
 * 默认关闭（fail closed）；内部验证环境显式 LEARNING_RUN_V1=true。
 */
export function isLearningRunV1Enabled(): boolean {
  return process.env.LEARNING_RUN_V1 === "true";
}

/** Keep canonical mastery/schedule writes separately gated from the UI path. */
export function isLearningSessionCanonicalCommitEnabled(): boolean {
  return process.env.LEARNING_SESSION_CANONICAL_COMMIT_ENABLED === "true";
}

/**
 * Card Generation V2 capability（方案 20）：
 * 价值优先生成、候选治理与 LearningTarget 重基。
 * 默认关闭（fail closed）；内部验证环境显式 CARD_GENERATION_V2_ENABLED=true。
 */
export function isCardGenerationV2Enabled(): boolean {
  return process.env.CARD_GENERATION_V2_ENABLED === "true";
}

/**
 * C8：V1 旧 writer 停写开关（方案 20 §26）。
 * V2 启用（CARD_GENERATION_V2_ENABLED=true）时 V1 生成默认**拒绝**
 * （fail closed，防双 writer / 旧 schema 反写，C39）；显式
 * CARD_GENERATION_V1_WRITER_ENABLED=true 可保留 V1（legacy 租户 /
 * 回滚 drill / 观察期过渡）。
 */
export function isCardGenerationV1WriterEnabled(): boolean {
  return process.env.CARD_GENERATION_V1_WRITER_ENABLED === "true";
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
