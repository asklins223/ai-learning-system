/**
 * v0.6 Server-side Feature Flags (计划 §12.2)
 *
 * Centralised feature flag utilities for the API server and AI Worker.
 * Flags are read from process.env (NOT NEXT_PUBLIC_*) so they are only
 * available on the server side.
 *
 * When a flag is disabled, the system fail-closes (计划 §12.2):
 * "关闭 flag 时必须 fail closed：可以回到只读卡片、确定性题目或旧
 *  schedule 展示，但不能恢复客户端题面/outcome 的升级权力。"
 *
 * Default behaviour:
 * - AI_QUESTION_V1_ENABLED:        false (must be explicitly enabled)
 * - RUBRIC_EVALUATION_V1_ENABLED:  false (must be explicitly enabled)
 * - SCHEDULER_POLICY_VERSION:      "discrete-v1" (safe rollout default)
 * - CARD_REPAIR_V1_ENABLED:        false (must be explicitly enabled)
 * - FSRS_SHADOW_ENABLED:           false (must be explicitly enabled)
 */

import { SchedulingPolicyVersion } from "./enums.ts";

/**
 * AI_QUESTION_V1_ENABLED — gates server-side AI question generation.
 *
 * When false:
 * - The system falls back to deterministic question generation only.
 * - Client-authored questions can NEVER produce understanding upgrades.
 *
 * Default: false. Only the exact value "true" enables the feature.
 */
export function isAIQuestionEnabled(): boolean {
  return process.env.AI_QUESTION_V1_ENABLED === "true";
}

/**
 * RUBRIC_EVALUATION_V1_ENABLED — gates server-side rubric evaluation.
 *
 * When false:
 * - The system falls back to the old evaluation path (model directly
 *   gives outcome without persistent rubric items).
 * - Rubric-based point assessments are not written.
 *
 * Default: false. Only the exact value "true" enables the feature.
 */
export function isRubricEvaluationEnabled(): boolean {
  return process.env.RUBRIC_EVALUATION_V1_ENABLED === "true";
}

/**
 * SCHEDULER_POLICY_VERSION — selects the active scheduling policy.
 *
 * "discrete-v2": unified v0.6 policy with assistance-aware scheduling.
 * "discrete-v1" (default): legacy v0.5 policy during the staged rollout.
 *
 * 计划 §10.6: "Worker 中独立 intervalForOutcome 被单一 discrete-v2 策略替代"
 */
export function getSchedulerPolicyVersion(): string {
  const version = process.env.SCHEDULER_POLICY_VERSION;
  if (version === SchedulingPolicyVersion.DISCRETE_V2) {
    return SchedulingPolicyVersion.DISCRETE_V2;
  }
  return SchedulingPolicyVersion.DISCRETE_V1;
}

/**
 * Convenience: returns true when the active scheduling policy is discrete-v2.
 */
export function isSchedulerPolicyV2(): boolean {
  return getSchedulerPolicyVersion() === SchedulingPolicyVersion.DISCRETE_V2;
}

/**
 * CARD_REPAIR_V1_ENABLED — gates conditional card repair (计划 §7.7).
 *
 * When false: only a single sanitizeCardOutput pass runs (no second model call).
 * When true: hard-trigger issues initiate at most one repair attempt.
 *
 * Default: false. Must be explicitly set to "true" to enable.
 */
export function isCardRepairEnabled(): boolean {
  return process.env.CARD_REPAIR_V1_ENABLED === "true";
}

/**
 * CARD_GENERATION_V2_ENABLED — routes new requests through the resumable
 * generation-run workflow. M6 makes v2 the default for new requests. Setting
 * the flag to the exact string "false" is the documented rollback switch;
 * invalid non-empty values remain disabled instead of being guessed.
 */
export function isCardGenerationV2Enabled(): boolean {
  const value = process.env.CARD_GENERATION_V2_ENABLED;
  if (value === undefined || value === "") return true;
  return value === "true";
}

/**
 * FSRS_SHADOW_ENABLED — gates FSRS shadow decision writing (计划 §6.8).
 *
 * When false, no shadow decisions are written. Shadow writes never affect
 * the official schedule.
 *
 * Default: false. Must be explicitly set to "true" to enable.
 *
 * Implementation: isFSRSShadowEnabled() is exported from fsrs-shadow.ts
 * and re-exported via index.ts. Do not re-export here to avoid duplicate
 * export conflicts.
 */
