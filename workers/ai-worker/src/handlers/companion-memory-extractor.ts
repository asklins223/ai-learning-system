/**
 * 日常对话记忆提取器（22-real-desktop-pet-memory-context-prd-tdd.md §9.1）。
 *
 * 在 assistant.final 后异步执行：
 * - 读取本 run 的 user message / assistant reply / 最近上下文；
 * - 调用 LLM 输出严格 JSON 候选（最多 3 条）；
 * - 只写入 candidate 记忆，不自动确认；
 * - 失败静默，不阻塞对话。
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { readJobPayloadString } from "@ailearn/shared";
import { logger } from "../lib/logger.ts";
import { createProvider, withThinkingDisabled } from "../lib/ai-provider.ts";
import {
  AIConsentRequiredError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { assertJobLease, lockJobLease, withJobTransaction } from "../lib/job-lease.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { MemoryExtractOutputError } from "../lib/non-retryable-errors.ts";
import { withoutQuotedNames } from "./companion-dialogue-content.ts";
import { MEMORY_CONTENT_SIMILARITY_THRESHOLD } from "@ailearn/shared/db-schema/assistant-memory";
import type { JobPayload } from "./index.ts";

/**
 * 抽取后**直接写活**（`candidate=false`）的记忆种类（方案 29 §4.3 / 决策 D3=a）。
 *
 * 为什么必须改：三处检索查询一律要求 `candidate = false`
 * （companion-memory-vector.ts 的 keyword 与 vector 路径），而抽取器以前把**所有**
 * 候选都写成 `candidate=true`。唯一的桥梁是用户在气泡上点"确认"
 * （memory-service.confirmMemory）。于是抽取即使解析成功也永远读不到——
 * 这才是「她从来不记得我说过什么」的完整链条，光修解析是不够的。
 *
 * 为什么不是全部写活：`interaction_note` / `episodic` 是**关于用户当下状态**的
 * 推断（"今天情绪低落"、"刚才吐槽了复习"），被长期引用起来容易显得被监视，
 * 保留候选、交给记忆中心过目。而 preference / goal / learning_context 是用户
 * 自己陈述过的稳定事实，写活符合直觉，且都能在记忆中心里一键撤销。
 */
const LIVE_ON_WRITE_KINDS = new Set<string>(["preference", "goal", "learning_context"]);

/**
 * 跨空间同步的判据（2026-09-22 Owner 裁决 + 当日收紧）。
 *
 * 裁决是"跟空间关联性不强的记忆需要带过去"，同时要求**收紧**——因为"关联性不强"
 * 如果只按种类粗判，会把空间专属的东西带到别的空间去。
 *
 * ─── 拿真实数据定出来的两条 ───
 * dev 库那批真种子记忆（45 条）里能看到很清楚的分界：
 *
 *   可携带：习惯在晚上九点之后写笔记 / 看新概念时更想先看反例 / 偏好短节奏学习
 *   该留下：用户正在备考日语N3，考试时间为下个月 / 用户正在学习数据库索引优化 /
 *           用户之前主要专注于 N3 相关工作，近期开始接触数据库索引优化
 *
 * 于是：
 *   1. **只有 `preference` 可能跨空间**。`interaction_note` 实测记的多半是"用户
 *      当前在做什么"（上面第三条就是它），那是空间内容，改回本地。另外三种本来
 *      就绑定空间内的对象。
 *   2. `preference` 里还要再分一次：关于**怎么学**的（时段、节奏、顺序、环境、
 *      称呼）跟人走；提到**具体科目/考试/项目**的留在原空间——那些东西在另一个
 *      空间里根本不存在。
 *
 * ─── 两道判据，任一判本地就本地 ───
 *   - 模型给 `binding`（它在对话现场，能看见"这句话是在说这门课还是说我"）；
 *   - 服务端确定性规则（见 `memoryLooksWorkspaceBound`），**可以否决模型**：
 *     模型说 portable 但内容里有明确的"这个班/这门课/考试"，一律按本地。
 *
 * 缺省 fail-closed：模型没说、规则也没说 → 本地。宁可少带，不可错带。
 */
