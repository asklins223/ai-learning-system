/**
 * 确定性语气层（2026-08-24，AI 设计审查 §4.2 修复；同日二轮审查重构）。
 *
 * 此前伴星人格 prompt 内嵌约 500 字符的 30 条语音标签全表并要求模型自行
 * 嵌入——小模型在 temperature 1.0 下经常堆砌、漏带或自造标签。V4 人格已
 * 禁止模型输出任何方括号标记；语气改由本模块在 **TTS 段文本**上确定性注入：
 *
 * - 情绪判定基于全文（classifyCompanionReplyEmotion，零 LLM、确定性）；
 *   非中性即注入对应句首控制类标签；
 * - **逐段注入**：每条 voice.segment.ready 是一次独立合成请求，控制标签
 *   只作用于所在段——只在回复开头注一次会让多句回复从第二段起失去韵律。
 *   流式路径切段增量下发，故每次 flush 以"至今累计文本"重新判定情绪，
 *   只作用于新切出的段（前段保留已发情绪，符合旁白式渐进语义）；
 * - 注入同时剥掉模型幻觉的未知标签形态 token：流式注入器逐 delta 清洗
 *   （未闭合 "[" 片段短暂扣留防跨 delta 拆分漏网），段级应用再对完整段
 *   文本做最终净化；
 * - 已含已知控制类标签的全文（回滚 V2/V3 或模型仍输出时）不叠加——尊重
 *   模型自己的标注；已含已知标签的单段也不叠加；
 * - 展示/入库文本在 validateCompanionOutput 中剥离全部标签，双文本管线
 *   语义不变。段 textSha256 在注入后重算（segmentId 由调用方据其派生）。
 *
 * 模型不参与任何决策——最坏情况只是标签选得不贴切，不会出现堆砌或轰炸。
 */

import { createHash } from "node:crypto";
import { classifyCompanionReplyEmotion, type CharacterCueEmotionV1 } from "@ailearn/shared";
import { purifyVoiceText } from "./tts-segments.ts";
import {
  extractVoiceEmotion,
  stripUnknownVoiceExpressionTags,
  VOICE_EMOTION_TAGS,
  VOICE_RICH_TAGS,
} from "@ailearn/shared/voice-expression-tags";
import { TTS_MAX_SEGMENT_CHARS } from "./tts-segments.ts";

/** 段内是否已含已知标签（控制类或富语言类）的快速测试（用于叠加判定）。 */
const VOICE_TAG_TEST = new RegExp(
  `\\[(?:${[...VOICE_EMOTION_TAGS, ...VOICE_RICH_TAGS].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\]`,
  "i",
);

/** 情绪 → 句首控制类标签映射（全部在 voice-expression-tags 控制类白名单内；
 *  控制类标签同时驱动语音韵律与段级 emotion 字段（Live2D 表情））。
 *
 *  与 buildFinalCuePayload 的判定面差异（有意）：cue 对"已剥标签的干净文本"
 *  直接分类，本层在全文含已知控制类标签时整体不注入（尊重模型/旧版人格自己
 *  的标注）——此时表情走 cue 的分类、语音韵律跟模型自己的标签，二者仍同源
 *  （都来自模型文本的情绪），只是路径不同。 */
const EMOTION_TONE_TAGS: Record<CharacterCueEmotionV1, string> = {
  happy: "[excited]",
  surprised: "[amazed]",
  curious: "[curious]",
  concerned: "[empathetic]",
  neutral: "",
};

/**
 * 为整段回复决定语气情绪：未知标签先剥离；全文已含已知控制类标签则返回
 * neutral（= 不注入，尊重模型/旧版人格自己的标注）；否则返回分类器结果
 * （neutral 即不注入）。非中性情绪 baseIntensity 均 ≥0.5，单关键词命中即可
 * 注入——与 buildFinalCuePayload 的"任意非零强度出 cue"同一判定面。
 */
export function resolveReplyToneEmotion(replyText: string): CharacterCueEmotionV1 {
  const cleaned = stripUnknownVoiceExpressionTags(replyText);
  if (extractVoiceEmotion(cleaned)) return "neutral";
  return classifyCompanionReplyEmotion(cleaned).emotion;
}

export interface ToneSegmentInput {
  ordinal: number;
  text: string;
  textSha256: string;
}

/**
 * 逐段应用语气层：对已切出的每个 TTS 段独立注入句首标签，并做最终的
 * 未知标签净化。必须在计算 segmentId 之前调用（本函数会重算 textSha256）。
 *
 * 长度安全：voice.segment.ready 合同与 web 客户端都按 ≤160 code unit 校验
 * （TTS_MAX_SEGMENT_CHARS），超长段会被静默丢弃（文字显示、音频缺失）。
 * 切段发生在注入之前，注入 9-12 字符可能把 160 字符的满段顶过上限——
 * 此类段跳过注入（保住音频；该段只是缺语气，不缺内容）。
 *
 * `injectTags=false` 是用户在伴星中心关掉「语气标签」那条边界
 * （`pet_profiles.boundaries.allowVoiceTags`）：仍然净化模型自己写出的幻觉标签，
 * 只是不再由我们注入。不接这条的话，那个开关就只是个显示用的复选框——
 * 她可以说"我关掉语气标签了"，音频却照旧带标签。
 */
export function applyDeterministicToneToSegments(
  segments: ToneSegmentInput[],
  replyEmotion: CharacterCueEmotionV1,
  injectTags = true,
): ToneSegmentInput[] {
  const tag = injectTags ? (EMOTION_TONE_TAGS[replyEmotion] ?? "") : "";
  return segments.map((s) => {
    // 可见正文从 0246/B6b 起**保留 markdown**（由渲染层排版），朗读文本必须另走一份：
    // 不然 TTS 会把"两个星号""井号"念出来。`purifyVoiceText` 就是这条 speakable 投影
    // （剥标题/列表/强调/行内代码与代码块/URL，保留可读正文）。
    const cleaned = purifyVoiceText(stripUnknownVoiceExpressionTags(s.text));
    // 段内已有任何已知标签（控制类或富语言类）→ 不叠加，避免双标签。
    // 已知标签在净化后仍保留，故只看净化后文本；净化前后有变化不代表
    // 原文带的是已知标签（可能只是被剥掉的幻觉标签）。
    const fitsWithTag = cleaned.length + tag.length <= TTS_MAX_SEGMENT_CHARS;
    const tone = tag && fitsWithTag && !VOICE_TAG_TEST.test(cleaned) ? tag : "";
    const text = `${tone}${cleaned}`;
    return {
      ...s,
      text,
      textSha256: createHash("sha256").update(text, "utf8").digest("hex"),
    };
  });
}

