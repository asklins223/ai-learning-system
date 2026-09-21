/**
 * P2 — Durable Text Conversation 共享合同（03-conversation-api-data-proactive-contract.md §2–§6）。
 *
 * 唯一 wire truth：Conversation / Message / ContentBlock / Turn / CharacterCue /
 * SSE envelope + discriminated payload / 公开错误码。所有网络/IPC/DB JSON shape
 * 均为 zod strict；类型只用 z.infer 导出；枚举未知值 fail closed。
 *
 * 长度语义：V1 全部 min/max 按 JavaScript UTF-16 code unit（text.length）计数。
 * hash：所有小写 64 位 SHA-256 复用 content-hash.ts 的 canonicalJsonV1/sha256Hex。
 */

import { z } from "zod";
import { allowedMainRouteV2Schema } from "./companion-bridge-contracts.ts";
import {
  characterCueEmotionV1Schema,
  characterCueIntentV1Schema,
} from "./companion-character-contracts.ts";
import { companionAgentToolEventV1Schema } from "./companion-agent-contracts.ts";
import { sourceImageObjectKeyFromUrl } from "./source-image-contracts.ts";
import { createLearningRunV2RequestSchema } from "./learning-target-v2-contracts.ts";

// ─── 基础 ────────────────────────────────────────────────────────────────

export const companionHashV1Schema = z.string().regex(/^[a-f0-9]{64}$/);
export type CompanionHashV1 = z.infer<typeof companionHashV1Schema>;

/**
 * 收件箱投递的 NOTIFY 通道（16 §14.3）。
 *
 * 放在 shared 而不是 api 的 companion-notify.ts 里，是因为写入方有两个进程：
 * API 的 `deliver()` 和 worker 直投的主动念头/记忆候选。通道名写不一致**不会报错**，
 * 只会让新投递安静地等到 SSE 的 durable 轮询才被发现——主动气泡因此"看起来从不出现"。
 */
export const COMPANION_INBOX_NOTIFY_CHANNEL = "ailearn_companion_inbox_v1";

// ─── Conversation（§3.1） ────────────────────────────────────────────────

export const companionConversationV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  kind: z.enum(["dialogue", "inbox", "journey"]),
  title: z.string().min(1).max(120),
  titleSource: z.enum(["placeholder", "auto", "user", "system"]),
  status: z.enum(["active", "archived"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastMessageAt: z.string().datetime().nullable(),
}).strict();

export type CompanionConversationV1 = z.infer<typeof companionConversationV1Schema>;

// ─── Content blocks（§3.2） ───────────────────────────────────────────────

/**
 * 单个块的 schema 各自命名导出：桌宠日记（0252）只收 `text`/`quote`/`image`
 * 三种，它必须**引用**这里的定义而不是再抄一份——抄的那份会在
 * "图片 url 只收站内 /api/uploads/"这类校验规则变化时悄悄落后。
 */
export const companionTextBlockV1Schema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(20_000),
  // 语气层情绪（2026-09-18）：worker 确定性语气分类的落库形态，
  // 渲染层据此驱动 Live2D 表情。可选，历史消息没有该字段。
  emotion: characterCueEmotionV1Schema.optional(),
}).strict();

/**
 * 她读出来的那段原文（方案 29 §4.8，抱怨 #10「只能输出纯文本」）。
 *
 * 为什么由服务端而不是模型给：`companion_read_note` 已经取到了正文，
 * 让模型把这几百字**再抄一遍**既慢又必然改写——用户看到的"引用"就不是原文。
 * 服务端直接带出这一块，她的正文只负责说"我读到了什么、意味着什么"。
 * 桌宠日记（0252）同一条规矩：她给引用编号，原文由服务端带。
 */
export const companionQuoteBlockV1Schema = z.object({
  type: z.literal("quote"),
  label: z.string().min(1).max(80),
  text: z.string().min(1).max(2_000),
}).strict();

/**
 * 她把某张图**摆到对话里**（方案 29 §4.8 里 B6 剩下的那一块，抱怨 #9 的另一半）。
 *
 * 与 `companion_read_image` 是两件不同的事：读图要把字节发给视觉模型（受
 * `sendImageContent` 管，政策关着时工具根本不下发）；这一块只是让本机显示一张
 * **她自己库里**的图，一个字节都不出境。所以用户说"把那张图给我看"时，即使
 * 图片外发关着，她也做得成。
 *
 * `url` 的校验刻意复用渲染层那同一个函数（`sourceImageObjectKeyFromUrl`）：
 * "合同收得下"与"显示得出"必须是同一件事，否则会出现一条能落库却永远显示不出来的块。
 * 而它只能由**服务端**从 `note_image_assets` 的行拼出来——模型给不出这个字段，
 * 也就给不出一个指向站外地址的 img src。
 */
export const companionImageBlockV1Schema = z.object({
  type: z.literal("image"),
  url: z.string().max(2_000).refine(
    (value) => sourceImageObjectKeyFromUrl(value) !== null,
    { message: "only site-internal /api/uploads/ image urls are displayable" },
  ),
  /** 图注：她说的是哪一张（`《笔记标题》· 第 2 张`）。渲染在图下面。 */
  label: z.string().min(1).max(80),
  /** 无障碍替代文字；缺省时渲染层回落到 label。 */
  alt: z.string().min(1).max(120).optional(),
}).strict();

