import { z } from "zod";
import {
  COMPANION_PAGE_DESTINATIONS_V2,
  companionPageKindValuesV2,
  type CompanionPageKindV2,
} from "./companion-bridge-contracts.ts";
import {
  COMPANION_AGENT_CONTRACT_VERSION,
  companionAgentToolDefinitionV1Schema,
  isVisionGatedCompanionTool,
  type CompanionAgentPermissionLevel,
  type CompanionAgentToolDefinitionV1,
  type CompanionAgentToolExecutionConstraints,
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
 * 而是 `validateCompanionAgentToolArguments` 落到"这个工具的参数要求没有登记"——
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

const companionPageKindSchemaV2 = z.enum(
  companionPageKindValuesV2 as [CompanionPageKindV2, ...CompanionPageKindV2[]],
);

/** 页面名与别名都取自词表：她嘴里的那个页面，必须是桌面端真有的一页。 */
function companionOpenPageDescriptionV2(): string {
  // 整条描述要 ≤240 字：`agent.tool` 的 safeLabel 上限就是 240，而那条测试把
  // description 原样当 safeLabel 过 schema。超了不会报"描述太长"，只会让 SSE 事件解析失败。
  const pages = COMPANION_PAGE_DESTINATIONS_V2.map(
    (page) => `${page.label}=${page.kind}(${page.aliases.join("/")})`,
  ).join("；");
  return `跳到某个页面：${pages}。用户说的页面不在列里时别硬挑相近的，问他在哪儿看到的。`;
}

const REGISTERED_TOOLS: readonly RegisteredTool[] = [
  tool("companion_read_context", "读取当前用户在当前 workspace 的学习上下文。", "read", false, emptyParameters, emptyArguments),
  tool("companion_read_current_page", "读取用户此刻屏幕上正显示的内容：页面标题、状态行、计数器、按屏幕顺序编号的条目、空态与当前筛选。用户说「这一页」「第N张」「为什么这么慢/卡住」时先调它——别用别的工具的数字代替眼前这屏。返回 available=false 表示这一页没有可读内容，要问她是在哪儿看到的，不要据此推断系统没问题。", "read", false, emptyParameters, emptyArguments),
  tool("companion_read_history", "读取当前伴星对话的有限历史摘要。", "read", false, { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false }, z.object({ limit: z.number().int().min(1).max(20).optional() }).strict()),
  // 系统敞开面（方案 29 §4.2，抱怨 #5/#6「连跳到某个笔记都做不到、看不到学习数据、
  // 看不到任务队列」）。这些不是"锦上添花的工具"：没有它们，她能说的只有闲聊。
  // 描述统一写成"什么时候该调"，因为工具描述是她唯一能看到的用法说明。
  tool("companion_search_notes", "按关键词搜用户的笔记标题与正文，返回笔记 id/标题/时间。用户问「我之前记过什么」或要跳到某篇笔记时先用它。", "read", false, { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 120 }, limit: { type: "integer", minimum: 1, maximum: 10 } }, required: ["query"], additionalProperties: false }, z.object({ query: z.string().min(1).max(120), limit: z.number().int().min(1).max(10).optional() }).strict()),
  tool("companion_read_note", "读出一篇笔记的正文内容（截断到几千字）。要引用、总结或核对用户写过什么时必须先读，不要凭标题猜内容。", "read", false, { type: "object", properties: { noteId: { type: "string", format: "uuid" } }, required: ["noteId"], additionalProperties: false }, z.object({ noteId: uuid }).strict()),
  tool("companion_open_note", "跳到用户的一篇笔记（在应用里打开它）。", "read", false, { type: "object", properties: { noteId: { type: "string", format: "uuid" } }, required: ["noteId"], additionalProperties: false }, z.object({ noteId: uuid }).strict()),
  // 页面词表由 `COMPANION_PAGE_DESTINATIONS_V2`（companion-bridge-contracts）一处定义：
  // 枚举、中文页名、用户的口语别名都从同一张表生成，桌面端有落点的页面才进得了这里。
  // 以前这份枚举手抄一遍，结果「今日」「设置」服务端能发、客户端没有分支，
  // 而笔记库/学习卡/查找三页她根本说不出名字，只能被就近塞进来源库和星图。
  tool("companion_open_page", companionOpenPageDescriptionV2(), "read", false, { type: "object", properties: { page: { type: "string", enum: [...companionPageKindValuesV2] } }, required: ["page"], additionalProperties: false }, z.object({ page: companionPageKindSchemaV2 }).strict()),
  tool("companion_get_learning_stats", "读取学习数据统计：今天/本周学了多久、到期复习数、活跃卡片数、笔记数等（与首页同一口径）。**只在用户问自己学了多久/进度如何时调用**；她跟你打招呼、闲聊、或只是接着上一个话题时不要调，也不要把这些数字主动报给用户。", "read", false, emptyParameters, emptyArguments),
  tool("companion_list_task_queue", "列出当前学习运行里排着的任务（含进度和第几步）。用户问「我接下来要做什么」「还有什么任务」时调用。", "read", false, emptyParameters, emptyArguments),
  tool("companion_list_due_reviews", "列出到期（或快到期）的复习卡，带卡片标题和到期时间。用户问「有什么要复习的」时调用。", "read", false, { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false }, z.object({ limit: z.number().int().min(1).max(20).optional() }).strict()),
  tool("companion_open_card", "打开一个已存在的学习卡片。cardId 直接用到期复习列表给的那个 id 就行。", "read", false, { type: "object", properties: { cardId: { type: "string", minLength: 1, maxLength: 120 } }, required: ["cardId"], additionalProperties: false }, z.object({ cardId: uuid }).strict()),
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
  // 呈现类工具（方案 29 §4.8，抱怨 #10「只能输出纯文本」）。它不读也不写数据，只是把
  // 结构交给客户端排版，所以 riskClass=read：任何权限档都给，永不弹确认。
  // 为什么不让模型直接"用文字画流程图"：字符画在消息列里会折行错乱，而且
  // 朗读文本会把箭头念出来；结构化之后渲染层画得稳，TTS 也只念步骤本身。
  tool("companion_render_diagram", "把一组步骤/流程画成竖向流程图交给客户端显示。用户让你「列出步骤」「讲清流程」「画个图说明先后顺序」时用；2 到 8 步，每步一个短标题，可选一句补充。", "read", false, { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 60 }, steps: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", properties: { label: { type: "string", minLength: 1, maxLength: 40 }, detail: { type: "string", maxLength: 80 } }, required: ["label"], additionalProperties: false } } }, required: ["title", "steps"], additionalProperties: false }, z.object({ title: z.string().min(1).max(60), steps: z.array(z.object({ label: z.string().min(1).max(40), detail: z.string().max(80).optional() }).strict()).min(2).max(8) }).strict()),
  // 读图（抱怨 #9）。`riskClass=read` 但**受数据外发政策里的 sendImageContent 管**：
  // 图片比文字敏感（可能拍到人脸、门牌、别人的屏幕），所以政策关着时这个工具
  // **从工具面里摘掉**——看不见就不会答应，也就不会有"我看看这张图"然后什么都没有。
  // 参数只收我们自己库里的 id，不收 URL——收 URL 等于让模型拿她的凭证去访问任意地址。
  tool("companion_read_image", "看图并说出图里的内容（截图里的公式、表格、流程图、页面文字）。用户问「我笔记里那张图」「这张截图写了什么」时调用；先用 noteId（那张图所在的笔记）或 assetId（companion_read_note 返回的图片 id）指定是哪张。", "read", false, { type: "object", properties: { noteId: { type: "string", format: "uuid" }, assetId: { type: "string", format: "uuid" }, question: { type: "string", minLength: 1, maxLength: 200 } }, additionalProperties: false }, z.object({ noteId: uuid.optional(), assetId: uuid.optional(), question: z.string().min(1).max(200).optional() }).strict()),
  // 显示图片与读图是**两条不同的能力**（方案 29 §4.8 剩下的那块，抱怨 #9 的另一半）：
  // 读图要把字节发给视觉模型，受 sendImageContent 管；把用户自己库里的图摆到对话里
  // 只是本机显示，一个字节都不出境。所以图片外发关着时，"给我看那张图"仍然做得成——
  // 这一句必须写进描述，否则她会把自己"看不了图"的限制误套到"给你看"上，
  // 明明能办的事也回答"我看不了"。
  tool("companion_show_image", "把用户自己库里的图片显示在伴星身旁和对话中（只在本机显示，不发给模型，不需要图片外发开关）。自然地说想看看某文章的插图也属于展示请求。若只知道文章简称或标题，先用 companion_search_notes 找到真实 noteId，再用 noteId 与 position（从 1 起）或 assetId 展示；不可凭旧对话猜图片归属。", "read", false, { type: "object", properties: { noteId: { type: "string", format: "uuid" }, assetId: { type: "string", format: "uuid" }, position: { type: "integer", minimum: 1, maximum: 20 } }, additionalProperties: false }, z.object({ noteId: uuid.optional(), assetId: uuid.optional(), position: z.number().int().min(1).max(20).optional() }).strict()),
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
 * 扁平工具面（方案 29 §4.1）：**每轮全部提供，只按权限档与外发约束过滤**。
 *
 * 这是取代 `selectSkill()` 的那一刀。原先工具面 = 关键词命中的那**一个**技能的
 * `toolNames`，没命中就是空工具面 + 单步——基线实测 90.7% 的轮次一个工具都没有，
 * 于是"读记忆/看系统状态/跳转"这些能力不是被拒，而是**根本没出现在她面前**。
 *
 * 权限三档（`read_only`/`guided`/`full`）是真正的安全边界，保留：它只**过滤**工具，
 * 从不参与"这一轮能看见什么"的发现过程。
 *
 * `constraints` 是第二类过滤，管的不是"她能改什么"而是"数据能出到哪里"：政策没批准
 * 外发图片时读图工具**不下发**。看不见才不会先答应再看不了——这是抱怨 #9 里"她说
 * 我看看这张图，然后什么都没有"的根治点，执行层的复核只是兜底。
 */
export function resolveAllCompanionAgentTools(
  permission: CompanionAgentPermissionLevel,
  constraints: CompanionAgentToolExecutionConstraints = {},
): CompanionAgentToolDefinitionV1[] {
  return COMPANION_AGENT_TOOL_DEFINITIONS.filter((definition) => {
    if (isVisionGatedCompanionTool(definition.name) && constraints.visionEnabled !== true) return false;
    return permission !== "read_only" || definition.riskClass === "read";
  });
}

export function getCompanionAgentTool(toolName: string): CompanionAgentToolDefinitionV1 | null {
  return COMPANION_AGENT_TOOL_DEFINITIONS.find((toolDefinition) => toolDefinition.name === toolName) ?? null;
}

export function validateCompanionAgentToolArguments(
  toolName: string,
  args: unknown,
): { success: true; data: Record<string, unknown> } | { success: false; reason: string } {
  const schema = ARGUMENT_SCHEMAS.get(toolName);
  // 这两句会原样进 `agent.tool` 的 `safeSummary`，也就是**用户看的那一行**（执行过程里失败
  // 那步的小字），同一份又回给模型当工具报错。以前这里写的是
  // "tool arguments failed schema validation" —— 字段名叫 safe，内容却是排查日志用的英文
  // 机器话，界面上就成了「正在看到期复习 ｜ tool arguments failed schema validation ｜ 失败」。
  // 只在这一处定义，改这里两边一起变。
  if (!schema) return { success: false, reason: "这个工具的参数要求没有登记，这一步没有执行" };
  const parsed = schema.safeParse(args);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, reason: "这一步要填的内容没有对上，没有执行" };
}
