import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { jobStatusEnum } from "./enums.ts";
import { users } from "./identity.ts";
import { cardGenerationRuns, cardGenerationUnits } from "./card-generation.ts";

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
    generationRunId: uuid("generation_run_id").references(() => cardGenerationRuns.id, { onDelete: "cascade" }),
    generationUnitId: uuid("generation_unit_id").references(() => cardGenerationUnits.id, { onDelete: "cascade" }),
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
    generationRunIdx: index("jobs_generation_run_idx").on(t.generationRunId, t.stage, t.status),
    idempotencyUniqueIdx: uniqueIndex("jobs_workspace_idempotency_unique_idx")
      .on(t.workspaceId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  }),
);
