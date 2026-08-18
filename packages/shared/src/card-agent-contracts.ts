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
 * - isRunErrorRetryable（被 run-retryable.test.ts 引用）
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
 */
export const AgentRole = {
  GENERATION_SUPERVISOR: "generation_supervisor",
  TEXT_EXTRACTOR: "text_extractor",
  CODE_EXTRACTOR: "code_extractor",
  VISION_SPECIALIST: "vision_specialist",
  DECK_COMPOSER: "deck_composer",
  GROUNDING_CRITIC: "grounding_critic",
  REPAIRER: "repairer",
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

// ─── 2. Run 可重试性（needs_attention 恢复语义） ──────────────────────

/**
 * needs_attention run 的 errorCode 中，哪些明确"重试无意义"。
 *
 * 分类依据（2026-08-06）：
 * - 预算/资源类：预算按 run 累计且不可重置，重试必然再次失败
 * - 快照漂移类：provider fingerprint 是 run 创建时冻结的，重试不会改变
 * - 确定性门禁类：VERIFY/PUBLISH 是确定性阶段，不重新调用模型（G5），
 *   同一 draft 重跑校验/发布结果必然相同
 * - 配置/产品类：mock 阻止、prepare 确定性失败
 *
 * 瞬时故障（provider 5xx/超时/worker 崩溃/lease 丢失）**不在**此集合，
 * 这些场景下 `/retry` 是正解的恢复手段。
 */
export const NON_RETRYABLE_RUN_ERROR_CODES: ReadonlySet<string> = new Set([
  // 预算/资源耗尽
  "budget_exhausted",
  "budget_exhausted_during_pagination",
  // 快照漂移
  "provider_fingerprint_mismatch",
  // 配置/产品阻止
  "mock_provider_blocked_in_production",
  "prepare_failed",
  // 确定性门禁：VERIFY
  "no_draft_for_verify",
  "no_quality_report",
  "verify_failed",
  "coverage_insufficient",
  "critic_check_failed",
  "quality_report_missing",
  "candidate_check_failed",
  "evidence_check_failed",
  "empty_result",
  "pending_candidate",
  "partial_verdict",
  "unsupported_verdict",
  "contradicted_verdict",
  "auto_verified_blocked",
  "survival_coverage_incomplete",
  // 确定性门禁：PUBLISH
  "publish_failed",
  "stale_epoch",
  "draft_hash_mismatch",
  "unaligned_evidence",
  "empty_verdicts",
  "run_not_found",
  "run_not_active",
  "blocked_verdict",
  // 其它明确不可恢复
  "superseded_by_manual_kill",
]);

/** 命中即不可重试的错误码前缀（含历史/兜底拼接的 code）。 */
export const NON_RETRYABLE_RUN_ERROR_PREFIXES: readonly string[] = [
  "verify_failed:", // verify 兜底拼接 code
  "publish_failed:", // publish 兜底拼接 code
  "预算耗尽", // 历史 BudgetExhaustedError 的中文 message
];

/**
 * 判断 needs_attention run 是否值得通过 `/retry` 恢复。
 * 未知 errorCode 默认可重试（检查点已存在，重试是安全的恢复尝试）。
 */
export function isRunErrorRetryable(errorCode: string | null | undefined): boolean {
  if (!errorCode) return true;
  if (NON_RETRYABLE_RUN_ERROR_CODES.has(errorCode)) return false;
  for (const prefix of NON_RETRYABLE_RUN_ERROR_PREFIXES) {
    if (errorCode.startsWith(prefix)) return false;
  }
  return true;
}

// ─── 3. Provider Capability ────────────────────────────────────────────

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
   * 向后兼容：旧 provider 不返回此字段时为 undefined。
   */
  cacheHitTokens: z.number().int().nullable().optional(),
  /**
   * B2（计划 §2.5）：prompt cache 未命中的 token 数。
   * provider 返回 cache 未命中时记录，用于成本观测。
   */
  cacheMissTokens: z.number().int().nullable().optional(),
}).strict();
export type ProviderUsage = z.infer<typeof providerUsageSchema>;

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
  ]),
  /** 系统策略 prompt（不含用户数据） */
  systemPrompt: z.string(),
  /** 上下文消息（从 ledger/event/task results 重建） */
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    // E3（计划 §2.10）：支持 multimodal content（text + image_url）
    // 向后兼容：string content 仍然可用
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
  /** 本次调用的 token 用量 */
  usage: providerUsageSchema.nullable(),
  /** Provider 请求 ID（用于追踪） */
  providerRequestId: z.string().nullable(),
}).strict();
export type AgentTurnResult = z.infer<typeof agentTurnResultSchema>;
