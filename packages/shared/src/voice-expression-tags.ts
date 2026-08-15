/**
 * 15b 二期：情感与富语言标签（阿里百炼 Qwen-Audio-TTS 专属能力）。
 *
 * 双文本管线：LLM 输出可嵌入标签（仅 qwen 朗读文本保留），展示/入库文本
 * 必须剥离（stripVoiceExpressionTags）；段级情感由 extractVoiceEmotion
 * 解析（最后一个控制类标签 → emotion，供 live2d 协同）。
 *
 * 2026-08-13（引擎兼容）：标签是 qwen-audio 模型的专属能力——edge-tts 等
 * 其他引擎会把 `[excited]` 当普通文字朗读。api 是引擎边界：edge 分支在
 * 合成前调用 stripVoiceExpressionTags 净化文本；emotion 字段（Live2D
 * 表情驱动）与引擎无关，worker 始终解析下发。
 */

/** 控制类标签（23 个，文档全表）：作用于其后文本的情感/风格。 */
export const VOICE_EMOTION_TAGS = [
  "sad",
  "amazed",
  "deep and loud shouting",
  "trembling",
  "angry",
  "excited",
  "sarcastic",
  "curious",
  "like dracula",
  "bored",
  "tired",
  "scornful",
  "shouting",
  "asmr",
  "panicked",
  "mischievously",
  "empathetic",
  "whispers",
  "reluctantly",
  "crying",
  "serious",
  "very slowly",
  "very fast",
] as const;

/** 富语言类标签（7 个，文档全表）：在当前位置插入拟声效果。 */
export const VOICE_RICH_TAGS = [
  "gasp",
  "sighing",
  "clears throat",
  "giggles",
  "laughing",
  "cough",
  "snorts",
] as const;

function escapeTagRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 白名单正则：只匹配已知标签（`[excited]` 等），不误伤正文 `[重要]` 方括号。 */
const VOICE_TAG_PATTERN = new RegExp(
  `\\[(?:${[...VOICE_EMOTION_TAGS, ...VOICE_RICH_TAGS].map(escapeTagRegex).join("|")})\\]`,
  "gi",
);

/** 剥离全部已知语音标签（展示/入库/非 qwen 引擎合成前调用）。 */
export function stripVoiceExpressionTags(text: string): string {
  return text.replace(VOICE_TAG_PATTERN, "");
}

/** 提取文本中最后一个控制类标签名（小写；无则 null）——段级 emotion 来源。 */
export function extractVoiceEmotion(text: string): string | null {
  const pattern = new RegExp(
    `\\[(${VOICE_EMOTION_TAGS.map(escapeTagRegex).join("|")})\\]`,
    "gi",
  );
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = pattern.exec(text)) !== null) {
    last = match[1].toLowerCase();
  }
  return last;
}
