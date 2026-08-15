/**
 * LearningRun V1 数据模型（docs/plans/learning-companion/16 §16.1 目标表演进）。
 *
 * 对象语言与 wire contract 对齐（@ailearn/shared learning-run-contracts.ts）：
 * - learning_runs              ← learning_sessions 演进（phase/budget/activeTask/revision/checkpoint）
 * - learning_run_private_contracts ← learning_episodes 演进（private target/scheduling/epoch/planHash）
 * - learning_tasks / learning_task_variants ← learning_session_probes 演进（intent + Public Variant）
 * - learning_task_private_solutions / learning_task_safety_reports /
 *   learning_task_disclosure_profiles ← 现有 Critic/Safety 基础（server-private）
 * - learning_artifacts         ← learning_response_artifacts 演进（discriminated payload）
 * - learning_assessments       ← learning_assessment_reports 演进（task/artifact 绑定）
 * - learning_task_drafts / learning_run_events / learning_run_action_ledger /
 *   learning_activity_leases / learning_task_presentation_history / 幂等账本（新建）
 * - canonical_learning_event_outbox / practice_trail_event_outbox ← commit outbox 演进
 *
 * 约束（文档 16 §16.2）：
 * - canonical envelope(commitId) 唯一、canonicalEventId 唯一；
 * - practice event(runId, scope) 唯一；
 * - outbox 事务内 insert + at-least-once delivery，下游按键幂等。
 *
 * 隔离（文档 16 §1.3/§16.4）：
 * - 全部表 workspace/user RLS（迁移中 ENABLE + FORCE + workspace_isolation policy）；
 * - private solution / safety / disclosure 表对 ailearn_api REVOKE ALL（公共
 *   API 账号无 SELECT 路径），仅 ailearn_worker 可读。
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { cardKeyPoints } from "./card.ts";
import { users } from "./identity.ts";

// ─── 列级枚举（服务端存储值，与 wire contract 字面量一致）────────────────

export const LearningRunPhaseValues = [
  "preparing",
  "active",
  "assessing",
  "checkpoint",
  "committing",
  "paused",
  "completed",
  "ended",
  "skipped",
  "cancelled",
  "stale",
  "recoverable_error",
] as const;
export type LearningRunPhase = (typeof LearningRunPhaseValues)[number];

export const LearningTaskStatusValues = ["pending", "active", "answered", "skipped", "completed", "stale"] as const;
export type LearningTaskStatus = (typeof LearningTaskStatusValues)[number];

export const LearningTaskVariantStatusValues = ["active", "standby", "superseded", "abandoned"] as const;
export type LearningTaskVariantStatus = (typeof LearningTaskVariantStatusValues)[number];

export const LearningRunArtifactStatusValues = ["locked", "superseded", "abandoned"] as const;
export type LearningRunArtifactStatus = (typeof LearningRunArtifactStatusValues)[number];

export const LearningAssessmentStatusValues = ["queued", "running", "completed", "not_assessable", "failed"] as const;
export type LearningAssessmentStatus = (typeof LearningAssessmentStatusValues)[number];

export const LearningRunEventTypeValues = [
  "learning_run.created",
  "learning_run.prepared",
  "learning_run.started",
  "learning_run.paused",
  "learning_run.resumed",
  "learning_run.completed",
  "learning_run.ended",
  "learning_run.skipped",
  "learning_run.stale",
  "learning_run.cancelled",
  "learning_run.recoverable_error",
  "learning_task.presented",
  "learning_task.variant_switched",
  "learning_task.hint_requested",
  "learning_task.skipped",
  "learning_task.declared_unable",
  "learning_artifact.started",
  "learning_artifact.draft_saved",
  "learning_artifact.locked",
  "learning_artifact.superseded",
  "learning_assessment.queued",
  "learning_assessment.started",
  "learning_assessment.completed",
  "learning_assessment.not_assessable",
  "learning_assessment.failed",
  "learning_commit.completed",
  "learning_commit.failed",
  "learning_result.viewed",
] as const;
export type LearningRunEventType = (typeof LearningRunEventTypeValues)[number];

// ─── learning_runs（一个 Run 一个 Key Point 的微旅程容器）──────────────────

export const learningRuns = pgTable(
  "learning_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    assistantSessionId: uuid("assistant_session_id"),
    origin: jsonb("origin").notNull(),
    returnTarget: jsonb("return_target").notNull(),
    keyPointId: uuid("key_point_id").notNull().references(() => cardKeyPoints.id, { onDelete: "cascade" }),
    targetFingerprint: text("target_fingerprint").notNull(),
    goal: text("goal").notNull(), // stabilize | clarify | repair | transfer | explore
    phase: text("phase").$type<LearningRunPhase>().notNull().default("preparing"),
    timeBudgetSeconds: integer("time_budget_seconds").notNull().default(180),
    plannedActiveSeconds: integer("planned_active_seconds").notNull().default(180),
    activeSecondsUsed: integer("active_seconds_used").notNull().default(0),
    planningClosesAtActiveSecond: integer("planning_closes_at_active_second").notNull().default(150),
    activeTaskId: uuid("active_task_id"),
    checkpoint: jsonb("checkpoint"), // { kind, allowedFollowupIds } | null
    failure: jsonb("failure"), // LearningRunFailureV1 | null
    projectionStatus: text("projection_status").notNull().default("not_requested"),
    projectionBaselineCheckpointToken: text("projection_baseline_checkpoint_token"),
    terminalReasonCode: text("terminal_reason_code"),
    eventCursor: integer("event_cursor").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    runtimeEpoch: integer("runtime_epoch").notNull().default(0),
    result: jsonb("result"), // LearningRunResultV1 | null（只有学习结算存在）
    // 旧 Session/Episode 迁移追溯（§16.3：按 Episode 拆 Run，可还原旧顺序）。
    legacySessionId: uuid("legacy_session_id"),
    legacyEpisodeId: uuid("legacy_episode_id"),
    legacyOrdinal: integer("legacy_ordinal"),
    // P6 sandbox：隔离教学空间（§16.4）；非 sandbox Run 恒为 null。
    sandboxNamespaceId: uuid("sandbox_namespace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceUserCreatedIdx: index("learning_runs_workspace_user_created_idx").on(
      t.workspaceId, t.userId, t.createdAt,
    ),
    workspaceUserPhaseIdx: index("learning_runs_workspace_user_phase_idx").on(
      t.workspaceId, t.userId, t.phase,
    ),
    keyPointIdx: index("learning_runs_key_point_idx").on(t.workspaceId, t.userId, t.keyPointId),
    activeTaskIdx: index("learning_runs_active_task_idx").on(t.activeTaskId),
    // 0133：E17 backfill 幂等（legacyEpisodeId 部分唯一）。
    legacyEpisodeUnique: uniqueIndex("learning_runs_legacy_episode_unique_idx")
      .on(t.workspaceId, t.legacyEpisodeId)
      .where(sql`${t.legacyEpisodeId} IS NOT NULL`),
  }),
);

// ─── learning_run_private_contracts（server-private Run contract）──────────

export const learningRunPrivateContracts = pgTable(
  "learning_run_private_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    keyPointId: uuid("key_point_id").notNull().references(() => cardKeyPoints.id, { onDelete: "cascade" }),
    targetFingerprint: text("target_fingerprint").notNull(),
    runtimeEpoch: integer("runtime_epoch").notNull(),
    timeBudgetSeconds: integer("time_budget_seconds").notNull(),
    planningClosesAtActiveSecond: integer("planning_closes_at_active_second").notNull(),
    schedulingAuthorization: jsonb("scheduling_authorization").notNull(),
    taskPlanHash: text("task_plan_hash").notNull(),
    projectionBaselineCheckpointToken: text("projection_baseline_checkpoint_token"),
    contractHash: text("contract_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    runIdUnique: uniqueIndex("learning_run_private_contracts_run_unique_idx").on(t.runId),
    contractHashUnique: uniqueIndex("learning_run_private_contracts_hash_unique_idx").on(t.contractHash),
  }),
);

// ─── learning_tasks（一个待完成的认知动作）────────────────────────────────

export const learningTasks = pgTable(
  "learning_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(), // 1..3
    intent: text("intent").notNull(), // TaskIntentV1
    prompt: text("prompt").notNull(),
    targetSummary: text("target_summary").notNull(),
    hintLevels: integer("hint_levels").notNull().default(0), // 0 | 1 | 2 | 3
    status: text("status").$type<LearningTaskStatus>().notNull().default("pending"),
    revision: integer("revision").notNull().default(1),
    presentedAt: timestamp("presented_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    runSequenceUnique: uniqueIndex("learning_tasks_run_sequence_unique_idx").on(t.runId, t.sequence),
    runStatusIdx: index("learning_tasks_run_status_idx").on(t.runId, t.status),
    workspaceUserIdx: index("learning_tasks_workspace_user_idx").on(t.workspaceId, t.userId),
  }),
);

// ─── learning_task_variants（激活的交互合同 + public payload）──────────────

export const learningTaskVariants = pgTable(
  "learning_task_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => learningTasks.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(), // formal | facet | diagnostic | practice
    templateTrustCeiling: text("template_trust_ceiling").notNull(),
    estimatedActiveSeconds: integer("estimated_active_seconds").notNull(),
    // Public interaction payload（客户端渲染需要）；答案不在此处。
    interaction: jsonb("interaction").notNull(),
    publicPayloadHash: text("public_payload_hash").notNull(),
    inputSchemaHash: text("input_schema_hash").notNull(),
    disclosureProfileHash: text("disclosure_profile_hash").notNull(),
    // 0120：private 闭包冗余（api 进程提交时读；private 表保持无 SELECT 隔离）。
    privateSolutionHash: text("private_solution_hash").notNull(),
    safetyReportHash: text("safety_report_hash").notNull(),
    rubricTargetIds: jsonb("rubric_target_ids").notNull().default([]),
    alternatives: jsonb("alternatives").notNull().default([]),
    revision: integer("revision").notNull().default(1),
    status: text("status").$type<LearningTaskVariantStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 同 revision 只允许一个 active Variant（PREPARE 可预签发多个 Variant，
    // 各自 revision=1；superseded 历史行保留，见迁移 0118）。
    taskRevisionActiveUnique: uniqueIndex("learning_task_variants_task_revision_active_unique_idx")
      .on(t.taskId, t.revision)
      .where(sql`${t.status} = 'active'`),
    taskStatusIdx: index("learning_task_variants_task_status_idx").on(t.taskId, t.status),
  }),
);

// ─── server-private：solution / safety / disclosure ────────────────────────
// 公共 API 账号无 SELECT 路径（迁移 REVOKE ALL FROM ailearn_api）。

export const learningTaskPrivateSolutions = pgTable(
  "learning_task_private_solutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id").notNull().references(() => learningTaskVariants.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    solution: jsonb("solution").notNull(), // PrivateTaskSolutionV1
    privateSolutionHash: text("private_solution_hash").notNull(),
    runPlanHash: text("run_plan_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    variantUnique: uniqueIndex("learning_task_private_solutions_variant_unique_idx").on(t.variantId),
  }),
);

export const learningTaskSafetyReports = pgTable(
  "learning_task_safety_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").notNull().references(() => learningTasks.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").notNull().references(() => learningTaskVariants.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    publicPayloadHash: text("public_payload_hash").notNull(),
    inputSchemaHash: text("input_schema_hash").notNull(),
    privateSolutionHash: text("private_solution_hash").notNull(),
    disclosureProfileHash: text("disclosure_profile_hash").notNull(),
    qualificationProfileHash: text("qualification_profile_hash"),
    runPlanHash: text("run_plan_hash").notNull(),
    injectionScan: text("injection_scan").notNull(),
    privateLeakageScan: text("private_leakage_scan").notNull(),
    schemaValidation: text("schema_validation").notNull(),
    accessibilityProfile: text("accessibility_profile").notNull(),
    activationDecision: text("activation_decision").notNull(),
    reportHash: text("report_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    reportHashUnique: uniqueIndex("learning_task_safety_reports_hash_unique_idx").on(t.workspaceId, t.reportHash),
    variantIdx: index("learning_task_safety_reports_variant_idx").on(t.variantId),
  }),
);

export const learningTaskDisclosureProfiles = pgTable(
  "learning_task_disclosure_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id").notNull().references(() => learningTaskVariants.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    disclosedFieldPaths: jsonb("disclosed_field_paths").notNull(),
    hiddenFieldPaths: jsonb("hidden_field_paths").notNull(),
    answerBearingFieldsHidden: boolean("answer_bearing_fields_hidden").notNull().default(true),
    profileHash: text("profile_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    profileHashUnique: uniqueIndex("learning_task_disclosure_profiles_hash_unique_idx").on(t.workspaceId, t.profileHash),
    variantIdx: index("learning_task_disclosure_profiles_variant_idx").on(t.variantId),
  }),
);

// ─── learning_artifacts（不可变 discriminated payload）────────────────────

export const learningArtifacts = pgTable(
  "learning_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => learningTasks.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").notNull().references(() => learningTaskVariants.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
    payload: jsonb("payload").notNull(), // ArtifactPayloadV1
    payloadHash: text("payload_hash").notNull(),
    publicPayloadHash: text("public_payload_hash").notNull(),
    inputSchemaHash: text("input_schema_hash").notNull(),
    privateSolutionHash: text("private_solution_hash").notNull(),
    safetyReportHash: text("safety_report_hash").notNull(),
    disclosureProfileHash: text("disclosure_profile_hash").notNull(),
    assistanceSnapshotHash: text("assistance_snapshot_hash").notNull(),
    qualificationProfileHash: text("qualification_profile_hash"),
    status: text("status").$type<LearningRunArtifactStatus>().notNull().default("locked"),
    supersedesArtifactId: uuid("supersedes_artifact_id").references(
      (): AnyPgColumn => learningArtifacts.id,
      { onDelete: "set null" },
    ),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    taskRevisionUnique: uniqueIndex("learning_artifacts_task_revision_unique_idx").on(t.taskId, t.revision),
    runTaskIdx: index("learning_artifacts_run_task_idx").on(t.runId, t.taskId),
    // 一个 Task 至多一个 locked Artifact（§12.3 提交事务原子 lock）。
    taskLockedUnique: uniqueIndex("learning_artifacts_task_locked_unique_idx")
      .on(t.taskId)
      .where(sql`${t.status} = 'locked'`),
    // 不可变：locked 行必须有 lockedAt。
    lockedImmutableCheck: check(
      "learning_artifacts_locked_immutable_check",
      sql`${t.status} <> 'locked' OR ${t.lockedAt} IS NOT NULL`,
    ),
  }),
);

// ─── learning_assessments（一个 Assessment 只评一个 locked Artifact）──────

export const learningAssessments = pgTable(
  "learning_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => learningTasks.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id").notNull().references(() => learningArtifacts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // assessment_critic | deterministic_declared_unable
    status: text("status").$type<LearningAssessmentStatus>().notNull().default("queued"),
    rubricResults: jsonb("rubric_results").notNull().default([]),
    trustClass: text("trust_class"),
    reportHash: text("report_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    artifactUnique: uniqueIndex("learning_assessments_artifact_unique_idx").on(t.artifactId),
    runIdx: index("learning_assessments_run_idx").on(t.runId),
    runStatusIdx: index("learning_assessments_run_status_idx").on(t.runId, t.status),
    // 终态必须带 reportHash（§12.4 fail closed）。
    terminalReportCheck: check(
      "learning_assessments_terminal_report_check",
      sql`${t.status} NOT IN ('completed', 'not_assessable') OR ${t.reportHash} IS NOT NULL`,
    ),
  }),
);

// ─── learning_task_drafts（user-private 跨设备恢复草稿）───────────────────

export const learningTaskDrafts = pgTable(
  "learning_task_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => learningTasks.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").notNull().references(() => learningTaskVariants.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    taskRevision: integer("task_revision").notNull(),
    draftRevision: integer("draft_revision").notNull().default(1),
    payload: jsonb("payload"), // LearningDraftPayloadV1 | null（可部分完成）
    rendererState: jsonb("renderer_state").notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 一个 Task 一份草稿（CAS 对象）。
    taskUnique: uniqueIndex("learning_task_drafts_task_unique_idx").on(t.taskId),
    workspaceUserIdx: index("learning_task_drafts_workspace_user_idx").on(t.workspaceId, t.userId),
  }),
);

// ─── learning_run_events（Run lifecycle 事件流 / SSE replay）──────────────

export const learningRunEvents = pgTable(
  "learning_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").$type<LearningRunEventType>().notNull(),
    payload: jsonb("payload").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    runSequenceUnique: uniqueIndex("learning_run_events_run_sequence_unique_idx").on(t.runId, t.sequence),
    runIdx: index("learning_run_events_run_idx").on(t.runId, t.occurredAt),
  }),
);

// ─── learning_run_action_ledger（action 级幂等账本）────────────────────────

export const learningRunActionLedger = pgTable(
  "learning_run_action_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    actionKind: text("action_kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: text("response_status").notNull().default("pending"), // pending | success | error
    responseSnapshot: jsonb("response_snapshot"),
    acceptedActionId: text("accepted_action_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    runIdempotencyUnique: uniqueIndex("learning_run_action_ledger_run_idem_unique_idx").on(
      t.runId, t.idempotencyKey,
    ),
    acceptedActionUnique: uniqueIndex("learning_run_action_ledger_accepted_unique_idx").on(
      t.acceptedActionId,
    ),
  }),
);

// ─── learning_activity_leases（§13.3 三分钟 active time 续租账本）──────────

export const learningActivityLeases = pgTable(
  "learning_activity_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    deviceSessionId: text("device_session_id").notNull(),
    leaseStartedAt: timestamp("lease_started_at", { withTimezone: true }).notNull(),
    leaseEndedAt: timestamp("lease_ended_at", { withTimezone: true }).notNull(),
    creditedSeconds: integer("credited_seconds").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 同一设备会话同一起始时刻幂等去重（§13.3 重复/重叠 lease 幂等）。
    leaseUnique: uniqueIndex("learning_activity_leases_unique_idx").on(
      t.runId, t.deviceSessionId, t.leaseStartedAt,
    ),
    runIdx: index("learning_activity_leases_run_idx").on(t.runId),
  }),
);

// ─── learning_task_presentation_history（§7.8 题面轮换与 exposure）─────────

export const learningTaskPresentationHistory = pgTable(
  "learning_task_presentation_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    keyPointId: uuid("key_point_id").notNull().references(() => cardKeyPoints.id, { onDelete: "cascade" }),
    intent: text("intent").notNull(),
    publicPayloadHash: text("public_payload_hash").notNull(),
    interactionFamily: text("interaction_family").notNull(),
    presentedAt: timestamp("presented_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull().default("not_answered"),
    exposed: boolean("exposed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userKeyPointIntentIdx: index("learning_task_pres_hist_user_kp_intent_idx").on(
      t.workspaceId, t.userId, t.keyPointId, t.intent, t.presentedAt,
    ),
    payloadHashIdx: index("learning_task_pres_hist_payload_hash_idx").on(
      t.workspaceId, t.userId, t.keyPointId, t.publicPayloadHash,
    ),
  }),
);

// ─── canonical / practice outbox（projection 唯一输入）────────────────────

export const canonicalLearningEventOutbox = pgTable(
  "canonical_learning_event_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    commitId: uuid("commit_id").notNull(),
    canonicalEventId: text("canonical_event_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "cascade" }),
    keyPointId: uuid("key_point_id").notNull().references(() => cardKeyPoints.id, { onDelete: "cascade" }),
    envelope: jsonb("envelope").notNull(),
    status: text("status").notNull().default("pending"), // pending | published | failed
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // §16.2：canonical envelope(commitId) 唯一、canonicalEventId 唯一。
    commitUnique: uniqueIndex("canonical_learning_event_outbox_commit_unique_idx").on(t.commitId),
    eventIdUnique: uniqueIndex("canonical_learning_event_outbox_event_unique_idx").on(t.canonicalEventId),
    statusIdx: index("canonical_learning_event_outbox_status_idx").on(t.status, t.createdAt),
    workspaceUserRunIdx: index("canonical_learning_event_outbox_w_u_run_idx").on(
      t.workspaceId, t.userId, t.runId,
    ),
  }),
);

export const practiceTrailEventOutbox = pgTable(
  "practice_trail_event_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceEventId: text("practice_event_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "cascade" }),
    keyPointId: uuid("key_point_id").notNull().references(() => cardKeyPoints.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(), // official_user | sandbox
    event: jsonb("event").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // §16.2：practice event(runId, scope) 唯一（每个 Run 最多一个聚合 practice event）。
    runScopeUnique: uniqueIndex("practice_trail_event_outbox_run_scope_unique_idx").on(t.runId, t.scope),
    statusIdx: index("practice_trail_event_outbox_status_idx").on(t.status, t.createdAt),
  }),
);

// ─── learning_run_idempotency（POST /learning-runs 创建幂等）───────────────

export const learningRunIdempotency = pgTable(
  "learning_run_idempotency",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    keyUnique: uniqueIndex("learning_run_idempotency_key_unique_idx").on(
      t.workspaceId, t.userId, t.idempotencyKey,
    ),
  }),
);

// ─── learning_run_processing_outbox（Assessment/Commit 内部驱动）───────────
// §13.1：Assessment 与 Commit 只能由内部 outbox/worker 驱动。payload 只含
// ID 引用，答案正文绝不进入队列。

export const LearningRunProcessingCommand = {
  ASSESSMENT_REQUESTED: "assessment_requested",
  COMMIT_REQUESTED: "commit_requested",
} as const;
export type LearningRunProcessingCommand =
  (typeof LearningRunProcessingCommand)[keyof typeof LearningRunProcessingCommand];

export const learningRunProcessingOutbox = pgTable(
  "learning_run_processing_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull().references(() => learningTasks.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id").references(() => learningArtifacts.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    commandType: text("command_type").$type<LearningRunProcessingCommand>().notNull(),
    payload: jsonb("payload").notNull().default({}),
    idempotencyKey: text("idempotency_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    leasedAt: timestamp("leased_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 同 run+command 幂等（重放不重复驱动）。
    scopeKeyUnique: uniqueIndex("learning_run_processing_outbox_scope_key_unique_idx").on(
      t.workspaceId, t.runId, t.idempotencyKey,
    ),
    pendingIdx: index("learning_run_processing_outbox_pending_idx").on(
      t.availableAt, t.createdAt,
    ),
    runIdx: index("learning_run_processing_outbox_run_idx").on(t.runId, t.commandType),
    // 队列 payload 不得包含答案正文（与 0081 同姿态的防泄漏 CHECK）。
    payloadNoAnswerCheck: check(
      "learning_run_processing_outbox_payload_check",
      sql`NOT (${t.payload} ? 'answer')
        AND NOT (${t.payload} ? 'answerText')
        AND NOT (${t.payload} ? 'userAnswer')
        AND NOT (${t.payload} ? 'transcript')`,
    ),
  }),
);
