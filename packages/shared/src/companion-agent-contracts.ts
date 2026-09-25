/**
 * Companion Agent v1 contracts.
 *
 * 这些合同描述的是**能力**，不是可执行代码：一个工具能声明自己的参数、风险档和
 * 是否需要确认，但不能带来新传输、任意代码或无界操作。
 *
 * 曾经还有一层"技能"（选工具 + 附加策略文本）。它现在整条删除了：工具面每轮全给、
 * 只按权限档过滤（方案 29 §4.1），而"按关键词挑一个技能"正是 90.7% 轮次拿不到
 * 工具的原因。留下一个不参与决策的层，比删掉它更容易骗到下一个读代码的人。
 */

import { z } from "zod";

export const COMPANION_AGENT_CONTRACT_VERSION = 1 as const;
export const COMPANION_AGENT_MAX_STEPS = 8;
export const COMPANION_AGENT_MAX_TOOL_CALLS_PER_STEP = 4;
export const COMPANION_AGENT_MAX_TOOL_CALLS = 12;
export const COMPANION_AGENT_DEADLINE_MS = 120_000;
export const COMPANION_AGENT_TOOL_TIMEOUT_MS = 10_000;

/**
 * 受"图片可以外发"这条政策管的能力档工具。
 *
 * 与权限档无关（读图在 read_only 下也是读），管的是**数据出境**：一张截图里可能
 * 有人脸、门牌、别人的屏幕，所以 `dataPolicy.sendImageContent=false` 时这些工具
 * **根本不下发**——她看不见就不会调，也就不会先答应再看不了。执行层独立再拦一次
 * （见 CompanionAgentToolExecutionConstraints），因为工具名是模型给的。
 */
export const VISION_GATED_COMPANION_TOOL_NAMES: readonly string[] = Object.freeze([
  "companion_read_image",
]);

export function isVisionGatedCompanionTool(toolName: string): boolean {
  return VISION_GATED_COMPANION_TOOL_NAMES.includes(toolName);
}

/**
 * 一轮工具执行的环境约束（权限档之外的那一类：数据能出到哪里）。
 *
 * 只放**必须由服务端判定**的项。她的 `question`/`noteId` 是模型给的，不算约束。
 */
export interface CompanionAgentToolExecutionConstraints {
  /** 用户是否允许把图片发给外部模型（`dataPolicy.sendImageContent`）。 */
  visionEnabled?: boolean;
}

export const companionAgentPermissionLevelSchema = z.enum([
  "read_only",
  "guided",
  "full",
]);
export type CompanionAgentPermissionLevel = z.infer<
  typeof companionAgentPermissionLevelSchema
>;

export const companionAgentRiskClassSchema = z.enum([
  "read",
  "reversible_low",
  "consequential",
  "irreversible",
]);
export type CompanionAgentRiskClass = z.infer<typeof companionAgentRiskClassSchema>;

export const companionAgentToolStatusSchema = z.enum([
  "requested",
  "executing",
  "waiting_confirmation",
  "succeeded",
  "failed",
  "blocked",
  "expired",
]);
export type CompanionAgentToolStatus = z.infer<typeof companionAgentToolStatusSchema>;

export const companionAgentStepKindSchema = z.enum([
  "model",
  "tool",
  "confirmation",
  "final",
  "error",
]);
export type CompanionAgentStepKind = z.infer<typeof companionAgentStepKindSchema>;

export const companionAgentStepStatusSchema = z.enum([
  "running",
  "succeeded",
  "waiting",
  "failed",
  "cancelled",
]);
export type CompanionAgentStepStatus = z.infer<typeof companionAgentStepStatusSchema>;

/**
 * 伴星 agent 的用户设置。只剩权限档。
 *
 * 这里曾有 `enabledSkillIds`（勾哪些技能）。技能层不再参与工具面的发现
 * （方案 29 §4.1：每轮全给、只按权限过滤），那个开关就变成**界面上能勾、
 * 勾了没有任何效果**的东西——留着比删掉更坏，删。
 */
export const companionAgentSettingsV1Schema = z.object({
  version: z.literal(COMPANION_AGENT_CONTRACT_VERSION),
  permissionLevel: companionAgentPermissionLevelSchema,
}).strict();
export type CompanionAgentSettingsV1 = z.infer<typeof companionAgentSettingsV1Schema>;

export const companionAgentToolDefinitionV1Schema = z.object({
  version: z.literal(COMPANION_AGENT_CONTRACT_VERSION),
  name: z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/).max(80),
  toolVersion: z.string().min(1).max(40),
  description: z.string().min(1).max(800),
  parameters: z.record(z.unknown()),
  riskClass: companionAgentRiskClassSchema,
  requiresConfirmation: z.boolean(),
  maxInputChars: z.number().int().positive().max(20_000),
  maxOutputChars: z.number().int().positive().max(20_000),
}).strict();
export type CompanionAgentToolDefinitionV1 = z.infer<
  typeof companionAgentToolDefinitionV1Schema
