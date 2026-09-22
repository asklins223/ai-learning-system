import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, uniqueIndex, jsonb, integer, check } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("owner"),
    // ADR-0009: 用户的个人工作区 ID（注册时自动创建，不可删除）
    personalWorkspaceId: uuid("personal_workspace_id"),
    // PROFILE-01: 用户展示名与头像（选填，注册时可收集，个人中心可编辑）
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
  }),
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    // ADR-0009: workspace 类型区分个人/协作。它是空间自身的属性，不由查看者决定。
    workspaceType: text("workspace_type").notNull().default("personal"), // personal | collaborative
    // AI 同意与数据外发政策曾在这四列上（N-011），0237 迁到 user_ai_settings：
    // 同意管的是"我的内容能不能送出去"，授权范围只能是本人。
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // 空间边界令牌（0261）：成员变动 / AI 同意或外发政策改变 / 空间改名时由触发器 +1。
    // 会话解码与会话签发都读它，客户端拿旧值请求会被判 stale_workspace。
    workspaceEpoch: integer("workspace_epoch").notNull().default(1),
  },
  (t) => ({
    ownerIdx: index("workspaces_owner_idx").on(t.ownerId),
  }),
);

/**
 * 高危动作的审计留痕（0263）。
 *
 * 与 `ai_audit_log`（AI 外发内容类别）和 `companion_audit`（伴星页面动作）都不是
 * 一回事：这里记的是"谁在什么时候导出了整个空间 / 物理删掉了哪篇笔记"。
 * 写入必须与动作同事务（见 `apps/api/src/modules/audit/service.ts`）。
 */
export const workspaceAuditLog = pgTable(
  "workspace_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    targetKind: text("target_kind").notNull(),
    targetId: uuid("target_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceCreatedIdx: index("workspace_audit_log_workspace_created_idx").on(t.workspaceId, t.createdAt),
    actionCreatedIdx: index("workspace_audit_log_action_created_idx").on(t.action, t.createdAt),
  }),
);

/** 账号级 AI 数据外发政策。 */
export type UserAiDataPolicy = {
  sendToExternal: boolean;
  sendImageContent: boolean;
  piiDetection: boolean;
  auditLogging: boolean;
};

/**
 * AI 使用同意与数据外发政策（0237）。
 *
 * 键是 `user_id`，**没有 workspace_id**：同意只影响本人，不属于学习空间。空间内
 * 共享的是资料，资料一旦放进协作空间即视为可被该空间成员的伴星读取与外发，这一条
 * 在"放入"时明示，而不是由某个 owner 替所有人签。
 *
 * RLS 按 `user_id` 隔离，所以读取必须走 `withWorkspaceTransaction` 一类会设置
 * `app.user_id` 的入口——否则查询静默返回 0 行，表现成"同意永远未签"。
 */
export const userAiSettings = pgTable("user_ai_settings", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  consentVersion: text("consent_version"),
  consentAt: timestamp("consent_at", { withTimezone: true }),
  dataPolicy: jsonb("data_policy").$type<UserAiDataPolicy>().notNull()
    .default({ sendToExternal: false, sendImageContent: false, piiDetection: true, auditLogging: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
    // ADR-0009: 软退出标记，NULL 表示活跃成员
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (t) => ({
    pk: uniqueIndex("workspace_members_pk").on(t.workspaceId, t.userId),
    // 0259：角色只有 owner / member 两种（PRODUCT.md:67）。此前是 free-text，
    // 数据库对"把别人写成 owner"一句话都不说——dev 库里真的出现过这种夹具行。
    roleCheck: check("workspace_members_role_check", sql`${t.role} IN ('owner', 'member')`),
  }),
);

export const inviteCodes = pgTable(
  "invite_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code"),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    consumedBy: uuid("consumed_by").references(() => users.id),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // SEC-02 / ADR-0002: secure token storage
    tokenHash: text("token_hash"),
    tokenHint: text("token_hint"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id),
    role: text("role").notNull().default("member"),
    // ADR-0009: 区分邀请码消费场景
    consumeContext: text("consume_context").notNull().default("registration"), // registration | workspace_join
  },
  (t) => ({
    // 2026-08-12（schema 完整性审计）：0021:80-87 两索引此前未声明
    tokenHashIdx: index("invite_codes_token_hash_idx").on(t.tokenHash),
    workspaceCreatedIdx: index("invite_codes_workspace_created_idx").on(t.workspaceId, t.createdAt),
  }),
);

/**
 * Server-side onboarding state per (workspace, user, version).
 * Steps are business-fact driven: ai_consent, first_content,
 * first_note, first_card, evidence_review.
 */
export const onboardingStates = pgTable(
  "onboarding_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    version: text("version").notNull().default("v1"),
    steps: jsonb("steps").$type<Record<string, boolean>>().notNull().default({}),
    status: text("status").notNull().default("pending"), // pending | in_progress | completed
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqueState: uniqueIndex("onboarding_states_unique_idx").on(t.workspaceId, t.userId, t.version),
    workspaceUserIdx: index("onboarding_states_workspace_user_idx").on(t.workspaceId, t.userId),
  }),
);

/**
 * Shared authentication rate-limit buckets.
 *
 * A bucket is keyed by a normalized IP/email identity.  The API updates a
 * row with one atomic INSERT ... ON CONFLICT statement, so all API replicas
 * share the same window and counter.
 */
export const authRateLimits = pgTable(
  "auth_rate_limits",
  {
    bucketKey: text("bucket_key").primaryKey(),
    count: integer("count").notNull().default(0),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    resetIdx: index("auth_rate_limits_reset_idx").on(t.resetAt),
  }),
);

/**
 * N-011: AI 调用审计日志。
 * 记录每次 AI 调用的 workspace、用户、job、provider、模型、操作类型、
 * 数据类别、数据量、token 成本、耗时和状态，支持隐私追溯。
 */
export const aiAuditLog = pgTable(
  "ai_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    jobId: uuid("job_id"),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    operation: text("operation").notNull(), // active worker operation name
    dataCategories: text("data_categories").array().notNull().default([]), // note_content | user_answer | question | claim | quote
    dataSizeBytes: integer("data_size_bytes"),
    costTokens: integer("cost_tokens"),
    durationMs: integer("duration_ms"),
    status: text("status").notNull().default("success"), // success | failed | blocked
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    workspaceIdx: index("ai_audit_log_workspace_idx").on(t.workspaceId),
    userIdx: index("ai_audit_log_user_idx").on(t.userId, t.createdAt),
  }),
);
