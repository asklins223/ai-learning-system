/**
 * discrete-v2: 统一离散调度策略 (计划 §10.6)
 *
 * 纯函数：不读取时钟、不修改状态、不调用外部服务。
 *
 * 与 discrete-v1 的关键差异：
 * 1. partial 不推进间隔（v0.5 bug：partial 像 correct 一样前进）
 * 2. 新增 source_viewed outcome：due 不早于 max(now+1d, unassisted_eligible_after)
 * 3. 新增 stale / provider_failure outcome：不改正式 schedule
 * 4. incorrect/unable/source_viewed 的 due 考虑 unassisted_eligible_after
 * 5. Review effective start = max(next_review_at, unassisted_eligible_after)
 */

// ─── Constants ────────────────────────────────────────────────────────────

export const DISCRETE_V2_INTERVAL_TIERS = Object.freeze([1, 3, 7, 14, 30, 60] as const);
export const DISCRETE_V2_LATER_DELAY_HOURS = 12;
export const DISCRETE_V2_POLICY_VERSION = "discrete-v2" as const;

const MS_PER_HOUR = 60 * 60 * 1_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export type DiscreteV2IntervalDays = (typeof DISCRETE_V2_INTERVAL_TIERS)[number];

// ─── Outcomes ─────────────────────────────────────────────────────────────

export const DISCRETE_V2_OUTCOMES = Object.freeze([
  "correct",
  "partial",
  "incorrect",
  "unable",
  "source_viewed",
  "later",
  "stale",
  "provider_failure",
] as const);

export type DiscreteV2Outcome = (typeof DISCRETE_V2_OUTCOMES)[number];

// ─── Reason codes ─────────────────────────────────────────────────────────

export type DiscreteV2ReasonCode =
  | "correct_advance"
  | "correct_interval_cap"
  | "partial_hold"          // v0.6: partial 不推进
  | "incorrect_reset"
  | "unable_reset"
  | "source_viewed_hold"    // v0.6: source_viewed 不推进
  | "later_short_deferral"
  | "stale_no_change"       // v0.6: stale 不改 schedule
  | "provider_failure_no_change" // v0.6: provider failure 不改 schedule
  | "question_invalid"
  | "evidence_insufficient";

export type DiscreteV2UnderstandingEffect = "upgrade" | "downgrade" | "unchanged";

// ─── Error ────────────────────────────────────────────────────────────────

export type DiscreteV2ErrorCode =
  | "invalid_input"
  | "invalid_interval"
  | "invalid_outcome"
  | "invalid_time";

export class DiscreteV2PolicyError extends Error {
  readonly code: DiscreteV2ErrorCode;

