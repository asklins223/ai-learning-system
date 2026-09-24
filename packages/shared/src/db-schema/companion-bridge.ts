/**
 * Main ↔ Pet Bridge 服务端 context 表（文档 16 §14.2）。
 *
 * 服务端 hydration 后的 AssistantContextSnapshotV2 落点：renderer 提交的
 * context 输入是不可信提示，服务端校验 authenticated user/workspace、RLS 与
 * EntityRef 归属后覆盖安全字段并计算 canonical revision。本表只存 ID 引用与
 * 展示状态，不存任何实体正文/答案内容。
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

export const assistantPageContexts = pgTable(
  "assistant_page_contexts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** broker 生成的页面实例 id（窗口/页面生命周期）。 */
    pageInstanceId: text("page_instance_id").notNull(),
    /** canonical hash（route/entity/interaction/graph 的确定性摘要）。 */
    revision: text("revision").notNull(),
    routeRef: jsonb("route_ref").notNull(),
    pageKind: text("page_kind").notNull(),
    entityRefs: jsonb("entity_refs").notNull().default([]),
    interactionState: text("interaction_state").notNull().default("idle"),
    graph: jsonb("graph"),
    capabilityHints: jsonb("capability_hints").notNull().default([]),
    sensitivity: text("sensitivity").notNull().default("normal"),
    /** 页面自登记的屏上可读视图（0277）；无时间戳，"多久之前"由 issuedAt 算。 */
    readableView: jsonb("readable_view"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 同一 (workspace,user,pageInstance) 至多一个未撤销 context。
    activeUnique: uniqueIndex("assistant_page_contexts_active_unique_idx")
      .on(t.workspaceId, t.userId, t.pageInstanceId)
      .where(sql`${t.revokedAt} IS NULL`),
    workspaceUserIdx: index("assistant_page_contexts_workspace_user_idx").on(
      t.workspaceId, t.userId, t.issuedAt,
    ),
  }),
);
