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

// 否定词集合：命中词前 2-3 字符窗口内出现任一否定词即视为被否定。
// 2026-08-25（AI 设计审计修复）：原实现只看紧邻前一字符（"不开心"能拦，
// "没有进步"/"不那么棒"这类间隔否定漏网误判 happy）。窗口取 2 是
// "不/没/别…" + 1 字衬字（如"没有进步"的"有"、"不太棒"的"太"）的
// 常见间隔；再宽会开始吞并合法并列（"不好不坏的进步"）。
const NEGATION_WORDS = ["不", "没", "别", "无", "莫", "非", "未", "毫无", "毫不"] as const;

function isNegatedKeyword(text: string, index: number): boolean {
  if (index <= 0) return false;
  const window = text.slice(Math.max(0, index - 3), index);
  return NEGATION_WORDS.some((w) => {
    const at = window.lastIndexOf(w);
    // 否定词必须落在紧贴关键词的 2 字符窗口内（允许隔 1 个衬字）。
    return at >= 0 && (window.length - at - w.length) <= 1;
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 每个规则预编译一个合并正则：一次扫描文本即可命中该规则的全部关键词，
 * 避免对 ~50 个关键词各自做一次全文 indexOf（对话热路径）。
 * 命中顺序为文档顺序；与旧逐关键词扫描相比，matched 内容/计数完全一致。
 */
const REPLY_EMOTION_RULES_COMPILED: Array<{
  emotion: CharacterCueEmotionV1;
  baseIntensity: number;
  regex: RegExp;
}> = REPLY_EMOTION_RULES.map((rule) => ({
  emotion: rule.emotion,
  baseIntensity: rule.baseIntensity,
  regex: new RegExp(rule.keywords.map(escapeRegExp).join("|"), "g"),
}));

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
  for (const rule of REPLY_EMOTION_RULES_COMPILED) {
    const matched: string[] = [];
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(normalized)) !== null) {
      if (!isNegatedKeyword(normalized, m.index)) matched.push(m[0]);
      // 防御：避免零宽匹配死循环（本规则关键词均非空串）。
      if (m[0].length === 0) rule.regex.lastIndex += 1;
    }
    if (matched.length > 0) {
      const bonus = Math.min(0.18, (matched.length - 1) * 0.06);
      const intensity = Math.min(0.9, Math.max(0.15, rule.baseIntensity + bonus));
      return { emotion: rule.emotion, intensity, matched };
    }
  }
  return { emotion: "neutral", intensity: NEUTRAL_INTENSITY, matched: [] };
}
