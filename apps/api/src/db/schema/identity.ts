import { pgTable, uuid, text, timestamp, index, uniqueIndex, jsonb, integer } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("owner"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
  }),
);

/** Personal BYOK model settings. Provider secrets are AES-GCM ciphertext only. */
export const userAIModelConfigs = pgTable("user_ai_model_configs", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), // mock | dashscope | openai_compatible
  baseUrl: text("base_url"),
  model: text("model"),
  apiKeyEncrypted: text("api_key_encrypted"),
  apiKeyHint: text("api_key_hint"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    // N-011: AI 隐私治理字段
    aiProvider: text("ai_provider").notNull().default("mock"), // mock | dashscope | qwen
    aiConsentVersion: text("ai_consent_version"), // 同意版本号
    aiConsentAt: timestamp("ai_consent_at", { withTimezone: true }), // 同意时间
    aiConsentBy: uuid("ai_consent_by").references(() => users.id), // 同意操作者
    aiDataPolicy: jsonb("ai_data_policy").$type<{
      sendToExternal: boolean;
      piiDetection: boolean;
      auditLogging: boolean;
    }>().notNull().default({ sendToExternal: false, piiDetection: true, auditLogging: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ownerIdx: index("workspaces_owner_idx").on(t.ownerId),
  }),
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: uniqueIndex("workspace_members_pk").on(t.workspaceId, t.userId),
  }),
);

export const inviteCodes = pgTable("invite_codes", {
  code: text("code").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  consumedBy: uuid("consumed_by").references(() => users.id),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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
    operation: text("operation").notNull(), // generate_card | evaluate_validation | parse_source | align_evidence
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
