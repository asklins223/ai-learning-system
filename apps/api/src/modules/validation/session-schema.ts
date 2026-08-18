/**
 * v0.6 Validation Session API schemas (计划 §8.2)
 *
 * All mutation endpoints require an idempotencyKey for action command replay.
 * The submit/draft endpoints use baseRevision for optimistic concurrency.
 */
import { z } from "zod";

// ─── Start ───────────────────────────────────────────────────────────────

export const startSessionSchema = z.object({
  objectiveId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(128),
  // v0.6 review context (计划 §8.3): when context="review", the session is
  // started from a review schedule. The server selects the key point from the
  // schedule, creates/resumes a review attempt, and links the submission.
  context: z.enum(["initial_validation", "review"]).optional(),
  reviewScheduleId: z.string().uuid().optional(),
}).refine(
  (data) => {
    // If context is review, reviewScheduleId is required.
    // If context is initial_validation (or absent), reviewScheduleId must be absent.
    if (data.context === "review") return !!data.reviewScheduleId;
    return !data.reviewScheduleId;
  },
  { message: "reviewScheduleId is required when context=review and must be absent otherwise" },
);
export type StartSessionInput = z.infer<typeof startSessionSchema>;

// ─── Get (no body) ───────────────────────────────────────────────────────

// ─── Draft ───────────────────────────────────────────────────────────────

export const draftAnswerSchema = z.object({
  answer: z.string().min(1).max(10_000),
  selfConfidence: z.number().int().min(1).max(3).optional(),
  baseRevision: z.number().int().min(0),
  idempotencyKey: z.string().min(1).max(128),
});
export type DraftAnswerInput = z.infer<typeof draftAnswerSchema>;

// ─── Reveal Source ───────────────────────────────────────────────────────

export const revealSourceSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
});
export type RevealSourceInput = z.infer<typeof revealSourceSchema>;

// ─── Reveal Result ───────────────────────────────────────────────────────

export const revealResultSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
});
export type RevealResultInput = z.infer<typeof revealResultSchema>;

// ─── Submit ──────────────────────────────────────────────────────────────

export const submitAnswerSchema = z.object({
  answer: z.string().min(1).max(10_000),
  selfConfidence: z.number().int().min(1).max(3).optional(),
  baseRevision: z.number().int().min(0),
  idempotencyKey: z.string().min(1).max(128),
});
export type SubmitAnswerInput = z.infer<typeof submitAnswerSchema>;

// ─── Unable ──────────────────────────────────────────────────────────────

export const unableSchema = z.object({
  baseRevision: z.number().int().min(0),
  idempotencyKey: z.string().min(1).max(128),
});
export type UnableInput = z.infer<typeof unableSchema>;

// ─── Retry Question ──────────────────────────────────────────────────────

export const retryQuestionSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
});
export type RetryQuestionInput = z.infer<typeof retryQuestionSchema>;

// ─── Retry Evaluation ────────────────────────────────────────────────────

export const retryEvaluationSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
});
export type RetryEvaluationInput = z.infer<typeof retryEvaluationSchema>;

// ─── Abandon ─────────────────────────────────────────────────────────────

export const abandonSchema = z.object({
  idempotencyKey: z.string().min(1).max(128),
});
export type AbandonInput = z.infer<typeof abandonSchema>;

// ─── Quality Signal (计划 §8.4 Should) ────────────────────────────────────

export const qualitySignalSchema = z.object({
  reason: z.enum([
    "question_bad",
    "too_strict",
    "too_lenient",
    "rubric_bad",
    "evidence_bad",
  ]),
  comment: z.string().min(1).max(2_000).optional(),
});
export type QualitySignalInput = z.infer<typeof qualitySignalSchema>;
