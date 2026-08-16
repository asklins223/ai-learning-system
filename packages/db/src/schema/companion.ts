/**
 * 阶段 02（W1）任务 02-1：Companion account-scoped 状态表（§12.2 / §5.4.3）。
 *
 * 对应冻结记录 02-3 的 CompanionOnboardingStateV1 语义与 01-3 §1 归属矩阵：
 * - user_companion_onboarding：account-scoped（version + 单调 offer status/
 *   disposition + revision CAS + active run + last run），不使用 workspace RLS。
 * - user_companion_account_state：account-scoped（revision/epoch CAS、global
 *   enabled/off、presence、suggestion pause/suppression、动画/语音和通知边界）。
 * - user_learning_preferences：显式偏好与建议偏好分离（projection），
 *   account 级（workspace_id 可选）。
 *
 * 这些表跨设备同步；workspace actor 与其他用户不可读（迁移 0074/0075 使用
 * user_id isolation RLS，0075 起 account 级行按 user_id、workspace 级行叠加双条件）。
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity.ts";

// ─── CompanionOnboardingStateV1 形状（02-3 冻结）───────────────────────────

export type CompanionOnboardingOfferStatus = "not_offered" | "offered" | "consumed";
export type CompanionOnboardingDisposition = "completed" | "skipped";
export type CompanionOnboardingEntryMode = "first_run" | "manual_replay" | "migration_intro";

export type CompanionOnboardingActiveRun = {
  runId: string;
  entryMode: CompanionOnboardingEntryMode;
  runStatus: "in_progress" | "paused";
  stepId: string;
  resumeTokenRef: string;
  resumeWorkspaceRef?: string;
  expiresAt: string;
};

export type CompanionOnboardingLastRun = {
  entryMode: CompanionOnboardingEntryMode;
  disposition: "completed" | "skipped" | "abandoned";
  at: string;
};

// ─── user_companion_onboarding（account-scoped）────────────────────────────

export const userCompanionOnboarding = pgTable(
  "user_companion_onboarding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    onboardingVersion: text("onboarding_version").notNull(),
    revision: integer("revision").notNull().default(0),
    // 自动欢迎资格严格等于 offer_status = 'not_offered'；consumed 是单调终态。
    offerStatus: text("offer_status")
      .$type<CompanionOnboardingOfferStatus>().notNull().default("not_offered"),
    offerDisposition: text("offer_disposition").$type<CompanionOnboardingDisposition>(),
    activeRun: jsonb("active_run").$type<CompanionOnboardingActiveRun>(),
    lastRun: jsonb("last_run").$type<CompanionOnboardingLastRun>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // account + version 唯一；跨设备同步通过 revision CAS 竞争（01-3 §12.5）。
    userVersionUnique: uniqueIndex("user_companion_onboarding_user_version_unique_idx")
      .on(t.userId, t.onboardingVersion),
    offerStatusIdx: index("user_companion_onboarding_offer_status_idx").on(
      t.userId, t.offerStatus,
    ),
  }),
);

// ─── user_companion_account_state（account-scoped）─────────────────────────

export type CompanionPresenceState = {
  presence: "online" | "dnd" | "offline";
  updatedAt?: string;
};

export type CompanionSuggestionPause = {
  paused: boolean;
  until?: string;
  reasonCodes?: string[];
};

export type CompanionSuppression = {
  // suppressedSuggestionClassIds 可长期保存但不携带 target（02-4）。
  suppressedSuggestionClassIds?: string[];
  paused?: boolean;
  until?: string;
};

export type CompanionAnimationVoiceOff = {
  animationOff: boolean;
  voiceOff: boolean;
};

export type CompanionNotificationBoundary = {
  notificationsEnabled: boolean;
  quietHours?: { from: string; to: string };
};

export const userCompanionAccountState = pgTable(
  "user_companion_account_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // account revision / epoch CAS；SSE/WebSocket epoch 撤销依赖 epoch 单调递增。
    revision: integer("revision").notNull().default(0),
    epoch: integer("epoch").notNull().default(0),
    globalEnabled: boolean("global_enabled").notNull().default(true),
    presence: jsonb("presence").$type<CompanionPresenceState>(),
    suggestionPause: jsonb("suggestion_pause").$type<CompanionSuggestionPause>(),
    suppression: jsonb("suppression").$type<CompanionSuppression>(),
    animationVoiceOff: jsonb("animation_voice_off").$type<CompanionAnimationVoiceOff>(),
    notificationBoundary: jsonb("notification_boundary").$type<CompanionNotificationBoundary>(),
    // 方案 16 §10.3：主动介入强度与静默时段（账号级跨设备；0140 迁移）。
    interventionLevel: text("intervention_level").$type<"quiet" | "moderate" | "active">().notNull().default("moderate"),
    quietHours: jsonb("quiet_hours").$type<{ startLocal: string; endLocal: string; timezone: string } | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 每账号一行；全局开关/存在感/suppression 跨设备同步。
    userUnique: uniqueIndex("user_companion_account_state_user_unique_idx").on(t.userId),
  }),
);

// 短 TTL、content-free 的 device runtime fence。它不是账号偏好，只为多 API
// 实例共享当前设备的 surface epoch 和撤销边界。
export const companionRuntimeFences = pgTable(
  "companion_runtime_fences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    deviceSessionId: text("device_session_id").notNull(),
    surfaceEpoch: integer("surface_epoch").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    userDeviceUnique: uniqueIndex("companion_runtime_fences_user_device_unique_idx")
      .on(t.userId, t.deviceSessionId),
    expiryIdx: index("companion_runtime_fences_expiry_idx").on(t.userId, t.expiresAt),
  }),
);

// ─── user_learning_preferences（显式偏好与建议偏好分离）────────────────────

export type LearningExplicitPreferences = {
  // 用户明确保存的学习偏好（模态、复习节奏等）。
  [key: string]: unknown;
};

export type LearningSuggestedPreferences = {
  // 系统建议但未经用户确认的偏好；不得与显式偏好混表/混列（02-1）。
  [key: string]: unknown;
};

export const userLearningPreferences = pgTable(
  "user_learning_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // account 级一行时为空；可选 workspace 作用域（user-private-in-workspace）。
    workspaceId: uuid("workspace_id"),
    explicitPreferences: jsonb("explicit_preferences")
      .$type<LearningExplicitPreferences>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    suggestedPreferences: jsonb("suggested_preferences")
      .$type<LearningSuggestedPreferences>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userAccountUnique: uniqueIndex("user_learning_preferences_user_account_unique_idx")
      .on(t.userId)
      .where(sql`${t.workspaceId} IS NULL`),
    userWorkspaceUnique: uniqueIndex("user_learning_preferences_user_workspace_unique_idx")
      .on(t.userId, t.workspaceId)
      .where(sql`${t.workspaceId} IS NOT NULL`),
    workspaceIdx: index("user_learning_preferences_workspace_idx").on(t.workspaceId),
  }),
);

// ─── companion_invitation_ledger（workspace-scoped，任务 02-4）──────────────

export type CompanionSuggestionLease = {
  /** 活跃建议租约 ID：同 lease 的重复请求幂等返回，不重复展示。 */
  leaseId: string;
  /** 签发时的 account surface epoch（设备侧校验用，迟到的旧 lease fail closed）。 */
  surfaceEpoch: number;
  issuedAt: string;
  expiresAt: string;
};

