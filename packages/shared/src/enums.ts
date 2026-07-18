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
} as const;
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];

// Job types
export const JobType = {
  GENERATE_CARD: "generate_card",
  ALIGN_EVIDENCE: "align_evidence",
  EVALUATE_VALIDATION: "evaluate_validation",
  SCHEDULE_REVIEW: "schedule_review",
  PARSE_SOURCE: "parse_source",
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

