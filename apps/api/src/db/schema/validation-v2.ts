/**
 * v0.6 Schema: 可信掌握闭环 (计划 §6)
 *
 * 新增表：
 * - validation_question_rubric_items (§6.3)
 * - validation_submissions (§6.4)
 * - validation_submission_jobs (§6.4)
 * - validation_action_commands (§6.4.1)
 * - validation_assistance_exposures (§6.4.2)
 * - validation_point_assessments (§6.5)
 * - scheduling_shadow_decisions (§6.8)
 * - validation_quality_signals (§8.4 Should)
 *
 * 现有表扩展在 migration 0040 中通过 ALTER TABLE 实现。
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";
import { validationQuestions, validationEvents } from "./evidence.ts";
import { evidences } from "./evidence.ts";

// ─── §6.3 validation_question_rubric_items ────────────────────────────────

/**
 * AI 题目使用 2～5 个 rubric item；确定性 fallback 允许 1 个 required item。
 * expected_concept 提交前不返回客户端。
 */
export const validationQuestionRubricItems = pgTable(
  "validation_question_rubric_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    questionId: uuid("question_id").notNull().references(() => validationQuestions.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    criterion: text("criterion").notNull(),
    expectedConcept: text("expected_concept").notNull(),
    weight: integer("weight").notNull().default(1), // 1 | 2 | 3
    required: boolean("required").notNull().default(true),
    evidenceId: uuid("evidence_id").references(() => evidences.id, { onDelete: "set null" }),
    evidenceSnapshot: jsonb("evidence_snapshot").$type<{
      noteVersionId?: string;
      blockId?: string;
      quote?: string;
      alignment?: string;
      userOverride?: string;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    questionIdx: index("vq_rubric_items_question_idx").on(t.questionId, t.ordinal),
    workspaceIdx: index("vq_rubric_items_workspace_idx").on(t.workspaceId),
    uniqueQuestionOrdinal: uniqueIndex("vq_rubric_items_unique_ordinal_idx").on(t.questionId, t.ordinal),
  }),
);

// ─── §6.4 validation_submissions ──────────────────────────────────────────

/**
 * 保存首次验证和 Review AI 评估的进行中事实。
 * status: question_preparing | ready | answer_saved | evaluation_pending |
 *         question_retryable | evaluation_retryable | question_blocked |
 *         completed | stale | abandoned
 */
export const validationSubmissions = pgTable(
  "validation_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // V1 card/keyPoint references removed
    questionId: uuid("question_id"), // nullable until ready/answer_saved
    context: text("context").notNull(), // initial_validation | review
    reviewAttemptId: uuid("review_attempt_id"), // review context only
    inputScheduleId: uuid("input_schedule_id"), // review context only
    userAnswer: text("user_answer"),
    selfConfidence: integer("self_confidence"), // 1 | 2 | 3, nullable
    draftRevision: integer("draft_revision").notNull().default(0),
    answerHash: text("answer_hash"),
    answerLockedAt: timestamp("answer_locked_at", { withTimezone: true }),
    assistanceSnapshotExposedAt: timestamp("assistance_snapshot_exposed_at", { withTimezone: true }),
    assistanceLevel: text("assistance_level").notNull().default("none"), // none | source_viewed
    evidenceRevealedAt: timestamp("evidence_revealed_at", { withTimezone: true }),
    sourceFingerprint: text("source_fingerprint"),
    status: text("status").notNull().default("question_preparing"),
    currentGenerationJobId: uuid("current_generation_job_id"),
    currentEvaluationJobId: uuid("current_evaluation_job_id"),
    validationEventId: uuid("validation_event_id"),
    failureStage: text("failure_stage"),
    failureCode: text("failure_code"),
    terminalReason: text("terminal_reason"),
    startIdempotencyKey: text("start_idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    startIdempotencyUniqueIdx: uniqueIndex("val_submissions_start_idem_idx").on(
      t.workspaceId, t.userId, t.startIdempotencyKey,
    ),
    reviewAttemptIdx: index("val_submissions_review_attempt_idx").on(t.reviewAttemptId),
    statusIdx: index("val_submissions_status_idx").on(t.workspaceId, t.userId, t.status),
    // V1 keyPoint-based unique index removed
  }),
);

// ─── §6.4 validation_submission_jobs ──────────────────────────────────────

/**
 * 保存全部 job lineage，同一去重后的 question generation job 可以绑定多个
 * 等待它的 submission。
 */
export const validationSubmissionJobs = pgTable(
  "validation_submission_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id").notNull().references(() => validationSubmissions.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(), // question_generation | evaluation
    phaseOrdinal: integer("phase_ordinal").notNull().default(1),
    jobId: uuid("job_id").notNull(),
    retryOfJobId: uuid("retry_of_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniquePhase: uniqueIndex("val_sub_jobs_phase_idx").on(t.submissionId, t.phase, t.phaseOrdinal),
    uniqueJob: uniqueIndex("val_sub_jobs_job_idx").on(t.submissionId, t.jobId),
  }),
);

// ─── §6.4.1 validation_action_commands ────────────────────────────────────

/**
 * Action 级幂等账本。start、draft、source/result reveal、submit、unable、
 * retry、later 和 abandon 都必须先查该账本。
 */
