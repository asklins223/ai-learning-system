/**
 * Learning Agent Runtime（阶段 03 / W2 任务 03-1）
 *
 * 基于现有 generation AgentRuntime（workers/ai-worker/src/agent/runtime.ts）的
 * 有界 loop 模式，但**完全独立于 Generation Supervisor**（任务 03-1）：
 * - role / tool / provider / budget 独立；provider 通过 LearningProviderAdapter 注入，
 *   不依赖 generation 的 CapabilityBundle；
 * - 预留 contract epoch 校验钩子（任务 03-6：所有 turn/tool/Critic 结果落库前
 *   重新比较 contract 的 `runtimeEpochSnapshot + episodeEpoch`）。
 *
 * 本文件仅骨架：完整 turn 执行、transport 重试、deadline 强执行与 epoch 落库
 * 强校验实现于 W2 后续任务（03-2/03-3/03-6）。
 */

import type {
  LearningAgentRole,
  LearningToolCall,
} from "./types.ts";
import type { LearningAgentSession } from "./session.ts";
import type { LearningBudgetTracker } from "./budget.ts";

// ─── 1. Provider 工具模式 ────────────────────────────────────────────────

/** Provider 工具支持模式（Learning 侧独立定义，不借用 generation 的共享枚举） */
export const LearningToolMode = {
  /** 原生 tool call */
  NATIVE_TOOLS: "native_tools",
  /** JSON mode 的同构 structured_action_v1 */
  STRUCTURED_ACTION: "structured_action",
  /** 不支持工具 */
  UNSUPPORTED: "unsupported",
} as const;
export type LearningToolMode = (typeof LearningToolMode)[keyof typeof LearningToolMode];

// ─── 2. Turn 请求 / 结果类型 ─────────────────────────────────────────────

/** Provider 用量（与 generation 的 ProviderUsage 独立定义） */
export interface LearningProviderUsage {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  requestId: string | null;
}

/** Learning Agent turn 请求 */
export interface LearningAgentTurnRequest {
  /** 系统策略 prompt（不含用户数据；hidden rubric/solution 不得进入） */
  systemPrompt: string;
  /** 上下文消息（从 contract/probe/artifact/assessment 重建，不来自无限增长的 messages） */
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    toolCallId?: string;
  }>;
  /** 工具 schema（按角色 allowlist，由 LearningToolGateway 提供） */
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  /** 最大输出 token */
  maxTokens: number;
  /** 温度 */
  temperature: number;
  /** 使用的模型（可覆盖冻结的 modelId） */
  model?: string;
  /**
   * 由 episode contract 冻结的 provider 配置（01-2 §5：只存不可变引用，不存 API key）。
   * 仅服务端内部 actor 读取。
   */
  providerConfigId: string;
  /**
   * contract epoch 快照（01-2 §5 / 任务 03-6）。
   * 执行前后必须与当前 runtime-control + learning_episode 重新比较。
   */
  runtimeEpochSnapshot: number;
  episodeEpoch: number;
}

/** Learning Agent turn 结果 */
export interface LearningAgentTurnResult {
  /** 模型自由文本输出（可为 null） */
  content: string | null;
  /** 模型请求执行的工具调用 */
  toolCalls: LearningToolCall[];
  /** 完成原因：stop | tool_calls | length | content_filter | error */
  finishReason: string;
  /** 本次调用 token 用量 */
  usage: LearningProviderUsage | null;
  /** Provider 请求 ID（追踪用） */
  providerRequestId: string | null;
}

// ─── 3. Provider 适配器 ──────────────────────────────────────────────────

/**
 * Learning 专用 provider 适配器。
 *
 * 与 generation 的 CapabilityBundle 完全隔离：Learning 角色只经本适配器
 * 获取模型能力（01-3 §1 Agent 隔离原则）。实现（对接真实 provider/ASR policy）
 * 由 W2 后续任务完成，本文件仅定义契约。
 */
export interface LearningProviderAdapter {
  executeAgentTurn(
    request: LearningAgentTurnRequest,
    signal?: AbortSignal,
  ): Promise<LearningAgentTurnResult>;
}

// ─── 4. Runtime 配置与 turn 上下文 ───────────────────────────────────────

