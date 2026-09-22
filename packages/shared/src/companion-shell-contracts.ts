/**
 * 阶段 02（W1）任务 02-3：Companion onboarding 状态机与跨设备同步契约（§5.4.3 + §12.5）。
 *
 * 对应冻结记录 CompanionOnboardingStateV1 语义：
 * - offerStatus 单调前进：not_offered → offered → consumed；consumed 是该版本终态。
 * - 一次性 display permit：渲染前必须先 CAS `not_offered → offered`，只有获胜设备/标签页可展示。
 * - manual replay 只创建独立 run，绝不改变 consumed。
 * - resumeTokenRef 绑定 user / onboardingVersion / runId / base revision / expiry；
 *   跨 workspace 只同步账号级 offer 终态，不复用上一 workspace 的 resume token。
 * - account 级状态（globalEnabled/presence/suggestionPause/suppression/动画/语音/通知边界）
 *   跨设备同步，带 revision/epoch CAS。
 *
 * zod schema 风格与 packages/shared/src/schemas.ts 保持一致（z.object + .strict + z.infer）。
 */

import { z } from "zod";
import { isTtsVoiceAllowed, ttsEngineV1Schema } from "./tts-voice-catalog.ts";
import {
  companionAgentPermissionLevelSchema,
  companionAgentSettingsV1Schema,
} from "./companion-agent-contracts.ts";

// ─── Onboarding 状态机基础枚举 ─────────────────────────────────────────────

export const CompanionOnboardingOfferStatusSchema = z.enum([
  "not_offered",
  "offered",
  "consumed",
]);
export type CompanionOnboardingOfferStatus = z.infer<
  typeof CompanionOnboardingOfferStatusSchema
>;

export const CompanionOnboardingDispositionSchema = z.enum([
  "completed",
  "skipped",
]);
export type CompanionOnboardingDisposition = z.infer<
  typeof CompanionOnboardingDispositionSchema
>;

export const CompanionOnboardingEntryModeSchema = z.enum([
  "first_run",
  "manual_replay",
  "migration_intro",
]);
export type CompanionOnboardingEntryMode = z.infer<
  typeof CompanionOnboardingEntryModeSchema
>;

export const CompanionOnboardingRunStatusSchema = z.enum([
  "in_progress",
  "paused",
]);
export type CompanionOnboardingRunStatus = z.infer<
  typeof CompanionOnboardingRunStatusSchema
>;

// ─── Onboarding 状态（V1，冻结）───────────────────────────────────────────

export const companionOnboardingActiveRunSchema = z.object({
  runId: z.string().min(1).max(100),
  entryMode: CompanionOnboardingEntryModeSchema,
  runStatus: CompanionOnboardingRunStatusSchema,
  stepId: z.string().min(1).max(100),
  /** 服务端签发的不透明恢复令牌引用；resume 时必须与行内值一致才放行。 */
  resumeTokenRef: z.string().min(1).max(200),
  /** 签发 run 时的 workspace；resume 必须同 workspace，跨 workspace 不复用。 */
  resumeWorkspaceRef: z.string().uuid().optional(),
  /** resume token 过期时间（ISO-8601）；过期后只能被动恢复入口/重播，不能自动续接。 */
  expiresAt: z.string().datetime(),
}).strict();
export type CompanionOnboardingActiveRun = z.infer<
  typeof companionOnboardingActiveRunSchema
>;

export const companionOnboardingLastRunSchema = z.object({
  entryMode: CompanionOnboardingEntryModeSchema,
  disposition: z.enum(["completed", "skipped", "abandoned"]),
  at: z.string().datetime(),
}).strict();
export type CompanionOnboardingLastRun = z.infer<
  typeof companionOnboardingLastRunSchema
>;

export const companionOnboardingStateV1Schema = z.object({
  onboardingVersion: z.string().min(1).max(100),
  /** 乐观并发版本：每次写入 +1；客户端提交 base revision 做 CAS。 */
  revision: z.number().int().min(0),
  offerStatus: CompanionOnboardingOfferStatusSchema,
  /** 仅 offerStatus=consumed 时有值；completed | skipped 是该版本终态。 */
  offerDisposition: CompanionOnboardingDispositionSchema.optional(),
  activeRun: companionOnboardingActiveRunSchema.optional(),
  lastRun: companionOnboardingLastRunSchema.optional(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((state, ctx) => {
  if (state.offerStatus === "consumed" && !state.offerDisposition) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "consumed onboarding must carry a disposition",
      path: ["offerDisposition"],
    });
  }
  if (state.offerStatus !== "consumed" && state.offerDisposition) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "disposition is only valid once offerStatus is consumed",
      path: ["offerDisposition"],
    });
  }
});
export type CompanionOnboardingStateV1 = z.infer<
  typeof companionOnboardingStateV1Schema
