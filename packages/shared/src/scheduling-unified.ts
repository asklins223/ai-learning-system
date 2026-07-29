/**
 * Unified scheduling dispatcher (计划 §10.6, §12.2)
 *
 * Checks SCHEDULER_POLICY_VERSION feature flag and delegates to the
 * appropriate scheduling policy:
 * - "discrete-v2": v0.6 unified policy with assistance-aware scheduling
 * - "discrete-v1" (default): legacy v0.5 policy used as the fail-closed rollout default
 *
 * Both API server and AI Worker use this dispatcher to ensure consistent
 * scheduling behavior across code paths.
 */

import {
  calculateDiscreteV2Schedule,
  DISCRETE_V2_POLICY_VERSION,
  type DiscreteV2Input,
  type DiscreteV2Decision,
} from "./scheduling-policy-v2.ts";
import { SchedulingPolicyVersion } from "./enums.ts";
import { getSchedulerPolicyVersion } from "./feature-flags.ts";

// ─── v1-compatible constants and types ───────────────────────────────────

export const DISCRETE_V1_INTERVAL_TIERS = Object.freeze([1, 3, 7, 14, 30, 60] as const);
export const DISCRETE_V1_POLICY_VERSION = SchedulingPolicyVersion.DISCRETE_V1;
const MS_PER_HOUR = 60 * 60 * 1_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export interface UnifiedScheduleInput {
  currentIntervalDays: number;
  outcome: string;
  hasValidServerQuestion: boolean;
  hasHardEvidence: boolean;
  now: Date;
  unassistedEligibleAfter?: Date | null;
}

export interface UnifiedScheduleResult {
  shouldMutateSchedule: boolean;
  nextReviewAt: Date;
  afterIntervalDays: number;
  beforeIntervalDays: number;
  reasonCode: string;
  understandingEffect: string;
  policyVersion: string;
}

// ─── v1-compatible scheduling logic ──────────────────────────────────────

function normalizeV1Interval(value: number): number {
  const positive = Math.max(1, value);
  const tier = DISCRETE_V1_INTERVAL_TIERS.find((t) => t >= positive);
  return tier ?? DISCRETE_V1_INTERVAL_TIERS[DISCRETE_V1_INTERVAL_TIERS.length - 1];
}

function nextV1Tier(current: number): number {
  const idx = DISCRETE_V1_INTERVAL_TIERS.indexOf(current as (typeof DISCRETE_V1_INTERVAL_TIERS)[number]);
  if (idx < 0) return DISCRETE_V1_INTERVAL_TIERS[0];
  return DISCRETE_V1_INTERVAL_TIERS[Math.min(idx + 1, DISCRETE_V1_INTERVAL_TIERS.length - 1)];
}

/**
 * v1-compatible scheduling: partial advances (v0.5 bug), no source_viewed
 * handling, no unassisted_eligible_after consideration.
 */
