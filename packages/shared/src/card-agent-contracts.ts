/**
 * Supervisor Agent v1 核心合约定义
 *
 * 本文件是学习卡生成 Supervisor Agent 系统的唯一类型真实来源（single source of truth）。
 * 集中管理 Agent role/tool/action/candidate/coverage/budget/draft/report 等全部 TypeScript 类型与 Zod schema。
 *
 * 设计原则（计划 §0.1, §8.4）：
 * - 全面 Agent 化的是需要知识理解和策略判断的工作
 * - 不 Agent 化的是不能容忍概率错误的安全内核
 * - Prompt 不要求输出 chain-of-thought，只输出 schema 化 action 和 reason code
 * - 正文、OCR、代码和图片说明全部标记为 untrusted source data
 *
 * 版本：supervisor_agent_v1 / card-supervisor-shell-v1
 */

import { z } from "zod";

// ─── 1. 版本与引擎标识（计划 §0, §9.1） ──────────────────────────────────

/** Supervisor Agent 引擎标识 */
export const SUPERVISOR_AGENT_ENGINE_MODE = "supervisor_agent_v1" as const;

/** 外层执行图版本 */
export const SUPERVISOR_SHELL_VERSION = "card-supervisor-shell-v1" as const;

/** Supervisor 策略版本 */
export const SUPERVISOR_POLICY_VERSION = "supervisor-policy-v1" as const;

/** 工具 schema 版本 */
export const TOOL_SCHEMA_VERSION = "tool-schema-v1" as const;

/** 结果合约版本（终态完整性 CHECK 的唯一标识） */
export const RESULT_CONTRACT_VERSION = "result-contract-v1" as const;

/** 派生索引 embedding profile 版本 */
export const EMBEDDING_PROFILE_VERSION = "card-evidence-v1" as const;

/** 向量维度（公测冻结） */
export const EMBEDDING_DIMENSIONS = 1024 as const;

/** 检索策略版本 */
export const RETRIEVAL_POLICY_VERSION = "retrieval-policy-v1" as const;

/** 验证器版本 */
export const VERIFIER_VERSION = "verifier-v1" as const;

/** Planner 版本 */
export const PLANNER_VERSION = "supervisor-planner-v1" as const;

/** Critic 版本 */
export const CRITIC_VERSION = "grounding-critic-v1" as const;

/** node contract 版本 */
export const NODE_CONTRACT_VERSION = "node-contract-v1" as const;

// ─── 2. Agent Role（计划 §4, §8.1） ──────────────────────────────────────

/**
 * Agent 角色枚举。
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

/** 所有合法的 Agent role 列表 */
export const ALL_AGENT_ROLES = Object.values(AgentRole) as AgentRole[];

/** 子 Agent role（不含 supervisor 自身） */
export const SPECIALIST_ROLES: AgentRole[] = [
  AgentRole.TEXT_EXTRACTOR,
  AgentRole.CODE_EXTRACTOR,
  AgentRole.VISION_SPECIALIST,
  AgentRole.DECK_COMPOSER,
  AgentRole.GROUNDING_CRITIC,
  AgentRole.REPAIRER,
];

// ─── 3. Agent Unit Kind（计划 §9.2，泛化 card_generation_units） ───────────

/**
 * Agent 路径只使用粗粒度 kind：
 * - prepare: 确定性封存、atomic evidence、bundle、outline、预算
 * - agent_run: Supervisor 和所有 child specialist（通过 agentRole 区分）
 * - deterministic_verify: 确定性完整性门禁
 * - publish: 单事务 canonical publish
 *
 * Agent 路径只使用以上四种粗粒度 kind。
 */
export const AgentUnitKind = {
  PREPARE: "prepare",
  AGENT_RUN: "agent_run",
  DETERMINISTIC_VERIFY: "deterministic_verify",
  PUBLISH: "publish",
} as const;
export type AgentUnitKind = (typeof AgentUnitKind)[keyof typeof AgentUnitKind];

// ─── 3.5. Agent Unit Status（计划 §9.2, P0-06 修复） ──────────────────────

/**
 * card_generation_units 的合法 status 值。
 *
 * 与 DB CHECK 约束（migration 0054）和 Zod schema 保持一致，
 * 作为 TypeScript / Zod / DB 三者的唯一真相源。
 *
 * - pending:        初始状态，等待调度
 * - running:        正在执行
 * - succeeded:      成功完成（终态）
 * - retryable_failed: 可重试失败（非终态，队列会重投）
 * - terminal_failed:  不可重试失败（终态）
 * - cancelled:      被取消（终态）
 * - superseded:     被取代（终态）
 * - waiting_child:  等待子任务完成（非终态）
 * - agent_running:  Agent turn 正在执行（非终态）
 * - verifying:      VERIFY 阶段正在执行（非终态）
 */
export const UnitStatus = {
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  RETRYABLE_FAILED: "retryable_failed",
  TERMINAL_FAILED: "terminal_failed",
  CANCELLED: "cancelled",
  SUPERSEDED: "superseded",
  WAITING_CHILD: "waiting_child",
  AGENT_RUNNING: "agent_running",
  VERIFYING: "verifying",
} as const;
export type UnitStatus = (typeof UnitStatus)[keyof typeof UnitStatus];

/** 所有合法的 unit status 值列表 */
export const ALL_UNIT_STATUSES = Object.values(UnitStatus) as UnitStatus[];

/** 非终态 status 数组（用于 SQL inArray 查询，如终态 run 时取消非终态 unit） */
export const NON_TERMINAL_UNIT_STATUSES = ALL_UNIT_STATUSES.filter(
  (s) => s !== UnitStatus.SUCCEEDED
    && s !== UnitStatus.TERMINAL_FAILED
    && s !== UnitStatus.CANCELLED
    && s !== UnitStatus.SUPERSEDED,
);

