import { z } from "zod";
import {
  ArtifactStatus,
  ArtifactType,
  CardStatus,
  EvidenceAlignment,
  ReviewStatus,
  ValidationOutcome,
} from "./enums.ts";

export const learningCardKeyPointSchema = z.object({
  ordinal: z.number().int().min(0),
  claim: z.string().min(1).max(500),
  quote_text: z.string().min(1).max(1000),
});

export const learningCardOutputSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(1000),
  key_points: z.array(learningCardKeyPointSchema).min(1).max(20),
});

export type LearningCardOutput = z.infer<typeof learningCardOutputSchema>;

export const evidenceAlignmentSchema = z.enum([
  EvidenceAlignment.ALIGNED,
  EvidenceAlignment.SOFT,
  EvidenceAlignment.UNALIGNED,
  EvidenceAlignment.STALE,
]);

export const cardStatusSchema = z.enum([
  CardStatus.ACTIVE,
  CardStatus.SUPERSEDED,
  CardStatus.ARCHIVED,
]);

export const validationOutcomeSchema = z.enum([
  ValidationOutcome.PRELIMINARY_UNDERSTANDING,
  ValidationOutcome.UNCLEAR_EXPRESSION,
  ValidationOutcome.MISUNDERSTANDING,
  ValidationOutcome.UNKNOWN,
]);

export const artifactStatusSchema = z.enum([
  ArtifactStatus.PENDING,
  ArtifactStatus.READY,
  ArtifactStatus.FAILED,
  ArtifactStatus.STALE,
  ArtifactStatus.DISMISSED,
  ArtifactStatus.ACCEPTED,
]);

export const artifactTypeSchema = z.enum([
  ArtifactType.LEARNING_CARD,
  ArtifactType.SUMMARY,
  ArtifactType.CODE_EXPLANATION,
  ArtifactType.PITFALL,
  ArtifactType.QUESTION,
  ArtifactType.VALIDATION_FEEDBACK,
]);

export const reviewStatusSchema = z.enum([
  ReviewStatus.PENDING,
  ReviewStatus.ACCEPTED,
  ReviewStatus.DISMISSED,
  ReviewStatus.COMPLETED,
  ReviewStatus.SUPERSEDED,
  ReviewStatus.CANCELLED,
]);

/**
 * 验证判定的 AI 输出契约（对齐产品文档 §5.8）。
 * worker 调 evaluateValidation 后必须通过此 schema 校验才写入。
 */
export const evaluateValidationOutputSchema = z.object({
  outcome: validationOutcomeSchema,
  confidence: z.number().min(0).max(1),
  feedback: z.string().min(1).max(2000),
  covered_points: z.array(z.string().min(1).max(200)).max(20).default([]),
  missing_points: z.array(z.string().min(1).max(200)).max(20).default([]),
  misunderstandings: z.array(z.string().min(1).max(200)).max(20).default([]),
  evidence_refs: z.array(z.string().min(1).max(100)).max(20).default([]),
});

export type EvaluateValidationOutput = z.infer<typeof evaluateValidationOutputSchema>;
