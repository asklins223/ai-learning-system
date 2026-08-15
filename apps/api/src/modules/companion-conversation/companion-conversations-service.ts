/**
 * P2 companion conversation 管理（03 §6.2 inbox ensure / §6.3 list / §6.4 messages /
 * §12 delete）。Export（§12 NDJSON）在 companion-export.ts。
 *
 * - inbox ensure：幂等唯一 inbox（partial unique 并发处理），201/200，无副作用；
 * - list：签名 keyset cursor（HMAC-SHA256，AUTH_SURFACE_MANIFEST_SECRET），
 *   排序 (COALESCE(lastMessageAt,createdAt) DESC, id DESC)；
 * - messages：seq 倒序查询、升序返回，beforeSeq 分页；
 * - delete：hard delete，active turn 原子 superseded + job cancel fence + cascade，204。
 */

import { eq, and, lt, desc, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { companionConversationSnapshotV1Schema } from "@ailearn/shared";
import { sha256Utf8V1 } from "@ailearn/shared/content-hash";
import {
  companionConversations,
  companionMessages,
  companionTurnRuns,
  CompanionConversationError,
} from "./turn-service.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { resolveAuthSurfaceManifestSecret } from "../companion-shell/auth-surface.ts";
import { logCompanionAudit } from "../companion-shell/audit-service.ts";

const CURSOR_CONTEXT = "companion-conversation-cursor-v1:";
const CURSOR_TTL_MS = 24 * 3_600_000;
const MAX_USER_INBOX_TITLE = "伴星消息";
// F9（round-4）：snapshot 复原最多加载的 stream 事件条数（取最近 N 条），
// 约束 24h TTL 窗口内长 run 的快照体体积。
const SNAPSHOT_EVENT_LIMIT = 500;

// ─── 签名 cursor（§6.3） ─────────────────────────────────────────────────

export interface CompanionListCursorPayload {
  version: 1;
  workspaceId: string;
  userId: string;
  kind: "dialogue" | "inbox";
  status: "active" | "archived";
  sortAt: string;
  id: string;
  expiresAt: string;
}

function base64urlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export function signCompanionConversationCursor(
  payload: CompanionListCursorPayload,
  secret: string,
): string {
  const payloadUtf8 = canonicalCursorJson(payload);
  const sig = createHmac("sha256", secret)
    .update(CURSOR_CONTEXT + payloadUtf8)
    .digest();
  return `${base64urlEncode(payloadUtf8)}.${base64urlEncode(sig)}`;
}

/** 校验 + 解码 cursor；验签失败/scope 不匹配/过期 → null（fail closed）。 */
export function verifyCompanionConversationCursor(
  cursor: string,
  args: { workspaceId: string; userId: string; kind: "dialogue" | "inbox"; status: "active" | "archived" },
): CompanionListCursorPayload | null {
  const parts = cursor.split(".");
  if (parts.length !== 2) return null;
  let payloadUtf8: string;
  let sig: Buffer;
  try {
    payloadUtf8 = base64urlDecode(parts[0]).toString("utf8");
    sig = base64urlDecode(parts[1]);
  } catch {
    return null;
  }
  const secret = resolveAuthSurfaceManifestSecret();
  if (!secret) return null; // 缺失密钥 → fail closed
  const expected = createHmac("sha256", secret)
    .update(CURSOR_CONTEXT + payloadUtf8)
    .digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  let parsed: CompanionListCursorPayload;
  try {
    parsed = JSON.parse(payloadUtf8) as CompanionListCursorPayload;
  } catch {
    return null;
  }
  if (
    parsed.version !== 1 ||
    parsed.workspaceId !== args.workspaceId ||
    parsed.userId !== args.userId ||
    parsed.kind !== args.kind ||
    parsed.status !== args.status
  ) {
    return null;
  }
  if (Date.parse(parsed.expiresAt) < Date.now()) return null;
  return parsed;
}

function canonicalCursorJson(payload: CompanionListCursorPayload): string {
  return JSON.stringify({
    version: payload.version,
    workspaceId: payload.workspaceId,
    userId: payload.userId,
    kind: payload.kind,
    status: payload.status,
    sortAt: payload.sortAt,
    id: payload.id,
    expiresAt: payload.expiresAt,
  });
}

// ─── §6.2 inbox ensure ────────────────────────────────────────────────────

export interface EnsureCompanionInboxResult {
  statusCode: number;
  body: Record<string, unknown>;
}

export async function ensureCompanionInbox(args: {
  workspaceId: string;
  userId: string;
}): Promise<EnsureCompanionInboxResult> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const id = randomUUID();
      const inserted = await tx.execute(sql`
        INSERT INTO companion_conversations
          (id, workspace_id, user_id, kind, title, title_source, status,
           next_message_seq, next_event_seq, next_generation, summary_version)
        VALUES
          (${id}, ${args.workspaceId}, ${args.userId}, 'inbox', ${MAX_USER_INBOX_TITLE}, 'system',
           'active', 1, 1, 1, 0)
        ON CONFLICT DO NOTHING
        RETURNING id, workspace_id, user_id, kind, title, title_source, status,
                  created_at, updated_at, last_message_at
      `);
      if (inserted[0]) {
        return {
          statusCode: 201,
          body: companionConversationBody(inserted[0] as unknown as ConversationRow),
        };
      }
      // 并发已存在 → 读回唯一 inbox
      const existing = await tx.execute(sql`
        SELECT id, workspace_id, user_id, kind, title, title_source, status,
               created_at, updated_at, last_message_at
        FROM companion_conversations
        WHERE workspace_id = ${args.workspaceId} AND user_id = ${args.userId}
          AND kind = 'inbox' AND status = 'active'
        LIMIT 1
      `);
      if (!existing[0]) {
        throw new CompanionConversationError("INTERNAL_ERROR", 500, "inbox ensure raced");
      }
      return { statusCode: 200, body: companionConversationBody(existing[0] as unknown as ConversationRow) };
    },
  );
}

type ConversationRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  kind: string;
  title: string;
  title_source: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  last_message_at: Date | null;
};

function companionConversationBody(row: ConversationRow): Record<string, unknown> {
  return {
    version: 1,
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    kind: row.kind,
    title: row.title,
    titleSource: row.title_source,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
  };
}

function parseSnapshotJson(value: unknown, field: string): Record<string, unknown> {
  const parsed = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      })()
    : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CompanionConversationError("INTERNAL_ERROR", 500, `invalid ${field} snapshot`);
  }
  return parsed as Record<string, unknown>;
}

export async function getCompanionConversationSnapshot(args: {
  workspaceId: string;
  userId: string;
  conversationId: string;
}): Promise<{ statusCode: 200; body: unknown }> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      // Conversation, active run, deltas and P5 action rows must describe one
      // durable point in time; no writes are performed by this endpoint.
      const conversations = await tx.execute<ConversationRow & { next_event_seq: string }>(sql`
        SELECT id, workspace_id, user_id, kind, title, title_source, status,
               created_at, updated_at, last_message_at, next_event_seq
        FROM companion_conversations
        WHERE id = ${args.conversationId}
        LIMIT 1
      `);
      const conversation = conversations[0];
      if (!conversation) {
        throw new CompanionConversationError("NOT_FOUND", 404, "conversation not found");
      }

      const activeRuns = await tx.execute<{
        id: string;
        conversation_id: string;
        user_message_id: string;
        assistant_message_id: string | null;
        generation: number;
        status: "accepted" | "running" | "cancel_requested";
        created_at: Date;
        updated_at: Date;
      }>(sql`
        SELECT id, conversation_id, user_message_id, assistant_message_id,
               generation, status, created_at, updated_at
        FROM companion_turn_runs
        WHERE conversation_id = ${args.conversationId}
          AND status IN ('accepted', 'running', 'cancel_requested')
        ORDER BY generation DESC
        LIMIT 1
      `);

      let activeRun: Record<string, unknown> | null = null;
      if (activeRuns[0]) {
        const run = activeRuns[0];
        // F9（round-4）：snapshot 主路径曾无 LIMIT 全量加载该 run 全部 stream 事件
        // （含 jsonb payload）入内存，长 run（24h TTL 窗口内）下快照体无界。改为
        // 取最近 SNAPSHOT_EVENT_LIMIT 条（倒序 LIMIT 再正序），约束恢复主路径内存/
        // 传输体积；lastEventSeq 基于尾部事件计算保持准确，preview 尾部拼接可能被
        // 截断并由既有 previewTruncated 降级路径处理（与 delta TTL gap 一致语义）。
        const events = await tx.execute<{ seq: string; type: string; payload: unknown }>(sql`
          SELECT seq, type, payload
          FROM companion_stream_events
          WHERE conversation_id = ${args.conversationId}
            AND run_id = ${run.id}
          ORDER BY seq DESC
          LIMIT ${SNAPSHOT_EVENT_LIMIT}
        `);
        // 倒序翻转回 seq 升序，保持既有顺序语义。
        events.reverse();
        let previewText = "";
        let sawDelta = false;
        // delta 事件是 24h TTL 的短生命周期数据（§5.3），而 snapshot 是恢复
        // 主路径；若中间 delta 已被 TTL 清理/损坏（run 长时间未终态），不能
        // 让恢复路径依赖可变 TTL 数据抛 500——降级为"已重建部分"，
        // previewTextSha256 对截断结果计算保持一致，完整文本由 durable message
        // 与后续 SSE delta 续读补全。
        // F9（round-4）：用数组累积 textDelta 再 join 取代 `previewText += textDelta`
        // （长 run 下 O(n²) 重复字符串拼接），仅用 running 字符计数做 appendFrom 校验。
        const deltaChunks: string[] = [];
        let previewLength = 0;
        let previewTruncated = false;
        for (const event of events) {
          if (event.type !== "assistant.delta") continue;
          const payload = parseSnapshotJson(event.payload, "assistant.delta");
          const appendFrom = payload.appendFrom;
          const textDelta = payload.textDelta;
          if (
            typeof appendFrom !== "number" ||
            !Number.isInteger(appendFrom) ||
            appendFrom !== previewLength ||
            typeof textDelta !== "string" ||
            textDelta.length < 1
          ) {
            previewTruncated = true;
            break;
          }
          deltaChunks.push(textDelta);
          previewLength += textDelta.length;
          sawDelta = true;
        }
        if (deltaChunks.length > 0) previewText = deltaChunks.join("");
        if (previewTruncated) {
          // eslint-disable-next-line no-console
          console.warn(`companion snapshot: active run ${run.id} preview truncated (delta TTL gap)`);
        }
        const lastEventSeq = events.reduce((max, event) => Math.max(max, Number(event.seq)), 0);
        if (lastEventSeq <= 0) {
          throw new CompanionConversationError("INTERNAL_ERROR", 500, "active run has no durable event");
        }
        const phase = run.status === "accepted"
          ? "accepted"
          : sawDelta ? "streaming" : "thinking";
        activeRun = {
          version: 1,
          id: run.id,
          conversationId: run.conversation_id,
          userMessageId: run.user_message_id,
          assistantMessageId: run.assistant_message_id,
          generation: run.generation,
          status: run.status,
          phase,
          previewText,
          previewTextSha256: sha256Utf8V1(previewText),
          lastEventSeq,
          createdAt: new Date(run.created_at).toISOString(),
          updatedAt: new Date(run.updated_at).toISOString(),
        };
      }

      const learningActionsEnabled =
        process.env.COMPANION_DIALOGUE_V1_ENABLED === "true" &&
        process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED === "true";
      let pendingProposal: Record<string, unknown> | null = null;
      let activeActionRun: Record<string, unknown> | null = null;
      if (learningActionsEnabled) {
        const proposals = await tx.execute<{
          id: string;
          conversation_id: string;
          source_message_id: string;
          source_generation: number;
          context_grant_id: string | null;
          payload: unknown;
          payload_sha256: string;
          title: string;
          target_summary: string;
          impact_summary: string;
          status: "pending";
          decision: null;
          expires_at: Date;
          decided_at: Date | null;
          created_at: Date;
          updated_at: Date;
        }>(sql`
          SELECT id, conversation_id, source_message_id, source_generation,
                 context_grant_id, payload, payload_sha256, title, target_summary,
                 impact_summary, status, decision, expires_at, decided_at,
                 created_at, updated_at
          FROM companion_action_proposals
          WHERE conversation_id = ${args.conversationId}
            AND status = 'pending'
            AND expires_at > now()
          ORDER BY created_at DESC
          LIMIT 1
        `);
        const proposal = proposals[0];
        if (proposal) {
          pendingProposal = {
            version: 1,
            proposalId: proposal.id,
            conversationId: proposal.conversation_id,
            sourceMessageId: proposal.source_message_id,
            sourceGeneration: proposal.source_generation,
            contextGrantId: proposal.context_grant_id,
            payload: parseSnapshotJson(proposal.payload, "action proposal"),
            payloadSha256: proposal.payload_sha256,
            title: proposal.title,
            targetSummary: proposal.target_summary,
            impactSummary: proposal.impact_summary,
            requiresConfirmation: true,
            status: proposal.status,
            decision: proposal.decision,
            actionRunId: null,
            expiresAt: new Date(proposal.expires_at).toISOString(),
            decidedAt: null,
            createdAt: new Date(proposal.created_at).toISOString(),
            updatedAt: new Date(proposal.updated_at).toISOString(),
          };
        }

        const actionRuns = await tx.execute<{
          id: string;
          proposal_id: string;
          status: "accepted" | "running";
          result_message_id: string | null;
          result_ref: string | null;
          route: unknown;
          safe_summary: string | null;
          error_code: string | null;
          created_at: Date;
          updated_at: Date;
        }>(sql`
          SELECT id, proposal_id, status, result_message_id, result_ref, route,
                 safe_summary, error_code, created_at, updated_at
          FROM companion_action_runs
          WHERE conversation_id = ${args.conversationId}
            AND status IN ('accepted', 'running')
          ORDER BY created_at DESC
          LIMIT 1
        `);
        const actionRun = actionRuns[0];
        if (actionRun) {
          activeActionRun = {
            version: 1,
            actionRunId: actionRun.id,
            proposalId: actionRun.proposal_id,
            status: actionRun.status,
            resultMessageId: actionRun.result_message_id,
            resultRef: actionRun.result_ref,
            route: actionRun.route == null ? null : parseSnapshotJson(actionRun.route, "action route"),
            safeSummary: actionRun.safe_summary,
            errorCode: actionRun.error_code,
            createdAt: new Date(actionRun.created_at).toISOString(),
            updatedAt: new Date(actionRun.updated_at).toISOString(),
          };
        }
      }

      const body = companionConversationSnapshotV1Schema.parse({
        version: 1,
        conversation: companionConversationBody(conversation),
        activeRun,
        latestEventSeq: Number(conversation.next_event_seq) - 1,
        pendingProposal,
        activeActionRun,
      });
      return { statusCode: 200 as const, body };
    },
    { isolationLevel: "repeatable read" },
  );
}