>;

export const companionAgentToolEventV1Schema = z.object({
  toolCallId: z.string().min(1).max(200),
  name: z.string().min(1).max(80),
  toolVersion: z.string().min(1).max(40),
  riskClass: companionAgentRiskClassSchema,
  status: companionAgentToolStatusSchema,
  safeLabel: z.string().min(1).max(240),
  proposalId: z.string().uuid().optional(),
  safeSummary: z.string().max(240).optional(),
  route: z.record(z.unknown()).optional(),
  /**
   * 客户端可直接执行（2026-09-19 对齐权限分级原设计）。
   *
   * 只在**用户预授权**（permissionLevel = full）且该次执行不需要确认时为 true：
   * 带 route 的读类结果客户端应立即跳转，不再要求点「前往」；chip 仍下发作为留痕。
   * 服务端是唯一的授权判定点——客户端只服从这个标志，不自行判断权限。
   */
  autoExecute: z.boolean().optional(),
}).strict();
export type CompanionAgentToolEventV1 = z.infer<typeof companionAgentToolEventV1Schema>;

export const companionAgentBudgetSnapshotV1Schema = z.object({
  maxSteps: z.number().int().positive().max(COMPANION_AGENT_MAX_STEPS),
  maxToolCallsPerStep: z.literal(COMPANION_AGENT_MAX_TOOL_CALLS_PER_STEP),
  maxToolCalls: z.literal(COMPANION_AGENT_MAX_TOOL_CALLS),
  deadlineMs: z.literal(COMPANION_AGENT_DEADLINE_MS),
}).strict();
export type CompanionAgentBudgetSnapshotV1 = z.infer<
  typeof companionAgentBudgetSnapshotV1Schema
>;

/**
 * 这几条命令的**执行处在提案确认那条路**（`decideCompanionProposal` 按 payload 的 `kind`
 * 分支），worker 侧没有直执行器。
 *
 * 为什么这件事要写在权限判据里：full 档的语义是"这类动作不必每次问她"，
 * 于是 `canUseCompanionAgentTool` 会把 `requiresConfirmation` 判成 false，worker 就直接
 * 去找执行器——找不到，那一轮以一句「这一步我这边还做不了」报错。**结果是权限越高越差**：
 * guided 档这六条出提案卡（能用），full 档反而失败。这条清单就是用来堵那个反差的：
 * 命令由提案路径执行的工具，**任何一档都走提案**，worker 不去直执行它们。
 *
 * 这**不等于** full 档已经"免确认"——提案卡仍然要点一下。真正的服务端自动确认还欠着
 * （它是 39d #16 剩下的那半步，要 API 侧在自己进程里确认同一份提案，不能拿"我权限高"
 * 去绕开唯一的那个执行处）。
 */
export const COMPANION_PROPOSAL_EXECUTED_TOOLS: ReadonlySet<string> = new Set([
  "companion_start_learning",
  "companion_resume_learning",
  "companion_pause_learning",
  "companion_switch_task_variant",
  "companion_request_hint",
  "companion_defer_review",
]);

export function canUseCompanionAgentTool(
  permission: CompanionAgentPermissionLevel,
  definition: Pick<CompanionAgentToolDefinitionV1, "riskClass" | "requiresConfirmation" | "name">,
): { allowed: boolean; requiresConfirmation: boolean; reason?: string } {
  if (definition.riskClass === "read") {
    return { allowed: true, requiresConfirmation: false };
  }
  if (permission === "read_only") {
    return { allowed: false, requiresConfirmation: false, reason: "agent permission is read_only" };
  }
  if (definition.riskClass === "irreversible") {
    return { allowed: true, requiresConfirmation: true };
  }
  // 命令本体只在提案那条路执行的工具：直执行会撞「没有执行器」，所以 full 档也出提案。
  // 放在 guided 分支**之前**——否则 guided 只是恰好也返回 true，看不出这条规则在管什么。
  if (COMPANION_PROPOSAL_EXECUTED_TOOLS.has(definition.name)) {
    return { allowed: true, requiresConfirmation: true };
  }
  if (permission === "guided") {
    const requiresConfirmation = definition.riskClass !== "reversible_low"
      || definition.requiresConfirmation;
    return { allowed: true, requiresConfirmation };
  }
  // full = 用户预授权（2026-09-19 对齐产品原设计：权限分级就是用户的授权开关）。
  // 用户把权限开到 full，就表示"这类动作不必每次都问我"——工具直接执行，
  // 路由类结果直接自动跳转（见 companionAgentRouteEventV1.autoExecute）。
  // 安全底线只有一条：irreversible 已在上方被拦下（无论授权到哪一档都要人点头）。
  return { allowed: true, requiresConfirmation: false };
}
