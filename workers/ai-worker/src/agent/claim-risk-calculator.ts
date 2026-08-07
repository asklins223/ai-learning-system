/**
 * P2-5：DeterministicClaimRisk 计算器（实施计划 §3.3, P2-5）。
 *
 * 确定性风险信号（纯代码，无模型）→ 审查等级映射：
 * - low   → grounding_critic_light（轻量 Critic）
 * - medium/high → grounding_critic_claim（逐 claim 审查）
 * - 硬规则：Repair / Image / Formula / Code 证据至少 Claim-Level
 *
 * 模型标注只升不降（模型可提高风险，不能降低确定性风险）。
 */

import type { FastExtractionCandidate } from "@ailearn/shared";

export const ClaimRiskLevel = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;
export type ClaimRiskLevel = (typeof ClaimRiskLevel)[keyof typeof ClaimRiskLevel];

export const ReviewLevel = {
  LIGHT: "grounding_critic_light",
  CLAIM: "grounding_critic_claim",
} as const;
export type ReviewLevel = (typeof ReviewLevel)[keyof typeof ReviewLevel];

/** 模型可附加的风险标注（只升不降） */
export interface ModelRiskAnnotation {
  claimRisk?: ClaimRiskLevel;
  reason?: string;
}

export interface ClaimRiskInput {
  candidate: FastExtractionCandidate;
  /** 模型标注(可选,只升不降) */
  modelAnnotation?: ModelRiskAnnotation;
  /** 引用证据的块类型(代码/公式/图片判定) */
  referencedBlockTypes: string[];
  /** 引用证据是否含公式标记 */
  referencedFormulaMarkers: boolean[];
  /** 重复候选判定(与既有候选 claim 相似) */
  isDuplicateClaim?: boolean;
}

export interface ClaimRiskResult {
  level: ClaimRiskLevel;
  /** 命中的确定性信号 */
  signals: string[];
}

const LEVEL_ORDER: Record<ClaimRiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** 取更高风险(只升不降) */
function maxLevel(a: ClaimRiskLevel, b: ClaimRiskLevel): ClaimRiskLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

/**
 * 计算确定性 claim 风险(纯函数,可单测)。
 * 硬规则:Repair/Image/Formula/Code 证据 → 至少 high(→ Claim-Level)。
 */
export function computeClaimRisk(input: ClaimRiskInput): ClaimRiskResult {
  const signals: string[] = [];
  let level: ClaimRiskLevel = ClaimRiskLevel.LOW;

  const { candidate } = input;

  // 证据数:0 证据 → high;1 证据 → medium;≥2 → 保持
  if (input.referencedBlockTypes.length === 0) {
    level = maxLevel(level, ClaimRiskLevel.HIGH);
    signals.push("no_evidence");
  } else if (input.referencedBlockTypes.length === 1) {
    level = maxLevel(level, ClaimRiskLevel.MEDIUM);
    signals.push("single_evidence");
  }

  // claim 长度:>300 字 → high;200-300 → medium
  if (candidate.claim.length > 300) {
    level = maxLevel(level, ClaimRiskLevel.HIGH);
    signals.push("long_claim");
  } else if (candidate.claim.length > 200) {
    level = maxLevel(level, ClaimRiskLevel.MEDIUM);
    signals.push("longish_claim");
  }

  // 硬规则:代码/公式/图片证据 → high(→ Claim-Level)
  const hasCode = input.referencedBlockTypes.includes("code");
  const hasFormula = input.referencedFormulaMarkers.some(Boolean);
  const hasImage = input.referencedBlockTypes.includes("image");
  if (hasCode) {
    level = maxLevel(level, ClaimRiskLevel.HIGH);
    signals.push("code_evidence");
  }
  if (hasFormula) {
    level = maxLevel(level, ClaimRiskLevel.HIGH);
    signals.push("formula_evidence");
  }
  if (hasImage) {
    level = maxLevel(level, ClaimRiskLevel.HIGH);
    signals.push("image_evidence");
  }

  // 重复候选
  if (input.isDuplicateClaim) {
    level = maxLevel(level, ClaimRiskLevel.HIGH);
    signals.push("duplicate_claim");
  }

  // 模型标注只升不降
  if (input.modelAnnotation?.claimRisk) {
    const annotated = maxLevel(level, input.modelAnnotation.claimRisk);
    if (annotated !== level) signals.push(`model_annotation_${input.modelAnnotation.claimRisk}`);
    level = annotated;
  }

  return { level, signals };
}

/**
 * 风险 → 审查等级映射。
 * low → LIGHT;medium/high → CLAIM。
 */
export function riskToReviewLevel(risk: ClaimRiskLevel): ReviewLevel {
  return risk === ClaimRiskLevel.LOW ? ReviewLevel.LIGHT : ReviewLevel.CLAIM;
}
