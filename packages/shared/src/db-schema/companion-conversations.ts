/**
 * P2 companion conversation foundation（03 合同 §7.1–§7.6）。
 *
 * 六张表全部 workspace+user RLS（policy 匹配 app.workspace_id + app.user_id）。
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
import type {
  CompanionAgentRiskClass,
  CompanionAgentStepKind,
  CompanionAgentStepStatus,
  CompanionAgentToolStatus,
  CompanionMessageV1,
  CompanionStreamEventV1,
  ProviderReasoningHandle,
} from "@ailearn/shared";

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
    continuousHistoryIdx: index("companion_messages_workspace_user_created_id_idx")
      .on(t.workspaceId, t.userId, sql`${t.createdAt} DESC`, sql`${t.id} DESC`),
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
    status: text("status").$type<"accepted" | "running" | "waiting_for_confirmation" | "succeeded" | "cancel_requested" | "cancelled" | "failed" | "superseded">().notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestBodyHash: text("request_body_hash").notNull(),
    // 迁移 0107 新增（L11）：run 创建时冻结的账号世代
    // （companion_runtime_fences.surface_epoch）。
    accountEpoch: integer("account_epoch").notNull().default(0),
    providerId: text("provider_id"),
    modelId: text("model_id"),
    promptVersion: text("prompt_version"),
    /**
     * 这一发产出于哪一版泄露闸（39d #28；NULL＝那一版还没记，属"未归因"而不是"空版本"）。
     * 值由 `companionLeakGateVersionV1()` 派生，不手写。
     */
    leakGateVersion: text("leak_gate_version"),
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
    // Companion Agent v1 frozen runtime state.
    permissionLevel: text("permission_level").$type<"read_only" | "guided" | "full">(),
    permissionSnapshot: jsonb("permission_snapshot"),
    budgetSnapshot: jsonb("budget_snapshot"),
    stepCount: integer("step_count").notNull().default(0),
    toolCallCount: integer("tool_call_count").notNull().default(0),
    /** 已消耗的 Agent 执行毫秒数（跨确认续跑累计，不含等待用户确认的时间）。 */
    agentElapsedMs: integer("agent_elapsed_ms").notNull().default(0),
    waitingProposalId: uuid("waiting_proposal_id"),
    providerCapabilityFingerprint: text("provider_capability_fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversationGenerationUnique: uniqueIndex("companion_turn_runs_conversation_generation_unique").on(t.conversationId, t.generation),
    idempotencyUnique: uniqueIndex("companion_turn_runs_idempotency_unique").on(t.conversationId, t.idempotencyKeyHash),
    activeUnique: uniqueIndex("companion_turn_runs_active_unique")
      .on(t.conversationId)
      .where(sql`status IN ('accepted', 'running', 'waiting_for_confirmation', 'cancel_requested')`),
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

// ─── 7.4a Companion Agent audit ledger ───────────────────────────────────

export const companionAgentSteps = pgTable(
  "companion_agent_steps",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull().references(() => companionConversations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => companionTurnRuns.id, { onDelete: "cascade" }),
    stepNo: integer("step_no").notNull(),
    kind: text("kind").$type<CompanionAgentStepKind>().notNull(),
    status: text("status").$type<CompanionAgentStepStatus>().notNull(),
    requestHash: char("request_hash", { length: 64 }),
    resultHash: char("result_hash", { length: 64 }),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runStepUnique: uniqueIndex("companion_agent_steps_run_step_unique").on(t.runId, t.stepNo),
    workspaceRunIdx: index("companion_agent_steps_workspace_run_idx").on(t.workspaceId, t.userId, t.runId, t.stepNo),
  }),
);

export const companionAgentToolCalls = pgTable(
  "companion_agent_tool_calls",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id").notNull().references(() => companionConversations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => companionTurnRuns.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").notNull().references(() => companionAgentSteps.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    name: text("name").notNull(),
    toolVersion: text("tool_version").notNull(),
    arguments: jsonb("arguments").notNull(),
    argumentsSha256: char("arguments_sha256", { length: 64 }).notNull(),
    riskClass: text("risk_class").$type<CompanionAgentRiskClass>().notNull(),
    status: text("status").$type<CompanionAgentToolStatus>().notNull(),
    proposalId: uuid("proposal_id"),
    resultRef: text("result_ref"),
    resultSafeSummary: text("result_safe_summary"),
    /**
     * 该工具调用轮次的 provider 不透明 reasoning 句柄（见 0218 迁移）。
     * 用于用户确认后的冷启动续跑回放；已剥离明文思维链，NULL = 无句柄。
     */
    reasoningHandles: jsonb("reasoning_handles").$type<ProviderReasoningHandle[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    runToolCallUnique: uniqueIndex("companion_agent_tool_calls_run_call_unique").on(t.runId, t.toolCallId),
    workspaceRunIdx: index("companion_agent_tool_calls_workspace_run_idx").on(t.workspaceId, t.userId, t.runId, t.createdAt),
    proposalIdx: index("companion_agent_tool_calls_proposal_idx").on(t.proposalId),
  }),
);

// ─── 7.5 companion_voice_artifacts ───────────────────────────────────────

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

// ─── 7.7 companion_action_proposals（迁移 0092/0095/0096） ──────────────
// P5 typed action bridge（§6.6–§6.8）。FK（source_message_id）
// 由手写迁移维护，此处仅镜像列集合与类型，
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
    resultRef: text("result_ref"),
    resultRoute: jsonb("result_route"),
    resultSafeSummary: text("result_safe_summary"),
    idempotencyKeyHash: char("idempotency_key_hash", { length: 64 }).notNull(),
    // 迁移 0096 新增：confirm 请求体 sha256（幂等去重）。
    requestBodySha256: char("request_body_sha256", { length: 64 }),
    origin: text("origin").$type<"menu" | "agent_tool">(),
    // 39d W2-4 #16：full 档自动确认的标记（迁移 0278，默认 false＝照旧等人点）。
    autoConfirm: boolean("auto_confirm").notNull().default(false),
    agentRunId: uuid("agent_run_id"),
    agentToolCallId: text("agent_tool_call_id"),
    agentToolVersion: text("agent_tool_version"),
    riskClass: text("risk_class").$type<CompanionAgentRiskClass>(),
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
    // 2026-08-12（generate 对齐）：0106 定义单列 (conversation_id)
    conversationIdx: index("companion_action_proposals_conversation_idx").on(t.conversationId),
  }),
);
