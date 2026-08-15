/**
 * 方案 20 §10.2 — V2 生成管线显式路由（R35）。
 *
 * 轻链路条件（§10.2）：
 * - 纯文本（无 code/formula/table/image 等复杂模态）；
 * - evidence 数量与上下文在安全范围内（单次上下文可完成全局规划）；
 * - 未命中 prompt injection / contradiction / cross-section dependency 标记。
 *
 * 当前实现：
 * - 模态判定：block.type 非 paragraph/text → standard；
 * - 规模判定：source 文本 > 2000 字或 evidence > 12 → standard；
 * - prompt injection：复用 deterministic-gates §13.1 safety 的标记正则；
 * - contradiction / cross-section dependency：预留标记位（当前无独立检测器，
 *   caller 可经 extraRiskMarkers 注入；有检测器后在此接入，如实记录）。
 *
 * 路由不影响质量要求（Grounding/Pedagogy 仍必须独立成立），只决定编排标记
 * 与观测：handler 把 route 写入 `pipeline.route.light|standard` 领域事件。
 */

const INJECTION_MARKER =
  /(ignore (previous|prior|all) instructions|disregard (previous|prior)|system prompt:|你是.*AI|你是一个.*助手|pretend (you are|to be)|forget your instructions|忽略(以上|之前|所有|一切|先前)|放弃(之前|先前)(指令|设定)|请忽略|忘掉你)/i;

export interface PipelineRouteInputV2 {
  /** note blocks（含 type 与 content） */
  blocks: Array<{ type: string; content: string }>;
  /** sealed evidence snapshot 数量 */
  evidenceCount: number;
  /** 参与规划的源文本总长（字符） */
  sourceTextLength: number;
  /** 额外风险标记（contradiction/cross-section 等检测器接入点） */
  extraRiskMarkers?: string[];
}

export type V2PipelineRoute = "light" | "standard";

export interface PipelineRouteResultV2 {
  route: V2PipelineRoute;
  reasons: string[];
}

export function classifyV2PipelineRoute(input: PipelineRouteInputV2): PipelineRouteResultV2 {
  const reasons: string[] = [];

  if (input.blocks.some((b) => b.type !== "paragraph" && b.type !== "text")) {
    reasons.push("non_text_block");
  }
  if (input.sourceTextLength > 2000) {
    reasons.push("source_too_large");
  }
  if (input.evidenceCount > 12) {
    reasons.push("evidence_count_too_high");
  }
  if (input.blocks.some((b) => INJECTION_MARKER.test(b.content))) {
    reasons.push("prompt_injection_marker");
  }
  for (const marker of input.extraRiskMarkers ?? []) {
    reasons.push(marker);
  }

  return {
    route: reasons.length === 0 ? "light" : "standard",
    reasons,
  };
}
