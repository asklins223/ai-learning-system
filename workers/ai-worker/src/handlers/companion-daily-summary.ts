/**
 * 桌宠日记生成器（22-real-desktop-pet-memory-context-prd-tdd.md §15.4/§15.5）。
 *
 * 读取指定用户本地日期的事实计数与对话拾遗，确定性模板生成 summary，
 * 写入 companion_daily_summaries 并幂等创建 learning_context 候选记忆。
 */

import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import { assertJobLease, withJobTransaction } from "../lib/job-lease.ts";
import type { JobPayload } from "./index.ts";

interface DailyFacts {
  notesCreated: number;
  notesUpdated: number;
  cardsCreated: number;
  sourcesCreated: number;
  jobsCreated: number;
  jobsCompleted: number;
  learningRunsCreated: number;
  learningRunsCompleted: number;
  pageContexts: number;
  conversationMessages: number;
  userMessages: number;
  assistantMessages: number;
}

export function buildSummaryText(date: string, facts: DailyFacts): string {
  const parts: string[] = [];
  parts.push(`${date} 的学习小结：`);
  if (facts.notesCreated > 0 || facts.notesUpdated > 0) {
    parts.push(`新建/更新笔记 ${facts.notesCreated}/${facts.notesUpdated} 条`);
  }
  if (facts.cardsCreated > 0) parts.push(`新增学习卡 ${facts.cardsCreated} 张`);
  if (facts.sourcesCreated > 0) parts.push(`收录资料 ${facts.sourcesCreated} 份`);
  if (facts.learningRunsCreated > 0 || facts.learningRunsCompleted > 0) {
    parts.push(`学习运行创建/完成 ${facts.learningRunsCreated}/${facts.learningRunsCompleted}`);
  }
  if (facts.conversationMessages > 0) {
    parts.push(`与桌宠对话 ${facts.conversationMessages} 条`);
  }
  if (parts.length === 1) return `${date} 没有留下明显学习痕迹。`;
  return parts.join("；") + "。";
}

