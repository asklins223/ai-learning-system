/**
 * AI Prompt 定义 — 从 @ailearn/shared/prompts 重新导出。
 *
 * 单一来源在 packages/shared/src/prompts.ts，确保 worker 和 ai-quality
 * RC 门禁使用完全相同的 prompt。
 *
 * Prompt 版本历史：
 *   v1: 基础提取 prompt，质量指引不足
 *   v2: 增加 claim 质量标准、层级示例、summary 结构指引，
 *       key_points 上限从 8 降至 5，提高单点质量
 */

export {
  IMAGE_UNDERSTANDING_SYSTEM_PROMPT,
  EVAL_SYSTEM_PROMPT,
  QUESTION_GENERATION_PROMPT,
  RUBRIC_EVALUATION_PROMPT,
} from "@ailearn/shared/prompts";
