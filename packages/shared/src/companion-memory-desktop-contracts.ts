/**
 * 伴星中心（桌面页 20）读取合同。
 *
 * 服务端早已提供记忆、记忆星图、日记与人格档案（`/companion/memory`、
 * `/companion/memory/star-map`、`/companion/daily`、`/companion/pet-profile`），
 * 但桌面客户端此前没有对应的 typed IPC。本模块把这几条只读响应的 wire shape
 * 固化下来，让 main 进程在把结果交给渲染层之前先 fail-closed 校验一遍。
 *
 * 写操作（确认 / 忽略 / 固定 / 归档 / 删除）复用 `companionMemoryItemV1Schema`
 * 作为返回体——服务端这些端点返回的就是同一条记忆。
 *
 * 所有 schema 都是 strict：服务端多出任何 main-only 字段都会在这里被拒绝，
 * 而不是原样漏给渲染进程。
 */

import { z } from "zod";
import {
  companionContentBlockV1Schema,
  companionImageBlockV1Schema,
  companionQuoteBlockV1Schema,
  companionTextBlockV1Schema,
} from "./companion-conversation-contracts.ts";

// ─── 记忆条目（§3.3 memory-routes.ts 的 MemoryItemV2）────────────────────

export const companionMemoryKindV1Schema = z.enum([
  "preference",
  "goal",
  "learning_context",
  "interaction_note",
  "episodic",
]);
export type CompanionMemoryKindV1 = z.infer<typeof companionMemoryKindV1Schema>;

export const companionMemoryScopeV1Schema = z.enum(["global", "workspace", "task"]);
export type CompanionMemoryScopeV1 = z.infer<typeof companionMemoryScopeV1Schema>;

export const companionMemorySourceTypeV1Schema = z.enum([
  "user_stated",
  "model_inferred",
  "confirmed",
  "summary",
]);
export type CompanionMemorySourceTypeV1 = z.infer<typeof companionMemorySourceTypeV1Schema>;

export const companionMemoryEmbeddingStatusV1Schema = z.enum(["none", "pending", "ready", "failed"]);
export type CompanionMemoryEmbeddingStatusV1 = z.infer<
  typeof companionMemoryEmbeddingStatusV1Schema
>;

const isoTimestampSchema = z.string().datetime({ offset: true });

/** 写入端统一限制 ≤200 字（memory-routes §9.4/§25），读取侧照抄同一上限。 */
export const companionMemoryContentMaxLength = 200;

export const companionMemoryItemV1Schema = z.strictObject({
  memoryItemId: z.string().uuid(),
  kind: companionMemoryKindV1Schema,
  content: z.string().min(1).max(companionMemoryContentMaxLength),
  sourceEventId: z.string().max(240).nullable(),
  sourceSessionId: z.string().uuid().nullable(),
  userStated: z.boolean(),
  userConfirmed: z.boolean(),
  /** true = 候选记忆：尚未写入长期记忆，等用户在伴星中心裁决。 */
  candidate: z.boolean(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  scope: companionMemoryScopeV1Schema,
  pinned: z.boolean(),
  archived: z.boolean(),
  dismissedAt: isoTimestampSchema.nullable(),
  conflictGroup: z.string().uuid().nullable(),
  embeddingStatus: companionMemoryEmbeddingStatusV1Schema,
  sourceType: companionMemorySourceTypeV1Schema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type CompanionMemoryItemV1 = z.infer<typeof companionMemoryItemV1Schema>;

/** `GET /companion/memory`；服务端一次最多返回 200 条。 */
export const companionMemoryListV1Schema = z.strictObject({
  version: z.literal(2),
  items: z.array(companionMemoryItemV1Schema).max(200),
});
export type CompanionMemoryListV1 = z.infer<typeof companionMemoryListV1Schema>;

// ─── 记忆星图（§2.6 memory-star-map.ts）──────────────────────────────────

export const companionMemoryEntityTypeV2Schema = z.enum([
  "note",
  "source",
  "card",
  "key_point",
  "learning_run",
]);
export type CompanionMemoryEntityTypeV2 = z.infer<typeof companionMemoryEntityTypeV2Schema>;

export const companionMemoryEntityTargetV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("note"), noteId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("source"), sourceId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("objective"), objectiveId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("understanding"), objectiveId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("learning_run"), runId: z.string().uuid() }),
]);
export type CompanionMemoryEntityTargetV2 = z.infer<typeof companionMemoryEntityTargetV2Schema>;

