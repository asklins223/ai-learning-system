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
