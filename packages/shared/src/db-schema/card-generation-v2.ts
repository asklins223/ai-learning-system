/**
 * Card Generation V2 DB Schema（方案 20 §18）。
 *
 * 覆盖表：card_generation_runs_v2, card_generation_plans_v2,
 * card_generation_candidates_v2, learning_objectives_v2,
 * learning_objective_revisions_v2, learning_cards_v2,
 * learning_card_publication_revisions_v2, card_exposure_ledger_v2,
 * initial_validation_reminders_v2, card_activation_receipts_v2,
 * card_generation_events_v2。
 *
 * 设计原则（§18.5）：
 * - 所有表 (workspace_id, id) 支持 scope 查询
 * - Candidate 三态分离
 * - 答案/rubric 存 jsonb private 列
 * - RLS workspace+user 双条件
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
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";
import { notes, noteVersions } from "./note.ts";
import { learningRuns } from "./learning-runs.ts";

// ─── §17.2 Generation Run ───────────────────────────────────────────────

export const cardGenerationRunsV2 = pgTable(
  "card_generation_runs_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    noteVersionId: uuid("note_version_id").notNull().references(() => noteVersions.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("queued"),
    cardContentEpoch: integer("card_content_epoch").notNull().default(1),
    semanticSpecHash: text("semantic_spec_hash").notNull(),
    inputSnapshotHash: text("input_snapshot_hash").notNull(),
    generationFingerprint: text("generation_fingerprint").notNull(),
    sourceSnapshotHash: text("source_snapshot_hash").notNull(),
    sourceContentHash: text("source_content_hash").notNull(),
    blockManifestHash: text("block_manifest_hash").notNull(),
    assetManifestHash: text("asset_manifest_hash").notNull(),
    scopeManifestHash: text("scope_manifest_hash").notNull(),
    currentPlanVersion: integer("current_plan_version").notNull().default(0),
    reviewDraftRevision: integer("review_draft_revision").notNull().default(1),
    semanticSpec: jsonb("semantic_spec").notNull().default(sql`'{}'::jsonb`),
    inputSnapshot: jsonb("input_snapshot").notNull().default(sql`'{}'::jsonb`),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    supersedesRunId: uuid("supersedes_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsIdempotencyUnique: uniqueIndex("cg_v2_ws_idempotency_idx").on(t.workspaceId, t.idempotencyKey),
    wsIdIdx: index("cg_v2_ws_id_idx").on(t.workspaceId, t.id),
    wsNoteIdx: index("cg_v2_ws_note_idx").on(t.workspaceId, t.noteId, t.createdAt),
    wsStatusIdx: index("cg_v2_ws_status_idx").on(t.workspaceId, t.status, t.updatedAt),
    statusCheck: check("cg_v2_status_chk", sql`${t.status} IN ('queued','source_sealing','planning','authoring','checking','review_ready','no_cards_recommended','needs_attention','activating','activated','closed_without_activation','failed','cancelled','stale')`),
    epochCheck: check("cg_v2_epoch_chk", sql`${t.cardContentEpoch} >= 1`),
  }),
);

// ─── §8.5 CardPlan revisions ────────────────────────────────────────────

export const cardGenerationPlansV2 = pgTable(
  "card_generation_plans_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRunsV2.id, { onDelete: "cascade" }),
    planRevisionId: uuid("plan_revision_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    previousPlanRevisionId: uuid("previous_plan_revision_id"),
    inputSnapshotHash: text("input_snapshot_hash").notNull(),
    cardContentEpoch: integer("card_content_epoch").notNull(),
    result: jsonb("result").notNull(),
    atomDecisions: jsonb("atom_decisions").notNull().default(sql`'[]'::jsonb`),
    planHash: text("plan_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    planRevisionUnique: uniqueIndex("cg_v2_plan_revision_idx").on(t.workspaceId, t.planRevisionId),
    // §8.5: (workspace_id, run_id, plan_version) 必须唯一，防止同一 run 下重复 plan version
    planRunVersionUnique: uniqueIndex("cg_v2_plan_run_version_idx").on(t.workspaceId, t.runId, t.planVersion),
    planRunIdx: index("cg_v2_plan_run_idx").on(t.workspaceId, t.runId, t.planVersion),
    planVersionCheck: check("cg_v2_plan_version_chk", sql`${t.planVersion} >= 1`),
  }),
);

// ─── §11 Candidate revisions ────────────────────────────────────────────

export const cardGenerationCandidatesV2 = pgTable(
  "card_generation_candidates_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRunsV2.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id").notNull(),
    candidateRevisionId: uuid("candidate_revision_id").notNull(),
    revision: integer("revision").notNull(),
    planRevisionId: uuid("plan_revision_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    planHash: text("plan_hash").notNull(),
    cardContentEpoch: integer("card_content_epoch").notNull(),
    planObjectiveLocalId: text("plan_objective_local_id").notNull(),
    recommendation: jsonb("recommendation").notNull().default(sql`'{}'::jsonb`),
    derivedFrom: jsonb("derived_from").notNull().default(sql`'[]'::jsonb`),
    objectiveDraft: jsonb("objective_draft").notNull(),
    presentationDraft: jsonb("presentation_draft").notNull(),
    /**
     * 两级提示（迁移 0234）。刻意做成兄弟列而不是塞进上面两个草稿：
     * `computeCandidateRevisionHashV2` 对整对象取哈希，塞进去就把提示并进了
     * 判分内容的审计链。
     */
    hints: jsonb("hints").notNull().default(sql`'{}'::jsonb`),
    evidenceSetHash: text("evidence_set_hash").notNull(),
    candidateRevisionHash: text("candidate_revision_hash").notNull(),
    qualityState: text("quality_state").notNull().default("authored"),
    reviewDecision: text("review_decision").notNull().default("undecided"),
    publishState: text("publish_state").notNull().default("unpublished"),
    reviewReasonCode: text("review_reason_code"),
    reviewNote: text("review_note"),
    qualityReportHashes: text("quality_report_hashes").array().notNull().default(sql`'{}'::text[]`),
    evidenceBindingPlanHash: text("evidence_binding_plan_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    revisionUnique: uniqueIndex("cg_v2_cand_revision_idx").on(t.workspaceId, t.candidateRevisionId),
    /**
     * 「1 版计划 : 1 个计划目标 : 1 个 revision」是 A1（逐候选提交）的幂等键，
     * 写进库里而不是只写进注释：重投的 job 第二次插同一目标时必须当场失败。
     * plan_version 必须在键里：replan 会 supersede 旧候选而不删除，并用同一批
     * `obj-atom-N` 目标号出新的一版计划（2026-09-21 读路径核对），少这一列会打死重试。
     */
    planObjectiveRevisionUnique: uniqueIndex("cg_v2_cand_plan_objective_revision_idx").on(
      t.workspaceId,
      t.runId,
      t.planVersion,
      t.planObjectiveLocalId,
      t.revision,
    ),
    runIdx: index("cg_v2_cand_run_idx").on(t.workspaceId, t.runId, t.candidateId, t.revision),
    latestIdx: index("cg_v2_cand_latest_idx").on(t.workspaceId, t.runId, t.candidateId, sql`${t.revision} DESC`),
    qualityCheck: check("cg_v2_cand_quality_chk", sql`${t.qualityState} IN ('authored','checking','passed','failed')`),
    reviewCheck: check("cg_v2_cand_review_chk", sql`${t.reviewDecision} IN ('undecided','keep','reject','merged')`),
    publishCheck: check("cg_v2_cand_publish_chk", sql`${t.publishState} IN ('unpublished','activating','activated','activation_failed','superseded','expired')`),
    revisionCheck: check("cg_v2_cand_revision_chk", sql`${t.revision} >= 1`),
  }),
);