const companionMemoryEntityLinkV2Schema = z.strictObject({
  entityType: companionMemoryEntityTypeV2Schema,
  entityId: z.string().uuid(),
  /** 服务端解析后的可读名称；失效实体也必须返回稳定的说明，禁止显示裸 UUID。 */
  label: z.string().min(1).max(240),
  target: companionMemoryEntityTargetV2Schema.nullable(),
  /** true = 关联的学习实体已删除；此时必须不可导航。 */
  orphaned: z.boolean(),
}).superRefine((link, context) => {
  if (link.orphaned && link.target !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "orphaned memory links cannot be navigable" });
  }
  if (!link.orphaned && link.target === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "live memory links require a navigation target" });
  }
});

export const companionMemoryStarNodeV2Schema = z.strictObject({
  memoryId: z.string().uuid(),
  kind: companionMemoryKindV1Schema,
  content: z.string().min(1).max(companionMemoryContentMaxLength),
  state: z.enum(["active", "pinned"]),
  importance: z.number().min(0).max(1),
  updatedAt: isoTimestampSchema,
  entityLinks: z.array(companionMemoryEntityLinkV2Schema).max(200),
});
export type CompanionMemoryStarNodeV2 = z.infer<typeof companionMemoryStarNodeV2Schema>;

export const companionMemoryStarMapV2Schema = z.strictObject({
  version: z.literal(2),
  nodes: z.array(companionMemoryStarNodeV2Schema).max(500),
  cursor: z.null(),
});
export type CompanionMemoryStarMapV2 = z.infer<typeof companionMemoryStarMapV2Schema>;

// ─── 桌宠日记（§15.3 daily-summary-routes.ts）───────────────────────────

/**
 * 日记只有她自己写的那一段话。当天计数（`companion_daily_summaries.facts`）**不再上线**：
 * 用户 2026-09-21 的裁决是"这跟系统统计数据有什么区别"，而 facts 仍要写进 DB，
 * 因为 `companion-thought.ts` 靠 `learningRunsCreated/Completed` 算连续学习天数。
 */
export const companionDailyFailureReasonV1Schema = z.enum([
  "consent_required",
  "model_unavailable",
  "diary_output_invalid",
]);
export type CompanionDailyFailureReasonV1 = z.infer<typeof companionDailyFailureReasonV1Schema>;

/** 日记日期用用户本地日历日（YYYY-MM-DD），不是 UTC 时间戳。 */
export const companionDailyDateV1Schema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * 日记正文的块（0252）。成员 schema 直接引用对话那三个，不抄第二份。
 *
 * 只收 `text`/`quote`/`image`：日记是"她写的那一天"，不是操作流，
 * 所以 `nav`/`action_ref`/`card` 这些带对话语义的块不进这一页。
 * 以后放开音频/视频时，在这里加一个成员就接得上——渲染层按 type 分发。
 *
 * `text.emotion`（驱动 Live2D 表情那个字段）对日记无意义，但**不在此处剔除**：
 * 剔除就等于复制一份 text schema，两份会在长度上限变化时分叉。生成器从不写它。
 */
export const companionDailyBlockV1Schema = z.discriminatedUnion("type", [
  companionTextBlockV1Schema,
  companionQuoteBlockV1Schema,
  companionImageBlockV1Schema,
]);
export type CompanionDailyBlockV1 = z.infer<typeof companionDailyBlockV1Schema>;

export const companionDailySummaryV1Schema = z.strictObject({
  version: z.literal(1),
  /** null = 尚未生成过任何一天；status 会是 not_generated。 */
  date: companionDailyDateV1Schema.nullable(),
  status: z.enum(["generated", "not_generated", "failed"]),
  generatedAt: isoTimestampSchema.nullable(),
  /** status=failed 的成因；generated / not_generated 恒为 null。 */
  failureReason: companionDailyFailureReasonV1Schema.nullable(),
  /**
   * 正文块序列。0252 之前的历史行 DB 里 `blocks='[]'`，只读路由把它投影成
   * 单个 text 块（内容来自当时的 `summary`），所以这里永远非空——
   * 渲染层不需要为"旧日子没有块"写分支。
   */
  blocks: z.array(companionDailyBlockV1Schema).max(24),
  /** 该日日记派生出的记忆条目（可能是候选，等确认）。 */
  memory: z.strictObject({
    memoryItemId: z.string().uuid(),
    candidate: z.boolean(),
  }).nullable(),
});
export type CompanionDailySummaryV1 = z.infer<typeof companionDailySummaryV1Schema>;

