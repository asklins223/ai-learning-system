import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AgentRole,
  DeckDraft,
  RunBudget,
  ProviderUsage,
} from "@ailearn/shared";
import { users } from "./identity.ts";
import { noteBlocks, noteImageAssets, notes, noteVersions } from "./note.ts";

export type CardGenerationBlockManifestEntry = {
  blockId: string;
  ordinal: number;
  type: string;
  contentHash: string;
};

export type CardGenerationAssetManifestEntry = {
  blockId: string;
  ordinal: number;
  sourceHash: string;
  assetId?: string;
};

export const cardGenerationRuns = pgTable(
  "card_generation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    noteVersionId: uuid("note_version_id").notNull().references(() => noteVersions.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    requestIdempotencyKey: text("request_idempotency_key").notNull(),
    generationFingerprint: text("generation_fingerprint").notNull(),
    generationEpoch: integer("generation_epoch").notNull(),
    supersedesRunId: uuid("supersedes_run_id"),
    titleSnapshot: text("title_snapshot").notNull(),
    sourceContentHash: text("source_content_hash").notNull(),
    blockManifestHash: text("block_manifest_hash").notNull(),
    assetManifestHash: text("asset_manifest_hash").notNull(),
    blockManifest: jsonb("block_manifest")
      .$type<CardGenerationBlockManifestEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    assetManifest: jsonb("asset_manifest")
      .$type<CardGenerationAssetManifestEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // ── Supervisor Agent v1 字段（计划 §9.1） ──
    engineMode: text("engine_mode").notNull().default("supervisor_agent_v1"),
    shellVersion: text("shell_version"),
    supervisorPolicyVersion: text("supervisor_policy_version"),
    toolSchemaVersion: text("tool_schema_version"),
    plannerVersion: text("planner_version"),
    verifierVersion: text("verifier_version"),
    retrievalPolicyVersion: text("retrieval_policy_version"),
    embeddingProfileVersion: text("embedding_profile_version"),
    resultContractVersion: text("result_contract_version").notNull().default("result-contract-v1"),
    providerCapabilityFingerprint: text("provider_capability_fingerprint"),
    budgetSnapshot: jsonb("budget_snapshot").$type<RunBudget>().notNull().default(sql`'{}'::jsonb`),
    usageSummary: jsonb("usage_summary").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    verifiedDraftId: uuid("verified_draft_id"),
    verifiedDraftHash: text("verified_draft_hash"),
    qualityReportId: uuid("quality_report_id"),
    degradedCapabilities: jsonb("degraded_capabilities").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    providerSnapshot: jsonb("provider_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    governancePolicyVersion: text("governance_policy_version").notNull().default("workspace-policy-snapshot-v1"),
    status: text("status").notNull().default("queued"),
    stage: text("stage").notNull().default("queued"),
    stateVersion: integer("state_version").notNull().default(1),
    nextEventSequence: integer("next_event_sequence").notNull().default(1),
    errorCode: text("error_code"),
    retryable: boolean("retryable").notNull().default(false),
    requiredUnits: integer("required_units").notNull().default(0),
    completedUnits: integer("completed_units").notNull().default(0),
    failedUnits: integer("failed_units").notNull().default(0),
    requiredImages: integer("required_images").notNull().default(0),
    completedImages: integer("completed_images").notNull().default(0),
    sourceCoverageBps: integer("source_coverage_bps"),
    imageCoverageBps: integer("image_coverage_bps"),
    coverageReport: jsonb("coverage_report")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // 0048 binds (workspace, run, result set) with a tenant-safe composite FK.
    resultCardSetId: uuid("result_card_set_id"),
    resultCardId: uuid("result_card_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("card_generation_runs_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    workspaceIdentityUnique: uniqueIndex("card_generation_runs_workspace_identity_unique_idx")
      .on(t.workspaceId, t.id, t.noteId, t.noteVersionId),
    requestIdempotencyUnique: uniqueIndex("card_generation_runs_request_idem_unique_idx")
      .on(t.workspaceId, t.requestIdempotencyKey),
    noteEpochUnique: uniqueIndex("card_generation_runs_note_epoch_unique_idx")
      .on(t.workspaceId, t.noteId, t.generationEpoch),
    activeFingerprintUnique: uniqueIndex("card_generation_runs_active_fingerprint_unique_idx")
      .on(t.workspaceId, t.noteVersionId, t.generationFingerprint)
      .where(sql`${t.status} NOT IN ('partial_ready', 'succeeded', 'needs_attention', 'cancelled', 'superseded')`),
    noteCreatedIdx: index("card_generation_runs_note_created_idx")
      .on(t.workspaceId, t.noteId, t.createdAt),
    statusIdx: index("card_generation_runs_status_idx")
      .on(t.workspaceId, t.status, t.updatedAt),
    // ── Supervisor Agent v1 result contract check（计划 §9.1） ──
    resultContractCheck: check(
      "card_generation_runs_result_contract_check",
      sql`
        ${t.resultContractVersion} <> 'result-contract-v1'
        OR ${t.status} NOT IN ('succeeded', 'partial_ready')
        OR (
          ${t.resultCardSetId} IS NOT NULL
          AND ${t.resultCardId} IS NOT NULL
        )
      `,
    ),
    engineModeIdx: index("card_generation_runs_engine_mode_idx")
      .on(t.workspaceId, t.engineMode, t.status, t.updatedAt),
  }),
);

