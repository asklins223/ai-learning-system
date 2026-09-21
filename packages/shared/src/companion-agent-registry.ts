import { z } from "zod";
import {
  COMPANION_AGENT_CONTRACT_VERSION,
  companionAgentToolDefinitionV1Schema,
  type CompanionAgentPermissionLevel,
  type CompanionAgentToolDefinitionV1,
} from "./companion-agent-contracts.ts";

const emptyParameters = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const emptyArguments = z.object({}).strict();
const uuid = z.string().uuid();

/**
 * 一个工具 = 一份模型可见的 JSON schema + 一份服务端 zod 校验，**成对声明**。
 *
 * 以前它们是两份清单（`COMPANION_AGENT_TOOL_DEFINITIONS` 与
 * `companionAgentToolArgumentSchemas`），靠人记得同步。漏一条的后果不是编译期报错，
 * 而是 `validateCompanionAgentToolArguments` 落到 "unknown tool argument schema"——
 * 她看得见这个工具、也会去调、每一调必败。上一批新加的 3 个提醒工具就是这么
 * 上线即坏的（没人调用，所以没人看见）。现在两者出自同一个 `tool()` 调用，
 * 少传第二个参数是类型错误。
 */
interface RegisteredTool {
  readonly definition: CompanionAgentToolDefinitionV1;
  readonly argumentSchema: z.ZodType<Record<string, unknown>>;
}

function tool(
  name: string,
  description: string,
  riskClass: CompanionAgentToolDefinitionV1["riskClass"],
  requiresConfirmation: boolean,
  parameters: Record<string, unknown>,
  argumentSchema: z.ZodType<Record<string, unknown>>,
): RegisteredTool {
  return {
    definition: companionAgentToolDefinitionV1Schema.parse({
      version: COMPANION_AGENT_CONTRACT_VERSION,
      name,
      toolVersion: "1.0.0",
      description,
      parameters,
      riskClass,
      requiresConfirmation,
      maxInputChars: 4_000,
      maxOutputChars: 4_000,
    }),
    argumentSchema,
  };
}

