/**
 * P2-3：FAST_EXTRACT 执行器（中间确定性校验运行时编排）。
 *
 * 流程（§3.1 失败分类）：
 * 1. 调用 provider 获取输出（零冗余 JSON 约束）
 * 2. 解析 FastExtractionArtifact（容错提取 JSON）
 * 3. validateFastExtractionArtifact 确定性校验
 * 4. 失败分类：
 *    - retryable（schema/allowlist/Bundle 覆盖/截断/悬空引用）→ 重试 ≤2 次（共 ≤3 次）
 *    - escalate（复杂语义:代码/公式类型不一致）→ 立即升级 Full
 * 5. 全部重试仍失败 → escalate_to_full（保留 issues 供诊断）
 *
 * P2-1 只统计不切换:本执行器为独立组件,Router 未路由到 fast_extract 前不被调用。
 */

import { validateFastExtractionArtifact, type FastExtractionValidationContext } from "./fast-extraction-validator.ts";
import { logger } from "../lib/logger.ts";

/** Provider turn 执行依赖(注入,便于单测) */
export interface FastExtractProviderTurn {
  executeProviderTurn(input: { systemPrompt: string; userMessage: string }): Promise<{
    content: string;
    finishReason: string;
  }>;
}

export interface FastExtractRunInput {
  systemPrompt: string;
  userMessage: string;
  validationContext: FastExtractionValidationContext;
}

export type FastExtractAction =
  | { kind: "proceed"; artifact: unknown; attemptCount: number }
  | { kind: "escalate_to_full"; attemptCount: number; issues: string[] };

export interface FastExtractRunResult {
  action: FastExtractAction;
  /** 每次尝试的校验问题(诊断) */
  attemptLog: Array<{ attempt: number; issues: string[] }>;
}

const MAX_ATTEMPTS = 3; // 1 初试 + 2 重试

/**
 * 容错提取 JSON 对象:模型输出可能带 markdown 围栏/前后说明,提取首个 {...} 块。
 * 提取失败返回 null(归 retryable schema_invalid)。
 */
export function extractJsonObject(raw: string): unknown | null {
  // 去 markdown 围栏
  const withoutFence = raw.replace(/```(?:json)?/g, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 执行 FAST_EXTRACT(含重试/升级编排)。
 */
export async function runFastExtract(
  deps: FastExtractProviderTurn,
  input: FastExtractRunInput,
): Promise<FastExtractRunResult> {
  const attemptLog: Array<{ attempt: number; issues: string[] }> = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const providerOut = await deps.executeProviderTurn({
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
    });

    // 输出截断是 retryable 信号,合并进校验上下文
    const parsed = extractJsonObject(providerOut.content);
    const validation = validateFastExtractionArtifact(parsed, {
      ...input.validationContext,
      finishReason: providerOut.finishReason,
    });

    // nit(review):attemptLog 与 escalate 返回统一记录 issue code(不含 severity)
    const issueCodes = validation.issues.map((i) => i.code);
    attemptLog.push({ attempt, issues: issueCodes });

    if (validation.passed && parsed != null) {
      logger.info({ attempt, retries: attempt - 1 }, "FAST_EXTRACT 校验通过");
      return {
        action: { kind: "proceed", artifact: parsed, attemptCount: attempt },
        attemptLog,
      };
    }

    // 升级判定:任何 escalate(复杂语义)立即升级,不再重试
    const hasEscalate = validation.issues.some((i) => i.severity === "escalate");
    if (hasEscalate) {
      logger.warn({ attempt, issues: issueCodes }, "FAST_EXTRACT 复杂语义错误,升级 Full");
      return {
        action: {
          kind: "escalate_to_full",
          attemptCount: attempt,
          issues: issueCodes,
        },
        attemptLog,
      };
    }

    logger.warn(
      { attempt, retriesRemaining: MAX_ATTEMPTS - attempt, issues: issueCodes },
      "FAST_EXTRACT 校验未通过(可重试)",
    );
  }

  // 全部重试仍失败 → 升级 Full(保留 issues)
  const lastIssues = attemptLog[attemptLog.length - 1]?.issues ?? [];
  logger.warn({ issues: lastIssues }, "FAST_EXTRACT 重试耗尽,升级 Full");
  return {
    action: { kind: "escalate_to_full", attemptCount: MAX_ATTEMPTS, issues: lastIssues },
    attemptLog,
  };
}
