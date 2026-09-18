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
import { companionConversationV1Schema } from "./companion-conversation-contracts.ts";

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

export const companionMemoryStarNodeV1Schema = z.strictObject({
  memoryId: z.string().uuid(),
  kind: z.string().min(1).max(60),
  content: z.string().min(1).max(companionMemoryContentMaxLength),
  state: z.enum(["active", "pinned"]),
  entityLinks: z.array(z.strictObject({
    entityType: z.string().min(1).max(60),
    entityId: z.string().min(1).max(120),
    /** true = 关联的学习实体已被删除，星图上要画成断开的连线。 */
    orphaned: z.boolean(),
  })).max(200),
});
export type CompanionMemoryStarNodeV1 = z.infer<typeof companionMemoryStarNodeV1Schema>;

export const companionMemoryStarMapV1Schema = z.strictObject({
  version: z.literal(1),
  nodes: z.array(companionMemoryStarNodeV1Schema).max(500),
  cursor: z.null(),
});
export type CompanionMemoryStarMapV1 = z.infer<typeof companionMemoryStarMapV1Schema>;

// ─── 桌宠日记（§15.3 daily-summary-routes.ts）───────────────────────────

/**
 * Worker 的确定性模板只写这 12 个计数（companion-daily-summary.ts），但
 * facts 列是 jsonb，历史行可能带旧键。这里按"可选计数"解析，页面只渲染
 * 真正拿到的键，不补零、不编造。
 */
export const companionDailyFactsV1Schema = z.strictObject({
  notesCreated: z.number().int().min(0).optional(),
  notesUpdated: z.number().int().min(0).optional(),
  cardsCreated: z.number().int().min(0).optional(),
  sourcesCreated: z.number().int().min(0).optional(),
  jobsCreated: z.number().int().min(0).optional(),
  jobsCompleted: z.number().int().min(0).optional(),
  learningRunsCreated: z.number().int().min(0).optional(),
  learningRunsCompleted: z.number().int().min(0).optional(),
  pageContexts: z.number().int().min(0).optional(),
  conversationMessages: z.number().int().min(0).optional(),
  userMessages: z.number().int().min(0).optional(),
  assistantMessages: z.number().int().min(0).optional(),
});
export type CompanionDailyFactsV1 = z.infer<typeof companionDailyFactsV1Schema>;

export const companionDailyHighlightV1Schema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: z.string().max(200),
});
export type CompanionDailyHighlightV1 = z.infer<typeof companionDailyHighlightV1Schema>;

/** 日记日期用用户本地日历日（YYYY-MM-DD），不是 UTC 时间戳。 */
export const companionDailyDateV1Schema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const companionDailySummaryV1Schema = z.strictObject({
  version: z.literal(1),
  /** null = 尚未生成过任何一天；status 会是 not_generated。 */
  date: companionDailyDateV1Schema.nullable(),
  status: z.enum(["generated", "not_generated", "failed"]),
  generatedAt: isoTimestampSchema.nullable(),
  summary: z.string().max(500),
  facts: companionDailyFactsV1Schema,
  conversationHighlights: z.array(companionDailyHighlightV1Schema).max(8),
  /** 该日日记派生出的记忆条目（可能是候选，等确认）。 */
  memory: z.strictObject({
    memoryItemId: z.string().uuid(),
    candidate: z.boolean(),
  }).nullable(),
});
export type CompanionDailySummaryV1 = z.infer<typeof companionDailySummaryV1Schema>;

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

// ─── 对话记录（§6.3 GET /companion/conversations）───────────────────────

/**
 * 伴星中心只展示"我们聊过什么"的记录，不在这里续写对话——渲染层拿到的
 * 是会话摘要，没有消息正文，也没有发送通道。
 */
export const companionConversationListV1Schema = z.strictObject({
  version: z.literal(1),
  items: z.array(companionConversationV1Schema).max(50),
  nextCursor: z.string().max(2000).nullable(),
});
export type CompanionConversationListV1 = z.infer<typeof companionConversationListV1Schema>;

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