const REGISTERED_TOOLS: readonly RegisteredTool[] = [
  tool("companion_read_context", "读取当前用户在当前 workspace 的学习上下文。", "read", false, emptyParameters, emptyArguments),
  tool("companion_read_history", "读取当前伴星对话的有限历史摘要。", "read", false, { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false }, z.object({ limit: z.number().int().min(1).max(20).optional() }).strict()),
  // 系统敞开面（方案 29 §4.2，抱怨 #5/#6「连跳到某个笔记都做不到、看不到学习数据、
  // 看不到任务队列」）。这些不是"锦上添花的工具"：没有它们，她能说的只有闲聊。
  // 描述统一写成"什么时候该调"，因为工具描述是她唯一能看到的用法说明。
  tool("companion_search_notes", "按关键词搜用户的笔记标题与正文，返回笔记 id/标题/时间。用户问「我之前记过什么」或要跳到某篇笔记时先用它。", "read", false, { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 120 }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"], additionalProperties: false }, z.object({ query: z.string().min(1).max(120), limit: z.number().int().min(1).max(10).optional() }).strict()),
  tool("companion_read_note", "读出一篇笔记的正文内容（截断到几千字）。要引用、总结或核对用户写过什么时必须先读，不要凭标题猜内容。", "read", false, { type: "object", properties: { noteId: { type: "string", format: "uuid" } }, required: ["noteId"], additionalProperties: false }, z.object({ noteId: uuid }).strict()),
  tool("companion_open_note", "跳到用户的一篇笔记（在应用里打开它）。", "read", false, { type: "object", properties: { noteId: { type: "string", format: "uuid" } }, required: ["noteId"], additionalProperties: false }, z.object({ noteId: uuid }).strict()),
  tool("companion_open_page", "跳到应用里的某个页面。用户说「打开复习」「去看看星图」时调用。", "read", false, { type: "object", properties: { page: { type: "string", enum: ["home", "today", "review", "star_map", "conversation", "source", "settings"] } }, required: ["page"], additionalProperties: false }, z.object({ page: z.enum(["home", "today", "review", "star_map", "conversation", "source", "settings"]) }).strict()),
  tool("companion_get_learning_stats", "读取学习数据统计：今天/本周学了多久、到期复习数、活跃卡片数、笔记数等（与首页同一口径）。用户问「我今天学了多少」时调用。", "read", false, emptyParameters, emptyArguments),
  tool("companion_list_task_queue", "列出当前学习运行里排着的任务（含进度和第几步）。用户问「我接下来要做什么」「还有什么任务」时调用。", "read", false, emptyParameters, emptyArguments),
  tool("companion_list_due_reviews", "列出到期（或快到期）的复习卡，带卡片标题和到期时间。用户问「有什么要复习的」时调用。", "read", false, { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false }, z.object({ limit: z.number().int().min(1).max(20).optional() }).strict()),
  tool("companion_open_card", "打开一个已存在的学习卡片。", "read", false, { type: "object", properties: { cardId: { type: "string", minLength: 1, maxLength: 120 } }, required: ["cardId"], additionalProperties: false }, z.object({ cardId: uuid }).strict()),
  tool("companion_focus_graph", "聚焦知识图谱中的节点。", "reversible_low", false, { type: "object", properties: { keyPointId: { type: "string", minLength: 1, maxLength: 120 }, lens: { type: "string", enum: ["current_target", "evidence", "provenance", "issues"] } }, required: ["keyPointId", "lens"], additionalProperties: false }, z.object({ keyPointId: uuid, lens: z.enum(["current_target", "evidence", "provenance", "issues"]) }).strict()),
  tool("companion_start_learning", "开始一个新的学习运行。", "consequential", true, emptyParameters, emptyArguments),
  tool("companion_resume_learning", "恢复当前学习运行。", "consequential", true, emptyParameters, emptyArguments),
  // 以下动作改学习状态或排程数据：即使可逆也算 consequential，guided 档必须确认。
  tool("companion_pause_learning", "暂停当前学习运行。", "consequential", true, { type: "object", properties: { runId: { type: "string", minLength: 1, maxLength: 120 } }, required: ["runId"], additionalProperties: false }, z.object({ runId: uuid }).strict()),
  tool("companion_request_hint", "请求当前任务的提示。", "consequential", true, { type: "object", properties: { runId: { type: "string", minLength: 1, maxLength: 120 }, taskId: { type: "string", minLength: 1, maxLength: 120 }, level: { type: "integer", minimum: 1, maximum: 3 } }, required: ["runId", "taskId", "level"], additionalProperties: false }, z.object({ runId: uuid, taskId: uuid, level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }).strict()),
  tool("companion_switch_task_variant", "切换当前任务的题目变体。", "consequential", true, { type: "object", properties: { runId: { type: "string", minLength: 1, maxLength: 120 }, taskId: { type: "string", minLength: 1, maxLength: 120 }, alternativeId: { type: "string", minLength: 1, maxLength: 120 } }, required: ["runId", "taskId", "alternativeId"], additionalProperties: false }, z.object({ runId: uuid, taskId: uuid, alternativeId: z.string().min(1).max(200) }).strict()),
  tool("companion_defer_review", "延期当前复习提醒。", "consequential", true, { type: "object", properties: { scheduleId: { type: "string", format: "uuid" }, scheduleGeneration: { type: "integer", minimum: 0 }, deferredUntil: { type: "string", format: "date-time" }, reasonCode: { type: "string", enum: ["user_requested", "temporary_unavailable"] } }, required: ["scheduleId", "scheduleGeneration", "deferredUntil", "reasonCode"], additionalProperties: false }, z.object({ scheduleId: uuid, scheduleGeneration: z.number().int().nonnegative(), deferredUntil: z.string().datetime(), reasonCode: z.enum(["user_requested", "temporary_unavailable"]) }).strict()),
  tool("companion_plan_route", "规划一条学习理解路线。", "consequential", true, { type: "object", properties: { request: { type: "object" } }, required: ["request"], additionalProperties: false }, z.object({ request: z.record(z.unknown()) }).strict()),
  // auto-set / auto-fill（2026-09-19 权限分级对齐原设计）：可逆的低风险写入。
  // requiresConfirmation=true 使 guided 档仍走提案确认；full 档视用户预授权直接执行。
  // kind 枚举与 assistant_memory_items.kind 的 DB CHECK 约束同源（见迁移）。
  tool("companion_save_memory", "把用户明确要求记住的内容保存为伴星记忆。", "reversible_low", true, { type: "object", properties: { kind: { type: "string", enum: ["preference", "goal", "learning_context", "interaction_note", "episodic"] }, content: { type: "string", minLength: 1, maxLength: 200 } }, required: ["kind", "content"], additionalProperties: false }, z.object({ kind: z.enum(["preference", "goal", "learning_context", "interaction_note", "episodic"]), content: z.string().min(1).max(200) }).strict()),
  tool("companion_set_activeness", "设置伴星的活跃度（quiet=安静 / moderate=适中 / active=活跃）。", "reversible_low", true, { type: "object", properties: { activeness: { type: "string", enum: ["quiet", "moderate", "active"] } }, required: ["activeness"], additionalProperties: false }, z.object({ activeness: z.enum(["quiet", "moderate", "active"]) }).strict()),
  // 定时提醒（方案 29 §4.6，抱怨 #9）。fireAtLocal 收**用户本地挂钟时间**而不是
  // ISO UTC 时刻：模型算时区一定会错（差 8 小时那种），而"明早九点"本来就是人的说法。
  // 换算在服务端按账号时区做（这里挡住 ISO/UTC 写法，否则她会两种格式混发）。
  // 可逆、低风险、不改学习状态 → guided 档也直接执行：用户刚亲口说的"提醒我"，
  // 再弹一次"确定吗"是噪音。
  tool("companion_schedule_reminder", "在用户指定的时间主动提醒他一件事。用户说「提醒我三点开会」时调用。", "reversible_low", false, { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 200 }, fireAtLocal: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2})?$" } }, required: ["text", "fireAtLocal"], additionalProperties: false }, z.object({ text: z.string().min(1).max(200), fireAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/) }).strict()),
  tool("companion_list_reminders", "查看还没有兑现的提醒（含原定时间）。", "read", false, emptyParameters, emptyArguments),
  tool("companion_cancel_reminder", "取消一条还没兑现的提醒；不给 reminderId 就取消最近的那条。", "reversible_low", false, { type: "object", properties: { reminderId: { type: "string", format: "uuid" } }, additionalProperties: false }, z.object({ reminderId: uuid.optional() }).strict()),
  // 记忆与活动流（方案 29 §4.3/§4.4，抱怨 #3/#6）。
  // `companion_read_memory` 已删除：它返回的就是本轮已经注入 prompt 的那一份记忆，
  // 调一次等于把看过的东西再看一遍——她以为自己在"回忆"，其实什么都没查到。
  tool("companion_recall_memory", "按关键词或语义再检索一批记忆，返回本轮还没注入的那些。用户问「你还记得我说过什么」而当前上下文里没有时调用。", "read", false, { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 8 } }, required: ["query"], additionalProperties: false }, z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(8).optional() }).strict()),
  tool("companion_forget_memory", "删掉一条记忆。用户明确说「忘掉这条」「别记着」时调用；先 recall 拿到 memoryId 再删，不要凭印象猜 id。", "reversible_low", false, { type: "object", properties: { memoryId: { type: "string", format: "uuid" } }, required: ["memoryId"], additionalProperties: false }, z.object({ memoryId: uuid }).strict()),
  tool("companion_list_recent_activity", "列出用户最近在系统里做过什么：写或改过的笔记、完成的复习、新增的卡片、到点兑现的提醒。用户问「我最近在忙什么」时调用。", "read", false, { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 30 } }, additionalProperties: false }, z.object({ days: z.number().int().min(1).max(30).optional() }).strict()),
  tool("companion_set_boundary", "调整伴星的行为边界：是否可以玩趣、是否催学习、是否带语音情绪标签、口头禅。用户说「别催我学习」时调用。", "reversible_low", false, { type: "object", properties: { allowPlayful: { type: "boolean" }, allowNudgeLearning: { type: "boolean" }, allowVoiceTags: { type: "boolean" }, catchphrase: { type: "string", minLength: 1, maxLength: 30 } }, additionalProperties: false }, z.object({ allowPlayful: z.boolean().optional(), allowNudgeLearning: z.boolean().optional(), allowVoiceTags: z.boolean().optional(), catchphrase: z.string().min(1).max(30).optional() }).strict()),
];

