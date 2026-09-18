/**
 * AssistantSession 解析（文档 16 P1/system_pet_v2 + §22.2）。
 *
 * GET /companion/session/current — 服务端会话真相解析（替代前端 localStorage
 * dialogue 真相）。解析顺序：kind='journey' active 最新优先（onboarding 会话
 * 是旅程期唯一前台）；否则 kind='inbox' active（每 workspace 唯一，历史页
 * 读模型）；否则 null（前端再走创建路径）。
 *
 * GET /companion/history/search — 完整历史全文搜索（§10.4）。只搜索当前
 * user/workspace 的 companion_messages 正文（blocks 的 text 字段）；
 * 已删除对话物理清除，不会命中；结果按 createdAt 倒序，limit 默认 20。
 *
 * 只读（不创建、不修改任何会话），但仍属 dialogue 能力面：两条路由都要求
 * COMPANION_DIALOGUE_V1_ENABLED，关闭时 404 fail closed，与同模块
 * conversations 列表/详情一致。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { companionConversations, companionMessages } from "@ailearn/shared/db-schema/companion-conversations";
import { and, desc, eq, sql } from "drizzle-orm";
// 这两条路由读取的是伴星会话正文（session/current 解析 journey/inbox 会话，
// history/search 全文检索 companion_messages），与 conversations 列表/详情同属
// dialogue 能力面。此前只挂 requireSession，导致 COMPANION_DIALOGUE_V1_ENABLED
// 关闭时仍可读到会话内容——与同模块其余路由的能力边界不一致。
import { requireCompanionDialogue } from "./routes.ts";

const historySearchQuerySchema = z.object({
  q: z.string().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export interface AssistantSessionResolutionV1 {
  version: 1;
  assistantSession: {
    kind: "journey" | "inbox";
    sessionId: string;
    conversationId: string;
    title: string;
    status: string;
    createdAt: string;
    lastMessageAt: string | null;
  } | null;
  serverTime: string;
}

export async function assistantSessionRoutes(app: FastifyInstance) {
  app.get(
    "/companion/session/current",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req) => {
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const session = await withWorkspaceTransaction(scope, async (tx) => {
        // journey active 最新优先（旅程期唯一前台）。
        const journeyRows = await tx
          .select()
          .from(companionConversations)
          .where(and(
            eq(companionConversations.workspaceId, scope.workspaceId),
            eq(companionConversations.userId, scope.userId),
            eq(companionConversations.kind, "journey"),
            eq(companionConversations.status, "active"),
          ))
          .orderBy(desc(companionConversations.lastMessageAt), desc(companionConversations.createdAt))
          .limit(1);
        if (journeyRows[0]) return { kind: "journey" as const, row: journeyRows[0] };
        const inboxRows = await tx
          .select()
          .from(companionConversations)
          .where(and(
            eq(companionConversations.workspaceId, scope.workspaceId),
            eq(companionConversations.userId, scope.userId),
            eq(companionConversations.kind, "inbox"),
            eq(companionConversations.status, "active"),
          ))
          .limit(1);
        return inboxRows[0] ? { kind: "inbox" as const, row: inboxRows[0] } : null;
      });

      const body: AssistantSessionResolutionV1 = {
        version: 1,
        assistantSession: session
          ? {
              kind: session.kind,
              sessionId: session.row.id,
              conversationId: session.row.id,
              title: session.row.title,
              status: session.row.status,
              createdAt: session.row.createdAt.toISOString(),
              lastMessageAt: session.row.lastMessageAt?.toISOString() ?? null,
            }
          : null,
        serverTime: new Date().toISOString(),
      };
      return body;
    },
  );

  // GET /companion/history/search — §10.4 全文搜索（redacted/已删内容不命中）。
  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/companion/history/search",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      const query = historySearchQuerySchema.safeParse(req.query ?? {});
      if (!query.success) {
        return reply.code(400).send({ error: "bad_request", message: "history search query 非法" });
      }
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const keyword = `%${query.data.q}%`;
      // PERF: blocks::text ILIKE '%q%' 前置通配符无法命中 B-tree——迁移 0169 已
      // 为 companion_messages.blocks 建 pg_trgm GIN 索引（含 text 表达式），
      // 使 ILIKE '%...%' 走索引候选扫描而非整用户历史全表扫描；LIMIT 仍约束
      // 单次返回体积上限 50。
      // PERF（round-5）：标题查询在同一个事务/RLS 快照内完成，不再另开第二个
      // withWorkspaceTransaction（原实现会把事务数翻倍，且可能读到不一致标题）。
      const { rows, titles } = await withWorkspaceTransaction(scope, async (tx) => {
        const messageRows = await tx
          .select({
            messageId: companionMessages.id,
            conversationId: companionMessages.conversationId,
            role: companionMessages.role,
            kind: companionMessages.kind,
            blocks: companionMessages.blocks,
            runId: companionMessages.runId,
            createdAt: companionMessages.createdAt,
          })
          .from(companionMessages)
          .where(and(
            eq(companionMessages.workspaceId, scope.workspaceId),
            eq(companionMessages.userId, scope.userId),
            sql`${companionMessages.blocks}::text ILIKE ${keyword}`,
          ))
          .orderBy(desc(companionMessages.createdAt))
          .limit(query.data.limit);
        // 会话标题（供结果展示；无会话引用时保持 null——消息 FK 保证存在）。
        const conversationIds = Array.from(new Set(messageRows.map((row) => row.conversationId)));
        const convs = conversationIds.length > 0
          ? await tx
              .select({ id: companionConversations.id, title: companionConversations.title })
              .from(companionConversations)
              .where(and(
                eq(companionConversations.workspaceId, scope.workspaceId),
                eq(companionConversations.userId, scope.userId),
                conversationIds.length > 0 ? sql`${companionConversations.id} IN (${sql.join(conversationIds.map((id) => sql`${id}`), sql`, `)})` : sql`false`,
              ))
          : [];
        return {
          rows: messageRows,
          titles: new Map(convs.map((conv) => [conv.id, conv.title])),
        };
      });
      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        query: query.data.q,
        items: rows.map((row) => ({
          messageId: row.messageId,
          conversationId: row.conversationId,
          conversationTitle: titles.get(row.conversationId) ?? null,
          role: row.role,
          kind: row.kind,
          blocks: row.blocks,
          runId: row.runId,
          createdAt: row.createdAt.toISOString(),
        })),
      });
    },
  );
}
