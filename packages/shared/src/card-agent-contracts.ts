/**
 * Provider Agent 契约定义
 *
 * 本文件原为 Supervisor Agent v1 核心合约（1491 行），学习卡 V1 清理
 * 阶段 E 后精简为仅保留**被实际引用**的 Provider 契约部分：
 *
 * 保留（活代码）：
 * - AgentRole（被 agentTurnRequestSchema 引用）
 * - ProviderToolMode / providerCapabilitySchema / ProviderCapability
 * - providerUsageSchema / ProviderUsage
 * - agentTurnRequestSchema / AgentTurnRequest
 * - agentTurnResultSchema / AgentTurnResult
 *
 * 已删除（V1 死代码，无外部引用）：
 * - 版本常量（SUPERVISOR_AGENT_ENGINE_MODE 等）
 * - AgentUnitKind / UnitStatus 及相关函数
 * - SupervisorShellStage / SupervisorRunStatus
 * - AgentEventType / CoverageLayer / Bundle 状态
 * - GenerationExecutionMode 及用户文案
 * - Fast/Compose/Critic/Draft/Coverage/Tool schema
 * - 所有 ToolName 常量 / FORBIDDEN_OPERATIONS
 * - AgentErrorClass / NeedsAttentionReason
 * - RetrievalMode / searchResultSchema
 * - specialistTaskSpecSchema
 * - mapContextBundleSchema
 * - Budget schema（roleBudgetSchema / runBudgetSchema 等）
 * - generationPlanSchema / deckDraftSchema（含 density "overview/standard/complete"）
 */

import { z } from "zod";

// ─── 1. Agent Role ─────────────────────────────────────────────────────

/**
 * Agent 角色枚举（被 agentTurnRequestSchema 引用）。
 *
 * - generation_supervisor: 主导完整认知过程，按需调用专业子 Agent
 * - text_extractor: 处理定义、原理、条件、因果、比较、例外和 procedure
 * - code_extractor: 保留命令、运算符、数值、单位、边界条件
 * - vision_specialist: 只读取 immutable image asset，生成 OCR/caption/region
 * - deck_composer: 可选专家，提出 canonical merge/importance/grouping
 * - grounding_critic: 强制、只读、独立角色，逐 claim 输出支撑判定
 * - repairer: 最多创建一次，只能根据 Critic hard issues 提交 typed patch
 * - companion_agent: 伴星可调用受控工具的通用 Agent loop
 */
export const AgentRole = {
  GENERATION_SUPERVISOR: "generation_supervisor",
  TEXT_EXTRACTOR: "text_extractor",
  CODE_EXTRACTOR: "code_extractor",
  VISION_SPECIALIST: "vision_specialist",
  DECK_COMPOSER: "deck_composer",
  GROUNDING_CRITIC: "grounding_critic",
  REPAIRER: "repairer",
  COMPANION_AGENT: "companion_agent",
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

// ─── 2. Provider Capability ────────────────────────────────────────────

/** Provider 工具支持模式 */
export const ProviderToolMode = {
  /** 原生 tool call */
  NATIVE_TOOLS: "native_tools",
  /** JSON mode 的同构 structured_action_v1 */
  STRUCTURED_ACTION: "structured_action",
  /** 不支持 */
  UNSUPPORTED: "unsupported",
} as const;
export type ProviderToolMode =
  (typeof ProviderToolMode)[keyof typeof ProviderToolMode];

/**
 * Provider 能力快照。
 * capability fingerprint 固化到 run，同一 run 不得在执行中切 provider/model/tool schema。
 */
export const providerCapabilitySchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  visionModelId: z.string().min(1),
  toolMode: z.enum([ProviderToolMode.NATIVE_TOOLS, ProviderToolMode.STRUCTURED_ACTION]),
  contextWindowTokens: z.number().int().positive(),
  reservedOutputTokens: z.number().int().positive(),
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  /** 能力指纹（provider + model + tool mode + 版本的 hash） */
  fingerprint: z.string().min(1),
}).strict();
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

// ─── 4. Agent Turn 请求与结果 ─────────────────────────────────────────

/** Provider 用量 */
export const providerUsageSchema = z.object({
  totalTokens: z.number().int().nullable().optional(),
  promptTokens: z.number().int().nullable().optional(),
  completionTokens: z.number().int().nullable().optional(),
  requestId: z.string().nullable().optional(),
  /**
   * B2（计划 §2.5）：prompt cache 命中的 token 数。
   * provider 返回 cache 命中时记录，用于成本观测。
   * Provider 未提供 cache 统计时保持 undefined。
   */
  cacheHitTokens: z.number().int().nullable().optional(),
  /**
   * B2（计划 §2.5）：prompt cache 未命中的 token 数。
   * provider 返回 cache 未命中时记录，用于成本观测。
   */
  cacheMissTokens: z.number().int().nullable().optional(),
}).strict();
export type ProviderUsage = z.infer<typeof providerUsageSchema>;