export const companionContentBlockV1Schema = z.discriminatedUnion("type", [
  companionTextBlockV1Schema,
  z.object({
    type: z.literal("code"),
    language: z.string().min(1).max(40).optional(),
    code: z.string().min(1).max(20_000),
  }).strict(),
  z.object({
    type: z.literal("citation"),
    label: z.string().min(1).max(200),
    target: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("external_https"),
        href: z.string().url().max(2_000).refine((value) => new URL(value).protocol === "https:"),
      }).strict(),
      z.object({
        kind: z.literal("entity"),
        entityRef: z.string().min(1).max(240),
      }).strict(),
    ]),
  }).strict(),
  z.object({
    type: z.literal("action_ref"),
    proposalId: z.string().uuid(),
  }).strict(),
  /**
   * 跳转落点**进消息流**（方案 29 §4.8，抱怨 #5「连跳到某个笔记都做不到」的收尾）。
   *
   * 以前 route 只活在 `agent.tool` SSE 事件与一个游离在消息之外的 chip 行里：
   * 事件有 TTL、chip 不落在正文顺序里，于是"她带我去看的那篇笔记"在回看时**根本不存在**。
   * 现在 she 打开什么，就在那句话下面留一个可点、可重放的落点。
   *
   * `route` 直接复用主进程那份白名单 schema（`allowedMainRouteV2Schema`），
   * 不再抄第二份"客户端能跳哪儿"的清单——两份清单必然分叉。
   */
  z.object({
    type: z.literal("nav"),
    label: z.string().min(1).max(80),
    route: allowedMainRouteV2Schema,
  }).strict(),
  /**
   * 她读出来的那段原文（方案 29 §4.8，抱怨 #10「只能输出纯文本」）。
   *
   * 为什么由服务端而不是模型给：`companion_read_note` 已经取到了正文，
   * 让模型把这几百字**再抄一遍**既慢又必然改写——用户看到的"引用"就不是原文。
   * 服务端直接带出这一块，她的正文只负责说"我读到了什么、意味着什么"。
   */
  companionQuoteBlockV1Schema,
  /**
   * 步骤/流程（方案 29 §4.8）。收的是**结构化输入**（`companion_render_diagram`），
   * 不是让模型用文字"画"——她用字符画箭头时，客户端只能当纯文本换行显示，
   * 手机上还会折行错乱。
   *
   * 只做"竖向步骤流"这一种版式：条目数与字段长度都收紧，渲染层不需要布局引擎，
   * 也不会因为模型给出 40 步而把消息列撑爆。
   */
  z.object({
    type: z.literal("diagram"),
    title: z.string().min(1).max(60),
    steps: z.array(z.object({
      label: z.string().min(1).max(40),
      detail: z.string().max(80).optional(),
    }).strict()).min(2).max(8),
  }).strict(),
  /**
   * 她打开的那张卡片**内容**（§4.8）。`nav` 块只回答"跳去哪"，这块回答"这张卡写着什么"——
   * 由 `companion_open_card` 服务端带出，同样不让模型转抄题面。
   *
   * 字段按 `learning_cards_v2` 真实有的东西来：题面（front.cue/prompt）、
   * 这张卡在考什么（public_summary）、知识形态。**没有"答案"字段**——
   * 回忆卡的正文里本来就不存标准答案，编一个出来比缺一个字段更糟。
   */
  z.object({
    type: z.literal("card"),
    cardId: z.string().uuid(),
    front: z.string().min(1).max(600),
    summary: z.string().max(600).nullable(),
    knowledgeForm: z.string().max(40).nullable(),
  }).strict(),
  companionImageBlockV1Schema,
]);

export type CompanionContentBlockV1 = z.infer<typeof companionContentBlockV1Schema>;

// ─── Message（§3.3） ──────────────────────────────────────────────────────

export const companionMessageV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  seq: z.number().int().positive(),
  role: z.enum(["user", "assistant", "system"]),
  kind: z.enum([
    "text",
    "voice_transcript",
    "proactive",
    "action",
    "result",
    "error",
    /**
     * 用户按下"停止"时已经产出、但没能说完的那一段（2026-09-19）。
     *
     * 取消后 worker 的 latest-generation fence 会让迟到的 final 零写入，于是用户
     * 看过的内容会从历史里消失。这条 kind 把当时累积的文本留下来——它是**给人看
     * 的历史记录，不是给模型的上下文**：装配 next-turn prompt 时必须排除它，
     * 否则半截话会让下一轮顺着断句续写（见 companion-dialogue.ts 的历史 SELECT）。
     */
    "cancelled",
  ]),
  blocks: z.array(companionContentBlockV1Schema).min(1).max(32),
  runId: z.string().uuid().nullable(),
  clientMessageId: z.string().uuid().nullable(),
  // 2026-08-11：API 实际返回 contentSha256（内容校验用），契约补齐声明
  contentSha256: z.string().length(64),
  createdAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable(),
}).strict();

