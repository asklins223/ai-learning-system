import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { evidenceAlignmentEnum, validationOutcomeEnum, reviewStatusEnum } from "./enums.ts";
import { cardKeyPoints } from "./card.ts";
import { noteBlocks, noteImageAssets } from "./note.ts";
import { learningCards } from "./card.ts";
import { aiArtifacts } from "./ai.ts";
import { users } from "./identity.ts";
import { noteEvidenceSpans, noteImageEvidenceUnits, noteImageInsights } from "./card-generation.ts";
import type { ValidationFeedback } from "@ailearn/shared";

export const evidences = pgTable(
  "evidences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    keyPointId: uuid("key_point_id").notNull().references(() => cardKeyPoints.id, { onDelete: "cascade" }),
    blockId: uuid("block_id").references(() => noteBlocks.id, { onDelete: "set null" }),
    blockOrdinal: integer("block_ordinal"),
    quoteText: text("quote_text").notNull(),
    alignment: evidenceAlignmentEnum("alignment").notNull().default("unaligned"),
    alignmentScore: integer("alignment_score").notNull().default(0), // store 0-100
    alignmentMethod: text("alignment_method").notNull().default("fuzzy"), // embedding | fuzzy | exact | manual
    evidenceSpanId: uuid("evidence_span_id").references(() => noteEvidenceSpans.id, { onDelete: "set null" }),
    sourceKind: text("source_kind"),
    charStart: integer("char_start"),
    charEnd: integer("char_end"),
    sourceHash: text("source_hash"),
    imageAssetId: uuid("image_asset_id").references(() => noteImageAssets.id, { onDelete: "set null" }),
    imageInsightId: uuid("image_insight_id").references(() => noteImageInsights.id, { onDelete: "set null" }),
    imageEvidenceUnitId: uuid("image_evidence_unit_id").references(() => noteImageEvidenceUnits.id, { onDelete: "set null" }),
    regionJson: jsonb("region_json").$type<{ x: number; y: number; width: number; height: number; page?: number } | null>(),
    extractorVersion: text("extractor_version"),
    userOverride: text("user_override"), // confirmed | downgraded | rejected — 保留向后兼容，新逻辑使用 evidence_overrides 表
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    keyPointIdx: index("evidences_key_point_idx").on(t.keyPointId),
    blockIdx: index("evidences_block_idx").on(t.blockId),
    workspaceIdx: index("evidences_workspace_idx").on(t.workspaceId),
    evidenceSpanIdx: index("evidences_span_idx").on(t.workspaceId, t.evidenceSpanId),
    imageEvidenceIdx: index("evidences_image_evidence_idx").on(t.workspaceId, t.imageEvidenceUnitId),

    idWorkspaceUnique: uniqueIndex("evidences_id_workspace_unique").on(t.id, t.workspaceId),}),
);

/**
 * N-005: 用户级证据覆盖表。
 * 替代 evidences.userOverride 字段，每个用户对同一证据有独立的 override，
 * 不再全工作区共享 last-write-wins。
 */
export const evidenceOverrides = pgTable(
  "evidence_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    evidenceId: uuid("evidence_id").notNull().references(() => evidences.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    override: text("override").notNull(), // confirmed | downgraded | rejected
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueEvidenceUser: uniqueIndex("evidence_overrides_unique_idx").on(t.evidenceId, t.userId),
    workspaceIdx: index("evidence_overrides_workspace_idx").on(t.workspaceId),

    idWorkspaceUnique: uniqueIndex("evidence_overrides_id_workspace_unique").on(t.id, t.workspaceId),}),
);

/**
 * N-003: 服务端持久化验证题。
 * 题目由服务端生成和存储，绑定 card/keyPoint/noteVersion，
 * 客户端只提交 questionId + answer + idempotencyKey。
 */
