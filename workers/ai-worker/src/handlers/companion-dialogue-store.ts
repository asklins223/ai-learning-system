/**
 * Companion 对话 DB 编排原语（2026-08-24 AI 设计审查 §4.4 拆分）。
 *
 * 自 companion-dialogue.ts 拆出：
 * - ReadContext：read 阶段冻结的上下文结构；
 * - insertStreamEvent / emitCompanionTtsSegments：事件写入（独立事务 + fence）；
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
import {
  materializeGroundedTutorEvidence,
  type GroundedTutorEvidenceRow,
} from "./companion-grounded-evidence.ts";

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

export interface CompanionTtsSegmentEvent {
  version: 2;
  segmentId: string;
  ordinal: number;
  displayText: string;
  displayStart: number;
  displayEnd: number;
  synthesisText: string;
  synthesisTextSha256: string;
  cue: {
    version: 1;
    intent: "think" | "explain" | "encourage" | "celebrate" | "uncertain" | "warn" | "sleep";
    emotion: "neutral" | "happy" | "curious" | "concerned" | "surprised";
    intensity: number;
    durationMs?: number;
  };
}

/**
 * 15b（字幕般流式 TTS）：下发 voice.segment.ready——每事务一批
 * （fence 校验一次 + 连续 seq 分配 + 多行 INSERT + 批尾 NOTIFY）。
 *
 * 段事件在 final 之前按 ordinal 顺序下发，前端按批收到后送 TTS 引擎排队合成。
 * 一段一个事务在 200 段上限下是 200 个事务（每事务 5 条语句），批量后降到 1/4。
 * 返回 false 表示 run 已终态（fence 拒绝），调用方应停止后续段。
 */
