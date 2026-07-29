import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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

export type CardGenerationImageExclusion = {
  sourceUnitId: string;
  kind: "image";
  inputHash: string;
  imageAssetId: string;
  imageBlockId: string;
  errorCode: string | null;
};

export type CardGenerationExclusionPolicy = {
  mode: "explicit_image_exclusions_v1";
  sourceRunId: string;
  requestedBy: string;
  requestedAt: string;
  requestedUnitIds?: string[];
  excludedUnits: CardGenerationImageExclusion[];
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
    pipelineVersion: text("pipeline_version").notNull().default("card-generation-v2-m1"),
    promptBundleVersion: text("prompt_bundle_version").notNull().default("legacy-card-v1"),
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
    legacyJobId: uuid("legacy_job_id"),
    exclusionPolicy: jsonb("exclusion_policy").$type<CardGenerationExclusionPolicy | null>(),
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
      .where(sql`${t.status} NOT IN ('partial_ready', 'succeeded', 'cancelled', 'superseded')`),
    noteCreatedIdx: index("card_generation_runs_note_created_idx")
      .on(t.workspaceId, t.noteId, t.createdAt),
    statusIdx: index("card_generation_runs_status_idx")
      .on(t.workspaceId, t.status, t.updatedAt),
    m5TerminalResult: check(
      "card_generation_runs_m5_terminal_result_check",
      sql`
        ${t.pipelineVersion} <> 'card-generation-v2-m5'
        OR ${t.status} NOT IN ('succeeded', 'partial_ready')
        OR (
          ${t.resultCardSetId} IS NOT NULL
          AND ${t.resultCardId} IS NOT NULL
        )
      `,
    ),
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
    pipelineVersion: text("pipeline_version").notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("card_generation_units_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    workspaceRunIdUnique: uniqueIndex("card_generation_units_workspace_run_id_unique_idx")
      .on(t.workspaceId, t.runId, t.id),
    identityUnique: uniqueIndex("card_generation_units_identity_unique_idx")
      .on(t.runId, t.kind, t.level, t.ordinal, t.pipelineVersion),
    runStatusIdx: index("card_generation_units_run_status_idx")
      .on(t.workspaceId, t.runId, t.kind, t.status, t.ordinal),
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