export const validationActionCommands = pgTable(
  "validation_action_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id"), // nullable
    action: text("action").notNull(), // start | draft | source_reveal | result_reveal | submit | unable | retry | later | abandon
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: text("response_status").notNull().default("pending"), // pending | success | error
    responseSnapshot: jsonb("response_snapshot").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueActionIdem: uniqueIndex("val_action_cmd_unique_idx").on(
      t.workspaceId, t.userId, t.action, t.idempotencyKey,
    ),
  }),
);

// ─── §6.4.2 validation_assistance_exposures ───────────────────────────────

/**
 * User-private assistance 暴露账本。
 * 逐次审计事实保留在 action command，聚合行只做单调冷却门禁。
 */
export const validationAssistanceExposures = pgTable(
  "validation_assistance_exposures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // V1 keyPoint reference removed
    exposureFingerprint: text("exposure_fingerprint").notNull(),
    lastExposureKind: text("last_exposure_kind").notNull(), // pre_submit_source | post_result_feedback
    firstExposedAt: timestamp("first_exposed_at", { withTimezone: true }).notNull(),
    lastExposedAt: timestamp("last_exposed_at", { withTimezone: true }).notNull(),
    unassistedEligibleAfter: timestamp("unassisted_eligible_after", { withTimezone: true }).notNull(),
    lastOriginSubmissionId: uuid("last_origin_submission_id"),
    inputScheduleId: uuid("input_schedule_id"), // nullable
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueExposure: uniqueIndex("val_assist_exp_unique_idx").on(
      t.workspaceId, t.userId, t.exposureFingerprint,
    ),
    workspaceUserIdx: index("val_assist_exp_workspace_user_idx").on(t.workspaceId, t.userId),
  }),
);

// ─── §6.5 validation_point_assessments ────────────────────────────────────

/**
 * 逐点 rubric 评估结果。
 * 唯一键 (submission_id, rubric_item_id)。
 */
export const validationPointAssessments = pgTable(
  "validation_point_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id").notNull().references(() => validationSubmissions.id, { onDelete: "cascade" }),
    rubricItemId: uuid("rubric_item_id").notNull().references(() => validationQuestionRubricItems.id, { onDelete: "cascade" }),
    verdict: text("verdict").notNull(), // covered | partial | missing | contradicted | not_assessable
    assessmentSource: text("assessment_source").notNull(), // ai | user_declared_unable
    confidence: integer("confidence"), // 0-100
    rationale: text("rationale"),
    answerExcerpt: text("answer_excerpt"),
    evidenceSnapshot: jsonb("evidence_snapshot").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueSubmissionRubric: uniqueIndex("val_point_assess_unique_idx").on(t.submissionId, t.rubricItemId),
    submissionIdx: index("val_point_assess_sub_idx").on(t.submissionId),
    userWorkspaceIdx: index("val_point_assess_u_w_idx").on(t.userId, t.workspaceId),
  }),
);

// ─── §6.8 scheduling_shadow_decisions ─────────────────────────────────────

/**
 * FSRS shadow 数据（append-only）。
 * 该表不能被正式 review 查询用于决定 due 状态。
 */
export const schedulingShadowDecisions = pgTable(
  "scheduling_shadow_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // V1 keyPoint reference removed
    sourceType: text("source_type").notNull(), // validation_event | review_attempt
    sourceId: uuid("source_id").notNull(),
    algorithm: text("algorithm").notNull(), // fsrs
    algorithmVersion: text("algorithm_version").notNull(),
    parametersVersion: text("parameters_version").notNull(),
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>(),
    predictedDueAt: timestamp("predicted_due_at", { withTimezone: true }).notNull(),
    stability: jsonb("stability"), // FSRS stability value
    difficulty: jsonb("difficulty"), // FSRS difficulty value
    retrievability: jsonb("retrievability"), // FSRS retrievability value
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueShadow: uniqueIndex("sched_shadow_unique_idx").on(
      t.sourceType, t.sourceId, t.algorithm, t.parametersVersion,
    ),
    userIdx: index("sched_shadow_user_idx").on(t.userId),
  }),
);

// ─── §8.4 validation_quality_signals (Should) ─────────────────────────────

/**
 * User-private quality signal for validation events (计划 §8.4 Should).
 * v0.6 只保存 user-private 信号、关联版本并避免有争议结果继续被当作高可信样本；
 * 完整分流、修正提案和处理后台进入 v0.7。
 */
export const validationQualitySignals = pgTable(
  "validation_quality_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    validationEventId: uuid("validation_event_id").notNull().references(() => validationEvents.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id"), // optional link to v0.6 submission
    reason: text("reason").notNull(), // question_bad | too_strict | too_lenient | rubric_bad | evidence_bad
    comment: text("comment"),
    // Version tracking for auditability (计划 §8.4: "关联版本")
    sourceFingerprint: text("source_fingerprint"),
    rubricVersion: text("rubric_version"),
    reducerVersion: text("reducer_version"),
    policyVersion: text("policy_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    eventIdx: index("val_quality_sig_event_idx").on(t.validationEventId),
    userEventIdx: index("val_quality_sig_user_event_idx").on(t.userId, t.validationEventId),
  }),
);