// ─── §15.3 Learning Objective ──────────────────────────────────────────

export const learningObjectivesV2 = pgTable(
  "learning_objectives_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    objectiveId: uuid("objective_id").notNull(),
    semanticIdentityClassId: text("semantic_identity_class_id").notNull(),
    semanticIdentityPolicyVersion: text("semantic_identity_policy_version").notNull(),
    semanticTargetFingerprint: text("semantic_target_fingerprint").notNull(),
    lifecycle: text("lifecycle").notNull().default("active"),
    lifecycleEpoch: integer("lifecycle_epoch").notNull().default(1),
    currentObjectiveRevisionId: uuid("current_objective_revision_id"),
    currentRevision: integer("current_revision").notNull().default(0),
    // W1-08：Surface 公共读模型 revision / 失效时间（支撑 ETag；独立于 semantic fingerprint）。
    surfaceRevision: integer("surface_revision").notNull().default(0),
    surfaceUpdatedAt: timestamp("surface_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsObjectiveUnique: uniqueIndex("lo_v2_ws_objective_idx").on(t.workspaceId, t.objectiveId),
    wsLifecycleIdx: index("lo_v2_ws_lifecycle_idx").on(t.workspaceId, t.lifecycle, t.updatedAt),
    lifecycleCheck: check("lo_v2_lifecycle_chk", sql`${t.lifecycle} IN ('active','archived','superseded')`),
    epochCheck: check("lo_v2_epoch_chk", sql`${t.lifecycleEpoch} >= 1`),
  }),
);

export const learningObjectiveRevisionsV2 = pgTable(
  "learning_objective_revisions_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    objectiveRevisionId: uuid("objective_revision_id").notNull(),
    objectiveId: uuid("objective_id").notNull(),
    revision: integer("revision").notNull(),
    objectiveStatement: text("objective_statement").notNull(),
    publicSummary: text("public_summary").notNull(),
    // W1-05：概念级知识标题（不把 cue/prompt 当概念标题）；迁移期允许 NULL。
    conceptLabel: text("concept_label"),
    knowledgeForm: text("knowledge_form").notNull(),
    preferredIntents: text("preferred_intents").array().notNull(),
    canonicalAnswer: jsonb("canonical_answer").notNull(),
    learningSupport: jsonb("learning_support").notNull(),
    /**
     * 两级提示（迁移 0234），由制卡阶段随卡片产出。
     *
     * 独立成列而不是并入 learning_support：那张 jsonb 受 R30「必须严格基于证据」
     * 约束并由 Grounding Critic 逐字段核对，而提示是**教学引导不是事实断言**
     * （"先想它由哪两部分构成"无法指回证据），混进去会被误杀；同时它也不进
     * target_revision_hash / private_payload_hash 的输入。
     */
    hints: jsonb("hints").notNull().default(sql`'{}'::jsonb`),
    /**
     * 0245：作者产出的客观练习件（选择 / 判断 / 排序 / 配对）。NULL = 这张卡
     * 没有练习件（历史卡、以及作者拿不出有证据的干扰项时）。与 hints 相反，
     * 它是判分内容，因此进 target_revision_hash / private_payload_hash 闭包。
     */
    practiceItem: jsonb("practice_item"),
    scoringRubric: jsonb("scoring_rubric").notNull(),
    relations: jsonb("relations").notNull().default(sql`'[]'::jsonb`),
    evidenceBindings: jsonb("evidence_bindings").notNull().default(sql`'[]'::jsonb`),
    supersedesObjectiveRevisionId: uuid("supersedes_objective_revision_id"),
    semanticTargetFingerprint: text("semantic_target_fingerprint").notNull(),
    targetRevisionHash: text("target_revision_hash").notNull(),
    privatePayloadHash: text("private_payload_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    revisionUnique: uniqueIndex("lo_v2_rev_revision_idx").on(t.workspaceId, t.objectiveRevisionId),
    objectiveIdx: index("lo_v2_rev_objective_idx").on(t.workspaceId, t.objectiveId, sql`${t.revision} DESC`),
    revisionCheck: check("lo_v2_rev_revision_chk", sql`${t.revision} >= 1`),
    // 方案 20 §15.3：lineage 不可自引用——supersedesObjectiveRevisionId 不能等于自身 objectiveRevisionId
    noSelfReference: check("lo_v2_rev_no_self_ref_chk", sql`${t.objectiveRevisionId} IS DISTINCT FROM ${t.supersedesObjectiveRevisionId}`),
  }),
);

