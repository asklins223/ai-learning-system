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
import { noteBlocks, noteVersions } from "./note.ts";
import { learningCards } from "./card.ts";
import { aiArtifacts } from "./ai.ts";
import { users } from "./identity.ts";
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
    userOverride: text("user_override"), // confirmed | downgraded | rejected — 保留向后兼容，新逻辑使用 evidence_overrides 表
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    keyPointIdx: index("evidences_key_point_idx").on(t.keyPointId),
    blockIdx: index("evidences_block_idx").on(t.blockId),
    workspaceIdx: index("evidences_workspace_idx").on(t.workspaceId),
  }),
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
  }),
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
  },
  (t) => ({
    cardIdx: index("validation_questions_card_idx").on(t.cardId),
    workspaceIdx: index("validation_questions_workspace_idx").on(t.workspaceId),
    keyPointIdx: index("validation_questions_key_point_idx").on(t.keyPointId),
  }),
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
    questionId: uuid("question_id"), // FK 在迁移中定义
    jobId: uuid("job_id"), // 绑定 evaluate_validation job
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    cardIdx: index("validation_events_card_idx").on(t.cardId),
    userIdx: index("validation_events_user_idx").on(t.userId, t.createdAt),
    keyPointIdx: index("validation_events_key_point_idx").on(t.keyPointId),
    jobUniqueIdx: uniqueIndex("validation_events_job_unique_idx")
      .on(t.jobId)
      .where(sql`${t.jobId} IS NOT NULL`),
  }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    subjectIdx: index("review_schedules_subject_idx").on(t.subjectType, t.subjectId),
    nextIdx: index("review_schedules_next_idx").on(t.nextReviewAt, t.status),
    userStatusIdx: index("review_schedules_user_status_idx").on(t.userId, t.status, t.nextReviewAt),
  }),
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
  }),
);