function calculateDiscreteV1Schedule(input: UnifiedScheduleInput): UnifiedScheduleResult {
  const before = normalizeV1Interval(input.currentIntervalDays);

  // v1 doesn't handle source_viewed, stale, provider_failure
  // Map them to safe no-change outcomes
  if (input.outcome === "stale" || input.outcome === "provider_failure") {
    return {
      shouldMutateSchedule: false,
      nextReviewAt: new Date(input.now.getTime() + before * MS_PER_DAY),
      afterIntervalDays: before,
      beforeIntervalDays: before,
      reasonCode: input.outcome === "stale" ? "stale_no_change" : "provider_failure_no_change",
      understandingEffect: "unchanged",
      policyVersion: DISCRETE_V1_POLICY_VERSION,
    };
  }

  // source_viewed 是 v0.6 才存在的 outcome（v0.5 不追踪 assistance），只可能
  // 来自 v0.6 finalizer。计划 §4.1 不变量 4 是硬性门禁且不随 flag 关闭而豁免：
  // "0 次在 answer_locked_at 之前发生的 assistance 却延长正式间隔"。
  // 因此即使回退到 discrete-v1，assisted 结果也必须按"保持区间 + 冷却下限"
  // 处理，绝不能映射成 partial 走升级分支。
  if (input.outcome === "source_viewed") {
    const cooldownFloor = input.unassistedEligibleAfter?.getTime() ?? 0;
    const nextTime = Math.max(input.now.getTime() + MS_PER_DAY, cooldownFloor);
    return {
      shouldMutateSchedule: true,
      nextReviewAt: new Date(nextTime),
      afterIntervalDays: before,
      beforeIntervalDays: before,
      reasonCode: "assisted_hold",
      understandingEffect: "unchanged",
      policyVersion: DISCRETE_V1_POLICY_VERSION,
    };
  }

  const v1Outcome = input.outcome;

  // Guard checks
  if ((v1Outcome === "correct" || v1Outcome === "partial") && !input.hasValidServerQuestion) {
    return {
      shouldMutateSchedule: true,
      nextReviewAt: new Date(input.now.getTime() + before * MS_PER_DAY),
      afterIntervalDays: before,
      beforeIntervalDays: before,
      reasonCode: "question_invalid",
      understandingEffect: "unchanged",
      policyVersion: DISCRETE_V1_POLICY_VERSION,
    };
  }

  if ((v1Outcome === "correct" || v1Outcome === "partial") && !input.hasHardEvidence) {
    return {
      shouldMutateSchedule: true,
      nextReviewAt: new Date(input.now.getTime() + before * MS_PER_DAY),
      afterIntervalDays: before,
      beforeIntervalDays: before,
      reasonCode: "evidence_insufficient",
      understandingEffect: "unchanged",
      policyVersion: DISCRETE_V1_POLICY_VERSION,
    };
  }

  switch (v1Outcome) {
    case "correct":
    case "partial": {
      // v1 bug: partial advances like correct
      const after = nextV1Tier(before);
      return {
        shouldMutateSchedule: true,
        nextReviewAt: new Date(input.now.getTime() + after * MS_PER_DAY),
        afterIntervalDays: after,
        beforeIntervalDays: before,
        reasonCode: after === before ? `${v1Outcome}_interval_cap` : `${v1Outcome}_advance`,
        understandingEffect: "upgrade",
        policyVersion: DISCRETE_V1_POLICY_VERSION,
      };
    }
    case "incorrect":
      return {
        shouldMutateSchedule: true,
        nextReviewAt: new Date(input.now.getTime() + MS_PER_DAY),
        afterIntervalDays: 1,
        beforeIntervalDays: before,
        reasonCode: "incorrect_reset",
        understandingEffect: "downgrade",
        policyVersion: DISCRETE_V1_POLICY_VERSION,
      };
    case "unable":
      return {
        shouldMutateSchedule: true,
        nextReviewAt: new Date(input.now.getTime() + MS_PER_DAY),
        afterIntervalDays: 1,
        beforeIntervalDays: before,
        reasonCode: "unable_reset",
        understandingEffect: "downgrade",
        policyVersion: DISCRETE_V1_POLICY_VERSION,
      };
    case "later":
      return {
        shouldMutateSchedule: true,
        nextReviewAt: new Date(input.now.getTime() + 12 * MS_PER_HOUR),
        afterIntervalDays: before,
        beforeIntervalDays: before,
        reasonCode: "later_short_deferral",
        understandingEffect: "unchanged",
        policyVersion: DISCRETE_V1_POLICY_VERSION,
      };
    default:
      // Unknown outcome — fail closed
      return {
        shouldMutateSchedule: false,
        nextReviewAt: new Date(input.now.getTime() + before * MS_PER_DAY),
        afterIntervalDays: before,
        beforeIntervalDays: before,
        reasonCode: "unknown_outcome",
        understandingEffect: "unchanged",
        policyVersion: DISCRETE_V1_POLICY_VERSION,
      };
  }
}

// ─── Unified dispatcher ──────────────────────────────────────────────────

/**
 * Calculate scheduling decision using the active policy version.
 *
 * Checks SCHEDULER_POLICY_VERSION feature flag (计划 §12.2):
 * - "discrete-v2": v0.6 unified policy
 * - "discrete-v1" (default): legacy v0.5 policy
 */
export function calculateSchedule(input: UnifiedScheduleInput): UnifiedScheduleResult {
  const version = getSchedulerPolicyVersion();

  if (version === SchedulingPolicyVersion.DISCRETE_V1) {
    return calculateDiscreteV1Schedule(input);
  }

  // The flag helper only reaches this branch after an explicit v2 opt-in.
  const v2Input: DiscreteV2Input = {
    currentIntervalDays: input.currentIntervalDays,
    outcome: input.outcome as DiscreteV2Input["outcome"],
    hasValidServerQuestion: input.hasValidServerQuestion,
    hasHardEvidence: input.hasHardEvidence,
    now: input.now,
    unassistedEligibleAfter: input.unassistedEligibleAfter ?? null,
  };

  const v2Result: DiscreteV2Decision = calculateDiscreteV2Schedule(v2Input);

  return {
    shouldMutateSchedule: v2Result.shouldMutateSchedule,
    nextReviewAt: v2Result.nextReviewAt,
    afterIntervalDays: v2Result.afterIntervalDays,
    beforeIntervalDays: v2Result.beforeIntervalDays,
    reasonCode: v2Result.reasonCode,
    understandingEffect: v2Result.understandingEffect,
    policyVersion: DISCRETE_V2_POLICY_VERSION,
  };
}
