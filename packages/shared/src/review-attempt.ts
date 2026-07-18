import { z } from "zod";

export const REVIEW_ATTEMPT_ANSWER_MAX_LENGTH = 10_000;
export const REVIEW_ATTEMPT_IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const REVIEW_ATTEMPT_IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const REVIEW_ATTEMPT_HISTORY_CURSOR_MAX_LENGTH = 512;

export const ReviewAttemptAnswerType = {
  RECALL: "recall",
  FREE_TEXT: "free_text",
  SELF_GRADE: "self_grade",
} as const;

export type ReviewAttemptAnswerType =
  (typeof ReviewAttemptAnswerType)[keyof typeof ReviewAttemptAnswerType];

export const ReviewAttemptOutcome = {
  CORRECT: "correct",
  PARTIAL: "partial",
  INCORRECT: "incorrect",
  UNABLE: "unable",
} as const;

export type ReviewAttemptOutcome =
  (typeof ReviewAttemptOutcome)[keyof typeof ReviewAttemptOutcome];

export const REVIEW_ATTEMPT_LATER_REASON = "later" as const;
export type ReviewAttemptLaterReason = typeof REVIEW_ATTEMPT_LATER_REASON;

export const reviewAttemptAnswerTypeSchema = z.enum([
  ReviewAttemptAnswerType.RECALL,
  ReviewAttemptAnswerType.FREE_TEXT,
  ReviewAttemptAnswerType.SELF_GRADE,
]);

export const reviewAttemptOutcomeSchema = z.enum([
  ReviewAttemptOutcome.CORRECT,
  ReviewAttemptOutcome.PARTIAL,
  ReviewAttemptOutcome.INCORRECT,
  ReviewAttemptOutcome.UNABLE,
]);

const canonicalIdempotencyKeyPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])$/;

export const reviewAttemptIdempotencyKeySchema = z
  .string()
  .min(REVIEW_ATTEMPT_IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(REVIEW_ATTEMPT_IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(canonicalIdempotencyKeyPattern, "idempotencyKey must use canonical URL-safe characters");

export const reviewAttemptAnswerSchema = z
  .string()
  .max(REVIEW_ATTEMPT_ANSWER_MAX_LENGTH)
  .refine((value) => value.trim().length > 0, {
    message: "answer cannot be blank",
  })
  .refine((value) => !value.includes("\0"), {
    message: "answer cannot contain NUL characters",
  });

export const reviewAttemptStartSchema = z
  .object({
    reviewScheduleId: z.string().uuid(),
    idempotencyKey: reviewAttemptIdempotencyKeySchema,
  })
  .strict();

export type ReviewAttemptStartInput = z.infer<typeof reviewAttemptStartSchema>;

export const reviewAttemptSubmitSchema = z
  .object({
    attemptId: z.string().uuid(),
    reviewScheduleId: z.string().uuid(),
    validationQuestionId: z.string().uuid().optional(),
    answerType: reviewAttemptAnswerTypeSchema,
    answer: reviewAttemptAnswerSchema.optional(),
    outcome: reviewAttemptOutcomeSchema,
    confidence: z.number().finite().int().min(0).max(100),
    idempotencyKey: reviewAttemptIdempotencyKeySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const needsAnswer =
      value.answerType === ReviewAttemptAnswerType.FREE_TEXT ||
      value.outcome !== ReviewAttemptOutcome.UNABLE;
    if (needsAnswer && value.answer === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["answer"],
        message: "answer is required for this answer type and outcome",
      });
    }
    const canUpgrade =
      value.outcome === ReviewAttemptOutcome.CORRECT ||
      value.outcome === ReviewAttemptOutcome.PARTIAL;
    if (canUpgrade && value.validationQuestionId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validationQuestionId"],
        message: "validationQuestionId is required for an upgrading outcome",
      });
    }
  });

export type ReviewAttemptSubmitInput = z.infer<typeof reviewAttemptSubmitSchema>;

export const reviewAttemptLaterSchema = z
  .object({
    reviewScheduleId: z.string().uuid(),
    reason: z.literal(REVIEW_ATTEMPT_LATER_REASON),
    idempotencyKey: reviewAttemptIdempotencyKeySchema,
  })
  .strict();

export type ReviewAttemptLaterInput = z.infer<typeof reviewAttemptLaterSchema>;

const reviewAttemptHistoryLimitSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return value;
    return Number(value);
  },
  z.number().int().min(1).max(100),
);

export const reviewAttemptHistoryPaginationSchema = z
  .object({
    limit: reviewAttemptHistoryLimitSchema,
    cursor: z
      .string()
      .min(1)
      .max(REVIEW_ATTEMPT_HISTORY_CURSOR_MAX_LENGTH)
      .refine((value) => !value.includes("\0"), "cursor cannot contain NUL characters")
      .optional(),
  })
  .strict();

export type ReviewAttemptHistoryPagination = z.infer<
  typeof reviewAttemptHistoryPaginationSchema
>;