export const cardGenerationEvents = pgTable(
  "card_generation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRuns.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    sequence: integer("sequence").notNull(),
    stage: text("stage").notNull(),
    state: text("state").notNull(),
    completed: integer("completed"),
    total: integer("total"),
    unit: text("unit"),
    messageCode: text("message_code").notNull(),
    safeDetails: jsonb("safe_details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    runSequenceUnique: uniqueIndex("card_generation_events_run_sequence_unique_idx")
      .on(t.runId, t.sequence),
    workspaceRunIdx: index("card_generation_events_workspace_run_idx")
      .on(t.workspaceId, t.runId, t.sequence),
  }),
);

export type NoteEvidenceSectionPath = string[];

export type ImageEvidenceRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  page?: number;
};

export type NoteImageOcrRegion = {
  text: string;
  region: ImageEvidenceRegion;
  confidence: number;
};

export type NoteImageStructuredFact = {
  text: string;
  region: ImageEvidenceRegion;
  confidence: number;
  kind: "table" | "chart" | "diagram" | "formula" | "document" | "other";
};

/**
 * Exact, immutable coordinates into a sealed note block. The source text is
 * intentionally not duplicated here: callers recover it from block.content
 * and verify textHash before using it as evidence.
 */
export const noteEvidenceSpans = pgTable(
  "note_evidence_spans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    noteVersionId: uuid("note_version_id").notNull().references(() => noteVersions.id, { onDelete: "cascade" }),
    blockId: uuid("block_id").notNull().references(() => noteBlocks.id, { onDelete: "cascade" }),
    unitKey: text("unit_key").notNull(),
    plannerVersion: text("planner_version").notNull(),
    ordinal: integer("ordinal").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    textHash: text("text_hash").notNull(),
    sectionPath: jsonb("section_path")
      .$type<NoteEvidenceSectionPath>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sourceKind: text("source_kind").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("note_evidence_spans_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    versionUnitUnique: uniqueIndex("note_evidence_spans_version_unit_unique_idx")
      .on(t.workspaceId, t.noteVersionId, t.unitKey),
    blockOrdinalIdx: index("note_evidence_spans_block_ordinal_idx")
      .on(t.workspaceId, t.noteVersionId, t.blockId, t.ordinal),
  }),
);

/** Versioned and cacheable OCR/vision result for one immutable image asset. */
export const noteImageInsights = pgTable(
  "note_image_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    imageAssetId: uuid("image_asset_id").notNull().references(() => noteImageAssets.id, { onDelete: "cascade" }),
    cacheKey: text("cache_key").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    visionModelId: text("vision_model_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    governancePolicyVersion: text("governance_policy_version").notNull(),
    status: text("status").notNull().default("pending"),
    contentType: text("content_type"),
    caption: text("caption"),
    ocrJson: jsonb("ocr_json").$type<NoteImageOcrRegion[]>().notNull().default(sql`'[]'::jsonb`),
    factsJson: jsonb("facts_json").$type<NoteImageStructuredFact[]>().notNull().default(sql`'[]'::jsonb`),
    safetyJson: jsonb("safety_json").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    artifactHash: text("artifact_hash"),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("note_image_insights_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    assetCacheUnique: uniqueIndex("note_image_insights_asset_cache_unique_idx")
      .on(t.workspaceId, t.imageAssetId, t.cacheKey),
    statusIdx: index("note_image_insights_status_idx")
      .on(t.workspaceId, t.status, t.updatedAt),
  }),
);

