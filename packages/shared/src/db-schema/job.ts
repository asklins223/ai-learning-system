import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { jobStatusEnum } from "./enums.ts";
import { users } from "./identity.ts";

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(), // parse_source | companion_*
    workspaceId: uuid("workspace_id").notNull(),
    // SEC-01: trusted actor attribution. Legacy rows may remain null until a
    // membership-validated backfill or explicit quarantine decision is made.
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: jobStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // G-001: 不可变 lease token — claim 时生成并写入 DB，完成/失败时以此作为原子条件。
    leaseToken: text("lease_token"),
    priority: integer("priority").notNull().default(50),
    resourceClass: text("resource_class").notNull().default("maintenance"),
    idempotencyKey: text("idempotency_key"),
  },
  (t) => ({
    statusIdx: index("jobs_status_idx").on(t.status, t.scheduledAt),
    workspaceIdx: index("jobs_workspace_idx").on(t.workspaceId),
    workspaceRequestedByIdx: index("jobs_workspace_requested_by_idx")
      .on(t.workspaceId, t.requestedBy)
      .where(sql`${t.requestedBy} IS NOT NULL`),
    idempotencyUniqueIdx: uniqueIndex("jobs_workspace_idempotency_unique_idx")
      .on(t.workspaceId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),

    idWorkspaceUnique: uniqueIndex("jobs_id_workspace_unique").on(t.id, t.workspaceId),
  }),
);
