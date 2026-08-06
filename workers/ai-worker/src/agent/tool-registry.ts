/**
 * Agent 工具注册表（计划 §6）
 *
 * P1-07 修复：以 Zod schema 为唯一真相源，自动生成 provider JSON Schema。
 * 禁止手写两套漂移定义。所有嵌套对象 additionalProperties: false。
 *
 * 职责：
 * - 按 Agent role 维护工具 allowlist，默认拒绝
 * - 提供工具 schema 供 provider 使用（从 Zod 自动生成）
 * - 验证工具参数（由 executor 调用 safeParse）
 * - 工具幂等键计算
 *
 * 不变量（G5, G6, §6.5）：
 * - Supervisor 可以选择专家、顺序、批次，但不能修改 coverage/tool allowlist/budget/repair limit/critic requirement
 * - child Agent depth=1，不能继续 delegate 或 spawn Agent
 * - 任意 SQL/HTTP/shell/文件系统/插件被明确禁止
 */

import { createHash } from "node:crypto";
import type { ZodTypeAny } from "zod";
import type {
  AgentRole,
  AgentTurnRequest,
} from "@ailearn/shared";
import {
  SupervisorToolName as SupervisorTools,
  ExtractorToolName as ExtractorTools,
  ComposerToolName as ComposerTools,
  CriticToolName as CriticTools,
  RepairerToolName as RepairerTools,
  TOOL_SCHEMA_VERSION,
} from "@ailearn/shared";
import { TOOL_ZOD_SCHEMAS } from "./tools/schemas.ts";
import { zodToJsonSchema } from "./tools/zod-to-json-schema.ts";

/** 工具定义 */
export interface ToolDefinition {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 工具参数 JSON schema（从 Zod 自动生成） */
  parameters: Record<string, unknown>;
  /** 工具参数 Zod schema（运行时校验用） */
  zodSchema: ZodTypeAny;
  /** 工具版本 */
  version: string;
  /** 是否有副作用（需要幂等） */
  hasSideEffect: boolean;
}

/**
 * 从 Zod schema 创建工具定义。
 *
 * JSON Schema 从 Zod 自动生成，确保两者不会漂移。
 */
function makeToolDef(
  name: string,
  description: string,
  zodSchema: ZodTypeAny,
  hasSideEffect: boolean,
): ToolDefinition {
  return {
    name,
    description,
    parameters: zodToJsonSchema(zodSchema),
    zodSchema,
    version: TOOL_SCHEMA_VERSION,
    hasSideEffect,
  };
}

/** 获取工具的 Zod schema（如不存在返回 null） */
export function getToolZodSchema(toolName: string): ZodTypeAny | null {
  return TOOL_ZOD_SCHEMAS[toolName] ?? null;
}

/**
 * 计算 tool call 的幂等键（计划 §6.4）。
 * SHA256(runId | agentUnitId | turnNo | toolCallId | toolName | argsHash)
 */
export function computeToolIdempotencyKey(input: {
  runId: string;
  agentUnitId: string;
  turnNo: number;
  toolCallId: string;
  toolName: string;
  argsHash: string;
}): string {
  const raw = `${input.runId}|${input.agentUnitId}|${input.turnNo}|${input.toolCallId}|${input.toolName}|${input.argsHash}`;
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * 计算工具参数的 hash。
 *
 * 使用递归排序的确定性 JSON 序列化，确保嵌套对象 key 顺序不影响 hash。
 * null/undefined 安全。
 */
export function computeArgsHash(args: unknown): string {
  const json = stableJsonStringify(args);
  return createHash("sha256").update(json, "utf8").digest("hex");
}

/**
 * 递归排序的确定性 JSON 序列化。
 *
 * - 对象 key 按字典序排序
 * - 数组保持顺序不变
 * - null/undefined 输出为 null
 * - 其他类型直接序列化
 */
function stableJsonStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => stableJsonStringify(v));
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort((a, b) => a[0].localeCompare(b[0]));
    const pairs = entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJsonStringify(v)}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}

// ─── Supervisor 工具定义（计划 §6.1） ────────────────────────────────────