/** Stable image-region evidence IDs consumed by Map and final card evidence. */
export const noteImageEvidenceUnits = pgTable(
  "note_image_evidence_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    imageInsightId: uuid("image_insight_id").notNull().references(() => noteImageInsights.id, { onDelete: "cascade" }),
    imageAssetId: uuid("image_asset_id").notNull().references(() => noteImageAssets.id, { onDelete: "cascade" }),
    unitKey: text("unit_key").notNull(),
    ordinal: integer("ordinal").notNull(),
    sourceKind: text("source_kind").notNull(),
    text: text("text").notNull(),
    textHash: text("text_hash").notNull(),
    region: jsonb("region").$type<ImageEvidenceRegion>().notNull(),
    confidenceBps: integer("confidence_bps").notNull(),
    evidenceLevel: text("evidence_level").notNull(),
    required: boolean("required").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("note_image_evidence_units_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    insightUnitUnique: uniqueIndex("note_image_evidence_units_insight_unit_unique_idx")
      .on(t.workspaceId, t.imageInsightId, t.unitKey),
    assetOrdinalIdx: index("note_image_evidence_units_asset_ordinal_idx")
      .on(t.workspaceId, t.imageAssetId, t.ordinal),
  }),
);

export type CardGenerationUnitInputManifest = {
  /** 生成密度（Supervisor Agent v1，plan §11.2） */
  density?: "overview" | "standard" | "complete";
  spanIds?: string[];
  spanUnitKeys?: string[];
  imageEvidenceUnitIds?: string[];
  imageAssetId?: string;
  imageInsightId?: string;
  imageBlockId?: string;
  userDescription?: string;
  selectedCandidateIds?: string[];
  candidateIds?: string[];
  scope?: "overview" | "section";
  scopeKey?: string;
  cardOrdinal?: number;
  titleHint?: string;
  sectionKeys?: string[];
  chunkOrdinal?: number;
  sectionPath?: string[];
  // ── Supervisor Agent v1 字段（计划 §9.2） ──
  agentRole?: AgentRole;
  taskSpec?: Record<string, unknown>;
  depth?: number;
};

/** Durable, independently retryable checkpoint; queue jobs are only leases. */
export const cardGenerationUnits = pgTable(
  "card_generation_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRuns.id, { onDelete: "cascade" }),
    parentUnitId: uuid("parent_unit_id"),
    kind: text("kind").notNull(),
    level: integer("level").notNull().default(0),
    ordinal: integer("ordinal").notNull(),
    unitKey: text("unit_key").notNull(),
    required: boolean("required").notNull().default(true),
    inputManifest: jsonb("input_manifest")
      .$type<CardGenerationUnitInputManifest>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    inputHash: text("input_hash").notNull(),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    artifactJson: jsonb("artifact_json").$type<Record<string, unknown> | null>(),
    artifactHash: text("artifact_hash"),
    errorCode: text("error_code"),
    // ── Supervisor Agent v1 字段（计划 §9.2） ──
    nodeContractVersion: text("node_contract_version"),
    budgetJson: jsonb("budget_json").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    cursorJson: jsonb("cursor_json").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    retryPolicyJson: jsonb("retry_policy_json").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("card_generation_units_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    workspaceRunIdUnique: uniqueIndex("card_generation_units_workspace_run_id_unique_idx")
      .on(t.workspaceId, t.runId, t.id),
    identityUnique: uniqueIndex("card_generation_units_identity_unique_idx")
      .on(t.runId, t.kind, t.level, t.ordinal),
    runStatusIdx: index("card_generation_units_run_status_idx")
      .on(t.workspaceId, t.runId, t.kind, t.status, t.ordinal),
    // ── Supervisor Agent v1：新增 (workspace, run, unit_key) 唯一约束 ──
    runUnitKeyUnique: uniqueIndex("card_generation_units_run_unit_key_unique_idx")
      .on(t.workspaceId, t.runId, t.unitKey),
  }),
);