// ─── §15.1 Learning Card + Publication ─────────────────────────────────

export const learningCardsV2 = pgTable(
  "learning_cards_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    cardId: uuid("card_id").notNull(),
    objectiveId: uuid("objective_id").notNull(),
    noteVersionId: uuid("note_version_id").references(() => noteVersions.id, { onDelete: "restrict" }),
    cardRevision: integer("card_revision").notNull().default(1),
    currentPublicationRevision: integer("current_publication_revision").notNull().default(1),
    lifecycle: text("lifecycle").notNull().default("active"),
    front: jsonb("front").notNull(),
    publicSummary: text("public_summary").notNull(),
    knowledgeForm: text("knowledge_form").notNull(),
    strategy: text("strategy").notNull(),
    sourceLabel: text("source_label"),
    presentationHash: text("presentation_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsCardUnique: uniqueIndex("lc_v2_ws_card_idx").on(t.workspaceId, t.cardId),
    wsLifecycleIdx: index("lc_v2_ws_lifecycle_idx").on(t.workspaceId, t.lifecycle, t.updatedAt),
    wsNoteVersionIdx: index("lc_v2_ws_note_version_idx").on(t.workspaceId, t.noteVersionId),
    // 方案 20 §15.1：同一 objective 在 active 状态下只能有一张 active Card
    wsObjectiveActiveUnique: uniqueIndex("lc_v2_ws_obj_active_idx").on(t.workspaceId, t.objectiveId).where(sql`${t.lifecycle} = 'active'`),
    lifecycleCheck: check("lc_v2_lifecycle_chk", sql`${t.lifecycle} IN ('active','archived','superseded')`),
    cardRevCheck: check("lc_v2_card_rev_chk", sql`${t.cardRevision} >= 1`),
  }),
);

export const learningCardPublicationRevisionsV2 = pgTable(
  "learning_card_publication_revisions_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    cardId: uuid("card_id").notNull(),
    publicationRevision: integer("publication_revision").notNull(),
    cardRevision: integer("card_revision").notNull(),
    objectiveId: uuid("objective_id").notNull(),
    objectiveRevision: integer("objective_revision").notNull(),
    lifecycleAtPublication: text("lifecycle_at_publication").notNull(),
    publicPayloadHash: text("public_payload_hash").notNull(),
    revealPayloadHash: text("reveal_payload_hash").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    cardRevUnique: uniqueIndex("lc_v2_pub_card_rev_idx").on(t.workspaceId, t.cardId, t.publicationRevision),
    lifecycleCheck: check("lc_v2_pub_lifecycle_chk", sql`${t.lifecycleAtPublication} IN ('active','archived','superseded')`),
    pubRevCheck: check("lc_v2_pub_rev_chk", sql`${t.publicationRevision} >= 1`),
  }),
);

// ─── §18.2 Learning Card Revisions（R36）───────────────────────────────
// 不可变 Card revision 行：learning_cards_v2 只保留 current 去规范化行，
// 每次 bump cardRevision 必须原子写入一条 revision 行（front/strategy/
// presentation hash），杜绝前端被原地覆盖、历史丢失（§18.2）。

export const learningCardRevisionsV2 = pgTable(
  "learning_card_revisions_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    cardRevisionId: uuid("card_revision_id").notNull(),
    cardId: uuid("card_id").notNull(),
    revision: integer("revision").notNull(),
    front: jsonb("front").notNull(),
    strategy: text("strategy").notNull(),
    presentationHash: text("presentation_hash").notNull(),
    supersedesCardRevisionId: uuid("supersedes_card_revision_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsRevisionUnique: uniqueIndex("lcr_v2_ws_revision_unique").on(t.workspaceId, t.cardRevisionId),
    wsCardRevUnique: uniqueIndex("lcr_v2_ws_card_rev_unique").on(t.workspaceId, t.cardId, t.revision),
    wsCardIdx: index("lcr_v2_ws_card_idx").on(t.workspaceId, t.cardId, t.createdAt),
    revisionCheck: check("lcr_v2_revision_chk", sql`${t.revision} >= 1`),
    noSelfRef: check("lcr_v2_no_self_ref_chk", sql`${t.supersedesCardRevisionId} IS NULL OR ${t.supersedesCardRevisionId} <> ${t.cardRevisionId}`),
  }),
);

// ─── §15.2 Exposure Ledger ─────────────────────────────────────────────

export const cardExposureLedgerV2 = pgTable(
  "card_exposure_ledger_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    exposureId: uuid("exposure_id").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectCandidateId: uuid("subject_candidate_id"),
    subjectCandidateRevision: integer("subject_candidate_revision"),
    subjectObjectiveId: uuid("subject_objective_id"),
    subjectObjectiveRevision: integer("subject_objective_revision"),
    subjectCardId: uuid("subject_card_id"),
    subjectCardRevision: integer("subject_card_revision"),
    exposureKind: text("exposure_kind").notNull(),
    contextHash: text("context_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    exposedAt: timestamp("exposed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsIdemUnique: uniqueIndex("ce_v2_ws_idem_idx").on(t.workspaceId, t.userId, t.idempotencyKey),
    wsUserObjIdx: index("ce_v2_ws_user_obj_idx").on(t.workspaceId, t.userId, t.subjectObjectiveId, sql`${t.exposedAt} DESC`, t.id),
    wsUserCandIdx: index("ce_v2_ws_user_cand_idx").on(t.workspaceId, t.userId, t.subjectCandidateId, sql`${t.exposedAt} DESC`, t.id),
    subjectCheck: check("ce_v2_subject_chk", sql`${t.subjectKind} IN ('candidate','objective')`),
    kindCheck: check("ce_v2_kind_chk", sql`${t.exposureKind} IN ('answer_reveal','evidence_reveal','answer_editor_view')`),
  }),
);

