/**
 * Companion 对话 DB 编排原语（2026-08-24 AI 设计审查 §4.4 拆分）。
 *
 * 自 companion-dialogue.ts 拆出：
 * - ReadContext：read 阶段冻结的上下文结构；
 * - insertStreamEvent / emitCompanionTtsSegment：事件写入（独立事务 + fence）；
 * - markCompanionRunFailed：run failed + error event（fence：仅 active 可写终态）;
 * - readGroundedTutorContext / parsePageContext 的 DB 侧使用、
 *   enqueueCompanionMemoryJobs：终态事务内异步入队记忆任务；
 * - feature flags 与 grounded-tutor prompt 常量。
 */

import { sha256Hex } from "@ailearn/shared/content-hash";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.ts";
import { withWorkerWorkspaceTransaction } from "../db.ts";
// 2026-08-25（AI 设计审计修复）：复用 content 模块的同一实现，消除拆分时
// 复制出的双份 parsePageContext（两份漂移会让编排层与 DB 层对同一
// page_context 得出不同判定）。content→store 无依赖边，不构成循环。
import { parsePageContext } from "./companion-dialogue-content.ts";

/** 与 turn-service 对齐的硬限额（03 §6.10）。 */
export interface CompanionDialogueHandlerContext {
  id: string;
  payload: Record<string, unknown>;
  workspaceId: string;
  requestedBy: string | null;
  leaseToken: string;
  signal: AbortSignal;
}

export interface ReadContext {
  runId: string;
  conversationId: string;
  userId: string;
  userMessageId: string;
  generation: number;
  runStatus: string;
  /** L11：run 创建时冻结的账号世代（surface_epoch）。 */
  accountEpoch: number;
  pageContext: unknown;
  groundedTutorContext: import("./companion-dialogue-content.ts").GroundedTutorContext | null;
  userText: string;
  recentMessages: { role: "user" | "assistant"; text: string }[];
  activeMemories: { kind: string; content: string }[];
  petProfile: {
    name: string;
    speakingStyle: string;
    personalityTags: string[];
    examples: { text: string }[];
  } | null;
  nextMessageSeq: number;
  nextEventSeq: number;
}

interface InsertStreamEventArgs {
  conversationId: string;
  workspaceId: string;
  userId: string;
  runId: string;
  generation: number;
  accountEpoch: number;
  seq: number;
  type: string;
  payload: unknown;
  expiresAt: string;
}

