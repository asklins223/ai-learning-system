export const REVIEW_INTERVAL_TIERS = Object.freeze([1, 3, 7, 14, 30, 60] as const);

export const REVIEW_LATER_DELAY_HOURS = 12;

const MILLISECONDS_PER_HOUR = 60 * 60 * 1_000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;

export type ReviewIntervalDays = (typeof REVIEW_INTERVAL_TIERS)[number];

export const REVIEW_OUTCOMES = Object.freeze([
  "correct",
  "partial",
  "incorrect",
  "unable",
  "later",
] as const);

export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export type ReviewScheduleReasonCode =
  | "correct_advance"
  | "correct_interval_cap"
  | "partial_advance"
  | "partial_interval_cap"
  | "incorrect_reset"
  | "unable_reset"
  | "later_short_deferral"
  | "question_invalid"
  | "evidence_insufficient";

export type ReviewUnderstandingEffect = "upgrade" | "downgrade" | "unchanged";

export type ReviewSchedulingPolicyErrorCode =
  | "invalid_input"
  | "invalid_interval"
  | "invalid_outcome"
  | "invalid_time"
  | "invalid_question"
  | "invalid_evidence";

export interface ReviewSchedulingInput {
  currentIntervalDays: number;
  outcome: ReviewOutcome;
  /** Derived by the service after loading the current server-side question. */
  hasValidServerQuestion: boolean;
  /** Derived by the service from the target key point's current evidence. */
  hasHardEvidence: boolean;
  now: Date;
}

export interface ReviewSchedulingDecision {
  /** Exact value read from the legacy/current schedule before normalization. */
  storedIntervalDays: number;
  /** Canonical tier used by the v0.5 policy. */
  beforeIntervalDays: ReviewIntervalDays;
  afterIntervalDays: ReviewIntervalDays;
  nextReviewAt: Date;
  reasonCode: ReviewScheduleReasonCode;
  understandingEffect: ReviewUnderstandingEffect;
}

export class ReviewSchedulingPolicyError extends Error {
  readonly code: ReviewSchedulingPolicyErrorCode;

  constructor(code: ReviewSchedulingPolicyErrorCode) {
    super(code);
    this.name = "ReviewSchedulingPolicyError";
    this.code = code;
  }
}

function isReviewOutcome(value: unknown): value is ReviewOutcome {
  return typeof value === "string" && (REVIEW_OUTCOMES as readonly string[]).includes(value);
}

function nextIntervalTier(currentIntervalDays: ReviewIntervalDays): ReviewIntervalDays {
  const currentIndex = REVIEW_INTERVAL_TIERS.indexOf(currentIntervalDays);
  const nextIndex = Math.min(currentIndex + 1, REVIEW_INTERVAL_TIERS.length - 1);
  return REVIEW_INTERVAL_TIERS[nextIndex];
}

function addMilliseconds(now: Date, milliseconds: number): Date {
  const nextReviewAt = new Date(now.getTime() + milliseconds);
  if (!Number.isFinite(nextReviewAt.getTime())) {
    throw new ReviewSchedulingPolicyError("invalid_time");
  }
  return nextReviewAt;
}

function decision(
  storedIntervalDays: number,
  beforeIntervalDays: ReviewIntervalDays,
  afterIntervalDays: ReviewIntervalDays,
  nextReviewAt: Date,
  reasonCode: ReviewScheduleReasonCode,
  understandingEffect: ReviewUnderstandingEffect,
): ReviewSchedulingDecision {
  return {
    storedIntervalDays,
    beforeIntervalDays,
    afterIntervalDays,
    nextReviewAt,
    reasonCode,
    understandingEffect,
  };
}

/**
 * Maps intervals produced by v0.4 (including 0/2/6/12/24) to the first v0.5
 * tier that does not shorten the stored interval. This keeps representative
 * upgrades usable while still failing closed on corrupt/out-of-range values.
 */
