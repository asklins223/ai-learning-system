/**
 * 方案 16 §20：学习漏斗指标事件表（迁移 0149）。
 * 只存引用/状态/行为元数据，不存答案正文/语音/private rubric（§20.1）。
 */

import { pgTable, uuid, text, jsonb, integer, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

export const learningMetricEvents = pgTable(
  "learning_metric_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    // run_created | task_presented | artifact_locked | action | run_result
    runId: uuid("run_id"),
    taskId: uuid("task_id"),
    origin: jsonb("origin"),
    goal: text("goal"),
    intent: text("intent"),
    interactionKind: text("interaction_kind"),
    variantPurpose: text("variant_purpose"),
    trustClass: text("trust_class"),
    actionKind: text("action_kind"),
    outcome: text("outcome"),
    scheduleImpact: jsonb("schedule_impact"),
    activeSecondsUsed: integer("active_seconds_used"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 2026-08-12（generate 对齐）：0159 定义 (workspace_id, user_id, occurred_at DESC)，
    // 支撑用户维度漏斗聚合 / 指标读取，避免 workspace 分区内全扫排序。
    wsUserTimeIdx: index("learning_metric_events_ws_user_time_idx")
      .on(t.workspaceId, t.userId, sql`${t.occurredAt} desc`),
  }),
);