export const cardGenerationCandidates = pgTable(
  "card_generation_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRuns.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull().references(() => cardGenerationUnits.id, { onDelete: "cascade" }),
    localOrdinal: integer("local_ordinal").notNull(),
    localId: text("local_id").notNull(),
    claim: text("claim").notNull(),
    normalizedClaimHash: text("normalized_claim_hash").notNull(),
    topic: text("topic").notNull(),
    sectionKey: text("section_key").notNull(),
    cognitiveType: text("cognitive_type").notNull(),
    importance: text("importance").notNull(),
    validationStatus: text("validation_status").notNull().default("accepted"),
    exclusionReason: text("exclusion_reason"),
    // ── Supervisor Agent v1 字段（计划 §9.5） ──
    candidateKind: text("candidate_kind").notNull().default("extracted"),
    // P1-09: 强制每个 candidate 恰好属于一个 owning bundle
    bundleId: text("bundle_id"),
    sourceStartOrdinal: integer("source_start_ordinal"),
    sectionKeys: jsonb("section_keys").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    primarySection: text("primary_section"),
    originAgentEventKey: text("origin_agent_event_key"),
    derivedCandidateIds: jsonb("derived_candidate_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    relationHints: jsonb("relation_hints").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    qualityMetadata: jsonb("quality_metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    importanceScore: doublePrecision("importance_score"),
    groupKey: text("group_key"),
    overviewScore: doublePrecision("overview_score"),
    supportMode: text("support_mode"),
    // P1-11: 候选难度（质量标准与密度约束）
    difficulty: text("difficulty"),
    semanticSupportStatus: text("semantic_support_status").notNull().default("pending"),
    semanticSupportScoreBps: integer("semantic_support_score_bps"),
    verifierVersion: text("verifier_version"),
    qualityReportId: uuid("quality_report_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("card_generation_candidates_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    workspaceRunIdUnique: uniqueIndex("card_generation_candidates_workspace_run_id_unique_idx")
      .on(t.workspaceId, t.runId, t.id),
    unitLocalUnique: uniqueIndex("card_generation_candidates_unit_local_unique_idx")
      .on(t.workspaceId, t.runId, t.unitId, t.localId),
    runStatusIdx: index("card_generation_candidates_run_status_idx")
      .on(t.workspaceId, t.runId, t.validationStatus, t.sectionKey),
    runKindIdx: index("card_generation_candidates_run_kind_idx")
      .on(t.workspaceId, t.runId, t.candidateKind, t.validationStatus),
  }),
);

export const cardGenerationCandidateEvidence = pgTable(
  "card_generation_candidate_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRuns.id, { onDelete: "cascade" }),
    noteVersionId: uuid("note_version_id").notNull().references(() => noteVersions.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id").notNull().references(() => cardGenerationCandidates.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull().default("text_span"),
    evidenceSpanId: uuid("evidence_span_id").references(() => noteEvidenceSpans.id, { onDelete: "cascade" }),
    imageEvidenceUnitId: uuid("image_evidence_unit_id").references(() => noteImageEvidenceUnits.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    // ── Supervisor Agent v1：来源真实性与语义支撑拆层（计划 §7.3, §9.7） ──
    sourceVerificationStatus: text("source_verification_status").notNull().default("pending"),
    sourceVerificationMethod: text("source_verification_method"),
    semanticSupportStatus: text("semantic_support_status").notNull().default("pending"),
    semanticSupportScoreBps: integer("semantic_support_score_bps"),
    verifierVersion: text("verifier_version"),
    qualityReportId: uuid("quality_report_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    candidateSpanUnique: uniqueIndex("card_generation_candidate_evidence_unique_idx")
      .on(t.candidateId, t.evidenceSpanId),
    candidateImageUnique: uniqueIndex("card_generation_candidate_image_evidence_unique_idx")
      .on(t.candidateId, t.imageEvidenceUnitId),
    workspaceCandidateIdx: index("card_generation_candidate_evidence_candidate_idx")
      .on(t.workspaceId, t.runId, t.candidateId, t.ordinal),
    workspaceSpanIdx: index("card_generation_candidate_evidence_span_idx")
      .on(t.workspaceId, t.noteVersionId, t.evidenceSpanId),
    workspaceImageIdx: index("card_generation_candidate_evidence_image_idx")
      .on(t.workspaceId, t.imageEvidenceUnitId),
  }),
);

// ─── Supervisor Agent v1：Agent Events（计划 §9.3） ─────────────────────
// 一张 append-only 表统一承载所有 Agent 事件
export const cardGenerationAgentEvents = pgTable(
  "card_generation_agent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRuns.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").references(() => cardGenerationUnits.id, { onDelete: "cascade" }),
    parentUnitId: uuid("parent_unit_id"),
    childUnitId: uuid("child_unit_id"),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    agentRole: text("agent_role"),
    turnNo: integer("turn_no"),
    attemptNo: integer("attempt_no"),
    toolName: text("tool_name"),
    toolVersion: text("tool_version"),
    inputHash: text("input_hash"),
    outputHash: text("output_hash"),
    safePayload: jsonb("safe_payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    usage: jsonb("usage").$type<ProviderUsage>().notNull().default(sql`'{}'::jsonb`),
    providerRequestId: text("provider_request_id"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    eventKeyUnique: uniqueIndex("card_generation_agent_events_event_key_unique_idx")
      .on(t.workspaceId, t.runId, t.eventKey),
    workspaceRunIdx: index("card_generation_agent_events_workspace_run_idx")
      .on(t.workspaceId, t.runId, t.createdAt),
    unitIdx: index("card_generation_agent_events_unit_idx")
      .on(t.workspaceId, t.runId, t.unitId, t.turnNo),
  }),
);

