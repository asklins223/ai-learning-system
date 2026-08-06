/**
 * 输入规模预检（计划 §W3, §10.2）
 *
 * 在 PREPARE 阶段最早期执行，拒绝超过产品限制的输入。
 * 不做任何模型调用，纯确定性检查。
 *
 * 预检阈值（计划 §17.1 黄金集）：
 * - 文本规模：2K / 13K / 50K / 500K 字符
 * - 图片数量：1 / 10 / 30 张
 * - block 数量：最多 2,000 个
 *
 * 不变量（G1, G2）：
 * - 输入快照不可变，预检只读
 * - 超限输入直接进入 needs_attention，不截断、不静默丢弃
 */

import {
  CARD_GENERATION_MAX_BLOCKS,
  CARD_GENERATION_MAX_IMAGES,
  CARD_GENERATION_MAX_SOURCE_CHARS,
} from "@ailearn/shared";

/** 输入预检结果 */
export interface InputPrecheckResult {
  /** 是否通过 */
  ok: boolean;
  /** 文本字符总数 */
  totalSourceChars: number;
  /** block 总数 */
  blockCount: number;
  /** 图片总数 */
  imageCount: number;
  /** 文本规模档位 */
  textScale: TextScale;
  /** 图片规模档位 */
  imageScale: ImageScale;
  /** 失败原因（如果不通过） */
  failureReason: string | null;
  /** 警告信息（通过但有风险） */
  warnings: string[];
}

/** 文本规模档位（计划 §17.1） */
export type TextScale = "short" | "medium" | "long" | "extra_long" | "oversized";

/** 图片规模档位（计划 §17.1） */
export type ImageScale = "none" | "few" | "moderate" | "many" | "oversized";

/** 文本规模阈值（字符数） */
export const TEXT_SCALE_THRESHOLDS = {
  SHORT: 2_000,
  MEDIUM: 13_000,
  LONG: 50_000,
  EXTRA_LONG: 500_000,
} as const;

/** 图片规模阈值 */
export const IMAGE_SCALE_THRESHOLDS = {
  FEW: 1,
  MODERATE: 10,
  MANY: 30,
} as const;

/** 判断文本规模档位 */
export function classifyTextScale(charCount: number): TextScale {
  if (charCount > CARD_GENERATION_MAX_SOURCE_CHARS) return "oversized";
  if (charCount <= TEXT_SCALE_THRESHOLDS.SHORT) return "short";
  if (charCount <= TEXT_SCALE_THRESHOLDS.MEDIUM) return "medium";
  if (charCount <= TEXT_SCALE_THRESHOLDS.LONG) return "long";
  return "extra_long";
}

/** 判断图片规模档位 */
export function classifyImageScale(imageCount: number): ImageScale {
  if (imageCount > CARD_GENERATION_MAX_IMAGES) return "oversized";
  if (imageCount === 0) return "none";
  if (imageCount <= IMAGE_SCALE_THRESHOLDS.FEW) return "few";
  if (imageCount <= IMAGE_SCALE_THRESHOLDS.MODERATE) return "moderate";
  return "many";
}

/** 预检输入 */
export interface PrecheckInput {
  /** 所有 block 的内容长度总和 */
  totalSourceChars: number;
  /** block 总数 */
  blockCount: number;
  /** 图片 block 数量 */
  imageCount: number;
}

/**
 * 执行输入规模预检。
 *
 * 纯确定性检查，不做任何模型调用。
 * 超限输入直接失败，不截断、不静默丢弃（计划 §G2, §10.2）。
 */
export function precheckInput(input: PrecheckInput): InputPrecheckResult {
  const textScale = classifyTextScale(input.totalSourceChars);
  const imageScale = classifyImageScale(input.imageCount);
  const warnings: string[] = [];

  // 检查硬限制
  if (input.blockCount > CARD_GENERATION_MAX_BLOCKS) {
    return {
      ok: false,
      totalSourceChars: input.totalSourceChars,
      blockCount: input.blockCount,
      imageCount: input.imageCount,
      textScale,
      imageScale,
      failureReason: `block 数量 ${input.blockCount} 超过上限 ${CARD_GENERATION_MAX_BLOCKS}`,
      warnings,
    };
  }

  if (input.totalSourceChars > CARD_GENERATION_MAX_SOURCE_CHARS) {
    return {
      ok: false,
      totalSourceChars: input.totalSourceChars,
      blockCount: input.blockCount,
      imageCount: input.imageCount,
      textScale,
      imageScale,
      failureReason: `文本字符数 ${input.totalSourceChars} 超过上限 ${CARD_GENERATION_MAX_SOURCE_CHARS}`,
      warnings,
    };
  }

  if (input.imageCount > CARD_GENERATION_MAX_IMAGES) {
    return {
      ok: false,
      totalSourceChars: input.totalSourceChars,
      blockCount: input.blockCount,
      imageCount: input.imageCount,
      textScale,
      imageScale,
      failureReason: `图片数量 ${input.imageCount} 超过上限 ${CARD_GENERATION_MAX_IMAGES}`,
      warnings,
    };
  }

  // 添加警告（通过但有性能风险）
  if (textScale === "extra_long") {
    warnings.push("超长文本（>50K 字符），生成时间可能较长，建议拆分笔记或使用 overview 密度");
  }
  if (imageScale === "many") {
    warnings.push("图片数量较多（>10 张），视觉处理可能消耗较多预算");
  }

  return {
    ok: true,
    totalSourceChars: input.totalSourceChars,
    blockCount: input.blockCount,
    imageCount: input.imageCount,
    textScale,
    imageScale,
    failureReason: null,
    warnings,
  };
}
