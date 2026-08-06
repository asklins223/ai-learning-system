/**
 * Grounding Critic 角色（计划 §16.1）
 *
 * 此文件是计划 §16.1 要求的 `roles/grounding-critic.ts` 文件。
 * Critic 逻辑实现位于 `agent/critic.ts`，通过此文件统一导出。
 *
 * 计划 §4.6: Critic 是强制、只读、独立角色，逐 claim 输出支撑判定。
 */

export {
  executeCriticTurn,
  type CriticConfig,
  type CriticTurnOutcome,
} from "../critic.ts";
