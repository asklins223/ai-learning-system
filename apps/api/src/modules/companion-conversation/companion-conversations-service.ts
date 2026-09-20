/**
 * Internal continuous-dialogue storage helpers.
 *
 * Product surfaces expose one continuous history. The inbox id remains an
 * implementation detail for turn/event transport, so this module only keeps
 * the two operations still used by that transport: ensure the unique inbox
 * and page messages inside the current internal segment.
 */

import { and, desc, eq, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { withWorkspaceTransaction } from "../../db/client.ts";
import {
  companionConversations,
  companionMessages,
  CompanionConversationError,
} from "./turn-service.ts";

const MAX_USER_INBOX_TITLE = "伴星消息";

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
      return {
        statusCode: 200,
        body: companionConversationBody(existing[0] as unknown as ConversationRow),
      };
    },
  );
}

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
      const conversation = await tx
        .select({ id: companionConversations.id })
        .from(companionConversations)
        .where(eq(companionConversations.id, args.conversationId))
        .limit(1);
      if (!conversation[0]) {
        throw new CompanionConversationError("NOT_FOUND", 404, "conversation not found");
      }
      const rows = await tx
        .select({
          id: companionMessages.id,
          workspaceId: companionMessages.workspaceId,
          conversationId: companionMessages.conversationId,
          seq: companionMessages.seq,
          role: companionMessages.role,
          kind: companionMessages.kind,
          blocks: companionMessages.blocks,
          runId: companionMessages.runId,
          clientMessageId: companionMessages.clientMessageId,
          contentSha256: companionMessages.contentSha256,
          createdAt: companionMessages.createdAt,
          editedAt: companionMessages.editedAt,
        })
        .from(companionMessages)
        .where(and(
          eq(companionMessages.conversationId, args.conversationId),
          args.beforeSeq == null ? undefined : lt(companionMessages.seq, args.beforeSeq),
        ))
        .orderBy(desc(companionMessages.seq))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const paged = rows.slice(0, limit);
      return {
        statusCode: 200,
        body: {
          version: 1,
          items: paged.slice().reverse().map((row) => ({
            version: 1,
            id: row.id,
            workspaceId: row.workspaceId,
            conversationId: row.conversationId,
            seq: Number(row.seq),
            role: row.role,
            kind: row.kind,
            blocks: row.blocks,
            runId: row.runId,
            clientMessageId: row.clientMessageId,
            contentSha256: row.contentSha256,
            createdAt: row.createdAt.toISOString(),
            editedAt: row.editedAt?.toISOString() ?? null,
          })),
          hasMore,
          oldestSeq: paged.length > 0 ? Number(paged[paged.length - 1].seq) : null,
        },
      };
    },
  );
}
