/**
 * 会话摘要器（22-real-desktop-pet-memory-context-prd-tdd.md §2.5/§9.5）。
 *
 * 异步处理长对话摘要：
 * - 读取会话最近消息；
 * - LLM 生成结构化摘要 JSON；
 * - 写入 conversation_summaries（唯一约束幂等）；
 * - 生成 episodic 候选记忆（不自动确认）。
 */

import { z } from "zod";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import { readJobPayloadString } from "@ailearn/shared";
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
import { companionSummaryTotal } from "../lib/metrics.ts";
import { parseMemoryExtractJson } from "./companion-memory-extractor.ts";
import { REPLAY_WINDOW_MESSAGES } from "./companion-dialogue-content.ts";
import type { JobPayload } from "./index.ts";

export const conversationSummaryOutputSchema = z.object({
  title: z.string().min(1).max(200),
  topics: z.array(z.string().min(1).max(200)).max(20).default([]),
  userGoals: z.array(z.string().min(1).max(500)).max(20).default([]),
  keyEvents: z.array(z.string().min(1).max(500)).max(20).default([]),
  userPreferences: z.array(z.string().min(1).max(500)).max(20).default([]),
  followUps: z.array(z.string().min(1).max(500)).max(20).default([]),
  emotionalState: z.string().min(1).max(40).default("neutral"),
});

const SUMMARIZER_PROMPT = [
  "你是桌宠的会话摘要器。把以下对话压缩成结构化摘要。",
  // 2026-09-22：这里原来是一行一条**中文**字段名（"主题 / 用户目标 / …"），而 schema
  // 要的是英文键——模型照着清单回中文键，`schema.parse` 每次都抛，摘要自 0170 建表
  // 以来落库 0 行（同期审计日志里成功调用 283 次）。字段名必须逐字给出来，
  // 而"中文标签 + 英文键"两份清单只会让她照错的那份写。
  "只输出一个 JSON 对象，键名必须逐字用下面这些英文（值用中文）：",
  '{"title": "一句话主题", "topics": ["主题"], "userGoals": ["用户目标"],',
  ' "keyEvents": ["关键事件"], "userPreferences": ["用户偏好"],',
  ' "followUps": ["待跟进事项"], "emotionalState": "neutral"}',
  "title 不能为空；四个列表没有内容就给空数组；emotionalState 只填一个英文词" +
    "（neutral / positive / frustrated / tired 里选）。",
  "只输出 JSON。",
].join("\n");

export const SUMMARIZER_INPUT_CHARS = 12_000;

/**
 * `SELECT … ORDER BY seq DESC LIMIT 200` 的行 → 正序可读对话。
 *
 * 调用方给的是"最近 200 条"（倒序），这里翻回时间顺序再拼文本。
 */
export function formatSummarizerTranscript(
  rows: Array<{ role: string; blocks: unknown }>,
): string {
  return [...rows]
    .reverse()
    .map((row) => {
      const text = Array.isArray(row.blocks)
        ? (row.blocks as Array<{ type?: string; text?: unknown }>)
            .filter((b) => b.type === "text")
            .map((b) => String(b.text ?? ""))
            .join("")
        : "";
      return `${row.role === "assistant" ? "桌宠" : "用户"}：${text}`;
    })
    .join("\n");
}

export function buildSummarizerMessages(conversationText: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: SUMMARIZER_PROMPT },
    // 超预算时留**结尾**：会话是往上长的，砍尾巴等于把"刚才聊了什么"丢掉。
    { role: "user", content: conversationText.slice(-SUMMARIZER_INPUT_CHARS) },
  ];
}

/**
 * 摘要 → 注入对话上下文的 `<conversation_summary>` 数据块（方案 29 §11 C1）。
 *
 * 为什么要有这一块：历史回放只带最近 20 条（`recentMessages.slice(-20)`），
 * 一条 524 消息的连续会话里，更早的那一段对她本来是完全不可见的——
 * 摘要修好了却没人读，等于没修。
 *
 * 两条约束（都在测试里钉住）：
 * - **数字不作数**：这块不进 `keepRecomputedBlocks` 的白名单。摘要里的数字是
 *   "写它那一刻"的值，让它当出处等于把她几周前说过的统计复活成事实（§9.35）。
 * - 摘要正文是模型生成的，与用户自填字段同级处理：先剥掉能提前闭合边界的标记。
 */
export const CONVERSATION_SUMMARY_MAX_CHARS = 600;