  constructor(code: DiscreteV2ErrorCode) {
    super(code);
    this.name = "DiscreteV2PolicyError";
    this.code = code;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface DiscreteV2Input {
  currentIntervalDays: number;
  outcome: DiscreteV2Outcome;
  /** Server-side question validity */
  hasValidServerQuestion: boolean;
  /** Hard evidence eligibility */
  hasHardEvidence: boolean;
  /** Effective server time */
  now: Date;
  /** When unassisted eligibility resumes after assistance exposure; null = no exposure */
  unassistedEligibleAfter: Date | null;
}

export interface DiscreteV2Decision {
  storedIntervalDays: number;
  beforeIntervalDays: DiscreteV2IntervalDays;
  afterIntervalDays: DiscreteV2IntervalDays;
  nextReviewAt: Date;
  reasonCode: DiscreteV2ReasonCode;
  understandingEffect: DiscreteV2UnderstandingEffect;
  policyVersion: typeof DISCRETE_V2_POLICY_VERSION;
  /** false for stale/provider_failure — caller must NOT mutate the schedule */
  shouldMutateSchedule: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isDiscreteV2Outcome(value: unknown): value is DiscreteV2Outcome {
  return typeof value === "string" && (DISCRETE_V2_OUTCOMES as readonly string[]).includes(value);
}

function normalizeIntervalDays(value: unknown): DiscreteV2IntervalDays {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 60) {
    throw new DiscreteV2PolicyError("invalid_interval");
  }
  const positiveValue = Math.max(1, value as number);
  const tier = DISCRETE_V2_INTERVAL_TIERS.find((candidate) => candidate >= positiveValue);
  if (tier === undefined) throw new DiscreteV2PolicyError("invalid_interval");
  return tier;
}

function nextTier(current: DiscreteV2IntervalDays): DiscreteV2IntervalDays {
  const idx = DISCRETE_V2_INTERVAL_TIERS.indexOf(current);
  return DISCRETE_V2_INTERVAL_TIERS[Math.min(idx + 1, DISCRETE_V2_INTERVAL_TIERS.length - 1)];
}

function addMs(now: Date, ms: number): Date {
  const result = new Date(now.getTime() + ms);
  if (!Number.isFinite(result.getTime())) {
    throw new DiscreteV2PolicyError("invalid_time");
  }
  return result;
}

/**
 * Compute the effective due date: max(policyDue, unassistedEligibleAfter).
 * This ensures assisted/incorrect/unable users can't start a trusted review
 * before the exposure cooldown ends.
 */
function effectiveDueDate(policyDue: Date, unassistedEligibleAfter: Date | null): Date {
  if (unassistedEligibleAfter && unassistedEligibleAfter.getTime() > policyDue.getTime()) {
    return new Date(unassistedEligibleAfter.getTime());
  }
  return policyDue;
}

function makeDecision(
  storedIntervalDays: number,
  beforeIntervalDays: DiscreteV2IntervalDays,
  afterIntervalDays: DiscreteV2IntervalDays,
  nextReviewAt: Date,
  reasonCode: DiscreteV2ReasonCode,
  understandingEffect: DiscreteV2UnderstandingEffect,
  shouldMutateSchedule = true,
): DiscreteV2Decision {
  return {
    storedIntervalDays,
    beforeIntervalDays,
    afterIntervalDays,
    nextReviewAt,
    reasonCode,
    understandingEffect,
    policyVersion: DISCRETE_V2_POLICY_VERSION,
    shouldMutateSchedule,
  };
}

// ─── Policy ───────────────────────────────────────────────────────────────

/**
 * Applies the discrete-v2 scheduling policy.
 *
 * Key difference from v1: partial does NOT advance the interval.
 * Assisted (source_viewed) results get a cooldown gate via unassistedEligibleAfter.
 * stale and provider_failure do not mutate the schedule at all.
 */
export function calculateDiscreteV2Schedule(input: DiscreteV2Input): DiscreteV2Decision {
  if (!input || typeof input !== "object") {
    throw new DiscreteV2PolicyError("invalid_input");
  }
  const beforeIntervalDays = normalizeIntervalDays(input.currentIntervalDays);
  if (!isDiscreteV2Outcome(input.outcome)) {
    throw new DiscreteV2PolicyError("invalid_outcome");
  }
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new DiscreteV2PolicyError("invalid_time");
  }
  if (typeof input.hasHardEvidence !== "boolean" || typeof input.hasValidServerQuestion !== "boolean") {
    throw new DiscreteV2PolicyError("invalid_input");
  }

  const storedIntervalDays = input.currentIntervalDays;
  const { now, unassistedEligibleAfter } = input;

  // ── stale / provider_failure: no schedule mutation ──
  if (input.outcome === "stale") {
    return makeDecision(
      storedIntervalDays,
      beforeIntervalDays,
      beforeIntervalDays,
      addMs(now, beforeIntervalDays * MS_PER_DAY),
      "stale_no_change",
      "unchanged",
      false, // shouldMutateSchedule = false
    );
  }

  if (input.outcome === "provider_failure") {
    return makeDecision(
      storedIntervalDays,
      beforeIntervalDays,
      beforeIntervalDays,
      addMs(now, beforeIntervalDays * MS_PER_DAY),
      "provider_failure_no_change",
      "unchanged",
      false,
    );
  }

  // ── Guard: question/evidence validity for upgrade-eligible outcomes ──
  const isUpgradeEligible = input.outcome === "correct" || input.outcome === "partial";

  if (isUpgradeEligible && !input.hasValidServerQuestion) {
    return makeDecision(
      storedIntervalDays,
      beforeIntervalDays,
      beforeIntervalDays,
      addMs(now, beforeIntervalDays * MS_PER_DAY),
      "question_invalid",
      "unchanged",
    );
  }

  if (isUpgradeEligible && !input.hasHardEvidence) {
    return makeDecision(
      storedIntervalDays,
      beforeIntervalDays,
      beforeIntervalDays,
      addMs(now, beforeIntervalDays * MS_PER_DAY),
      "evidence_insufficient",
      "unchanged",
    );
  }

  // ── Main outcome switch ──
  // Cooldown gate (unassistedEligibleAfter) applies ONLY to:
  //   incorrect, unable, source_viewed (计划 §10.6)
  // correct and partial use pure policy due dates.
  switch (input.outcome) {
    case "correct": {
      const after = nextTier(beforeIntervalDays);
      return makeDecision(
        storedIntervalDays,
        beforeIntervalDays,
        after,
        addMs(now, after * MS_PER_DAY),
        after === beforeIntervalDays ? "correct_interval_cap" : "correct_advance",
        "upgrade",
      );
    }

    case "partial": {
      // v0.6 KEY FIX: partial does NOT advance.
      // Interval stays the same, understanding is unchanged.
      return makeDecision(
        storedIntervalDays,
        beforeIntervalDays,
        beforeIntervalDays, // same as before — no advance
        addMs(now, beforeIntervalDays * MS_PER_DAY),
        "partial_hold",
        "unchanged",
      );
    }

    case "incorrect": {
      // Reset to 1 day, but respect unassisted cooldown
      const policyDue = addMs(now, MS_PER_DAY);
      return makeDecision(
        storedIntervalDays,
        beforeIntervalDays,
        1,
        effectiveDueDate(policyDue, unassistedEligibleAfter),
        "incorrect_reset",
        "downgrade",
      );
    }

    case "unable": {
      const policyDue = addMs(now, MS_PER_DAY);
      return makeDecision(
        storedIntervalDays,
        beforeIntervalDays,
        1,
        effectiveDueDate(policyDue, unassistedEligibleAfter),
        "unable_reset",
        "downgrade",
      );
    }

    case "source_viewed": {
      // v0.6: source_viewed → understanding unchanged,
      // due not earlier than max(now + 1 day, unassistedEligibleAfter),
      // interval does not increase.
      const policyDue = addMs(now, MS_PER_DAY);
      return makeDecision(
        storedIntervalDays,
        beforeIntervalDays,
        beforeIntervalDays, // no increase
        effectiveDueDate(policyDue, unassistedEligibleAfter),
        "source_viewed_hold",
        "unchanged",
      );
    }

    case "later": {
      // Same as v1: delay 12 hours, keep interval, no understanding change
      return makeDecision(
        storedIntervalDays,
        beforeIntervalDays,
        beforeIntervalDays,
        addMs(now, DISCRETE_V2_LATER_DELAY_HOURS * MS_PER_HOUR),
        "later_short_deferral",
        "unchanged",
      );
    }
  }
}

// ─── Effective start time helper (计划 §9.4) ─────────────────────────────

/**
 * Review effective start = max(next_review_at, unassisted_eligible_after).
 * Used to determine if a user can start a trusted review.
 */
export function effectiveReviewStart(
  nextReviewAt: Date,
  unassistedEligibleAfter: Date | null,
): Date {
  if (!unassistedEligibleAfter) return nextReviewAt;
  return unassistedEligibleAfter.getTime() > nextReviewAt.getTime()
    ? new Date(unassistedEligibleAfter.getTime())
    : nextReviewAt;
}
