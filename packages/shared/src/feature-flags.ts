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
export function isPromptCacheEnabled(): boolean {
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

// ─── E1: Hybrid Search (计划 §2.8) ──────────────────────────────────────

/**
 * HYBRID_SEARCH_ENABLED — gates the use of HybridSearchEngine (E1, 计划 §2.8).
 *
 * When false (default): the search_related_evidence tool uses its existing
 * inline vector + lexical search logic (no RRF merge).
 *
 * When true: the tool delegates to HybridSearchEngine, which performs
 * RRF (Reciprocal Rank Fusion) merge of vector cosine and trigram lexical
 * results, with automatic degradation to sequential/lexical on failure.
 *
 * Risk control: flag default off; degradation is automatic and silent.
 */
export function isHybridSearchEnabled(): boolean {
  return process.env.HYBRID_SEARCH_ENABLED === "true";
}

/**
 * Get the preferred retrieval mode when hybrid search is enabled.
 *
 * - "hybrid" (default): vector + lexical RRF merge
 * - "vector": vector-only with lexical fallback
 * - "trigram": lexical-only
 * - "sequential": sequential manifest scan (no index dependency)
 *
 * @returns RetrievalMode string (defaults to "hybrid")
 */
export function getHybridSearchMode(): string {
  const mode = process.env.HYBRID_SEARCH_MODE;
  if (mode === "vector" || mode === "trigram" || mode === "sequential") {
    return mode;
  }
  return "hybrid";
}

/**
 * E1: Check if embedding index should be refreshed.
 *
 * Convenience wrapper around isEmbeddingStale that reads the current
 * embedding profile defaults and compares with stored metadata.
 * Used in PREPARE/VERIFY phases to ensure index coverage baseline.
 */
export function shouldRefreshEmbedding(params: {
  currentSourceHash: string;
  embeddingSourceHash: string;
  currentModelRevision: string;
  embeddingModelRevision: string;
  currentProfileVersion: string;
  embeddingProfileVersion: string;
}): boolean {
  return (
    params.currentSourceHash !== params.embeddingSourceHash ||
    params.currentModelRevision !== params.embeddingModelRevision ||
    params.currentProfileVersion !== params.embeddingProfileVersion
  );
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

/**
 * FEEDBACK_REGENERATION_ENABLED — gates feedback-informed regeneration (E2 Phase 2, 计划 §2.9).
 *
 * Phase 2 (M5): Provides a "regenerate with feedback" entry point that injects
 * aggregated feedback summary into the next run's context (prompt supplement).
 *
 * When false (default): feedback is collected but not injected into prompts.
 * When true: users can trigger "regenerate with feedback" which adds a
 * feedback summary section to the generation context.
 *
 * Risk control: flag default off; requires Phase 1 collection to be enabled;
 * does not auto-regenerate; does not touch trusted chain.
 */
export function isFeedbackRegenerationEnabled(): boolean {
  return process.env.FEEDBACK_REGENERATION_ENABLED === "true";
}

// ─── E3: 图片真实视觉理解 (计划 §2.10, 独立 Gate) ──────────────────────────

/**
 * VISION_UNDERSTANDING_ENABLED — gates real image vision understanding (E3, 计划 §2.10).
 *
 * This is the ONLY improvement item with an independent Gate:
 * owner must explicitly approve sending user images to third-party models
 * (external model scenario), image token costs, and real provider vision capability.
 *
 * When false (default): images are processed as text descriptions only
 * (current behavior). No image bytes are sent to any provider.
 *
 * When true: context-builder injects image references (object storage URL
 * or size-limited base64) for image blocks, and vision-capable providers
 * process them. Feature flag + per-run image budget enforced.
 *
 * Risk control: HIGH risk — cost, privacy, provider support.
 * Must be flag-isolated, default off. Owner decision required.
 *
 * Related env vars:
 * - VISION_IMAGE_BUDGET_PER_RUN: max number of images per run (default: 10)
 * - VISION_IMAGE_MAX_BASE64_BYTES: max base64 size per image (default: 1048576 = 1MB)
 */
export function isVisionUnderstandingEnabled(): boolean {
  return process.env.VISION_UNDERSTANDING_ENABLED === "true";
}

/**
 * E3: Get the per-run image budget for vision understanding.
 * Limits how many images can be sent to the vision provider in a single run.
 * @returns max images per run (default: 10)
 */
export function getVisionImageBudgetPerRun(): number {
  const raw = Number(process.env.VISION_IMAGE_BUDGET_PER_RUN);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 10;
}

/**
 * E3: Get the maximum base64 size per image for vision understanding.
 * Prevents sending excessively large images to the provider.
 * @returns max bytes (default: 1MB = 1048576)
 */
export function getVisionImageMaxBase64Bytes(): number {
  const raw = Number(process.env.VISION_IMAGE_MAX_BASE64_BYTES);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 1_048_576;
}

// ─── P2-9: Fast 路径灰度机制(实施计划 §5.2 P2-9) ────────────────────────

/**
 * FAST_PATH_ENABLED — Fast 路径灰度总开关(默认 false,只统计不切换)。
 *
 * 关闭时 fail-closed:Router 恒 full_supervisor_v1(现状路径,§12.2 原则)。
 * 精确值 "true" 启用;启用后按 FAST_PATH_ROLLOUT_PERCENT 分桶放量。
 */
export function isFastPathEnabled(): boolean {
  return process.env.FAST_PATH_ENABLED === "true";
}

/** 灰度放量百分比(0-100,默认 0)。非法值收敛到 0(fail-closed)。 */
export function getFastPathRolloutPercent(): number {
  const raw = Number.parseInt(process.env.FAST_PATH_ROLLOUT_PERCENT ?? "", 10);
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
}

/**
 * 按 runId 稳定哈希分桶:hash % 100 < percent → Fast 桶。
 * 同一 runId 每次判定一致(重试不换桶)。
 */
export function isRunInFastBucket(runId: string): boolean {
  if (!isFastPathEnabled()) return false;
  const percent = getFastPathRolloutPercent();
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  let h = 0;
  for (let i = 0; i < runId.length; i++) {
    h = (h * 31 + runId.charCodeAt(i)) >>> 0;
  }
  return h % 100 < percent;
}

// ─── P3 Planned 路径灰度机制(全量审计接线;与 Fast 同模式,默认关闭) ────────

/**
 * PLANNED_PATH_ENABLED — Planned 路径灰度总开关(默认 false,只统计不切换)。
 * 关闭时 fail-closed:Router 恒 full_supervisor_v1(§12.2 原则)。
 */
export function isPlannedPathEnabled(): boolean {
  return process.env.PLANNED_PATH_ENABLED === "true";
}

/** Planned 放量百分比(0-100,默认 0)。非法值收敛到 0(fail-closed)。 */
export function getPlannedPathRolloutPercent(): number {
  const raw = Number.parseInt(process.env.PLANNED_PATH_ROLLOUT_PERCENT ?? "", 10);
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
}

/** 按 runId 稳定哈希分桶(与 Fast 同语义:同一 runId 每次判定一致) */
export function isRunInPlannedBucket(runId: string): boolean {
  if (!isPlannedPathEnabled()) return false;
  const percent = getPlannedPathRolloutPercent();
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  let h = 0;
  for (let i = 0; i < runId.length; i++) {
    h = (h * 31 + runId.charCodeAt(i)) >>> 0;
  }
  return h % 100 < percent;
}