// ─── §17.3 Initial Validation Reminder ────────────────────────────────

export const initialValidationRemindersV2 = pgTable(
  "initial_validation_reminders_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    reminderId: uuid("reminder_id").notNull(),
    objectiveId: uuid("objective_id").notNull(),
    exposureScopeId: text("exposure_scope_id").notNull(),
    qualificationNotBefore: timestamp("qualification_not_before", { withTimezone: true }).notNull(),
    lastExposureId: uuid("last_exposure_id"),
    policyVersion: text("policy_version").notNull(),
    status: text("status").notNull().default("pending"),
    reminderRevision: integer("reminder_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsUserObjPendingUnique: uniqueIndex("ivr_v2_ws_user_obj_pending_idx").on(t.workspaceId, t.userId, t.objectiveId).where(sql`${t.status} IN ('pending','ready')`),
    wsUserStatusIdx: index("ivr_v2_ws_user_status_idx").on(t.workspaceId, t.userId, t.status, t.qualificationNotBefore),
    statusCheck: check("ivr_v2_status_chk", sql`${t.status} IN ('pending','ready','completed','cancelled','superseded')`),
    revCheck: check("ivr_v2_rev_chk", sql`${t.reminderRevision} >= 1`),
  }),
);

// ─── §17.5 Activation Receipt ──────────────────────────────────────────

export const cardActivationReceiptsV2 = pgTable(
  "card_activation_receipts_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => cardGenerationRunsV2.id, { onDelete: "cascade" }),
    receiptId: uuid("receipt_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    mappings: jsonb("mappings").notNull(),
    lifecycleResults: jsonb("lifecycle_results").notNull().default(sql`'[]'::jsonb`),
    responseHash: text("response_hash").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsReceiptUnique: uniqueIndex("car_v2_ws_receipt_idx").on(t.workspaceId, t.receiptId),
    wsIdemUnique: uniqueIndex("car_v2_ws_idem_idx").on(t.workspaceId, t.idempotencyKey),
    wsRunIdx: index("car_v2_ws_run_idx").on(t.workspaceId, t.runId),
  }),
);

// ─── §17.1 Generation Run Events ───────────────────────────────────────

export const cardGenerationEventsV2 = pgTable(
  "card_generation_events_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRunsV2.id, { onDelete: "cascade" }),
    eventSeq: integer("event_seq").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsRunSeqUnique: uniqueIndex("cge_v2_ws_run_seq_idx").on(t.workspaceId, t.runId, t.eventSeq),
    wsRunCreatedIdx: index("cge_v2_ws_run_created_idx").on(t.workspaceId, t.runId, t.createdAt),
  }),
);

// ─── §17.7 Domain Events（R36：card/objective/reminder lifecycle 通道） ──
// run-scoped 事件表无法承载无 runId 的 lifecycle 事件（reveal/archive/reminder）；
// 本表提供 aggregate 语义的领域事件通道，供 Today/Card 通知、search、shared
// topology 等白名单消费者按 (eventId, consumerName) 幂等消费（§17.7）。

export const cardDomainEventsV2 = pgTable(
  "card_domain_events_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    eventId: uuid("event_id").notNull(),
    eventType: text("event_type").notNull(),
    aggregateKind: text("aggregate_kind").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateRevision: integer("aggregate_revision"),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    payloadHash: text("payload_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    causationId: uuid("causation_id"),
    correlationId: uuid("correlation_id"),
    idempotencyKey: text("idempotency_key"),
    schemaVersion: integer("schema_version").notNull().default(2),
    consumerWatermarks: jsonb("consumer_watermarks").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    wsEventUnique: uniqueIndex("cde_v2_ws_event_unique").on(t.workspaceId, t.eventId),
    wsAggIdx: index("cde_v2_ws_agg_idx").on(t.workspaceId, t.aggregateKind, t.aggregateId, t.occurredAt),
    wsTypeIdx: index("cde_v2_ws_type_idx").on(t.workspaceId, t.eventType, t.occurredAt),
    wsOccurredIdx: index("cde_v2_ws_occurred_idx").on(t.workspaceId, t.occurredAt),
    typeCheck: check("cde_v2_type_chk", sql`${t.eventType} IN (
      'learning_objective.revised',
      'learning_objective.superseded',
      'learning_objective.archived',
      'learning_card.revised',
      'learning_card.revealed',
      'learning_card.archived',
      'initial_validation_reminder.created',
      'initial_validation_reminder.deferred',
      'initial_validation_reminder.ready',
      'initial_validation_reminder.completed',
      'initial_validation_reminder.cancelled'
    )`),
    aggKindCheck: check("cde_v2_agg_kind_chk", sql`(
      (${t.eventType} LIKE 'learning_objective.%' AND ${t.aggregateKind} = 'objective')
      OR (${t.eventType} LIKE 'learning_card.%' AND ${t.aggregateKind} = 'card')
      OR (${t.eventType} LIKE 'initial_validation_reminder.%' AND ${t.aggregateKind} = 'reminder')
    )`),
  }),
);

// ─── §16.1 Learning Target Snapshot V2 ───────────────────────────────────

