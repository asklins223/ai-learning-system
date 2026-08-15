/**
 * 分层记忆表（文档 16 §10/§21 保留清单：有来源、可审计、可删除的长期语义记忆）。
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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

export const assistantMemoryItems = pgTable(
  "assistant_memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // preference | goal | learning_context | interaction_note
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