export const companionDailyMonthValueV1Schema = z.string().regex(/^\d{4}-\d{2}$/);

/**
 * 一个月里「她写过哪几天」——月历要打的标记。
 *
 * 只回**有记录的那些天**，不为空日补位：整月最多 31 条，空位由渲染端按月份自己
 * 排。`status` 只有 generated / failed 两种，因为表里就只有这两种行；
 * 「没写过」不是失败，是一种缺席，由日历上**没有标记**表达。
 */
export const companionDailyMonthV1Schema = z.strictObject({
  version: z.literal(1),
  month: companionDailyMonthValueV1Schema,
  days: z.array(z.strictObject({
    date: companionDailyDateV1Schema,
    status: z.enum(["generated", "failed"]),
  })).max(31),
});
export type CompanionDailyMonthV1 = z.infer<typeof companionDailyMonthV1Schema>;

// ─── 人格档案（§2.1/§12.2 pet-profile-routes.ts）────────────────────────

export const companionPersonaActivenessV1Schema = z.enum(["quiet", "moderate", "active"]);
export type CompanionPersonaActivenessV1 = z.infer<typeof companionPersonaActivenessV1Schema>;

export const companionPersonaBoundariesV1Schema = z.strictObject({
  allowPlayful: z.boolean().optional(),
  allowNudgeLearning: z.boolean().optional(),
  allowVoiceTags: z.boolean().optional(),
  catchphrase: z.string().max(80).nullable().optional(),
});
export type CompanionPersonaBoundariesV1 = z.infer<typeof companionPersonaBoundariesV1Schema>;