export type CompanionMessageV1 = z.infer<typeof companionMessageV1Schema>;

// ─── Turn run（§4.3） ─────────────────────────────────────────────────────

export const companionRunStatusV1Schema = z.enum([
  "accepted",
  "running",
  "waiting_for_confirmation",
  "succeeded",
  "cancel_requested",
  "cancelled",
  "failed",
  "superseded",
]);

export type CompanionRunStatusV1 = z.infer<typeof companionRunStatusV1Schema>;

export const companionTurnRunV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid().nullable(),
  generation: z.number().int().positive(),
  status: companionRunStatusV1Schema,
  phase: z.enum(["accepted", "thinking", "streaming", "acting", "awaiting_confirmation"]).nullable(),
  previewText: z.string().max(20_000),
  previewTextSha256: companionHashV1Schema,
  lastEventSeq: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export type CompanionTurnRunV1 = z.infer<typeof companionTurnRunV1Schema>;

// ─── Turn cancel（§6.5） ──────────────────────────────────────────────────

export const cancelCompanionRunRequestV1Schema = z.object({
  version: z.literal(1),
  generation: z.number().int().positive(),
  reason: z.literal("user"),
}).strict();

export const cancelCompanionRunResponseV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  status: companionRunStatusV1Schema,
  eventCursor: z.number().int().nonnegative(),
}).strict();

export type CancelCompanionRunRequestV1 = z.infer<typeof cancelCompanionRunRequestV1Schema>;
export type CancelCompanionRunResponseV1 = z.infer<typeof cancelCompanionRunResponseV1Schema>;

// ─── Page context（§4.1） — P2 提交的 bounded 页面上下文 ───────────────────

/**
 * LearningRun 是现行正式学习容器。它的 Tutor 授权必须同时绑定 Run、冻结
 * target snapshot 和当前 task。
 */
const companionLearningRunGroundedTutorGrantPayloadV1Schema = z.object({
  version: z.literal(1),
  grantId: z.string().uuid(),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  pageInstanceId: z.string().uuid(),
  pageKind: z.literal("learning_run"),
  capability: z.literal("grounded_tutor"),
  runId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  taskId: z.string().uuid(),
  contextRevision: companionHashV1Schema,
  permissionSnapshotHash: companionHashV1Schema,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export const companionGroundedTutorGrantPayloadV1Schema = z.discriminatedUnion("pageKind", [
  companionLearningRunGroundedTutorGrantPayloadV1Schema,
]);

export type CompanionGroundedTutorGrantPayloadV1 = z.infer<
  typeof companionGroundedTutorGrantPayloadV1Schema
>;

export const companionGroundedTutorGrantV1Schema = z.discriminatedUnion("pageKind", [
  companionLearningRunGroundedTutorGrantPayloadV1Schema.extend({
    signature: companionHashV1Schema,
  }).strict(),
]);

export type CompanionGroundedTutorGrantV1 = z.infer<
  typeof companionGroundedTutorGrantV1Schema
>;

export const companionPageContextV1Schema = z.discriminatedUnion("pageKind", [
  z.object({
    pageKind: z.literal("today"),
    sharing: z.literal("page_registered"),
    // 非学习运行页没有服务端签发的 revision 来源（旧 web 已删）；渲染层
    // 只声明"我在这一页"，revision 留空（2026-09-18 聊天抽屉接线）。
    contextRevision: companionHashV1Schema.optional(),
  }).strict(),
  z.object({
    pageKind: z.literal("review"),
    sharing: z.enum(["page_registered", "user_selected"]),
    cardId: z.string().uuid().optional(),
    keyPointId: z.string().uuid().optional(),
    contextRevision: companionHashV1Schema.optional(),
  }).strict(),
  z.object({
    pageKind: z.literal("card"),
    sharing: z.enum(["page_registered", "user_selected"]),
    cardId: z.string().uuid(),
    keyPointId: z.string().uuid().optional(),
    contextRevision: companionHashV1Schema.optional(),
  }).strict(),
  z.object({
    pageKind: z.literal("star_map"),
    sharing: z.enum(["page_registered", "user_selected"]),
    keyPointId: z.string().uuid().optional(),
    contextRevision: companionHashV1Schema.optional(),
  }).strict(),
  z.object({
    pageKind: z.literal("learning_run"),
    sharing: z.enum(["page_registered", "user_selected"]),
    runId: z.string().uuid(),
    snapshotId: z.string().uuid(),
    taskId: z.string().uuid(),
    requestedCapability: z.enum(["none", "grounded_tutor"]),
    // learning_run 保留必填：grounded_tutor grant 以它做新鲜度校验。
    contextRevision: companionHashV1Schema,
    groundedTutorGrant: companionGroundedTutorGrantV1Schema.nullable(),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.pageKind !== "learning_run") return;
  const required = value.requestedCapability === "grounded_tutor";
  if (required !== (value.groundedTutorGrant !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["groundedTutorGrant"],
      message: "grant iff grounded_tutor",
    });
  }
  if (value.groundedTutorGrant !== null && value.groundedTutorGrant.pageKind !== value.pageKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["groundedTutorGrant", "pageKind"],
      message: "grounded tutor grant page kind mismatch",
    });
  }
});

