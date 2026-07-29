// Source states
export const SourceStatus = {
  DRAFT: "draft",
  PROCESSING: "processing",
  READY: "ready",
  FAILED: "failed",
  ARCHIVED: "archived",
} as const;
export type SourceStatus = (typeof SourceStatus)[keyof typeof SourceStatus];

// Evidence alignment states
export const EvidenceAlignment = {
  ALIGNED: "aligned", // hard evidence (>= 0.85)
  SOFT: "soft", // soft hint (0.6 - 0.85)
  UNALIGNED: "unaligned", // model quote could not be matched
  STALE: "stale_alignment", // originally aligned but source moved
} as const;
export type EvidenceAlignment = (typeof EvidenceAlignment)[keyof typeof EvidenceAlignment];

// Validation outcome states (对齐产品文档 §5.8)
export const ValidationOutcome = {
  PRELIMINARY_UNDERSTANDING: "preliminary_understanding",
  UNCLEAR_EXPRESSION: "unclear_expression",
  MISUNDERSTANDING: "misunderstanding",
  UNKNOWN: "unknown",
} as const;
export type ValidationOutcome = (typeof ValidationOutcome)[keyof typeof ValidationOutcome];

// Learning card status
export const CardStatus = {
  ACTIVE: "active",
  SUPERSEDED: "superseded",
  ARCHIVED: "archived",
} as const;
export type CardStatus = (typeof CardStatus)[keyof typeof CardStatus];

// Job status
export const JobStatus = {
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  DEAD: "dead",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

// AI Artifact status (对齐产品文档 §9.3)
export const ArtifactStatus = {
  PENDING: "pending",
  READY: "ready",
  FAILED: "failed",
  STALE: "stale",
  DISMISSED: "dismissed",
  ACCEPTED: "accepted",
} as const;
export type ArtifactStatus = (typeof ArtifactStatus)[keyof typeof ArtifactStatus];

// AI Artifact type (对齐产品文档 §5.5)
export const ArtifactType = {
  LEARNING_CARD: "learning_card",
  SUMMARY: "summary",
  CODE_EXPLANATION: "code_explanation",
  PITFALL: "pitfall",
  QUESTION: "question",
  VALIDATION_FEEDBACK: "validation_feedback",
  // v0.6: AI question generation artifact
  VALIDATION_QUESTION: "validation_question",
  // v0.6: rubric evaluation feedback (point-level)
  RUBRIC_EVALUATION: "rubric_evaluation",
  // v0.6: deterministic fallback question artifact
  DETERMINISTIC_QUESTION: "deterministic_question",
} as const;
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];

// Job types
export const JobType = {
  GENERATE_CARD: "generate_card",
  PLAN_CARD_GENERATION: "plan_card_generation",
  ANALYZE_CARD_IMAGE: "analyze_card_image",
  MAP_CARD_GENERATION: "map_card_generation",
  REDUCE_CARD_GENERATION: "reduce_card_generation",
  PLAN_CARD_SET: "plan_card_set",
  RENDER_CARD_GENERATION: "render_card_generation",
  PUBLISH_CARD_GENERATION: "publish_card_generation",
  ALIGN_EVIDENCE: "align_evidence",
  EVALUATE_VALIDATION: "evaluate_validation",
  SCHEDULE_REVIEW: "schedule_review",
  PARSE_SOURCE: "parse_source",
  GENERATE_VALIDATION_QUESTION: "generate_validation_question",
} as const;
export type JobType = (typeof JobType)[keyof typeof JobType];

// Review schedule status (对齐产品文档 §9.5)
export const ReviewStatus = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  DISMISSED: "dismissed",
  COMPLETED: "completed",
  SUPERSEDED: "superseded",
  CANCELLED: "cancelled",
} as const;
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

// ─── v0.6 enums ────────────────────────────────────────────────────────────

/** Rubric item verdict (计划 §7.2) */
export const RubricVerdict = {
  COVERED: "covered",
  PARTIAL: "partial",
  MISSING: "missing",
  CONTRADICTED: "contradicted",
  NOT_ASSESSABLE: "not_assessable",
} as const;
export type RubricVerdict = (typeof RubricVerdict)[keyof typeof RubricVerdict];

