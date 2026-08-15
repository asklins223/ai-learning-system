/**
 * Sandbox namespace（文档 16 §16.4 隔离教学空间）。
 *
 * sandboxNamespaceId 是隔离的教学空间标识：sandbox 的 Run/Artifact 必须带
 * 该 namespace；RLS 同时校验 user、workspace 与 namespace；sandbox ref 不能
 * 用于普通 API；sandbox target 永远 publishedTargetEligibility=false；Commit
 * disposition 固定 sandbox_only；默认 24 小时 TTL 清理。
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

export const companionSandboxNamespaces = pgTable(
  "companion_sandbox_namespaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** 归属旅程（可选：独立教学空间也可以无旅程）。 */
    journeyId: uuid("journey_id"),
    status: text("status").notNull().default("active"), // active | exited | expired
    branch: text("branch").notNull().default("sandbox_sample"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    exitedAt: timestamp("exited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceUserIdx: index("companion_sandbox_namespaces_ws_user_idx").on(
      t.workspaceId, t.userId, t.createdAt,
    ),
    // 同一用户同一旅程至多一个 active namespace。
    journeyActiveUnique: uniqueIndex("companion_sandbox_namespaces_journey_active_unique_idx")
      .on(t.journeyId)
      .where(sql`${t.journeyId} IS NOT NULL`),
    statusIdx: index("companion_sandbox_namespaces_status_idx").on(t.status, t.expiresAt),
  }),
);
