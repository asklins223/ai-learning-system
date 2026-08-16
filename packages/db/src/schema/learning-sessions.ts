/**
 * 阶段 02（W1）任务 02-1：AI 学习伴侣驱动的学习过程对象 schema（§12.2）。
 *
 * 对应冻结记录 01-2（Session/Scene/Artifact/Trust 合同）：
 * - PrivateLearningEpisodeContract / OfficialSchedulingDecisionV1 / FrozenProbeRef
 * - RubricTarget / ResponseArtifactBase / RubricAssessment
 *
 * 语义要点：
 * - 全部 workspace-scoped，RLS 见迁移 0074（workspace_isolation）与 0075
 *   （收紧为 workspace_id + user_id 双条件）。
 * - learning_sessions 是容器（过程对象），不承载正式学习结果；
 *   正式 outcome/attempt/schedule 落入现有 validation/review 域。
 * - learning_episodes 是单 Key Point target 的 Episode contract 落点：
 *   scheduling decision、runtime/policy epoch、commit key、planHash 全部冻结。
 * - learning_session_probes 按 FrozenProbeRef 语义保存 scene 三对象引用与 hash。
 * - learning_response_artifacts 是不可变多模态 payload（hash + lock + supersede）。
 * - learning_assessment_reports 是支撑证据（Critic version + 逐 RubricTarget
 *   artifact/evidence binding 与 verdict），不是第二套 canonical outcome。
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
  check,
  boolean,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { cardKeyPoints } from "./card.ts";
import { users } from "./identity.ts";

// ─── 冻结合同的 JSONB 形状（01-2 §5/§6/§9）───────────────────────────────

export type LearningSessionOrigin = "card" | "review" | "star_map" | "now";
export type LearningSessionOriginRef = {
  type: "card" | "review_schedule" | "key_point" | "question_suggestion";
  id: string;
};
export type LearningSessionIntent = "stabilize" | "clarify" | "transfer" | "explore";

export type LearningSessionStatus = "active" | "ended" | "cancelled" | "stale";

/** OfficialSchedulingDecisionV1（01-2 §5） */
export type OfficialSchedulingDecisionV1 = {
  decisionRef: string;
  decisionHash: string;
  authorizedAction: "create_initial" | "consume_pending" | "record_only" | "no_effect";
  inputScheduleId?: string;
  inputScheduleGeneration?: number;
  prioritySource: "official_due" | "official_overdue" | "canonical_gap" | "user_selected";
  policyVersion: string;
  policyEpoch: number;
  reasonCodes: string[];
};

/** PrivateLearningEpisodeContract.formalPlan（01-2 §5） */
export type EpisodeFormalPlan = {
  kind: "voice_mastery" | "structured_mastery_bundle" | "facet_only" | "practice";
  requiredProbeIds: string[];
  bundlePolicyVersion?: string;
  silentProofProfileId?: string;
  structuredProofEligibilityReportHash?: string;
};

/** PrivateLearningEpisodeContract.rubricTargets 元素（01-2 §5） */
export type EpisodeRubricTarget = {
  id: string;
  criterion: string;
  expectedTargetRef: string;
  expectedTargetHash: string;
  weight: 1 | 2 | 3;
  required: boolean;
  capabilityFacet: string;
  targetKeyPointId: string;
  evidenceRefIds: string[];
  semanticSupportReportId: string;
  semanticSupportReportHash: string;
};

export type EpisodeFormalEligibilityKind =
  | "initial_validation"
  | "scheduled_review"
  | "repair_revalidation"
  | "ad_hoc_transfer"
  | "practice";

export type LearningEpisodeStatus = "draft" | "active" | "completed" | "stale" | "cancelled";

/** Processing pipeline state, independent from the Episode lifecycle. */
export type LearningEpisodeProcessingPhase =
  | "preparing"
  | "scene_ready"
  | "awaiting_response"
  | "assessment_pending"
  | "assessment_complete"
  | "commit_pending"
  | "committed"
  | "cancelled"
  | "stale";

export type LearningProbeStatus =
  | "draft"
  | "safety_check"
  | "active"
  | "locked"
  | "superseded"
  | "stale";

export type LearningArtifactStatus =
  | "draft"
  | "capturing"
  | "transcribed"
  | "awaiting_confirmation"
  | "locked"
  | "superseded"
  | "stale"
  | "redacted";