const supervisorToolDefinitions: Record<string, ToolDefinition> = {
  [SupervisorTools.GET_RUN_MANIFEST]: makeToolDef(
    SupervisorTools.GET_RUN_MANIFEST,
    "读取 outline、预算、coverage/task 摘要。不返回无界全文。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.GET_RUN_MANIFEST]!,
    false,
  ),
  [SupervisorTools.GET_NEXT_UNASSIGNED_BUNDLES]: makeToolDef(
    SupervisorTools.GET_NEXT_UNASSIGNED_BUNDLES,
    "顺序领取未处理 required bundles。游标签名；不能跳号或改 ownership。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.GET_NEXT_UNASSIGNED_BUNDLES]!,
    true,
  ),
  [SupervisorTools.DELEGATE_SPECIALIST]: makeToolDef(
    SupervisorTools.DELEGATE_SPECIALIST,
    "异步创建子 Agent。role allowlist、depth=1、幂等、预算。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.DELEGATE_SPECIALIST]!,
    true,
  ),
  [SupervisorTools.READ_AGENT_TASK_RESULTS]: makeToolDef(
    SupervisorTools.READ_AGENT_TASK_RESULTS,
    "读取已完成子任务。只能读取当前 Supervisor 的 children。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.READ_AGENT_TASK_RESULTS]!,
    false,
  ),
  [SupervisorTools.ENSURE_SEMANTIC_INDEX]: makeToolDef(
    SupervisorTools.ENSURE_SEMANTIC_INDEX,
    "异步补齐派生 embedding。失败可回退，不改变 coverage。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.ENSURE_SEMANTIC_INDEX]!,
    true,
  ),
  [SupervisorTools.SEARCH_RELATED_EVIDENCE]: makeToolDef(
    SupervisorTools.SEARCH_RELATED_EVIDENCE,
    "vector + lexical 关联召回。当前 sealed noteVersion；返回 exact refs。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.SEARCH_RELATED_EVIDENCE]!,
    false,
  ),
  [SupervisorTools.READ_CANDIDATE_LEDGER]: makeToolDef(
    SupervisorTools.READ_CANDIDATE_LEDGER,
    "读取候选和 ledger hash。确定性分页。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.READ_CANDIDATE_LEDGER]!,
    false,
  ),
  [SupervisorTools.APPLY_CANDIDATE_OPERATIONS]: makeToolDef(
    SupervisorTools.APPLY_CANDIDATE_OPERATIONS,
    "merge/exclude/calibrate/group。typed ops、evidence union、矛盾保护。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.APPLY_CANDIDATE_OPERATIONS]!,
    true,
  ),
  [SupervisorTools.SUBMIT_DECK_DRAFT]: makeToolDef(
    SupervisorTools.SUBMIT_DECK_DRAFT,
    "提交 immutable Deck Draft。density 和 cardBudget 为必填字段，由服务端冻结。每张卡片必须引用至少一个候选 ID。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.SUBMIT_DECK_DRAFT]!,
    true,
  ),
  [SupervisorTools.REQUEST_GROUNDING_REVIEW]: makeToolDef(
    SupervisorTools.REQUEST_GROUNDING_REVIEW,
    "异步创建强制 Critic。Critic role 独立，重复调用幂等。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.REQUEST_GROUNDING_REVIEW]!,
    true,
  ),
  [SupervisorTools.READ_QUALITY_REPORT]: makeToolDef(
    SupervisorTools.READ_QUALITY_REPORT,
    "读取 Critic report。draftHash 必须完全匹配。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.READ_QUALITY_REPORT]!,
    false,
  ),
  [SupervisorTools.REQUEST_REPAIR]: makeToolDef(
    SupervisorTools.REQUEST_REPAIR,
    "创建一次 Repair task。repairCount=0 且 issue patchable。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.REQUEST_REPAIR]!,
    true,
  ),
  [SupervisorTools.APPLY_DRAFT_PATCH]: makeToolDef(
    SupervisorTools.APPLY_DRAFT_PATCH,
    "生成新 immutable Draft。typed patch、CAS、旧 report 失效。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.APPLY_DRAFT_PATCH]!,
    true,
  ),
  [SupervisorTools.VALIDATE_DRAFT]: makeToolDef(
    SupervisorTools.VALIDATE_DRAFT,
    "deterministic preflight。不产生语义 verdict。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.VALIDATE_DRAFT]!,
    false,
  ),
  [SupervisorTools.REQUEST_VERIFICATION]: makeToolDef(
    SupervisorTools.REQUEST_VERIFICATION,
    "关闭 Supervisor 并进入 VERIFY。coverage、Critic、budget 前置检查。",
    TOOL_ZOD_SCHEMAS[SupervisorTools.REQUEST_VERIFICATION]!,
    true,
  ),
};