const CROSS_SPACE_KINDS = new Set<string>(["preference"]);

/**
 * 内容里出现"空间专属"信号的确定性判据。
 *
 * 两类：
 *   - **明确的本地指代**：这个班 / 我们组 / 这门课 / 本学期的……
 *   - **具体科目、考试、项目**：日语、物理、贝叶斯、N3、考试、期中、答辩……
 *     （第二个列表只用于 `preference`，所以像"喜欢在安静时段学习"这种不带科目的
 *     偏好不会被误判成本地。）
 *
 * 导出给测试用。改这个正则等于改"什么记忆会跨空间"，所以它有专门的用例。
 */
const LOCAL_REFERENCE_PATTERN =
  /(这个|该|本|我们|咱们|此)(空间|房间|工作区|协作|班级|班|课|课程|小组|团队|项目|学期|门课)|(这|本)(学期|门课|门|节课|次考试)|(期中|期末|月考|模拟考|统考|答辩|deadline|截止日期)/;

const SUBJECT_OR_EXAM_PATTERN =
  /(日语|英语|数学|物理|化学|生物|语文|历史|地理|政治|编程|数据库|索引|算法|贝叶斯|统计|概率|线性代数|微积分|N[1-5]|雅思|托福|考研|高考|中考|四级|六级|考试|备考|证书|认证)/i;

/** `preference` 的内容看起来是否绑定了这个空间。 */
export function memoryLooksWorkspaceBound(content: string): boolean {
  return LOCAL_REFERENCE_PATTERN.test(content) || SUBJECT_OR_EXAM_PATTERN.test(content);
}

/** 一条记忆该落在哪个 scope 上。导出给测试与调用方共用，避免第二套判据。 */
export function memoryScopeForKind(
  kind: string,
  modelScope?: string,
  binding?: string,
  content?: string,
): "global" | "workspace" | "task" {
  if (CROSS_SPACE_KINDS.has(kind)) {
    // 两道判据任一判本地就本地。规则那一道可以否决模型。
    //
    // 注意这里是 `!== "portable"` 而不是 `=== "local"`：缺省必须落在**本地**。
    // 契约（schema）的默认值也是 local，但函数不能依赖调用方先过 schema——
    // 直接调这个函数的地方（测试、以后的批量重算）同样要 fail-closed。
    // 实测抓到过：写成 `=== "local"` 时 `binding` 为 undefined 会返回 global，
    // 与契约的默认值方向相反，等于开了一个"漏传就跨空间"的口子。
    if (binding !== "portable") return "workspace";
    if (content !== undefined && memoryLooksWorkspaceBound(content)) return "workspace";
    return "global";
  }
  // 非跨空间种类尊重模型给的 task（"只在这一轮有用"的细分），其余一律 workspace。
  if (modelScope === "task") return "task";
  return "workspace";
}

/**
 * "系统随时算得出来的那份统计"不是记忆（实机 2026-09-21）。
 *
 * 抽取器把"截至当前，用户本周累计学习时长为 23 分钟，拥有 10 张活跃卡片和 9 篇笔记"
 * 写成了 `learning_context`——而那个 23 分钟本来就是她当轮**没查工具编出来的**
 * （真值 60）。统计量进记忆有两层害：①数值天天变，存下来就是过期事实；
 * ②她自己的编造从此有了"记忆出处"，下一轮照着复述，谁拦都拦不住。
 *
 * 判据要窄，用户说出口的偏好里也带数字（"每天只能挤出四十分钟"、"每次练习约 10 分钟、
 * 每天总计约 40 分钟"），那些是要留的稳定信息——所以**不含**"累计/总计"这种通用量词，
 * 只认指向"现在这一份"的时间窗：本周/今天/截至。
 */
const VOLATILE_STAT_WINDOW_TEST = /(本周|这周|今天|今日|截至|这一阵)/;
const STATISTIC_QUANTITY_TEST = /\d+(?:\.\d+)?\s*(分钟|小时|张|篇|项|题|次|条|%)/;

