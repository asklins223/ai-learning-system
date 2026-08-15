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
import { resolveSystemPlatform } from "./platform-config-node.ts";

/** AI 任务类型 — 可扩展 */
export type AITaskType =
  // ── 卡片生成 Agent ──
  | "card_generation"       // Supervisor Agent（高复杂度）
  | "text_extraction"      // Text/Code Extractor（高复杂度）
  | "deck_composition"     // Deck Composer（中复杂度）
  | "grounding_critic"     // Grounding Critic（中复杂度）
  | "repair"               // Repairer（中复杂度）
  // ── 验证评估 ──
  | "evaluate_validation"  // 验证评估（影响深→agent_turn）
  | "generate_question"    // 题目生成（影响深→agent_turn）
  | "evaluate_rubric"      // 评分（影响深→agent_turn）
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

/**
 * 模型槽位语义（2026-08-13 按"用户体验"分级，而非任务复杂度）：
 *
 * 分级原则：**任何用户直接可见、或影响用户学习结论的任务 → agent_turn
 * （专业模型）**；text_generation（小模型槽）仅保留给**用户不可见的内部
 * 低影响任务**（当前无此类任务，槽位留空待用）。
 *
 * - agent_turn（专业模型，tokenrhythm + deepseek-v4-flash-0731）：
 *   卡片生成、文本抽取、卡组编排、证据批判、修复、**题目生成、
 *   验证/评估/评分（决定掌握度与复习调度）、日常对话、桌宠动作建议**——
 *   全部用户可见/影响结论，一律专业模型（体验优先）。
 * - text_generation（轻量槽，GLM-4-9B 小模型）：
 *   **仅限用户不可见的内部辅助任务**（如日志/元数据分类）；质量不足以
 *   面向用户，当前无任务分配至此。
 * - vision / embedding / rerank：各自专用能力。
 */
const TASK_CAPABILITY_MAP: Record<AITaskType, Capability> = {
  card_generation:    "agent_turn",
  text_extraction:     "agent_turn",
  deck_composition:    "agent_turn",
  grounding_critic:    "agent_turn",
  repair:              "agent_turn",
  // 2026-08-13（模型分级）：题目生成与评估对用户学习结论影响深——
  // 一律 agent_turn（专业模型），不用小模型降级体验。
  evaluate_validation: "agent_turn",
  generate_question:   "agent_turn",
  evaluate_rubric:     "agent_turn",
  companion_dialogue:  "agent_turn",
  // 桌宠动作建议是用户直接可见的文案——体验优先，专业模型。
  companion_action:    "agent_turn",
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