/** ResponseArtifactBase（01-2 §6）：assistanceSnapshot 形状 */
export type ArtifactAssistanceSnapshot = {
  assistanceLevel: string; // none | content_assisted | practice_only
  contentAssisted: boolean;
  exposedAt?: string;
  reasonCodes?: string[];
};

/** RubricAssessment（01-2 §9）：逐 rubric item 的 artifact/evidence binding 与 verdict */
export type RubricAssessment = {
  rubricItemId: string;
  verdict: "covered" | "partial" | "missing" | "contradicted" | "not_assessable";
  responseBindings: Array<{
    responseArtifactId: string;
    answerExcerpt?: string;
    interactionRefs?: string[];
  }>;
  evidenceRefIds: string[];
  assessmentSource: "deterministic" | "critic" | "user_declared_unable";
  rationale: string;
  confidence: number;
};

// ─── learning_sessions（容器，过程对象）─────────────────────────────────────

export const learningSessions = pgTable(
  "learning_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    origin: text("origin").$type<LearningSessionOrigin>().notNull(),
    originRef: jsonb("origin_ref").$type<LearningSessionOriginRef>().notNull(),
    intent: text("intent").$type<LearningSessionIntent>().notNull(),
    status: text("status").$type<LearningSessionStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceUserCreatedIdx: index("learning_sessions_workspace_user_created_idx").on(
      t.workspaceId, t.userId, t.createdAt,
    ),
    statusIdx: index("learning_sessions_status_idx").on(t.workspaceId, t.userId, t.status),
    // 2026-08-12（schema 完整性审计 P1-2）：0097 部分唯一索引声明
    userActiveUniqueIdx: uniqueIndex("learning_sessions_user_active_unique_idx")
      .on(t.workspaceId, t.userId)
      .where(sql`${t.status} = 'active'`),
  }),
);

// ─── learning_episodes（单 Key Point target + 冻结 Episode contract）────────

export const learningEpisodes = pgTable(
  "learning_episodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => learningSessions.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    keyPointId: uuid("key_point_id").notNull().references(() => cardKeyPoints.id, { onDelete: "cascade" }),
    origin: text("origin").$type<LearningSessionOrigin>().notNull(),
    originRef: jsonb("origin_ref").$type<LearningSessionOriginRef>().notNull(),
    intent: text("intent").$type<LearningSessionIntent>().notNull(),
    formalEligibilityKind: text("formal_eligibility_kind")
      .$type<EpisodeFormalEligibilityKind>().notNull(),
    formalPlan: jsonb("formal_plan").$type<EpisodeFormalPlan>().notNull(),
    schedulingDecision: jsonb("scheduling_decision").$type<OfficialSchedulingDecisionV1>().notNull(),
    episodeTargetFingerprint: text("episode_target_fingerprint").notNull(),
    contentExposureKey: text("content_exposure_key").notNull(),
    rubricTargets: jsonb("rubric_targets").$type<EpisodeRubricTarget[]>().notNull(),
    allowedModalities: text("allowed_modalities").array().notNull().default([]),
    maxTurns: integer("max_turns").notNull(),
    assistancePolicyVersion: text("assistance_policy_version").notNull(),
    rubricPolicyVersion: text("rubric_policy_version").notNull(),
    scenePolicyVersion: text("scene_policy_version").notNull(),
    assessmentPolicyVersion: text("assessment_policy_version").notNull(),
    masteryPolicyVersion: text("mastery_policy_version").notNull(),
    schedulerPolicyVersion: text("scheduler_policy_version").notNull(),
    providerPolicyVersion: text("provider_policy_version").notNull(),
    commitPolicyVersion: text("commit_policy_version").notNull(),
    providerConfigId: text("provider_config_id").notNull(),
    modelId: text("model_id").notNull(),
    requiredCapabilityIds: text("required_capability_ids").array().notNull().default([]),
    capabilitySnapshotHash: text("capability_snapshot_hash").notNull(),
    runtimeEpochSnapshot: integer("runtime_epoch_snapshot").notNull(),
    episodeEpoch: integer("episode_epoch").notNull(),
    budgetEnvelopeRef: text("budget_envelope_ref").notNull(),
    budgetEnvelopeHash: text("budget_envelope_hash").notNull(),
    planHash: text("plan_hash").notNull(),
    processingPhase: text("processing_phase")
      .$type<LearningEpisodeProcessingPhase>()
      .notNull()
      .default("awaiting_response"),
    status: text("status").$type<LearningEpisodeStatus>().notNull().default("draft"),
    commitKey: text("commit_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    sessionIdx: index("learning_episodes_session_idx").on(t.sessionId),
    workspaceUserKeyPointIdx: index("learning_episodes_workspace_user_keypoint_idx").on(
      t.workspaceId, t.userId, t.keyPointId, t.createdAt,
    ),
    statusIdx: index("learning_episodes_status_idx").on(t.workspaceId, t.userId, t.status),
    // 同一 Session 至多一个未终态 Episode（单 Key Point target 语义）。
    sessionActiveUnique: uniqueIndex("learning_episodes_session_active_unique_idx")
      .on(t.sessionId)
      .where(sql`${t.status} NOT IN ('completed', 'stale', 'cancelled')`),
    // COMMIT 幂等兜底（01-3 §12.5：session/episode 具有稳定幂等键）。
    commitKeyUnique: uniqueIndex("learning_episodes_commit_key_unique_idx")
      .on(t.workspaceId, t.commitKey)
      .where(sql`${t.commitKey} IS NOT NULL`),

    processingPhaseIdx: index("learning_episodes_processing_phase_idx").on(t.workspaceId, t.userId, t.processingPhase),}),
);