// ─── §6.3 list ────────────────────────────────────────────────────────────

export interface ListCompanionConversationsResult {
  statusCode: number;
  body: {
    version: 1;
    items: Record<string, unknown>[];
    nextCursor: string | null;
  };
}

export async function listCompanionConversations(args: {
  workspaceId: string;
  userId: string;
  limit: number;
  cursor: string | null;
  kind: "dialogue" | "inbox";
  status: "active" | "archived";
}): Promise<ListCompanionConversationsResult> {
  const limit = Math.max(1, Math.min(50, args.limit));
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      let cursorPayload: CompanionListCursorPayload | null = null;
      if (args.cursor) {
        cursorPayload = verifyCompanionConversationCursor(args.cursor, {
          workspaceId: args.workspaceId,
          userId: args.userId,
          kind: args.kind,
          status: args.status,
        });
        if (!cursorPayload) {
          throw new CompanionConversationError("INVALID_CURSOR", 400, "invalid or expired cursor");
        }
      }

      const where = and(
        eq(companionConversations.workspaceId, args.workspaceId),
        eq(companionConversations.userId, args.userId),
        eq(companionConversations.kind, args.kind),
        eq(companionConversations.status, args.status),
        cursorPayload
          ? sql`(
              COALESCE(${companionConversations.lastMessageAt}, ${companionConversations.createdAt}) < ${cursorPayload.sortAt}::timestamptz
              OR (
                COALESCE(${companionConversations.lastMessageAt}, ${companionConversations.createdAt}) = ${cursorPayload.sortAt}::timestamptz
                AND ${companionConversations.id} < ${cursorPayload.id}
              )
            )`
          : undefined,
      );

      const rows = await tx
        .select({
          id: companionConversations.id,
          workspace_id: companionConversations.workspaceId,
          user_id: companionConversations.userId,
          kind: companionConversations.kind,
          title: companionConversations.title,
          title_source: companionConversations.titleSource,
          status: companionConversations.status,
          created_at: companionConversations.createdAt,
          updated_at: companionConversations.updatedAt,
          last_message_at: companionConversations.lastMessageAt,
          // 2026-08-11：cursor 用 DB 微秒精度排序键——JS Date 只有毫秒，
          // 同一毫秒内多条（微秒不同）时旧 cursor 截断导致下一页漏行。
          sort_key: sql<string>`to_char(COALESCE(${companionConversations.lastMessageAt}, ${companionConversations.createdAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(companionConversations)
        .where(where)
        .orderBy(
          desc(sql`COALESCE(${companionConversations.lastMessageAt}, ${companionConversations.createdAt})`),
          desc(companionConversations.id),
        )
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => companionConversationBody(row as unknown as ConversationRow));
      let nextCursor: string | null = null;
      if (hasMore && items.length > 0) {
        const lastRow = rows[limit - 1] as unknown as { id: string; sort_key: string };
        const secret = resolveAuthSurfaceManifestSecret();
        if (!secret) throw new CompanionConversationError("INTERNAL_ERROR", 500, "cursor signing secret missing");
        nextCursor = signCompanionConversationCursor(
          {
            version: 1,
            workspaceId: args.workspaceId,
            userId: args.userId,
            kind: args.kind,
            status: args.status,
            sortAt: lastRow.sort_key,
            id: lastRow.id,
            expiresAt: new Date(Date.now() + CURSOR_TTL_MS).toISOString(),
          },
          secret,
        );
      }
      return { statusCode: 200, body: { version: 1, items, nextCursor } };
    },
  );
}

// ─── §6.4 messages ────────────────────────────────────────────────────────

export interface ListCompanionMessagesResult {
  statusCode: number;
  body: {
    version: 1;
    items: Record<string, unknown>[];
    hasMore: boolean;
    oldestSeq: number | null;
  };
}

export async function listCompanionMessages(args: {
  workspaceId: string;
  userId: string;
  conversationId: string;
  limit: number;
  beforeSeq: number | null;
}): Promise<ListCompanionMessagesResult> {
  const limit = Math.max(1, Math.min(100, args.limit));
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      // RLS 已 scope；不存在/非本人 → 零行 → 404
      const conv = await tx
        .select({ id: companionConversations.id })
        .from(companionConversations)
        .where(eq(companionConversations.id, args.conversationId))
        .limit(1);
      if (!conv[0]) {
        throw new CompanionConversationError("NOT_FOUND", 404, "conversation not found");
      }
      const rows = await tx
        .select({
          id: companionMessages.id,
          workspaceId: companionMessages.workspaceId,
          conversation_id: companionMessages.conversationId,
          seq: companionMessages.seq,
          role: companionMessages.role,
          kind: companionMessages.kind,
          blocks: companionMessages.blocks,
          run_id: companionMessages.runId,
          client_message_id: companionMessages.clientMessageId,
          content_sha256: companionMessages.contentSha256,
          created_at: companionMessages.createdAt,
          edited_at: companionMessages.editedAt,
        })
        .from(companionMessages)
        .where(and(
          eq(companionMessages.conversationId, args.conversationId),
          args.beforeSeq != null ? lt(companionMessages.seq, args.beforeSeq) : undefined,
        ))
        .orderBy(desc(companionMessages.seq))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const paged = rows.slice(0, limit);
      const items = paged
        .slice()
        .reverse() // 升序返回
        .map((row) => ({
          version: 1,
          id: row.id,
          workspaceId: row.workspaceId,
          conversationId: row.conversation_id,
          seq: Number(row.seq),
          role: row.role,
          kind: row.kind,
          blocks: row.blocks,
          runId: row.run_id,
          clientMessageId: row.client_message_id,
          contentSha256: row.content_sha256,
          createdAt: row.created_at.toISOString(),
          editedAt: row.edited_at ? row.edited_at.toISOString() : null,
        }));
      return {
        statusCode: 200,
        body: {
          version: 1,
          items,
          hasMore,
          oldestSeq: paged.length > 0 ? Number(paged[paged.length - 1].seq) : null,
        },
      };
    },
  );
}

// ─── §12 delete（hard delete + active turn supersede fence） ─────────────

export async function deleteCompanionConversation(args: {
  workspaceId: string;
  userId: string;
  conversationId: string;
}): Promise<{ statusCode: number; body: unknown }> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      const conv = await tx
        .select({ id: companionConversations.id })
        .from(companionConversations)
        .where(eq(companionConversations.id, args.conversationId))
        .for("update")
        .limit(1);
      if (!conv[0]) {
        throw new CompanionConversationError("NOT_FOUND", 404, "conversation not found");
      }

      // 仅 active turn（accepted/running/cancel_requested）：原子 superseded + job cancel fence。
      // 轻微·17（round-4）：不变量保证每会话恰 0/1 条 active turn，仍加 LIMIT 2
      // 防数据异常下深加放大（安全阻尼，不改变语义）。
      const activeRuns = await tx
        .select({ id: companionTurnRuns.id, jobId: companionTurnRuns.jobId })
        .from(companionTurnRuns)
        .where(and(
          eq(companionTurnRuns.conversationId, args.conversationId),
          sql`${companionTurnRuns.status} IN ('accepted', 'running', 'cancel_requested')`,
        ))
        .limit(2);
      if (activeRuns.length > 0) {
        for (const run of activeRuns) {
          await tx
            .update(companionTurnRuns)
            .set({ status: "superseded", finishedAt: sql`now()` })
            .where(eq(companionTurnRuns.id, run.id));
          if (run.jobId) {
            await tx.execute(sql`
              UPDATE jobs SET status = 'dead'
              WHERE id = ${run.jobId} AND status IN ('pending', 'running')
            `);
          }
        }
      }

      // §12：active action run（accepted/running）存在时不得删除——学习动作
      // 正在执行，级联删除会让 action 回执与 durable result 一起消失。
      const activeActionRuns = await tx.execute<{ id: string }>(sql`
        SELECT id FROM companion_action_runs
        WHERE conversation_id = ${args.conversationId}
          AND status IN ('accepted', 'running')
        LIMIT 1
      `);
      if (activeActionRuns.length > 0) {
        throw new CompanionConversationError(
          "RUN_ALREADY_ACTIVE",
          409,
          "active learning action run",
        );
      }

      // cascade scoped rows。删除顺序必须同时处理双向 FK：
      //   1. companion_messages.action_ref（0093）反向引用 proposals——
      //      无级联，删 proposals 前必须先置 NULL；
      //   2. action_runs / proposals 的 source_message_id / result_message_id
      //      引用 companion_messages 且无 ON DELETE CASCADE（0092），
      //      必须在删 messages 前删除。
      await tx.execute(sql`
        UPDATE companion_messages SET action_ref = NULL
        WHERE conversation_id = ${args.conversationId} AND action_ref IS NOT NULL
      `);
      await tx.execute(sql`
        DELETE FROM companion_action_runs WHERE conversation_id = ${args.conversationId}
      `);
      await tx.execute(sql`
        DELETE FROM companion_action_proposals WHERE conversation_id = ${args.conversationId}
      `);
      await tx.execute(sql`
        DELETE FROM companion_stream_events WHERE conversation_id = ${args.conversationId}
      `);
      await tx.execute(sql`
        DELETE FROM companion_turn_runs WHERE conversation_id = ${args.conversationId}
      `);
      // 2026-08-11：proactive_deliveries.message_id 引用 companion_messages(id)
      // 且无 ON DELETE CASCADE（0088:165）——必须先删 deliveries 再删 messages，
      // 否则含 proactive delivery 的对话删除抛 FK 违反 → 500。
      await tx.execute(sql`
        DELETE FROM companion_proactive_deliveries WHERE conversation_id = ${args.conversationId}
      `);
      // 2026-08-11：companion_voice_artifacts 无 FK（0088 §7.5），
      // status='attached' 的行 message_id/conversation_id 指向已删行，
      // 且部分唯一索引上的行永不过期（TTL 只清 pending）——随对话一并删除，
      // 否则残留行与幽灵 message_id 永久驻留。
      await tx.execute(sql`
        DELETE FROM companion_voice_artifacts WHERE conversation_id = ${args.conversationId}
      `);
      await tx.execute(sql`
        DELETE FROM companion_messages WHERE conversation_id = ${args.conversationId}
      `);
      await tx
        .delete(companionConversations)
        .where(eq(companionConversations.id, args.conversationId));

      // §12：删除写 content-free audit（嵌套复用同一事务，随删除原子提交）。
      await logCompanionAudit({
        userId: args.userId,
        workspaceId: args.workspaceId,
        pageActionType: "audit_delete",
        pageOpaqueId: args.conversationId,
        result: "conversation_deleted",
      });

      return { statusCode: 204, body: undefined };
    },
  );
}