export async function insertStreamEvent(
  tx: { execute(query: unknown): Promise<unknown> },
  args: InsertStreamEventArgs,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO companion_stream_events
      (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
    VALUES
      (${args.conversationId}, ${args.seq}, ${args.workspaceId}, ${args.userId},
       ${args.runId}, ${args.generation}, ${args.accountEpoch}, ${args.type},
       ${JSON.stringify(args.payload)}, ${args.expiresAt})
  `);
}

/**
 * 15b（字幕般流式 TTS）：发送一条 voice.segment.ready——独立事务
 * （fence 校验 + seq + NOTIFY），与 delta flush 同构。段事件在 final 之前
 * 逐个下发，前端边收段边送 TTS 引擎 → 音频边回边播。
 * 返回 false 表示 run 已终态（fence 拒绝），调用方应停止后续段。
 */
export async function emitCompanionTtsSegment(args: {
  workspaceId: string;
  userId: string;
  runId: string;
  generation: number;
  accountEpoch: number;
  conversationId: string;
  expiresAt: string;
  segmentId: string;
  ordinal: number;
  text: string;
  textSha256: string;
  /** 15b 二期：段级情感（段内最后一个控制类标签，无则省略）——live2d 协同预留 */
  emotion?: string;
  notifyCompanionEvent: (tx: { execute(q: unknown): Promise<unknown> }, seq: number) => Promise<void>;
}): Promise<boolean> {
  return withWorkerWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const alive = await tx.execute<{ id: string }>(sql`
        UPDATE companion_turn_runs
        SET status = 'running', updated_at = now()
        WHERE id = ${args.runId} AND status IN ('accepted', 'running')
          AND generation = ${args.generation}
        RETURNING id
      `);
      if (!alive[0]) return false;
      const counters = await tx.execute<{ next_event_seq: string }>(sql`
        UPDATE companion_conversations
        SET next_event_seq = next_event_seq + 1
        WHERE id = ${args.conversationId}
        RETURNING next_event_seq
      `);
      const seq = Number(counters[0].next_event_seq) - 1;
      await insertStreamEvent(tx, {
        conversationId: args.conversationId,
        workspaceId: args.workspaceId,
        userId: args.userId,
        runId: args.runId,
        generation: args.generation,
        accountEpoch: args.accountEpoch,
        seq,
        type: "voice.segment.ready",
        payload: {
          segmentId: args.segmentId,
          ordinal: args.ordinal,
          text: args.text,
          textSha256: args.textSha256,
          ...(args.emotion ? { emotion: args.emotion } : {}),
        },
        expiresAt: args.expiresAt,
      });
      await args.notifyCompanionEvent(tx, seq);
      return true;
    },
  );
}

// V2: read grounded tutor context from learning_objectives_v2 +
// learning_objective_revisions_v2 (claim → objective_statement) +
// evidence_snapshots_v2 + learning_objective_evidence_bindings_v2.
// key_point_id is now an alias for objective_id; card_id validates
// the card exists via learning_cards_v2.
export async function readGroundedTutorContext(
  tx: { execute(query: unknown): Promise<unknown> },
  pageContext: unknown,
  scope: { workspaceId: string; userId: string },
): Promise<import("./companion-dialogue-content.ts").GroundedTutorContext | null> {
  const context = parsePageContextForStore(pageContext);
  if (context?.pageKind !== "learning_session" || context.requestedCapability !== "grounded_tutor") {
    return null;
  }
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : null;
  const episodeId = typeof context.episodeId === "string" ? context.episodeId : null;
  const cardId = typeof context.cardId === "string" ? context.cardId : null;
  const keyPointId = typeof context.keyPointId === "string" ? context.keyPointId : null;
  if (!sessionId || !episodeId || !cardId || !keyPointId) return null;

  // V2: claim from learning_objective_revisions_v2.objective_statement
  const claimRows = await tx.execute(sql`
    SELECT rev.objective_statement AS claim
    FROM learning_episodes ep
    JOIN learning_objectives_v2 o ON o.objective_id = ep.key_point_id
    JOIN learning_objective_revisions_v2 rev ON rev.objective_revision_id = o.current_objective_revision_id
    WHERE ep.id = ${episodeId}
      AND ep.session_id = ${sessionId}
      AND ep.workspace_id = ${scope.workspaceId}
      AND ep.user_id = ${scope.userId}
      AND o.workspace_id = ${scope.workspaceId}
    LIMIT 1
  `) as Array<{ claim: string | null }>;
  const claim = claimRows[0]?.claim?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!claim) return null;

  // V2: evidence from evidence_snapshots_v2 joined via
  // learning_objective_evidence_bindings_v2 (bound to objective revision).
  // block_content from note_blocks (still exists in V2 schema).
  const evidenceRows = await tx.execute(sql`
    SELECT es.protected_quote_ref AS quote_text,
           nb.content AS block_content,
           es.support_description
    FROM learning_episodes ep
    JOIN learning_objectives_v2 o ON o.objective_id = ep.key_point_id
    JOIN learning_objective_revisions_v2 rev ON rev.objective_revision_id = o.current_objective_revision_id
    JOIN learning_objective_evidence_bindings_v2 b ON b.objective_revision_id = rev.objective_revision_id
    JOIN evidence_snapshots_v2 es ON es.evidence_snapshot_id = b.evidence_snapshot_id
    LEFT JOIN note_blocks nb ON nb.id = es.block_id AND nb.workspace_id = es.workspace_id
    WHERE ep.id = ${episodeId}
      AND ep.session_id = ${sessionId}
      AND ep.workspace_id = ${scope.workspaceId}
      AND ep.user_id = ${scope.userId}
      AND o.workspace_id = ${scope.workspaceId}
      AND es.workspace_id = ${scope.workspaceId}
    ORDER BY es.created_at DESC
    LIMIT 8
  `) as Array<{
    quote_text: string | null;
    block_content: string | null;
    support_description: string | null;
  }>;
  const valid = evidenceRows.filter(() => {
    // V2: all evidence snapshots that are bound are considered "hard" —
    // the alignment/effective_override concept was removed.
    return true;
  });
  if (valid.length === 0) return null;
  const evidence = valid
    .map((row) => row.block_content?.trim() || row.quote_text?.trim() || row.support_description?.trim() || "")
    .filter((value) => value.length > 0)
    .slice(0, 5)
    .map((value) => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, 1_200));
  return evidence.length > 0 ? { claim: claim.slice(0, 800), evidence } : null;
}

function parsePageContextForStore(value: unknown): Record<string, unknown> | null {
  return parsePageContext(value);
}

export function isActiveRun(status: string): boolean {
  return status === "accepted" || status === "running";
}

export function isCompanionDialogueEnabled(): boolean {
  return process.env.COMPANION_DIALOGUE_V1_ENABLED === "true";
}

export function isCompanionVoiceDialogueEnabled(): boolean {
  return process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED === "true";
}

/** 22 方案记忆上下文开关：任一记忆相关 flag 开启即启用新检索/回传链路。 */
export function isCompanionMemoryContextEnabled(): boolean {
  return process.env.COMPANION_MEMORY_VECTOR_V1 === "true"
    || process.env.COMPANION_MEMORY_EXTRACTOR_V1 === "true"
    || process.env.COMPANION_SUMMARIZER_V1 === "true";
}

/**
 * 在终态事务内异步入队记忆提取/摘要任务。
 * 幂等：jobs.idempotency_key 唯一索引兜底。
 */
export async function enqueueCompanionMemoryJobs(
  tx: { execute(query: unknown): Promise<unknown> },
  args: {
    workspaceId: string;
    userId: string;
    runId: string;
    conversationId: string;
    messageSeq: number;
  },
): Promise<void> {
  if (process.env.COMPANION_MEMORY_EXTRACTOR_V1 === "true") {
    await tx.execute(sql`
      INSERT INTO jobs
        (type, workspace_id, requested_by, payload, status, priority, resource_class, idempotency_key)
      VALUES
        ('companion_memory_extract', ${args.workspaceId}, ${args.userId},
         ${JSON.stringify({ runId: args.runId, userId: args.userId })},
         'pending', 10, 'maintenance', ${`memory-extract:${args.runId}`})
      ON CONFLICT (workspace_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING
    `);
  }
  if (process.env.COMPANION_SUMMARIZER_V1 === "true" && args.messageSeq >= 30) {
    await tx.execute(sql`
      INSERT INTO jobs
        (type, workspace_id, requested_by, payload, status, priority, resource_class, idempotency_key)
      VALUES
        ('companion_summarizer', ${args.workspaceId}, ${args.userId},
         ${JSON.stringify({ conversationId: args.conversationId, userId: args.userId, sourceRunId: args.runId })},
         'pending', 10, 'maintenance', ${`summary:${args.conversationId}:${args.runId}`})
      ON CONFLICT (workspace_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING
    `);
  }
}

/** run failed + error event（fence：仅 active run 可写终态；cancel/supersede 后零写入）。 */
export async function markCompanionRunFailed(
  read: Pick<ReadContext, "runId" | "conversationId" | "userId" | "generation" | "accountEpoch">,
  workspaceId: string,
  code: string,
  recoverable: boolean,
  reason: string,
): Promise<void> {
  try {
    await withWorkerWorkspaceTransaction(
      { workspaceId, userId: read.userId },
      async (tx) => {
        // fence：只有 run 仍 active 才标记 failed（已被 cancel/supersede → 不写 error event，
        // turn.cancelled 已由 cancel 路径负责）。
        const claimed = await tx.execute<{ id: string }>(sql`
          UPDATE companion_turn_runs
          SET status = 'failed', error_code = ${code}, finished_at = now()
          WHERE id = ${read.runId} AND status IN ('accepted', 'running')
          RETURNING id
        `);
        if (!claimed[0]) return;
        const counters = await tx.execute<{ next_event_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_event_seq = next_event_seq + 2
          WHERE id = ${read.conversationId}
          RETURNING next_event_seq
        `);
        const next = counters[0];
        if (!next) return;
        const seq = Number(next.next_event_seq) - 2;
        const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
        await insertStreamEvent(tx, {
          conversationId: read.conversationId,
          workspaceId,
          userId: read.userId,
          runId: read.runId,
          generation: read.generation,
          accountEpoch: read.accountEpoch,
          seq,
          type: "error",
          payload: {
            code,
            message: reason.slice(0, 240),
            recoverable,
            requestId: read.runId,
          },
          expiresAt,
        });
        // §5.2 确定性来源：安全错误 → uncertain/concerned/0.45（与 error 同事务原子下发）。
        await insertStreamEvent(tx, {
          conversationId: read.conversationId,
          workspaceId,
          userId: read.userId,
          runId: read.runId,
          generation: read.generation,
          accountEpoch: read.accountEpoch,
          seq: seq + 1,
          type: "character.cue",
          payload: { cue: ERROR_CUE_PAYLOAD },
          expiresAt,
        });
        await tx.execute(sql`
          UPDATE companion_turn_runs
          SET last_event_seq = ${seq + 1}, updated_at = now()
          WHERE id = ${read.runId}
        `);
        await tx.execute(sql`
          UPDATE companion_stream_events
          SET expires_at = ${expiresAt}
          WHERE conversation_id = ${read.conversationId} AND run_id = ${read.runId}
        `);
        await tx.execute(sql`
          SELECT pg_notify('ailearn_companion_events_v1',
                           ${JSON.stringify({ conversationId: read.conversationId, maxSeq: seq + 1 })})
        `);
        logger.warn({ runId: read.runId, code, reason }, "companion run marked failed");
      },
    );
  } catch (err) {
    logger.warn({ runId: read.runId, err }, "markCompanionRunFailed failed");
  }
}

import { ERROR_CUE_PAYLOAD_V1 as ERROR_CUE_PAYLOAD } from "./companion-dialogue-content.ts";

/** grounded-tutor 分支的审计元数据（prompt id/hash）。 */
export const GROUNDED_TUTOR_PROMPT_ID = "companion-grounded-tutor-v1";

export function computeGroundedTutorPromptSha256(prompt: string): string {
  return sha256Hex(prompt);
}
