import type { CharacterCueEmotionV1 } from "./companion-character-contracts.ts";

/**
 * 本地确定性情感分类器（soullink MessageReactionClassifier 思路迁移）。
 *
 * 作用对象是**助手回复文本**：把回复传达的情绪（而非用户输入）映射到
 * 受控的 CharacterCueEmotionV1 枚举 + 0..1 强度。纯本地关键词正则，
 * 零 LLM 调用、确定性、可单测、可审计——失败/无命中永远回落 neutral，
 * 不阻塞对话正文（方案 13 §3.4 / 03 合同 §5.2：cue 失败回确定性映射）。
 */

export interface CompanionReplyEmotionV1 {
  emotion: CharacterCueEmotionV1;
  /** 0..1，调用方负责最终 clamp。 */
  intensity: number;
  /** 命中的关键词（便于审计与测试）。 */
  matched: string[];
}

interface EmotionRule {
  emotion: CharacterCueEmotionV1;
  baseIntensity: number;
  keywords: string[];
}

// 优先级从高到低：同一文本命中多个规则时取第一个（happy > surprised >
// curious > concerned）。规则顺序即优先级顺序，不得随意调整。
const REPLY_EMOTION_RULES: readonly EmotionRule[] = [
  {
    emotion: "happy",
    baseIntensity: 0.72,
    keywords: [
      "恭喜", "太好了", "好耶", "太棒", "真棒", "棒", "成功", "上岸",
      "通过", "拿下", "完成了", "做到了", "达成", "收获", "进步",
      "开心", "高兴", "哈哈", "加油", "继续保持", "值得",
    ],
  },
  {
    emotion: "surprised",
    baseIntensity: 0.62,
    keywords: [
      "没想到", "居然", "竟然", "哇", "天哪", "真的吗", "这么厉害",
      "惊讶", "出乎意料", "厉害啊", "意外",
    ],
  },
  {
    emotion: "curious",
    baseIntensity: 0.5,
    keywords: [
      "好奇", "想知道", "看看", "为什么", "怎么回事", "原因",
      "有趣", "发现", "琢磨", "留意", "想想", "回忆一下",
    ],
  },
  {
    emotion: "concerned",
    baseIntensity: 0.55,
    keywords: [
      "别担心", "没关系", "辛苦了", "累了吧", "注意休息", "注意身体",
      "小心", "休息一下", "没事的", "放松", "别急", "慢慢来",
      "担心", "心疼", "照顾", "不舒服",
    ],
  },
];

const NEGATION_PREFIX = /(不|没|别|无|莫|非)$/u;

/** 判断命中词是否被否定前缀抵消（如「不开心」「没关系」不触发 happy）。 */
function isNegatedKeyword(text: string, index: number): boolean {
  if (index <= 0) return false;
  const prefix = text.slice(Math.max(0, index - 2), index);
  return NEGATION_PREFIX.test(prefix);
}

const NEUTRAL_INTENSITY = 0.3;

/**
 * 把助手回复文本分类为受控情绪。
 * - 命中规则 → 情绪 + 强度（命中词数越多强度越高，clamp 0.15..0.9）；
 * - 未命中 → neutral / NEUTRAL_INTENSITY（03 合同 §5.2 首个 delta 兜底值）。
 */
export function classifyCompanionReplyEmotion(text: string): CompanionReplyEmotionV1 {
  const normalized = text.normalize("NFC").trim();
  if (normalized.length === 0) {
    return { emotion: "neutral", intensity: NEUTRAL_INTENSITY, matched: [] };
  }
  for (const rule of REPLY_EMOTION_RULES) {
    const matched: string[] = [];
    for (const keyword of rule.keywords) {
      let searchFrom = 0;
      while (searchFrom <= normalized.length) {
        const index = normalized.indexOf(keyword, searchFrom);
        if (index < 0) break;
        if (!isNegatedKeyword(normalized, index)) matched.push(keyword);
        searchFrom = index + keyword.length;
      }
    }
    if (matched.length > 0) {
      const bonus = Math.min(0.18, (matched.length - 1) * 0.06);
      const intensity = Math.min(0.9, Math.max(0.15, rule.baseIntensity + bonus));
      return { emotion: rule.emotion, intensity, matched };
    }
  }
  return { emotion: "neutral", intensity: NEUTRAL_INTENSITY, matched: [] };
}