/** `GET /companion/pet-profile` 的 profile：无自定义时服务端返回系统默认。 */
export const companionPersonaProfileV1Schema = z.strictObject({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  presetId: z.string().max(80).nullable(),
  name: z.string().min(1).max(60),
  personalityTags: z.array(z.string().min(1).max(20)).max(10),
  speakingStyle: z.string().min(1).max(1000),
  examples: z.array(z.strictObject({ text: z.string().min(1).max(200) })).max(5),
  activeness: companionPersonaActivenessV1Schema,
  boundaries: companionPersonaBoundariesV1Schema,
  revision: z.number().int().positive(),
  familiarity: z.number().min(0).max(1),
  interactionCount: z.number().int().min(0),
  lastActiveAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type CompanionPersonaProfileV1 = z.infer<typeof companionPersonaProfileV1Schema>;

export const companionPersonaPresetV1Schema = z.strictObject({
  presetId: z.string().min(1).max(80),
  name: z.string().min(1).max(60),
  personalityTags: z.array(z.string().min(1).max(20)).max(10),
  speakingStyle: z.string().min(1).max(1000),
  examples: z.array(z.strictObject({ text: z.string().min(1).max(200) })).max(5),
  activeness: companionPersonaActivenessV1Schema,
  boundaries: companionPersonaBoundariesV1Schema,
});
export type CompanionPersonaPresetV1 = z.infer<typeof companionPersonaPresetV1Schema>;

export const companionPersonaV1Schema = z.strictObject({
  version: z.literal(1),
  profile: companionPersonaProfileV1Schema.nullable(),
  presets: z.array(companionPersonaPresetV1Schema).max(20),
  activePreset: companionPersonaPresetV1Schema.nullable(),
});
export type CompanionPersonaV1 = z.infer<typeof companionPersonaV1Schema>;

/**
 * `PATCH /companion/pet-profile` 的请求体（§12.1.3）。
 *
 * 服务端把这份 body 整体写入，不做字段级合并：`examples` 与 `boundaries` 省略时
 * 会被服务端默认值清空。所以调用方**必须**每次提交完整的档案内容，而不是只提交
 * 被改动的那一项——`companionPersonaPatchFromProfile` 就是这条纪律的唯一实现。
 */
export const companionPersonaPatchV1Schema = z.strictObject({
  /** 当前 revision，CAS 乐观锁；服务端版本不一致时返回 409。 */
  revision: z.number().int().positive().optional(),
  presetId: z.string().min(1).max(80).nullable().optional(),
  name: z.string().min(1).max(60),
  personalityTags: z.array(z.string().min(1).max(20)).min(1).max(10),
  speakingStyle: z.string().min(1).max(1000),
  examples: z.array(z.strictObject({ text: z.string().min(1).max(200) })).max(5),
  activeness: companionPersonaActivenessV1Schema,
  boundaries: companionPersonaBoundariesV1Schema,
});
export type CompanionPersonaPatchV1 = z.infer<typeof companionPersonaPatchV1Schema>;

/** `PATCH /companion/pet-profile` 的成功响应：被写入的那一版档案。 */
export const companionPersonaMutationV1Schema = z.strictObject({
  version: z.literal(1),
  profile: companionPersonaProfileV1Schema,
});
export type CompanionPersonaMutationV1 = z.infer<typeof companionPersonaMutationV1Schema>;

/** `POST /companion/pet-profile/reset` 的成功响应。 */
export const companionPersonaResetV1Schema = z.strictObject({
  version: z.literal(1),
  ok: z.literal(true),
});
export type CompanionPersonaResetV1 = z.infer<typeof companionPersonaResetV1Schema>;

/** 页面改动一项设置时，用它把「整套档案 + 这一项」拼成合法请求体。 */
export function companionPersonaPatchFromProfile(
  profile: CompanionPersonaProfileV1,
  change: {
    readonly presetId?: string | null;
    readonly activeness?: CompanionPersonaActivenessV1;
    readonly boundaries?: CompanionPersonaBoundariesV1;
  },
): CompanionPersonaPatchV1 {
  return companionPersonaPatchV1Schema.parse({
    revision: profile.revision,
    presetId: change.presetId !== undefined ? change.presetId : profile.presetId,
    name: profile.name,
    personalityTags: profile.personalityTags,
    speakingStyle: profile.speakingStyle,
    examples: profile.examples,
    activeness: change.activeness ?? profile.activeness,
    boundaries: change.boundaries ?? profile.boundaries,
  });
}

/** 应用一套服务端预设：预设自带完整档案内容，所以不需要已有 profile。 */
export function companionPersonaPatchFromPreset(
  preset: CompanionPersonaPresetV1,
  revision?: number,
): CompanionPersonaPatchV1 {
  return companionPersonaPatchV1Schema.parse({
    ...(revision !== undefined ? { revision } : {}),
    presetId: preset.presetId,
    name: preset.name,
    personalityTags: preset.personalityTags,
    speakingStyle: preset.speakingStyle,
    examples: preset.examples,
    activeness: preset.activeness,
    boundaries: preset.boundaries,
  });
}

// ─── 连续对话历史（产品层不暴露 conversation）──────────────────────────

export const companionHistoryItemV1Schema = z.strictObject({
  version: z.literal(1),
  messageId: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  kind: z.enum(["text", "voice_transcript", "proactive", "action", "result", "error", "cancelled"]),
  blocks: z.array(companionContentBlockV1Schema).min(1).max(32),
  runId: z.string().uuid().nullable(),
  createdAt: isoTimestampSchema,
  editedAt: isoTimestampSchema.nullable(),
});
export type CompanionHistoryItemV1 = z.infer<typeof companionHistoryItemV1Schema>;

export const companionHistoryPageV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(companionHistoryItemV1Schema).max(100),
  nextCursor: z.string().max(2000).nullable(),
});
export type CompanionHistoryPageV1 = z.infer<typeof companionHistoryPageV1Schema>;

export const companionHistorySearchV1Schema = z.strictObject({
  version: z.literal(1),
  query: z.string().min(1).max(120),
  items: z.array(companionHistoryItemV1Schema).max(50),
});
export type CompanionHistorySearchV1 = z.infer<typeof companionHistorySearchV1Schema>;

export const companionHistoryClearResultV1Schema = z.strictObject({
  version: z.literal(1),
  deletedMessages: z.number().int().min(0),
  deletedConversations: z.number().int().min(0),
  inboxCreated: z.literal(true),
});
export type CompanionHistoryClearResultV1 = z.infer<typeof companionHistoryClearResultV1Schema>;