export function isVolatileStatisticMemory(content: string): boolean {
  // 名字里的数量词不算统计（「背 3 条法律」是一张真卡的标题也可能长这样）：
  // 误判的代价是这条记忆**根本没写进去**，比误放难发现得多。
  const outsideNames = withoutQuotedNames(content);
  return VOLATILE_STAT_WINDOW_TEST.test(outsideNames) && STATISTIC_QUANTITY_TEST.test(outsideNames);
}

const memoryExtractCandidateSchema = z.object({
  kind: z.enum(["preference", "goal", "learning_context", "interaction_note", "episodic"]),
  // §9.4：写入端即限制 ≤200 字，确保读取注入时不需截断、不丢失信息。
  content: z.string().min(1).max(200),
  importance: z.number().min(0).max(1).default(0.5),
  /**
   * 保持必填：它是 §9.1 `> 0.6` 置信度闸的输入。给默认值等于替模型表态
   * （默认高了就什么都写、默认低了就什么都不写），两种都比"模型没给"更糟。
   */
  confidence: z.number().min(0).max(1),
  scope: z.enum(["global", "workspace", "task"]).default("workspace"),
  /**
   * 这条记忆是"关于我怎么学"（portable）还是"关于我现在在弄什么"（local）。
   *
   * 缺省 **local**（fail-closed）：模型没说就按本地处理。宁可少带一条到别的空间，
   * 也不要把"这个班的作业"带过去。服务端的确定性规则还能再否决一次 portable。
   */
  binding: z.enum(["portable", "local"]).default("local"),
  linkedEntityIds: z.array(z.string()).max(10).default([]),
});

export const memoryExtractOutputSchema = z.object({
  // `version` 是**我们自己的**信封版本，不是模型该表达的内容。以前它是
  // `z.literal(1)` 必填，而 prompt 里从未提到这个形状——于是模型给出
  // `{"candidates":[…]}` 就整单解析失败。这是 §9.11 那 88 次失败的主因。
  version: z.literal(1).default(1),
  // 候选超过 3 条时截断而不是判失败：多给一条是模型的正常发挥，
  // 为这个把整轮记忆丢掉不值得。
  candidates: z.preprocess(
    (value) => (Array.isArray(value) ? value.slice(0, 3) : value),
    z.array(memoryExtractCandidateSchema).max(3).default([]),
  ),
});

const EXTRACT_PROMPT = [
  "你是桌宠的记忆整理器。根据对话判断是否有值得长期记住的信息。",
  "只提取用户明确表达或高置信推断的信息；没有就返回空数组，不要为了有输出而编造。",
  // 统计量不是记忆：见 isVolatileStatisticMemory。prompt 先讲清规矩，服务端再拦一道。
  "不要记录系统随时能查出来的当前数字（今天/本周学了多久、卡片数、笔记数、到期数）——它们每天都在变，记下来就成了过期事实；只记用户自己说过的稳定偏好、目标和情况。",
  "每条记忆内容不超过 200 字，只保留核心信息，不要赘述。",
  // 契约必须写进 prompt：schema 单方面要求而模型不知道，等于必然失败。
  "只输出一个 JSON 对象，形状如下（不要输出 JSON 以外的任何文字、不要 markdown 代码块）：",
  '{"candidates":[{"kind":"goal|preference|learning_context|interaction_note|episodic",'
  + '"content":"…","importance":0.0到1.0,"confidence":0.0到1.0,"binding":"portable|local"}]}',
  "kind 可以省略（会有默认值），但必须从上面五个枚举里选。",
  // scope 不再由模型选（产品规则按 kind 定），但 binding 必须问它：只有它在对话现场，
  // 能分辨"这句话是在说我这门课，还是在说我一贯怎么学"。
  "不要输出 scope 字段——记忆的可见范围由系统决定。",
  "每条给一个 binding，表示这条记忆是不是只在**当前这个学习空间**里成立：",
  "  portable —— 关于用户**一贯怎么学、怎么相处**的：学习时段与节奏、理解顺序、环境偏好、称呼与沟通方式。换个空间照样成立。",
  "  local —— 与**当前空间的内容**绑定的：正在学的科目或技术、要考的试与时间、这个班/这门课/这个项目的事、以及「用户最近在做什么」。",
  "拿不准就填 local。宁可留在这个空间，也不要让它跑到别的空间去。",
  "confidence 表示你有多确信这是用户真实长期信息：0.7 以上才会被采纳。",
  "没有值得记的信息时输出 {\"candidates\":[]}。",
  "候选最多 3 条。",
].join("\n");