export const learningTargetSnapshotsV2 = pgTable(
  "learning_target_snapshots_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    snapshotId: uuid("snapshot_id").notNull(),
    // §16.1/§18.4：run_id 绑定方案 16 的 learning_runs（RESTRICT 防级联清快照）
    runId: uuid("run_id").notNull().references(() => learningRuns.id, { onDelete: "restrict" }),
    userId: uuid("user_id"),
    objectiveId: uuid("objective_id").notNull(),
    objectiveRevisionId: uuid("objective_revision_id").notNull(),
    objectiveRevision: integer("objective_revision").notNull(),
    semanticTargetFingerprint: text("semantic_target_fingerprint").notNull(),
    targetRevisionHash: text("target_revision_hash").notNull(),
    semanticIdentityClassId: text("semantic_identity_class_id").notNull(),
    semanticIdentityPolicyVersion: text("semantic_identity_policy_version").notNull(),
    objectiveLifecycleEpoch: integer("objective_lifecycle_epoch").notNull(),
    cardContentEpoch: integer("card_content_epoch").notNull(),
    assistanceSnapshotHash: text("assistance_snapshot_hash"),
    cardId: uuid("card_id"),
    publicationRevision: integer("publication_revision"),
    cardRevision: integer("card_revision"),
    publicPayloadHash: text("public_payload_hash"),
    revealPayloadHash: text("reveal_payload_hash"),
    evidenceBindingSetHash: text("evidence_binding_set_hash"),
    evidenceEligibilityVectorHash: text("evidence_eligibility_vector_hash"),
    planningExposure: jsonb("planning_exposure"),
    lifecycleAtPrepare: text("lifecycle_at_prepare"),
    publishedTargetEligibility: text("published_target_eligibility"),
    preparedAt: timestamp("prepared_at", { withTimezone: true }),
    targetSnapshotPolicyVersion: text("target_snapshot_policy_version"),
    canonicalAnswer: jsonb("canonical_answer").notNull(),
    scoringRubric: jsonb("scoring_rubric").notNull(),
    relations: jsonb("relations").notNull().default(sql`'[]'::jsonb`),
    evidenceBindings: jsonb("evidence_bindings").notNull().default(sql`'[]'::jsonb`),
    preferredIntents: text("preferred_intents").array().notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    // 0139：完整 §16.1 server-private target（含 objectiveStatement/
    // publicSummary/knowledgeForm/learningSupport 等未单列为列的子字段）。
    target: jsonb("target").notNull(),
    frozenAt: timestamp("frozen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    snapshotIdUnique: uniqueIndex("lts_v2_snapshot_id_idx").on(t.workspaceId, t.snapshotId),
    wsRunIdx: index("lts_v2_ws_run_idx").on(t.workspaceId, t.runId, t.objectiveId),
    wsObjectiveIdx: index("lts_v2_ws_objective_idx").on(t.workspaceId, t.objectiveId, t.frozenAt),
    revisionCheck: check("lts_v2_revision_chk", sql`${t.objectiveRevision} >= 1`),
    epochCheck: check("lts_v2_epoch_chk", sql`${t.cardContentEpoch} >= 1`),
    lifecycleEpochCheck: check("lts_v2_lifecycle_epoch_chk", sql`${t.objectiveLifecycleEpoch} >= 1`),
  }),
);

// ─── §12.2 Candidate Evidence Binding Plan V2 ─────────────────────────────

export const candidateEvidenceBindingPlansV2 = pgTable(
  "candidate_evidence_binding_plans_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    bindingPlanId: uuid("binding_plan_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRunsV2.id, { onDelete: "cascade" }),
    candidateRevisionId: uuid("candidate_revision_id").notNull(),
    candidateRevisionHash: text("candidate_revision_hash").notNull(),
    planRevisionId: uuid("plan_revision_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    planHash: text("plan_hash").notNull(),
    targetUnitBindings: jsonb("target_unit_bindings").notNull(),
    bindingPlanHash: text("binding_plan_hash").notNull(),
    evidenceEligibilityVectorHash: text("evidence_eligibility_vector_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bindingPlanIdUnique: uniqueIndex("cebp_v2_id_idx").on(t.workspaceId, t.bindingPlanId),
    wsCandidateIdx: index("cebp_v2_ws_candidate_idx").on(t.workspaceId, t.candidateRevisionId),
    versionCheck: check("cebp_v2_version_chk", sql`${t.planVersion} >= 1`),
  }),
);

// ─── §13.1 Evidence Eligibility State V2 ─────────────────────────────────

export const evidenceEligibilityStatesV2 = pgTable(
  "evidence_eligibility_states_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    eligibilityId: uuid("eligibility_id").notNull(),
    evidenceSnapshotId: uuid("evidence_snapshot_id").notNull(),
    status: text("status").notNull().default("usable"),
    eligibilityEpoch: integer("eligibility_epoch").notNull().default(1),
    eligibilityVectorHash: text("eligibility_vector_hash").notNull(),
    restrictedReason: text("restricted_reason"),
    restrictedAt: timestamp("restricted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    eligibilityIdUnique: uniqueIndex("ees_v2_id_idx").on(t.workspaceId, t.eligibilityId),
    wsSnapshotIdx: index("ees_v2_ws_snapshot_idx").on(t.workspaceId, t.evidenceSnapshotId, t.status),
    statusCheck: check("ees_v2_status_chk", sql`${t.status} IN ('usable','restricted','revoked')`),
    epochCheck: check("ees_v2_epoch_chk", sql`${t.eligibilityEpoch} >= 1`),
  }),
);

// ─── §17.2 Card Generation Run Outbox (worker enqueue) ───────────────────