>;

// ─── Transition action 与请求/响应 ─────────────────────────────────────────

export const TransitionActionSchema = z.enum([
  "start",
  "skip",
  "pause",
  "resume",
  "replay",
  "complete",
  "abandon",
]);
export type TransitionAction = z.infer<typeof TransitionActionSchema>;

export const onboardingTransitionRequestSchema = z.object({
  action: TransitionActionSchema,
  /** 客户端持有的 base revision（CAS 乐观锁）；不传则按服务端当前状态执行。 */
  revision: z.number().int().min(0).optional(),
  /** pause/resume/abandon 必须带当前 runId；start/replay 不带时由服务端签发。 */
  runId: z.string().min(1).max(100).optional(),
  /** start/replay 时可选指定起始 stepId（缺省为服务端初始 step）。 */
  stepId: z.string().min(1).max(100).optional(),
  /** resume 时必须提交与 activeRun.resumeTokenRef 一致的令牌。 */
  resumeTokenRef: z.string().min(1).max(200).optional(),
}).strict();
export type OnboardingTransitionRequest = z.infer<
  typeof onboardingTransitionRequestSchema
>;

export const onboardingTransitionResponseSchema = z.object({
  /** start 时标识是否赢得一次性 display permit（false = 其他设备/标签页已 offer）。 */
  won: z.boolean().optional(),
  state: companionOnboardingStateV1Schema,
}).strict();
export type OnboardingTransitionResponse = z.infer<
  typeof onboardingTransitionResponseSchema
>;

// ─── Onboarding CAS 错误码（客户端可按码幂等处理）────────────────────────

export const CompanionOnboardingErrorCode = {
  /** offerStatus 已是 consumed 且 disposition 不同：终态不可回退。 */
  ONBOARDING_ALREADY_CONSUMED: "ONBOARDING_ALREADY_CONSUMED",
  /** revision CAS 失败：另一设备/标签页已写入，需刷新后重试。 */
  STALE_REVISION: "STALE_REVISION",
  /** resume token 过期或与 activeRun 不匹配。 */
  PERMIT_EXPIRED: "PERMIT_EXPIRED",
  /** start 时另一设备/标签页已赢得一次性 display permit。 */
  OFFER_NOT_WINNER: "OFFER_NOT_WINNER",
  /** 当前状态不允许该 transition（如 not_offered 时 replay、无 run 时 pause）。 */
  INVALID_TRANSITION: "INVALID_TRANSITION",
  /** 目标 run 不存在或 runId 不匹配。 */
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  /** resume 跨越 workspace：跨 workspace 不复用 resume token。 */
  CROSS_WORKSPACE_RESUME_DENIED: "CROSS_WORKSPACE_RESUME_DENIED",
} as const;
export type CompanionOnboardingErrorCode =
  (typeof CompanionOnboardingErrorCode)[keyof typeof CompanionOnboardingErrorCode];

export const companionOnboardingErrorCodeSchema = z.nativeEnum(
  CompanionOnboardingErrorCode,
);

// ─── Account 级状态（跨设备同步，§5.4.3 / §12.5）────────────────────────

export const companionPresenceStateSchema = z.object({
  presence: z.enum(["online", "dnd", "offline"]),
  updatedAt: z.string().datetime().optional(),
}).strict();
export type CompanionPresenceState = z.infer<typeof companionPresenceStateSchema>;

export const companionSuggestionPauseSchema = z.object({
  paused: z.boolean(),
  until: z.string().datetime().optional(),
  reasonCodes: z.array(z.string().min(1).max(100)).max(50).optional(),
}).strict();
export type CompanionSuggestionPause = z.infer<typeof companionSuggestionPauseSchema>;