/** 终态 status 集合：进入后不会再改变 */
const TERMINAL_UNIT_STATUSES = new Set<UnitStatus>([
  UnitStatus.SUCCEEDED,
  UnitStatus.TERMINAL_FAILED,
  UnitStatus.CANCELLED,
  UnitStatus.SUPERSEDED,
]);

/** 成功终态 status 集合 */
const SUCCESS_UNIT_STATUSES = new Set<UnitStatus>([
  UnitStatus.SUCCEEDED,
]);

/** 可重试的非终态 status 集合 */
const RETRYABLE_UNIT_STATUSES = new Set<UnitStatus>([
  UnitStatus.RETRYABLE_FAILED,
]);

/** 判断 unit status 是否为终态 */
export function isTerminalUnitStatus(status: string): boolean {
  return TERMINAL_UNIT_STATUSES.has(status as UnitStatus);
}

/** 判断 unit status 是否为成功终态 */
export function isSuccessUnitStatus(status: string): boolean {
  return SUCCESS_UNIT_STATUSES.has(status as UnitStatus);
}

/** 判断 unit status 是否为可重试（非终态但可重新执行） */
export function isRetryableUnitStatus(status: string): boolean {
  return RETRYABLE_UNIT_STATUSES.has(status as UnitStatus);
}

/** 判断 unit status 是否为活跃（非终态） */
export function isActiveUnitStatus(status: string): boolean {
  return !isTerminalUnitStatus(status);
}

// ─── 4. 用户可见四阶段（计划 §12） ────────────────────────────────────────

/**
 * 用户可见阶段只有四个，由四节点 shell 和 Agent task aggregate 推导，
 * 不从 specialist role 猜测。
 */
export const SupervisorShellStage = {
  PREPARING: "preparing",
  GENERATING: "generating",
  CHECKING: "checking",
  PUBLISHING: "publishing",
} as const;
export type SupervisorShellStage =
  (typeof SupervisorShellStage)[keyof typeof SupervisorShellStage];

// ─── 5. Supervisor Run Status（计划 §9.1） ───────────────────────────────

/**
 * Supervisor engine 使用的 run 状态：
 * - active: queued | preparing | running | validating | publishing
 * - terminal/actionable: needs_attention | partial_ready | succeeded | cancelled | superseded
 */
export const SupervisorRunStatus = {
  QUEUED: "queued",
  PREPARING: "preparing",
  RUNNING: "running",
  VALIDATING: "validating",
  PUBLISHING: "publishing",
  NEEDS_ATTENTION: "needs_attention",
  PARTIAL_READY: "partial_ready",
  SUCCEEDED: "succeeded",
  CANCELLED: "cancelled",
  SUPERSEDED: "superseded",
} as const;
export type SupervisorRunStatus =
  (typeof SupervisorRunStatus)[keyof typeof SupervisorRunStatus];

/** 活跃状态集合 */
export const ACTIVE_RUN_STATUSES: SupervisorRunStatus[] = [
  SupervisorRunStatus.QUEUED,
  SupervisorRunStatus.PREPARING,
  SupervisorRunStatus.RUNNING,
  SupervisorRunStatus.VALIDATING,
  SupervisorRunStatus.PUBLISHING,
];

/** 终态/可操作状态集合 */
export const TERMINAL_RUN_STATUSES: SupervisorRunStatus[] = [
  SupervisorRunStatus.NEEDS_ATTENTION,
  SupervisorRunStatus.PARTIAL_READY,
  SupervisorRunStatus.SUCCEEDED,
  SupervisorRunStatus.CANCELLED,
  SupervisorRunStatus.SUPERSEDED,
];

// ─── 5b. Run 可重试性（needs_attention 恢复语义） ─────────────────────────

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

// ─── 6. Agent 事件类型（计划 §9.3） ──────────────────────────────────────

/**
 * card_generation_agent_events 的 event type 枚举。
 * 一张 append-only 表统一承载所有 Agent 事件。
 */
export const AgentEventType = {
  // Supervisor/Specialist turn
  TURN_STARTED: "turn_started",
  TURN_COMPLETED: "turn_completed",
  TURN_FAILED: "turn_failed",
  // Tool 请求/结果
  TOOL_REQUEST: "tool_request",
  TOOL_RESULT: "tool_result",
  TOOL_REJECTED: "tool_rejected",
  // 子任务生命周期
  CHILD_TASK_CREATED: "child_task_created",
  CHILD_TASK_COMPLETED: "child_task_completed",
  CHILD_TASK_FAILED: "child_task_failed",
  // 预算
  BUDGET_RESERVED: "budget_reserved",
  BUDGET_SETTLED: "budget_settled",
  BUDGET_EXHAUSTED: "budget_exhausted",
  // 候选/草稿操作
  CANDIDATE_OPERATION: "candidate_operation",
  DRAFT_OPERATION: "draft_operation",
  // 等待/恢复/取消/安全
  WAIT: "wait",
  RESUME: "resume",
  CANCEL: "cancel",
  SECURITY_EVENT: "security_event",
} as const;
export type AgentEventType = (typeof AgentEventType)[keyof typeof AgentEventType];

// ─── 7. Coverage 层类型（计划 §7.2） ─────────────────────────────────────

/**
 * 六层账本枚举。
 * full result 的前三项必须为 100%。
 * model_omitted 永远不得自动改写为 no_learnable_fact。
 */