export const cardGenerationRunOutboxV2 = pgTable(
  "card_generation_run_outbox_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRunsV2.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    // 0154/0155/0163（round-3 审计“schema 漂移”）：0154 已加租约三列 + 0155 已加
    // (run_id, job_type) 唯一索引，0163 进一步收窄为部分唯一（仅 plan/post_activation 单例），
    // 此前的 drizzle schema 未声明 → 未来 drizzle-kit diff 会反向删列/删约束。
    // 此处同步声明，防止漂移。该表是活跃工作路径（plan/post_activation job 由 worker 消费）。
    startedAt: timestamp("started_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    // 0220（2026-09-15 管线评审 H1）：可重试失败后的下次可认领时间（指数退避）。
    // 没有它时 retryable 失败立即回 pending，下一个 poll 就重新认领并重放整条
    // 已付费的 LLM 管道；429/5xx 时会形成重试风暴。
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  },
  (t) => ({
    wsRunStatusIdx: index("cgro_v2_ws_run_status_idx").on(t.workspaceId, t.runId, t.status, t.createdAt),
    statusCheck: check("cgro_v2_status_chk", sql`${t.status} IN ('pending','processing','completed','failed')`),
    statusLeaseIdx: index("cgro_v2_status_lease_idx")
      .on(t.status, t.leaseExpiresAt)
      .where(sql`${t.status} = 'processing'`),
    pendingClaimIdx: index("cgro_v2_pending_claim_idx")
      .on(t.status, t.nextAttemptAt, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    // 0163（第六轮）：唯一约束收窄为每 run 单例 job 类型——recheck/regenerate
    // 是 per-candidate 语义（同 run 多候选需多 job），全类型唯一会静默吞掉
    // 第二个 job。部分唯一索引只对 plan/post_activation 生效。
    runJobUnique: uniqueIndex("cgro_v2_run_singleton_job_type_unique")
      .on(t.runId, t.jobType)
      .where(sql`${t.jobType} IN ('card_generation_plan', 'card_v2_post_activation')`),
  }),
);

/**
 * 0249：生成过程的实时进度读数（只读投影，不是产物）。
 * 为什么没有指向 runs 的外键、为什么带 `leaseToken`、为什么到终态不清理——
 * 三处的理由都写在迁移 0249 的表头注释里（一句话版本：外键的 KEY SHARE 会排在
 * 管道事务那把分钟级 `FOR UPDATE` 后面，读数就永远刷不进来）。
 */
export const cardGenerationRunProgressV2 = pgTable(
  "card_generation_run_progress_v2",
  {
    runId: uuid("run_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    leaseToken: uuid("lease_token").notNull(),
    progress: jsonb("progress").notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    progressShapeCheck: check(
      "card_generation_run_progress_v2_progress_chk",
      sql`jsonb_typeof(${t.progress}) = 'object'`,
    ),
    workspaceIdx: index("card_generation_run_progress_v2_workspace_idx").on(t.workspaceId),
  }),
);

// ─── 0138 补表（§18 审查修复） ─────────────────────────────────────────────
// 依据 docs/evidence/learning-companion/20-learning-card-v2-implementation-review.md；
// 与迁移 0138_card_generation_v2_review_fixes.sql 保持一致。

/** §18.1 cardContentEpoch 单一权威（server-owned；单调递增由服务层 CAS 保证）。 */
export const cardContentCapabilityStateV2 = pgTable(
  "card_content_capability_state",
  {
    workspaceId: uuid("workspace_id").primaryKey(),
    contentEpoch: integer("content_epoch").notNull(),
    mode: text("mode").notNull().default("shadow"),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    changeReceipt: text("change_receipt"),
  },
  (t) => ({
    epochCheck: check("ccs_v2_epoch_min", sql`${t.contentEpoch} >= 1`),
  }),
);

/** §18.1 immutable semantic spec（可按 semantic_spec_hash 复用）。 */
export const cardGenerationSemanticSpecsV2 = pgTable(
  "card_generation_semantic_specs_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    semanticSpecHash: text("semantic_spec_hash").notNull(),
    semanticSpec: jsonb("semantic_spec").notNull(),
    version: integer("version").notNull().default(2),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    hashUnique: unique("cgss_v2_hash_unique").on(t.semanticSpecHash),
  }),
);

/** §18.1 immutable input snapshot（run 1:1；input hash unique）。 */
export const cardGenerationInputSnapshotsV2 = pgTable(
  "card_generation_input_snapshots_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    generationRunId: uuid("generation_run_id").notNull(),
    inputSnapshotHash: text("input_snapshot_hash").notNull(),
    inputSnapshot: jsonb("input_snapshot").notNull(),
    version: integer("version").notNull().default(2),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    runUnique: unique("cgis_v2_run_unique").on(t.generationRunId),
    hashUnique: unique("cgis_v2_hash_unique").on(t.inputSnapshotHash),
  }),
);

/** §14.1/§18.3 immutable evidence snapshot（正文在独立加密 blob）。 */
export const evidenceSnapshotsV2 = pgTable(
  "evidence_snapshots_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    evidenceSnapshotId: uuid("evidence_snapshot_id").notNull(),
    evidenceSnapshotHash: text("evidence_snapshot_hash").notNull(),
    sourceSnapshotId: uuid("source_snapshot_id").notNull(),
    noteId: uuid("note_id"),
    blockId: uuid("block_id"),
    startOffset: integer("start_offset").notNull().default(0),
    endOffset: integer("end_offset").notNull().default(0),
    protectedQuoteRef: text("protected_quote_ref"),
    quoteHash: text("quote_hash"),
    blockContentHash: text("block_content_hash"),
    sourceContentHash: text("source_content_hash").notNull(),
    modality: text("modality").notNull().default("text"),
    assetId: uuid("asset_id"),
    assetVersionHash: text("asset_version_hash"),
    region: jsonb("region"),
    page: integer("page"),
    protectedExtractedTextRef: text("protected_extracted_text_ref"),
    extractedTextHash: text("extracted_text_hash"),
    supportDescription: text("support_description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    snapshotUnique: unique("es_v2_snapshot_unique").on(t.evidenceSnapshotId),
    wsSnapshotIdx: index("es_v2_ws_snapshot_idx").on(t.workspaceId, t.evidenceSnapshotId),
  }),
);

