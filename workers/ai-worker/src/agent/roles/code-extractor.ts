/**
 * Code Extractor 专家 Agent（计划 §4.4, §W4）
 *
 * 保留命令、运算符、数值、单位、边界条件。
 *
 * 与 Text Extractor 的区别：
 * - 更关注代码语法、命令参数、运算符语义
 * - 保留数值和单位的精确性
 * - 识别边界条件和异常处理
 * - cognitiveType 更偏向 boundary 和 procedure
 */

import type { AgentRole } from "@ailearn/shared";
import { executeExtractorTurn, type ExtractorConfig, type ExtractorTurnOutcome } from "./text-extractor.ts";

/**
 * 执行一次 Code Extractor turn。
 *
 * 复用通用 Extractor 逻辑，角色为 code_extractor。
 * 系统 prompt 由 buildExtractorSystemPrompt("code_extractor") 生成。
 */
export async function executeCodeExtractorTurn(
  runtime: import("../runtime.ts").AgentRuntime,
  session: import("../session.ts").AgentSession,
  budgetTracker: import("../budget.ts").BudgetTracker,
  contextBuilder: import("../context-builder.ts").ContextBuilder,
  config: Omit<ExtractorConfig, "role">,
  assignedBundles: Array<{
    bundleId: string;
    sectionPath: string[];
    evidenceUnits: Array<{
      refId: string;
      kind: string;
      text: string;
      contextOnly: boolean;
    }>;
  }>,
  signal?: AbortSignal,
): Promise<ExtractorTurnOutcome> {
  return executeExtractorTurn(
    runtime,
    session,
    budgetTracker,
    contextBuilder,
    { ...config, role: "code_extractor" as AgentRole },
    assignedBundles,
    signal,
  );
}