// ─── Supervisor Agent v1：Source Bundle Ledger（计划 §9.4） ─────────────
// 语义上下文 bundle 和 coverage decision
export const cardGenerationSourceBundles = pgTable(
  "card_generation_source_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRuns.id, { onDelete: "cascade" }),
    noteVersionId: uuid("note_version_id").notNull(),
    bundleKey: text("bundle_key").notNull(),
    bundleOrdinal: integer("bundle_ordinal").notNull(),
    sectionPath: jsonb("section_path").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    sourceStartOrdinal: integer("source_start_ordinal").notNull(),
    tokenEstimate: integer("token_estimate").notNull().default(0),
    inputHash: text("input_hash").notNull(),
    required: boolean("required").notNull().default(true),
    assignmentStatus: text("assignment_status").notNull().default("pending"),
    assignedAgentUnitId: uuid("assigned_agent_unit_id"),
    decisionStatus: text("decision_status").notNull().default("pending"),
    decisionReason: text("decision_reason"),
    decidedEventKey: text("decided_event_key"),
    // QUAL-33 修复：持久化每 bundle 的候选计数，避免崩溃恢复后 candidateSurvivalCoverage 不准确
    candidateCount: integer("candidate_count").notNull().default(0),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("card_generation_source_bundles_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    runKeyUnique: uniqueIndex("card_generation_source_bundles_run_key_unique_idx")
      .on(t.workspaceId, t.runId, t.bundleKey),
    runOrdinalIdx: index("card_generation_source_bundles_run_ordinal_idx")
      .on(t.workspaceId, t.runId, t.bundleOrdinal),
    assignmentIdx: index("card_generation_source_bundles_assignment_idx")
      .on(t.workspaceId, t.runId, t.assignmentStatus, t.bundleOrdinal),
  }),
);

// ─── Supervisor Agent v1：Bundle Members（计划 §9.4） ───────────────────
// typed text/image evidence reference，primary | context_only
export const cardGenerationSourceBundleMembers = pgTable(
  "card_generation_source_bundle_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRuns.id, { onDelete: "cascade" }),
    bundleId: uuid("bundle_id").notNull().references(() => cardGenerationSourceBundles.id, { onDelete: "cascade" }),
    memberOrdinal: integer("member_ordinal").notNull(),
    evidenceRefType: text("evidence_ref_type").notNull(),
    evidenceSpanId: uuid("evidence_span_id").references(() => noteEvidenceSpans.id, { onDelete: "cascade" }),
    imageEvidenceUnitId: uuid("image_evidence_unit_id").references(() => noteImageEvidenceUnits.id, { onDelete: "cascade" }),
    membership: text("membership").notNull().default("primary"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("card_generation_source_bundle_members_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    bundleIdx: index("card_generation_source_bundle_members_bundle_idx")
      .on(t.workspaceId, t.runId, t.bundleId, t.memberOrdinal),
    primarySpanUnique: uniqueIndex("card_generation_source_bundle_members_primary_span_unique_idx")
      .on(t.runId, t.evidenceSpanId)
      .where(sql`${t.evidenceSpanId} IS NOT NULL AND ${t.membership} = 'primary'`),
    primaryImageUnique: uniqueIndex("card_generation_source_bundle_members_primary_image_unique_idx")
      .on(t.runId, t.imageEvidenceUnitId)
      .where(sql`${t.imageEvidenceUnitId} IS NOT NULL AND ${t.membership} = 'primary'`),
    xorCheck: check(
      "card_generation_source_bundle_members_xor_check",
      sql`(${t.evidenceSpanId} IS NOT NULL)::integer + (${t.imageEvidenceUnitId} IS NOT NULL)::integer = 1`,
    ),
  }),
);

