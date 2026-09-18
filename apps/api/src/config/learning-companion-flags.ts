/** Server-only rollout gates for the current Companion product paths. */

/** LearningRun creation, player, submission, assessment, and commit gate. */
export function isLearningRunEnabled(): boolean {
  return process.env.LEARNING_RUN_ENABLED === "true";
}

/** Keep canonical mastery/schedule writes separately gated from the UI path. */
/**
 * Card Generation V2 capability（方案 20）：
 * 价值优先生成、候选治理与 LearningTarget 重基。
 * 默认关闭（fail closed）；内部验证环境显式 CARD_GENERATION_V2_ENABLED=true。
 */
export function isCardGenerationV2Enabled(): boolean {
  return process.env.CARD_GENERATION_V2_ENABLED === "true";
}

/**
 * 伴星对话链路（COMPANION_DIALOGUE_V1_ENABLED）。同一个开关决定
 * `/companion/*` 对话路由是否 404 fail closed，所以能力投影必须读它，
 * 否则设置页永远显示「已关闭」，与真实部署状态相反。
 */
export function isCompanionDialogueEnabled(): boolean {
  return process.env.COMPANION_DIALOGUE_V1_ENABLED === "true";
}

/** 伴星语音对话（COMPANION_VOICE_DIALOGUE_V1_ENABLED）。 */
export function isCompanionVoiceDialogueEnabled(): boolean {
  return process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED === "true";
}
