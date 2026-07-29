import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { parseQuery, paginationQuerySchema, uuidParamSchema } from "../../lib/pagination.ts";
import { requireOwner, requireSession } from "../identity/middleware.ts";
import {
  acceptCardSet,
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

function sendCardSetError(reply: FastifyReply, error: unknown) {
  if (error instanceof CardSetServiceError) {
    return reply.code(error.statusCode).send({
      error: error.code,
      code: error.code,
      message: error.message,
    });
  }
  throw error;
}

export async function cardSetRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/card-sets", async (req) => {
    const query = parseQuery(app, paginationQuerySchema, req.query);
    return listCardSets(req.session.workspaceId, req.session.userId, {
      cursor: query.cursor,
      limit: query.limit,
    });
  });

  app.get<{ Params: { id: string } }>("/card-sets/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid_id", code: "invalid_id" });
    }
    const result = await getCardSetWithDetail(
      params.data.id,
      req.session.workspaceId,
      req.session.userId,
    );
    if (!result) return reply.code(404).send({ error: "not_found" });
    return result;
  });

  app.get<{ Params: { id: string } }>(
    "/card-sets/:id/cards",
    async (req, reply) => {
      const params = uuidParamSchema.safeParse(req.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid_id", code: "invalid_id" });
      }
      const query = parseQuery(app, cardSetCardsQuerySchema, req.query);
      try {
        const result = await listCardSetCards(
          params.data.id,
          req.session.workspaceId,
          req.session.userId,
          query,
        );
        if (!result) return reply.code(404).send({ error: "not_found" });
        return result;
      } catch (error) {
        return sendCardSetError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/card-sets/:id/accept",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      const params = uuidParamSchema.safeParse(req.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid_id", code: "invalid_id" });
      }
      try {
        const result = await acceptCardSet(
          params.data.id,
          req.session.workspaceId,
          req.session.userId,
        );
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
        return reply.code(400).send({ error: "invalid_id", code: "invalid_id" });
      }
      try {
        const result = await dismissCardSet(
          params.data.id,
          req.session.workspaceId,
          req.session.userId,
        );
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
        return reply.code(400).send({ error: "invalid_id", code: "invalid_id" });
      }
      try {
        const result = await regenerateCardSet(
          params.data.id,
          req.session.workspaceId,
          req.session.userId,
        );
        if (!result) return reply.code(404).send({ error: "not_found" });
        return result;
      } catch (error) {
        return sendCardSetError(reply, error);
      }
    },
  );
}
