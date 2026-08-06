/**
 * Supervisor Agent 统一入口（计划 §16.1）
 *
 * 此文件是计划 §16.1 要求的 `agent/supervisor.ts` 文件。
 * Supervisor 逻辑拆分为 supervisor-loop（turn 执行 + 状态机）和
 * supervisor-policy（system prompt），通过此文件统一导出。
 */

export {
  executeSupervisorTurn,
  shouldContinueLoop,
  notifyChildCompleted,
  type SupervisorLoopConfig,
  type SupervisorLoopContext,
  type SupervisorLoopState,
  type SupervisorTurnOutcome,
  type SupervisorNextAction,
} from "./roles/supervisor-loop.ts";

export {
  buildSupervisorSystemPrompt,
} from "./roles/supervisor-policy.ts";
