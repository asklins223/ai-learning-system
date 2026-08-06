/**
 * Supervisor 主循环（计划 §5, §W4）
 *
 * Supervisor 是有界、可恢复的 Agent loop。
 * 每个 turn 从 manifest、ledger、task results 和 event summary 重建上下文。
 *
 * 循环流程（计划 §5）：
 * 1. 读取目标、manifest、预算
 * 2. 顺序领取未处理 Source Bundles
 * 3. 按内容委派 Text / Code / Vision Extractors
 * 4. 汇总 Candidate Ledger 与 Coverage Ledger
 * 5. 判断是否需要补查、合并或更深处理
 * 6. 组织 Deck，或调用 Deck Composer
 * 7. 强制调用独立 Grounding Critic
 * 8. 如果有可修复 hard issue 且 repairCount=0，调用 Repairer 或应用 typed patch
 * 9. 修复后重新调用 Critic
 * 10. 如果 Critic 通过，调用 deterministic preflight
 * 11. 如果预检通过，提交 immutable Draft 并请求 VERIFY
 *
 * 不变量（G5, G7, G9）：
 * - Supervisor 可以选择专家、顺序、批次，但不能修改 coverage/tool/budget/gate
 * - 每个最终 Draft 必须经过独立 Grounding Critic
 * - Agent 只写 staging，Canonical Card Set 只能由 deterministic Publish 写入
 */

import type {
  AgentTurnResult,
  RunBudget,
  ProviderCapability,
} from "@ailearn/shared";
import type { AgentRuntime, AgentTurnContext } from "../runtime.ts";
import { maybeReThrowRetryableProviderError } from "../runtime.ts";
import type { AgentSession } from "../session.ts";
import type { BudgetTracker } from "../budget.ts";
import type { ContextBuilder, ContextBuilderInput } from "../context-builder.ts";
import type { CoverageLedger } from "../coverage-ledger.ts";
import type { CandidateLedger } from "../candidate-ledger.ts";
import { buildSupervisorSystemPrompt } from "./supervisor-policy.ts";
import { logger } from "../../lib/logger.ts";

/** Supervisor 循环配置 */
export interface SupervisorLoopConfig {
  /** 运行 ID */
  runId: string;
  /** Agent unit ID */
  agentUnitId: string;
  /** 工作区 ID */
  workspaceId: string;
  /** noteVersion ID */
  noteVersionId: string;
  /** 笔记标题 */
  noteTitle: string;
  /** 密度 */
  density: "overview" | "standard" | "complete";
  /** 预算 */
  budget: RunBudget;
  /** Provider 能力 */
  providerCapability: ProviderCapability;
  /**
   * E2 阶段二（计划 §2.9）：反馈摘要补充段。
   * 从 run 的 providerSnapshot.feedbackSummary 读取。
   * 当 isFeedbackRegenerationEnabled() 为 true 时注入到 system prompt。
   */
  feedbackSummary?: string;
}

/** Supervisor 循环状态 */
export type SupervisorLoopState =
  | "init"
  | "reading_manifest"
  | "fetching_bundles"
  | "delegating"
  | "waiting_children"
  | "processing_results"
  | "organizing_deck"
  | "requesting_critic"
  | "waiting_critic"
  | "repairing"
  | "waiting_repair"
  | "validating"
  | "requesting_verify"
  | "completed"
  | "failed"
  | "needs_attention";

/** Supervisor 循环上下文 */
export interface SupervisorLoopContext {
  /** Runtime */
  runtime: AgentRuntime;
  /** Session */
  session: AgentSession;
  /** Budget tracker */
  budgetTracker: BudgetTracker;
  /** Context builder */
  contextBuilder: ContextBuilder;
  /** Coverage ledger */
  coverageLedger: CoverageLedger;
  /** Candidate ledger */
  candidateLedger: CandidateLedger;
  /** 循环状态 */
  state: SupervisorLoopState;
  /** 当前 turn 编号 */
  turnNo: number;
  /** 已委派的子任务 IDs */
  delegatedTaskIds: string[];
  /** 已完成的子任务 IDs */
  completedTaskIds: string[];
  /** 当前 Draft hash（如果有） */
  currentDraftHash: string | null;
  /** Critic report hash（如果有） */
  criticReportHash: string | null;
  /** 修复次数 */
  repairCount: number;
}

/**
 * 执行一次 Supervisor turn。
 *
 * 一个 turn 对应一次 provider 请求。
 * turn 结束后根据结果决定下一步：
 * - 如果模型请求了更多判断，创建下一 turn job
 * - 如果模型在等待 child task，当前 turn 正常结束
 * - child task 完成后由 scheduler 恢复 Supervisor
 */
