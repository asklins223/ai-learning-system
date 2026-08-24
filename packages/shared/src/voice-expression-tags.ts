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

/**
 * 2026-08-24（AI 设计审查 §4.2 修复）：未知标签防御。
 * 此前白名单只剥 30 个已知标签，模型自造的 `[happy]` 这类标签会原样
 * 漏进展示文本与 TTS（被当普通文字读出）。此处按"ASCII 标签形态"
 * 剥离未知标签：
 * - 负向前瞻逐项锚定 `]`（只豁免完整已知标签）——否则已知标签的变形词
 *   （[sadly]、[excitedly]、[gasps]，恰是最高发的幻觉家族）会因前缀命中
 *   已知名而逃过剥离；
 * - 形态：`[a-z]` 开头、仅含小写字母/数字/空格、内长 ≥3（排除 CEFR 级别
 *   [A1]/[B2] 这类合法短 token）；
 * - 中文正文方括号（如 `[重要]`）与单字符标记（`[b]`）不受影响。
 * 已知取舍：3 字符以上的 ASCII 缩写（[FAQ]/[TODO]）也会被剥——V4 人格已
 * 禁止模型输出任何方括号标记，此残留面可接受；如未来需要保留，应改为
 * 显式白名单而非放宽本模式。
 */
const UNKNOWN_TAG_PATTERN = new RegExp(
  `\\[(?!${[...VOICE_EMOTION_TAGS, ...VOICE_RICH_TAGS].map((t) => escapeTagRegex(t) + "\\]").join("|")})`
  + `[a-z][a-z0-9 ]{2,29}\\]`,
  "gi",
);

/** 只剥未知标签形态 token（保留已知标签——TTS 原始文本管线专用）。迭代到不动点，清除嵌套残留（如 "[excited ]"）；末轮顺带清掉剥空后的 "[]" 空壳。 */
export function stripUnknownVoiceExpressionTags(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(UNKNOWN_TAG_PATTERN, "").replace(/\[\s*\]/g, "");
    if (next === out) return out;
    out = next;
  }
}

/** 剥离全部语音标签：已知 30 个 + 未知 ASCII 标签形态（展示/入库/非 qwen 引擎合成前调用）。 */
export function stripVoiceExpressionTags(text: string): string {
  return stripUnknownVoiceExpressionTags(text.replace(VOICE_TAG_PATTERN, ""));
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
