/**
 * Agent Runtime（计划 §5.2, §8.1）
 *
 * 通用 Agent turn 执行引擎。
 * 一次 attempt 最多一次 provider 请求（计划 §5.3）。
 *
 * 执行顺序（计划 §5.2）：
 * 1. 短事务 claim job/unit，检查 lease、run、epoch、cancel、deadline 和预算
 * 2. 从 ledger/event/task results 重建当前 turn 消息
 * 3. 在事务外执行一次 provider 请求
 * 4. 严格解析 native tool call 或 structured_action_v1
 * 5. 重新检查 lease、epoch、cancel
 * 6. 在事务中 append event、幂等执行工具副作用、更新预算和 Agent Session
 * 7. 如果需要更多模型判断，创建下一 turn job
 * 8. 如果等待 child task，当前 turn 正常结束
 * 9. child task 完成后由 scheduler 恢复 Supervisor
 */

import type {
  AgentTurnRequest,
  AgentTurnResult,
  AgentRole,
  ProviderToolMode,
} from "@ailearn/shared";
import type { CapabilityBundle } from "../lib/capability-bundle.ts";
import { logger } from "../lib/logger.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { recordProviderTurnMetrics } from "../lib/metrics.ts";
import type { AgentSession } from "./session.ts";
import type { BudgetTracker } from "./budget.ts";
import { enforceRequestTokenBudget, InputOverContextError } from "./request-packer.ts";
import {
  classifyGenerationFailure,
  ProviderRequestError,
} from "../lib/generation-failure-policy.ts";

// ─── QUAL-35: 共享的 Agent turn 初始化和错误处理辅助函数 ────────────────
// 此前 text-extractor、deck-composer、critic、repairer 各自重复了
// 完全相同的 3 步初始化 + turnCtx 构建 + 错误清理逻辑。
// 现统一提取到此处，减少维护成本并确保一致性。

/**
 * 初始化 Agent turn：预留 turn 预算 + provider 调用预算，并开始 attempt。
 *
 * @param session      Agent 会话
 * @param budgetTracker 预算追踪器
 * @param role         当前角色
 * @returns 构建好的 AgentTurnContext
 */
export function initAgentTurn(
  session: AgentSession,
  budgetTracker: BudgetTracker,
  config: { runId: string; agentUnitId: string },
  role: AgentRole,
): AgentTurnContext {
  // 3 步初始化：start turn → reserve turn budget → reserve provider call budget
  session.startTurn();
  budgetTracker.reserveTurn(role);
  budgetTracker.reserveProviderCall(role);

  const state = session.getState();
  const turnCtx: AgentTurnContext = {
    runId: config.runId,
    agentUnitId: config.agentUnitId,
    turnNo: state.turnNo,
    attemptNo: state.attemptNo,
    role,
  };

  session.startAttempt();
  return turnCtx;
}

/**
 * Agent turn 执行失败时的清理逻辑：结算 provider 调用预算并标记会话失败。
 *
 * @param budgetTracker 预算追踪器
 * @param session      Agent 会话
 * @param role         当前角色
 */
export function handleTurnFailure(
  budgetTracker: BudgetTracker,
  session: AgentSession,
  role: AgentRole,
): void {
  budgetTracker.settleProviderCall(role, null);
  session.fail();
}

/**
 * 判断异常是否为可重试的 provider 错误，是则 re-throw。
 *
 * BUG-94 修复：各角色循环（supervisor/extractor/composer/critic/repair）的
 * catch 把 provider 异常吞掉转成 state:"failed"，最终被映射成 needs_attention
 * 终态。腾讯 MaaS 偶发 502 一次即永久杀死整个 run，无任何重试。
 *
 * 规则：
 * - ProviderRequestError 5xx/429/408 → re-throw（队列重投 backoff 2s/4s）
 * - ProviderRequestError 401/402/403/配置错误 → 不 re-throw（重试无意义）
 * - InputOverContextError → 不 re-throw（输入超限，重试同一输入仍超限）
 * - 其他非 Provider 异常 → 不 re-throw（维持现状，避免行为变更）
 */
export function maybeReThrowRetryableProviderError(err: unknown): void {
  if (err instanceof InputOverContextError) return;
  const policy = classifyGenerationFailure(err);
  if (policy.autoRetry && err instanceof ProviderRequestError) {
    throw err;
  }
}

/** Agent runtime 配置 */
export interface AgentRuntimeConfig {
  /**
   * R2: 能力束 — 按 capability 持有多个 provider 实例。
   * R5: bundle 是 AgentRuntime 获取 provider 的唯一路径。
   *   CompositeAIProvider 和 provider 字段已删除。
   */
  bundle: CapabilityBundle;
  /** 工具模式 */
  toolMode: ProviderToolMode;
  /** 最大重试次数（transport 层） */
  maxTransportRetries: number;
  /**
   * Provider 上下文窗口大小（token 数）。
   * P1-09：用于请求级 Token Hard Check。
   */
  contextWindowTokens: number;
  /**
   * 安全余量（token 数）。
   * P1-09：用于请求级 Token Hard Check。
   * 默认 2_048，与 ContextPacker 一致。
   */
  safetyMarginTokens?: number;
  /**
   * 单 turn 超时预算（毫秒）。
   * 2026-08-12（模型调用面审计）：此前多轮循环无 per-attempt 超时，
   * 一轮挂起（如模型 thinking 不返回）会耗尽整个 handler 预算，
   * 后续 turn 全部没有时间。默认 90s，留给 handler 剩余时间做 DB 收尾。
   */
  turnTimeoutMs?: number;
}

