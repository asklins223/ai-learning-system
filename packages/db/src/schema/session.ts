import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Session 表：持久化登录态，替代内存 Map。
 * - token 作为主键，查询 O(1)。
 * - expiresAt 用于过期清理；decodeToken 时一并校验。
 * - V0 单实例足够；未来多实例天然共享（Postgres）。
 */
export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: uuid("user_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
