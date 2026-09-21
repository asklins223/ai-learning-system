import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { resolveAuthSurfaceManifestSecret } from "../companion-shell/auth-surface.ts";

const CURSOR_CONTEXT = "companion-continuous-history-v1:";
const CURSOR_TTL_MS = 24 * 3_600_000;

type HistoryCursor = {
  version: 1;
  workspaceId: string;
  userId: string;
  createdAt: string;
  id: string;
  expiresAt: string;
};

function canonicalCursor(payload: HistoryCursor): string {
  return JSON.stringify({
    version: payload.version,
    workspaceId: payload.workspaceId,
    userId: payload.userId,
    createdAt: payload.createdAt,
    id: payload.id,
    expiresAt: payload.expiresAt,
  });
}

function signCursor(payload: HistoryCursor): string {
  const secret = resolveAuthSurfaceManifestSecret();
  if (!secret) throw new Error("continuous history cursor signing secret missing");
  const body = canonicalCursor(payload);
  const signature = createHmac("sha256", secret).update(CURSOR_CONTEXT + body).digest("base64url");
  return `${Buffer.from(body).toString("base64url")}.${signature}`;
}

function verifyCursor(
  encoded: string,
  scope: { workspaceId: string; userId: string },
): HistoryCursor | null {
  const [bodyPart, signaturePart, extra] = encoded.split(".");
  if (!bodyPart || !signaturePart || extra) return null;
  const secret = resolveAuthSurfaceManifestSecret();
  if (!secret) return null;
  let body: string;
  let supplied: Buffer;
  try {
    body = Buffer.from(bodyPart, "base64url").toString("utf8");
    supplied = Buffer.from(signaturePart, "base64url");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret).update(CURSOR_CONTEXT + body).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const parsed = JSON.parse(body) as HistoryCursor;
    if (
      parsed.version !== 1
      || parsed.workspaceId !== scope.workspaceId
      || parsed.userId !== scope.userId
      || typeof parsed.createdAt !== "string"
      || typeof parsed.id !== "string"
      || Date.parse(parsed.expiresAt) <= Date.now()
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

type HistoryRow = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "voice_transcript" | "proactive" | "action" | "result" | "error" | "cancelled";
  blocks: unknown[];
  run_id: string | null;
  // postgres-js 对 raw execute 不把 timestamptz 解析成 Date（返回
  // "2026-08-20 01:33:39.135727+00" 这类字符串），时间一律在 SQL 层
  // to_char 成 ISO 后再交给 item()。
  created_at_iso: string;
  edited_at_iso: string | null;
  cursor_created_at: string;
};

function item(row: HistoryRow) {
  return {
    version: 1 as const,
    messageId: row.id,
    role: row.role,
    kind: row.kind,
    blocks: row.blocks,
    runId: row.run_id,
    createdAt: row.created_at_iso,
    editedAt: row.edited_at_iso,
  };
}

export async function listContinuousHistory(args: {
  workspaceId: string;
  userId: string;
  before?: string;
  limit: number;
}) {
  const cursor = args.before ? verifyCursor(args.before, args) : null;
  if (args.before && !cursor) return { invalidCursor: true as const };
  const page = await withWorkspaceTransaction(args, async (tx) => {
    const rows = await tx.execute<HistoryRow>(sql`
      SELECT m.id, m.role, m.kind, m.blocks, m.run_id,
             to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
             to_char(m.edited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS edited_at_iso,
             to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
      FROM companion_messages m
      JOIN companion_conversations c ON c.id = m.conversation_id
      WHERE m.workspace_id = ${args.workspaceId}
        AND m.user_id = ${args.userId}
        AND c.kind IN ('dialogue', 'inbox')
        ${cursor ? sql`AND (m.created_at, m.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : sql``}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${args.limit + 1}
    `);
    return Array.isArray(rows) ? rows : [];
  });
  const hasMore = page.length > args.limit;
  const selected = page.slice(0, args.limit);
  const last = selected[selected.length - 1];
  return {
    invalidCursor: false as const,
    value: {
      version: 1 as const,
      // API 分页按倒序取，交给界面前恢复为自然时间顺序。
      items: selected.map(item).reverse(),
      nextCursor: hasMore && last
        ? signCursor({
            version: 1,
            workspaceId: args.workspaceId,
            userId: args.userId,
            createdAt: last.cursor_created_at,
            id: last.id,
            expiresAt: new Date(Date.now() + CURSOR_TTL_MS).toISOString(),
          })
        : null,
    },
  };
}

export async function searchContinuousHistory(args: {
  workspaceId: string;
  userId: string;
  query: string;
  limit: number;
}) {
  const keyword = `%${args.query}%`;
  return withWorkspaceTransaction(args, async (tx) => {
    const rows = await tx.execute<HistoryRow>(sql`
      SELECT m.id, m.role, m.kind, m.blocks, m.run_id,
             to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
             to_char(m.edited_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS edited_at_iso,
             to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
      FROM companion_messages m
      JOIN companion_conversations c ON c.id = m.conversation_id
      WHERE m.workspace_id = ${args.workspaceId}
        AND m.user_id = ${args.userId}
        AND c.kind IN ('dialogue', 'inbox')
        AND m.blocks::text ILIKE ${keyword}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${args.limit}
    `);
    return {
      version: 1 as const,
      query: args.query,
      items: (Array.isArray(rows) ? rows : []).map(item),
    };
  });
}

async function clearConversationRows(tx: ApiTransaction, scope: { workspaceId: string; userId: string }) {
  const conversations = await tx.execute<{ id: string }>(sql`
    SELECT id FROM companion_conversations
    WHERE workspace_id = ${scope.workspaceId}
      AND user_id = ${scope.userId}
      AND kind IN ('dialogue', 'inbox')
    FOR UPDATE
  `);
  const ids = (Array.isArray(conversations) ? conversations : []).map((row) => row.id);
  if (ids.length === 0) return { deletedMessages: 0, deletedConversations: 0 };
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const active = await tx.execute(sql`
    SELECT 1 FROM companion_turn_runs
    WHERE conversation_id IN (${idList})
      AND status IN ('accepted', 'running', 'waiting_for_confirmation', 'cancel_requested')
    LIMIT 1
  `);
  if (active.length > 0) return null;
  const messageCount = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM companion_messages WHERE conversation_id IN (${idList})
  `);
  await tx.execute(sql`UPDATE companion_messages SET action_ref = NULL WHERE conversation_id IN (${idList}) AND action_ref IS NOT NULL`);
  await tx.execute(sql`DELETE FROM companion_action_proposals WHERE conversation_id IN (${idList})`);
  await tx.execute(sql`DELETE FROM companion_stream_events WHERE conversation_id IN (${idList})`);
  await tx.execute(sql`DELETE FROM companion_turn_runs WHERE conversation_id IN (${idList})`);
  // 连续历史清理不能顺手抹掉“动态”：旧主动投递表的两个会话引用均可空，
  // 先解除正文引用，让投递状态/审计语义继续保留。
  await tx.execute(sql`
    UPDATE companion_proactive_deliveries
    SET conversation_id = NULL, message_id = NULL
    WHERE conversation_id IN (${idList})
  `);
  await tx.execute(sql`DELETE FROM companion_voice_artifacts WHERE conversation_id IN (${idList})`);
  await tx.execute(sql`DELETE FROM conversation_summaries WHERE conversation_id IN (${idList})`);
  await tx.execute(sql`DELETE FROM companion_messages WHERE conversation_id IN (${idList})`);
  await tx.execute(sql`DELETE FROM companion_conversations WHERE id IN (${idList})`);
  return {
    deletedMessages: Number(messageCount[0]?.count ?? 0),
    deletedConversations: ids.length,
  };
}

export async function clearContinuousHistory(scope: { workspaceId: string; userId: string }) {
  return withWorkspaceTransaction(scope, async (tx) => {
    const deleted = await clearConversationRows(tx, scope);
    if (!deleted) return { activeReply: true as const };
    await tx.execute(sql`
      INSERT INTO companion_conversations
        (id, workspace_id, user_id, kind, title, title_source, status,
         next_message_seq, next_event_seq, next_generation, summary_version)
      VALUES
        (${randomUUID()}, ${scope.workspaceId}, ${scope.userId}, 'inbox', '伴星消息', 'system',
         'active', 1, 1, 1, 0)
    `);
    return {
      activeReply: false as const,
      value: { version: 1 as const, ...deleted, inboxCreated: true as const },
    };
  });
}
