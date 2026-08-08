/**
 * 任务 04-1 / 04-2：voice / text_or_mixed 模态 payload 与 ASR/TTS Provider
 * 数据治理契约（§6.5 语音一等输入 + §7.2 模态 payload + §13.2 音频与 transcript 治理）。
 *
 * 冻结依据（04-w3 任务 04-1/04-2 + 冻结记录 01-2 §6.1 / 01-4 §13.2）：
 * - `voice` payload：逐字 confirmed transcript、segment timestamps、
 *   ASR provider/model/version/language/confidence、可选短期 audio ref/hash；
 *   只有重录后的确认仍属纯 voice；
 * - `text_or_mixed` payload：原始文本与 hash；手工编辑 ASR transcript 创建此模态
 *   新 Artifact，并经 `supersedesArtifactId` 保留来源，不伪装为纯 voice；
 * - raw audio 只是短期 transient 输入（加密、短 TTL、不进长期备份）；
 *   audio hash 不可被用来恢复声音；
 * - ASR/TTS Provider 绑定 tenant policy、region、retention、training-use 禁令与
 *   consent version；不满足 workspace policy 时语音能力 fail closed。
 *
 * 本文件 = 契约单一来源（zod strict schema + z.infer）。字段改动必须回阶段 01 W0
 * 评审（01-2 冻结记录约束级别）。
 *
 * 注：主代理在 `packages/shared/src/index.ts` 统一收口导出后，apps/api 服务应改为
 * `import type { VoicePayload, TextOrMixedPayload, ... } from "@ailearn/shared"`；
 * 收口前 apps/api 本地模块内声明等价类型（见决策记录 04-1/04-2）。
 */

import { z } from "zod";

// ─── 常量 ────────────────────────────────────────────────────────────────

/** 内容哈希形式：sha256:<64hex>（transcript / 原始文本 / audio 统一前缀） */
export const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** 契约 schema 版本（冻结引用；任何字段/语义改动必须回 W0） */
export const VOICE_ARTIFACT_CONTRACTS_VERSION = "voice-artifact-contracts-v1" as const;

// ─── TranscriptSegmentSchema（逐字 segment + 时间戳 + 置信度）──────────────

export const transcriptSegmentSchema = z
  .object({
    /** segment 起始时间（毫秒，相对音频起点） */
    startMs: z.number().int().nonnegative(),
    /** segment 结束时间（毫秒），必须严格大于 startMs */
    endMs: z.number().int().positive(),
    /** 该 segment 的逐字文本（原样，不润色） */
    text: z.string().min(1),
    /** 该 segment 的 ASR 置信度 [0,1]；低置信关键术语 → not_assessable */
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .refine((s) => s.endMs > s.startMs, {
    message: "endMs 必须严格大于 startMs",
  });

export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

// ─── VoicePayloadSchema（voice 模态 payload，§7.2）─────────────────────────

export const voicePayloadSchema = z
  .object({
    /** 用户确认的逐字 transcript —— voice artifact 的 canonical answer */
    confirmedTranscript: z.string().min(1),
    /** 逐字 segment timestamps（含逐段置信度） */
    segmentTimestamps: z.array(transcriptSegmentSchema).min(1),
    asrProvider: z.string().min(1),
    asrModel: z.string().min(1),
    asrVersion: z.string().min(1),
    /** BCP-47 语言标签，如 en-US / zh-CN */
    language: z.string().regex(/^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,8})*$/, {
      message: "language 必须是 BCP-47 语言标签",
    }),
    /** 保守整体置信度（取逐段最低，[0,1]） */
    confidence: z.number().min(0).max(1),
    /** 短期 raw audio 引用（临时对象存储 ref，短 TTL、加密、不进长期备份） */
    audioRef: z.string().min(1).optional(),
    /** 短期 audio hash（sha256:<64hex>，不可用于恢复声音） */
    audioHash: z.string().regex(SHA256_HASH_PATTERN).optional(),
    /** 用户确认时间（ISO8601；canonical answer 的确认时刻） */
    confirmedAt: z.string().datetime(),
  })
  .strict();

export type VoicePayload = z.infer<typeof voicePayloadSchema>;

// ─── TextOrMixedPayloadSchema（text_or_mixed 模态 payload，§7.2）───────────

export const textOrMixedPayloadSchema = z
  .object({
    /** 用户确认的原始文本（可来自手工编辑 ASR transcript 或纯文字输入） */
    text: z.string().min(1),
    /** 原始文本的确定性 hash（sha256:<64hex>） */
    contentHash: z.string().regex(SHA256_HASH_PATTERN),
    /** 被本 artifact 取代的来源 artifact id（不伪装为纯 voice） */
    supersedesArtifactId: z.string().min(1).optional(),
  })
  .strict();

export type TextOrMixedPayload = z.infer<typeof textOrMixedPayloadSchema>;

// ─── ASRProviderPolicySchema（Provider 数据治理，§13.2）────────────────────

export const asrProviderPolicySchema = z
  .object({
    /** workspace 绑定的 tenant policy 引用（固定到 artifact/contract） */
    tenantPolicyRef: z.string().min(1),
    /** 数据处理区域（如 eu-central-1 / us-east-1） */
    region: z.string().min(1),
    /** 数据保留期（天）；raw audio 短期 TTL 与 transcript 长期保留分开 */
    retentionDays: z.number().int().positive(),
    /** 训练使用禁令：true = 禁止使用用户音频/transcript 训练 */
    trainingUseProhibited: z.boolean(),
    /** 数据处理 consent version（用户当前同意的版本，不满足 → fail closed） */
    consentVersion: z.string().min(1),
  })
  .strict();

export type ASRProviderPolicy = z.infer<typeof asrProviderPolicySchema>;

// ─── 汇总导出（供整体契约校验/引用）───────────────────────────────────────

export const voiceArtifactContracts = {
  version: VOICE_ARTIFACT_CONTRACTS_VERSION,
  transcriptSegment: transcriptSegmentSchema,
  voicePayload: voicePayloadSchema,
  textOrMixedPayload: textOrMixedPayloadSchema,
  asrProviderPolicy: asrProviderPolicySchema,
} as const;