export type CompanionPageContextV1 = z.infer<typeof companionPageContextV1Schema>;

// ─── Turn create response（§4.2） ─────────────────────────────────────────

export const createCompanionTurnRequestV1Schema = z.object({
  version: z.literal(1),
  clientMessageId: z.string().uuid(),
  inputKind: z.enum(["text", "voice_transcript"]),
  blocks: z.array(companionContentBlockV1Schema).length(1),
  voiceArtifactId: z.string().uuid().optional(),
  sourceSurface: z.enum(["pet", "main"]),
  supersedesGeneration: z.number().int().positive().optional(),
  context: companionPageContextV1Schema.optional(),
  // 划选/拖拽投喂（2026-09-18）：用户在页面上选中的原文，随 turn 上抛。
  // 持久化进 page_context，worker 以 <selection_data> 边界注入 prompt。
  selection: z.strictObject({
    text: z.string().min(1).max(2_000),
    sharing: z.literal("user_selected"),
  }).optional(),
}).strict().superRefine((value, ctx) => {
  const textOnly = value.blocks[0]?.type === "text";
  if (!textOnly) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blocks"], message: "v1 turn input must be one text block" });
  }
  if ((value.inputKind === "voice_transcript") !== (value.voiceArtifactId !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["voiceArtifactId"], message: "required iff voice_transcript" });
  }
});

export type CreateCompanionTurnRequestV1 = z.infer<
  typeof createCompanionTurnRequestV1Schema
>;

export const createCompanionTurnResponseV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  clientMessageId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  // 幂等重放已终态 run 时返回真实状态（§6.3），客户端据此决定挂 SSE 还是恢复快照。
  status: z.enum(["accepted", "running", "succeeded", "cancelled", "failed", "superseded"]),
  eventCursor: z.number().int().nonnegative(),
}).strict();

export type CreateCompanionTurnResponseV1 = z.infer<
  typeof createCompanionTurnResponseV1Schema
>;