export async function runCompanionDailySummary(job: JobPayload): Promise<void> {
  const date = job.payload.date as string | undefined;
  const timezone = job.payload.timezone as string | undefined;
  const userId = job.payload.userId as string | undefined;
  if (!date || !timezone || !userId) {
    throw new Error("companion_daily_summary payload 缺 date/timezone/userId");
  }
  await assertJobLease(job);

  const facts = await withJobTransaction(job, async (tx) => {
    const rows = await tx.execute<Record<string, unknown>>(sql`
      WITH day AS (
        SELECT
          (${date}::date AT TIME ZONE ${timezone}) AS day_start,
          ((${date}::date + 1) AT TIME ZONE ${timezone}) AS day_end
      )
      SELECT
        (SELECT count(*)::int FROM notes WHERE workspace_id = ${job.workspaceId} AND created_by = ${userId}
          AND created_at >= (SELECT day_start FROM day) AND created_at < (SELECT day_end FROM day)
          AND deleted_at IS NULL) AS notes_created,
        (SELECT count(*)::int FROM notes WHERE workspace_id = ${job.workspaceId} AND created_by = ${userId}
          AND updated_at >= (SELECT day_start FROM day) AND updated_at < (SELECT day_end FROM day)
          AND deleted_at IS NULL) AS notes_updated,
        (SELECT count(*)::int FROM learning_cards WHERE workspace_id = ${job.workspaceId}
          AND created_at >= (SELECT day_start FROM day) AND created_at < (SELECT day_end FROM day)) AS cards_created,
        (SELECT count(*)::int FROM sources WHERE workspace_id = ${job.workspaceId}
          AND created_at >= (SELECT day_start FROM day) AND created_at < (SELECT day_end FROM day)) AS sources_created,
        (SELECT count(*)::int FROM jobs WHERE workspace_id = ${job.workspaceId} AND requested_by = ${userId}
          AND scheduled_at >= (SELECT day_start FROM day) AND scheduled_at < (SELECT day_end FROM day)) AS jobs_created,
        (SELECT count(*)::int FROM jobs WHERE workspace_id = ${job.workspaceId} AND requested_by = ${userId}
          AND finished_at >= (SELECT day_start FROM day) AND finished_at < (SELECT day_end FROM day)
          AND status = 'succeeded') AS jobs_completed,
        (SELECT count(*)::int FROM learning_runs WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND created_at >= (SELECT day_start FROM day) AND created_at < (SELECT day_end FROM day)) AS learning_runs_created,
        (SELECT count(*)::int FROM learning_runs WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND updated_at >= (SELECT day_start FROM day) AND updated_at < (SELECT day_end FROM day)
          AND phase = 'completed') AS learning_runs_completed,
        (SELECT count(DISTINCT page_kind)::int FROM assistant_page_contexts
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND created_at >= (SELECT day_start FROM day) AND created_at < (SELECT day_end FROM day)) AS page_contexts,
        (SELECT count(*)::int FROM companion_messages
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND created_at >= (SELECT day_start FROM day) AND created_at < (SELECT day_end FROM day)) AS conversation_messages,
        (SELECT count(*)::int FROM companion_messages
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND role = 'user'
          AND created_at >= (SELECT day_start FROM day) AND created_at < (SELECT day_end FROM day)) AS user_messages,
        (SELECT count(*)::int FROM companion_messages
          WHERE workspace_id = ${job.workspaceId} AND user_id = ${userId}
          AND role = 'assistant'
          AND created_at >= (SELECT day_start FROM day) AND created_at < (SELECT day_end FROM day)) AS assistant_messages
    `);
    const row = (Array.isArray(rows) ? rows : [])[0] ?? {};
    return {
      notesCreated: Number(row.notes_created ?? 0),
      notesUpdated: Number(row.notes_updated ?? 0),
      cardsCreated: Number(row.cards_created ?? 0),
      sourcesCreated: Number(row.sources_created ?? 0),
      jobsCreated: Number(row.jobs_created ?? 0),
      jobsCompleted: Number(row.jobs_completed ?? 0),
      learningRunsCreated: Number(row.learning_runs_created ?? 0),
      learningRunsCompleted: Number(row.learning_runs_completed ?? 0),
      pageContexts: Number(row.page_contexts ?? 0),
      conversationMessages: Number(row.conversation_messages ?? 0),
      userMessages: Number(row.user_messages ?? 0),
      assistantMessages: Number(row.assistant_messages ?? 0),
    };
  });

  const highlights = await withJobTransaction(job, async (tx) => {
    const rows = await tx.execute<{ role: string; text: string }>(sql`
      SELECT m.role, COALESCE(
        (SELECT string_agg(b->>'text', '') FROM jsonb_array_elements(m.blocks) b WHERE b->>'type' = 'text'),
        ''
      ) AS text
      FROM companion_messages m
      WHERE m.workspace_id = ${job.workspaceId} AND m.user_id = ${userId}
        AND m.created_at >= ((${date}::date AT TIME ZONE ${timezone}))
        AND m.created_at < ((${date}::date + 1) AT TIME ZONE ${timezone})
      ORDER BY m.created_at DESC
      LIMIT 8
    `);
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      role: (row.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      text: String(row.text ?? "").slice(0, 160),
    }));
  });

  const summary = buildSummaryText(date, facts);
  const memoryContent = `${date} 桌宠日记：${summary}`.slice(0, 2000);

  await withJobTransaction(job, async (tx) => {
    await tx.execute(sql`
      INSERT INTO companion_daily_summaries
        (workspace_id, user_id, date, timezone, facts, highlights, summary, status, revision, generated_at, created_at, updated_at)
      VALUES
        (${job.workspaceId}, ${userId}, ${date}, ${timezone},
         ${JSON.stringify(facts)}::jsonb, ${JSON.stringify(highlights)}::jsonb,
         ${summary}, 'generated', 1, now(), now(), now())
      ON CONFLICT (workspace_id, user_id, date)
      DO UPDATE SET timezone = EXCLUDED.timezone, facts = EXCLUDED.facts,
                    highlights = EXCLUDED.highlights, summary = EXCLUDED.summary,
                    status = 'generated', revision = companion_daily_summaries.revision + 1,
                    generated_at = now(), updated_at = now()
    `);
    await tx.execute(sql`
      INSERT INTO assistant_memory_items
        (workspace_id, user_id, kind, content, source_event_id, user_stated, user_confirmed,
         candidate, importance, confidence, scope, source_type, embedding_status, created_at, updated_at)
      VALUES
        (${job.workspaceId}, ${userId}, 'learning_context', ${memoryContent},
         ${`daily-summary:${date}`}, false, false, true, 0.5, 0.7, 'workspace', 'summary', 'pending', now(), now())
      ON CONFLICT (workspace_id, user_id, kind, source_event_id)
        WHERE deleted_at IS NULL AND source_event_id IS NOT NULL
      DO NOTHING
    `);
  });

  logger.info({ jobId: job.id, date, timezone }, "companion daily summary generated");
}
