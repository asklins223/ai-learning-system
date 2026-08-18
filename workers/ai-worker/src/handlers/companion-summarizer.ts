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
import { createProvider } from "../lib/ai-provider.ts";
import {
  AIConsentRequiredError,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { assertJobLease, withJobTransaction } from "../lib/job-lease.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { companionSummaryTotal } from "../lib/metrics.ts";
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
  const conversationId = job.payload.conversationId as string | undefined;
  const userId = job.payload.userId as string | undefined;
  if (!conversationId || !userId) throw new Error("companion_summarizer payload 缺 conversationId/userId");
  await assertJobLease(job);

  const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
  if (!govCtx.consentOk) throw new AIConsentRequiredError();
  const textRes = resolveProviderForTask(govCtx, "companion_dialogue");
  const provider = createProvider(textRes.providerName, textRes.providerConfig);

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
      (signal) => provider.chatCompletion(messages, { temperature: 0.2, maxTokens: 1000, responseFormat: "text" }, signal),
      job.signal,
      resolveProviderCallTimeout("companion_dialogue"),
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
    summary = conversationSummaryOutputSchema.parse(JSON.parse(raw));
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

    // 生成 episodic 候选记忆。
    await tx.execute(sql`
      INSERT INTO assistant_memory_items
        (workspace_id, user_id, kind, content, source_event_id, user_stated, user_confirmed,
         candidate, importance, confidence, scope, source_type, embedding_status, created_at, updated_at)
      VALUES
        (${job.workspaceId}, ${userId}, 'episodic',
         ${summary.title + "：" + summary.keyEvents.slice(0, 3).join("；")},
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
