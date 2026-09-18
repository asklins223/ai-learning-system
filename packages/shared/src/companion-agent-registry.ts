import {
  COMPANION_AGENT_CONTRACT_VERSION,
  companionAgentSkillManifestV1Schema,
  companionAgentToolDefinitionV1Schema,
  type CompanionAgentPermissionLevel,
  type CompanionAgentSkillManifestV1,
  type CompanionAgentSettingsV1,
  type CompanionAgentToolDefinitionV1,
} from "./companion-agent-contracts.ts";
import { z } from "zod";

const emptyParameters = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const COMPANION_AGENT_SKILLS: readonly CompanionAgentSkillManifestV1[] = [
  companionAgentSkillManifestV1Schema.parse({
    version: COMPANION_AGENT_CONTRACT_VERSION,
    id: "learning-context",
    skillVersion: "1.0.0",
    name: "学习上下文",
    description: "读取当前学习运行、卡片、图谱和复习上下文。",
    triggerHints: ["进度", "当前学习", "卡片", "图谱", "复习"],
    systemPrompt: "你是学习上下文助手。优先读取当前页面和学习状态，再用简洁、可验证的事实回答。不要猜测数据库中不存在的状态。",
    toolNames: ["companion_read_context", "companion_read_history", "companion_read_memory", "companion_open_card", "companion_open_review", "companion_open_star_map", "companion_open_history"],
    maxSteps: 4,
    outputMaxChars: 20_000,
  }),
  companionAgentSkillManifestV1Schema.parse({
    version: COMPANION_AGENT_CONTRACT_VERSION,
    id: "learning-tutor",
    skillVersion: "1.0.0",
    name: "学习辅导",
    description: "基于授权学习上下文提供解释、提示和任务辅导。",
    triggerHints: ["解释", "提示", "怎么做", "为什么", "辅导"],
    systemPrompt: "你是 grounded learning tutor。仅使用已授权的当前学习上下文和工具结果，不泄露隐藏答案，不越过当前任务边界。",
    toolNames: ["companion_read_context", "companion_request_hint", "companion_open_card"],
    maxSteps: 6,
    outputMaxChars: 20_000,
  }),
  companionAgentSkillManifestV1Schema.parse({
    version: COMPANION_AGENT_CONTRACT_VERSION,
    id: "learning-planner",
    skillVersion: "1.0.0",
    name: "学习计划",
    description: "协助启动、恢复、暂停和规划学习任务。",
    triggerHints: ["开始学习", "继续学习", "暂停", "规划", "延期", "切换"],
    systemPrompt: "你是学习计划助手。先读取当前学习状态，再提出最小、明确的动作。任何会改变学习状态的动作必须使用注册工具并遵守确认策略。",
    toolNames: ["companion_read_context", "companion_start_learning", "companion_resume_learning", "companion_pause_learning", "companion_switch_task_variant", "companion_defer_review", "companion_plan_route"],
    maxSteps: 6,
    outputMaxChars: 20_000,
  }),
  companionAgentSkillManifestV1Schema.parse({
    version: COMPANION_AGENT_CONTRACT_VERSION,
    id: "companion-memory",
    skillVersion: "1.0.0",
    name: "伴星记忆",
    description: "读取对话记忆和伴星资料，并在允许时管理记忆。",
    triggerHints: ["记得", "记忆", "历史", "我的资料"],
    systemPrompt: "你是伴星记忆助手。区分用户明确保存的记忆与系统建议，最小化暴露个人信息，不把推测当成记忆事实。",
    toolNames: ["companion_read_history", "companion_read_memory"],
    maxSteps: 4,
    outputMaxChars: 20_000,
  }),
  companionAgentSkillManifestV1Schema.parse({
    version: COMPANION_AGENT_CONTRACT_VERSION,
    id: "companion-navigation",
    skillVersion: "1.0.0",
    name: "伴星导航",
    description: "打开学习卡片、复习、图谱和对话历史。",
    triggerHints: ["打开", "带我去", "跳转", "查看"],
    systemPrompt: "你是伴星导航助手。只生成已注册的页面路由，不修改学习事实或用户数据。",
    toolNames: ["companion_open_card", "companion_open_review", "companion_open_star_map", "companion_focus_graph", "companion_open_history"],
    maxSteps: 2,
    outputMaxChars: 20_000,
  }),
];

