/**
 * Vision Specialist 专家 Agent（计划 §4.5, §W4）
 *
 * 只读取 immutable image asset，生成 OCR/caption/region。
 *
 * 与 Text/Code Extractor 的区别：
 * - 只处理图片类型的 evidence
 * - 生成图片描述和结构化事实
 * - 识别表格、图表、流程图、公式等
 * - 图片内容标记为 untrusted source data
 */

import type { AgentRole } from "@ailearn/shared";
import { executeExtractorTurn, type ExtractorConfig, type ExtractorTurnOutcome } from "./text-extractor.ts";

/**
 * 执行一次 Vision Specialist turn。
 *
 * 复用通用 Extractor 逻辑，角色为 vision_specialist。
 * 系统 prompt 由 buildExtractorSystemPrompt("vision_specialist") 生成。
 */
export async function executeVisionSpecialistTurn(
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
    { ...config, role: "vision_specialist" as AgentRole },
    assignedBundles,
    signal,
  );
}
