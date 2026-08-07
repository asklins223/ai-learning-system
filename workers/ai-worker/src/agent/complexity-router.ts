/**
 * P2-1：Complexity Router（先统计不切换）。
 *
 * 依据内容特征确定性判定执行模式（实施计划 §2.1/§3.1/§4.8）：
 * - 无图片、无公式、代码片段少、density 非 complete → `fast_two_stage_v1` 候选
 * - 否则 → `full_supervisor_v1`（现状路径，P2-1 期不切换，仅统计）
 * - `adaptive_planned_v1` 预留（Phase 3 实施）
 *
 * **不做 token 量或数量级硬阈值**（历史教训：数值上限导致 AI 输出截断、任务失败）。
 * P2-1 期只落库 execution_mode + routing_reason，实际执行仍走 Full Supervisor。
 */

import { GenerationExecutionMode, type GenerationDensity } from "@ailearn/shared";

/** Router 输入（确定性信号,来自 PREPARE 已加载的 note blocks） */
export interface RouterInput {
  /** 生成密度（overview | standard | complete） */
  density: GenerationDensity | string;
  /** 文本块数（含标题/段落） */
  blockCount: number;
  /** 图片块数 */
  imageCount: number;
  /** 公式块数（note_blocks.type === "formula" 或公式标记） */
  formulaCount: number;
  /** 代码块数（note_blocks.type === "code"） */
  codeCount: number;
  /** 全部文本字符数（仅统计,不进判定） */
  totalChars: number;
}

/** 路由结果 */
export interface RouterDecision {
  mode: GenerationExecutionMode;
  /** 确定性判定依据（如 no_images / has_images / density_complete） */
  routingReason: string[];
}

/** 只读路由原因 allowlist（审计/统计用） */
export const ROUTING_REASON_ALLOWLIST = [
  "no_images",
  "no_formula",
  "no_code",
  "density_not_complete",
  "has_images",
  "has_formula",
  "has_code",
  "density_complete",
] as const;

/**
 * 确定性复杂度路由判定（纯函数,可单测）。
 *
 * 规则（§3.1）：简单内容 = 无图片 + 无公式 + 无代码 + density 非 complete。
 * 任何一项排除条件命中 → full_supervisor_v1（现状路径）。
 * P2-1 统计期该判定仅落库,不改变执行路径。
 */
export function computeComplexityRoute(input: RouterInput): RouterDecision {
  const reasons: string[] = [];

  if (input.imageCount === 0) reasons.push("no_images");
  else reasons.push("has_images");

  if (input.formulaCount === 0) reasons.push("no_formula");
  else reasons.push("has_formula");

  if (input.codeCount === 0) reasons.push("no_code");
  else reasons.push("has_code");

  if (input.density !== "complete") reasons.push("density_not_complete");
  else reasons.push("density_complete");

  const isSimple = input.imageCount === 0
    && input.formulaCount === 0
    && input.codeCount === 0
    && input.density !== "complete";

  // P2-1 只统计不切换：判定结果落库,但执行仍走 Full Supervisor。
  // adaptive_planned_v1 由 Phase 3 引入,当前不产出。
  return {
    mode: isSimple ? GenerationExecutionMode.FAST_TWO_STAGE_V1 : GenerationExecutionMode.FULL_SUPERVISOR_V1,
    routingReason: reasons,
  };
}
