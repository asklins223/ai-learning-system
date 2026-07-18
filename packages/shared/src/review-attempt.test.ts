import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REVIEW_ATTEMPT_ANSWER_MAX_LENGTH,
  REVIEW_ATTEMPT_HISTORY_CURSOR_MAX_LENGTH,
  REVIEW_ATTEMPT_IDEMPOTENCY_KEY_MAX_LENGTH,
  REVIEW_ATTEMPT_IDEMPOTENCY_KEY_MIN_LENGTH,
  REVIEW_ATTEMPT_LATER_REASON,
  ReviewAttemptAnswerType,
  ReviewAttemptOutcome,
  reviewAttemptAnswerTypeSchema,
  reviewAttemptHistoryPaginationSchema,
  reviewAttemptIdempotencyKeySchema,
  reviewAttemptLaterSchema,
  reviewAttemptOutcomeSchema,
  reviewAttemptStartSchema,
  reviewAttemptSubmitSchema,
  type ReviewAttemptHistoryPagination,
  type ReviewAttemptLaterInput,
  type ReviewAttemptStartInput,
  type ReviewAttemptSubmitInput,
} from "./index.ts";

const SCHEDULE_ID = "123e4567-e89b-42d3-a456-426614174000";
const QUESTION_ID = "123e4567-e89b-42d3-a456-426614174001";
const ATTEMPT_ID = "123e4567-e89b-42d3-a456-426614174002";
const IDEMPOTENCY_KEY = "review-20260718-A1";

function validSubmit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: ATTEMPT_ID,
    reviewScheduleId: SCHEDULE_ID,
    validationQuestionId: QUESTION_ID,
    answerType: ReviewAttemptAnswerType.FREE_TEXT,
    answer: "I recalled the key point and explained it in my own words.",
    outcome: ReviewAttemptOutcome.CORRECT,
    confidence: 85,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

