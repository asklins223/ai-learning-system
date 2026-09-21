/**
 * 真桌宠记忆与上下文（22-real-desktop-pet-memory-context-prd-tdd.md）新增表。
 *
 * 包含：assistant_memory_embeddings / pet_profiles / memory_links /
 * conversation_summaries / memory_usage_log / companion_daily_summaries。
 * 所有表均按 workspace_id + user_id 启用 RLS，与现有 companion 表一致。
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  real,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

/** pgvector 派生索引：只由 Worker 写入；Drizzle 中以 jsonb 占位 vector(1024)。 */
export const assistantMemoryEmbeddings = pgTable(
  "assistant_memory_embeddings",
  {
    memoryId: uuid("memory_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    embedding: jsonb("embedding").$type<unknown>().notNull(),
    modelRevision: text("model_revision").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceUserIdx: index("assistant_memory_embeddings_ws_user_idx").on(
      t.workspaceId, t.userId,
    ),
  }),
);

export type PetProfileActiveness = "quiet" | "moderate" | "active";

export const petProfiles = pgTable(
  "pet_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    presetId: text("preset_id"),
    name: text("name").notNull(),
    personalityTags: jsonb("personality_tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    speakingStyle: text("speaking_style").notNull(),
    examples: jsonb("examples").$type<{ text: string }[]>().notNull().default(sql`'[]'::jsonb`),
    activeness: text("activeness").$type<PetProfileActiveness>().notNull().default("moderate"),
    boundaries: jsonb("boundaries").$type<{
      allowPlayful?: boolean;
      allowNudgeLearning?: boolean;
      allowVoiceTags?: boolean;
      catchphrase?: string | null;
    }>().notNull().default(sql`'{}'::jsonb`),
    revision: integer("revision").notNull().default(1),
    familiarity: real("familiarity").notNull().default(0),
    interactionCount: integer("interaction_count").notNull().default(0),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceUserUnique: uniqueIndex("pet_profiles_workspace_user_unique").on(t.workspaceId, t.userId),
  }),
);

export const memoryLinks = pgTable(
  "memory_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memoryId: uuid("memory_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    entityType: text("entity_type").notNull(), // card | key_point | note | source | learning_run
    entityId: uuid("entity_id").notNull(),
    autoLinked: boolean("auto_linked").notNull().default(false),
    orphaned: boolean("orphaned").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueLink: uniqueIndex("memory_links_unique_idx").on(t.memoryId, t.entityType, t.entityId),
    entityIdx: index("memory_links_entity_idx").on(t.workspaceId, t.entityType, t.entityId),
    memoryIdx: index("memory_links_memory_idx").on(t.workspaceId, t.userId, t.memoryId),
  }),
);

export const conversationSummaries = pgTable(
  "conversation_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    sourceRunId: uuid("source_run_id"),
    status: text("status").notNull().default("candidate"), // candidate | confirmed | rejected | pending | processing
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueSummary: uniqueIndex("conversation_summaries_unique_idx").on(
      t.workspaceId, t.userId, t.conversationId, t.sourceRunId,
    ),
    statusIdx: index("conversation_summaries_status_idx").on(
      t.workspaceId, t.userId, t.status, t.createdAt,
    ),
  }),
);

export const memoryUsageLog = pgTable(
  "memory_usage_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    runId: uuid("run_id").notNull(),
    memoryIds: uuid("memory_ids").array().notNull(),
    retrievalMode: text("retrieval_mode").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsUserRunIdx: index("memory_usage_log_ws_user_run_idx").on(
      t.workspaceId, t.userId, t.runId, t.createdAt,
    ),
  }),
);

export const companionDailySummaries = pgTable(
  "companion_daily_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    date: text("date").notNull(), // YYYY-MM-DD 用户本地日期
    timezone: text("timezone").notNull(),
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull(),
    /** 日记正文的块序列（0252）；[] = 历史行，读取时从 summary 投影。 */
    blocks: jsonb("blocks").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    summary: text("summary").notNull().default(""),
    status: text("status").notNull().default("generated"), // generated | failed
    /** status=failed 的成因；generated 行必须为 NULL（0250）。 */
    failureReason: text("failure_reason"),
    revision: integer("revision").notNull().default(1),
    generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    wsUserDateUnique: uniqueIndex("companion_daily_summaries_ws_user_date_unique").on(
      t.workspaceId, t.userId, t.date,
    ),
  }),
);
