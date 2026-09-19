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