interface ExtractMessage {
  role: "user" | "assistant";
  text: string;
}

export function buildExtractMessages(input: {
  userText: string;
  assistantText: string;
  recent: ExtractMessage[];
}): Array<{ role: "system" | "user"; content: string }> {
  const recentText = input.recent
    .slice(-5)
    .map((m) => `${m.role}: ${m.text.slice(0, 500)}`)
    .join("\n");
  const conversation = [
    ...(recentText ? [`最近上下文：\n${recentText}`] : []),
    `用户：${input.userText.slice(0, 1000)}`,
    `桌宠：${input.assistantText.slice(0, 1000)}`,
  ].join("\n\n");
  return [
    { role: "system" as const, content: EXTRACT_PROMPT },
    { role: "user" as const, content: conversation },
  ];
}

/**
 * 2026-08-16（实机溯源修复）：LLM 输出容错解析——
 * tokenrhythm 偶发在 JSON 外包裹 ```json fence 或前后赘述，
 * 此前直接 JSON.parse 失败即整轮丢弃（记忆提取成功率低）。
 * 依次尝试：原样 → 剥 fence → 提取首个 {…} 平衡片段。
 */
export function parseMemoryExtractJson(raw: string): unknown {
  const attempts: string[] = [raw.trim()];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) attempts.push(fenced[1].trim());
  // 提取首个从 { 到最后一个 } 的平衡片段（容忍前后赘述）。
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    attempts.push(raw.slice(firstBrace, lastBrace + 1).trim());
  }
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // 继续尝试下一形态
    }
  }
  throw new SyntaxError("memory extract JSON parse failed after all fallbacks");
}

