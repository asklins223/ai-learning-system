/**
 * Tool 执行层入口（计划 §6, §16.1）
 *
 * 这是 Supervisor 和 specialist Agent tool calls 的统一执行入口。
 * 当 Agent turn 返回 tool calls 时，由 Handler 调用此模块执行副作用。
 *
 * 职责：
 * - 按 role allowlist 验证工具权限
 * - 幂等执行工具副作用
 * - 返回工具结果供下一 turn 使用
 * - 不变量：一次 toolCallId 最多执行一次副作用
 *
 * 不变量（G5, G6, §6.4, §6.5）：
 * - child Agent depth=1，不能继续 delegate
 * - 任意 SQL/HTTP/shell/文件系统/插件被明确禁止
 * - 工具幂等键：SHA256(runId | agentUnitId | turnNo | toolCallId | toolName | argsHash)
 */

export { executeToolCall, type ToolExecutionContext, type ToolCallRequest, type ToolCallResult } from "./executor.ts";
export * from "./manifest.ts";
export * from "./delegation.ts";
export * from "./evidence.ts";
export * from "./candidate-ledger.ts";
export * from "./deck-draft.ts";
export * from "./quality.ts";