export const companionSuppressionSchema = z.object({
  // suppressedSuggestionClassIds 可长期保存但不携带 target（02-4）。
  suppressedSuggestionClassIds: z.array(z.string().min(1).max(200)).max(200).optional(),
  paused: z.boolean().optional(),
  until: z.string().datetime().optional(),
}).strict();
export type CompanionSuppression = z.infer<typeof companionSuppressionSchema>;

export const companionNotificationBoundarySchema = z.object({
  notificationsEnabled: z.boolean(),
  quietHours: z.object({
    from: z.string().min(1).max(10),
    to: z.string().min(1).max(10),
  }).strict().optional(),
}).strict();
export type CompanionNotificationBoundary = z.infer<
  typeof companionNotificationBoundarySchema
>;

/** db 层把 animationOff/voiceOff 存为单一 animation_voice_off JSONB；API 契约按语义拆开。 */
export const companionAccountStateV1Schema = z.object({
  /** account revision：每次写入 +1，客户端 PATCH 必须提交 base revision。 */
  revision: z.number().int().min(0),
  /** account epoch：global off 等撤销事件时单调递增，供 SSE/WebSocket epoch 撤销使用。 */
  epoch: z.number().int().min(0),
  /** true=开启 Companion；false=global off（广播 fence 到全部 active device session）。 */
  globalEnabled: z.boolean(),
  presence: companionPresenceStateSchema.optional(),
  suggestionPause: companionSuggestionPauseSchema.optional(),
  suppression: companionSuppressionSchema.optional(),
  animationOff: z.boolean().optional(),
  voiceOff: z.boolean().optional(),
  notificationBoundary: companionNotificationBoundarySchema.optional(),
  // 方案 16 §10.3：主动介入强度与静默时段（账号级；0140 迁移）。
  interventionLevel: z.enum(["quiet", "moderate", "active"]).optional(),
  quietHours: z
    .object({
      startLocal: z.string().min(1).max(10),
      endLocal: z.string().min(1).max(10),
      timezone: z.string().min(1).max(64),
    })
    .nullable()
    .optional(),
  agentSettings: companionAgentSettingsV1Schema.optional(),
}).strict();
export type CompanionAccountStateV1 = z.infer<typeof companionAccountStateV1Schema>;

/** Account-wide revocation event delivered on the companion account SSE. */
export const companionAccountGlobalOffEventV1Schema = z.object({
  version: z.literal(1),
  type: z.literal("account.global_off"),
  userId: z.string().uuid(),
  epoch: z.number().int().min(0),
}).strict();
export type CompanionAccountGlobalOffEventV1 = z.infer<
  typeof companionAccountGlobalOffEventV1Schema
>;

export const companionAccountPatchSchema = z.object({
  /** 客户端持有的 base revision（CAS 乐观锁），必填。 */
  revision: z.number().int().min(0),
  globalEnabled: z.boolean().optional(),
  presence: companionPresenceStateSchema.optional(),
  suggestionPause: companionSuggestionPauseSchema.optional(),
  suppression: companionSuppressionSchema.optional(),
  animationOff: z.boolean().optional(),
  voiceOff: z.boolean().optional(),
  notificationBoundary: companionNotificationBoundarySchema.optional(),
  // 方案 16 §10.3：主动介入强度与静默时段。
  interventionLevel: z.enum(["quiet", "moderate", "active"]).optional(),
  quietHours: z
    .object({
      startLocal: z.string().min(1).max(10),
      endLocal: z.string().min(1).max(10),
      timezone: z.string().min(1).max(64),
    })
    .nullable()
    .optional(),
  agentPermissionLevel: companionAgentPermissionLevelSchema.optional(),
}).strict().superRefine((patch, ctx) => {
  const hasChange =
    patch.globalEnabled !== undefined ||
    patch.presence !== undefined ||
    patch.suggestionPause !== undefined ||
    patch.suppression !== undefined ||
    patch.animationOff !== undefined ||
    patch.voiceOff !== undefined ||
    patch.notificationBoundary !== undefined ||
    patch.interventionLevel !== undefined ||
    patch.quietHours !== undefined ||
    patch.agentPermissionLevel !== undefined;
  if (!hasChange) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "at least one account state field must be provided",
    });
  }
});
export type CompanionAccountPatch = z.infer<typeof companionAccountPatchSchema>;

// ─── Runtime fence（device session，短 TTL server-side fence）─────────────

