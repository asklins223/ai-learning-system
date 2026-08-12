/**
 * Grounding Critic 强制独立审查 Agent（计划 §4.6, §W5）
 *
 * 职责：
 * - 逐 claim 验证草稿的支撑情况
 * - 检查 claim-evidence 语义支撑
 * - 检查 direct/composed evidence 是否充分
 * - 检查矛盾和错误 merge
 * - 检查重要概念遗漏和 section survival
 * - 检查跨卡重复、卡内内聚、overview 代表性
 * - 检查 title/summary 是否准确并有 support IDs
 * - 检查 density/card budget 是否合理
 *
 * 不变量（G7, §4.6）：
 * - 每个最终 Draft 必须经过独立 Grounding Critic
 * - Supervisor 不能自己写 supported verdict，也不能跳过 Critic
 * - Repair 后必须针对新 draftHash 再跑一次 Critic
 * - Critic 独立于 Supervisor，不受其意图影响
 */

import type {
  AgentTurnResult,
  QualityReport,
  CriticIssue,
  CriticClaimVerdict,
  SupportVerdict,
  CriticIssueSeverity,
} from "@ailearn/shared";
import {
  CRITIC_VERSION,
  VERIFIER_VERSION,
} from "@ailearn/shared";
import type { AgentRuntime } from "./runtime.ts";
import { initAgentTurn, handleTurnFailure, maybeReThrowRetryableProviderError } from "./runtime.ts";
import type { AgentSession } from "./session.ts";
import type { BudgetTracker } from "./budget.ts";
import type { ContextBuilder } from "./context-builder.ts";
import { buildCriticSystemPrompt } from "./roles/supervisor-policy.ts";
import { logger } from "../lib/logger.ts";

/** Critic 执行配置 */
export interface CriticConfig {
  /** 运行 ID */
  runId: string;
  /** Agent unit ID */
  agentUnitId: string;
  /** 要审查的 draft hash */
  draftHash: string;
  /** 候选池 hash */
  candidatePoolHash: string;
  /** 来源账本 hash */
  sourceLedgerHash: string;
}

/** Critic turn 结果 */
export interface CriticTurnOutcome {
  /** 状态 */
  state: "running" | "completed" | "failed";
  /** Quality Report（如果提交了） */
  report: QualityReport | null;
  /** 错误信息 */
  error?: string;
}

/**
 * 执行一次 Critic turn。
 *
 * Critic 是独立的只读 Agent，逐 claim 验证支撑情况。
 * 只能读取 Draft、候选和 exact evidence，提交 Quality Report。
 */