export const companionHistoryQueryV1Schema = z.strictObject({
  before: z.string().max(2000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type CompanionHistoryQueryV1 = z.infer<typeof companionHistoryQueryV1Schema>;

export const companionHistorySearchQueryV1Schema = z.strictObject({
  q: z.string().min(1).max(120),
  limit: z.number().int().min(1).max(50).optional(),
});
export type CompanionHistorySearchQueryV1 = z.infer<typeof companionHistorySearchQueryV1Schema>;

// ─── 记忆写操作请求 ─────────────────────────────────────────────────────

export const companionMemoryIdInputSchema = z.strictObject({
  memoryId: z.string().uuid(),
});
export type CompanionMemoryIdInput = z.infer<typeof companionMemoryIdInputSchema>;

/** 星图与列表共用的读取筛选；candidate / archived 默认都不进主视图。 */
export const companionMemoryListQuerySchema = z.strictObject({
  kind: companionMemoryKindV1Schema.optional(),
  q: z.string().min(1).max(200).optional(),
  scope: companionMemoryScopeV1Schema.optional(),
  includeCandidates: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
});
export type CompanionMemoryListQuery = z.infer<typeof companionMemoryListQuerySchema>;

export const companionMemoryCreateInputV1Schema = z.strictObject({
  kind: companionMemoryKindV1Schema,
  content: z.string().min(1).max(companionMemoryContentMaxLength),
  importance: z.number().min(0).max(1).optional(),
  scope: companionMemoryScopeV1Schema.optional(),
});
export type CompanionMemoryCreateInputV1 = z.infer<typeof companionMemoryCreateInputV1Schema>;

export const companionMemoryCorrectInputV1Schema = z.strictObject({
  content: z.string().min(1).max(companionMemoryContentMaxLength),
  reason: z.string().min(1).max(500).optional(),
});
export type CompanionMemoryCorrectInputV1 = z.infer<typeof companionMemoryCorrectInputV1Schema>;

export const companionMemoryConflictListV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(companionMemoryItemV1Schema).max(200),
});
export const companionMemoryConflictResolveResultV1Schema = z.strictObject({
  version: z.literal(1),
  ok: z.literal(true),
});
export const companionMemoryQueueResultV1Schema = z.strictObject({
  version: z.literal(1),
  queued: z.literal(true),
});
export const companionMemoryClearResultV1Schema = z.strictObject({
  deletedCount: z.number().int().min(0),
});

// ─── 动态投递与数据管理（renderer-safe projection）──────────────────────

export const companionActivityDeliveryV1Schema = z.strictObject({
  version: z.literal(1),
  deliveryId: z.string().uuid(),
  inboxSequence: z.number().int().min(0),
  state: z.enum(["queued", "delivered", "displayed", "acted", "dismissed", "snoozed", "expired", "suppressed"]),
  kind: z.enum(["message", "proposal", "action_result", "system_event", "memory_candidate"]),
  label: z.string().min(1).max(240),
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("dialogue"), messageId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("proposal"), proposalId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("memory"), memoryId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("none") }),
  ]),
  expired: z.boolean(),
  createdAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
});
export type CompanionActivityDeliveryV1 = z.infer<typeof companionActivityDeliveryV1Schema>;

export const companionActivityTimelineV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(companionActivityDeliveryV1Schema).max(100),
  nextCursor: z.number().int().min(0),
  serverTime: isoTimestampSchema,
});
export type CompanionActivityTimelineV1 = z.infer<typeof companionActivityTimelineV1Schema>;

export const companionActivityAckRequestV1Schema = z.strictObject({
  deliveryId: z.string().uuid(),
  inboxSequence: z.number().int().min(0),
  transition: z.enum(["displayed", "acted", "dismissed"]),
});
export type CompanionActivityAckRequestV1 = z.infer<typeof companionActivityAckRequestV1Schema>;

export const companionExportKindV1Schema = z.enum(["all", "memory", "audit"]);
export type CompanionExportKindV1 = z.infer<typeof companionExportKindV1Schema>;

export const companionExportResultV1Schema = z.strictObject({
  version: z.literal(1),
  saved: z.boolean(),
  canceled: z.boolean(),
  /** 只把用户已经选择的文件名回给 renderer，不暴露完整本机路径。 */
  fileName: z.string().min(1).nullable(),
  bytes: z.number().int().min(0),
});
export type CompanionExportResultV1 = z.infer<typeof companionExportResultV1Schema>;

export const companionAuditDeleteResultV1Schema = z.strictObject({
  deletedAudit: z.number().int().min(0),
  deletedLedger: z.number().int().min(0),
});
export type CompanionAuditDeleteResultV1 = z.infer<typeof companionAuditDeleteResultV1Schema>;
