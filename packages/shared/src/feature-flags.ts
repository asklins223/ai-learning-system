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
 * - SCHEDULER_POLICY_VERSION:      retired — discrete-v2 is always active
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
 * SCHEDULER_POLICY_VERSION — retired.
 *
 * discrete-v2 is now always active. This function is kept for backward
 * compatibility but always returns "discrete-v2".
 */
export function getSchedulerPolicyVersion(): string {
  return SchedulingPolicyVersion.DISCRETE_V2;
}

/**
 * Convenience: returns true when the active scheduling policy is discrete-v2.
 */
export function isSchedulerPolicyV2(): boolean {
  return getSchedulerPolicyVersion() === SchedulingPolicyVersion.DISCRETE_V2;
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

/**
 * PROMPT_CACHE_ENABLED — gates provider prompt caching (B2, 计划 §2.5).
 *
 * When false (default): no cache control markers are sent to providers,
 * and cache-related usage fields are parsed but not actively requested.
 *
 * When true: providers in the PROMPT_CACHE_PROVIDERS whitelist will have
 * cache control hints added to their requests, enabling prompt prefix
 * reuse across turns within the same run.
 *
 * Risk control: flag default off; parse failure silently degrades.
 */
function isPromptCacheEnabled(): boolean {
  return process.env.PROMPT_CACHE_ENABLED === "true";
}

// PROMPT_CACHE_PROVIDERS is effectively static in production; parse it once
// and reuse the Set to avoid per-call env split + allocation on hot LLM paths.
// Cache is keyed by the raw env value so tests that mutate env still get correct
// per-value parsing.
let promptCacheProvidersCache: { raw: string | undefined; set: Set<string> } | null = null;

/**
 * Get the set of provider IDs allowed to use prompt caching.
 *
 * Reads from PROMPT_CACHE_PROVIDERS env var (comma-separated).
 * When PROMPT_CACHE_ENABLED is true but PROMPT_CACHE_PROVIDERS is unset,
 * defaults to "dashscope" (the most commonly supported provider).
 *
 * @returns Set of lowercase provider IDs (e.g., {"dashscope", "openai_compatible"})
 */
export function getPromptCacheProviders(): Set<string> {
  const raw = process.env.PROMPT_CACHE_PROVIDERS;
  if (promptCacheProvidersCache && promptCacheProvidersCache.raw === raw) {
    return promptCacheProvidersCache.set;
  }

  let parsed: Set<string>;
  if (!raw || raw.trim() === "") {
    parsed = new Set(["dashscope"]);
  } else {
    const items = raw.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    // If all entries were empty/whitespace, fall back to default
    parsed = items.length > 0 ? new Set(items) : new Set(["dashscope"]);
  }
  promptCacheProvidersCache = { raw, set: parsed };
  return parsed;
}

/**
 * Check if a specific provider should use prompt caching.
 * Convenience wrapper: checks both the global flag and the provider whitelist.
 */
export function shouldUsePromptCache(providerId: string): boolean {
  if (!isPromptCacheEnabled()) return false;
  return getPromptCacheProviders().has(providerId.toLowerCase());
}

// ─── E2: 修正反馈闭环 (计划 §2.9) ─────────────────────────────────────────

/**
 * GENERATION_FEEDBACK_COLLECTION_ENABLED — gates feedback signal collection (E2 Phase 1, 计划 §2.9).
 *
 * Phase 1 (M4): Only collects quality signals, does NOT interfere with generation.
 * When false (default): no quality signals are collected.
 * When true: quality signals (verify NEEDS_ATTENTION, low coverage, user edits,
 * validation feedback) are persisted for aggregation and display.
 *
 * Risk control: collection-only, does not affect generation or trusted chain.
 */
export function isFeedbackCollectionEnabled(): boolean {
  return process.env.GENERATION_FEEDBACK_COLLECTION_ENABLED === "true";
}
