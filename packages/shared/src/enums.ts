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
} as const;
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType];

// Job types
export const JobType = {
  PARSE_SOURCE: "parse_source",
  // Companion Agent v1：日常对话与受控工具 loop（03 §8.1）
  COMPANION_AGENT: "companion_agent",
  // 22 真桌宠记忆与上下文：日常对话记忆提取 / 会话摘要 / 每日总结 / embedding 重建
  COMPANION_MEMORY_EXTRACT: "companion_memory_extract",
  COMPANION_SUMMARIZER: "companion_summarizer",
  COMPANION_DAILY_SUMMARY: "companion_daily_summary",
  COMPANION_MEMORY_EMBEDDING_REBUILD: "companion_memory_embedding_rebuild",
  // 基础主动念头调度；LLM 只增强措辞，不改变 job 合同与可降级语义。
  COMPANION_THOUGHT: "companion_thought",
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

// ─── Learning-card generation engine ──────────────────────────────────────

export const JobResourceClass = {
  INTERACTIVE_AI: "interactive_ai",
  CARD_FOREGROUND: "card_foreground",
  CARD_MAP: "card_map",
  VISION: "vision",
  MAINTENANCE: "maintenance",
} as const;
export type JobResourceClass =
  (typeof JobResourceClass)[keyof typeof JobResourceClass];