// ─── learning_session_probes（FrozenProbeRef 语义）────────────────────────

export const learningSessionProbes = pgTable(
  "learning_session_probes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => learningSessions.id, { onDelete: "cascade" }),
    episodeId: uuid("episode_id").notNull().references(() => learningEpisodes.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    // FrozenProbeRef（01-2 §5）：scene 三对象独立引用与 hash，不存 solution 原文。
    publicSceneContractId: text("public_scene_contract_id").notNull(),
    publicPayloadHash: text("public_payload_hash").notNull(),
    privateSolutionId: text("private_solution_id").notNull(),
    privateSolutionHash: text("private_solution_hash").notNull(),
    sceneSafetyReportId: text("scene_safety_report_id").notNull(),
    sceneSafetyReportHash: text("scene_safety_report_hash").notNull(),
    templateTrustCeiling: text("template_trust_ceiling").notNull(),
    disclosureProfileHash: text("disclosure_profile_hash").notNull(),
    status: text("status").$type<LearningProbeStatus>().notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // formalPlan.requiredProbeIds 内顺序固定，一个 Episode 内 sequence 唯一。
    episodeSequenceUnique: uniqueIndex("learning_session_probes_episode_sequence_unique_idx")
      .on(t.episodeId, t.sequence),
    episodeStatusIdx: index("learning_session_probes_episode_status_idx").on(t.episodeId, t.status),
    workspaceUserIdx: index("learning_session_probes_workspace_user_idx").on(t.workspaceId, t.userId),
  }),
);

// ─── learning_response_artifacts（不可变多模态 payload）────────────────────