/** 服务端持久化的 page context（§4.1）：去掉 grant signature/raw，只存 bounded refs。 */
export const companionPersistedPageContextV1Schema = z.object({
  version: z.literal(1),
  context: z.discriminatedUnion("pageKind", [
    z.object({
      pageKind: z.literal("today"),
      sharing: z.literal("page_registered"),
      contextRevision: companionHashV1Schema,
    }).strict(),
    z.object({
      pageKind: z.literal("review"),
      sharing: z.enum(["page_registered", "user_selected"]),
      cardId: z.string().uuid().optional(),
      keyPointId: z.string().uuid().optional(),
      contextRevision: companionHashV1Schema,
    }).strict(),
    z.object({
      pageKind: z.literal("card"),
      sharing: z.enum(["page_registered", "user_selected"]),
      cardId: z.string().uuid(),
      keyPointId: z.string().uuid().optional(),
      contextRevision: companionHashV1Schema,
    }).strict(),
    z.object({
      pageKind: z.literal("star_map"),
      sharing: z.enum(["page_registered", "user_selected"]),
      keyPointId: z.string().uuid().optional(),
      contextRevision: companionHashV1Schema,
    }).strict(),
    z.object({
      pageKind: z.literal("learning_run"),
      sharing: z.enum(["page_registered", "user_selected"]),
      runId: z.string().uuid(),
      snapshotId: z.string().uuid(),
      taskId: z.string().uuid(),
      requestedCapability: z.enum(["none", "grounded_tutor"]),
      contextRevision: companionHashV1Schema,
      groundedTutorGrant: z.object({
        grantId: z.string().uuid(),
        permissionSnapshotHash: companionHashV1Schema,
        expiresAt: z.string().datetime(),
      }).strict().nullable(),
    }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  if (value.context.pageKind !== "learning_run") return;
  if ((value.context.requestedCapability === "grounded_tutor") !== (value.context.groundedTutorGrant !== null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["context", "groundedTutorGrant"],
      message: "persisted grant iff grounded_tutor",
    });
  }
});

export type CompanionPersistedPageContextV1 = z.infer<
  typeof companionPersistedPageContextV1Schema
>;

/** 恢复快照（§6.4）：P2–P4 两个学习动作字段为 null；P5 可恢复 durable proposal/run。 */
export const companionConversationSnapshotV1Schema = z.object({
  version: z.literal(1),
  conversation: companionConversationV1Schema,
  activeRun: companionTurnRunV1Schema.nullable(),
  latestEventSeq: z.number().int().nonnegative(),
  // These P5 schemas are declared below; lazy references avoid a module-load
  // temporal-dead-zone while keeping the exported snapshot contract unified.
  pendingProposal: z.lazy(() => pendingLearningActionProposalV1Schema).nullable(),
}).strict();

export type CompanionConversationSnapshotV1 = z.infer<
  typeof companionConversationSnapshotV1Schema
>;

// ─── Character cue（§4.4，wire 版；区别于 P1 表现层 characterCueV1Schema） ──

export const companionCharacterCueV1Schema = z.object({
  version: z.literal(1),
  intent: z.enum([
    "acknowledge",
    "listen",
    "think",
    "explain",
    "encourage",
    "celebrate",
    "uncertain",
    "warn",
    "sleep",
  ]),
  emotion: z.enum(["neutral", "happy", "curious", "concerned", "surprised"]),
  intensity: z.number().min(0).max(1),
  durationMs: z.number().int().min(100).max(10_000).optional(),
}).strict();

export type CompanionCharacterCueV1 = z.infer<typeof companionCharacterCueV1Schema>;

// ─── P5 §4.5 Learning action proposal（第一批冻结） ─────────────────────

/**
 * 方案 16 §18 plan_understanding_route 工具的请求合同（与
 * POST /understanding/routes/plan 的 routePlanBodySchema 同构；共享侧为
 * canonical，projection-routes 从此导入，禁止再本地复制一份）。
 */
export const understandingRoutePlanRequestV1Schema = z.object({
  version: z.literal(1),
  intent: z.enum(["repair_gap", "prepare_review", "explore_neighbors"]),
  targetKeyPointId: z.string().uuid().optional(),
  maxSteps: z.number().int().min(1).max(5),
  lens: z.enum(["current_target", "evidence", "provenance", "issues"]),
  filter: z.object({
    showArchived: z.boolean(),
    sourceId: z.string().uuid().optional(),
    cardId: z.string().uuid().optional(),
    relationKinds: z.array(z.string()).optional(),
  }).passthrough(),
  expectedCheckpointToken: z.string().min(1),
  idempotencyKey: z.string().min(1).max(200),
});
export type UnderstandingRoutePlanRequestV1 = z.infer<typeof understandingRoutePlanRequestV1Schema>;

/** §18.1 AssistantMemoryItemV1 kind（与 memory-service 一致；22 方案新增 episodic）。 */
export const assistantMemoryKindV1Schema = z.enum([
  "preference",
  "goal",
  "learning_context",
  "interaction_note",
  "episodic",
]);

/** §18.1 defer_review 展示层 reason code（不修改 official dueAt）。 */
export const deferReviewReasonCodeV1Schema = z.enum([
  "user_requested",
  "temporary_unavailable",
]);

export const proposedLearningActionPayloadV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open_review") }).strict(),
  z.object({ kind: z.literal("open_card"), cardId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("open_star_map"), keyPointId: z.string().uuid().optional() }).strict(),
  // 已删除两个无法实现的 kind（2026-09-16）：
  // - ask_grounded_tutor：无 producer、无 decision 分支，确认必落 409；当前 target
  //   Tutor 由 companion-context-grants + grounded evidence 流程交付。
  // - propose_memory_candidate：契约要求 payload 携带 sourceMessageId，而该 id 由
  //   服务端在 proposal 创建事务内生成（菜单路径 userMessageId、agent 路径
  //   event.read.userMessageId），调用方无从提供 ⇒ 该 kind 不可满足。已落地的候选
  //   记忆路径是 worker memory-extractor + delivery 气泡 + confirm_or_reject_memory。
  // 方案 16 §18：统一 LearningRun 工具（menu 候选直连 LearningRun API；
  // 同步执行，confirm 后 proposal 直接 succeeded + resultRef=runId）。
  z.object({
    kind: z.literal("resume_learning_run"),
    runId: z.string().uuid(),
  }).strict(),
  // Plan 23 CS-06：V2 学习运行（originV2 → createRunV2；pet 不自建 origin/参数）。
  z.object({
    kind: z.literal("start_learning_run_v2"),
    request: createLearningRunV2RequestSchema,
  }).strict(),
  // ── 方案 16 §18.1 工具网关（第二批：Orchestrator 动作工具全集） ──
  // 全部为"用户确认后才执行"的业务动作；导航类同步 succeeded，业务类
  // 事务内确定性执行（执行函数见 learning-action-bridge.ts）。
  z.object({
    kind: z.literal("pause_learning_run"),
    runId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("switch_task_variant"),
    runId: z.string().uuid(),
    taskId: z.string().uuid(),
    alternativeId: z.string().min(1).max(200),
  }).strict(),
  z.object({
    kind: z.literal("request_hint_level"),
    runId: z.string().uuid(),
    taskId: z.string().uuid(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }).strict(),
  z.object({
    kind: z.literal("defer_review"),
    scheduleId: z.string().uuid(),
    // 乐观并发：schedule.generation 不匹配 → 409 ACTION_STALE。
    scheduleGeneration: z.number().int().nonnegative(),
    deferredUntil: z.string().datetime(),
    reasonCode: deferReviewReasonCodeV1Schema,
  }).strict(),
  z.object({
    kind: z.literal("plan_understanding_route"),
    request: understandingRoutePlanRequestV1Schema,
  }).strict(),
  z.object({
    kind: z.literal("focus_graph_node"),
    keyPointId: z.string().uuid(),
    lens: z.enum(["current_target", "evidence", "provenance", "issues"]),
  }).strict(),
  z.object({
    kind: z.literal("restore_graph_viewport"),
    runId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("open_conversation_history"),
  }).strict(),
  z.object({
    // revision = 目标记忆 updatedAt 的 epoch millis（单调 CAS 令牌；
    // 记忆无独立 revision 列，见 assistant-memory 表）。
    kind: z.literal("confirm_or_reject_memory"),
    memoryId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    decision: z.enum(["confirm", "reject"]),
  }).strict(),
  z.object({
    kind: z.literal("delete_assistant_memory"),
    memoryId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
  }).strict(),
  // ── 2026-09-19：auto-set / auto-fill 工具（guided 档提案确认后的执行分支）──
  // full 档不创建提案，由 worker executeDirectTool 直执行；这里的 payload 形状
  // 与 worker 侧 buildActionPayload 映射同源。
  z.object({
    kind: z.literal("save_memory"),
    // 枚举与 assistant_memory_items.kind 的 DB CHECK 约束同源。
    memoryKind: z.enum(["preference", "goal", "learning_context", "interaction_note", "episodic"]),
    content: z.string().min(1).max(200),
  }).strict(),
  z.object({
    kind: z.literal("set_pet_activeness"),
    activeness: z.enum(["quiet", "moderate", "active"]),
  }).strict(),
]);

export const companionActionProposalV1Schema = z.object({
  version: z.literal(1),
  proposalId: z.string().uuid(),
  conversationId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  sourceGeneration: z.number().int().nonnegative(),
  contextGrantId: z.string().uuid().nullable(),
  payload: proposedLearningActionPayloadV1Schema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1).max(80),
  targetSummary: z.string().min(1).max(160),
  impactSummary: z.string().min(1).max(240),
  requiresConfirmation: z.literal(true),
  status: z.enum(["pending", "rejected", "accepted", "executing", "succeeded", "failed", "expired"]),
  decision: z.enum(["confirm", "reject"]).nullable(),
  expiresAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const pendingLearningActionProposalV1Schema = companionActionProposalV1Schema.extend({
  status: z.literal("pending"),
  decision: z.null(),
  decidedAt: z.null(),
}).strict();

export const companionProposalSnapshotV1Schema = z.object({
  version: z.literal(1),
  proposal: companionActionProposalV1Schema,
}).strict();

export type CompanionProposalSnapshotV1 = z.infer<typeof companionProposalSnapshotV1Schema>;

export const companionMenuCandidateIdV1Schema = z.enum([
  "learning_run_resume",
  "learning_run_start",
]);

// ─── P5 §6.7 Menu proposal create（只接受 resume/start 两类） ──────────

export const createMenuProposalRequestV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid().optional(),
  clientMessageId: z.string().uuid(),
  candidateId: companionMenuCandidateIdV1Schema,
  expectedContextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSurface: z.enum(["pet", "main"]),
}).strict();

