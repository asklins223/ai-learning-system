/**
 * P2 companion conversation foundation（03 合同 §7.1–§7.6）。
 *
 * 六张表全部 workspace+user RLS（policy 匹配 app.workspace_id + app.user_id）；
 * companion_voice_artifacts 在 P2 保持空表且无写路径（P3 启用 provenance）。
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  primaryKey,
  char,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users, workspaces } from "./identity.ts";
import type { CompanionMessageV1, CompanionStreamEventV1 } from "@ailearn/shared";

// ─── 7.1 companion_conversations ──────────────────────────────────────────

export const companionConversations = pgTable(
  "companion_conversations",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    kind: text("kind").$type<"dialogue" | "inbox" | "journey">().notNull(),
    title: text("title").notNull(),
    titleSource: text("title_source").$type<"placeholder" | "auto" | "user" | "system">().notNull(),
    status: text("status").$type<"active" | "archived">().notNull().default("active"),
    nextMessageSeq: bigint("next_message_seq", { mode: "number" }).notNull().default(1),
    nextEventSeq: bigint("next_event_seq", { mode: "number" }).notNull().default(1),
    nextGeneration: integer("next_generation").notNull().default(1),
    summaryText: text("summary_text"),
    summaryVersion: integer("summary_version").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activityIdx: index("companion_conversations_activity_idx").on(
      sql`(workspace_id, user_id, COALESCE(last_message_at, created_at) DESC, id DESC)`,
    ),
    inboxActiveUnique: uniqueIndex("companion_conversations_inbox_active_unique")
      .on(t.workspaceId, t.userId)
      .where(sql`kind = 'inbox' AND status = 'active'`),
  }),
);

// ─── 7.2 companion_messages ───────────────────────────────────────────────

export const companionMessages = pgTable(
  "companion_messages",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull().references(() => companionConversations.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    role: text("role").$type<"user" | "assistant" | "system">().notNull(),
    kind: text("kind").$type<CompanionMessageV1["kind"]>().notNull(),
    blocks: jsonb("blocks").$type<CompanionMessageV1["blocks"]>().notNull(),
    runId: uuid("run_id"),
    clientMessageId: uuid("client_message_id"),
    contentSha256: text("content_sha256").notNull(),
    // 迁移 0093 新增：assistant confirmation message 指向 action proposal。
    // FK（companion_action_proposals.id）由手写迁移维护。
    actionRef: uuid("action_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
  },
  (t) => ({
    conversationSeqUnique: uniqueIndex("companion_messages_conversation_seq_unique").on(t.conversationId, t.seq),
    clientMessageUnique: uniqueIndex("companion_messages_client_message_unique")
      .on(t.conversationId, t.clientMessageId)
      .where(sql`client_message_id IS NOT NULL`),
    // 2026-08-12（generate 对齐）：迁移 0110 复合索引声明（workspace 前缀，RLS 过滤+
    // SSE 游标按 conversation+seq 读取）。
    // 注：0158 已 DROP 冗余 DESC 索引 companion_messages_conversation_seq_desc_idx
    // （同键序的唯一约束 companion_messages_conversation_seq_unique 已覆盖，DESC 不提供
    // 额外能力，且避免每条 INSERT 写两棵 B-tree）。此处**不声明**该索引，防 generate 重建。
    workspaceUserConvSeqIdx: index("companion_messages_workspace_user_conv_seq_idx")
      .on(t.workspaceId, t.userId, t.conversationId, sql`seq DESC`),
    // 2026-08-12（generate 对齐）：0093 定义单列 (action_ref) 部分索引
    actionRefIdx: index("companion_messages_action_ref_idx")
      .on(t.actionRef)
      .where(sql`action_ref IS NOT NULL`),
  }),
);

// ─── 7.3 companion_turn_runs ──────────────────────────────────────────────

export const companionTurnRuns = pgTable(
  "companion_turn_runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull().references(() => companionConversations.id, { onDelete: "cascade" }),
    userMessageId: uuid("user_message_id").notNull().references(() => companionMessages.id),
    assistantMessageId: uuid("assistant_message_id").references(() => companionMessages.id),
    jobId: uuid("job_id"),
    generation: integer("generation").notNull(),
    status: text("status").$type<"accepted" | "running" | "succeeded" | "cancel_requested" | "cancelled" | "failed" | "superseded">().notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestBodyHash: text("request_body_hash").notNull(),
    // 迁移 0107 新增（L11）：run 创建时冻结的账号世代
    // （companion_runtime_fences.surface_epoch）。
    accountEpoch: integer("account_epoch").notNull().default(0),
    providerId: text("provider_id"),
    modelId: text("model_id"),
    promptVersion: text("prompt_version"),
    promptHash: char("prompt_hash", { length: 64 }),
    pageContext: jsonb("page_context"),
    contextGrantId: uuid("context_grant_id"),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // 迁移 0089 新增：本 run 已落库的最大 event seq（SSE 恢复/幂等响应用）。
    lastEventSeq: bigint("last_event_seq", { mode: "number" }).notNull().default(0),
    // 迁移 0092 新增：frozen router decision（§6.7）。
    routerIntent: text("router_intent"),
    routerConfidence: integer("router_confidence"),
    routerPromptVersion: text("router_prompt_version"),
    routerPromptHash: char("router_prompt_hash", { length: 64 }),
    routerContextRevision: char("router_context_revision", { length: 64 }),
    routerPayloadHash: char("router_payload_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversationGenerationUnique: uniqueIndex("companion_turn_runs_conversation_generation_unique").on(t.conversationId, t.generation),
    idempotencyUnique: uniqueIndex("companion_turn_runs_idempotency_unique").on(t.conversationId, t.idempotencyKeyHash),
    activeUnique: uniqueIndex("companion_turn_runs_active_unique")
      .on(t.conversationId)
      .where(sql`status IN ('accepted', 'running', 'cancel_requested')`),
    jobIdUnique: uniqueIndex("companion_turn_runs_job_id_unique")
      .on(t.jobId)
      .where(sql`job_id IS NOT NULL`),
    contextGrantUnique: uniqueIndex("companion_turn_runs_context_grant_unique")
      .on(t.contextGrantId)
      .where(sql`context_grant_id IS NOT NULL`),
  }),
);

// ─── 7.4 companion_stream_events ──────────────────────────────────────────

export const companionStreamEvents = pgTable(
  "companion_stream_events",
  {
    conversationId: uuid("conversation_id").notNull().references(() => companionConversations.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    runId: uuid("run_id"),
    generation: integer("generation").notNull(),
    accountEpoch: integer("account_epoch").notNull().default(0),
    type: text("type").$type<CompanionStreamEventV1["type"]>().notNull(),
    payload: jsonb("payload").$type<CompanionStreamEventV1["payload"]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.seq] }),
    expiresIdx: index("companion_stream_events_expires_idx").on(t.expiresAt),
  }),
);

// ─── 7.5 companion_voice_artifacts（P2 无写路径） ─────────────────────────

export const companionVoiceArtifacts = pgTable(
  "companion_voice_artifacts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id"),
    messageId: uuid("message_id"),
    status: text("status").$type<"pending" | "attached" | "expired">().notNull(),
    transcriptSha256: text("transcript_sha256").notNull(),
    asrProvider: text("asr_provider").notNull(),
    asrModel: text("asr_model").notNull(),
    language: text("language").notNull(),
    durationMs: integer("duration_ms").notNull(),
    rawAudioPersisted: boolean("raw_audio_persisted").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attachedAt: timestamp("attached_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    messageUnique: uniqueIndex("companion_voice_artifacts_message_unique")
      .on(t.messageId)
      .where(sql`status = 'attached'`),
    // 2026-08-12（generate 对齐）：0152 定义 (status, expires_at) 部分索引（仅 pending）。
    // 支撑 ailearn_expire_pending_voice_artifacts() 的分批过期清理谓词，避免全表扫描。
    pendingExpiresIdx: index("companion_voice_artifacts_pending_expires_idx")
      .on(t.status, t.expiresAt)
      .where(sql`status = 'pending'`),
  }),
);

// ─── 7.6 companion_proactive_deliveries ───────────────────────────────────

export const companionProactiveDeliveries = pgTable(
  "companion_proactive_deliveries",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    permitId: text("permit_id").notNull(),
    conversationId: uuid("conversation_id").references(() => companionConversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => companionMessages.id),
    reasonId: text("reason_id").notNull(),
    suggestionClassId: text("suggestion_class_id").notNull(),
    contentPolicy: text("content_policy").$type<"content" | "content_hidden">().notNull(),
    status: text("status").$type<"pending" | "shown" | "suppressed" | "dismissed" | "expired">().notNull(),
    contentClaimedDeviceSessionHash: text("content_claimed_device_session_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    firstPresentedAt: timestamp("first_presented_at", { withTimezone: true }),
    shownAt: timestamp("shown_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    permitUnique: uniqueIndex("companion_proactive_deliveries_permit_unique").on(t.permitId),
  }),
);

// ─── 7.7 companion_action_proposals / companion_action_runs（迁移 0092/0095/0096） ──
// P5 typed action bridge（§6.6–§6.8）。FK（source_message_id / action_run_id /
// proposal_id / result_message_id）由手写迁移维护，此处仅镜像列集合与类型，
// 保证 drizzle-kit generate 不会把已存在表当新表重复生成。

export const companionActionProposals = pgTable(
  "companion_action_proposals",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull().references(() => companionConversations.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id").notNull(),
    sourceGeneration: integer("source_generation").notNull(),
    contextGrantId: uuid("context_grant_id"),
    payload: jsonb("payload").notNull(),
    payloadSha256: char("payload_sha256", { length: 64 }).notNull(),
    title: text("title").notNull(),
    targetSummary: text("target_summary").notNull(),
    impactSummary: text("impact_summary").notNull(),
    status: text("status").$type<"pending" | "rejected" | "accepted" | "executing" | "succeeded" | "failed" | "expired">().notNull(),
    decision: text("decision").$type<"confirm" | "reject">(),
    decisionKeyHash: char("decision_key_hash", { length: 64 }),
    idempotencyKeyHash: char("idempotency_key_hash", { length: 64 }).notNull(),
    // 迁移 0096 新增：confirm 请求体 sha256（幂等去重）。
    requestBodySha256: char("request_body_sha256", { length: 64 }),
    // 迁移 0095 新增：决策后创建的 action run。
    actionRunId: uuid("action_run_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    singlePendingIdx: uniqueIndex("companion_action_proposals_single_pending_idx")
      .on(t.conversationId)
      .where(sql`status = 'pending'`),
    decisionKeyIdx: uniqueIndex("companion_action_proposals_decision_key_idx")
      .on(t.decisionKeyHash)
      .where(sql`decision_key_hash IS NOT NULL`),
    workspaceIdx: index("companion_action_proposals_workspace_idx").on(t.workspaceId, t.userId),
    runIdx: index("companion_action_proposals_run_idx")
      .on(t.actionRunId)
      .where(sql`action_run_id IS NOT NULL`),
    // 2026-08-12（generate 对齐）：0106 定义单列 (conversation_id)
    conversationIdx: index("companion_action_proposals_conversation_idx").on(t.conversationId),
  }),
);

export const companionActionRuns = pgTable(
  "companion_action_runs",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull().references(() => companionConversations.id, { onDelete: "cascade" }),
    proposalId: uuid("proposal_id").notNull(),
    jobId: uuid("job_id"),
    status: text("status").$type<"accepted" | "running" | "succeeded" | "failed" | "cancelled">().notNull(),
    resultMessageId: uuid("result_message_id"),
    resultRef: text("result_ref"),
    route: jsonb("route"),
    safeSummary: text("safe_summary"),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    proposalUnique: uniqueIndex("companion_action_runs_proposal_idx").on(t.proposalId),
    workspaceIdx: index("companion_action_runs_workspace_idx").on(t.workspaceId, t.userId),
    // 迁移 0106 新增：DELETE conversation 前按 conversation 查 active run。
    conversationIdx: index("companion_action_runs_conversation_idx").on(t.conversationId),
  }),
);