export const COMPANION_AGENT_TOOL_DEFINITIONS: readonly CompanionAgentToolDefinitionV1[] =
  Object.freeze(REGISTERED_TOOLS.map((registered) => registered.definition));

export const COMPANION_AGENT_TOOL_NAMES: readonly string[] = Object.freeze(
  REGISTERED_TOOLS.map((registered) => registered.definition.name),
);

const ARGUMENT_SCHEMAS = new Map<string, z.ZodType<Record<string, unknown>>>(
  REGISTERED_TOOLS.map((registered) => [registered.definition.name, registered.argumentSchema]),
);

/**
 * 扁平工具面（方案 29 §4.1）：**每轮全部提供，只按权限档过滤**。
 *
 * 这是取代 `selectSkill()` 的那一刀。原先工具面 = 关键词命中的那**一个**技能的
 * `toolNames`，没命中就是空工具面 + 单步——基线实测 90.7% 的轮次一个工具都没有，
 * 于是"读记忆/看系统状态/跳转"这些能力不是被拒，而是**根本没出现在她面前**。
 *
 * 权限三档（`read_only`/`guided`/`full`）是真正的安全边界，保留：它只**过滤**工具，
 * 从不参与"这一轮能看见什么"的发现过程。
 */
export function resolveAllCompanionAgentTools(
  permission: CompanionAgentPermissionLevel,
): CompanionAgentToolDefinitionV1[] {
  return COMPANION_AGENT_TOOL_DEFINITIONS.filter(
    (definition) => permission !== "read_only" || definition.riskClass === "read",
  );
}

export function getCompanionAgentTool(toolName: string): CompanionAgentToolDefinitionV1 | null {
  return COMPANION_AGENT_TOOL_DEFINITIONS.find((toolDefinition) => toolDefinition.name === toolName) ?? null;
}

export function validateCompanionAgentToolArguments(
  toolName: string,
  args: unknown,
): { success: true; data: Record<string, unknown> } | { success: false; reason: string } {
  const schema = ARGUMENT_SCHEMAS.get(toolName);
  if (!schema) return { success: false, reason: "unknown tool argument schema" };
  const parsed = schema.safeParse(args);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, reason: "tool arguments failed schema validation" };
}