export async function executeCriticTurn(
  runtime: AgentRuntime,
  session: AgentSession,
  budgetTracker: BudgetTracker,
  contextBuilder: ContextBuilder,
  config: CriticConfig,
  draftContent: string,
  candidatesContent: string,
  evidenceContent: string,
  signal?: AbortSignal,
): Promise<CriticTurnOutcome> {
  const role = "grounding_critic";

  // QUAL-35: 使用共享的初始化函数替代重复的 3 步初始化
  const turnCtx = initAgentTurn(session, budgetTracker, config, role);

  const systemPrompt = buildCriticSystemPrompt();

  let result: AgentTurnResult;
  try {
    // v3: 通过 ContextBuilder 统一打包，自动压缩超限数据
    const turnRequest = contextBuilder.buildCriticTurn(
      role,
      { draftHash: config.draftHash },
      draftContent,
      candidatesContent,
      evidenceContent,
      systemPrompt,
    );

    // 补充操作指引到消息内容末尾
    const trailingInstructions = [
      "",
      "以上是所有审查数据。",
      "",
      "现在请执行以下操作：",
      "1. 逐个检查 Draft 中每张卡片引用的候选，验证其证据是否充分支撑 claim。",
      "2. 调用 submit_quality_report，提交 Quality Report。",
      "   - 对每个候选给出 verdict（supported/partial/unsupported/contradicted）。",
      "   - 如果全部 supported，criticStatus 设为 \"passed\"；否则设为 \"failed\"。",
      "   - hardIssues 中列出必须修复的问题（如 unsupported/contradicted claims）。",
      "3. 调用 complete_agent_task 完成任务。",
    ].join("\n");

    const lastMessage = turnRequest.messages[turnRequest.messages.length - 1]!;
    turnRequest.messages = [
      ...turnRequest.messages.slice(0, -1),
      {
        ...lastMessage,
        content: (typeof lastMessage.content === "string" ? lastMessage.content : "") + "\n" + trailingInstructions,
      },
    ];

    logger.debug(
      { runId: config.runId, draftHash: config.draftHash, turnNo: turnCtx.turnNo },
      "Critic turn 开始",
    );

    result = await runtime.executeTurn(turnRequest, turnCtx, signal);
  } catch (err) {
    // QUAL-35: 使用共享的错误处理函数
    // P1-08: InputOverContextError 也会在此被捕获
    // BUG-94: 可重试 provider 错误（502/429/408/5xx）re-throw，走队列重投
    maybeReThrowRetryableProviderError(err);
    handleTurnFailure(budgetTracker, session, role);
    return {
      state: "failed",
      report: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  budgetTracker.settleProviderCall(role, result.usage);
  session.recordProviderCall(result.usage, result.providerRequestId);

  // 解析结果
  const outcome = parseCriticResult(result, config);

  // 如果调用了 complete_agent_task，标记完成
  const hasComplete = result.toolCalls.some((c) => c.name === "complete_agent_task");
  if (hasComplete) {
    session.complete();
    outcome.state = "completed";
  }

  logger.debug(
    {
      runId: config.runId,
      draftHash: config.draftHash,
      hasReport: outcome.report !== null,
      hardIssues: outcome.report?.hardIssues.length ?? 0,
      softIssues: outcome.report?.softIssues.length ?? 0,
    },
    "Critic turn 完成",
  );

  return outcome;
}

/**
 * 解析 Critic 的 turn 结果。
 */
function parseCriticResult(
  result: AgentTurnResult,
  config: CriticConfig,
): CriticTurnOutcome {
  for (const call of result.toolCalls) {
    if (call.name === "submit_quality_report") {
      const args = call.arguments as Record<string, unknown>;
      const reportData = args.report as Record<string, unknown> | undefined;

      if (reportData) {
        const report = buildQualityReport(reportData, config);
        return {
          state: "running",
          report,
        };
      }
    }
  }

  return {
    state: "running",
    report: null,
  };
}

/**
 * 从模型输出构建 QualityReport。
 *
 * P0-02 修复（2026-08-03）：
 * - 空 perClaimVerdicts 时 criticStatus 设为 "failed"，不再自动通过。
 * - 确保只有模型实际提交了 verdict 的报告才能 passed。
 * - 空报告、空 verdict 一律 hard fail。
 */
function buildQualityReport(
  data: Record<string, unknown>,
  config: CriticConfig,
): QualityReport {
  const hardIssues = parseIssues(data.hardIssues, "hard");
  const softIssues = parseIssues(data.softIssues, "soft");
  const perClaimVerdicts = parseClaimVerdicts(data.perClaimVerdicts);

  // P0-02 修复：空 verdict 不得自动通过。
  // 原代码只检查 hardIssues.length > 0，空 verdict 时 criticStatus="passed"。
  // 这导致 5/5 真实 Provider run 的空 verdict 报告都被当作通过。
  // 修复后：perClaimVerdicts 为空时 criticStatus="failed"，
  // 并添加 hard issue 标记协议失败。
  const hasHardIssues = hardIssues.length > 0;
  const hasEmptyVerdicts = perClaimVerdicts.length === 0;
  const criticStatus = (hasHardIssues || hasEmptyVerdicts) ? "failed" : "passed";

  // 如果 verdict 为空，添加 hard issue 以便诊断
  const effectiveHardIssues = hasEmptyVerdicts
    ? [...hardIssues, {
        code: "empty_verdicts",
        severity: "hard" as const,
        candidateId: undefined,
        cardDraftId: undefined,
        evidenceRefIds: [],
        verdict: undefined,
        patchable: false,
      }]
    : hardIssues;

  return {
    draftHash: config.draftHash,
    candidatePoolHash: config.candidatePoolHash,
    sourceLedgerHash: config.sourceLedgerHash,
    criticVersion: CRITIC_VERSION,
    verifierVersion: VERIFIER_VERSION,
    hardIssues: effectiveHardIssues,
    softIssues,
    perClaimVerdicts,
    metrics: (data.metrics as Record<string, unknown>) ?? {},
    criticStatus,
    deterministicStatus: "pending",
  };
}

/** 解析 issues */
function parseIssues(
  raw: unknown,
  defaultSeverity: CriticIssueSeverity,
): CriticIssue[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((item) => ({
    code: String(item.code ?? "unknown"),
    severity: (item.severity as CriticIssueSeverity) ?? defaultSeverity,
    candidateId: item.candidateId ? String(item.candidateId) : undefined,
    cardDraftId: item.cardDraftId ? String(item.cardDraftId) : undefined,
    evidenceRefIds: Array.isArray(item.evidenceRefIds)
      ? (item.evidenceRefIds as string[])
      : [],
    verdict: item.verdict as SupportVerdict | undefined,
    patchable: Boolean(item.patchable ?? false),
  }));
}

/** 解析 claim verdicts */
function parseClaimVerdicts(raw: unknown): CriticClaimVerdict[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((item) => ({
    candidateId: String(item.candidateId ?? ""),
    verdict: item.verdict as SupportVerdict,
    supportingEvidenceRefIds: Array.isArray(item.supportingEvidenceRefIds)
      ? (item.supportingEvidenceRefIds as string[])
      : [],
    reasonCode: String(item.reasonCode ?? ""),
  }));
}

/**
 * 判断 Critic 是否通过。
 *
 * P0-02 修复（2026-08-03）：判定语义（perClaimVerdicts 非空、无 auto_verified、
 * 无 hard issues、criticStatus === passed）已内联于 publish.ts 的发布门禁
 * （P0-03，且更完整——含 partial/unsupported/contradicted 阻断）。此函数零引用，
 * 2026-08-11 删除，避免双标准漂移。
 */

/**
 * 获取可修复的 hard issues。
 */
export function getPatchableHardIssues(report: QualityReport): CriticIssue[] {
  return report.hardIssues.filter((issue) => issue.patchable);
}