const SUMMARY_BOUNDARY_TAGS = /<\/?conversation_summary>/gi;

export function renderConversationSummary(
  summary: unknown,
): string | null {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const row = summary as Record<string, unknown>;
  const text = (value: unknown): string =>
    typeof value === "string" ? value.replace(SUMMARY_BOUNDARY_TAGS, "").trim() : "";
  const list = (value: unknown, max: number): string[] =>
    Array.isArray(value)
      ? value.map(text).filter((item) => item.length > 0).slice(0, max)
      : [];

  const title = text(row.title);
  if (title.length === 0) return null;
  const lines = [
    "<conversation_summary>",
    `更早那段对话：${title}`,
    ...(() => {
      const events = list(row.keyEvents, 3);
      return events.length > 0 ? [`办过的事：${events.join("；")}`] : [];
    })(),
    ...(() => {
      const followUps = list(row.followUps, 3);
      return followUps.length > 0 ? [`还没了结：${followUps.join("；")}`] : [];
    })(),
    ...(() => {
      const prefs = list(row.userPreferences, 2);
      return prefs.length > 0 ? [`他偏好的：${prefs.join("；")}`] : [];
    })(),
    "（这段是早些时候留下的摘要，不是这一轮新查的；里面的数字可能已经变了，" +
      "要报数字得重新查。）",
    "</conversation_summary>",
  ];
  const block = lines.join("\n");
  return block.length > CONVERSATION_SUMMARY_MAX_CHARS
    ? `${block.slice(0, CONVERSATION_SUMMARY_MAX_CHARS - 1)}…</conversation_summary>`
    : block;
}