/** Assessment source (计划 §6.5) */
export const AssessmentSource = {
  AI: "ai",
  USER_DECLARED_UNABLE: "user_declared_unable",
} as const;
export type AssessmentSource = (typeof AssessmentSource)[keyof typeof AssessmentSource];

/** Validation submission status (计划 §6.4) */
export const SubmissionStatus = {
  QUESTION_PREPARING: "question_preparing",
  READY: "ready",
  ANSWER_SAVED: "answer_saved",
  EVALUATION_PENDING: "evaluation_pending",
  QUESTION_RETRYABLE: "question_retryable",
  EVALUATION_RETRYABLE: "evaluation_retryable",
  QUESTION_BLOCKED: "question_blocked",
  COMPLETED: "completed",
  STALE: "stale",
  ABANDONED: "abandoned",
} as const;
export type SubmissionStatus = (typeof SubmissionStatus)[keyof typeof SubmissionStatus];

/** Validation question status (计划 §6.2) */
export const QuestionStatus = {
  ACTIVE: "active",
  STALE: "stale",
  SUPERSEDED: "superseded",
  EXPIRED: "expired",
  LEGACY_UNRUBRICED: "legacy_unrubriced",
} as const;
export type QuestionStatus = (typeof QuestionStatus)[keyof typeof QuestionStatus];

/** Question generator kind (计划 §6.2) */
export const GeneratorKind = {
  AI: "ai",
  DETERMINISTIC: "deterministic",
} as const;
export type GeneratorKind = (typeof GeneratorKind)[keyof typeof GeneratorKind];

/** Validation submission context (计划 §6.4) */
export const SubmissionContext = {
  INITIAL_VALIDATION: "initial_validation",
  REVIEW: "review",
} as const;
export type SubmissionContext = (typeof SubmissionContext)[keyof typeof SubmissionContext];

/** Assistance level (计划 §6.4) */
export const AssistanceLevel = {
  NONE: "none",
  SOURCE_VIEWED: "source_viewed",
} as const;
export type AssistanceLevel = (typeof AssistanceLevel)[keyof typeof AssistanceLevel];

/** Exposure kind (计划 §6.4.2) */
export const ExposureKind = {
  PRE_SUBMIT_SOURCE: "pre_submit_source",
  POST_RESULT_FEEDBACK: "post_result_feedback",
} as const;
export type ExposureKind = (typeof ExposureKind)[keyof typeof ExposureKind];

/** Card repair state (计划 §7.7) */
export const CardRepairState = {
  NONE: "none",
  CLAIMED: "claimed",
  COMPLETED: "completed",
} as const;
export type CardRepairState = (typeof CardRepairState)[keyof typeof CardRepairState];

/** Card repair reason code (计划 §7.7) */
export const CardRepairReasonCode = {
  QUOTE_NOT_IN_SOURCE: "quote_not_in_source",
  CLAIM_TOO_SHORT: "claim_too_short",
  CLAIM_VAGUE: "claim_vague",
  CLAIM_QUOTE_UNRELATED: "claim_quote_unrelated",
  CLAIM_QUOTE_TOO_SIMILAR: "claim_quote_too_similar",
  DUPLICATE_KEY_POINT: "duplicate_key_point",
  INSUFFICIENT_VALID_KEY_POINTS: "insufficient_valid_key_points",
  COVERAGE_TOO_LOW: "coverage_too_low",
  SCHEMA_INVALID_BOUNDED: "schema_invalid_bounded",
  SCHEMA_UNPARSEABLE: "schema_unparseable",
} as const;
export type CardRepairReasonCode =
  (typeof CardRepairReasonCode)[keyof typeof CardRepairReasonCode];

/** Scheduling policy version */
export const SchedulingPolicyVersion = {
  DISCRETE_V1: "discrete-v1",
  DISCRETE_V2: "discrete-v2",
} as const;
export type SchedulingPolicyVersion =
  (typeof SchedulingPolicyVersion)[keyof typeof SchedulingPolicyVersion];

