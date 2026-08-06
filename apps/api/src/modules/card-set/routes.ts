import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { parseQuery, paginationQuerySchema, uuidParamSchema } from "../../lib/pagination.ts";
import { requireOwner, requireSession } from "../identity/middleware.ts";
import {
  CardSetServiceError,
  dismissCardSet,
  getCardSetWithDetail,
  listCardSetCards,
  listCardSets,
  regenerateCardSet,
} from "./service.ts";

const cardSetCardsQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// QUAL-18 修复：统一错误响应格式为 { error, message }，
// 移除冗余的 code 字段（与 card-generation/routes.ts 的错误格式一致）
function sendCardSetError(reply: FastifyReply, error: unknown) {
  if (error instanceof CardSetServiceError) {
    return reply.code(error.statusCode).send({
      error: error.code,
      message: error.message,
    });
  }
  throw error;
}

export async function cardSetRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // QUAL-25 修复：GET 路由添加 try-catch 错误处理，与 POST 路由保持一致
  app.get("/card-sets", async (req, reply) => {
    const query = parseQuery(app, paginationQuerySchema, req.query);
    try {
      return await listCardSets(req.session.workspaceId, req.session.userId, {
        cursor: query.cursor,
        limit: query.limit,
      });
    } catch (error) {
      return sendCardSetError(reply, error);
    }
  });

  // QUAL-25 修复：GET 路由添加 try-catch 错误处理
  app.get<{ Params: { id: string } }>("/card-sets/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) {
      // QUAL-18 修复：移除冗余的 code 字段，统一为 { error } 格式
      return reply.code(400).send({ error: "invalid_id" });
    }
    try {
      const result = await getCardSetWithDetail(
        params.data.id,
        req.session.workspaceId,
        req.session.userId,
      );
      // QUAL-18 修复：统一 404 响应格式，添加 error 字段
      if (!result) return reply.code(404).send({ error: "not_found" });
      return result;
    } catch (error) {
      return sendCardSetError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/card-sets/:id/cards",
    async (req, reply) => {
      const params = uuidParamSchema.safeParse(req.params);
      if (!params.success) {
        // QUAL-18 修复：移除冗余的 code 字段，统一为 { error } 格式
      return reply.code(400).send({ error: "invalid_id" });
      }
      const query = parseQuery(app, cardSetCardsQuerySchema, req.query);
      try {
        const result = await listCardSetCards(
          params.data.id,
          req.session.workspaceId,
          req.session.userId,
          query,
        );
        // QUAL-18 修复：统一 404 响应格式，添加 error 字段
      if (!result) return reply.code(404).send({ error: "not_found" });
        return result;
      } catch (error) {
        return sendCardSetError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/card-sets/:id/dismiss",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      const params = uuidParamSchema.safeParse(req.params);
      if (!params.success) {
        // QUAL-18 修复：移除冗余的 code 字段，统一为 { error } 格式
      return reply.code(400).send({ error: "invalid_id" });
      }
      try {
        const result = await dismissCardSet(
          params.data.id,
          req.session.workspaceId,
          req.session.userId,
        );
        // QUAL-18 修复：统一 404 响应格式，添加 error 字段
      if (!result) return reply.code(404).send({ error: "not_found" });
        return result;
      } catch (error) {
        return sendCardSetError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/card-sets/:id/regenerate",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      const params = uuidParamSchema.safeParse(req.params);
      if (!params.success) {
        // QUAL-18 修复：移除冗余的 code 字段，统一为 { error } 格式
      return reply.code(400).send({ error: "invalid_id" });
      }
      try {
        const result = await regenerateCardSet(
          params.data.id,
          req.session.workspaceId,
          req.session.userId,
        );
        // QUAL-18 修复：统一 404 响应格式，添加 error 字段
      if (!result) return reply.code(404).send({ error: "not_found" });
        return result;
      } catch (error) {
        return sendCardSetError(reply, error);
      }
    },
  );
}