export async function runCompanionMemoryExtract(job: JobPayload): Promise<void> {
  // 设计 P1-8（2026-09-15 审计）：字段名走共享契约（@ailearn/shared 的
  // companion-memory-job-payload），改名由编译器兜住。
  const runId = readJobPayloadString(job.payload, "runId");
  const userId = readJobPayloadString(job.payload, "userId");
  if (!runId || !userId) throw new Error("companion_memory_extract payload 缺 runId/userId");
  await assertJobLease(job);

  const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
  if (!govCtx.consentOk) throw new AIConsentRequiredError();
  const textRes = resolveProviderForTask(govCtx, "companion_agent");
  // 思考必须关掉：这是一次 `responseFormat:"json_object"` + `maxTokens:800` 的整段取回，
  // 思考 token 也算在 800 里——吃满之后 `content` 直接为空，JSON 解析失败，
  // provider 内部重试 × job 重试跑满就把 job 判死（实机 2026-09-22：dead 里
  // `MEMORY_EXTRACT_OUTPUT_INVALID` 与 `provider_http_400` 各占一条，
  // 与 §9.71 摘要器"建表以来 0 行"是同一根因，当时只修了摘要器那一个调用点）。
  const provider = createGovernedProvider(
    createProvider(textRes.providerName, withThinkingDisabled(textRes.providerConfig)),
    govCtx,
    job.workspaceId,
    // AI P0-8（2026-09-15 审计）：接上 ai_audit_log 的唯一写入口（此前零调用）。
    // ai_audit_log.user_id 是 NOT NULL，故 payload 未带可信 actor 时不写审计行。
    userId
      ? { userId, operation: "companion_memory_extract", jobId: job.id }
      : undefined,
  );

  // 使用独立 RLS 事务读取本轮消息（避免在 provider 调用期间持有事务）。
  // runId 是 companion_turn_runs 的 ID，需通过它获取 user_message_id 和
  // conversation_id，再关联查询 companion_messages。
  const context = await withJobTransaction(job, async (tx) => {
    const runRows = await tx.execute<{ user_message_id: string; conversation_id: string }>(sql`
      SELECT user_message_id, conversation_id FROM companion_turn_runs
      WHERE id = ${runId}
    `);
    const run = runRows[0];
    if (!run) return { userText: "", assistantText: "", recent: [] };

    const userRows = await tx.execute<{ blocks: unknown }>(sql`
      SELECT blocks FROM companion_messages
      WHERE id = ${run.user_message_id}
    `);
    const userBlocks = userRows[0]?.blocks;
    const userText = Array.isArray(userBlocks)
      ? (userBlocks as Array<{ type?: string; text?: unknown }>)
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("")
      : "";

    const assistantRows = await tx.execute<{ blocks: unknown }>(sql`
      SELECT blocks FROM companion_messages
      WHERE run_id = ${runId} AND role = 'assistant'
      ORDER BY seq DESC LIMIT 1
    `);
    const assistantBlocks = assistantRows[0]?.blocks;
    const assistantText = Array.isArray(assistantBlocks)
      ? (assistantBlocks as Array<{ type?: string; text?: unknown }>)
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("")
      : "";

    const historyRows = await tx.execute<{ role: string; blocks: unknown }>(sql`
      SELECT role, blocks FROM companion_messages
      WHERE conversation_id = ${run.conversation_id}
        AND id <> ${run.user_message_id}
      ORDER BY seq DESC LIMIT 8
    `);
    const recent = historyRows
      .slice()
      .reverse()
      .map((row) => ({
        role: (row.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
        text: Array.isArray(row.blocks)
          ? (row.blocks as Array<{ type?: string; text?: unknown }>)
              .filter((b) => b.type === "text")
              .map((b) => String(b.text ?? ""))
              .join("")
          : "",
      }));

    return { userText, assistantText, recent };
  });

  if (!context.userText.trim() && !context.assistantText.trim()) {
    logger.info({ jobId: job.id, runId }, "memory extract skipped: empty conversation");
    return;
  }

  const messages = buildExtractMessages(context);
  // 2026-08-16（实机溯源修复）：LLM 输出不可解析或 schema 校验失败先重试
  // 一次（provider 偶发输出半截/非 JSON/字段缺失），重试仍失败才跳过——
  // 记忆提取从"一次失误即丢"改为容错。
  //
  // 2026-09-20（方案 29 §4.3）：**"跳过"这一步是整条记忆写路径静默瘫痪的原因**。
  // 解析失败时函数直接 `return`，不抛错也不记日志，于是 `jobs.status` 落成
  // `succeeded`——实测 242 个"成功"的抽取 job 写进了 0 行记忆，监控上一切正常。
  // 现在两条失败路径都必须抛：采样已在本函数内重试过一次，重投不会更好，
  // 所以判不可重试、直接 dead，让 `jobs.last_error` 说真话。
  type ExtractOutput = z.infer<typeof memoryExtractOutputSchema>;
  type ExtractParseSuccess = Extract<
    z.SafeParseReturnType<unknown, ExtractOutput>,
    { success: true }
  >;
  let parsed: ExtractParseSuccess | null = null;
  /** 与 `parsed` 同源的那次原始输出（候选为空时的指纹留痕要用它）。 */
  let parsedRaw = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await runWithAbortBudget(
        // 2026-08-24（AI 设计审查 §4.2）：responseFormat "text" → "json_object"，
        // provider 层先保证 JSON 合法性，容错解析退为二道防线。
        (signal) => provider.chatCompletion(messages, { temperature: 0.2, maxTokens: 800, responseFormat: "json_object" }, signal),
        job.signal,
        resolveProviderCallTimeout("companion_agent"),
        (lateError) => logger.warn({ jobId: job.id, err: lateError }, "memory extract provider settled late"),
      );
      const raw = result.content;
      let candidate: z.SafeParseReturnType<unknown, ExtractOutput> | null = null;
      try {
        candidate = memoryExtractOutputSchema.safeParse(parseMemoryExtractJson(raw));
      } catch {
        candidate = null;
      }
      if (candidate?.success) {
        parsed = candidate;
        parsedRaw = raw;
        break;
      }
      if (attempt === 0) {
        logger.warn(
          { jobId: job.id, runId, schemaOk: candidate?.success ?? false },
          "memory extract JSON unparsable or schema-invalid; retrying once",
        );
        continue;
      }
      break;
    } catch (err) {
      // provider 侧失败（网络/超时/5xx）**是可重试的**：原样抛出交给队列，
      // 但绝不能像以前那样 `return`——那会把它记成 succeeded 而什么都没写。
      logger.warn({ jobId: job.id, runId, err, attempt }, "memory extract provider failed");
      throw err;
    }
  }
  if (!parsed) {
    throw new MemoryExtractOutputError(
      `memory extract produced no schema-valid output after 2 attempts (run ${runId})`,
    );
  }
  // §9.1：只有置信度 > 0.6 才生成候选（严格大于，不含等于）。
  const confidenceAccepted = parsed.data.candidates.filter((c) => c.confidence > 0.6);
  const candidates = confidenceAccepted.filter((c) => !isVolatileStatisticMemory(c.content));
  if (candidates.length < confidenceAccepted.length) {
    logger.warn(
      {
        jobId: job.id,
        runId,
        dropped: confidenceAccepted
          .filter((c) => isVolatileStatisticMemory(c.content))
          .map((c) => c.content.slice(0, 60)),
      },
      "memory extract dropped volatile-statistic candidates (系统查得到，不该记)",
    );
  }
  if (candidates.length === 0) {
    // 2026-08-16（溯源）：候选被过滤/为空时留痕——区分"LLM 没提取到"与
    // "提取到但置信不足"，便于排查记忆链路。
    //
    // AI P0-13（2026-09-15 审计）：此处原为 `rawPreview: raw.slice(0, 160)`，
    // 而 raw 是模型对**用户对话内容**的复述/改写——INFO 级、无开关，是本轮审计
    // 清单里唯一无条件的用户内容泄漏点。改为长度 + sha256 前缀指纹：仍可对照定位
    // （同一次输出的指纹稳定），但不可还原。（与 openai-compatible.ts 的 REPRO-LOG
    // 加固同一模式。）
    logger.info(
      {
        jobId: job.id,
        runId,
        rawCandidates: parsed.data.candidates.length,
        rawLen: parsedRaw.length,
        rawFingerprint: createHash("sha256").update(parsedRaw, "utf8").digest("hex").slice(0, 16),
      },
      "memory extract no candidates after confidence filter",
    );
    return;
  }

  // 用户明确"忽略"过的事，下一轮抽取不能再当成新事端上来（doc 34 L14 的后半）。
  let skippedDismissedTwins = 0;

  await withJobTransaction(job, async (tx) => {
    // 稳定 P1-1（2026-09-15 审计）：提交前重新校验并续租租约（TOCTOU 围栏）。
    // 入口 assertJobLease 挡不住"LLM 调用期间租约被 reap"后另一实例重领并重复
    // 写记忆/重复计费。
    await lockJobLease(tx, job);
    // 与 API/action writer 共用用户级序列锁，防止并发写入时 inbox_sequence 冲突。
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`companion-inbox:${job.workspaceId}:${userId}`}, 0))
    `);
    for (const [index, candidate] of candidates.entries()) {
      const sourceEventId = `memory-extract:${runId}:${index}`;
      // scope 由种类 + 绑定判据决定，不采信模型给的 scope（见 memoryScopeForKind）。
      // 两道判据任一判本地就本地，服务端规则可以否决模型的 portable。
      const scope = memoryScopeForKind(candidate.kind, candidate.scope, candidate.binding, candidate.content);
      // 同一空间里已经有一条**被本人忽略过**的同类同内容记忆，就整条跳过：
      // 不写候选、不发气泡、不铺跨空间。判据与 api 侧冲突分组共用同一个数（见
      // MEMORY_CONTENT_SIMILARITY_THRESHOLD），否则同一句话会在一边算重复、
      // 另一边算新事。只认 dismissed_at，删除（deleted_at）不算"别再告诉我"。
      const dismissedTwin = await tx.execute<{ id: string }>(sql`
        SELECT id FROM assistant_memory_items
        WHERE workspace_id = ${job.workspaceId}
          AND user_id = ${userId}
          AND deleted_at IS NULL
          AND dismissed_at IS NOT NULL
          AND similarity(content, ${candidate.content}) > ${MEMORY_CONTENT_SIMILARITY_THRESHOLD}
        LIMIT 1
      `);
      if (dismissedTwin.length > 0) {
        skippedDismissedTwins += 1;
        continue;
      }
      await tx.execute(sql`
        INSERT INTO assistant_memory_items
          (workspace_id, user_id, kind, content, source_event_id, user_stated, user_confirmed,
           candidate, importance, confidence, scope, source_type, embedding_status, created_at, updated_at)
        VALUES
          (${job.workspaceId}, ${userId}, ${candidate.kind}, ${candidate.content}, ${sourceEventId},
           false, false, ${!LIVE_ON_WRITE_KINDS.has(candidate.kind)},
           ${candidate.importance}, ${candidate.confidence}, ${scope},
           'model_inferred', 'pending', now(), now())
        ON CONFLICT (workspace_id, user_id, kind, source_event_id)
          WHERE deleted_at IS NULL AND source_event_id IS NOT NULL
        DO NOTHING
      `);
      const memoryRows = await tx.execute<{ id: string }>(sql`
        SELECT id FROM assistant_memory_items
        WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND source_event_id = ${sourceEventId}
        LIMIT 1
      `);
      const memoryId = memoryRows[0]?.id;
      if (memoryId) {
        // 跨空间记忆：铺到该用户所有活跃空间（0267 的唯一实现）。
        // 只对 global 调；函数自己也会再判一次 scope，双保险。
        // 铺开失败不该让整轮记忆丢掉——它是"多带一份"的增强，不是主路径；
        // 但也不能静默：日志里留一行，否则"另一个空间怎么不记得"会查无实据。
        if (scope === "global") {
          try {
            const fanned = await tx.execute<{ inserted: number }>(sql`
              SELECT public.ailearn_fanout_global_companion_memory(${memoryId}::uuid) AS inserted
            `);
            logger.info(
              { memoryId, kind: candidate.kind, spaces: Number(fanned[0]?.inserted ?? 0) },
              "cross-space memory fanned out",
            );
          } catch (error) {
            logger.warn(
              { memoryId, kind: candidate.kind, error: (error as Error).message },
              "cross-space memory fanout failed; the memory stays in this space only",
            );
          }
        }
        const dedupeKey = `memory-candidate:${sourceEventId}`;
        // §16.2：delivery 携带候选内容摘要（≤80 字），气泡确认卡可直接展示；
        // 摘要缺失时由前端展示通用文案。
        const payloadRef = JSON.stringify({
          kind: "memory_item",
          memoryItemId: memoryId,
          contentPreview: candidate.content.slice(0, 80),
        });
        await tx.execute(sql`
          INSERT INTO assistant_deliveries
            (assistant_session_id, workspace_id, user_id, inbox_sequence, dedupe_key, state, kind, payload_ref, expires_at)
          SELECT NULL, ${job.workspaceId}, ${userId},
                 COALESCE(MAX(inbox_sequence), 0) + 1,
                 ${dedupeKey}, 'queued', 'memory_candidate',
                 ${payloadRef}::jsonb, now() + interval '30 days'
          FROM assistant_deliveries
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          ON CONFLICT (workspace_id, user_id, dedupe_key) DO NOTHING
        `);
      }
      for (const entityRef of candidate.linkedEntityIds) {
        const [entityType, entityId] = entityRef.split(":", 2);
        if (!entityType || !entityId) continue;
        await tx.execute(sql`
          INSERT INTO memory_links (memory_id, workspace_id, user_id, entity_type, entity_id, auto_linked)
          SELECT id, workspace_id, user_id, ${entityType}, ${entityId}::uuid, true
          FROM assistant_memory_items
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
            AND source_event_id = ${sourceEventId}
          ON CONFLICT (memory_id, entity_type, entity_id) DO NOTHING
        `);
      }
    }
  });

  logger.info(
    {
      jobId: job.id,
      runId,
      count: candidates.length - skippedDismissedTwins,
      dismissedTwinsSkipped: skippedDismissedTwins,
    },
    "memory extract completed",
  );
}
