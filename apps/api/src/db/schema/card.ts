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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { cardStatusEnum } from "./enums.ts";
import { notes, noteVersions } from "./note.ts";

export type LearningCardCoverageWarning = {
  code: "partial_generation";
  excludedImageCount: number;
  excludedUnitIds: string[];
  excludedImages: Array<{
    sourceUnitId: string;
    imageAssetId: string;
    imageBlockId: string;
    reason: string;
  }>;
};

export type LearningCardSetStatus =
  | "draft"
  | "active"
  | "partial_ready"
  | "superseded"
  | "archived";

export type LearningCardScope = "overview" | "section";

export type LearningCardSetCoverageReport = Record<string, unknown>;

export const learningCardSets = pgTable(
  "learning_card_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    noteVersionId: uuid("note_version_id").notNull().references(() => noteVersions.id, { onDelete: "cascade" }),
    // The tenant-safe run/note/version relationship is a composite FK in 0048.
    generationRunId: uuid("generation_run_id").notNull(),
    status: text("status").$type<LearningCardSetStatus>().notNull().default("draft"),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    coverageReport: jsonb("coverage_report")
      .$type<LearningCardSetCoverageReport>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("learning_card_sets_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    generationRunUnique: uniqueIndex("learning_card_sets_generation_run_unique_idx")
      .on(t.workspaceId, t.generationRunId),
    generationIdentityUnique: uniqueIndex("learning_card_sets_generation_identity_unique_idx")
      .on(t.workspaceId, t.generationRunId, t.id),
    activeNoteUnique: uniqueIndex("learning_card_sets_active_note_unique_idx")
      .on(t.workspaceId, t.noteId)
      .where(sql`${t.status} = 'active'`),
    noteVersionIdx: index("learning_card_sets_note_version_idx")
      .on(t.workspaceId, t.noteId, t.noteVersionId, t.createdAt),
    statusIdx: index("learning_card_sets_status_idx")
      .on(t.workspaceId, t.status, t.createdAt),
  }),
);

export const learningCards = pgTable(
  "learning_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteVersionId: uuid("note_version_id").notNull().references(() => noteVersions.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    // Cross-module provenance uses one composite FK in 0048 so the set and run
    // cannot be mixed across tenants. These remain nullable for legacy cards.
    cardSetId: uuid("card_set_id"),
    generationRunId: uuid("generation_run_id"),
    scope: text("scope").$type<LearningCardScope>(),
    scopeKey: text("scope_key"),
    ordinal: integer("ordinal"),
    status: cardStatusEnum("status").notNull().default("active"),
    schemaJson: jsonb("schema_json").$type<{
      title: string;
      summary: string;
      coverageWarning?: LearningCardCoverageWarning;
    }>().notNull(),
    artifactId: uuid("artifact_id"),
    supersededByCardId: uuid("superseded_by_card_id"), // regenerate 时指向新卡
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // CONC-10-edge: 专用标记列，仅在 deleteNote 归档卡片时设为 deletedAt，
    // restoreDeletedNote 恢复时用此列精确匹配并清除。不受其他操作（如
    // card/service archiveCard）覆盖 updatedAt 的影响。
    archivedByNoteDeletionAt: timestamp("archived_by_note_deletion_at", { withTimezone: true }),
    // Plan 23 W1-06：显式 alias/迁移角色。正式 consumer predicate 必须排除
    // objective_fk_alias/hidden_identity/migration_only（迁移 0175，§21.5）。
    compatibilityRole: text("compatibility_role"),
  },
  (t) => ({
    noteIdx: index("learning_cards_note_idx").on(t.noteVersionId),
    workspaceIdx: index("learning_cards_workspace_idx").on(t.workspaceId),
    // 2026-08-12（schema 完整性审计）：0114 列表排序索引（workspace + created_at DESC）
    workspaceCreatedIdx: index("learning_cards_workspace_created_idx")
      .on(t.workspaceId, sql`${t.createdAt} desc`),
    activeVersionIdx: index("learning_cards_workspace_note_version_active_idx")
      .on(t.workspaceId, t.noteVersionId)
      .where(sql`${t.status} = 'active'`),
    legacyActiveVersionUnique: uniqueIndex(
      "learning_cards_workspace_note_version_legacy_active_unique_idx",
    )
      .on(t.workspaceId, t.noteVersionId)
      .where(sql`${t.status} = 'active' AND ${t.cardSetId} IS NULL`),
    setIdx: index("learning_cards_set_idx")
      .on(t.workspaceId, t.cardSetId, t.ordinal),
    generationRunIdx: index("learning_cards_generation_run_idx")
      .on(t.workspaceId, t.generationRunId),
    generationSetIdentityUnique: uniqueIndex(
      "learning_cards_generation_set_identity_unique_idx",
    ).on(t.workspaceId, t.generationRunId, t.cardSetId, t.id),
    setOrdinalUnique: uniqueIndex("learning_cards_set_ordinal_unique_idx")
      .on(t.workspaceId, t.cardSetId, t.ordinal)
      .where(sql`${t.cardSetId} IS NOT NULL AND ${t.ordinal} IS NOT NULL`),
    setScopeKeyUnique: uniqueIndex("learning_cards_set_scope_key_unique_idx")
      .on(t.workspaceId, t.cardSetId, t.scopeKey)
      .where(sql`${t.cardSetId} IS NOT NULL AND ${t.scopeKey} IS NOT NULL`),
    setOverviewUnique: uniqueIndex("learning_cards_set_overview_unique_idx")
      .on(t.workspaceId, t.cardSetId)
      .where(sql`${t.cardSetId} IS NOT NULL AND ${t.scope} = 'overview'`),
    cardSetShape: check(
      "learning_cards_card_set_shape_check",
      sql`
        (
          ${t.cardSetId} IS NULL
          AND ${t.generationRunId} IS NULL
          AND ${t.scope} IS NULL
          AND ${t.scopeKey} IS NULL
          AND ${t.ordinal} IS NULL
        )
        OR
        (
          ${t.cardSetId} IS NOT NULL
          AND ${t.generationRunId} IS NOT NULL
          AND ${t.scopeKey} IS NOT NULL
          AND length(trim(${t.scopeKey})) > 0
          AND ${t.ordinal} IS NOT NULL
          AND (
            (${t.scope} = 'overview' AND ${t.ordinal} = 0)
            OR (${t.scope} = 'section' AND ${t.ordinal} > 0)
          )
        )
      `,
    ),

    idWorkspaceUnique: uniqueIndex("learning_cards_id_workspace_unique").on(t.id, t.workspaceId),
    workspaceIdUniqueIdx: uniqueIndex("learning_cards_workspace_id_unique_idx").on(t.workspaceId, t.id),
  }),
);

export const cardKeyPoints = pgTable(
  "card_key_points",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cardId: uuid("card_id").notNull().references(() => learningCards.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    claim: text("claim").notNull(),
    quoteText: text("quote_text").notNull(),
    segmentRef: jsonb("segment_ref").$type<{ blockId?: string; blockOrdinal?: number } | null>().default(null),
    candidateId: uuid("candidate_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    cardIdx: index("card_key_points_card_idx").on(t.cardId, t.ordinal),
    candidateIdx: uniqueIndex("card_key_points_candidate_unique_idx")
      .on(t.workspaceId, t.candidateId)
      .where(sql`${t.candidateId} IS NOT NULL`),

    idWorkspaceUnique: uniqueIndex("card_key_points_id_workspace_unique").on(t.id, t.workspaceId),}),
);