export const validationQuestions = pgTable(
  "validation_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    cardId: uuid("card_id").notNull().references(() => learningCards.id, { onDelete: "cascade" }),
    keyPointId: uuid("key_point_id").references(() => cardKeyPoints.id, { onDelete: "set null" }),
    noteVersionId: uuid("note_version_id"),
    questionType: text("question_type").notNull(), // explain | example | apply
    question: text("question").notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // ── v0.6 扩展 (计划 §6.2) ──
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }), // 问题按学习者及其 evidence override 隔离
    artifactId: uuid("artifact_id").references(() => aiArtifacts.id, { onDelete: "set null" }),
    generationJobId: uuid("generation_job_id"),
    generatorKind: text("generator_kind").notNull().default("ai"), // ai | deterministic
    status: text("status").notNull().default("active"), // active | stale | superseded | expired | legacy_unrubriced
    rubricVersion: text("rubric_version"),
    sourceFingerprint: text("source_fingerprint"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    staleReason: text("stale_reason"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    useCount: integer("use_count").notNull().default(0),
  },
  (t) => ({
    cardIdx: index("validation_questions_card_idx").on(t.cardId),
    workspaceIdx: index("validation_questions_workspace_idx").on(t.workspaceId),
    keyPointIdx: index("validation_questions_key_point_idx").on(t.keyPointId),
    // v0.6: 每个 (workspace,user,key_point,source_fingerprint) 最多一条 active question
    userKeyPointIdx: index("validation_questions_user_kp_idx").on(t.userId, t.keyPointId, t.status),
    // §6.2: 每个 (workspace,user,key_point,source_fingerprint) 最多一条 active question
    activeUniqueIdx: uniqueIndex("validation_questions_active_unique_idx")
      .on(t.workspaceId, t.userId, t.keyPointId, t.sourceFingerprint)
      .where(sql`${t.status} = 'active' AND ${t.userId} IS NOT NULL AND ${t.keyPointId} IS NOT NULL AND ${t.sourceFingerprint} IS NOT NULL`),

    idWorkspaceUnique: uniqueIndex("validation_questions_id_workspace_unique").on(t.id, t.workspaceId),}),
);

/**
 * 理解验证记录（对齐产品文档 §5.8）。
 * 每次用户提交验证答案后写入一条，关联到具体 keyPoint 和 AI 评估 artifact。
 * N-003: 新增 questionId（绑定服务端持久化的题目）和 jobId（绑定异步结果身份）。
 */