export type CompanionOneTimePermit = {
  /** 一次性 display permit：consume 后置 consumedAt，重复展示被拒。 */
  permitId: string;
  issuedAt: string;
  expiresAt: string;
  /** 已消费时间；存在即终态，跨设备/标签页旧写不得再次展示。 */
  consumedAt?: string;
  /** 消费方 device session（opaque，仅审计用途，不携带页面/内容）。 */
  consumedByDeviceSessionId?: string;
};

/**
 * 页面/target 邀请 ledger（§12.1 user-private-in-workspace）。
 *
 * 每 (workspace, user, stablePageContextKey) 一行，承载：
 * - context/reason 双预算键（context 预算一次、reason 预算有界次数）；
 * - bounded reason（长度受限、词表受限，不进入画像）；
 * - cooldown epoch（dismiss/拒绝后单调递增，低于当前 epoch 的旧写 fail closed）；
 * - 展示/dismiss 终态（dismiss 后不得重复自动展示）；
 * - activeSuggestionLease 与一次性 permit 在单事务内原子签发（01-3 §12.5）。
 *
 * 原始 entity refs（stablePageContextKey/contextBudgetKey/reasonBudgetKey）只保留到
 * TTL（默认 30 天）；到期后由清理函数清空 refs 并置 tombstonedAt，保留预算计数
 * 的 content-free tombstone（02-4 §3）。tombstone 行不携带任何 target。
 */