/** Submission terminal reason (计划 §6.4) */
export const TerminalReason = {
  USER_ABANDON: "user_abandon",
  LATER: "later",
  SOURCE_STALE: "source_stale",
  UNSAFE_FALLBACK: "unsafe_fallback",
} as const;
export type TerminalReason = (typeof TerminalReason)[keyof typeof TerminalReason];

/** Question type (formalised for v0.6) */
export const QuestionType = {
  EXPLAIN: "explain",
  EXAMPLE: "example",
  APPLY: "apply",
} as const;
export type QuestionType = (typeof QuestionType)[keyof typeof QuestionType];

/** Question safety reason code */
export const QuestionSafetyReasonCode = {
  LEAKS_CLAIM: "leaks_claim",
  LEAKS_QUOTE: "leaks_quote",
  LEAKS_EXPECTED_CONCEPT: "leaks_expected_concept",
  PROMPT_INJECTION: "prompt_injection",
  INVALID_TYPE: "invalid_type",
  LENGTH_BOUNDARY: "length_boundary",
  INVALID_EVIDENCE_REF: "invalid_evidence_ref",
} as const;
export type QuestionSafetyReasonCode =
  (typeof QuestionSafetyReasonCode)[keyof typeof QuestionSafetyReasonCode];

/** Quality signal reason (计划 §8.4 Should) */
export const QualitySignalReason = {
  QUESTION_BAD: "question_bad",
  TOO_STRICT: "too_strict",
  TOO_LENIENT: "too_lenient",
  RUBRIC_BAD: "rubric_bad",
  EVIDENCE_BAD: "evidence_bad",
} as const;
export type QualitySignalReason =
  (typeof QualitySignalReason)[keyof typeof QualitySignalReason];

// ─── Learning-card generation engine v2 ───────────────────────────────────

/** Business-level generation run state (not the execution job state). */
export const CardGenerationRunStatus = {
  QUEUED: "queued",
  PLANNING: "planning",
  AWAITING_ASSETS: "awaiting_assets",
  MAPPING: "mapping",
  REDUCING: "reducing",
  RENDERING: "rendering",
  VALIDATING: "validating",
  PUBLISHING: "publishing",
  NEEDS_ATTENTION: "needs_attention",
  PARTIAL_READY: "partial_ready",
  SUCCEEDED: "succeeded",
  CANCELLED: "cancelled",
  SUPERSEDED: "superseded",
} as const;
export type CardGenerationRunStatus =
  (typeof CardGenerationRunStatus)[keyof typeof CardGenerationRunStatus];

/** Stable, user-visible stages used by progress events and recovery APIs. */
export const CardGenerationStage = {
  QUEUED: "queued",
  SNAPSHOT: "snapshot",
  PLANNER: "planner",
  IMAGE_ANALYSIS: "image_analysis",
  TEXT_MAP: "text_map",
  SECTION_REDUCE: "section_reduce",
  DECK_PLAN: "deck_plan",
  CARD_RENDER: "card_render",
  GLOBAL_VERIFY: "global_verify",
  PUBLISH: "publish",
  LEGACY_GENERATE: "legacy_generate",
  COMPLETE: "complete",
} as const;
export type CardGenerationStage =
  (typeof CardGenerationStage)[keyof typeof CardGenerationStage];

/** Checkpoint kinds persisted independently from queue jobs. */
export const CardGenerationUnitKind = {
  PLANNER: "planner",
  IMAGE: "image",
  TEXT_MAP: "text_map",
  SECTION_REDUCE: "section_reduce",
  DECK_PLAN: "deck_plan",
  CARD_RENDER: "card_render",
  VERIFY: "verify",
  PUBLISH: "publish",
} as const;
export type CardGenerationUnitKind =
  (typeof CardGenerationUnitKind)[keyof typeof CardGenerationUnitKind];

export const JobResourceClass = {
  INTERACTIVE_AI: "interactive_ai",
  CARD_FOREGROUND: "card_foreground",
  CARD_MAP: "card_map",
  VISION: "vision",
  MAINTENANCE: "maintenance",
} as const;
export type JobResourceClass =
  (typeof JobResourceClass)[keyof typeof JobResourceClass];