export const COMPANION_AGENT_TOOL_DEFINITIONS: readonly CompanionAgentToolDefinitionV1[] = [
  tool("companion_read_context", "读取当前用户在当前 workspace 的学习上下文。", ["learning-context", "learning-tutor", "learning-planner"], "read", false, emptyParameters),
  tool("companion_read_history", "读取当前伴星对话的有限历史摘要。", ["learning-context", "companion-memory"], "read", false, { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false }),
  tool("companion_read_memory", "读取当前用户已授权的伴星记忆摘要。", ["learning-context", "companion-memory"], "read", false, emptyParameters),
  tool("companion_open_card", "打开一个已存在的学习卡片。", ["learning-context", "learning-tutor", "companion-navigation"], "read", false, { type: "object", properties: { cardId: { type: "string", minLength: 1, maxLength: 120 } }, required: ["cardId"], additionalProperties: false }),
  tool("companion_open_review", "打开复习页面。", ["learning-context", "companion-navigation"], "read", false, emptyParameters),
  tool("companion_open_star_map", "打开知识图谱。", ["learning-context", "companion-navigation"], "read", false, emptyParameters),
  tool("companion_focus_graph", "聚焦知识图谱中的节点。", ["companion-navigation"], "reversible_low", false, { type: "object", properties: { keyPointId: { type: "string", minLength: 1, maxLength: 120 }, lens: { type: "string", enum: ["current_target", "evidence", "provenance", "issues"] } }, required: ["keyPointId", "lens"], additionalProperties: false }),
  tool("companion_open_history", "打开伴星对话历史。", ["learning-context", "companion-memory", "companion-navigation"], "read", false, emptyParameters),
  tool("companion_start_learning", "开始一个新的学习运行。", ["learning-planner"], "consequential", true, { type: "object", properties: {}, additionalProperties: false }),
  tool("companion_resume_learning", "恢复当前学习运行。", ["learning-planner"], "consequential", true, emptyParameters),
  // These actions change learning state or scheduling data. They remain
  // consequential even when reversible, so guided mode must confirm them.
  tool("companion_pause_learning", "暂停当前学习运行。", ["learning-planner"], "consequential", true, { type: "object", properties: { runId: { type: "string", minLength: 1, maxLength: 120 } }, required: ["runId"], additionalProperties: false }),
  tool("companion_request_hint", "请求当前任务的提示。", ["learning-tutor", "learning-planner"], "consequential", true, { type: "object", properties: { runId: { type: "string", minLength: 1, maxLength: 120 }, taskId: { type: "string", minLength: 1, maxLength: 120 }, level: { type: "integer", minimum: 1, maximum: 3 } }, required: ["runId", "taskId", "level"], additionalProperties: false }),
  tool("companion_switch_task_variant", "切换当前任务的题目变体。", ["learning-planner"], "consequential", true, { type: "object", properties: { runId: { type: "string", minLength: 1, maxLength: 120 }, taskId: { type: "string", minLength: 1, maxLength: 120 }, alternativeId: { type: "string", minLength: 1, maxLength: 120 } }, required: ["runId", "taskId", "alternativeId"], additionalProperties: false }),
  tool("companion_defer_review", "延期当前复习提醒。", ["learning-planner"], "consequential", true, { type: "object", properties: { scheduleId: { type: "string", format: "uuid" }, scheduleGeneration: { type: "integer", minimum: 0 }, deferredUntil: { type: "string", format: "date-time" }, reasonCode: { type: "string", enum: ["user_requested", "temporary_unavailable"] } }, required: ["scheduleId", "scheduleGeneration", "deferredUntil", "reasonCode"], additionalProperties: false }),
  tool("companion_plan_route", "规划一条学习理解路线。", ["learning-planner"], "consequential", true, { type: "object", properties: { request: { type: "object" } }, required: ["request"], additionalProperties: false }),
];

