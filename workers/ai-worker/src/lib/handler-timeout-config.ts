/**
 * Per-job-type handler timeout resolution.
 *
 * Timeouts are configurable via environment variables:
 *   WORKER_MODEL_TIMEOUT_MS              — global default (fallback)
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
  // URL fetch + text segmentation, no AI call.
  parse_source: 60_000,
  // Companion Agent：bounded model/tool loop + 确定性落库。
  companion_agent: 110_000,
  // 2026-09-15 审计（设计 P1-13）：此前只覆盖 parse_source + companion_agent，
  // 其余 4 种 job 落到 GLOBAL_DEFAULT_MS(90s)。HEAD 的同名映射覆盖了它那个时代的
  // **全部** job 类型——job 类型换代后映射没跟上，属覆盖率回归。补齐现在的 6 种。
  // 单次 LLM 调用 + 确定性落库，与 HEAD 的 companion_dialogue(60s) 同级。
  companion_memory_extract: 60_000,
  companion_summarizer: 60_000,
  // 桌宠日记正文由模型写（2026-09-21 从确定性模板改过来），一次 job 最多两次采样。
  // 实测（dev，ai_audit_log.duration_ms，10 次成功调用）：5.3–20.2s，典型 8–14s。
  // 90s = provider 预算 75s/次，够装下四次"最慢那次"，所以重采样不会被本地 abort 掐死；
  // 30s（旧值）则会让第一次调用就被切——那是纯模板时代的数。
  companion_daily_summary: 90_000,
  // 最重的一个：最多 200 次 embed + 每行 2 条写语句（BATCH_LIMIT=200）。
  // 取 clamp 上限（LEASE_TIMEOUT_MS - 10s），是 lease 约束下能给的唯一选择。
  companion_memory_embedding_rebuild: 110_000,
  // 念头生成（0227）：素材收集 + 可选 LLM 批量/表达 + embedding 去重，多次外部往返。
  companion_thought: 110_000,
};

const GLOBAL_DEFAULT_MS = 90_000;
const PROVIDER_SAFETY_MARGIN_MS = 15_000;
// 75s (was 60s): long structured JSON outputs on commercial Qwen-class models
// regularly need 40-70s even without thinking mode. Still bounded by
// handlerTimeout - 15s, so the agent turn (120s) keeps its
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
 *   1. Per-type env var (e.g. WORKER_TIMEOUT_PARSE_SOURCE_MS)
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