export const validationEvents = pgTable(
  "validation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    cardId: uuid("card_id").notNull().references(() => learningCards.id, { onDelete: "cascade" }),
    keyPointId: uuid("key_point_id").references(() => cardKeyPoints.id, { onDelete: "set null" }),
    artifactId: uuid("artifact_id").references(() => aiArtifacts.id, { onDelete: "set null" }),
    question: text("question").notNull(),
    questionType: text("question_type").notNull(), // explain | example | apply
    userAnswer: text("user_answer").notNull(),
    outcome: validationOutcomeEnum("outcome").notNull(),
    confidence: integer("confidence").notNull(), // 0-100，存储时 ×100 避免浮点
    feedback: jsonb("feedback").$type<ValidationFeedback | null>(),
    // N-003: 绑定服务端持久化的题目和异步 job
    questionId: uuid("question_id").references(() => validationQuestions.id, { onDelete: "set null" }), // 0011:19 FK
    jobId: uuid("job_id"), // 绑定 evaluate_validation job
    // ── v0.6 扩展 (计划 §6.6) ──
    submissionId: uuid("submission_id"),
    noteVersionId: uuid("note_version_id"), // v0.6 显式 note version
    rubricVersion: text("rubric_version"),
    reducerVersion: text("reducer_version"),
    sourceFingerprint: text("source_fingerprint"),
    sourceStatus: text("source_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    cardIdx: index("validation_events_card_idx").on(t.cardId),
    userIdx: index("validation_events_user_idx").on(t.userId, t.createdAt),
    // 2026-08-12（schema 完整性审计）：0114 workspace 前缀聚合索引
    // （迁移定义 (workspace_id, created_at DESC)——DESC 与 note/card 同款）
    workspaceCreatedIdx: index("validation_events_workspace_created_idx")
      .on(t.workspaceId, sql`${t.createdAt} desc`),
    keyPointIdx: index("validation_events_key_point_idx").on(t.keyPointId),
    jobUniqueIdx: uniqueIndex("validation_events_job_unique_idx")
      .on(t.jobId)
      .where(sql`${t.jobId} IS NOT NULL`),
    // 并发安全兜底：防止相同输入组合的重复写入（advisory lock 的数据库层面兜底）
    inputUniqueIdx: uniqueIndex("validation_events_input_unique_idx")
      .on(t.workspaceId, t.cardId, sql`COALESCE(${t.keyPointId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.userId, t.question, t.userAnswer),

    idWorkspaceUnique: uniqueIndex("validation_events_id_workspace_unique").on(t.id, t.workspaceId),}),
);

/**
 * 复习计划（对齐产品文档 §9.5）。
 * 由 validation_events 的 outcome 驱动生成，按离散档位调度下次复习时间。
 */
export const reviewSchedules = pgTable(
  "review_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(), // card | validation
    subjectId: uuid("subject_id").notNull(),
    validationEventId: uuid("validation_event_id").references(() => validationEvents.id, { onDelete: "set null" }),
    status: reviewStatusEnum("status").notNull().default("pending"),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }).notNull(),
    intervalDays: integer("interval_days").notNull().default(1),
    lastReviewAt: timestamp("last_review_at", { withTimezone: true }),
    // ── v0.6 扩展 (计划 §6.6) ──
    keyPointId: uuid("key_point_id").references(() => cardKeyPoints.id, { onDelete: "set null" }),
    generation: integer("generation").notNull().default(0),
    policyVersion: text("policy_version"), // discrete-v2
    reasonCode: text("reason_code"),
    supersedesScheduleId: uuid("supersedes_schedule_id"),
    // 方案 16 §18.1 defer_review：用户队列"展示层延后"（不改 official
    // next_review_at、不消费 schedule、不创建 successor；仅队列 UI 展示）。
    userDeferredUntil: timestamp("user_deferred_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // CONC-10: updatedAt 记录最近一次 status 变更时间。
    // deleteNote 取消计划时设为 deletedAt，restoreDeletedNote 恢复时
    // 用 updatedAt = deletedAt 精确匹配，避免误恢复之前手动取消的计划。
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    subjectIdx: index("review_schedules_subject_idx").on(t.subjectType, t.subjectId),
    nextIdx: index("review_schedules_next_idx").on(t.nextReviewAt, t.status),
    userStatusIdx: index("review_schedules_user_status_idx").on(t.userId, t.status, t.nextReviewAt),
    // v0.6: key point based scheduling
    keyPointIdx: index("review_schedules_key_point_idx").on(t.keyPointId, t.status, t.nextReviewAt),
    // 2026-08-12（schema 完整性审计）：0114 listDue 高频路径索引（workspace 前缀）
    workspaceStatusNextIdx: index("review_schedules_workspace_status_next_idx")
      .on(t.workspaceId, t.status, t.nextReviewAt),
    // §10.6: 每个 (workspace,user,key_point) 最多一条 pending schedule
    pendingUniqueIdx: uniqueIndex("review_schedules_pending_unique_idx")
      .on(t.workspaceId, t.userId, t.keyPointId)
      .where(sql`${t.status} = 'pending' AND ${t.keyPointId} IS NOT NULL`),

    idWorkspaceUnique: uniqueIndex("review_schedules_id_workspace_unique").on(t.id, t.workspaceId),}),
);

/**
 * LOOP-01 / LOOP-02: Review attempt (ADR-0004).
 *
 * Every review completion produces one auditable row.  Version references are
 * nullable because "later" and "unable" attempts may not carry a full
 * question/evidence snapshot.  answer_text is nullable because recall and
 * self_grade outcomes may omit free text.  The (workspace_id, user_id,
 * idempotency_key) unique index is the idempotency boundary.
 */
export const reviewAttempts = pgTable(
  "review_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    reviewScheduleId: uuid("review_schedule_id").notNull().references(() => reviewSchedules.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    validationEventId: uuid("validation_event_id").references(() => validationEvents.id, { onDelete: "set null" }),
    validationQuestionId: uuid("validation_question_id"),
    keyPointId: uuid("key_point_id").references(() => cardKeyPoints.id, { onDelete: "set null" }),
    evidenceId: uuid("evidence_id").references(() => evidences.id, { onDelete: "set null" }),
    noteVersionId: uuid("note_version_id"),
    answerType: text("answer_type"),
    answerText: text("answer_text"),
    outcome: text("outcome"),
    confidence: integer("confidence"),
    skipReason: text("skip_reason"),
    scheduleBeforeIntervalDays: integer("schedule_before_interval_days"),
    scheduleAfterIntervalDays: integer("schedule_after_interval_days"),
    scheduleReasonCode: text("schedule_reason_code"),
    understandingEffect: text("understanding_effect"),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    // V05-RISK-05: persist the next schedule ID created by submit, so
    // historical attempts can trace their successor schedule across generations.
    nextScheduleId: uuid("next_schedule_id").references(() => reviewSchedules.id, { onDelete: "set null" }),
    // ── v0.6 扩展 (计划 §6.6) ──
    evaluationArtifactId: uuid("evaluation_artifact_id").references(() => aiArtifacts.id, { onDelete: "set null" }),
    evaluationStatus: text("evaluation_status"),
    assistanceLevel: text("assistance_level"), // none | source_viewed
    evidenceRevealedAt: timestamp("evidence_revealed_at", { withTimezone: true }),
    policyVersion: text("policy_version"), // discrete-v2
    sourceFingerprint: text("source_fingerprint"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("started"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // V05-RISK-04: record when a started attempt was abandoned (user cancel,
    // auto-abandon on new start, or stale cleanup).
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceUserCreatedIdx: index("review_attempts_workspace_user_created_idx").on(
      t.workspaceId, t.userId, t.createdAt, t.id,
    ),
    scheduleIdx: index("review_attempts_schedule_idx").on(t.reviewScheduleId, t.createdAt),
    subjectIdx: index("review_attempts_subject_idx").on(
      t.workspaceId, t.subjectType, t.subjectId, t.createdAt,
    ),
    idempotencyUniqueIdx: uniqueIndex("review_attempts_idempotency_unique_idx").on(
      t.workspaceId, t.userId, t.idempotencyKey,
    ),
    // V05-RISK-04: at most one 'started' attempt per (workspace, user, schedule).
    activeStartedUniqueIdx: uniqueIndex("review_attempts_active_started_unique_idx").on(
      t.workspaceId, t.userId, t.reviewScheduleId,
    ).where(sql`${t.status} = 'started'`),

    activeScheduleIdx: index("review_attempts_active_schedule_idx").on(t.workspaceId, t.userId, t.reviewScheduleId, t.status).where(sql`${t.status} = 'started'`),}),
);

/**
 * 理解事件（对齐产品文档 §5.9）。
 * 是未来理解账户和图谱的基础；V0 只写入 seen/validated/misunderstood/reviewed 四类。
 */
export const understandingEvents = pgTable(
  "understanding_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(), // card | note | validation
    subjectId: uuid("subject_id").notNull(),
    eventType: text("event_type").notNull(), // seen | validated | misunderstood | reviewed
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index("understanding_events_user_idx").on(t.userId, t.createdAt),
    subjectIdx: index("understanding_events_subject_idx").on(t.workspaceId, t.subjectType, t.subjectId, t.createdAt),

    idWorkspaceUnique: uniqueIndex("understanding_events_id_workspace_unique").on(t.id, t.workspaceId),}),
);