export const runtimeFenceRequestSchema = z.object({
  /** 设备本地会话 ID（不作为账号偏好；服务端仅短 TTL 保存）。 */
  deviceSessionId: z.string().min(1).max(200),
  /** 发起时客户端看到的 account surface epoch；服务端 fence 校验用。 */
  surfaceEpoch: z.number().int().min(0),
  /** fence 存活秒数（上限 300s）。 */
  ttlSeconds: z.number().int().min(1).max(300),
}).strict();
export type RuntimeFenceRequest = z.infer<typeof runtimeFenceRequestSchema>;

export const runtimeFenceResponseSchema = z.object({
  deviceSessionId: z.string().min(1).max(200),
  surfaceEpoch: z.number().int().min(0),
  ttlSeconds: z.number().int().min(1).max(300),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();
export type RuntimeFenceResponse = z.infer<typeof runtimeFenceResponseSchema>;

// ─── GET /me/companion 聚合视图 ──────────────────────────────────────────

export const companionOverviewSchema = z.object({
  account: companionAccountStateV1Schema,
  /** 当前账号全部 onboarding 版本状态（每版本一条，服务端保证 consumed 不回退）。 */
  onboardingStates: z.array(companionOnboardingStateV1Schema).max(100),
}).strict();
export type CompanionOverview = z.infer<typeof companionOverviewSchema>;

// ─── 任务 14：作答模态偏好（设置 → 伴星，跨设备一致；决策 4）──────────────

/** 用户显式设置的作答模态偏好；"any" = 未设置（跟随安排）。 */
export const answerModePreferenceV1Schema = z.enum(["voice", "silent", "text", "any"]).default("any");
export type AnswerModePreferenceV1 = z.infer<typeof answerModePreferenceV1Schema>;

export const companionAnswerModePreferenceV1Schema = z.object({
  version: z.literal(1),
  /** 显式偏好；"any" = 未设置（Supervisor 默认编排）。 */
  preference: answerModePreferenceV1Schema,
  updatedAt: z.string().datetime().nullable(),
}).strict();
export type CompanionAnswerModePreferenceV1 = z.infer<typeof companionAnswerModePreferenceV1Schema>;

export const companionAnswerModePreferencePatchV1Schema = z.object({
  version: z.literal(1),
  preference: answerModePreferenceV1Schema,
}).strict();
export type CompanionAnswerModePreferencePatchV1 = z.infer<typeof companionAnswerModePreferencePatchV1Schema>;

// ─── 语音音色偏好（设置 → 语音与伴星，账号级跨设备一致）───────────────────

/**
 * 用户选的合成引擎与音色。
 *
 * 存 account 级（与作答模态偏好同一行、同一套读写），因为它是"她的声音"这件事，
 * 属于人而不属于某个空间。未设置时服务端回落到 config 的 `tts.*`，
 * 所以这里不出现"未设置"这个第三态——GET 永远回一对目录内的合法值。
 */
export const companionVoicePreferenceV1Schema = z.object({
  version: z.literal(1),
  engine: ttsEngineV1Schema,
  /** 一定落在该引擎的音色目录内：目录外的存量值由服务端回落成该引擎默认音色。 */
  voice: z.string().min(1).max(120),
  /** 用户没有显式保存过时为 null（此时 engine/voice 是 config 默认，不是用户的选择）。 */
  explicit: z.boolean(),
  updatedAt: z.string().datetime().nullable(),
}).strict();
export type CompanionVoicePreferenceV1 = z.infer<typeof companionVoicePreferenceV1Schema>;

/**
 * 写入。voice 必须属于所选引擎的目录——这条跨字段校验放在合同层而不是 service 里，
 * 是因为 `voice` 会原样进上游的计费接口：放一个引擎与音色不匹配的组合过去，
 * 上游只回一句 `[cosyvoice:]Engine error [411]`，用户看到的是"点了没反应"。
 */
export const companionVoicePreferencePatchV1Schema = z
  .object({
    version: z.literal(1),
    engine: ttsEngineV1Schema,
    voice: z.string().min(1).max(120),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!isTtsVoiceAllowed(value.engine, value.voice)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["voice"],
        message: `voice ${value.voice} 不在引擎 ${value.engine} 的音色目录内`,
      });
    }
  });
export type CompanionVoicePreferencePatchV1 = z.infer<typeof companionVoicePreferencePatchV1Schema>;
