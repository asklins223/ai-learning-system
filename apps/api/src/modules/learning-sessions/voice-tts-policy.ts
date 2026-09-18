import { DomainError } from "@ailearn/shared";

export const DEFAULT_VOICE_PROFILE = "companion-default-v1";

const ALLOWED_VOICE_PROFILES: ReadonlySet<string> = new Set([DEFAULT_VOICE_PROFILE]);
const SSML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?\s*>/;
const REMOTE_URL_RE = /\bhttps?:\/\/\S+/i;
const HIDDEN_PROMPT_RE =
  /(?:\[system\]|\[assistant\]|<\|im_start\|)|ignore\s+(?:previous|above|prior)|^\s*(?:system|assistant)\s*[:：]|(?:忽略|忘记)(?:上面|以上|之前).{0,8}(?:内容|指令|话)|(?:直接|请).{0,6}(?:告诉|提示|说出).{0,4}(?:答案|关键词)/im;

export class VoiceTtsPolicyError extends DomainError {
  constructor(message: string) {
    super({
      name: "VoiceTtsPolicyError",
      code: "TTS_INPUT_UNSAFE",
      message,
      statusCode: 500,
    });
  }
}

/** TTS 只朗读净化后的题面纯文本和固定的审核 voice profile。 */
export function assertSafeTtsInput(text: string, voiceProfile: string): void {
  if (typeof text !== "string" || text.trim() === "") {
    throw new VoiceTtsPolicyError("TTS 输入为空");
  }
  if (SSML_TAG_RE.test(text)) {
    throw new VoiceTtsPolicyError("TTS 输入包含 SSML/XML 标签，拒绝");
  }
  if (REMOTE_URL_RE.test(text)) {
    throw new VoiceTtsPolicyError("TTS 输入包含远程音频 URL，拒绝");
  }
  if (HIDDEN_PROMPT_RE.test(text)) {
    throw new VoiceTtsPolicyError("TTS 输入包含隐藏提示/关键词暗示，拒绝");
  }
  if (!ALLOWED_VOICE_PROFILES.has(voiceProfile)) {
    throw new VoiceTtsPolicyError(`voice/profile 不在固定 allowlist：${voiceProfile}`);
  }
}