/** §14.1/§18.3 单调 redaction overlay。 */
export const evidenceRedactionsV2 = pgTable(
  "evidence_redactions_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    evidenceSnapshotId: uuid("evidence_snapshot_id").notNull()
      .references(() => evidenceSnapshotsV2.evidenceSnapshotId, { onDelete: "restrict" }),
    redactionRevision: integer("redaction_revision").notNull(),
    scope: text("scope").notNull(),
    reasonCode: text("reason_code").notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }).defaultNow().notNull(),
    tombstoneHash: text("tombstone_hash").notNull(),
  },
);

/** §14.3/§18.3 semantic support report（Grounding 输入/输出；不反向嵌入 Evidence）。 */
export const semanticSupportReportsV2 = pgTable(
  "semantic_support_reports_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    reportId: uuid("report_id").notNull(),
    candidateRevisionId: uuid("candidate_revision_id").notNull(),
    evidenceSnapshotId: uuid("evidence_snapshot_id").notNull(),
    report: jsonb("report").notNull(),
    verdict: text("verdict").notNull(),
    reportHash: text("report_hash").notNull(),
    version: integer("version").notNull().default(2),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    reportUnique: unique("ssr_v2_report_unique").on(t.reportId),
  }),
);

/** §14.3/§18.3 objective 级 evidence binding。 */
export const learningObjectiveEvidenceBindingsV2 = pgTable(
  "learning_objective_evidence_bindings_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    bindingId: uuid("binding_id").notNull(),
    objectiveRevisionId: uuid("objective_revision_id").notNull(),
    targetUnitKind: text("target_unit_kind").notNull(),
    targetUnitId: text("target_unit_id"),
    evidenceSnapshotId: uuid("evidence_snapshot_id").notNull()
      .references(() => evidenceSnapshotsV2.evidenceSnapshotId, { onDelete: "restrict" }),
    relation: text("relation").notNull(),
    supportStrength: text("support_strength").notNull(),
    semanticSupportReportId: uuid("semantic_support_report_id").notNull(),
    semanticSupportReportHash: text("semantic_support_report_hash").notNull(),
    derivationReportId: uuid("derivation_report_id"),
    derivationReportHash: text("derivation_report_hash"),
    bindingHash: text("binding_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bindingUnique: unique("loeb_v2_binding_unique").on(t.bindingId),
    unitIdx: index("loeb_v2_unit_idx").on(t.workspaceId, t.objectiveRevisionId, t.targetUnitKind, t.targetUnitId),
  }),
);

/** §5.4/§18.2 激活前 equivalence report（immutable；不得引用未创建 revision）。 */
export const learningObjectiveEquivalenceReportsV2 = pgTable(
  "learning_objective_equivalence_reports_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    reportId: uuid("report_id").notNull(),
    objectiveId: uuid("objective_id").notNull(),
    priorObjectiveRevisionId: uuid("prior_objective_revision_id").notNull(),
    priorTargetRevisionHash: text("prior_target_revision_hash").notNull(),
    proposedCandidateRevisionId: uuid("proposed_candidate_revision_id").notNull(),
    proposedCandidateRevisionHash: text("proposed_candidate_revision_hash").notNull(),
    proposedSemanticContentHash: text("proposed_semantic_content_hash").notNull(),
    proposedEvidenceBindingPlanHash: text("proposed_evidence_binding_plan_hash").notNull(),
    verdict: text("verdict").notNull(),
    checks: jsonb("checks").notNull(),
    policyVersion: text("policy_version").notNull(),
    authorizedBy: text("authorized_by").notNull(),
    reportHash: text("report_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    reportUnique: unique("loer_v2_report_unique").on(t.reportId),
    wsReportIdx: index("loer_v2_ws_report_idx").on(t.workspaceId, t.reportId),
  }),
);

/** §5.4/§18.2 激活事务原子写的 plan→result 映射。 */
export const learningObjectiveRevisionEquivalenceV2 = pgTable(
  "learning_objective_revision_equivalence_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    reportId: uuid("report_id").notNull()
      .references(() => learningObjectiveEquivalenceReportsV2.reportId, { onDelete: "restrict" }),
    reportHash: text("report_hash").notNull(),
    priorObjectiveRevisionId: uuid("prior_objective_revision_id").notNull(),
    resultingObjectiveRevisionId: uuid("resulting_objective_revision_id").notNull(),
    resultingTargetRevisionHash: text("resulting_target_revision_hash").notNull(),
    activatedCandidateRevisionId: uuid("activated_candidate_revision_id").notNull(),
    evaluatedCandidateEvidenceBindingPlanHash: text("evaluated_candidate_evidence_binding_plan_hash").notNull(),
    resultingEvidenceBindingSetHash: text("resulting_evidence_binding_set_hash").notNull(),
    bindingHash: text("binding_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    reportUnique: unique("lore_v2_report_unique").on(t.reportId),
  }),
);

/** §18.2 merge/split/supersede lineage。 */
export const learningObjectiveLineageV2 = pgTable(
  "learning_objective_lineage_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    predecessorRevisionId: uuid("predecessor_revision_id").notNull(),
    successorRevisionId: uuid("successor_revision_id").notNull(),
    relation: text("relation").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    predIdx: index("lol_v2_pred_idx").on(t.workspaceId, t.predecessorRevisionId),
    succIdx: index("lol_v2_succ_idx").on(t.workspaceId, t.successorRevisionId),
  }),
);

/** §15.2/§18.2 objective-scoped exposure（append-only）。 */
export const learningExposuresV2 = pgTable(
  "learning_exposures_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    exposureId: uuid("exposure_id").notNull(),
    userId: uuid("user_id").notNull(),
    objectiveId: uuid("objective_id").notNull(),
    objectiveRevision: integer("objective_revision").notNull(),
    cardId: uuid("card_id"),
    cardRevision: integer("card_revision"),
    exposureKind: text("exposure_kind").notNull(),
    contextHash: text("context_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceCandidateExposureId: uuid("source_candidate_exposure_id"),
    exposedAt: timestamp("exposed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    exposureUnique: unique("lex_v2_exposure_unique").on(t.exposureId),
    idemUnique: unique("lex_v2_idem_unique").on(t.workspaceId, t.userId, t.idempotencyKey),
    objIdx: index("lex_v2_obj_idx").on(t.workspaceId, t.userId, t.objectiveId, t.exposedAt, t.id),
  }),
);

