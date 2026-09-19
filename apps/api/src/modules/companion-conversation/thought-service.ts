/**
 * 念头主动开场（念头管线切片④，2026-09-18）。
 *
 * 用户点击念头气泡 → POST /companion/thoughts/:id/open → 把这条念头的表达
 * 作为她主动发起的开场消息（kind='proactive'，枚举值首次有生产者）落进
 * dialogue 会话，念头状态 candidate 之外的 delivered → spent。用户随后在
 * 聊天抽屉里自然回复（普通 turn），"气泡可点击变成她主动发起的一轮对话"。
 */

import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { CompanionConversationError } from "./turn-service.ts";

export interface CompanionThoughtOpenResult {
  version: 1;
  conversationId: string;
  messageId: string;
  text: string;
}

export async function openCompanionThought(args: {
  workspaceId: string;
  userId: string;
  thoughtId: string;
}): Promise<{ statusCode: number; body: CompanionThoughtOpenResult | { version: 1; error: string; message: string } }> {
  return withWorkspaceTransaction(
    { workspaceId: args.workspaceId, userId: args.userId },
    async (tx) => {
      // 念头必须存在、属于本会话用户，且处于 delivered（还没点开过、没过期）。
      const thoughtRows = await tx.execute<{ id: string; text: string; status: string }>(sql`
        SELECT id, text, status FROM assistant_thoughts
        WHERE id = ${args.thoughtId}
          AND workspace_id = ${args.workspaceId}
          AND user_id = ${args.userId}
        FOR UPDATE
      `);
      const thought = (Array.isArray(thoughtRows) ? thoughtRows : [])[0];
      if (!thought) {
        return { statusCode: 404, body: { version: 1, error: "NOT_FOUND", message: "thought not found" } };
      }
      if (thought.status !== "delivered") {
        return { statusCode: 409, body: { version: 1, error: "THOUGHT_NOT_OPENABLE", message: "thought is not openable" } };
      }

      // 复用最近一条 active dialogue；没有才新建（上限与 §6.1 同步：200）。
      const dialogueRows = await tx.execute<{ id: string }>(sql`
        SELECT id FROM companion_conversations
        WHERE workspace_id = ${args.workspaceId} AND user_id = ${args.userId}
          AND kind = 'dialogue' AND status = 'active'
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT 1
      `);
      let conversationId = (Array.isArray(dialogueRows) ? dialogueRows : [])[0]?.id;
      if (!conversationId) {
        const countRows = await tx.execute<{ n: string }>(sql`
          SELECT count(*)::int AS n FROM companion_conversations
          WHERE workspace_id = ${args.workspaceId} AND user_id = ${args.userId}
            AND kind = 'dialogue' AND status = 'active'
        `);
        if (Number(countRows[0]?.n ?? 0) >= 200) {
          throw new CompanionConversationError("CONVERSATION_LIMIT_REACHED", 409, "max 200 dialogue conversations");
        }
        const created = await tx.execute<{ id: string }>(sql`
          INSERT INTO companion_conversations
            (id, workspace_id, user_id, kind, title, title_source, status)
          VALUES (${randomUUID()}, ${args.workspaceId}, ${args.userId}, 'dialogue',
                  '她主动开口', 'auto', 'active')
          RETURNING id
        `);
        conversationId = created[0]?.id;
        if (!conversationId) {
          throw new CompanionConversationError("INTERNAL_ERROR", 500, "conversation create failed");
        }
      }

      // assistant 开场消息：kind='proactive'（0088 枚举的首个生产者）。
      const seqRows = await tx.execute<{ next_message_seq: string }>(sql`
        UPDATE companion_conversations
        SET next_message_seq = next_message_seq + 1, last_message_at = now()
        WHERE id = ${conversationId}
        RETURNING next_message_seq
      `);
      const messageSeq = Number(seqRows[0]?.next_message_seq ?? 1) - 1;
      const messageId = randomUUID();
      const blocks = JSON.stringify([{ type: "text", text: thought.text }]);
      await tx.execute(sql`
        INSERT INTO companion_messages
          (id, conversation_id, workspace_id, user_id, role, seq, kind, blocks,
           client_message_id, content_sha256)
        VALUES
          (${messageId}, ${conversationId}, ${args.workspaceId}, ${args.userId},
           'assistant', ${messageSeq}, 'proactive', ${blocks}::jsonb, NULL, ${sha256Utf8V1(thought.text)})
      `);

      // 念头消费掉：同一念头不会二次开场。
      await tx.execute(sql`
        UPDATE assistant_thoughts SET status = 'spent', opened_at = now(), updated_at = now()
        WHERE id = ${args.thoughtId}
      `);

      return {
        statusCode: 200,
        body: {
          version: 1,
          conversationId,
          messageId,
          text: thought.text,
        },
      };
    },
  );
}
