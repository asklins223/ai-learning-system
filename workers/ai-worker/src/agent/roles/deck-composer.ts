/**
 * Deck Composer 专家 Agent（计划 §4.5, §6.3, §W4）
 *
 * 可选专家，提出 canonical merge/importance/grouping。
 *
 * 职责：
 * - 读取 Candidate Ledger
 * - 从全局视角提出 Deck 组织方案
 * - 提交 deck proposal（Supervisor 接受或调整）
 *
 * 不变量（§6.3）：
 * - 只读 Candidate Ledger，不能修改
 * - 只能提交 deck proposal，不能直接写 Draft
 * - 不能 delegate 或请求 Verify/Publish
 */

import type { AgentTurnResult } from "@ailearn/shared";
import type { AgentRuntime } from "../runtime.ts";
import { initAgentTurn, handleTurnFailure, maybeReThrowRetryableProviderError } from "../runtime.ts";
import type { AgentSession } from "../session.ts";
import type { BudgetTracker } from "../budget.ts";
import type { ContextBuilder } from "../context-builder.ts";
import { buildDeckComposerSystemPrompt } from "./supervisor-policy.ts";
import { logger } from "../../lib/logger.ts";

/** Deck Composer 执行配置 */
export interface DeckComposerConfig {
  /** 运行 ID */
  runId: string;
  /** Agent unit ID */
  agentUnitId: string;
  /** 密度 */
  density: "overview" | "standard" | "complete";
  /** 卡片预算 */
  cardBudget: number;
}

/** Deck proposal */
export interface DeckProposal {
  /** Deck 标题 */
  deckTitle: string;
  /** Deck 摘要 */
  deckSummary: string;
  /** 卡片列表 */
  cards: Array<{
    draftCardId: string;
    canonicalCandidateIds: string[];
    title: string;
    summary: string;
    ordinal: number;
    primarySection: string;
    groupKey?: string;
  }>;
}

/** Deck Composer turn 结果 */
export interface DeckComposerTurnOutcome {
  /** 状态 */
  state: "running" | "completed" | "failed";
  /** 提交的 deck proposal */
  proposal: DeckProposal | null;
  /** 错误信息 */
  error?: string;
}

/**
 * 执行一次 Deck Composer turn。
 *
 * v3 优化：通过 ContextBuilder.buildDeckComposerTurn 接入 ContextPacker，
 * 候选数据超限时自动压缩，不再裸拼接。
 */
export async function executeDeckComposerTurn(
  runtime: AgentRuntime,
  session: AgentSession,
  budgetTracker: BudgetTracker,
  contextBuilder: ContextBuilder,
  config: DeckComposerConfig,
  candidateSummary: string,
  signal?: AbortSignal,
): Promise<DeckComposerTurnOutcome> {
  const role = "deck_composer" as const;

  // QUAL-35: 使用共享的初始化函数替代重复的 3 步初始化
  const turnCtx = initAgentTurn(session, budgetTracker, config, role);

  const systemPrompt = buildDeckComposerSystemPrompt();

  let result: AgentTurnResult;
  try {
    // v3: 通过 ContextBuilder 统一打包，自动压缩超限数据
    const turnRequest = contextBuilder.buildDeckComposerTurn(
      role,
      { density: config.density, cardBudget: config.cardBudget },
      candidateSummary,
      systemPrompt,
    );

    // 补充操作指引到消息内容末尾
    const trailingInstructions = [
      "",
      "以上是所有候选数据。",
      "",
      "现在请执行以下操作：",
      "1. 分析候选，根据密度决定卡片数量，将相关候选组织到同一张卡片中。",
      "2. 调用 submit_deck_proposal，提交 Deck 方案。",
      "   - proposal.cards 中每张卡的 canonicalCandidateIds 使用上面数据中的候选 id。",
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
      { runId: config.runId, turnNo: turnCtx.turnNo },
      "Deck Composer turn 开始",
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
      proposal: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  budgetTracker.settleProviderCall(role, result.usage);
  session.recordProviderCall(result.usage, result.providerRequestId);

  // 解析结果
  const outcome = parseComposerResult(result);

  // 如果调用了 complete_agent_task，标记完成
  const hasComplete = result.toolCalls.some((c) => c.name === "complete_agent_task");
  if (hasComplete) {
    session.complete();
    outcome.state = "completed";
  }

  logger.debug(
    { runId: config.runId, turnNo: turnCtx.turnNo, hasProposal: outcome.proposal !== null },
    "Deck Composer turn 完成",
  );

  return outcome;
}

/**
 * 解析 Deck Composer 的 turn 结果。
 */
function parseComposerResult(result: AgentTurnResult): DeckComposerTurnOutcome {
  for (const call of result.toolCalls) {
    if (call.name === "submit_deck_proposal") {
      const args = call.arguments as Record<string, unknown>;
      const proposal = args.proposal as Record<string, unknown> | undefined;

      if (proposal) {
        return {
          state: "running",
          proposal: {
            deckTitle: String(proposal.deckTitle ?? ""),
            deckSummary: String(proposal.deckSummary ?? ""),
            cards: Array.isArray(proposal.cards)
              ? (proposal.cards as Record<string, unknown>[]).map((c, index) => {
                  // 2026-08-11：ordinal 只接受有限数值——模型输出非法值
                  // （NaN/Infinity/非数值字符串）时回退到出现顺序 index，
                  // 避免 NaN 写进卡片排序导致 publish 后排序错乱。
                  const rawOrdinal = Number(c.ordinal ?? index);
                  return {
                    draftCardId: String(c.draftCardId ?? ""),
                    canonicalCandidateIds: Array.isArray(c.canonicalCandidateIds)
                      ? (c.canonicalCandidateIds as string[])
                      : [],
                    title: String(c.title ?? ""),
                    summary: String(c.summary ?? ""),
                    ordinal: Number.isFinite(rawOrdinal) ? rawOrdinal : index,
                    primarySection: String(c.primarySection ?? ""),
                    groupKey: c.groupKey ? String(c.groupKey) : undefined,
                  };
                })
              : [],
          },
        };
      }
    }
  }

  return {
    state: "running",
    proposal: null,
  };
}