function tool(
  name: string,
  description: string,
  skillIds: string[],
  riskClass: CompanionAgentToolDefinitionV1["riskClass"],
  requiresConfirmation: boolean,
  parameters: Record<string, unknown>,
): CompanionAgentToolDefinitionV1 {
  return companionAgentToolDefinitionV1Schema.parse({
    version: COMPANION_AGENT_CONTRACT_VERSION,
    name,
    toolVersion: "1.0.0",
    description,
    parameters,
    skillIds,
    riskClass,
    requiresConfirmation,
    maxInputChars: 4_000,
    maxOutputChars: 4_000,
  });
}

export const COMPANION_AGENT_DEFAULT_SKILL_IDS = Object.freeze(
  COMPANION_AGENT_SKILLS.map((skill) => skill.id),
);

export function resolveCompanionAgentSkills(settings: CompanionAgentSettingsV1): CompanionAgentSkillManifestV1[] {
  const enabled = new Set(settings.enabledSkillIds);
  return COMPANION_AGENT_SKILLS.filter((skill) => enabled.has(skill.id));
}

export function resolveCompanionAgentTools(
  skills: readonly CompanionAgentSkillManifestV1[],
  permission: CompanionAgentPermissionLevel,
): CompanionAgentToolDefinitionV1[] {
  const skillIds = new Set(skills.map((skill) => skill.id));
  return COMPANION_AGENT_TOOL_DEFINITIONS.filter((definition) => {
    if (!definition.skillIds.some((id) => skillIds.has(id))) return false;
    return permission !== "read_only" || definition.riskClass === "read";
  });
}

export function getCompanionAgentSkill(skillId: string): CompanionAgentSkillManifestV1 | null {
  return COMPANION_AGENT_SKILLS.find((skill) => skill.id === skillId) ?? null;
}

export function getCompanionAgentTool(toolName: string): CompanionAgentToolDefinitionV1 | null {
  return COMPANION_AGENT_TOOL_DEFINITIONS.find((toolDefinition) => toolDefinition.name === toolName) ?? null;
}

const uuid = z.string().uuid();
const boundedId = z.string().min(1).max(200);
const companionAgentToolArgumentSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  companion_read_context: z.object({}).strict(),
  companion_read_history: z.object({ limit: z.number().int().min(1).max(20).optional() }).strict(),
  companion_read_memory: z.object({}).strict(),
  companion_open_card: z.object({ cardId: uuid }).strict(),
  companion_open_review: z.object({}).strict(),
  companion_open_star_map: z.object({}).strict(),
  companion_focus_graph: z.object({ keyPointId: uuid, lens: z.enum(["current_target", "evidence", "provenance", "issues"]) }).strict(),
  companion_open_history: z.object({}).strict(),
  companion_start_learning: z.object({}).strict(),
  companion_resume_learning: z.object({}).strict(),
  companion_pause_learning: z.object({ runId: uuid }).strict(),
  companion_request_hint: z.object({ runId: uuid, taskId: uuid, level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).strict(),
  companion_switch_task_variant: z.object({ runId: uuid, taskId: uuid, alternativeId: boundedId }).strict(),
  companion_defer_review: z.object({ scheduleId: uuid, scheduleGeneration: z.number().int().nonnegative(), deferredUntil: z.string().datetime(), reasonCode: z.enum(["user_requested", "temporary_unavailable"]) }).strict(),
  companion_plan_route: z.object({ request: z.record(z.unknown()) }).strict(),
};

export function validateCompanionAgentToolArguments(
  toolName: string,
  args: unknown,
): { success: true; data: Record<string, unknown> } | { success: false; reason: string } {
  const schema = companionAgentToolArgumentSchemas[toolName];
  if (!schema) return { success: false, reason: "unknown tool argument schema" };
  const parsed = schema.safeParse(args);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, reason: "tool arguments failed schema validation" };
}
