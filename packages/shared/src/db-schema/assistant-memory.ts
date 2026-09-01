/**
 * 分层记忆表（文档 16 §10/§21 保留清单 + 22 方案 V2 扩展）。
 *
 * 不复制 Learner Model：每条记忆必须有来源（事件/会话引用）、可审计字段、
 * 删除级联；canonical 学习事实保持不变（记忆删除不影响学习真相）。
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  real,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

export const assistantMemoryItems = pgTable(
  "assistant_memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // preference | goal | learning_context | interaction_note | episodic
    content: text("content").notNull(),
    /** 来源引用（可审计）：事件 id 或会话 id。 */
    sourceEventId: text("source_event_id"),
    sourceSessionId: uuid("source_session_id"),
    /** 用户显式提供的来源（如目标设定），区别于模型推断。 */
    userStated: boolean("user_stated").notNull().default(false),
    /** 独立来源记忆（无事件/会话来源）由用户明确确认。 */
    userConfirmed: boolean("user_confirmed").notNull().default(false),
    /** 候选记忆（未经确认）不参与主动策略。 */
    candidate: boolean("candidate").notNull().default(false),
    /** 记忆重要性（0-1），影响检索排序。 */
    importance: real("importance").notNull().default(0.5),
    /** 提取置信度（0-1），低于阈值不生成候选。 */
    confidence: real("confidence").notNull().default(0.5),
    /** 可见范围：global | workspace | task。 */
    scope: text("scope").notNull().default("workspace"),
    /** 固定记忆：高优先级、不参与衰减。 */
    pinned: boolean("pinned").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    conflictGroup: uuid("conflict_group"),
    embeddingProfileVersion: text("embedding_profile_version"),
    sourceType: text("source_type").notNull().default("model_inferred"),
    /** 气泡“忽略”时间；忽略后 30 天内不重复弹出，管理页仍可见。 */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    /** embedding 状态：none | pending | ready | failed。 */
    embeddingStatus: text("embedding_status").notNull().default("none"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 内容去重：同一 (kind, content 前缀 hash) 至多一条活跃记忆。
    contentUnique: uniqueIndex("assistant_memory_items_content_unique_idx")
      .on(t.workspaceId, t.userId, t.kind, t.sourceEventId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.sourceEventId} IS NOT NULL`),
    workspaceUserIdx: index("assistant_memory_items_ws_user_idx").on(
      t.workspaceId, t.userId, t.updatedAt,
    ),
  }),
);