/**
 * Provider 不透明 reasoning 句柄（多轮工具循环回放用）。
 *
 * 背景：部分模型在思考模式下要求把上一轮的 reasoning 原样回传，否则工具循环
 * 第二步直接 400。实测 deepseek-v4.1-flash：
 * 「The reasoning_text in the thinking mode must be passed back to the API」；
 * 而 muse-spark-1.3-contributor 不要求回传、但**接受**回传（实测缺 `summary`
 * 字段会 400 `missing required field 'summary'`）。
 *
 * 契约约束：
 * - **provider 私有**：只有产出它的 provider 能解释其字段；调用方只做原样透传
 *   （以及按需持久化），不得解析或改写。
 * - **剥离明文思维链**：provider 必须去掉明文思考内容（Responses API 的
 *   `content[].reasoning_text`）后再返回。实测剥离后仍满足 muse-spark 与
 *   deepseek 的上游校验，因此模型内部推理不需要随事件或数据库落盘。
 * - **调用方不得把句柄写入日志或事件 payload**（它仍是模型侧数据）。
 * - 形状为不透明记录（而非固定字段），因为不同 provider/协议的句柄字段不同。
 */
export const providerReasoningHandleSchema = z.record(z.unknown());
export type ProviderReasoningHandle = z.infer<typeof providerReasoningHandleSchema>;

/** Agent turn 请求 */
export const agentTurnRequestSchema = z.object({
  /** Agent 角色 */
  role: z.enum([
    AgentRole.GENERATION_SUPERVISOR,
    AgentRole.TEXT_EXTRACTOR,
    AgentRole.CODE_EXTRACTOR,
    AgentRole.VISION_SPECIALIST,
    AgentRole.DECK_COMPOSER,
    AgentRole.GROUNDING_CRITIC,
    AgentRole.REPAIRER,
    AgentRole.COMPANION_AGENT,
  ]),
  /** 系统策略 prompt（不含用户数据） */
  systemPrompt: z.string(),
  /** 上下文消息（从 ledger/event/task results 重建） */
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    // E3（计划 §2.10）：支持纯文本或 multimodal content（text + image_url）。
    content: z.union([
      z.string(),
      z.array(z.union([
        z.object({
          type: z.literal("text"),
          text: z.string(),
        }),
        z.object({
          type: z.literal("image_url"),
          image_url: z.object({
            url: z.string(),
            detail: z.enum(["auto", "low", "high"]).optional(),
          }),
        }),
      ])),
    ]),
    /** 工具调用 ID（用于 tool role 消息） */
    toolCallId: z.string().optional(),
    /** assistant 消息的工具调用（用于确认后恢复同一次 Agent run） */
    toolCalls: z.array(z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      arguments: z.record(z.unknown()),
    }).strict()).max(4).optional(),
    /**
     * 该 assistant 消息对应的 reasoning 句柄（由 provider 产出，见
     * providerReasoningHandleSchema）。工具循环回放时原样带回给同一 provider。
     */
    reasoning: z.array(providerReasoningHandleSchema).max(4).optional(),
  })),
  /** 工具 schema（按 role allowlist） */
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.unknown()),
  })).default([]),
  /** 最大输出 token */
  maxTokens: z.number().int().positive(),
  /** 温度 */
  temperature: z.number().min(0).max(2).default(0.3),
  /** 使用的模型（可覆盖默认） */
  model: z.string().optional(),
}).strict();
export type AgentTurnRequest = z.infer<typeof agentTurnRequestSchema>;

/**
 * Agent turn 返回结果。
 * usage/requestId 随响应返回，不再依赖可变的 getLastUsage()。
 */
export const agentTurnResultSchema = z.object({
  /** 模型自由文本输出（可为 null） */
  content: z.string().nullable(),
  /** 模型请求执行的工具调用 */
  toolCalls: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** 工具参数（已 JSON 解析） */
    arguments: z.record(z.unknown()),
  })).default([]),
  /** 完成原因：stop | tool_calls | length | content_filter | error */
  finishReason: z.string(),
  /**
   * 本次 assistant 输出的 reasoning 句柄（provider 不透明）。
   *
   * 调用方必须在下一轮请求的对应 assistant 消息上原样带回（`messages[].reasoning`），
   * 否则需要 reasoning 回传的模型（deepseek 思考模式）会在工具循环第二步 400。
   * 无需 reasoning 的模型（muse-spark）带不带都能工作。
   */
  reasoning: z.array(providerReasoningHandleSchema).max(4).optional(),
  /** 本次调用的 token 用量 */
  usage: providerUsageSchema.nullable(),
  /** Provider 请求 ID（用于追踪） */
  providerRequestId: z.string().nullable(),
}).strict();
export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;