// ─── Extractor 工具定义（计划 §6.2） ─────────────────────────────────────

const extractorToolDefinitions: Record<string, ToolDefinition> = {
  [ExtractorTools.READ_ASSIGNED_BUNDLES]: makeToolDef(
    ExtractorTools.READ_ASSIGNED_BUNDLES,
    "读取分配给自己的 bundles。",
    TOOL_ZOD_SCHEMAS[ExtractorTools.READ_ASSIGNED_BUNDLES]!,
    false,
  ),
  [ExtractorTools.SEARCH_RELATED_EVIDENCE]: supervisorToolDefinitions[SupervisorTools.SEARCH_RELATED_EVIDENCE],
  [ExtractorTools.RECORD_EXTRACTION_DECISIONS]: makeToolDef(
    ExtractorTools.RECORD_EXTRACTION_DECISIONS,
    "记录抽取决策：candidates 或 no-candidate。每个 candidate 必须有 claim、cognitiveType、importance、evidenceRefIds。",
    TOOL_ZOD_SCHEMAS[ExtractorTools.RECORD_EXTRACTION_DECISIONS]!,
    true,
  ),
  [ExtractorTools.COMPLETE_AGENT_TASK]: makeToolDef(
    ExtractorTools.COMPLETE_AGENT_TASK,
    "完成当前 Agent 任务。",
    TOOL_ZOD_SCHEMAS[ExtractorTools.COMPLETE_AGENT_TASK]!,
    true,
  ),
};

// ─── Composer 工具定义（计划 §6.3） ──────────────────────────────────────

const composerToolDefinitions: Record<string, ToolDefinition> = {
  [ComposerTools.READ_CANDIDATE_LEDGER]: supervisorToolDefinitions[SupervisorTools.READ_CANDIDATE_LEDGER],
  // R52: Composer 也需要 submit_deck_draft，使 Supervisor 委派后可直接提交 Deck Draft
  [SupervisorTools.SUBMIT_DECK_DRAFT]: supervisorToolDefinitions[SupervisorTools.SUBMIT_DECK_DRAFT],
  [ComposerTools.SUBMIT_DECK_PROPOSAL]: makeToolDef(
    ComposerTools.SUBMIT_DECK_PROPOSAL,
    "提交 deck proposal（Supervisor 接受或调整）。proposal 包含 density、cardBudget、cards 等必填字段。",
    TOOL_ZOD_SCHEMAS[ComposerTools.SUBMIT_DECK_PROPOSAL]!,
    true,
  ),
  [ComposerTools.COMPLETE_AGENT_TASK]: extractorToolDefinitions[ExtractorTools.COMPLETE_AGENT_TASK],
};

// ─── Critic 工具定义（计划 §6.3） ────────────────────────────────────────

