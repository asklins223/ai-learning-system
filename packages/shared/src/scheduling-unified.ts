/**
 * Unified scheduling dispatcher (计划 §10.6, §12.2)
 *
 * Delegates to discrete-v2 policy. The v1 fallback path has been retired;
 * the SCHEDULER_POLICY_VERSION flag is no longer consulted.
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

/**
 * Calculate scheduling decision using discrete-v2 policy.
 *
 * The v1 fallback path has been retired; the SCHEDULER_POLICY_VERSION flag
 * is no longer consulted. All callers get v0.6 unified policy.
 */
export function calculateSchedule(input: UnifiedScheduleInput): UnifiedScheduleResult {
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
