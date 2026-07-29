/**
 * v0.6 Feature Flags (计划 §12.2)
 *
 * Client-side feature flag utilities. Flags are read from NEXT_PUBLIC_
 * environment variables so they are available at build time.
 *
 * When a flag is disabled, the UI falls back to a safe state (计划 §12.2:
 * "关闭 flag 时必须 fail closed：可以回到只读卡片、确定性题目或旧 schedule
 * 展示，但不能恢复客户端题面/outcome 的升级权力").
 */

function isExplicitlyEnabled(value: string | undefined): boolean {
  return value === "true";
}

/** QUESTION_FIRST_UI_ENABLED — controls v0.6 question-first Focus UI (计划 §12.2) */
export function isQuestionFirstUIEnabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_QUESTION_FIRST_UI_ENABLED);
}

/** AI_QUESTION_V1_ENABLED — controls server-side AI question generation */
export function isAIQuestionEnabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_AI_QUESTION_V1_ENABLED);
}

/** RUBRIC_EVALUATION_V1_ENABLED — controls server-side rubric evaluation */
export function isRubricEvaluationEnabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_RUBRIC_EVALUATION_V1_ENABLED);
}

/**
 * CARD_GENERATION_V2_ENABLED — enables the resumable generation-run UX.
 *
 * P1 audit fix: Changed from fail-open to fail-closed to align with M0's
 * frozen principle. Production must explicitly set
 * NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED=true at build time.
 */
export function isCardGenerationV2Enabled(): boolean {
  return isExplicitlyEnabled(process.env.NEXT_PUBLIC_CARD_GENERATION_V2_ENABLED);
}