export async function executeSupervisorTurn(
  ctx: SupervisorLoopContext,
  config: SupervisorLoopConfig,
  contextInput: ContextBuilderInput,
  signal?: AbortSignal,
): Promise<SupervisorTurnOutcome> {
  const { runtime, session, budgetTracker } = ctx;

  // 开始新 turn
  session.startTurn();
  ctx.turnNo = session.getState().turnNo;

  logger.debug(
    { runId: config.runId, turnNo: ctx.turnNo, state: ctx.state },
    "Supervisor turn 开始",
  );

  // 预留 turn 和 provider call
  budgetTracker.reserveTurn("generation_supervisor");
  budgetTracker.reserveProviderCall("generation_supervisor");

  // 构建系统 prompt
  const systemPrompt = buildSupervisorSystemPrompt({
    density: config.density,
    noteTitle: config.noteTitle,
    budgetSummary: formatBudgetSummary(budgetTracker),
    ...(config.feedbackSummary ? { feedbackSummary: config.feedbackSummary } : {}),
  });

  // 执行上下文：构建上下文消息 + provider 请求
  const turnCtx: AgentTurnContext = {
    runId: config.runId,
    agentUnitId: config.agentUnitId,
    turnNo: ctx.turnNo,
    attemptNo: session.getState().attemptNo,
    role: "generation_supervisor",
  };

  session.startAttempt();

  let result: AgentTurnResult;
  try {
    // P1-08: buildSupervisorTurn 超限时可能抛出 InputOverContextError
    const turnRequest = ctx.contextBuilder.buildSupervisorTurn(contextInput, systemPrompt);

    result = await runtime.executeTurn(turnRequest, turnCtx, signal);
  } catch (err) {
    // BUG-94 修复：可重试 provider 错误（502/429/408/5xx）re-throw，
    // 让外层 handler 标记 unit retryable_failed + 队列重投，
    // 而不是吞掉转成 needs_attention 终态。
    maybeReThrowRetryableProviderError(err);
    budgetTracker.settleProviderCall("generation_supervisor", null);
    session.fail();
    ctx.state = "failed";
    return {
      state: "failed",
      toolCalls: [],
      content: null,
      nextAction: "retry_or_fail",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 结算 provider call
  budgetTracker.settleProviderCall("generation_supervisor", result.usage);
  session.recordProviderCall(result.usage, result.providerRequestId);

  // 解析结果
  const outcome = analyzeTurnResult(result, ctx);

  logger.debug(
    {
      runId: config.runId,
      turnNo: ctx.turnNo,
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls.length,
      nextState: outcome.state,
    },
    "Supervisor turn 完成",
  );

  return outcome;
}

/** Supervisor turn 的结果分析 */
export interface SupervisorTurnOutcome {
  /** 下一个循环状态 */
  state: SupervisorLoopState;
  /** 模型请求的工具调用 */
  toolCalls: AgentTurnResult["toolCalls"];
  /** 模型的自由文本输出 */
  content: string | null;
  /** 下一步动作 */
  nextAction: SupervisorNextAction;
  /** 错误信息（如果失败） */
  error?: string;
}

/** Supervisor 下一步动作 */
export type SupervisorNextAction =
  | "continue"           // 继续下一个 turn
  | "wait_for_children"  // 等待子任务完成
  | "retry_or_fail"      // 重试或失败
  | "complete"           // Supervisor 完成
  | "needs_attention";   // 需要人工介入

/**
 * 分析 turn 结果，决定下一步。
 */
function analyzeTurnResult(
  result: AgentTurnResult,
  ctx: SupervisorLoopContext,
): SupervisorTurnOutcome {
  const { toolCalls, content, finishReason } = result;

  // 如果没有工具调用且 finishReason 是 stop，可能模型认为完成了
  if (toolCalls.length === 0 && finishReason === "stop") {
    // 模型没有调用工具就停止了，可能需要 attention
    ctx.state = "needs_attention";
    return {
      state: "needs_attention",
      toolCalls: [],
      content,
      nextAction: "needs_attention",
      error: "Supervisor 在没有调用工具的情况下停止",
    };
  }

  // 解析工具调用，确定下一个状态
  let nextState: SupervisorLoopState = ctx.state;

  for (const call of toolCalls) {
    switch (call.name) {
      case "get_run_manifest":
        nextState = "reading_manifest";
        break;
      case "get_next_unassigned_bundles":
        nextState = "fetching_bundles";
        break;
      case "delegate_specialist":
        nextState = "delegating";
        break;
      case "read_agent_task_results":
        nextState = "processing_results";
        break;
      case "apply_candidate_operations":
        nextState = "processing_results";
        break;
      case "submit_deck_draft":
        nextState = "organizing_deck";
        break;
      case "request_grounding_review":
        nextState = "requesting_critic";
        break;
      case "read_quality_report":
        nextState = "waiting_critic";
        break;
      case "request_repair":
        nextState = "repairing";
        ctx.repairCount += 1;
        break;
      case "apply_draft_patch":
        // BUG-19: apply_draft_patch 是同步修复操作，应递增 repairCount，
        // 防止 Supervisor 先调用 apply_draft_patch 再调用 request_repair
        // 时 repairCount 仍为 0，绕过"整 run 最多一次 Repair"的限制。
        nextState = "repairing";
        ctx.repairCount += 1;
        break;
      case "validate_draft":
        nextState = "validating";
        break;
      case "request_verification":
        nextState = "requesting_verify";
        break;
      default:
        // 未知工具调用，记录但不改变状态
        break;
    }
  }

  // 如果有 delegate_specialist 或 request_grounding_review 或 request_repair，
  // 需要等待子任务完成。
  // 修复：原代码只检查 delegate_specialist，不检查 request_grounding_review 和 request_repair。
  // 这导致 Supervisor 在调用 request_grounding_review 后不等待 Critic 完成，
  // 而是立即创建下一 turn 读取 quality report。但 Critic 是异步子任务，
  // report 尚未生成（status=pending），Supervisor 反复读取 pending report，
  // 陷入 read_quality_report 循环，最终预算耗尽。
  // 修复后：所有创建异步子任务的工具都触发 wait_for_children。
  const hasAsyncChild = toolCalls.some((c) =>
    c.name === "delegate_specialist"
    || c.name === "request_grounding_review"
    || c.name === "request_repair"
  );
  if (hasAsyncChild) {
    nextState = "waiting_children";
    ctx.state = nextState;
    return {
      state: nextState,
      toolCalls,
      content,
      nextAction: "wait_for_children",
    };
  }

  // 如果请求了 verification，Supervisor 意图完成。
  // R43 修复：不在 analyzeTurnResult 中调用 session_complete(ctx)。
  // 原代码在分析模型输出的 tool calls 时就标记 session 为 COMPLETED，
  // 但此时工具尚未执行。Handler 的 R19 修复会在工具执行后检查
  // request_verification 是否成功，如果失败则将 nextAction 覆盖为 "continue"。
  // 但 session 已被标记为 COMPLETED，造成逻辑不一致。
  // 修复后：只设置 state 和 nextAction，session 完成由 Handler 在确认
  // 工具执行成功后处理。
  const hasVerification = toolCalls.some((c) => c.name === "request_verification");
  if (hasVerification) {
    nextState = "completed";
    ctx.state = nextState;
    return {
      state: nextState,
      toolCalls,
      content,
      nextAction: "complete",
    };
  }

  ctx.state = nextState;
  return {
    state: nextState,
    toolCalls,
    content,
    nextAction: "continue",
  };
}

/** 格式化预算摘要 */
function formatBudgetSummary(budgetTracker: BudgetTracker): string {
  const usage = budgetTracker.getUsage();
  const budget = budgetTracker.getBudget();
  return [
    `provider_calls: ${usage.providerCalls}/${budget.maxProviderCalls}`,
    `input_tokens: ${usage.inputTokens}/${budget.maxInputTokens}`,
    `output_tokens: ${usage.outputTokens}/${budget.maxOutputTokens}`,
    `deadline: ${budget.runDeadline}`,
  ].join(", ");
}

/**
 * 判断 Supervisor 是否应该继续循环。
 *
 * 停止条件：
 * - 状态为 completed/failed/needs_attention
 * - 预算耗尽
 * - 截止时间到达
 * - 最大 turn 数达到
 */
export function shouldContinueLoop(
  ctx: SupervisorLoopContext,
  budgetTracker: BudgetTracker,
): boolean {
  if (ctx.state === "completed" || ctx.state === "failed" || ctx.state === "needs_attention") {
    return false;
  }

  if (budgetTracker.isDeadlineExceeded()) {
    ctx.state = "needs_attention";
    return false;
  }

  if (!budgetTracker.canMakeProviderCall()) {
    ctx.state = "needs_attention";
    return false;
  }

  // BUG-93 修复：在创建新 turn job 之前预检 maxTurns，
  // 避免创建注定在 reserveTurn 阶段失败的 turn。
  if (budgetTracker.isRoleTurnsExhausted("generation_supervisor")) {
    ctx.state = "needs_attention";
    return false;
  }

  return true;
}

/**
 * 通知 Supervisor 子任务已完成。
 *
 * 当 scheduler 恢复 Supervisor 时调用。
 */
export function notifyChildCompleted(
  ctx: SupervisorLoopContext,
  taskId: string,
): void {
  ctx.session.notifyChildCompleted(taskId);
  ctx.completedTaskIds.push(taskId);

  // 如果所有子任务都完成了，恢复到运行状态
  if (ctx.session.isRunning()) {
    ctx.state = "processing_results";
  }
}
