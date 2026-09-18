/**
 * v0.6 Schema: 可信掌握闭环 (计划 §6)
 *
 * 当前仍使用的表：
 * - validation_assistance_exposures：review cooldown 门禁
 *
 * 已删除的 question-generation / submission / rubric / shadow 表不再映射；
 * 它们没有当前生产读写入口，历史数据库由后续 drop migration 清理。
 */

import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity.ts";
// ─── validation_assistance_exposures ──────────────────────────────────────

/**
 * User-private assistance 暴露账本。
 * 每行记录同一 objective/fingerprint 的最近暴露和冷却窗口，只用于单调冷却门禁。
 */
export const validationAssistanceExposures = pgTable(
  "validation_assistance_exposures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // This column survived the V1-card cleanup and now points at the V2
    // objective id (migration 0176). Keep it mapped because it is NOT NULL.
    keyPointId: uuid("key_point_id").notNull(),
    exposureFingerprint: text("exposure_fingerprint").notNull(),
    lastExposureKind: text("last_exposure_kind").notNull(), // pre_submit_source | post_result_feedback
    firstExposedAt: timestamp("first_exposed_at", { withTimezone: true }).notNull(),
    lastExposedAt: timestamp("last_exposed_at", { withTimezone: true }).notNull(),
    unassistedEligibleAfter: timestamp("unassisted_eligible_after", { withTimezone: true }).notNull(),
    lastOriginSubmissionId: uuid("last_origin_submission_id"),
    inputScheduleId: uuid("input_schedule_id"), // nullable
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueExposure: uniqueIndex("val_assist_exp_unique_idx").on(
      t.workspaceId, t.userId, t.keyPointId, t.exposureFingerprint,
    ),
    userKeyPointIdx: index("val_assist_exp_user_kp_idx").on(t.userId, t.keyPointId),
  }),
);