// ─── Supervisor Agent v1：Immutable Draft（计划 §9.6） ─────────────────
// Draft 只插入，不原地更新
export const cardGenerationDrafts = pgTable(
  "card_generation_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRuns.id, { onDelete: "cascade" }),
    draftVersion: integer("draft_version").notNull(),
    parentDraftId: uuid("parent_draft_id"),
    producedByUnitId: uuid("produced_by_unit_id").notNull(),
    producedByEventKey: text("produced_by_event_key").notNull(),
    schemaVersion: text("schema_version").notNull(),
    contentJson: jsonb("content_json").$type<DeckDraft>().notNull(),
    contentHash: text("content_hash").notNull(),
    deckTitle: text("deck_title").notNull(),
    deckSummary: text("deck_summary").notNull(),
    density: text("density").notNull().default("standard"),
    cardBudget: integer("card_budget").notNull(),
    baseLedgerHash: text("base_ledger_hash").notNull(),
    summarySupportCandidateIds: jsonb("summary_support_candidate_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("card_generation_drafts_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    runVersionUnique: uniqueIndex("card_generation_drafts_run_version_unique_idx")
      .on(t.workspaceId, t.runId, t.draftVersion),
    runHashIdx: index("card_generation_drafts_run_hash_idx")
      .on(t.workspaceId, t.runId, t.contentHash),
  }),
);

// ─── Supervisor Agent v1：Quality Report（计划 §9.6） ───────────────────
// Repair 后创建新 Draft，旧 report 自动失效
export const cardGenerationQualityReports = pgTable(
  "card_generation_quality_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    runId: uuid("run_id").notNull().references(() => cardGenerationRuns.id, { onDelete: "cascade" }),
    draftId: uuid("draft_id").notNull().references(() => cardGenerationDrafts.id, { onDelete: "cascade" }),
    draftHash: text("draft_hash").notNull(),
    candidatePoolHash: text("candidate_pool_hash").notNull(),
    sourceLedgerHash: text("source_ledger_hash").notNull(),
    criticVersion: text("critic_version").notNull(),
    verifierVersion: text("verifier_version").notNull(),
    hardIssues: jsonb("hard_issues").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    softIssues: jsonb("soft_issues").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    perClaimVerdicts: jsonb("per_claim_verdicts").$type<Record<string, unknown>[]>().notNull().default(sql`'[]'::jsonb`),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    criticStatus: text("critic_status").notNull().default("pending"),
    deterministicStatus: text("deterministic_status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("card_generation_quality_reports_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    draftHashIdx: index("card_generation_quality_reports_draft_hash_idx")
      .on(t.workspaceId, t.runId, t.draftHash),
  }),
);

// ─── Supervisor Agent v1：Note Evidence Embeddings（计划 §7.4, §9.7） ───
// 固定 vector(D) profile，typed source ref、source/input hash、model revision
// 使用自定义类型向量（运行时由 SQL migration 创建 vector(1024) 列）
export const noteEvidenceEmbeddings = pgTable(
  "note_evidence_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    noteVersionId: uuid("note_version_id").notNull(),
    evidenceRefType: text("evidence_ref_type").notNull(),
    evidenceSpanId: uuid("evidence_span_id").references(() => noteEvidenceSpans.id, { onDelete: "cascade" }),
    imageEvidenceUnitId: uuid("image_evidence_unit_id").references(() => noteImageEvidenceUnits.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id"),
    bundleId: uuid("bundle_id"),
    sourceHash: text("source_hash").notNull(),
    inputHash: text("input_hash").notNull(),
    modelRevision: text("model_revision").notNull(),
    dimensions: integer("dimensions").notNull(),
    // embedding 列由 SQL migration 直接创建为 vector(1024)，Drizzle schema 中标记为 jsonb 占位
    embedding: jsonb("embedding").$type<unknown>().notNull(),
    profileVersion: text("profile_version").notNull().default("card-evidence-v1"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("note_evidence_embeddings_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    versionProfileIdx: index("note_evidence_embeddings_version_profile_idx")
      .on(t.workspaceId, t.noteVersionId, t.profileVersion, t.status),
    sourceHashIdx: index("note_evidence_embeddings_source_hash_idx")
      .on(t.workspaceId, t.noteVersionId, t.sourceHash),
  }),
);
