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
import { cardStatusEnum } from "./enums.ts";
import { noteVersions } from "./note.ts";

export const learningCards = pgTable(
  "learning_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteVersionId: uuid("note_version_id").notNull().references(() => noteVersions.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    status: cardStatusEnum("status").notNull().default("active"),
    schemaJson: jsonb("schema_json").$type<{
      title: string;
      summary: string;
    }>().notNull(),
    artifactId: uuid("artifact_id"),
    supersededByCardId: uuid("superseded_by_card_id"), // regenerate 时指向新卡
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // CONC-10-edge: 专用标记列，仅在 deleteNote 归档卡片时设为 deletedAt，
    // restoreDeletedNote 恢复时用此列精确匹配并清除。不受其他操作（如
    // card/service archiveCard）覆盖 updatedAt 的影响。
    archivedByNoteDeletionAt: timestamp("archived_by_note_deletion_at", { withTimezone: true }),
  },
  (t) => ({
    noteIdx: index("learning_cards_note_idx").on(t.noteVersionId),
    workspaceIdx: index("learning_cards_workspace_idx").on(t.workspaceId),
    activeVersionUniqueIdx: uniqueIndex("learning_cards_workspace_note_version_active_unique_idx")
      .on(t.workspaceId, t.noteVersionId)
      .where(sql`${t.status} = 'active'`),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    cardIdx: index("card_key_points_card_idx").on(t.cardId, t.ordinal),
  }),
);