/** §18.1 candidate 质量报告（immutable；exact revision closure）。 */
export const cardCandidateQualityReportsV2 = pgTable(
  "card_candidate_quality_reports_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    candidateRevisionId: uuid("candidate_revision_id").notNull(),
    reportType: text("report_type").notNull(),
    inputHash: text("input_hash").notNull(),
    report: jsonb("report").notNull(),
    verdict: text("verdict").notNull(),
    gateVersion: text("gate_version").notNull(),
    reportHash: text("report_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    revIdx: index("ccqr_v2_rev_idx").on(t.workspaceId, t.candidateRevisionId),
  }),
);

/** §18.1 candidate feedback（敏感文本分级保留）。 */
export const cardCandidateFeedbackV2 = pgTable(
  "card_candidate_feedback_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull(),
    // 判定是个人行为：协作空间里必须分得清是谁驳回/留下了这张卡（迁移 0242）。
    userId: uuid("user_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    action: text("action").notNull(),
    reasonCode: text("reason_code"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    runIdx: index("ccf_v2_run_idx").on(t.workspaceId, t.runId),
  }),
);

// ─── 0162: V2 post-activation 消费台账 ──────────────────────────────────────
// 由 worker（api 外）/api 裸 SQL 写入，此处补 schema 声明以保持迁移与 ORM 一致。
// RLS policy 仅按 workspace_id 隔离（与迁移一致）。

/** 0162 §17.5 step 17：post-activation 消费台账（共享对账，绝写个人投影）。 */
export const cardGenerationPostActivationConsumptions = pgTable(
  "card_generation_post_activation_consumptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRunsV2.id, { onDelete: "cascade" }),
    receiptId: uuid("receipt_id").notNull(),
    cardIds: uuid("card_ids").array().notNull(),
    objectiveIds: uuid("objective_ids").array().notNull(),
    reconciledCardCount: integer("reconciled_card_count").notNull(),
    reconciledObjectiveCount: integer("reconciled_objective_count").notNull(),
    personalProjectionWrites: integer("personal_projection_writes").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsReceiptUnique: unique("cgpa_v2_ws_receipt_unique").on(t.workspaceId, t.receiptId),
    zeroPersonalWritesCheck: check("cgpa_v2_zero_personal_writes_chk", sql`${t.personalProjectionWrites} = 0`),
    wsRunIdx: index("cgpa_v2_ws_run_idx").on(t.workspaceId, t.runId),
  }),
);

// ─── Plan 23 W1-01..W1-04: Objective Origin（迁移 0175）────────────────────
// 知识血缘属于 Objective revision（§3.3），不挂在可替换的 Card Presentation。
// origin_kind 条件字段由 DB CHECK 约束（W1-02）；正式消费者以 objectiveId 读取。

export const objectiveOriginKindV3Values = [
  "note",
  "manual",
  "imported",
] as const;
export type ObjectiveOriginKindV3 = (typeof objectiveOriginKindV3Values)[number];

export const learningObjectiveOriginsV2 = pgTable(
  "learning_objective_origins_v2",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    originId: uuid("origin_id").notNull(),
    objectiveId: uuid("objective_id").notNull(),
    objectiveRevisionId: uuid("objective_revision_id").notNull(),
    originKind: text("origin_kind").$type<ObjectiveOriginKindV3>().notNull(),
    // note kind：主来源（可多 note 并行；一 note 只能绑定一次）
    noteId: uuid("note_id"),
    noteVersionId: uuid("note_version_id"),
    sourceSnapshotId: uuid("source_snapshot_id"),
    evidenceSnapshotIds: uuid("evidence_snapshot_ids").array().notNull().default(sql`'{}'::uuid[]`),
    // imported kind
    importBatchRef: text("import_batch_ref"),
    integrity: text("integrity").notNull().default("verified"),
    provenance: jsonb("provenance").notNull().default(sql`'{}'::jsonb`),
    boundAt: timestamp("bound_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    originIdUnique: uniqueIndex("loo_v2_origin_id_unique_idx").on(t.workspaceId, t.originId),
    noteBindingUnique: uniqueIndex("loo_v2_note_binding_unique_idx")
      .on(t.workspaceId, t.objectiveRevisionId, t.noteVersionId)
      .where(sql`${t.originKind} = 'note' AND ${t.noteVersionId} IS NOT NULL`),
    objectiveIdx: index("loo_v2_objective_idx").on(t.workspaceId, t.objectiveId, t.objectiveRevisionId),
    noteIdx: index("loo_v2_note_idx").on(t.workspaceId, t.noteId, t.noteVersionId),
    sourceIdx: index("loo_v2_source_idx").on(t.workspaceId, t.sourceSnapshotId),
    kindCheck: check("loo_v2_kind_chk", sql`${t.originKind} IN ('note','manual','imported')`),
    integrityCheck: check("loo_v2_integrity_chk", sql`${t.integrity} IN ('verified','legacy_unreviewed')`),
    kindFieldsCheck: check("loo_v2_kind_fields_chk", sql`(
      (${t.originKind} = 'note' AND ${t.noteId} IS NOT NULL AND ${t.noteVersionId} IS NOT NULL
        AND ${t.importBatchRef} IS NULL)
      OR (${t.originKind} = 'manual' AND ${t.noteId} IS NULL AND ${t.noteVersionId} IS NULL
        AND ${t.importBatchRef} IS NULL)
      OR (${t.originKind} = 'imported' AND ${t.importBatchRef} IS NOT NULL
        AND ${t.noteId} IS NULL AND ${t.noteVersionId} IS NULL)
    )`),
  }),
);
