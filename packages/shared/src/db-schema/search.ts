import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * 搜索投影表（V0.3 引入）。
 * 使用 pg_trgm 扩展 + ILIKE 进行中文友好的全文搜索。
 * 同步写入：Note/Card/Source/Evidence 创建或更新时同步 upsert。
 */
export const searchDocuments = pgTable(
  "search_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    objectType: text("object_type").notNull(), // note | source | objective
    objectId: uuid("object_id").notNull(),
    title: text("title"),
    body: text("body"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceTypeIdx: index("search_documents_workspace_type_idx").on(t.workspaceId, t.objectType),
    objectIdx: uniqueIndex("search_documents_object_idx").on(t.workspaceId, t.objectType, t.objectId),

    bodyTrgmIdx: index("search_documents_body_trgm_idx").using("gin", sql`${t.body} gin_trgm_ops`),
    titleTrgmIdx: index("search_documents_title_trgm_idx").using("gin", sql`${t.title} gin_trgm_ops`),
  }),
);
