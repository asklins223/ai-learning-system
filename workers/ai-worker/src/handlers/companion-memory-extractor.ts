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
import type { JobPayload } from "./index.ts";

const memoryExtractCandidateSchema = z.object({
  kind: z.enum(["preference", "goal", "learning_context", "interaction_note", "episodic"]),
  // §9.4：写入端即限制 ≤200 字，确保读取注入时不需截断、不丢失信息。
  content: z.string().min(1).max(200),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  scope: z.enum(["global", "workspace", "task"]).default("workspace"),
  linkedEntityIds: z.array(z.string()).max(10).default([]),
});

export const memoryExtractOutputSchema = z.object({
  version: z.literal(1),
  candidates: z.array(memoryExtractCandidateSchema).max(3).default([]),
});

const EXTRACT_PROMPT = [
  "你是桌宠的记忆整理器。根据对话判断是否有值得长期记住的信息。",
  "只提取用户明确表达或高置信推断的信息。",
  "每条记忆内容不超过 200 字，只保留核心信息，不要赘述。",
  "输出严格 JSON，不要输出其他内容。",
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
  const runId = job.payload.runId as string | undefined;
  const userId = job.payload.userId as string | undefined;
  if (!runId || !userId) throw new Error("companion_memory_extract payload 缺 runId/userId");
  await assertJobLease(job);

  const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
  if (!govCtx.consentOk) throw new AIConsentRequiredError();
  const textRes = resolveProviderForTask(govCtx, "companion_dialogue");
  const provider = createProvider(textRes.providerName, textRes.providerConfig);

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
  let raw: string | null = null;
  let parsed: z.SafeParseReturnType<unknown, z.infer<typeof memoryExtractOutputSchema>> | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await runWithAbortBudget(
        (signal) => provider.chatCompletion(messages, { temperature: 0.2, maxTokens: 800, responseFormat: "text" }, signal),
        job.signal,
        resolveProviderCallTimeout("companion_dialogue"),
        (lateError) => logger.warn({ jobId: job.id, err: lateError }, "memory extract provider settled late"),
      );
      raw = result.content;
      let candidate: z.SafeParseReturnType<unknown, z.infer<typeof memoryExtractOutputSchema>> | null = null;
      try {
        candidate = memoryExtractOutputSchema.safeParse(parseMemoryExtractJson(raw));
      } catch {
        candidate = null;
      }
      if (candidate?.success) {
        parsed = candidate;
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
      logger.warn({ jobId: job.id, runId, err, attempt }, "memory extract provider failed; skipping");
      return;
    }
  }
  if (raw === null || !parsed) return;
  const parseResult = parsed as z.SafeParseReturnType<unknown, z.infer<typeof memoryExtractOutputSchema>>;
  if (!parseResult.success) {
    logger.warn({ jobId: job.id, runId, error: parseResult.error.message }, "memory extract invalid JSON; skipping");
    return;
  }

  // §9.1：只有置信度 > 0.6 才生成候选（严格大于，不含等于）。
  const candidates = parseResult.data.candidates.filter((c) => c.confidence > 0.6);
  if (candidates.length === 0) {
    // 2026-08-16（溯源）：候选被过滤/为空时留痕——区分"LLM 没提取到"与
    // "提取到但置信不足"，便于排查记忆链路。
    logger.info(
      {
        jobId: job.id,
        runId,
        rawCandidates: parseResult.data.candidates.length,
        rawPreview: raw.slice(0, 160),
      },
      "memory extract no candidates after confidence filter",
    );
    return;
  }

  await withJobTransaction(job, async (tx) => {
    // 防止同一用户并发提取时 inbox_sequence 冲突。
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`delivery:${job.workspaceId}:${userId}`}, 0))
    `);
    for (const [index, candidate] of candidates.entries()) {
      const sourceEventId = `memory-extract:${runId}:${index}`;
      await tx.execute(sql`
        INSERT INTO assistant_memory_items
          (workspace_id, user_id, kind, content, source_event_id, user_stated, user_confirmed,
           candidate, importance, confidence, scope, source_type, embedding_status, created_at, updated_at)
        VALUES
          (${job.workspaceId}, ${userId}, ${candidate.kind}, ${candidate.content}, ${sourceEventId},
           false, false, true, ${candidate.importance}, ${candidate.confidence}, ${candidate.scope},
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
        const dedupeKey = `memory-candidate:${sourceEventId}`;
        const payloadRef = JSON.stringify({ kind: "memory_item", memoryItemId: memoryId });
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

  logger.info({ jobId: job.id, runId, count: candidates.length }, "memory extract completed");
}
