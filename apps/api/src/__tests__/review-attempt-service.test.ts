import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ReviewAttemptError,
  type ReviewAttemptErrorCode,
} from "../modules/review/attempt-service.ts";
import {
  calculateReviewSchedule,
  REVIEW_INTERVAL_TIERS,
  REVIEW_LATER_DELAY_HOURS,
  type ReviewSchedulingInput,
} from "../modules/review/scheduling-policy.ts";
import {
  ReviewAttemptAnswerType,
  ReviewAttemptOutcome,
  REVIEW_ATTEMPT_LATER_REASON,
  reviewAttemptStartSchema,
  reviewAttemptSubmitSchema,
  reviewAttemptLaterSchema,
  reviewAttemptHistoryPaginationSchema,
} from "@ailearn/shared";
import { encodeCursor, decodeCursor } from "../lib/pagination.ts";

const NOW = new Date("2026-07-18T08:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const SCHEDULE_ID = "123e4567-e89b-42d3-a456-426614174000";
const QUESTION_ID = "123e4567-e89b-42d3-a456-426614174001";
const ATTEMPT_ID = "123e4567-e89b-42d3-a456-426614174002";
const IDEMPOTENCY_KEY = "review-20260718-A1";

describe("review attempt error status code mapping", () => {
  const notFoundCodes: ReviewAttemptErrorCode[] = [
    "schedule_not_found",
    "attempt_not_found",
    "card_not_found",
    "key_point_not_found",
    "question_not_found",
  ];
  const conflictCodes: ReviewAttemptErrorCode[] = [
    "schedule_not_pending",
    "attempt_not_started",
    "attempt_already_completed",
  ];
  const goneCodes: ReviewAttemptErrorCode[] = ["question_expired"];

  for (const code of notFoundCodes) {
    it(`maps ${code} to 404`, () => {
      const error = new ReviewAttemptError(code);
      assert.equal(error.code, code);
      assert.equal(error.statusCode, 404);
      assert.equal(error.name, "ReviewAttemptError");
      assert.equal(error.message, code);
    });
  }

  for (const code of conflictCodes) {
    it(`maps ${code} to 409`, () => {
      const error = new ReviewAttemptError(code);
      assert.equal(error.statusCode, 409);
    });
  }

  for (const code of goneCodes) {
    it(`maps ${code} to 410`, () => {
      const error = new ReviewAttemptError(code);
      assert.equal(error.statusCode, 410);
    });
  }
});

describe("review attempt contract and scheduling policy integration", () => {
  function schedulingInput(overrides: Partial<ReviewSchedulingInput> = {}): ReviewSchedulingInput {
    return {
      currentIntervalDays: 1,
      outcome: "correct",
      hasValidServerQuestion: true,
      hasHardEvidence: true,
      now: NOW,
      ...overrides,
    };
  }

  it("ReviewAttemptOutcome values are accepted by the scheduling policy", () => {
    // Verify that every ReviewAttemptOutcome can be passed to calculateReviewSchedule
    // without a type error. This is a compile-time guarantee that the shared
    // contract and the scheduling policy use compatible canonical strings.
    for (const outcome of Object.values(ReviewAttemptOutcome)) {
      // The compile-time guarantee is that ReviewAttemptOutcome is accepted by
      // calculateReviewSchedule. At runtime we only assert a decision is produced.
      const result = calculateReviewSchedule(schedulingInput({ outcome }));
      assert.ok(result, `expected a decision for outcome=${outcome}`);
    }
  });

  it("correct outcome with valid question and hard evidence upgrades understanding", () => {
    const result = calculateReviewSchedule(
      schedulingInput({
        currentIntervalDays: 1,
        outcome: ReviewAttemptOutcome.CORRECT,
        hasValidServerQuestion: true,
        hasHardEvidence: true,
      }),
    );
    assert.equal(result.understandingEffect, "upgrade");
    assert.equal(result.afterIntervalDays, 3);
    assert.equal(result.reasonCode, "correct_advance");
  });

  it("correct outcome without hard evidence blocks upgrade", () => {
    const result = calculateReviewSchedule(
      schedulingInput({
        currentIntervalDays: 1,
        outcome: ReviewAttemptOutcome.CORRECT,
        hasValidServerQuestion: true,
        hasHardEvidence: false,
      }),
    );
    assert.equal(result.understandingEffect, "unchanged");
    assert.equal(result.reasonCode, "evidence_insufficient");
    assert.equal(result.afterIntervalDays, result.beforeIntervalDays);
  });

  it("correct outcome without valid server question blocks upgrade", () => {
    const result = calculateReviewSchedule(
      schedulingInput({
        currentIntervalDays: 7,
        outcome: ReviewAttemptOutcome.CORRECT,
        hasValidServerQuestion: false,
        hasHardEvidence: true,
      }),
    );
    assert.equal(result.understandingEffect, "unchanged");
    assert.equal(result.reasonCode, "question_invalid");
    assert.equal(result.afterIntervalDays, 7);
  });

  it("incorrect outcome resets to 1 day regardless of evidence", () => {
    const result = calculateReviewSchedule(
      schedulingInput({
        currentIntervalDays: 30,
        outcome: ReviewAttemptOutcome.INCORRECT,
        hasHardEvidence: false,
        hasValidServerQuestion: false,
      }),
    );
    assert.equal(result.understandingEffect, "downgrade");
    assert.equal(result.afterIntervalDays, 1);
    assert.equal(result.reasonCode, "incorrect_reset");
  });

  it("unable outcome resets to 1 day without requiring an answer", () => {
    const result = calculateReviewSchedule(
      schedulingInput({
        currentIntervalDays: 14,
        outcome: ReviewAttemptOutcome.UNABLE,
      }),
    );
    assert.equal(result.understandingEffect, "downgrade");
    assert.equal(result.afterIntervalDays, 1);
    assert.equal(result.reasonCode, "unable_reset");
  });

  it("later outcome applies a short deferral and keeps the interval", () => {
    const result = calculateReviewSchedule(
      schedulingInput({
        currentIntervalDays: 14,
        outcome: "later",
      }),
    );
    assert.equal(result.understandingEffect, "unchanged");
    assert.equal(result.afterIntervalDays, 14);
    assert.equal(result.reasonCode, "later_short_deferral");
    assert.ok(result.nextReviewAt.getTime() - NOW.getTime() < DAY_MS);
    assert.ok(result.nextReviewAt.getTime() - NOW.getTime() === REVIEW_LATER_DELAY_HOURS * 60 * 60 * 1_000);
  });

  it("REVIEW_ATTEMPT_LATER_REASON is the canonical later skip reason", () => {
    assert.equal(REVIEW_ATTEMPT_LATER_REASON, "later");
  });
});

describe("review attempt contract validation for API boundaries", () => {
  it("start contract accepts a valid schedule and idempotency key", () => {
    const parsed = reviewAttemptStartSchema.parse({
      reviewScheduleId: SCHEDULE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    assert.deepEqual(parsed, {
      reviewScheduleId: SCHEDULE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
  });

  it("submit contract accepts validationQuestionId as optional (enforced at runtime)", () => {
    const validSubmit = {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      validationQuestionId: QUESTION_ID,
      answerType: ReviewAttemptAnswerType.FREE_TEXT,
      answer: "I explained the key point.",
      outcome: ReviewAttemptOutcome.CORRECT,
      confidence: 85,
      idempotencyKey: IDEMPOTENCY_KEY,
    };
    assert.equal(reviewAttemptSubmitSchema.safeParse(validSubmit).success, true);

    // validationQuestionId is optional at the schema level;
    // the service enforces it at runtime for upgrading outcomes.
    const withoutQuestion = { ...validSubmit, validationQuestionId: undefined };
    assert.equal(reviewAttemptSubmitSchema.safeParse(withoutQuestion).success, true);
  });

  it("submit contract allows unable recall without a question or answer", () => {
    const candidate = {
      attemptId: ATTEMPT_ID,
      reviewScheduleId: SCHEDULE_ID,
      answerType: ReviewAttemptAnswerType.RECALL,
      outcome: ReviewAttemptOutcome.UNABLE,
      confidence: 0,
      idempotencyKey: IDEMPOTENCY_KEY,
    };
    assert.equal(reviewAttemptSubmitSchema.safeParse(candidate).success, true);
  });

  it("later contract uses the fixed later reason", () => {
    const parsed = reviewAttemptLaterSchema.parse({
      reviewScheduleId: SCHEDULE_ID,
      reason: REVIEW_ATTEMPT_LATER_REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    assert.equal(parsed.reason, "later");

    assert.equal(
      reviewAttemptLaterSchema.safeParse({
        reviewScheduleId: SCHEDULE_ID,
        reason: "skip",
        idempotencyKey: IDEMPOTENCY_KEY,
      }).success,
      false,
    );
  });

  it("history pagination accepts bounded limit and optional cursor", () => {
    const first = reviewAttemptHistoryPaginationSchema.parse({ limit: 20 });
    assert.deepEqual(first, { limit: 20 });

    const withCursor = reviewAttemptHistoryPaginationSchema.parse({
      limit: 50,
      cursor: "cursor-abc_123",
    });
    assert.equal(withCursor.cursor, "cursor-abc_123");

    assert.equal(
      reviewAttemptHistoryPaginationSchema.safeParse({ limit: 0 }).success,
      false,
    );
    assert.equal(
      reviewAttemptHistoryPaginationSchema.safeParse({ limit: 101 }).success,
      false,
    );
  });
});

describe("review attempt history cursor round-trip", () => {
  it("encodeCursor and decodeCursor are inverse operations", () => {
    const timestamp = "2026-07-18T08:00:00.000Z";
    const id = "123e4567-e89b-42d3-a456-426614174000";

    const encoded = encodeCursor(timestamp, id);
    const decoded = decodeCursor(encoded);

    assert.ok(decoded);
    assert.equal(decoded!.timestamp, timestamp);
    assert.equal(decoded!.id, id);
  });

  it("decodeCursor returns null for invalid or malformed cursors", () => {
    for (const invalid of [
      undefined,
      null,
      "",
      "not-base64!!!",
      "invalid",
      "xxxxxxxx",
      "dGVzdA==", // valid base64 but not a valid cursor format
    ]) {
      assert.equal(decodeCursor(invalid as string | undefined | null), null, `cursor: ${invalid}`);
    }
  });

  it("encodeCursor accepts Date objects", () => {
    const date = new Date("2026-07-18T08:00:00.000Z");
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const encoded = encodeCursor(date, id);
    const decoded = decodeCursor(encoded);
    assert.ok(decoded);
    assert.equal(decoded!.id, id);
  });
});

describe("review attempt scheduling tier coverage", () => {
  it("publishes the ADR-0004 interval tiers used by attempts", () => {
    assert.deepEqual(REVIEW_INTERVAL_TIERS, [1, 3, 7, 14, 30, 60]);
  });

  it("correct outcome advances through all tiers exactly once", () => {
    const expected = [3, 7, 14, 30, 60];
    for (const [index, current] of REVIEW_INTERVAL_TIERS.slice(0, -1).entries()) {
      const result = calculateReviewSchedule({
        currentIntervalDays: current,
        outcome: ReviewAttemptOutcome.CORRECT,
        hasValidServerQuestion: true,
        hasHardEvidence: true,
        now: NOW,
      });
      assert.equal(result.afterIntervalDays, expected[index]);
      assert.equal(result.understandingEffect, "upgrade");
    }
  });

  it("caps correct at 60 days and exposes the cap reason", () => {
    const result = calculateReviewSchedule({
      currentIntervalDays: 60,
      outcome: ReviewAttemptOutcome.CORRECT,
      hasValidServerQuestion: true,
      hasHardEvidence: true,
      now: NOW,
    });
    assert.equal(result.afterIntervalDays, 60);
    assert.equal(result.reasonCode, "correct_interval_cap");
  });
});