export function normalizeReviewIntervalDays(value: unknown): ReviewIntervalDays {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 60) {
    throw new ReviewSchedulingPolicyError("invalid_interval");
  }
  const positiveValue = Math.max(1, value as number);
  const tier = REVIEW_INTERVAL_TIERS.find((candidate) => candidate >= positiveValue);
  if (tier === undefined) throw new ReviewSchedulingPolicyError("invalid_interval");
  return tier;
}

/**
 * Applies ADR-0004's discrete review policy without reading clocks or mutating state.
 * Callers must establish both the current server-question validity and hard-evidence
 * eligibility, then provide the effective server time. Invalid runtime input throws
 * instead of being coerced.
 */
export function calculateReviewSchedule(input: ReviewSchedulingInput): ReviewSchedulingDecision {
  if (!input || typeof input !== "object") {
    throw new ReviewSchedulingPolicyError("invalid_input");
  }
  const beforeIntervalDays = normalizeReviewIntervalDays(input.currentIntervalDays);
  if (!isReviewOutcome(input.outcome)) {
    throw new ReviewSchedulingPolicyError("invalid_outcome");
  }
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new ReviewSchedulingPolicyError("invalid_time");
  }
  if (typeof input.hasHardEvidence !== "boolean") {
    throw new ReviewSchedulingPolicyError("invalid_evidence");
  }
  if (typeof input.hasValidServerQuestion !== "boolean") {
    throw new ReviewSchedulingPolicyError("invalid_question");
  }

  const storedIntervalDays = input.currentIntervalDays;

  if (
    (input.outcome === "correct" || input.outcome === "partial") &&
    !input.hasValidServerQuestion
  ) {
    return decision(
      storedIntervalDays,
      beforeIntervalDays,
      beforeIntervalDays,
      addMilliseconds(input.now, beforeIntervalDays * MILLISECONDS_PER_DAY),
      "question_invalid",
      "unchanged",
    );
  }

  if ((input.outcome === "correct" || input.outcome === "partial") && !input.hasHardEvidence) {
    return decision(
      storedIntervalDays,
      beforeIntervalDays,
      beforeIntervalDays,
      addMilliseconds(input.now, beforeIntervalDays * MILLISECONDS_PER_DAY),
      "evidence_insufficient",
      "unchanged",
    );
  }

  switch (input.outcome) {
    case "correct": {
      const afterIntervalDays = nextIntervalTier(beforeIntervalDays);
      return decision(
        storedIntervalDays,
        beforeIntervalDays,
        afterIntervalDays,
        addMilliseconds(input.now, afterIntervalDays * MILLISECONDS_PER_DAY),
        afterIntervalDays === beforeIntervalDays ? "correct_interval_cap" : "correct_advance",
        "upgrade",
      );
    }
    case "partial": {
      const afterIntervalDays = nextIntervalTier(beforeIntervalDays);
      return decision(
        storedIntervalDays,
        beforeIntervalDays,
        afterIntervalDays,
        addMilliseconds(input.now, afterIntervalDays * MILLISECONDS_PER_DAY),
        afterIntervalDays === beforeIntervalDays ? "partial_interval_cap" : "partial_advance",
        "upgrade",
      );
    }
    case "incorrect":
      return decision(
        storedIntervalDays,
        beforeIntervalDays,
        1,
        addMilliseconds(input.now, MILLISECONDS_PER_DAY),
        "incorrect_reset",
        "downgrade",
      );
    case "unable":
      return decision(
        storedIntervalDays,
        beforeIntervalDays,
        1,
        addMilliseconds(input.now, MILLISECONDS_PER_DAY),
        "unable_reset",
        "downgrade",
      );
    case "later":
      return decision(
        storedIntervalDays,
        beforeIntervalDays,
        beforeIntervalDays,
        addMilliseconds(input.now, REVIEW_LATER_DELAY_HOURS * MILLISECONDS_PER_HOUR),
        "later_short_deferral",
        "unchanged",
      );
  }
}
