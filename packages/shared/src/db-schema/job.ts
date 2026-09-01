import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { jobStatusEnum } from "./enums.ts";
import { users } from "./identity.ts";

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(), // execute_card_agent_turn | align_evidence | evaluate_validation | parse_source | generate_validation_question
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
    // v0.6 CARD-02 (计划 §7.7): card repair state — persisted so crash/lease-lost
    // prevents a second repair call. CAS: none → claimed → completed.
    repairState: text("repair_state").notNull().default("none"),
    // CHECK (0..1) enforced at DB level via migration.
    repairAttemptCount: integer("repair_attempt_count").notNull().default(0),
        stage: text("stage"),
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
    // 2026-08-12（generate 对齐）：表达式+部分唯一索引——同 noteVersion 的
    // generate_card 不得并发重复(worker 幂等兜底)。drizzle 表达式索引用 sql 模板。
    generateCardActiveUnique: uniqueIndex("jobs_generate_card_active_unique_idx")
      .on(t.workspaceId, sql`(${t.payload} ->> 'noteVersionId')`)
      .where(
        sql`${t.type} = 'generate_card' AND ${t.status} IN ('pending', 'running') AND (${t.payload} ->> 'noteVersionId') IS NOT NULL`,
      ),}),
);