/** Agent turn 执行上下文 */
export interface AgentTurnContext {
  /** 运行 ID */
  runId: string;
  /** Agent unit ID */
  agentUnitId: string;
  /** 当前 turn 编号 */
  turnNo: number;
  /** 当前 attempt 编号 */
  attemptNo: number;
  /** Agent 角色 */
  role: AgentRole;
}

/**
 * Agent Runtime。
 *
 * 不做隐式重试（计划 §11.1）。
 * SDK 不做隐式重试。一次 transport attempt 对应一次 budget reservation；
 * 崩溃后的保守 reservation 不因重启消失。
 */
export class AgentRuntime {
  private readonly config: AgentRuntimeConfig;

  constructor(config: AgentRuntimeConfig) {
    this.config = config;
  }

  /**
   * 执行一次 Agent turn。
   *
   * 在事务外执行一次 provider 请求。
   * 严格解析 native tool call 或 structured_action_v1。
   *
   * P1-09：在 provider 调用前执行请求级 Token Hard Check，
   * 超出 context window 时抛出 InputOverContextError，不发送请求。
   */
  async executeTurn(
    request: AgentTurnRequest,
    ctx: AgentTurnContext,
    signal?: AbortSignal,
  ): Promise<AgentTurnResult> {
    logger.debug({ runId: ctx.runId, agentUnitId: ctx.agentUnitId, turnNo: ctx.turnNo, role: ctx.role, toolMode: this.config.toolMode }, "Agent turn 开始");

    // P1-09: 请求级 Token Hard Check
    // 在 provider 调用前按最终序列化 request 重新计数，
    // inputTokens + maxTokens > contextWindow - safety 时禁止发送。
    enforceRequestTokenBudget(request, {
      contextWindowTokens: this.config.contextWindowTokens,
      safetyMarginTokens: this.config.safetyMarginTokens ?? 2_048,
    });

  // R5: bundle is the sole path — provider field has been removed.
  const startedAt = Date.now();
  // 2026-08-12（模型调用面审计）：单 turn 独立预算——挂起的 provider 请求
  // 在 turnTimeoutMs 后被 abort，不再吞掉整个 handler 预算（多轮 supervisor
  // 场景：一轮卡死，后续 turn 仍有机会）。父 signal 取消仍然向下传播。
  const result = await runWithAbortBudget(
    (turnSignal) => this.config.bundle.agentTurn.executeAgentTurn(request, turnSignal),
    signal,
    this.config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    (lateError) => logger.warn(
      { runId: ctx.runId, agentUnitId: ctx.agentUnitId, turnNo: ctx.turnNo, err: lateError },
      "agent turn exceeded its budget after handler settled",
    ),
  );
  // P0-4：Agent 角色 provider 调用统一埋点（duration/token/finish_reason/truncated）。
  // model 优先取 request.model（调用方可覆盖），缺省取 capability 快照的 modelId。
  recordProviderTurnMetrics({
    role: ctx.role,
    model: request.model ?? this.config.bundle.capability.modelId,
    durationMs: Date.now() - startedAt,
    finishReason: result.finishReason,
    promptTokens: result.usage?.promptTokens,
    completionTokens: result.usage?.completionTokens,
    cacheHitTokens: result.usage?.cacheHitTokens,
    cacheMissTokens: result.usage?.cacheMissTokens,
  });
  logger.debug({ runId: ctx.runId, turnNo: ctx.turnNo, finishReason: result.finishReason, toolCallCount: result.toolCalls.length }, "Agent turn 完成（bundle）");
  return result;
  }

}

/**
 * 单 turn 超时预算默认值（毫秒）：90s。
 * 2026-08-12（模型调用面审计）。
 */
export const DEFAULT_TURN_TIMEOUT_MS = 90_000;

/**
 * 解析 structured_action_v1 格式的模型输出。
 *
 * 当 provider 只支持 JSON mode 时，模型输出一个 JSON 对象，
 * 其中包含 content 和 toolCalls 字段。
 */
export function parseStructuredAction(rawOutput: string): AgentTurnResult {
  // BUG-14: JSON.parse 无异常保护。当 provider 仅支持 JSON mode 且模型输出
  // 不是有效 JSON 时（如包含 markdown 包裹或截断的 JSON），直接解析会抛出
  // 未处理的异常，导致整个 Agent turn 崩溃。此处添加 try-catch，
  // 解析失败时返回空 toolCalls 和 stop finishReason，让上层逻辑正常处理。
  // 与 learning-agent/runtime.ts 的 parseStructuredAction 实现保持一致：
  // JSON.parse 成功但结果为 null/数字/字符串/数组时，直接访问属性同样会抛
  // TypeError，必须统一按解析失败 fail-soft。
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return {
      content: rawOutput,
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      providerRequestId: null,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      content: rawOutput,
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      providerRequestId: null,
    };
  }
  const record = parsed as Record<string, unknown>;

  // 验证基本结构（toolCalls 元素必须为对象，null/字符串/数字元素跳过——
  // 恶意或格式错误的模型输出可能含 [null] 元素，直接访问 call.id 会崩）
  const content = typeof record.content === "string" ? record.content : null;
  const toolCalls = Array.isArray(record.toolCalls)
    ? record.toolCalls
        .filter((call): call is Record<string, unknown> =>
          call !== null && typeof call === "object" && !Array.isArray(call))
        .map((call) => ({
          id: String(call.id ?? ""),
          name: String(call.name ?? ""),
          arguments: (call.arguments ?? {}) as Record<string, unknown>,
        }))
    : [];
  const finishReason = typeof record.finishReason === "string"
    ? record.finishReason
    : toolCalls.length > 0
      ? "tool_calls"
      : "stop";

  return {
    content,
    toolCalls,
    finishReason,
    usage: null,
    providerRequestId: null,
  };
}