export const learningResponseArtifacts = pgTable(
  "learning_response_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => learningSessions.id, { onDelete: "cascade" }),
    episodeId: uuid("episode_id").notNull().references(() => learningEpisodes.id, { onDelete: "cascade" }),
    keyPointId: uuid("key_point_id").notNull().references(() => cardKeyPoints.id, { onDelete: "cascade" }),
    probeId: uuid("probe_id").notNull().references(() => learningSessionProbes.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    publicSceneContractId: text("public_scene_contract_id").notNull(),
    publicPayloadHash: text("public_payload_hash").notNull(),
    privateSolutionId: text("private_solution_id").notNull(),
    privateSolutionHash: text("private_solution_hash").notNull(),
    sceneSafetyReportHash: text("scene_safety_report_hash").notNull(),
    disclosureProfileHash: text("disclosure_profile_hash").notNull(),
    inputSchemaHash: text("input_schema_hash").notNull(),
    modality: text("modality").notNull(), // voice | text_or_mixed | drag_graph | ordering | repair | scenario
    contentHash: text("content_hash").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    answerLockedAt: timestamp("answer_locked_at", { withTimezone: true }),
    assistanceSnapshot: jsonb("assistance_snapshot")
      .$type<ArtifactAssistanceSnapshot>().notNull(),
    episodeTargetFingerprint: text("episode_target_fingerprint").notNull(),
    contentExposureKey: text("content_exposure_key").notNull(),
    requestedTrustClass: text("requested_trust_class").notNull(),
    templateTrustCeiling: text("template_trust_ceiling").notNull(),
    effectiveTrustClass: text("effective_trust_class"),
    trustPolicyVersion: text("trust_policy_version").notNull(),
    trustReasonCodes: text("trust_reason_codes").array().notNull().default([]),
    correctionMethod: text("correction_method"), // none | re_recorded | manual_text_edit
    status: text("status").$type<LearningArtifactStatus>().notNull().default("draft"),
    revision: integer("revision").notNull().default(0),
    // 重录/手工修正创建新 revision/artifact 并保留来源（01-2 §6.2），不原地修改已哈希行。
    supersedesArtifactId: uuid("supersedes_artifact_id").references(
      (): AnyPgColumn => learningResponseArtifacts.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 同一 probe 下 revision 唯一，支撑"请求必须携带 base revision"的 CAS 语义。
    probeRevisionUnique: uniqueIndex("learning_response_artifacts_probe_revision_unique_idx")
      .on(t.workspaceId, t.probeId, t.revision),
    episodeIdx: index("learning_response_artifacts_episode_idx").on(t.episodeId),
    contentHashIdx: index("learning_response_artifacts_content_hash_idx")
      .on(t.workspaceId, t.contentHash),
    probeStatusIdx: index("learning_response_artifacts_probe_status_idx").on(t.probeId, t.status),
    // 不可变约束：locked 的已哈希行不能被原地改写（01-2 §6.2 状态机）。
    notRedactedCheck: check(
      "learning_response_artifacts_locked_immutable_check",
      sql`(${t.status} <> 'locked' AND ${t.status} <> 'redacted') OR (${t.answerLockedAt} IS NOT NULL)`,
    ),
  }),
);

// ─── learning_assessment_reports（支撑证据，非第二套 canonical outcome）─────

export const learningAssessmentReports = pgTable(
  "learning_assessment_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => learningSessions.id, { onDelete: "cascade" }),
    episodeId: uuid("episode_id").notNull().references(() => learningEpisodes.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    criticVersion: text("critic_version").notNull(),
    reducerVersion: text("reducer_version"),
    assessmentSource: text("assessment_source").notNull().default("critic"), // deterministic | critic | user_declared_unable
    rubricAssessments: jsonb("rubric_assessments").$type<RubricAssessment[]>().notNull(),
    reportHash: text("report_hash").notNull(),
    decisionHash: text("decision_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    episodeIdx: index("learning_assessment_reports_episode_idx").on(t.episodeId),
    // 每个 frozen rubric item 恰好一条最终 assessment；report hash 幂等去重。
    episodeReportHashUnique: uniqueIndex("learning_assessment_reports_episode_report_hash_unique_idx")
      .on(t.workspaceId, t.episodeId, t.reportHash),
    workspaceUserIdx: index("learning_assessment_reports_workspace_user_idx").on(t.workspaceId, t.userId),
  }),
);

// ─── 0081/0083/0084 迁移表（2026-08-12 generate 对齐补齐）─────────────────
// 此前 5 张表只在手写迁移中定义、schema 无声明——drizzle-kit generate 会
// 产出 DROP TABLE。列/索引/CHECK/RLS 语义与 0081/0083/0084 逐项对齐。

