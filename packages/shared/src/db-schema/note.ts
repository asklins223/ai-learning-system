import { pgTable, uuid, text, integer, bigint, customType, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users, workspaces } from "./identity.ts";
import { sourceStatusEnum } from "./enums.ts";

/**
 * drizzle-orm 0.45 的 pg-core 没有内置 bytea（只有 PgBinaryVector），所以 CRDT 快照
 * 这一列要自己声明。读写都是原样透传：Postgres 的 bytea 驱动层已经是 Buffer，
 * 自己再做一次 base64 只会让"快照落盘再读回"多一个可能出错的环节。
 */
const bytea = customType<{ data: Uint8Array; driverParam: Uint8Array | Buffer }>({
  dataType() {
    return "bytea";
  },
  // 驱动只认 Buffer（node-postgres 的 bytea 序列化路径），而 yjs 给的是 Uint8Array。
  toDriver: (value: unknown) => Buffer.from(value as Uint8Array),
  fromDriver: (value: unknown) => value as Uint8Array,
});

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
    // 0153 的 (workspace_id, updated_at DESC) 只服务过 created_at 排序的旧查询；
    // 0225 补齐游标分页真正需要的三列，listSources 按 updated_at DESC + id 走索引。
    workspaceUpdatedIdx: index("sources_workspace_updated_idx")
      .on(t.workspaceId, sql`${t.updatedAt} desc`, t.id),

    idWorkspaceUnique: uniqueIndex("sources_id_workspace_unique").on(t.id, t.workspaceId),}),
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
    /**
     * 归属：`private` = 界面上的「仅自己可见」，`shared` = 「已共享给空间」。
     *
     * 不能从 `workspaceId` 推出来（协作空间里同样有只给自己的笔记），也不能从
     * `createdBy` 推出来（作者写的同样可以共享出去）。界面文案刻意不叫"个人笔记"。
     * 判据只有一处实现：`apps/api/src/modules/note/visibility.ts`。
     */
    shareScope: text("share_scope").notNull().default("private"), // private | shared
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
    // 2026-08-12（schema 完整性审计）：0114 列表排序索引（workspace + updated_at DESC）
    activeUpdatedIdx: index("notes_active_updated_idx")
      .on(t.workspaceId, sql`${t.updatedAt} desc`)
      .where(sql`${t.deletedAt} IS NULL`),
    // 2026-08-12（schema 完整性审计）：0044:17 租户安全复合唯一此前未声明
    workspaceIdUniqueIdx: uniqueIndex("notes_workspace_id_unique_idx").on(t.workspaceId, t.id),
    // 2026-08-12（generate 对齐）：0011 N-007 (id, workspace_id) 复合唯一
    idWorkspaceUnique: uniqueIndex("notes_id_workspace_unique").on(t.id, t.workspaceId),
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
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    sealedReason: text("sealed_reason"),
  },
  (t) => ({
    noteIdx: index("note_versions_note_idx").on(t.noteId, t.versionNo),
    uniqueNoteVersion: uniqueIndex("note_versions_unique_idx").on(t.noteId, t.versionNo),
    contentHashIdx: index("note_versions_content_hash_idx").on(t.noteId, t.contentHash),
    // 2026-08-12（schema 完整性审计）：0044:19 租户安全复合唯一此前未声明
    workspaceNoteIdIdUniqueIdx: uniqueIndex("note_versions_workspace_note_id_id_unique_idx")
      .on(t.workspaceId, t.noteId, t.id),
    // 2026-08-12（generate 对齐）：0011 N-007 (id, workspace_id) 复合唯一
    idWorkspaceUnique: uniqueIndex("note_versions_id_workspace_unique").on(t.id, t.workspaceId),
    // 2026-08-12（generate 对齐）：0044 (workspace_id, id) 复合唯一
    workspaceIdUniqueIdx: uniqueIndex("note_versions_workspace_id_unique_idx").on(t.workspaceId, t.id),
  }),
);

/**
 * Immutable identity for an uploaded note image. Markdown remains a rendering
 * compatibility layer; generation and evidence use this typed asset instead.
 */
export const noteImageAssets = pgTable(
  "note_image_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    uploadedForNoteId: uuid("uploaded_for_note_id").references(() => notes.id, { onDelete: "set null" }),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    status: text("status").notNull().default("ready"),
    normalizedObjectKey: text("normalized_object_key"),
    thumbnailObjectKey: text("thumbnail_object_key"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    workspaceIdUnique: uniqueIndex("note_image_assets_workspace_id_unique_idx")
      .on(t.workspaceId, t.id),
    workspaceObjectKeyUnique: uniqueIndex("note_image_assets_workspace_object_key_unique_idx")
      .on(t.workspaceId, t.objectKey),
    workspaceHashIdx: index("note_image_assets_workspace_hash_idx")
      .on(t.workspaceId, t.sha256),
    noteIdx: index("note_image_assets_note_idx")
      .on(t.workspaceId, t.uploadedForNoteId, t.createdAt),
    // 2026-08-12（schema 完整性审计）：0114 (workspace_id, status) 查询索引
    workspaceStatusIdx: index("note_image_assets_workspace_status_idx")
      .on(t.workspaceId, t.status),
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
    imageAssetId: uuid("image_asset_id").references(() => noteImageAssets.id, { onDelete: "restrict" }),
    sourceRef: jsonb("source_ref").$type<{ sourceId?: string; segmentId?: string } | null>().default(null),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    versionIdx: index("note_blocks_version_idx").on(t.versionId, t.ordinal),
    imageAssetIdx: index("note_blocks_image_asset_idx").on(t.workspaceId, t.imageAssetId),

    idWorkspaceUnique: uniqueIndex("note_blocks_id_workspace_unique").on(t.id, t.workspaceId),
    workspaceVersionIdUnique: uniqueIndex("note_blocks_workspace_version_id_unique_idx").on(t.workspaceId, t.versionId, t.id),}),
);

/**
 * 笔记正文的 CRDT 文档状态（迁移 0244）。一行 = 一篇笔记当前 Y.Doc 的快照。
 *
 * 从这张表起，正文的事实源是 Y.Doc，`note_blocks` 是由它派生的投影关系表。
 * 组合外键挡住"note_id 属于 A 空间、workspace_id 写 B 空间"的行——那种行会让
 * RLS 的 workspace 判定形同虚设。
 */
export const noteDocumentStates = pgTable(
  "note_document_states",
  {
    noteId: uuid("note_id").primaryKey().references(() => notes.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    state: bytea("state").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdx: index("note_document_states_workspace_idx").on(t.workspaceId),
  }),
);