export const companionInvitationLedger = pgTable(
  "companion_invitation_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // 页面稳定上下文键：同一 workspace 内同一页面仅一行 ledger（展示/dismiss 状态）。
    stablePageContextKey: text("stable_page_context_key").notNull(),
    // context/reason 双预算键：context 预算一次、reason 预算按有界次数（01-3 §12.5）。
    contextBudgetKey: text("context_budget_key").notNull(),
    reasonBudgetKey: text("reason_budget_key").notNull(),
    /** reason 预算剩余次数：有界、非负；耗尽后不再为该 reason 展示。 */
    reasonBudgetRemaining: integer("reason_budget_remaining").notNull().default(0),
    // 有界 reason：长度受限，仅用于用户支持/幂等说明，不进入画像（§5.8）。
    boundedReason: text("bounded_reason"),
    // cooldown epoch：dismiss/拒绝后单调递增；低于当前 epoch 的请求 fail closed。
    cooldownEpoch: integer("cooldown_epoch").notNull().default(0),
    shownAt: timestamp("shown_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    // activeSuggestionLease + 一次性 permit：单事务原子签发（01-3 §12.5）。
    suggestionLease: jsonb("suggestion_lease").$type<CompanionSuggestionLease>(),
    oneTimePermit: jsonb("one_time_permit").$type<CompanionOneTimePermit>(),
    // TTL/tombstone：到期后清空 entity refs 保留预算的 content-free tombstone。
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // 每 user/workspace/页面一行；budget 键在 user/workspace 内唯一，防止重复行。
    userPageUnique: uniqueIndex("companion_invitation_ledger_user_page_unique_idx")
      .on(t.workspaceId, t.userId, t.stablePageContextKey),
    // budgetKey 唯一（01-3 §12.5 双预算：同一 context 预算至多一行原子签发）。
    contextBudgetUnique: uniqueIndex("companion_invitation_ledger_context_budget_unique_idx")
      .on(t.workspaceId, t.userId, t.contextBudgetKey),
    // TTL/清理索引：按 workspace+user 扫旧行（TTL 后 tombstone/删除）。
    cleanupIdx: index("companion_invitation_ledger_cleanup_idx")
      .on(t.workspaceId, t.userId, t.updatedAt),
    tombstoneIdx: index("companion_invitation_ledger_tombstone_idx")
      .on(t.tombstonedAt)
      .where(sql`${t.tombstonedAt} IS NOT NULL`),
  }),
);

// ─── companion_audit（user-private + 短 TTL，任务 02-4）───────────────────

export type CompanionAuditPageActionType =
  | "page_view"
  | "invitation_shown"
  | "invitation_dismissed"
  | "invitation_permit_issued"
  | "page_action_confirm"
  | "onboarding_transition"
  | "runtime_fence"
  | "suppression_change"
  | "audit_export"
  | "audit_delete";

export type CompanionAuditContextPermissionHashes = {
  contextVersion?: string;
  permissionSnapshotHash?: string;
  impactPreviewHash?: string;
  requestHash?: string;
};

/**
 * Companion page/action audit（§12.2 §2.2 + 02-4）。
 *
 * 只保留安全、幂等、预算与用户支持所需的最小字段：
 * page/action/entity opaque IDs、context/permission hashes、policyVersion、result。
 * ⚠️ 不保存整页内容、DOM、截图、凭据或未提交输入（§12.2）；
 * 不进入增长画像、兴趣推断或跨 workspace analytics（§12.2 + 02-4 §1）。
 *
 * 短 TTL：默认 30 天（W0 privacy owner 冻结）；到期后删除或替换为
 * 不可逆、content-free 的预算 tombstone（清空 opaque IDs，保留版本/结果计数）。
 */
export const companionAudit = pgTable(
  "companion_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // pageAction 类型：安全/幂等/预算/用户支持事件分类，不携带内容。
    pageActionType: text("page_action_type")
      .$type<CompanionAuditPageActionType>().notNull(),
    // opaque IDs：只做关联/去重，不可读回页面内容（§12.2）。
    pageOpaqueId: text("page_opaque_id"),
    actionOpaqueId: text("action_opaque_id"),
    entityOpaqueIds: text("entity_opaque_ids").array().notNull().default([]),
    contextPermissionHashes: jsonb("context_permission_hashes")
      .$type<CompanionAuditContextPermissionHashes>(),
    policyVersion: text("policy_version"),
    result: text("result"),
    // TTL/tombstone：到期删除或替换 content-free tombstone（02-4 §3）。
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // TTL/清理 + 用户导出索引（02-4 §4）。
    userCreatedIdx: index("companion_audit_user_created_idx").on(t.userId, t.createdAt),
    workspaceUserIdx: index("companion_audit_workspace_user_idx")
      .on(t.workspaceId, t.userId, t.createdAt),
    tombstoneIdx: index("companion_audit_tombstone_idx")
      .on(t.tombstonedAt)
      .where(sql`${t.tombstonedAt} IS NOT NULL`),
  }),
);