export const learningSessionProcessingOutbox = pgTable(
  "learning_session_processing_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => learningSessions.id, { onDelete: "cascade" }),
    episodeId: uuid("episode_id").notNull().references(() => learningEpisodes.id, { onDelete: "cascade" }),
    commandType: text("command_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
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
    commandCheck: check(
      "learning_session_processing_outbox_command_check",
      sql`${t.commandType} IN ('assessment_requested', 'commit_requested')`,
    ),
    payloadSafeCheck: check(
      "learning_session_processing_outbox_payload_check",
      // 0098 重建为 6 键(含 rationale/chainOfThought——思维链/理由也不得入队)
      sql`NOT (${t.payload} ? 'answer') AND NOT (${t.payload} ? 'answerText') AND NOT (${t.payload} ? 'userAnswer') AND NOT (${t.payload} ? 'question') AND NOT (${t.payload} ? 'rationale') AND NOT (${t.payload} ? 'chainOfThought')`,
    ),
    scopeKeyUnique: uniqueIndex("learning_session_processing_outbox_scope_key_unique")
      .on(t.workspaceId, t.idempotencyKey),
    pendingIdx: index("learning_session_processing_outbox_pending_idx")
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.processedAt} IS NULL`),
    episodeIdx: index("learning_session_processing_outbox_episode_idx")
      .on(t.workspaceId, t.episodeId, t.createdAt),
  }),
);

export const learningTutorDetours = pgTable(
  "learning_tutor_detours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => learningSessions.id, { onDelete: "cascade" }),
    episodeId: uuid("episode_id").notNull().references(() => learningEpisodes.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    questionId: text("question_id").notNull(),
    status: text("status").notNull().default("active"),
    endReason: text("end_reason"),
    questionMarkerSaved: boolean("question_marker_saved").notNull().default(false),
    turnCount: integer("turn_count").notNull().default(0),
    maxTurns: integer("max_turns").notNull().default(2),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastTurnAt: timestamp("last_turn_at", { withTimezone: true }),
  },
  (t) => ({
    statusCheck: check(
      "learning_tutor_detours_status_check",
      sql`${t.status} IN ('active', 'ended')`,
    ),
    endReasonCheck: check(
      "learning_tutor_detours_end_reason_check",
      sql`${t.endReason} IS NULL OR ${t.endReason} IN ('return_to_origin', 'end_session')`,
    ),
    turnCountCheck: check(
      "learning_tutor_detours_turn_count_check",
      sql`${t.turnCount} >= 0 AND ${t.turnCount} <= ${t.maxTurns}`,
    ),
    maxTurnsCheck: check(
      "learning_tutor_detours_max_turns_check",
      sql`${t.maxTurns} = 2`,
    ),
    workspaceUserIdx: index("learning_tutor_detours_workspace_user_idx")
      .on(t.workspaceId, t.userId, sql`${t.createdAt} desc`),
    sessionIdx: index("learning_tutor_detours_session_idx")
      .on(t.workspaceId, t.userId, t.sessionId, t.episodeId),
    // 2026-08-12（generate 对齐）：0098 部分唯一索引——同 episode 仅一个 active detour
    episodeActiveUnique: uniqueIndex("learning_tutor_detours_episode_active_unique_idx")
      .on(t.workspaceId, t.userId, t.episodeId)
      .where(sql`${t.status} = 'active'`),
  }),
);

export const learningTutorPermissions = pgTable(
  "learning_tutor_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 0083 UNIQUE (workspace_id, user_id, target_id)——drizzle 用 uniqueIndex 表达
    workspaceUserTargetUnique: uniqueIndex("learning_tutor_permissions_workspace_id_user_id_target_id_key")
      .on(t.workspaceId, t.userId, t.targetId),
  }),
);

export const learningTutorActionNonces = pgTable(
  "learning_tutor_action_nonces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => learningSessions.id, { onDelete: "cascade" }),
    keyPointId: uuid("key_point_id").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    nonceHashUnique: uniqueIndex("learning_tutor_action_nonces_nonce_hash_key").on(t.nonceHash),
    lookupIdx: index("learning_tutor_action_nonces_lookup_idx")
      .on(t.workspaceId, t.userId, t.sessionId, t.keyPointId, t.expiresAt),
  }),
);

export const learningSessionPracticeEvents = pgTable(
  "learning_session_practice_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => learningSessions.id, { onDelete: "cascade" }),
    episodeId: uuid("episode_id").notNull().references(() => learningEpisodes.id, { onDelete: "cascade" }),
    keyPointId: uuid("key_point_id").notNull().references(() => cardKeyPoints.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    typeCheck: check(
      "learning_session_practice_events_type_check",
      sql`${t.eventType} IN ('practice', 'diagnostic')`,
    ),
    summarySafeCheck: check(
      "learning_session_practice_events_summary_safe_check",
      sql`NOT (${t.summary} ? 'answer') AND NOT (${t.summary} ? 'answerText') AND NOT (${t.summary} ? 'userAnswer') AND NOT (${t.summary} ? 'question') AND NOT (${t.summary} ? 'rationale')`,
    ),
    idempotencyUnique: uniqueIndex("learning_session_practice_events_idempotency_idx")
      .on(t.workspaceId, t.userId, t.episodeId, t.idempotencyKey),
    sessionIdx: index("learning_session_practice_events_session_idx")
      .on(t.workspaceId, t.userId, t.sessionId, t.createdAt),
  }),
);
