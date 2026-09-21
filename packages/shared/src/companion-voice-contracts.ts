import { z } from "zod";

/**
 * Companion M2 语音朗读合同（`companion.voice.speak`）。
 *
 * renderer 只提交一段已净化的短中文提示文本；main 通过 `POST /voice/tts`
 * 取回 `audio/mpeg` 原始字节，再投影为本模块的 strict
 * result。服务端仍会二次拒绝 SSML/URL/脚本，因此这里只承载纯文本上限。
 */
export const COMPANION_VOICE_MAX_TEXT_LENGTH = 120;

/** main 侧音频硬上限（字节）：与 schema 上限一致，超限直接 fail closed。 */
export const COMPANION_VOICE_MAX_AUDIO_BYTES = 524288;

/** 朗读只允许已审核的固定 voice profile。 */
export const COMPANION_VOICE_SPEAK_VOICE = "zh-CN-XiaoxiaoNeural" as const;

export const companionVoiceSpeakRequestV1Schema = z.strictObject({
  version: z.literal(1),
  text: z.string().trim().min(1).max(COMPANION_VOICE_MAX_TEXT_LENGTH),
});
export type CompanionVoiceSpeakRequestV1 = z.infer<typeof companionVoiceSpeakRequestV1Schema>;

export const companionVoiceSpeakResultV1Schema = z.strictObject({
  version: z.literal(1),
  mimeType: z.literal("audio/mpeg"),
  audioBase64: z.string().min(1),
  byteLength: z.number().int().positive().max(COMPANION_VOICE_MAX_AUDIO_BYTES),
  voice: z.string().min(1).max(64),
});
export type CompanionVoiceSpeakResultV1 = z.infer<typeof companionVoiceSpeakResultV1Schema>;

/**
 * Agent 正文朗读只提交服务端签发的片段引用，正文、语气标签和 voice profile 都不由
 * renderer 指定。API 会在当前工作区内重读事件并再次校验 run/generation fence。
 */
export const companionVoiceSpeakSegmentRequestV2Schema = z.strictObject({
  version: z.literal(2),
  conversationId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  ordinal: z.number().int().min(1).max(200),
  segmentId: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CompanionVoiceSpeakSegmentRequestV2 = z.infer<typeof companionVoiceSpeakSegmentRequestV2Schema>;

/**
 * 一段音频在客户端那一侧的结局（0247）。
 *
 * 只报**原因**，不报 outcome：`outcome` 由服务端按这张表映射（客户端同时报两个字段
 * 只会造出 `reason=deadline, outcome=ok` 这种自相矛盾的行，而报表正是靠这些行回答
 * "她没声音"是哪一种）。
 *
 * 取值域只有三个，且每一个都对应渲染进程里一条真实分支：播完了、等到超时被跳过、
 * 取段这一步本身就失败。**没有**为"以后可能观察到"的情形预留取值。
 * 用户打断（新一轮开始）不在这里：那是正常行为，不是故障，记进同一张表只会让
 * "失败率"随用户打字速度浮动。
 */
export const COMPANION_TTS_PLAYBACK_REASONS = [
  "played",       // 播完了
  "deadline",     // 字节在路上，但首段/段间截止先到 → 这段被跳过
  "synth_failed", // 取段/合成请求本身失败（网络、502、解不出音频）
] as const;
export type CompanionTtsPlaybackReason = (typeof COMPANION_TTS_PLAYBACK_REASONS)[number];

/** reason → `companion_tts_outcomes.outcome`（沿用 0246 的词表，不新增取值）。 */
export const COMPANION_TTS_PLAYBACK_REASON_TO_OUTCOME: Record<
  CompanionTtsPlaybackReason,
  "ok" | "rejected" | "failed"
> = {
  played: "ok",
  deadline: "failed",
  synth_failed: "failed",
};

export const companionVoicePlaybackOutcomeRequestV1Schema = z.strictObject({
  version: z.literal(1),
  conversationId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().positive(),
  ordinal: z.number().int().min(1).max(200),
  segmentId: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.enum(COMPANION_TTS_PLAYBACK_REASONS),
  /** 从发起取段到这段有结局的耗时；`played` 时就是"听完这一段一共等了多久"。 */
  durationMs: z.number().int().min(0).max(600_000).optional(),
});
export type CompanionVoicePlaybackOutcomeRequestV1 = z.infer<
  typeof companionVoicePlaybackOutcomeRequestV1Schema
>;

/**
 * 上报的回执。`recorded` 说的是"**这次请求被接受了**"，不是"那一段播好了"——
 * 后者在请求里。同一段重发会被幂等索引吞掉，仍然回 recorded=true：从客户端的视角
 * 这两次都是"我已经把这段的结局告诉你了"，没有需要它处理的差别。
 */
export const companionVoicePlaybackOutcomeResultV1Schema = z.strictObject({
  version: z.literal(1),
  recorded: z.boolean(),
});
export type CompanionVoicePlaybackOutcomeResultV1 = z.infer<
  typeof companionVoicePlaybackOutcomeResultV1Schema
>;

// ─── 语音转文本（`companion.voice.transcribe`，2026-09-18 接线） ─────────────
//
// 渲染层已完成本地录音（getUserMedia + AudioWorklet → 16kHz 单声道 WAV），
// main 把字节以 multipart 送到 `POST /voice/transcribe`（purpose=companion_dialogue），
// 服务端做 magic-byte 校验 → SiliconFlow ASR → pending voice artifact，
// 回包携带 voiceArtifactId——后续 turn 以 `inputKind=voice_transcript` 引用它。
// 本地 SenseVoice（sherpa-onnx WASM）优先：只有本地引擎不可用时才落到这条云通道，
// 落地顺序见 docs/plans/learning-companion/13-… §P6 三路由。

export const COMPANION_VOICE_TRANSCRIBE_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const COMPANION_VOICE_TRANSCRIBE_MAX_TEXT = 4_000;

export const companionVoiceTranscribeRequestV1Schema = z.strictObject({
  version: z.literal(1),
  /** 16kHz 单声道 WAV 的完整字节（base64）。 */
  audioBase64: z.string().min(1),
  /** 采样时长（毫秒），服务端用于 companion 分支的实测时长对照。 */
  durationMs: z.number().int().min(200).max(120_000),
  /** BCP-47 主语言提示；companion 对话固定 zh-CN 起步。 */
  language: z.enum(["zh-CN", "en-US"]),
});
export type CompanionVoiceTranscribeRequestV1 = z.infer<typeof companionVoiceTranscribeRequestV1Schema>;

export const companionVoiceTranscribeResultV1Schema = z.strictObject({
  version: z.literal(1),
  voiceArtifactId: z.string().uuid(),
  text: z.string().min(1).max(COMPANION_VOICE_TRANSCRIBE_MAX_TEXT),
  transcriptSha256: z.string().length(64),
  asrProvider: z.string().min(1).max(64),
  asrModel: z.string().min(1).max(120),
  language: z.string().min(1).max(32),
  durationMs: z.number().int().min(0),
  expiresAt: z.string().datetime(),
});
export type CompanionVoiceTranscribeResultV1 = z.infer<typeof companionVoiceTranscribeResultV1Schema>;