/** Learning Agent Runtime 配置 */
export interface LearningAgentRuntimeConfig {
  /** Learning 专用 provider 适配器 */
  provider: LearningProviderAdapter;
  /** Provider 工具模式 */
  toolMode: LearningToolMode;
  /** transport 层最大重试次数 */
  maxTransportRetries: number;
  /** 单次 Agent turn deadline（W0 冻结：由 Provider/ASR policy 冻结，≤120s） */
  turnDeadlineMs: number;
}

/** Agent turn 执行上下文 */
export interface LearningAgentTurnContext {
  /** 运行 ID */
  runId: string;
  /** Session ID */
  sessionId: string;
  /** Episode ID */
  episodeId: string;
  /** 当前 turn 编号 */
  turnNo: number;
  /** 当前 attempt 编号 */
  attemptNo: number;
  /** Agent 角色 */
  role: LearningAgentRole;
}

// ─── 5. Epoch 校验钩子（任务 03-6 预留） ─────────────────────────────────

/** contract epoch 失配错误（任务 03-6：epoch 失配路径不产生任何学习副作用） */
export class LearningEpochMismatchError extends Error {
  readonly expectedRuntimeEpoch: number;
  readonly actualRuntimeEpoch: number;
  readonly expectedEpisodeEpoch: number;
  readonly actualEpisodeEpoch: number;

  constructor(input: {
    expectedRuntimeEpoch: number;
    actualRuntimeEpoch: number;
    expectedEpisodeEpoch: number;
    actualEpisodeEpoch: number;
  }) {
    super(
      `Learning contract epoch 失配：runtimeEpoch ${input.actualRuntimeEpoch}/${input.expectedRuntimeEpoch}，`
      + `episodeEpoch ${input.actualEpisodeEpoch}/${input.expectedEpisodeEpoch}`,
    );
    this.name = "LearningEpochMismatchError";
    this.expectedRuntimeEpoch = input.expectedRuntimeEpoch;
    this.actualRuntimeEpoch = input.actualRuntimeEpoch;
    this.expectedEpisodeEpoch = input.expectedEpisodeEpoch;
    this.actualEpisodeEpoch = input.actualEpisodeEpoch;
  }
}

/**
 * 校验 contract epoch（runtimeEpochSnapshot + episodeEpoch）。
 *
 * 任务 03-6 钩子：所有 turn / tool / Critic 结果落库前，以及 COMMIT 的完整 CAS 中
 * 都必须调用本函数；失配即抛错，调用方转为 stale/blocked，0 学习副作用。
 * 骨架已提供可运行实现；真实数据源接入（runtime-control / learning_episode 行）由 W2 后续任务完成。
 */
export function assertContractEpochValid(input: {
  expectedRuntimeEpoch: number;
  actualRuntimeEpoch: number;
  expectedEpisodeEpoch: number;
  actualEpisodeEpoch: number;
}): void {
  if (
    input.actualRuntimeEpoch !== input.expectedRuntimeEpoch
    || input.actualEpisodeEpoch !== input.expectedEpisodeEpoch
  ) {
    throw new LearningEpochMismatchError(input);
  }
}

// ─── 6. LearningAgentRuntime ─────────────────────────────────────────────

/**
 * Learning Agent Runtime。
 *
 * 不做隐式重试：一次 transport attempt 对应一次预算 reservation（对齐 generation §11.1）。
 * 一次 attempt 最多一次 provider 请求。
 */
export class LearningAgentRuntime {
  private readonly config: LearningAgentRuntimeConfig;

  constructor(config: LearningAgentRuntimeConfig) {
    this.config = config;
  }

  /**
   * 执行一次 Learning Agent turn（有界循环骨架）。
   *
   * 执行顺序（对齐 generation §5.2，但 epoch/deadline 独立）：
   * 1. turn deadline 校验（≤120s，W0 冻结）；
   * 2. contract epoch 预检（runtimeEpochSnapshot + episodeEpoch）；
   * 3. 事务外一次 provider 请求；
   * 4. 返回结果后由上层解析 native tool call / structured_action_v1 并重新校验 epoch。
   *
   * 完整实现（deadline 强制超时 → operational failure、epoch 落库重比较）于 W2 后续任务。
   */
  async executeTurn(
    request: LearningAgentTurnRequest,
    _ctx: LearningAgentTurnContext,
    signal?: AbortSignal,
  ): Promise<LearningAgentTurnResult> {
    // 预留：单次 turn deadline 检查。骨架不强制超时，W2 后续任务实现
    // `deadline 超时 → operational_only`（01-2 §8.6 disposition 优先级第 1 步）。
    this.assertTurnDeadline();

    // 预留：落库前 epoch 重比较由上层在持久化前调用 assertContractEpochValid。
    // 此处不做持久化，保持 0 副作用骨架。

    // 一次 attempt 最多一次 provider 请求（任务 03-1 复用点）。
    const result = await this.config.provider.executeAgentTurn(request, signal);
    return result;
  }