describe("review attempt contract", () => {
  it("publishes stable answer type and outcome values", () => {
    assert.deepEqual(Object.values(ReviewAttemptAnswerType), ["recall", "free_text", "self_grade"]);
    assert.deepEqual(Object.values(ReviewAttemptOutcome), ["correct", "partial", "incorrect", "unable"]);

    for (const value of Object.values(ReviewAttemptAnswerType)) {
      assert.equal(reviewAttemptAnswerTypeSchema.parse(value), value);
    }
    for (const value of Object.values(ReviewAttemptOutcome)) {
      assert.equal(reviewAttemptOutcomeSchema.parse(value), value);
    }
    assert.equal(reviewAttemptAnswerTypeSchema.safeParse("free-text").success, false);
    assert.equal(reviewAttemptOutcomeSchema.safeParse("later").success, false);
  });

  it("accepts complete submits and preserves optional answer text verbatim", () => {
    const parsed: ReviewAttemptSubmitInput = reviewAttemptSubmitSchema.parse(validSubmit({
      answer: "  A formatted recall answer.\n",
      confidence: 72,
    }));

    assert.equal(parsed.answer, "  A formatted recall answer.\n");
    assert.equal(parsed.confidence, 72);
    assert.equal(parsed.validationQuestionId, QUESTION_ID);
  });

  it("allows an unable recall to omit a question and answer", () => {
    const candidate = validSubmit({
      answerType: ReviewAttemptAnswerType.RECALL,
      outcome: ReviewAttemptOutcome.UNABLE,
    });
    delete candidate.validationQuestionId;
    delete candidate.answer;

    const parsed = reviewAttemptSubmitSchema.parse(candidate);
    assert.equal(parsed.validationQuestionId, undefined);
    assert.equal(parsed.answer, undefined);
  });

  it("rejects unknown keys for submit, later, and history inputs", () => {
    assert.equal(reviewAttemptSubmitSchema.safeParse(validSubmit({ debug: true })).success, false);
    assert.equal(reviewAttemptLaterSchema.safeParse({
      reviewScheduleId: SCHEDULE_ID,
      reason: REVIEW_ATTEMPT_LATER_REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
      debug: true,
    }).success, false);
    assert.equal(reviewAttemptStartSchema.safeParse({
      reviewScheduleId: SCHEDULE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      debug: true,
    }).success, false);
    assert.equal(reviewAttemptHistoryPaginationSchema.safeParse({ limit: 20, debug: true }).success, false);
  });

  it("rejects invalid schedule and validation question UUIDs", () => {
    for (const [field, value] of [
      ["reviewScheduleId", "schedule-1"],
      ["validationQuestionId", "question-1"],
      ["reviewScheduleId", ""],
    ] as const) {
      assert.equal(reviewAttemptSubmitSchema.safeParse(validSubmit({ [field]: value })).success, false);
    }
  });

  it("rejects blank and overlong answers while accepting the exact upper bound", () => {
    for (const answer of ["", "   ", "\n\t", "answer\0tail", "x".repeat(REVIEW_ATTEMPT_ANSWER_MAX_LENGTH + 1)]) {
      assert.equal(reviewAttemptSubmitSchema.safeParse(validSubmit({ answer })).success, false);
    }

    assert.equal(
      reviewAttemptSubmitSchema.safeParse(validSubmit({
        answer: "x".repeat(REVIEW_ATTEMPT_ANSWER_MAX_LENGTH),
      })).success,
      true,
    );
  });

  it("requires an answer for successful/incorrect results and a question for upgrades", () => {
    for (const outcome of [
      ReviewAttemptOutcome.CORRECT,
      ReviewAttemptOutcome.PARTIAL,
      ReviewAttemptOutcome.INCORRECT,
    ]) {
      assert.equal(
        reviewAttemptSubmitSchema.safeParse(validSubmit({ outcome, answer: undefined })).success,
        false,
      );
    }
    assert.equal(
      reviewAttemptSubmitSchema.safeParse(validSubmit({
        answerType: ReviewAttemptAnswerType.FREE_TEXT,
        outcome: ReviewAttemptOutcome.UNABLE,
        answer: undefined,
      })).success,
      false,
    );
    for (const outcome of [ReviewAttemptOutcome.CORRECT, ReviewAttemptOutcome.PARTIAL]) {
      assert.equal(
        reviewAttemptSubmitSchema.safeParse(validSubmit({
          outcome,
          validationQuestionId: undefined,
        })).success,
        false,
      );
    }
  });

  it("requires finite confidence in the inclusive 0-100 range", () => {
    for (const confidence of [0, 1, 50, 99, 100]) {
      assert.equal(reviewAttemptSubmitSchema.safeParse(validSubmit({ confidence })).success, true);
    }
    for (const confidence of [-0.1, 0.5, 99.9, 100.1, Number.NaN, Number.POSITIVE_INFINITY, "50", null]) {
      assert.equal(reviewAttemptSubmitSchema.safeParse(validSubmit({ confidence })).success, false);
    }
  });

  it("enforces canonical bounded idempotency keys without inventing entropy rules", () => {
    const minimumKey = "abcd1234";
    const maximumKey = "a1B2".repeat(REVIEW_ATTEMPT_IDEMPOTENCY_KEY_MAX_LENGTH / 4);

    assert.equal(minimumKey.length, REVIEW_ATTEMPT_IDEMPOTENCY_KEY_MIN_LENGTH);
    assert.equal(maximumKey.length, REVIEW_ATTEMPT_IDEMPOTENCY_KEY_MAX_LENGTH);
    assert.equal(reviewAttemptIdempotencyKeySchema.safeParse(minimumKey).success, true);
    assert.equal(reviewAttemptIdempotencyKeySchema.safeParse(maximumKey).success, true);
    assert.equal(reviewAttemptIdempotencyKeySchema.safeParse("aaaaaaaa").success, true);
    assert.equal(reviewAttemptIdempotencyKeySchema.safeParse("abababab").success, true);

    for (const key of [
      "a".repeat(REVIEW_ATTEMPT_IDEMPOTENCY_KEY_MIN_LENGTH - 1),
      "a1B2".repeat(33),
      "review key 123",
      " review-key-123",
      "review-key-123 ",
      "-reviewKey123",
      "reviewKey123-",
      "review.key.123",
      "复习-key-123",
    ]) {
      assert.equal(reviewAttemptIdempotencyKeySchema.safeParse(key).success, false, key);
    }
  });

  it("defines a strict start contract before a submit references its attempt identity", () => {
    const parsed: ReviewAttemptStartInput = reviewAttemptStartSchema.parse({
      reviewScheduleId: SCHEDULE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    assert.deepEqual(parsed, {
      reviewScheduleId: SCHEDULE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    assert.equal(reviewAttemptStartSchema.safeParse({
      reviewScheduleId: "not-a-uuid",
      idempotencyKey: IDEMPOTENCY_KEY,
    }).success, false);
  });

  it("uses a dedicated later contract with a fixed reason", () => {
    const parsed: ReviewAttemptLaterInput = reviewAttemptLaterSchema.parse({
      reviewScheduleId: SCHEDULE_ID,
      reason: REVIEW_ATTEMPT_LATER_REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    assert.equal(parsed.reason, "later");
    assert.equal(reviewAttemptLaterSchema.safeParse({ ...parsed, reason: "skip" }).success, false);
    assert.equal(reviewAttemptLaterSchema.safeParse({ ...parsed, reviewScheduleId: "not-a-uuid" }).success, false);
  });

  it("bounds history pagination and accepts an optional opaque cursor", () => {
    const firstPage: ReviewAttemptHistoryPagination = reviewAttemptHistoryPaginationSchema.parse({ limit: 1 });
    const nextPage = reviewAttemptHistoryPaginationSchema.parse({ limit: "100", cursor: "cursor-A1_2" });

    assert.deepEqual(firstPage, { limit: 1 });
    assert.deepEqual(nextPage, { limit: 100, cursor: "cursor-A1_2" });

    for (const limit of [0, 101, 1.5, "", "01", "1.5", "not-a-number", true, Number.NaN]) {
      assert.equal(reviewAttemptHistoryPaginationSchema.safeParse({ limit }).success, false);
    }
    for (const cursor of ["", "cursor\0tail", "x".repeat(REVIEW_ATTEMPT_HISTORY_CURSOR_MAX_LENGTH + 1)]) {
      assert.equal(reviewAttemptHistoryPaginationSchema.safeParse({ limit: 20, cursor }).success, false);
    }
  });
});