const criticToolDefinitions: Record<string, ToolDefinition> = {
  [CriticTools.READ_DRAFT]: makeToolDef(
    CriticTools.READ_DRAFT,
    "只读 Draft。",
    TOOL_ZOD_SCHEMAS[CriticTools.READ_DRAFT]!,
    false,
  ),
  [CriticTools.READ_CANDIDATES]: makeToolDef(
    CriticTools.READ_CANDIDATES,
    "只读候选。",
    TOOL_ZOD_SCHEMAS[CriticTools.READ_CANDIDATES]!,
    false,
  ),
  [CriticTools.READ_EVIDENCE]: makeToolDef(
    CriticTools.READ_EVIDENCE,
    "只读 exact evidence。",
    TOOL_ZOD_SCHEMAS[CriticTools.READ_EVIDENCE]!,
    false,
  ),
  [CriticTools.SUBMIT_QUALITY_REPORT]: makeToolDef(
    CriticTools.SUBMIT_QUALITY_REPORT,
    "提交 Quality Report。perClaimVerdicts 至少 1 个 verdict，criticStatus 必填。空 verdict 将被拒绝。",
    TOOL_ZOD_SCHEMAS[CriticTools.SUBMIT_QUALITY_REPORT]!,
    true,
  ),
  [CriticTools.COMPLETE_AGENT_TASK]: extractorToolDefinitions[ExtractorTools.COMPLETE_AGENT_TASK],
};

// ─── Repairer 工具定义（计划 §6.3） ──────────────────────────────────────

const repairerToolDefinitions: Record<string, ToolDefinition> = {
  // Repairer 只提供 submit_draft_patch 与 complete_agent_task。
  // read_issues / read_draft 已移除：修复所需数据（issues/draft/candidates）全部内联在
  // 用户消息中（见 buildRepairerSystemPrompt）。原实现允许模型调用这两个只读工具，但
  // Repairer 是单次 provider turn（executeRepairTurn），工具调用既不执行也不回传结果，
  // 模型反复调用 read_issues/read_draft 后永远拿不到数据 → 无法提交 submit_draft_patch →
  // 空转直到 budget_exhausted。移除后模型只能调用 submit_draft_patch，配合内联数据即可修复。
  [RepairerTools.SUBMIT_DRAFT_PATCH]: makeToolDef(
    RepairerTools.SUBMIT_DRAFT_PATCH,
    "提交 typed patch proposal。每个 patch 必须有 type 和 issueIds。",
    TOOL_ZOD_SCHEMAS[RepairerTools.SUBMIT_DRAFT_PATCH]!,
    true,
  ),
  [RepairerTools.COMPLETE_AGENT_TASK]: extractorToolDefinitions[ExtractorTools.COMPLETE_AGENT_TASK],
};

// ─── 角色到工具的映射（计划 §6, allowlist） ──────────────────────────────

const ROLE_TOOL_MAP: Record<AgentRole, Record<string, ToolDefinition>> = {
  generation_supervisor: supervisorToolDefinitions,
  text_extractor: extractorToolDefinitions,
  code_extractor: extractorToolDefinitions,
  vision_specialist: extractorToolDefinitions,
  deck_composer: composerToolDefinitions,
  grounding_critic: criticToolDefinitions,
  repairer: repairerToolDefinitions,
};

/**
 * Agent 工具注册表。
 * 按 Agent role 维护工具 allowlist，默认拒绝。
 */
export class ToolRegistry {
  /** 获取角色的工具 allowlist */
  getToolsForRole(role: AgentRole): ToolDefinition[] {
    const tools = ROLE_TOOL_MAP[role] ?? {};
    return Object.values(tools);
  }

  /** 获取角色的工具 schema（供 provider 使用） */
  getToolSchemasForRole(role: AgentRole): AgentTurnRequest["tools"] {
    return this.getToolsForRole(role).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /** 检查工具是否允许该角色使用 */
  isToolAllowed(role: AgentRole, toolName: string): boolean {
    const tools = ROLE_TOOL_MAP[role] ?? {};
    return toolName in tools;
  }

  /** 获取工具定义 */
  getToolDefinition(role: AgentRole, toolName: string): ToolDefinition | null {
    const tools = ROLE_TOOL_MAP[role] ?? {};
    return tools[toolName] ?? null;
  }

  /** 获取角色允许的所有工具名称 */
  getAllowedToolNames(role: AgentRole): string[] {
    const tools = ROLE_TOOL_MAP[role] ?? {};
    return Object.keys(tools);
  }
}

/** 单例工具注册表 */
export const toolRegistry = new ToolRegistry();
