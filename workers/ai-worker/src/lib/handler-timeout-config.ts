/**
 * Per-job-type handler timeout resolution.
 *
 * Timeouts are configurable via environment variables:
 *   WORKER_MODEL_TIMEOUT_MS              — global default (fallback)
 *   WORKER_TIMEOUT_GENERATE_CARD_MS      — generate_card override
 *   WORKER_TIMEOUT_ANALYZE_CARD_IMAGE_MS — analyze_card_image override
 *   WORKER_TIMEOUT_EVALUATE_VALIDATION_MS — evaluate_validation override
 *   WORKER_TIMEOUT_ALIGN_EVIDENCE_MS     — align_evidence override
 *   WORKER_TIMEOUT_PARSE_SOURCE_MS       — parse_source override
 *   WORKER_PROVIDER_TIMEOUT_MS           — nested provider-call default
 *   WORKER_PROVIDER_TIMEOUT_<TYPE>_MS    — nested provider-call override
 *
 * The lease timeout (LEASE_TIMEOUT_MS = 120 s) must remain strictly larger
 * than every handler timeout so the abort fires before the reaper reclaims
 * the job.  resolveHandlerTimeout clamps each value to LEASE_TIMEOUT_MS - 10 s
 * as a safety margin.
 */

import { LEASE_TIMEOUT_MS } from "../queue.ts";

const LEASE_SAFETY_MARGIN_MS = 10_000;
const MAX_ALLOWED_TIMEOUT_MS = LEASE_TIMEOUT_MS - LEASE_SAFETY_MARGIN_MS;

/** Default per-type timeouts (milliseconds). */
const DEFAULT_TIMEOUTS: Record<string, number> = {
  // AI generation — complex structured output, needs the most time.
  generate_card: 90_000,
  // Deterministic planner/reduce/publish leave ample time for DB checkpoints.
  plan_card_generation: 60_000,
  reduce_card_generation: 60_000,
  plan_card_set: 60_000,
  render_card_generation: 60_000,
  publish_card_generation: 60_000,
  // One bounded Provider call plus validation/persistence.
  map_card_generation: 90_000,
  // One vision call, optional bounded map call, and durable cache persistence.
  analyze_card_image: 110_000,
  // AI evaluation — simpler output but still a model round-trip.
  evaluate_validation: 90_000,
  // v0.6 question generation needs post-call time for safe fallback.
  generate_validation_question: 90_000,
  // No AI call — pure fuzzy text alignment.
  align_evidence: 30_000,
  // URL fetch + text segmentation, no AI call.
  parse_source: 60_000,
};

const GLOBAL_DEFAULT_MS = 90_000;
const PROVIDER_SAFETY_MARGIN_MS = 15_000;
// 75s (was 60s): long structured JSON outputs on commercial Qwen-class models
// regularly need 40-70s even without thinking mode. Still bounded by
// handlerTimeout - 15s, so map (90s) and image (110s) callers keep their
// persistence margin inside the 120s lease. Override per deployment via
// WORKER_PROVIDER_TIMEOUT_MS / WORKER_PROVIDER_TIMEOUT_<TYPE>_MS.
const DEFAULT_PROVIDER_TIMEOUT_MS = 75_000;

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function envKeyForType(jobType: string): string {
  return `WORKER_TIMEOUT_${jobType.toUpperCase()}_MS`;
}

function providerEnvKeyForType(jobType: string): string {
  return `WORKER_PROVIDER_TIMEOUT_${jobType.toUpperCase()}_MS`;
}

/**
 * Resolve the handler timeout for a given job type.
 *
 * Priority:
 *   1. Per-type env var (e.g. WORKER_TIMEOUT_GENERATE_CARD_MS)
 *   2. Global env var (WORKER_MODEL_TIMEOUT_MS)
 *   3. Per-type built-in default
 *   4. Global built-in default (90 000 ms)
 *
 * The result is clamped to MAX_ALLOWED_TIMEOUT_MS to stay within the lease.
 */
export function resolveHandlerTimeout(jobType: string): number {
  // 1. Per-type env var — highest priority, explicit operator override.
  const perTypeEnv = parsePositiveInt(process.env[envKeyForType(jobType)]);
  if (perTypeEnv !== undefined) return clamp(perTypeEnv);

  // 2. Global env var — operator-wide override applies to all job types
  //    that don't have an explicit per-type env var.
  const globalEnv = parsePositiveInt(process.env.WORKER_MODEL_TIMEOUT_MS);
  if (globalEnv !== undefined) return clamp(globalEnv);

  // 3. Per-type built-in default — sensible per-type values when no env.
  const perTypeDefault = DEFAULT_TIMEOUTS[jobType];
  if (perTypeDefault !== undefined) return clamp(perTypeDefault);

  // 4. Global built-in default.
  return clamp(GLOBAL_DEFAULT_MS);
}

/**
 * Resolve a nested provider-call budget that leaves time for the handler's
 * deterministic fallback or retry-state persistence.
 */
export function resolveProviderCallTimeout(jobType: string): number {
  const handlerTimeout = resolveHandlerTimeout(jobType);
  const requested =
    parsePositiveInt(process.env[providerEnvKeyForType(jobType)])
    ?? parsePositiveInt(process.env.WORKER_PROVIDER_TIMEOUT_MS)
    ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const available = handlerTimeout > PROVIDER_SAFETY_MARGIN_MS
    ? handlerTimeout - PROVIDER_SAFETY_MARGIN_MS
    : Math.max(1_000, handlerTimeout - 1_000);
  return Math.max(1, Math.min(requested, available));
}

function clamp(ms: number): number {
  return Math.min(ms, MAX_ALLOWED_TIMEOUT_MS);
}

/** Exposed for logging / diagnostics. */
export const RESOLVED_TIMEOUT_INFO = {
  leaseTimeoutMs: LEASE_TIMEOUT_MS,
  maxAllowedTimeoutMs: MAX_ALLOWED_TIMEOUT_MS,
  defaultTimeouts: { ...DEFAULT_TIMEOUTS },
  globalDefaultMs: GLOBAL_DEFAULT_MS,
  defaultProviderTimeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
  providerSafetyMarginMs: PROVIDER_SAFETY_MARGIN_MS,
};