export async function emitCompanionTtsSegments(args: {
  workspaceId: string;
  userId: string;
  runId: string;
  generation: number;
  accountEpoch: number;
  conversationId: string;
  expiresAt: string;
  segments: CompanionTtsSegmentEvent[];
  notifyCompanionEvent: (tx: { execute(q: unknown): Promise<unknown> }, seq: number) => Promise<void>;
}): Promise<boolean> {
  const SEGMENTS_PER_TX = 4;
  for (let i = 0; i < args.segments.length; i += SEGMENTS_PER_TX) {
    const batch = args.segments.slice(i, i + SEGMENTS_PER_TX);
    const written = await withWorkerWorkspaceTransaction(
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
          SET next_event_seq = next_event_seq + ${batch.length}
          WHERE id = ${args.conversationId}
          RETURNING next_event_seq
        `);
        const nextEventSeq = counters[0]?.next_event_seq;
        if (nextEventSeq === undefined) {
          throw new Error("conversation event counter update returned no row");
        }
        const endSeq = Number(nextEventSeq) - 1;
        const startSeq = endSeq - batch.length + 1;
        await tx.execute(sql`
          INSERT INTO companion_stream_events
            (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
          VALUES ${sql.join(batch.map((segment, j) => sql`(
            ${args.conversationId}, ${startSeq + j}, ${args.workspaceId}, ${args.userId},
            ${args.runId}, ${args.generation}, ${args.accountEpoch}, 'voice.segment.ready',
            ${JSON.stringify({
              version: segment.version,
              segmentId: segment.segmentId,
              ordinal: segment.ordinal,
              displayText: segment.displayText,
              displayStart: segment.displayStart,
              displayEnd: segment.displayEnd,
              synthesisText: segment.synthesisText,
              synthesisTextSha256: segment.synthesisTextSha256,
              cue: segment.cue,
            })}, ${args.expiresAt}
          )`), sql`, `)}
        `);
        await args.notifyCompanionEvent(tx, endSeq);
        return true;
      },
    );
    if (!written) return false;
  }
  return true;
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
  if (context?.requestedCapability !== "grounded_tutor") {
    return null;
  }
  if (context.pageKind === "learning_run") {
    return readGroundedTutorContextForLearningRun(tx, context, scope);
  }
  return null;
}

/**
 * 新 LearningRun 只读取 PREPARE 冻结的 target/evidence closure。即使
 * Objective 在 Run 期间更新，也不会把新 claim 或新证据带进已授权的 Tutor。
 */
async function readGroundedTutorContextForLearningRun(
  tx: { execute(query: unknown): Promise<unknown> },
  context: Record<string, unknown>,
  scope: { workspaceId: string; userId: string },
): Promise<import("./companion-dialogue-content.ts").GroundedTutorContext | null> {
  const runId = typeof context.runId === "string" ? context.runId : null;
  const snapshotId = typeof context.snapshotId === "string" ? context.snapshotId : null;
  const taskId = typeof context.taskId === "string" ? context.taskId : null;
  if (!runId || !snapshotId || !taskId) return null;

  const frozenRows = await tx.execute(sql`
    SELECT s.target, s.evidence_bindings
    FROM learning_runs r
    JOIN learning_run_private_contracts c
      ON c.run_id = r.id
      AND c.workspace_id = ${scope.workspaceId}
      AND c.user_id = ${scope.userId}
      AND c.snapshot_id = ${snapshotId}
    JOIN learning_target_snapshots_v2 s
      ON s.run_id = r.id
      AND s.snapshot_id = c.snapshot_id
      AND s.workspace_id = ${scope.workspaceId}
      AND s.user_id = ${scope.userId}
    JOIN learning_tasks t
      ON t.id = r.active_task_id
      AND t.id = ${taskId}
      AND t.run_id = r.id
      AND t.workspace_id = ${scope.workspaceId}
      AND t.user_id = ${scope.userId}
      AND t.status = 'active'
    WHERE r.id = ${runId}
      AND r.workspace_id = ${scope.workspaceId}
      AND r.user_id = ${scope.userId}
      AND r.phase = 'active'
      AND s.published_target_eligibility IN ('eligible', 'practice_only')
    LIMIT 1
  `) as Array<{ target: unknown; evidence_bindings: unknown }>;
  const frozen = frozenRows[0];
  if (!frozen || !frozen.target || typeof frozen.target !== "object" || !Array.isArray(frozen.evidence_bindings)) {
    return null;
  }

  const claimValue = (frozen.target as { objectiveStatement?: unknown }).objectiveStatement;
  const claim = typeof claimValue === "string"
    ? claimValue.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  if (!claim) return null;

  const allExpectedById = new Map<string, string>();
  const expectedById = new Map<string, string>();
  for (const raw of frozen.evidence_bindings) {
    if (!raw || typeof raw !== "object") return null;
    const binding = raw as { evidenceSnapshotId?: unknown; evidenceSnapshotHash?: unknown };
    if (
      typeof binding.evidenceSnapshotId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.evidenceSnapshotId)
      || typeof binding.evidenceSnapshotHash !== "string"
      || !/^[0-9a-f]{64}$/i.test(binding.evidenceSnapshotHash)
    ) {
      return null;
    }
    const previous = allExpectedById.get(binding.evidenceSnapshotId);
    if (previous && previous !== binding.evidenceSnapshotHash) return null;
    allExpectedById.set(binding.evidenceSnapshotId, binding.evidenceSnapshotHash);
    // 模型上下文最多容纳五条 sealed quote。Snapshot 的 binding
    // 顺序本身冻结，故取前五个不同 evidence 仍是确定性、可审计的子闭包。
    if (expectedById.size < 5 || expectedById.has(binding.evidenceSnapshotId)) {
      expectedById.set(binding.evidenceSnapshotId, binding.evidenceSnapshotHash);
    }
  }
  if (expectedById.size === 0) return null;

  // IDs 已按 UUID schema 校验；显式 uuid[] 可避免 postgres-js 对数组 bind 的
  // 参数歧义；只取 usable 的 sealed evidence。
  const idsLiteral = `{${[...expectedById.keys()].join(",")}}`;
  const evidenceRows = await tx.execute(sql`
    SELECT DISTINCT es.evidence_snapshot_id,
           es.evidence_snapshot_hash,
           es.quote_hash,
           es.block_content_hash,
           es.start_offset,
           es.end_offset,
           es.created_at,
           nb.content AS block_content
    FROM evidence_snapshots_v2 es
    JOIN evidence_eligibility_states_v2 ees
      ON ees.workspace_id = es.workspace_id
      AND ees.evidence_snapshot_id = es.evidence_snapshot_id
      AND ees.status = 'usable'
    JOIN note_blocks nb ON nb.id = es.block_id AND nb.workspace_id = es.workspace_id
    WHERE es.workspace_id = ${scope.workspaceId}
      AND es.evidence_snapshot_id = ANY(${idsLiteral}::uuid[])
    ORDER BY es.created_at DESC
    LIMIT 5
  `) as GroundedTutorEvidenceRow[];
  if (evidenceRows.length !== expectedById.size) return null;
  const rowsWithExpected = evidenceRows.map((row) => ({
    ...row,
    expected_evidence_snapshot_hash: expectedById.get(row.evidence_snapshot_id),
  }));
  try {
    const evidence = materializeGroundedTutorEvidence(rowsWithExpected);
    return evidence.length > 0 ? { claim: claim.slice(0, 800), evidence } : null;
  } catch {
    return null;
  }
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
        // waiting_proposal_id 一并清空：终态 run 不得残留挂起确认指针。
        const claimed = await tx.execute<{ id: string }>(sql`
          UPDATE companion_turn_runs
          SET status = 'failed', error_code = ${code}, finished_at = now(),
              waiting_proposal_id = NULL
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
