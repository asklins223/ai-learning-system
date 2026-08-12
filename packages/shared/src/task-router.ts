/**
 * R3: 任务路由层 — 任务 → 能力映射。
 *
 * 不同任务可以路由到不同 provider/模型。
 * 简单任务（验证评估、题目生成、评分）可以用免费小模型，
 * 复杂任务（卡片生成 Agent）用付费大模型。
 *
 * @see docs/plans/provider-registry-refactor.md §3.3
 */

import type { Capability } from "./provider-capabilities.ts";
import { resolveSystemPlatform } from "./platform-config.ts";

/** AI 任务类型 — 可扩展 */
export type AITaskType =
  // ── 卡片生成 Agent ──
  | "card_generation"       // Supervisor Agent（高复杂度）
  | "text_extraction"      // Text/Code Extractor（高复杂度）
  | "deck_composition"     // Deck Composer（中复杂度）
  | "grounding_critic"     // Grounding Critic（中复杂度）
  | "repair"               // Repairer（中复杂度）
  // ── 验证评估 ──
  | "evaluate_validation"  // 验证评估（低复杂度）
  | "generate_question"    // 题目生成（低复杂度）
  | "evaluate_rubric"      // 评分（低复杂度）
  // ── 其他 ──
  | "analyze_image"        // 图片分析
  | "embed"                // 向量嵌入
  | "rerank"               // 重排序
  // ── 未来 ──
  | "speech_recognition"   // 语音识别
  | "image_generation"     // 文生图
  // ── P2 companion（03 合同 §9.5 参数） ──
  | "companion_dialogue"    // 日常对话流式回复（低复杂度）
  // ── P5 learning action bridge（慢动作，worker 执行 Learning 公共入口） ──
  | "companion_action";

/** 任务 → 所需能力映射 */
const TASK_CAPABILITY_MAP: Record<AITaskType, Capability> = {
  card_generation:    "agent_turn",
  text_extraction:     "agent_turn",
  deck_composition:    "agent_turn",
  grounding_critic:    "agent_turn",
  repair:              "agent_turn",
  evaluate_validation: "text_generation",
  generate_question:   "text_generation",
  evaluate_rubric:     "text_generation",
  companion_dialogue:  "text_generation",
  companion_action:    "text_generation",
  analyze_image:       "vision",
  embed:               "embedding",
  rerank:              "rerank",
  speech_recognition:  "speech_recognition",
  image_generation:    "image_generation",
};

/** 任务复杂度等级 — 用于路由决策 */
export type TaskComplexity = "high" | "medium" | "low";

const TASK_COMPLEXITY: Record<AITaskType, TaskComplexity> = {
  card_generation:    "high",
  text_extraction:     "high",
  deck_composition:    "medium",
  grounding_critic:    "medium",
  repair:              "medium",
  evaluate_validation: "low",
  generate_question:   "low",
  evaluate_rubric:     "low",
  analyze_image:       "medium",
  embed:               "low",
  rerank:              "low",
  speech_recognition:  "low",
  image_generation:    "medium",
  companion_dialogue:  "low",
  companion_action:    "low",
};

/** 任务 → 所需能力 */
export function getCapabilityForTask(task: AITaskType): Capability {
  return TASK_CAPABILITY_MAP[task];
}

/** 任务 → 复杂度 */
export function getTaskComplexity(task: AITaskType): TaskComplexity {
  return TASK_COMPLEXITY[task];
}

/**
 * Resolve the system-level provider type for a capability.
 *
 * Delegates to resolveSystemPlatform() which reads from config/ai-platforms.json
 * (if present) or falls back to legacy AI_PROVIDER_* env vars.
 *
 * This function returns just the provider type string (e.g., "dashscope",
 * "openai_compatible"). For the full config (apiKey, baseUrl, model, options),
 * use resolveSystemPlatform() from platform-config.ts.
 *
 * This function can be called in both API and worker processes.
 */
export function resolveSystemProviderForCapability(cap: Capability): string {
  const platform = resolveSystemPlatform(cap);
  return platform?.type ?? "mock";
}