// ── 方案 16 §18.1：通用工具 proposal 请求（Orchestrator 网关入口） ──
export const createToolProposalRequestV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid().optional(),
  clientMessageId: z.string().uuid(),
  payload: proposedLearningActionPayloadV1Schema,
  title: z.string().min(1).max(80),
  targetSummary: z.string().min(1).max(160),
  impactSummary: z.string().min(1).max(240),
  sourceSurface: z.enum(["pet", "main"]),
}).strict();
export type CreateToolProposalRequestV1 = z.infer<typeof createToolProposalRequestV1Schema>;

export const createMenuProposalResponseV1Schema = z.object({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  proposal: pendingLearningActionProposalV1Schema,
  eventCursor: z.number().int().positive(),
}).strict();
export type CreateMenuProposalResponseV1 = z.infer<typeof createMenuProposalResponseV1Schema>;

// ─── P5 §6.6 Proposal decision（confirm/reject） ────────────────────────

export const proposalDecisionRequestV1Schema = z.object({
  version: z.literal(1),
  proposalId: z.string().uuid(),
  decision: z.enum(["confirm", "reject"]),
  idempotencyKey: z.string().uuid(),
  // §6.6：confirm 必须匹配服务端冻结的 payload hash。
  expectedPayloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const proposalDecisionResponseV1Schema = z.object({
  version: z.literal(1),
  proposalId: z.string().uuid(),
  status: z.enum(["rejected", "accepted", "executing", "succeeded", "failed"]),
  resultRef: z.string().min(1).max(240).nullable(),
  // 2026-08-15：服务端 navigationRouteFor 返回 V2 合同（§18 新导航 kind 的
  // lens/restoreRun/assistantSessionId 是 V1 strict 之外的新键）——decision
  // 响应必须用 V2 route schema，否则 focus_graph_node 等确认后客户端
  // parse 502 INVALID_DECISION_RESPONSE。
  route: allowedMainRouteV2Schema.nullable(),
  safeSummary: z.string().min(1).max(240).nullable(),
}).strict();
export type ProposalDecisionResponseV1 = z.infer<typeof proposalDecisionResponseV1Schema>;

// ─── P5 §6.7 Learning menu context（只读） ──────────────────────────────

export const companionLearningContextV1Schema = z.object({
  version: z.literal(1),
  contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
  learningRunResumeCandidate: z.object({
    candidateId: z.literal("learning_run_resume"),
    runId: z.string().uuid(),
    title: z.string().min(1).max(80),
    targetSummary: z.string().min(1).max(160),
    impactSummary: z.string().min(1).max(240),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).nullable(),
  learningRunStartCandidate: z.object({
    candidateId: z.literal("learning_run_start"),
    title: z.string().min(1).max(80),
    targetSummary: z.string().min(1).max(160),
    impactSummary: z.string().min(1).max(240),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    objectiveId: z.string().uuid(),
    originV2: createLearningRunV2RequestSchema.shape.originV2,
    /** 服务端冻结的真实创建参数；确认时必须逐字段复用，不能在第二次读取时补造。 */
    request: createLearningRunV2RequestSchema,
  }).nullable(),
}).strict();

export type CompanionLearningContextV1 = z.infer<typeof companionLearningContextV1Schema>;

// ─── P5 §6.7 Grounded tutor grant（HMAC 5min TTL） ──────────────────────

/** LearningRun Tutor grant 的一次性签发请求。 */
export const createCompanionLearningRunContextGrantRequestV1Schema = z.object({
  version: z.literal(1),
  pageInstanceId: z.string().uuid(),
  taskId: z.string().uuid(),
  contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type CreateCompanionLearningRunContextGrantRequestV1 = z.infer<
  typeof createCompanionLearningRunContextGrantRequestV1Schema
>;

/** 当前 LearningRun 的只读 Tutor 页面适配器快照。 */
export const companionLearningRunContextV1Schema = z.object({
  version: z.literal(1),
  pageKind: z.literal("learning_run"),
  sharing: z.literal("page_registered"),
  runId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  taskId: z.string().uuid(),
  requestedCapability: z.literal("none"),
  contextRevision: companionHashV1Schema,
  groundedTutorGrant: z.null(),
}).strict();

export type CompanionLearningRunContextV1 = z.infer<
  typeof companionLearningRunContextV1Schema
>;



// ─── P2 §5.2/§6.9 恢复块：错误码 + 16 事件 discriminated union + limits ──

export const companionPublicErrorCodeV1Schema = z.enum([
  "INVALID_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONVERSATION_LIMIT_REACHED",
  "IDEMPOTENCY_CONFLICT",
  "RUN_ALREADY_ACTIVE",
  "STALE_GENERATION",
  "CURSOR_EXPIRED",
  "INVALID_CURSOR",
  "RATE_LIMITED",
  // 2026-08-11：SSE 连接数上限（companion-events.ts / account-events.ts 429）
  "TOO_MANY_CONNECTIONS",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "TURN_CANCELLED",
  "VOICE_PERMISSION_DENIED",
  "VOICE_AUDIO_TOO_LARGE",
  "VOICE_UNSUPPORTED_FORMAT",
  "ASR_FAILED",
  "TTS_FAILED",
  "ACTION_CONFIRMATION_REQUIRED",
  "ACTION_EXPIRED",
  "ACTION_STALE",
  // 2026-08-12+（15a-E）：学习快捷方式错误码细分——context 变化/无进行中会话/无候选
  "CONTEXT_STALE",
  "NO_ACTIVE_RUN",
  "NO_CANDIDATE",
  "PAYLOAD_HASH_MISMATCH",
  "INTERNAL_ERROR",
]);

export const companionErrorV1Schema = z.object({
  version: z.literal(1),
  error: companionPublicErrorCodeV1Schema,
  message: z.string().min(1).max(240),
  recoverable: z.boolean(),
  requestId: z.string().min(1).max(120),
}).strict();

export const COMPANION_P2_LIMITS = Object.freeze({
  composerMaxChars: 4_000,
  serverHardMaxChars: 20_000,
  deltaMaxChars: 2_000,
  blocksPerMessage: 32,
});



// envelope 的 strict：base 字段展开进每个 union 分支，分支整体 .strict()，
// 未知顶层字段被分支拒绝（§5.1 唯一 wire truth）。不能用 z.intersection +
// base.strict()：intersection 的两个 schema 都作用于含 type/payload 的完整对象。
const companionStreamEventBaseShapeV1 = {
  version: z.literal(1),
  eventId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  generation: z.number().int().nonnegative(),
  accountEpoch: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
} as const;

// SSE 的 character.cue 必须与方案 13 §9.6 / 03 §4.4 的高层语义 cue 合同一致
// （intent/emotion 为固定 enum，含 durationMs），不复用 presentation 名。
export const characterCuePayloadV1Schema = z.object({
  version: z.literal(1),
  intent: characterCueIntentV1Schema,
  emotion: characterCueEmotionV1Schema,
  intensity: z.number().min(0).max(1),
  durationMs: z.number().int().positive().optional(),
}).strict();
export type CharacterCuePayloadV1 = z.infer<typeof characterCuePayloadV1Schema>;

/**
 * 伴星回复的服务端语音片段合同。
 *
 * `display*` 永远对应已经提交给用户的干净正文；`synthesisText` 只供服务端按
 * 严格引用重新读取并合成，可包含受控语气标签。桌面主进程会在跨 IPC 前删除
 * `synthesisText`，渲染层只看到引用、正文区间、摘要和语义 cue。
 */
export const companionVoiceSegmentReadyPayloadV2Schema = z.strictObject({
  version: z.literal(2),
  segmentId: z.string().regex(/^[a-f0-9]{64}$/),
  ordinal: z.number().int().min(1).max(200),
  displayText: z.string().min(1).max(160),
  displayStart: z.number().int().nonnegative(),
  displayEnd: z.number().int().positive(),
  synthesisText: z.string().min(1).max(200),
  synthesisTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cue: characterCuePayloadV1Schema,
}).superRefine((value, context) => {
  if (value.displayEnd <= value.displayStart) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["displayEnd"], message: "displayEnd must be greater than displayStart" });
  }
  if (value.displayEnd - value.displayStart !== value.displayText.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["displayText"], message: "display range must match displayText length" });
  }
});
export type CompanionVoiceSegmentReadyPayloadV2 = z.infer<typeof companionVoiceSegmentReadyPayloadV2Schema>;

