import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";
import { sourceStatusEnum } from "./enums.ts";

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    type: text("type").notNull(), // text | markdown | code | url
    title: text("title").notNull(),
    origin: text("origin"), // url / filename / null
    status: sourceStatusEnum("status").notNull().default("draft"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdx: index("sources_workspace_idx").on(t.workspaceId),
  }),
);

export const sourceSegments = pgTable(
  "source_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    segmentType: text("segment_type").notNull().default("paragraph"), // paragraph | heading | code | quote | list
  },
  (t) => ({
    sourceIdx: index("source_segments_source_idx").on(t.sourceId, t.ordinal),
  }),
);

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    title: text("title").notNull(),
    titleSource: text("title_source").notNull().default("auto"), // auto | manual
    currentVersionId: uuid("current_version_id"),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }), // nullable，指向 sources.id，手写笔记为 null
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    // CONC-03: 软删除标记，NULL 表示未删除。30 天后由定时任务物理删除。
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    workspaceIdx: index("notes_workspace_idx").on(t.workspaceId),
    sourceIdx: index("notes_source_idx").on(t.sourceId),
    // 查询 deleted_at IS NULL 时使用部分索引
    activeNotesIdx: index("notes_active_idx").on(t.workspaceId).where(sql`${t.deletedAt} IS NULL`),
  }),
);

export const noteVersions = pgTable(
  "note_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    versionNo: integer("version_no").notNull(),
    contentJson: jsonb("content_json").$type<unknown>().notNull(),
    contentHash: text("content_hash").notNull(),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // isAutosave 原地更新时刷新；未更新过则等于 createdAt
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    noteIdx: index("note_versions_note_idx").on(t.noteId, t.versionNo),
    uniqueNoteVersion: uniqueIndex("note_versions_unique_idx").on(t.noteId, t.versionNo),
    contentHashIdx: index("note_versions_content_hash_idx").on(t.noteId, t.contentHash),
  }),
);

export const noteBlocks = pgTable(
  "note_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionId: uuid("version_id").notNull().references(() => noteVersions.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    type: text("type").notNull(), // paragraph | heading | code | list | quote | image
    content: text("content").notNull(),
    sourceRef: jsonb("source_ref").$type<{ sourceId?: string; segmentId?: string } | null>().default(null),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    versionIdx: index("note_blocks_version_idx").on(t.versionId, t.ordinal),
  }),
);
