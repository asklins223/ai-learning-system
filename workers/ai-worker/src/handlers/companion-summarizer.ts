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
import { createProvider } from "../lib/ai-provider.ts";
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
  "你是桌宠的会话摘要器。把以下对话压缩成结构化摘要：",
  "- 主题",
  "- 用户目标",
  "- 关键事件",
  "- 用户偏好",
  "- 待跟进事项",
  "- 情绪状态",
  "只输出 JSON。",
].join("\n");

export function buildSummarizerMessages(conversationText: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: SUMMARIZER_PROMPT },
    { role: "user", content: conversationText.slice(0, 12_000) },
  ];
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
  const provider = createGovernedProvider(
    createProvider(textRes.providerName, textRes.providerConfig),
    govCtx,
    job.workspaceId,
    // AI P0-8（2026-09-15 审计）：接上 ai_audit_log 的唯一写入口（此前零调用）。
    // ai_audit_log.user_id 是 NOT NULL，故 payload 未带可信 actor 时不写审计行。
    userId
      ? { userId, operation: "companion_summarizer", jobId: job.id }
      : undefined,
  );

  const conversationText = await withJobTransaction(job, async (tx) => {
    const rows = await tx.execute<{ role: string; blocks: unknown }>(sql`
      SELECT role, blocks FROM companion_messages
      WHERE conversation_id = ${conversationId}
      ORDER BY seq ASC LIMIT 200
    `);
    return rows
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