export async function runCompanionSummarizer(job: JobPayload): Promise<void> {
  // 设计 P1-8（2026-09-15 审计）：字段名走共享契约（@ailearn/shared 的
  // companion-memory-job-payload），改名由编译器兜住。
  const conversationId = readJobPayloadString(job.payload, "conversationId");
  const userId = readJobPayloadString(job.payload, "userId");
  if (!conversationId || !userId) throw new Error("companion_summarizer payload 缺 conversationId/userId");
  await assertJobLease(job);

  const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
  if (!govCtx.consentOk) throw new AIConsentRequiredError();
  const textRes = resolveProviderForTask(govCtx, "companion_agent");
  // 2026-09-22 实测：开着思考时这一步 completion=998 token（= maxTokens 1000），
  // JSON 从句子中间被切断，`parseMemoryExtractJson` 三层兜底全都解不出——
  // 那 37 条 "invalid output" 的 SyntaxError 就是这个，而不是模型不听话。
  // 关掉思考之后同一份输入 completion=375、7.6 秒返回且解析通过（开着是 36 秒）。
  // 伴星的非流式调用一律关思考，这里此前是唯一漏掉的一处。
  const provider = createGovernedProvider(
    createProvider(textRes.providerName, withThinkingDisabled(textRes.providerConfig)),
    govCtx,
    job.workspaceId,
    // AI P0-8（2026-09-15 审计）：接上 ai_audit_log 的唯一写入口（此前零调用）。
    // ai_audit_log.user_id 是 NOT NULL，故 payload 未带可信 actor 时不写审计行。
    userId
      ? { userId, operation: "companion_summarizer", jobId: job.id }
      : undefined,
  );

  const conversationText = await withJobTransaction(job, async (tx) => {
    // 取**回放窗口之外**那一段的最近 200 条（原来是 `seq ASC`：524 条的会话每次
    // 都摘要最开头那 200 条，而且 `buildSummarizerMessages` 又按 12 000 字从头切，
    // 两次都往回看）。
    //
    // 为什么要显式让开最后 20 条：对话链路本来就把最近 20 条当原生多轮喂回去
    // （`recentMessages.slice(-20)`）。摘要若覆盖同一段，它就不携带任何新信息——
    // 实测因此完全无法判断"她是看了摘要还是复述上文"（方案 29 §12.1）。
    // 让开之后，摘要说的一定是回放里不存在的内容，接入才有意义，也才可归因。
    const rows = await tx.execute<{ role: string; blocks: unknown }>(sql`
      SELECT role, blocks FROM companion_messages
      WHERE conversation_id = ${conversationId}
        AND seq <= (
          SELECT max(seq) - ${REPLAY_WINDOW_MESSAGES} FROM companion_messages
          WHERE conversation_id = ${conversationId}
        )
      ORDER BY seq DESC LIMIT 200
    `);
    return formatSummarizerTranscript(rows);
  });

  if (!conversationText.trim()) {
    logger.info({ jobId: job.id, conversationId }, "summarizer skipped: empty conversation");
    return;
  }

  const messages = buildSummarizerMessages(conversationText);
  let raw: string;
  try {
    const result = await runWithAbortBudget(
      // 2026-08-24（AI 设计审查 §4.2）：responseFormat "text" → "json_object"——
      // 输出本就是结构化 JSON，让 provider 层开启 json 模式降低格式走样率。
      (signal) => provider.chatCompletion(messages, { temperature: 0.2, maxTokens: 1000, responseFormat: "json_object" }, signal),
      job.signal,
      resolveProviderCallTimeout("companion_agent"),
      (lateError) => logger.warn({ jobId: job.id, err: lateError }, "summarizer provider settled late"),
    );
    raw = result.content;
  } catch (err) {
    logger.warn({ jobId: job.id, conversationId, err }, "summarizer provider failed");
    // §9.9：记录摘要失败指标
    try {
      companionSummaryTotal.labels("failed").inc();
    } catch {
      // metrics 记录失败不阻断错误传播
    }
    throw err;
  }

  let summary: z.infer<typeof conversationSummaryOutputSchema>;
  try {
    // 2026-08-24：裸 JSON.parse → 容错解析（剥 fence/提取平衡片段）——与
    // memory-extractor 同款兜底，tokenrhythm 类网关偶发的 ```json 包裹不再丢摘要。
    summary = conversationSummaryOutputSchema.parse(parseMemoryExtractJson(raw));
  } catch (err) {
    logger.warn({ jobId: job.id, conversationId, err }, "summarizer invalid output; skipping");
    // §9.9：记录摘要失败指标（输出校验失败）
    try {
      companionSummaryTotal.labels("failed").inc();
    } catch {
      // metrics 记录失败不阻断
    }
    return;
  }

  const sourceRunId = job.payload.sourceRunId as string | null ?? null;
  const idempotencyKey = `summary:${conversationId}:${sourceRunId ?? "conversation"}`;

  await withJobTransaction(job, async (tx) => {
    // 稳定 P1-1（2026-09-15 审计）：提交前重新校验并续租租约（TOCTOU 围栏）。
    // 入口的 assertJobLease 只挡"开始时已失效"，挡不住"LLM 调用期间被 reap"——
    // 过期后另一个 worker 会重领同一 job 并重复写入/重复计费。与 parse-source
    // 的每次提交前 lockJobLease 对齐。
    await lockJobLease(tx, job);
    // conversation_summaries 幂等写入（唯一约束兜底）。
    await tx.execute(sql`
      INSERT INTO conversation_summaries
        (workspace_id, user_id, conversation_id, summary, source_run_id, status, created_at, updated_at)
      VALUES
        (${job.workspaceId}, ${userId}, ${conversationId}, ${JSON.stringify(summary)}, ${sourceRunId},
         'candidate', now(), now())
      ON CONFLICT (workspace_id, user_id, conversation_id, source_run_id)
      DO UPDATE SET summary = EXCLUDED.summary, updated_at = now()
    `);

    // 生成 episodic 候选记忆。§9.4：写入端即限制 ≤200 字，确保读取注入时不需截断。
    const episodicContent = (summary.title + "：" + summary.keyEvents.slice(0, 3).join("；")).slice(0, 200);
    await tx.execute(sql`
      INSERT INTO assistant_memory_items
        (workspace_id, user_id, kind, content, source_event_id, user_stated, user_confirmed,
         candidate, importance, confidence, scope, source_type, embedding_status, created_at, updated_at)
      VALUES
        (${job.workspaceId}, ${userId}, 'episodic',
         ${episodicContent},
         ${`summary:${conversationId}:${sourceRunId ?? "conversation"}`},
         false, false, true, 0.4, 0.7, 'workspace', 'summary', 'pending', now(), now())
      ON CONFLICT (workspace_id, user_id, kind, source_event_id)
        WHERE deleted_at IS NULL AND source_event_id IS NOT NULL
      DO NOTHING
    `);
  });

  logger.info({ jobId: job.id, conversationId, idempotencyKey }, "summarizer completed");
  // §9.9：记录摘要成功指标
  try {
    companionSummaryTotal.labels("success").inc();
  } catch {
    // metrics 记录失败不阻断
  }
}