export const CoverageLayer = {
  /** 是否完整封存 */
  SOURCE_PHYSICAL: "sourcePhysicalCoverage",
  /** 是否被 Supervisor 或 child task 领取 */
  BUNDLE_ASSIGNMENT: "bundleAssignmentCoverage",
  /** 是否有 candidate/no-candidate */
  EXPLICIT_DECISION: "explicitDecisionCoverage",
  /** 各 bundle/section 过滤后是否存活 */
  CANDIDATE_SURVIVAL: "candidateSurvivalCoverage",
  /** 关键概念/章节是否进入 Card Set */
  PUBLISHED_CONCEPT: "publishedConceptCoverage",
  /** 因 density/card budget 未发布的 canonical candidates */
  CAPACITY_EXCLUSIONS: "capacityExclusions",
} as const;
export type CoverageLayer = (typeof CoverageLayer)[keyof typeof CoverageLayer];

// ─── 8. Bundle 状态（计划 §9.4, G3） ──────────────────────────────────────

/**
 * Bundle 分配状态。
 * required bundle 最终必须是 candidate_emitted 或模型明确提交的 no_learnable_fact。
 * pending/model_omitted/protocol_error/auto_supplemented 均阻断 full publish。
 */
export const BundleAssignmentStatus = {
  PENDING: "pending",
  ASSIGNED: "assigned",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;
export type BundleAssignmentStatus =
  (typeof BundleAssignmentStatus)[keyof typeof BundleAssignmentStatus];

/**
 * Bundle 决策状态。
 * 每个 required bundle 最终必须有明确决策。
 */
export const BundleDecisionStatus = {
  PENDING: "pending",
  CANDIDATE_EMITTED: "candidate_emitted",
  NO_LEARNABLE_FACT: "no_learnable_fact",
  MODEL_OMITTED: "model_omitted",
  PROTOCOL_ERROR: "protocol_error",
  AUTO_SUPPLEMENTED: "auto_supplemented",
} as const;
export type BundleDecisionStatus =
  (typeof BundleDecisionStatus)[keyof typeof BundleDecisionStatus];

/** 阻断 full publish 的决策状态 */
export const BLOCKING_DECISION_STATUSES: BundleDecisionStatus[] = [
  BundleDecisionStatus.PENDING,
  BundleDecisionStatus.MODEL_OMITTED,
  BundleDecisionStatus.PROTOCOL_ERROR,
  BundleDecisionStatus.AUTO_SUPPLEMENTED,
];

// ─── 9. Agent Session 状态（计划 §5.2） ──────────────────────────────────

/**
 * Agent Session 状态。一个 Session 对应一个 Agent Unit。
 * Session 是有界、可恢复的 Agent loop。
 */
export const AgentSessionStatus = {
  PENDING: "pending",
  RUNNING: "running",
  WAITING_CHILD: "waiting_child",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type AgentSessionStatus =
  (typeof AgentSessionStatus)[keyof typeof AgentSessionStatus];

// ─── 10. Critic 支撑判定（计划 §4.6） ────────────────────────────────────

/**
 * 独立 Grounding Critic 的支撑判定结果。
 * Supervisor 不能自己写 supported verdict，也不能跳过 Critic。
 */
export const SupportVerdict = {
  /** 充分支撑 */
  SUPPORTED: "supported",
  /** 部分支撑 */
  PARTIAL: "partial",
  /** 未被支撑 */
  UNSUPPORTED: "unsupported",
  /** 与证据矛盾 */
  CONTRADICTED: "contradicted",
} as const;
export type SupportVerdict = (typeof SupportVerdict)[keyof typeof SupportVerdict];

/** Critic issue 严重程度 */
export const CriticIssueSeverity = {
  HARD: "hard",
  SOFT: "soft",
} as const;
export type CriticIssueSeverity =
  (typeof CriticIssueSeverity)[keyof typeof CriticIssueSeverity];

// ─── 11. Density（计划 §11.2） ───────────────────────────────────────────

/** 生成密度选项 */
export const GenerationDensity = {
  OVERVIEW: "overview",
  STANDARD: "standard",
  COMPLETE: "complete",
} as const;
export type GenerationDensity =
  (typeof GenerationDensity)[keyof typeof GenerationDensity];

// ─── 12. Provider Capability（计划 §8.2） ────────────────────────────────

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

// ─── 13. Agent Turn 请求与结果（计划 §8.1） ──────────────────────────────

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

// ─── 14. 预算（计划 §5.5, §11.2） ────────────────────────────────────────

/**
 * 角色级预算限制。
 * 达到 hard cap 立即停止并进入 needs_attention/budget_exhausted。
 */
export const roleBudgetSchema = z.object({
  /** 最大 turn 数 */
  maxTurns: z.number().int().positive(),
  /** 最大工具调用数 */
  maxToolCalls: z.number().int().positive(),
  /** 最大并发/数量 */
  maxConcurrent: z.number().int().positive(),
}).strict();
export type RoleBudget = z.infer<typeof roleBudgetSchema>;

/**
 * 完整运行预算快照。
 * 在 PREPARE 阶段冻结，固化到 run。
 */
export const runBudgetSchema = z.object({
  /** 各角色预算 */
  roles: z.record(z.enum([
    AgentRole.GENERATION_SUPERVISOR,
    AgentRole.TEXT_EXTRACTOR,
    AgentRole.CODE_EXTRACTOR,
    AgentRole.VISION_SPECIALIST,
    AgentRole.DECK_COMPOSER,
    AgentRole.GROUNDING_CRITIC,
    AgentRole.REPAIRER,
  ]), roleBudgetSchema),
  /** 最大 Provider 调用次数 */
  maxProviderCalls: z.number().int().positive(),
  /** 最大输入 token */
  maxInputTokens: z.number().int().positive(),
  /** 最大输出 token */
  maxOutputTokens: z.number().int().positive(),
  /** 最大 embedding token */
  maxEmbeddingTokens: z.number().int().positive(),
  /** 最大并行任务数 */
  maxParallelTasks: z.number().int().positive(),
  /** 运行截止时间（ISO 时间戳） */
  runDeadline: z.string(),
  /** 成本上限（分） */
  costCap: z.number().int().nonnegative(),
}).strict();
export type RunBudget = z.infer<typeof runBudgetSchema>;

/**
 * 默认预算起点（计划 §5.5）。
 * 最终数值在 G0 用真实 Provider 冻结。
 */
export const DEFAULT_ROLE_BUDGETS: Record<AgentRole, RoleBudget> = {
  [AgentRole.GENERATION_SUPERVISOR]: { maxTurns: 16, maxToolCalls: 40, maxConcurrent: 1 },
  [AgentRole.TEXT_EXTRACTOR]: { maxTurns: 3, maxToolCalls: 8, maxConcurrent: 6 },
  [AgentRole.CODE_EXTRACTOR]: { maxTurns: 3, maxToolCalls: 8, maxConcurrent: 6 },
  [AgentRole.VISION_SPECIALIST]: { maxTurns: 3, maxToolCalls: 8, maxConcurrent: 6 },
  [AgentRole.DECK_COMPOSER]: { maxTurns: 3, maxToolCalls: 8, maxConcurrent: 1 },
  [AgentRole.GROUNDING_CRITIC]: { maxTurns: 2, maxToolCalls: 4, maxConcurrent: 1 },
  [AgentRole.REPAIRER]: { maxTurns: 2, maxToolCalls: 6, maxConcurrent: 1 },
} as const;

/**
 * 创建一个带有动态截止时间的默认运行预算。
 *
 * R26 修复：原 DEFAULT_RUN_BUDGET 的 runDeadline 在模块加载时计算一次，
 * 导致服务运行期间所有 run 使用同一截止时间（服务启动 + 30 分钟）。
 * 此函数在每次调用时计算新的截止时间（当前时间 + 30 分钟）。
 */
export function createDefaultRunBudget(): RunBudget {
  return {
    roles: { ...DEFAULT_ROLE_BUDGETS },
    maxProviderCalls: 60,
    maxInputTokens: 2_000_000,
    maxOutputTokens: 500_000,
    maxEmbeddingTokens: 200_000,
    maxParallelTasks: 6,
    runDeadline: new Date(Date.now() + 20 * 60 * 1000).toISOString(), // 20 分钟（对齐 16 turns 预算）
    costCap: 500, // 5.00 元
  };
}

/**
 * 默认运行预算（保持兼容性，但截止时间在模块加载时冻结）。
 *
 * QUAL-53 修复：已移除 deprecated 的 DEFAULT_RUN_BUDGET 常量导出。
 * 新代码必须使用 createDefaultRunBudget() 获取动态截止时间。
 * 原常量在模块加载时冻结 runDeadline，服务长时间运行后使用会导致
 * 截止时间过期，run 可能在第一个 turn 就因 deadline 超时而失败。
 */

// ─── 15. MapContextBundle（计划 §7.1） ───────────────────────────────────

/**
 * 语义上下文 bundle。
 * 一个 primary evidence 必须恰好属于一个 owning bundle；
 * overlap 只能是 contextOnly。
 */
export const mapContextBundleSchema = z.object({
  bundleId: z.string().min(1).max(160),
  memberEvidenceIds: z.array(z.string().min(1).max(160)).min(1),
  contextEvidenceIds: z.array(z.string().min(1).max(160)).default([]),
  sectionPath: z.array(z.string().max(200)).max(12),
  sourceStartOrdinal: z.number().int().min(0),
  tokenEstimate: z.number().int().nonnegative(),
  inputHash: z.string().min(1),
}).strict();
export type MapContextBundle = z.infer<typeof mapContextBundleSchema>;

// ─── 16. 候选与 no-candidate（计划 §9.5） ────────────────────────────────

/** 候选类型：extracted（Extractor 产出）或 canonical（Supervisor 接受/创建） */
export const CandidateKind = {
  EXTRACTED: "extracted",
  CANONICAL: "canonical",
} as const;
export type CandidateKind = (typeof CandidateKind)[keyof typeof CandidateKind];

/** 候选认知类型 */
export const CognitiveType = {
  CONCEPT: "concept",
  COMPARISON: "comparison",
  CAUSAL: "causal",
  PROCEDURE: "procedure",
  BOUNDARY: "boundary",
  CODE: "code",
  FORMULA: "formula",
} as const;
export type CognitiveType = (typeof CognitiveType)[keyof typeof CognitiveType];

/** 候选重要度 */
export const CandidateImportance = {
  CORE: "core",
  SUPPORTING: "supporting",
  DETAIL: "detail",
} as const;
export type CandidateImportance =
  (typeof CandidateImportance)[keyof typeof CandidateImportance];

/** 候选难度（P1-11：质量标准与密度约束） */
export const CandidateDifficulty = {
  BASIC: "basic",
  INTERMEDIATE: "intermediate",
  ADVANCED: "advanced",
} as const;
export type CandidateDifficulty =
  (typeof CandidateDifficulty)[keyof typeof CandidateDifficulty];

/** no-candidate 原因 */
export const NoCandidateReason = {
  METADATA: "metadata",
  DUPLICATE: "duplicate",
  EXAMPLE_ONLY: "example_only",
  DECORATIVE: "decorative",
  NO_LEARNABLE_FACT: "no_learnable_fact",
} as const;
export type NoCandidateReason =
  (typeof NoCandidateReason)[keyof typeof NoCandidateReason];

/** 语义支撑状态 */
export const SemanticSupportStatus = {
  SUPPORTED: "supported",
  PARTIAL: "partial",
  UNSUPPORTED: "unsupported",
  CONTRADICTED: "contradicted",
  PENDING: "pending",
} as const;
export type SemanticSupportStatus =
  (typeof SemanticSupportStatus)[keyof typeof SemanticSupportStatus];

/** 来源验证状态 */
export const SourceVerificationStatus = {
  VERIFIED: "verified",
  HASH_MISMATCH: "hash_mismatch",
  NOT_FOUND: "not_found",
  PENDING: "pending",
} as const;
export type SourceVerificationStatus =
  (typeof SourceVerificationStatus)[keyof typeof SourceVerificationStatus];

// ─── 17. 候选操作（计划 §6.1, §9.5） ─────────────────────────────────────

/** 候选操作类型 */
export const CandidateOperationType = {
  MERGE: "merge",
  EXCLUDE: "exclude",
  CALIBRATE: "calibrate",
  GROUP: "group",
  SPLIT: "split",
  RESTORE: "restore",
  ADJUST_SUPPORT: "adjust_support",
} as const;
export type CandidateOperationType =
  (typeof CandidateOperationType)[keyof typeof CandidateOperationType];

/** 候选操作 schema */
export const candidateOperationSchema = z.object({
  type: z.enum([
    CandidateOperationType.MERGE,
    CandidateOperationType.EXCLUDE,
    CandidateOperationType.CALIBRATE,
    CandidateOperationType.GROUP,
    CandidateOperationType.SPLIT,
    CandidateOperationType.RESTORE,
    CandidateOperationType.ADJUST_SUPPORT,
  ]),
  /** 操作的候选 ID 列表 */
  candidateIds: z.array(z.string().min(1).max(160)).min(1),
  /** 操作原因 code */
  reasonCode: z.string().min(1).max(200),
  /** 合并后的 claim（merge 操作时使用） */
  mergedClaim: z.string().max(500).optional(),
  /** 调整后的重要度（calibrate 操作时使用） */
  adjustedImportance: z.enum([
    CandidateImportance.CORE,
    CandidateImportance.SUPPORTING,
    CandidateImportance.DETAIL,
  ]).optional(),
  /** 调整后的难度（calibrate 操作时使用，P1-11） */
  adjustedDifficulty: z.enum([
    CandidateDifficulty.BASIC,
    CandidateDifficulty.INTERMEDIATE,
    CandidateDifficulty.ADVANCED,
  ]).optional(),
  /** 分组 key（group 操作时使用） */
  groupKey: z.string().max(200).optional(),
  /** 排除原因（exclude 操作时使用） */
  excludeReason: z.string().max(200).optional(),
  /** 证据 union（合并时保留全部 evidence refIds） */
  unionEvidenceRefIds: z.array(z.string().min(1).max(160)).optional(),
  /** split 操作的新 claim 列表（拆分时使用，与 candidateIds 一一对应生成新候选） */
  splitClaims: z.array(z.string().min(1).max(200)).min(1).max(10).optional(),
}).strict();
export type CandidateOperation = z.infer<typeof candidateOperationSchema>;

// ─── 18. Deck Draft（计划 §9.6） ─────────────────────────────────────────

/** Deck 草稿中的卡片定义 */
export const deckCardDraftSchema = z.object({
  /** 草稿内局部 ID */
  draftCardId: z.string().min(1).max(100),
  /** 引用的 canonical candidate IDs */
  canonicalCandidateIds: z.array(z.string().min(1).max(160)).min(1),
  /** 卡片标题 */
  title: z.string().min(1).max(200),
  /** 卡片摘要 */
  summary: z.string().min(1).max(1000),
  /** 摘要支撑候选 IDs（只能引用 owner card 的候选） */
  summarySupportCandidateIds: z.array(z.string().min(1).max(160)).default([]),
  /** 排序序号 */
  ordinal: z.number().int().min(0),
  /** 主章节 */
  primarySection: z.string().max(200),
  /** 分组 key */
  groupKey: z.string().max(200).optional(),
  /** 学习目标（P1-11：每卡一个明确的学习目标，6-200 字） */
  learningObjective: z.string().min(6).max(200),
}).strict();
export type DeckCardDraft = z.infer<typeof deckCardDraftSchema>;

/**
 * Immutable Draft schema。
 * Draft 只插入，不原地更新。Repair 后创建新 Draft，旧 Quality Report 自动失效。
 */
export const deckDraftSchema = z.object({
  /** 草稿版本 */
  draftVersion: z.number().int().min(1),
  /** 父草稿 ID（Repair 后的新草稿指向旧草稿） */
  parentDraftId: z.string().nullable().optional(),
  /** 产生的 Agent unit/event */
  producedByUnitId: z.string().min(1),
  producedByEventKey: z.string().min(1),
  /** schema 版本 */
  schemaVersion: z.string().min(1),
  /** 内容 hash */
  contentHash: z.string().min(1),
  /** 卡片草稿列表 */
  cards: z.array(deckCardDraftSchema).min(1),
  /** Deck 标题 */
  deckTitle: z.string().min(1).max(200),
  /** Deck 摘要 */
  deckSummary: z.string().min(1).max(1000),
  /** 密度 */
  density: z.enum([
    GenerationDensity.OVERVIEW,
    GenerationDensity.STANDARD,
    GenerationDensity.COMPLETE,
  ]),
  /** 卡片预算 */
  cardBudget: z.number().int().positive(),
  /** base ledger hash（提交时的候选账本 hash） */
  baseLedgerHash: z.string().min(1),
}).strict();
export type DeckDraft = z.infer<typeof deckDraftSchema>;

// ─── 19. Critic Report（计划 §4.6, §9.6） ────────────────────────────────

/** Critic issue schema */
export const criticIssueSchema = z.object({
  /** 问题 code */
  code: z.string().min(1).max(200),
  /** 严重程度 */
  severity: z.enum([CriticIssueSeverity.HARD, CriticIssueSeverity.SOFT]),
  /** 关联的候选 ID */
  candidateId: z.string().max(160).optional(),
  /** 关联的卡片草稿 ID */
  cardDraftId: z.string().max(100).optional(),
  /** 关联的证据引用 IDs */
  evidenceRefIds: z.array(z.string().max(160)).default([]),
  /** 支撑判定（可选） */
  verdict: z.enum([
    SupportVerdict.SUPPORTED,
    SupportVerdict.PARTIAL,
    SupportVerdict.UNSUPPORTED,
    SupportVerdict.CONTRADICTED,
  ]).optional(),
  /** 是否可修复 */
  patchable: z.boolean(),
}).strict();
export type CriticIssue = z.infer<typeof criticIssueSchema>;

/** Critic per-claim verdict */
export const criticClaimVerdictSchema = z.object({
  candidateId: z.string().min(1).max(160),
  verdict: z.enum([
    SupportVerdict.SUPPORTED,
    SupportVerdict.PARTIAL,
    SupportVerdict.UNSUPPORTED,
    SupportVerdict.CONTRADICTED,
  ]),
  /** 支撑证据 refIds */
  supportingEvidenceRefIds: z.array(z.string().max(160)).default([]),
  /** 判定理由 code */
  reasonCode: z.string().min(1).max(200),
}).strict();
export type CriticClaimVerdict = z.infer<typeof criticClaimVerdictSchema>;

/**
 * Quality Report schema。
 * Repair 后创建新 Draft，旧 report 自动失效。
 * Publisher 在事务内重新比较全部 hash。
 */
export const qualityReportSchema = z.object({
  /** 关联的 draft hash */
  draftHash: z.string().min(1),
  /** 候选池 hash */
  candidatePoolHash: z.string().min(1),
  /** 来源账本 hash */
  sourceLedgerHash: z.string().min(1),
  /** Critic 版本 */
  criticVersion: z.string().min(1),
  /** 验证器版本 */
  verifierVersion: z.string().min(1),
  /** hard issues */
  hardIssues: z.array(criticIssueSchema).default([]),
  /** soft issues */
  softIssues: z.array(criticIssueSchema).default([]),
  /** 逐 claim 判定 */
  perClaimVerdicts: z.array(criticClaimVerdictSchema).default([]),
  /** 指标 */
  metrics: z.record(z.unknown()).default({}),
  /** Critic 状态 */
  criticStatus: z.enum(["passed", "failed", "pending"]),
  /** 确定性验证状态 */
  deterministicStatus: z.enum(["passed", "failed", "pending"]),
}).strict();
export type QualityReport = z.infer<typeof qualityReportSchema>;

// ─── 20. Repair Patch（计划 §4.7, §6.1） ────────────────────────────────

/** 修复操作类型 */
export const DraftPatchType = {
  REWRITE_CLAIM: "rewrite_claim",
  REWRITE_TITLE: "rewrite_title",
  REWRITE_SUMMARY: "rewrite_summary",
  REMOVE_EVIDENCE: "remove_evidence",
  SPLIT_CANDIDATE: "split_candidate",
  MERGE_CANDIDATE: "merge_candidate",
  MOVE_CANDIDATE: "move_candidate",
  RESTORE_CANDIDATE: "restore_candidate",
  ADJUST_PRIMARY_SUPPORT: "adjust_primary_support",
  ADJUST_GROUP: "adjust_group",
  ADJUST_ORDINAL: "adjust_ordinal",
} as const;
export type DraftPatchType = (typeof DraftPatchType)[keyof typeof DraftPatchType];

/** 修复 patch schema */
export const draftPatchSchema = z.object({
  type: z.enum([
    DraftPatchType.REWRITE_CLAIM,
    DraftPatchType.REWRITE_TITLE,
    DraftPatchType.REWRITE_SUMMARY,
    DraftPatchType.REMOVE_EVIDENCE,
    DraftPatchType.SPLIT_CANDIDATE,
    DraftPatchType.MERGE_CANDIDATE,
    DraftPatchType.MOVE_CANDIDATE,
    DraftPatchType.RESTORE_CANDIDATE,
    DraftPatchType.ADJUST_PRIMARY_SUPPORT,
    DraftPatchType.ADJUST_GROUP,
    DraftPatchType.ADJUST_ORDINAL,
  ]),
  /** 关联的 Critic issue IDs */
  issueIds: z.array(z.string().min(1).max(200)).min(1),
  /** 操作的候选 ID */
  candidateId: z.string().max(160).optional(),
  /** 操作的卡片草稿 ID（源卡片） */
  cardDraftId: z.string().max(100).optional(),
  /** 操作的卡片草稿 ID（目标卡片，仅 move_candidate 使用） */
  targetCardDraftId: z.string().max(100).optional(),
  /** 新 claim 文本 */
  newClaim: z.string().max(500).optional(),
  /** 新标题 */
  newTitle: z.string().max(200).optional(),
  /** 新摘要 */
  newSummary: z.string().max(1000).optional(),
  /** 新分组 key */
  newGroupKey: z.string().max(200).optional(),
  /** 新序号 */
  newOrdinal: z.number().int().min(0).optional(),
  /** 新主支撑 candidate ID */
  newPrimarySupportCandidateId: z.string().max(160).optional(),
  /** 要移除的证据 refIds */
  removedEvidenceRefIds: z.array(z.string().max(160)).optional(),
  /** BUG-18: 修复所基于的 draft hash，用于验证版本一致性 */
  baseDraftHash: z.string().max(200).optional(),
}).strict();
export type DraftPatch = z.infer<typeof draftPatchSchema>;

// ─── 21. 工具幂等键（计划 §6.4） ─────────────────────────────────────────

/**
 * 工具调用幂等键计算参数。
 * SHA256(runId | agentUnitId | turnNo | toolCallId | toolName | argsHash)
 */
export const toolIdempotencyInputSchema = z.object({
  runId: z.string().min(1),
  agentUnitId: z.string().min(1),
  turnNo: z.number().int().min(0),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  argsHash: z.string().min(1),
}).strict();

// ─── 22. 错误分类（计划 §11.1） ──────────────────────────────────────────

/** Agent 错误分类 */
export const AgentErrorClass = {
  /** 408/429/5xx/network — 只重试当前 turn/task */
  TRANSIENT: "transient",
  /** auth/billing/governance/capability — needs_attention，不重试 */
  FATAL: "fatal",
  /** source/asset hash mismatch — terminal integrity failure */
  INTEGRITY: "integrity",
  /** schema/tool protocol error — 一次有提示的纠错 turn，再失败则停止 */
  PROTOCOL: "protocol",
  /** tool 越权/非法参数 — 拒绝、记录安全事件、消耗 turn budget */
  SECURITY: "security",
  /** 预算/截止时间耗尽 — 停止，绝不 partial publish */
  BUDGET_EXHAUSTED: "budget_exhausted",
  /** DB 序列化/死锁 — 有界事务重试 */
  DB_CONTENTION: "db_contention",
} as const;
export type AgentErrorClass =
  (typeof AgentErrorClass)[keyof typeof AgentErrorClass];

/** needs_attention reason code */
export const NeedsAttentionReason = {
  PROVIDER_CAPABILITY_UNSUPPORTED: "provider_capability_unsupported",
  BUDGET_EXHAUSTED: "budget_exhausted",
  REQUIRED_SOURCE_MISSING: "required_source_missing",
  CRITIC_FAILURE: "critic_failure",
  PROTOCOL_ERROR: "protocol_error",
  PROVIDER_FATAL: "provider_fatal",
  INTEGRITY_FAILURE: "integrity_failure",
  MAX_TURNS_EXHAUSTED: "max_turns_exhausted",
  MAX_REPAIR_EXHAUSTED: "max_repair_exhausted",
} as const;
export type NeedsAttentionReason =
  (typeof NeedsAttentionReason)[keyof typeof NeedsAttentionReason];

// ─── 23. 检索模式（计划 §7.4） ────────────────────────────────────────────

/** 向量检索模式 */
export const RetrievalMode = {
  /** 向量 cosine search */
  VECTOR: "vector",
  /** 三元组 lexical search */
  TRIGRAM: "trigram",
  /** 顺序 manifest + lexical search（回退） */
  SEQUENTIAL: "sequential",
  /** 混合模式 */
  HYBRID: "hybrid",
} as const;
export type RetrievalMode = (typeof RetrievalMode)[keyof typeof RetrievalMode];

/** 检索结果 */
export const searchResultSchema = z.object({
  /** 证据 refId */
  evidenceRefId: z.string().min(1).max(160),
  /** 检索模式 */
  retrievalMode: z.enum([
    RetrievalMode.VECTOR,
    RetrievalMode.TRIGRAM,
    RetrievalMode.SEQUENTIAL,
    RetrievalMode.HYBRID,
  ]),
  /** 相似度分数（0-1） */
  score: z.number().min(0).max(1),
  /** 章节路径 */
  sectionPath: z.array(z.string()).default([]),
}).strict();
export type SearchResult = z.infer<typeof searchResultSchema>;

// ─── 24. Agent Task（计划 §5.3，异步子 Agent） ───────────────────────────

/** 子 Agent 任务状态 */
export const AgentTaskStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type AgentTaskStatus =
  (typeof AgentTaskStatus)[keyof typeof AgentTaskStatus];

/** delegate_specialist 创建的子任务规格 */
export const specialistTaskSpecSchema = z.object({
  /** 子 Agent 角色 */
  role: z.enum([
    AgentRole.TEXT_EXTRACTOR,
    AgentRole.CODE_EXTRACTOR,
    AgentRole.VISION_SPECIALIST,
    AgentRole.DECK_COMPOSER,
    AgentRole.GROUNDING_CRITIC,
    AgentRole.REPAIRER,
  ]),
  /** 分配的 bundle IDs */
  bundleIds: z.array(z.string().min(1).max(160)).min(1),
  /** 任务规格（自由结构，由 role 决定） */
  taskSpec: z.record(z.unknown()),
  /** 嵌套深度（固定为 1） */
  depth: z.literal(1),
}).strict();
export type SpecialistTaskSpec = z.infer<typeof specialistTaskSpecSchema>;

// ─── 25. Coverage Report（计划 §7.2, §9.1） ──────────────────────────────

/** 六层 coverage 报告 */
export const coverageReportSchema = z.object({
  sourcePhysicalCoverage: z.number().min(0).max(1),
  bundleAssignmentCoverage: z.number().min(0).max(1),
  explicitDecisionCoverage: z.number().min(0).max(1),
  candidateSurvivalCoverage: z.number().min(0).max(1),
  publishedConceptCoverage: z.number().min(0).max(1),
  capacityExclusions: z.array(z.object({
    candidateId: z.string().min(1).max(160),
    reasonCode: z.string().min(1).max(200),
  })).default([]),
  /** 详细的 bundle 决策列表 */
  bundleDecisions: z.array(z.object({
    bundleId: z.string().min(1).max(160),
    decisionStatus: z.enum([
      BundleDecisionStatus.PENDING,
      BundleDecisionStatus.CANDIDATE_EMITTED,
      BundleDecisionStatus.NO_LEARNABLE_FACT,
      BundleDecisionStatus.MODEL_OMITTED,
      BundleDecisionStatus.PROTOCOL_ERROR,
      BundleDecisionStatus.AUTO_SUPPLEMENTED,
    ]),
    reason: z.string().max(500).optional(),
  })).default([]),
}).strict();
export type CoverageReport = z.infer<typeof coverageReportSchema>;

// ─── 26. 用户可见进度（计划 §12） ─────────────────────────────────────────

/** 用户可见的实时进度 */
export const supervisorProgressSchema = z.object({
  /** 当前阶段 */
  stage: z.enum([
    SupervisorShellStage.PREPARING,
    SupervisorShellStage.GENERATING,
    SupervisorShellStage.CHECKING,
    SupervisorShellStage.PUBLISHING,
  ]),
  /** bundles assigned/decided/required */
  bundlesAssigned: z.number().int().nonnegative(),
  bundlesDecided: z.number().int().nonnegative(),
  bundlesRequired: z.number().int().nonnegative(),
  /** child tasks pending/running/completed */
  childTasksPending: z.number().int().nonnegative(),
  childTasksRunning: z.number().int().nonnegative(),
  childTasksCompleted: z.number().int().nonnegative(),
  /** images completed/required */
  imagesCompleted: z.number().int().nonnegative(),
  imagesRequired: z.number().int().nonnegative(),
  /** candidates/canonical/eligible */
  candidatesExtracted: z.number().int().nonnegative(),
  candidatesCanonical: z.number().int().nonnegative(),
  candidatesEligible: z.number().int().nonnegative(),
  /** draft revision */
  draftRevision: z.number().int().nonnegative(),
  /** critic/repair status */
  criticStatus: z.enum(["pending", "passed", "failed"]).optional(),
  repairStatus: z.enum(["none", "in_progress", "completed", "rejected"]).optional(),
  /** 语义索引模式 */
  semanticIndexMode: z.enum([
    RetrievalMode.VECTOR,
    RetrievalMode.TRIGRAM,
    RetrievalMode.SEQUENTIAL,
    RetrievalMode.HYBRID,
  ]).optional(),
}).strict();
export type SupervisorProgress = z.infer<typeof supervisorProgressSchema>;

// ─── 27. 引擎路由（计划 §12.1） ───────────────────────────────────────────

// ─── 28. 工具名称常量（计划 §6） ─────────────────────────────────────────

/** Supervisor 工具名称 */
export const SupervisorToolName = {
  GET_RUN_MANIFEST: "get_run_manifest",
  GET_NEXT_UNASSIGNED_BUNDLES: "get_next_unassigned_bundles",
  DELEGATE_SPECIALIST: "delegate_specialist",
  READ_AGENT_TASK_RESULTS: "read_agent_task_results",
  ENSURE_SEMANTIC_INDEX: "ensure_semantic_index",
  SEARCH_RELATED_EVIDENCE: "search_related_evidence",
  READ_CANDIDATE_LEDGER: "read_candidate_ledger",
  APPLY_CANDIDATE_OPERATIONS: "apply_candidate_operations",
  SUBMIT_DECK_DRAFT: "submit_deck_draft",
  REQUEST_GROUNDING_REVIEW: "request_grounding_review",
  READ_QUALITY_REPORT: "read_quality_report",
  REQUEST_REPAIR: "request_repair",
  APPLY_DRAFT_PATCH: "apply_draft_patch",
  VALIDATE_DRAFT: "validate_draft",
  REQUEST_VERIFICATION: "request_verification",
} as const;
export type SupervisorToolName =
  (typeof SupervisorToolName)[keyof typeof SupervisorToolName];

/** Extractor 工具名称 */
export const ExtractorToolName = {
  READ_ASSIGNED_BUNDLES: "read_assigned_bundles",
  SEARCH_RELATED_EVIDENCE: "search_related_evidence",
  RECORD_EXTRACTION_DECISIONS: "record_extraction_decisions",
  COMPLETE_AGENT_TASK: "complete_agent_task",
} as const;
export type ExtractorToolName =
  (typeof ExtractorToolName)[keyof typeof ExtractorToolName];

/** Composer 工具名称 */
export const ComposerToolName = {
  READ_CANDIDATE_LEDGER: "read_candidate_ledger",
  SUBMIT_DECK_PROPOSAL: "submit_deck_proposal",
  COMPLETE_AGENT_TASK: "complete_agent_task",
} as const;
export type ComposerToolName =
  (typeof ComposerToolName)[keyof typeof ComposerToolName];

/** Critic 工具名称 */
export const CriticToolName = {
  READ_DRAFT: "read_draft",
  READ_CANDIDATES: "read_candidates",
  READ_EVIDENCE: "read_evidence",
  SUBMIT_QUALITY_REPORT: "submit_quality_report",
  COMPLETE_AGENT_TASK: "complete_agent_task",
} as const;
export type CriticToolName =
  (typeof CriticToolName)[keyof typeof CriticToolName];

/** Repairer 工具名称 */
export const RepairerToolName = {
  READ_ISSUES: "read_issues",
  READ_DRAFT: "read_draft",
  SUBMIT_DRAFT_PATCH: "submit_draft_patch",
  COMPLETE_AGENT_TASK: "complete_agent_task",
} as const;
export type RepairerToolName =
  (typeof RepairerToolName)[keyof typeof RepairerToolName];

// ─── 29. 明确禁止（计划 §6.5） ───────────────────────────────────────────

/**
 * Agent 明确禁止的操作。
 * 以下操作在工具层被拒绝，并记录安全事件。
 */
export const FORBIDDEN_OPERATIONS = [
  "arbitrary_sql",
  "arbitrary_http",
  "shell_execution",
  "filesystem_access",
  "plugin_execution",
  "free_text_regeneration",
  "direct_canonical_write",
  "direct_publish",
  "self_increase_budget",
  "self_relax_gate",
  "child_spawn_agent",
  "dynamic_tool_creation",
] as const;
export type ForbiddenOperation = (typeof FORBIDDEN_OPERATIONS)[number];