const actionProposedProposalV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  sourceGeneration: z.number().int().nonnegative(),
  kind: proposedLearningActionPayloadV1Schema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1).max(80),
  targetSummary: z.string().min(1).max(160),
  impactSummary: z.string().min(1).max(240),
  status: z.enum(["pending", "rejected", "accepted", "executing", "succeeded", "failed", "expired"]),
  origin: z.enum(["menu", "agent_tool"]).optional(),
  agentToolCallId: z.string().max(200).optional(),
}).strict();

export const companionStreamEventV1Schema = z.discriminatedUnion("type", [
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("turn.accepted"), payload: z.object({
    clientMessageId: z.string().uuid(), userMessageId: z.string().uuid(), status: z.literal("accepted"),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("assistant.status"), payload: z.object({
    status: z.enum(["thinking", "acting"]), safeLabel: z.string().min(1).max(240),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("agent.tool"), payload: z.object({
    tool: companionAgentToolEventV1Schema,
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("assistant.delta"), payload: z.object({
    appendFrom: z.number().int().nonnegative(), textDelta: z.string().min(1).max(2_000),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("assistant.final"), payload: z.object({
    messageId: z.string().uuid(), textLength: z.number().int().nonnegative(),
    textSha256: z.string().regex(/^[a-f0-9]{64}$/),
    messageContentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    // 22 方案 §12.3/§14.5/§16.3：本轮真正使用的记忆引用，仅 UI 展示。
    memoryRefs: z.array(z.object({
      memoryId: z.string().uuid(),
      kind: z.string().min(1).max(64),
      content: z.string().min(1).max(80),
    }).strict()).max(3).optional(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("character.cue"), payload: z.object({
    cue: characterCuePayloadV1Schema,
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("action.proposed"), payload: z.object({
    proposal: actionProposedProposalV1Schema,
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("action.decision"), payload: z.object({
    proposalId: z.string().uuid(), decision: z.enum(["confirm", "reject"]),
    status: z.enum(["accepted", "rejected"]),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("action.expired"), payload: z.object({
    proposalId: z.string().uuid(),
  }).strict() }).strict(),
  z.object({
    ...companionStreamEventBaseShapeV1,
    type: z.literal("voice.segment.ready"),
    payload: companionVoiceSegmentReadyPayloadV2Schema,
  }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("proactive.delivery"), payload: z.object({
    deliveryId: z.string().uuid(), messageId: z.string().uuid(), expiresAt: z.string().datetime(),
    contentPolicy: z.enum(["content", "content_hidden"]),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("proactive.delivery.updated"), payload: z.object({
    deliveryId: z.string().uuid(), status: z.enum(["shown", "suppressed", "dismissed", "expired"]),
    contentClaimed: z.boolean(),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("turn.cancelled"), payload: z.object({
    reason: z.enum(["user", "superseded", "shutdown", "timeout"]),
  }).strict() }).strict(),
  z.object({ ...companionStreamEventBaseShapeV1, type: z.literal("error"), payload: z.object({
    code: companionPublicErrorCodeV1Schema, recoverable: z.boolean(), requestId: z.string().min(1).max(120).optional(),
  }).strict() }).strict(),
  ]);

export type CompanionStreamEventV1 = z.infer<typeof companionStreamEventV1Schema>;

// ─── P2/P3：TTS request + 错误码 type ────────────────────────────────────

export type CompanionPublicErrorCodeV1 = z.infer<typeof companionPublicErrorCodeV1Schema>;

// ─── P6 §13 流式 TTS 请求（句子级，每稳定句一条流） ─────────────────────

export const companionTtsStreamRequestV1Schema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  ordinal: z.number().int().min(1).max(200),
  segmentId: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().min(1).max(160),
  voice: z.string().min(1).max(120).optional(),
  // 2026-08-12（伴星语音设置）：语速（"-30%" | "+0%" | "+30%"）。
  rate: z.string().min(1).max(16).optional(),
  // 15b：TTS 引擎选择（缺省 = config tts.engine；前端通常不传，由服务端决定）。
  engine: z.enum(["qwen", "edge"]).optional(),
}).strict();
