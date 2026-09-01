/**
 * Understanding Projection V2 表（文档 16 §15/§16.1）。
 *
 * - understanding_projection_checkpoints：opaque token 的权威落点（token 封装
 *   并签名 server-private canonical/practice watermark；客户端不得解析）。
 * - understanding_change_sets：Projector 在应用 source event 的同一幂等事务
 *   中物化的 immutable change set（before/after 摘要 + from/to checkpoint）。
 * - understanding_route_plans：确定性 RoutePlan（步骤/边/原因码，过期即 409）。
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

export const understandingProjectionCheckpoints = pgTable(
  "understanding_projection_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    /** server-private watermark：最后已投影的 canonical/practice event。 */
    lastCanonicalEventId: text("last_canonical_event_id"),
    lastPracticeEventId: text("last_practice_event_id"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tokenUnique: uniqueIndex("understanding_projection_checkpoints_token_unique_idx").on(t.token),
    workspaceUserIdx: index("understanding_projection_checkpoints_ws_user_idx").on(
      t.workspaceId, t.userId, t.capturedAt,
    ),
  }),
);

export const understandingChangeSets = pgTable(
  "understanding_change_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    changeSetId: text("change_set_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    sourceEventId: text("source_event_id").notNull(),
    kind: text("kind").notNull(), // canonical | practice_only
    fromCheckpointToken: text("from_checkpoint_token").notNull(),
    toCheckpointToken: text("to_checkpoint_token").notNull(),
    /** event-local before/after 摘要（经授权；不是完整图补丁）。 */
    changedNodes: jsonb("changed_nodes").notNull().default([]),
    practiceTrailChanges: jsonb("practice_trail_changes").notNull().default([]),
    runBaselineCheckpointToken: text("run_baseline_checkpoint_token"),
    // 迁移 0146：projector consumption 唯一约束（§16.2）。
    projectorName: text("projector_name").notNull().default("personal_v2"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    changeSetUnique: uniqueIndex("understanding_change_sets_unique_idx").on(
      t.changeSetId,
    ),
    // §16.2：change set (runId, sourceEventId, fromTokenHash, toTokenHash) 唯一。
    runSourceUnique: uniqueIndex("understanding_change_sets_run_source_unique_idx").on(
      t.runId, t.sourceEventId,
    ),
    // §16.2：projector consumption (projectorName, sourceEventId) 唯一。
    projectorSourceUnique: uniqueIndex("understanding_change_sets_projector_source_unique_idx").on(
      t.projectorName, t.sourceEventId,
    ),
    runIdx: index("understanding_change_sets_run_idx").on(t.runId),
  }),
);

export const understandingRoutePlans = pgTable(
  "understanding_route_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    targetKeyPointId: uuid("target_key_point_id"),
    baseCheckpoint: jsonb("base_checkpoint").notNull(),
    intent: text("intent").notNull(),
    maxSteps: integer("max_steps").notNull(),
    steps: jsonb("steps").notNull(),
    sourceFactHashes: jsonb("source_fact_hashes").notNull().default([]),
    idempotencyKey: text("idempotency_key").notNull().default(""),
    revision: integer("revision").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceUserIdx: index("understanding_route_plans_ws_user_idx").on(
      t.workspaceId, t.userId, t.createdAt,
    ),
    // 幂等键唯一（idempotency_key 非空时）：并发双请求返回同一 plan。
    idempotencyUnique: uniqueIndex("understanding_route_plans_idempotency_unique_idx")
      .on(t.workspaceId, t.userId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} <> ''`),
  }),
);