  /** 单次 Agent turn deadline 校验（W0 冻结 ≤120s） */
  private assertTurnDeadline(): void {
    // 骨架：deadline 由 Provider/ASR policy 冻结。真实计时起点/超时行为实现于 W2 后续任务。
    if (this.config.turnDeadlineMs <= 0) {
      throw new Error(`turnDeadlineMs 非法：${String(this.config.turnDeadlineMs)}`);
    }
  }
}

// ─── 7. 共享 turn 初始化 / 失败清理（对齐 generation QUAL-35 模式） ──────

/**
 * 初始化 Learning Agent turn：开始 turn + 预留 turn 预算 + 开始 attempt。
 *
 * @param session       Learning Agent 会话
 * @param budgetTracker 学习预算追踪器
 * @param config        run/session/episode 标识
 * @param role          当前角色
 */
export function initAgentTurn(
  session: LearningAgentSession,
  budgetTracker: LearningBudgetTracker,
  config: { runId: string; sessionId: string; episodeId: string },
  role: LearningAgentRole,
): LearningAgentTurnContext {
  // 先预算后记账：reserveTurn 抛 LearningBudgetExhaustedError 时，
  // 不能留下已推进 turnNo 且 status=running 的孤儿 turn 记录（状态泄漏）。
  budgetTracker.reserveTurn(role);
  // 预算接线（2026-08-11）：reserveProviderCall 是全库唯一 providerCalls 计数
  // 递增点，此前无任何调用者 → 上限形同虚设。此处每个 turn 预留一次 provider
  // 调用。
  // ⚠️ 骨架阶段状态：initAgentTurn 当前零调用者（W2 接线任务）；接线时成功路径
  // 必须在 provider 调用完成后配对调用 settleProviderCall(role, usage) 冲抵
  // 预留并累加 token——handleTurnFailure 已配对。settle 每次调用结算一次，
  // 调用方负责严格配对，勿双重 settle（token 会重复累加）。
  budgetTracker.reserveProviderCall(role);
  session.startTurn(role);

  const state = session.getState();
  const turnCtx: LearningAgentTurnContext = {
    runId: config.runId,
    sessionId: config.sessionId,
    episodeId: config.episodeId,
    turnNo: state.turnNo,
    attemptNo: state.attemptNo,
    role,
  };

  session.startAttempt();
  return turnCtx;
}

/**
 * Learning Agent turn 执行失败时的清理：结算 provider 调用预算并标记会话失败。
 *
 * @param budgetTracker 学习预算追踪器
 * @param session       Learning Agent 会话
 * @param role          当前角色
 */
export function handleTurnFailure(
  budgetTracker: LearningBudgetTracker,
  session: LearningAgentSession,
  role: LearningAgentRole,
): void {
  budgetTracker.settleProviderCall(role, null);
  session.fail();
}

// ─── 8. 结构化动作解析 ───────────────────────────────────────────────────

/**
 * 解析 structured_action_v1 格式的模型输出。
 *
 * 对齐 generation BUG-14 防护：JSON 解析失败时返回空 toolCalls 与 stop finishReason，
 * 让上层逻辑正常处理（不抛出未处理异常）。
 */
export function parseStructuredAction(rawOutput: string): LearningAgentTurnResult {
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

  // BUG-14 防护补充：JSON.parse("null")/JSON.parse("42") 会成功返回非对象值，
  // 直接访问属性会抛 TypeError 绕过外层 fail-soft 意图，这里统一按解析失败处理。
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
  const content = typeof record.content === "string" ? record.content : null;
  const toolCalls: LearningToolCall[] = Array.isArray(record.toolCalls)
    ? record.toolCalls.map((call: Record<string, unknown>) => ({
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
