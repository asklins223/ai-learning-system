import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireOwner, requireSession } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import { parseQuery, uuidParamSchema } from "../../lib/pagination.ts";
import {
  createCardGenerationRunSchema,
  generationEventsQuerySchema,
  agentEventsQuerySchema,
} from "./schema.ts";
import {
  cancelCardGenerationRun,
  CardGenerationServiceError,
  createCardGenerationRun,
  getCardGenerationRun,
  getLatestCardGenerationRun,
  listCardGenerationAgentEvents,
  listCardGenerationEvents,
  retryCardGenerationRun,
} from "./service.ts";

const NO_STORE = { "Cache-Control": "private, no-store" };

function context(req: { session: { workspaceId: string; userId: string } }) {
  return { workspaceId: req.session.workspaceId, userId: req.session.userId };
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof CardGenerationServiceError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

export async function cardGenerationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.post("/card-generation-runs", { preHandler: [requireOwner] }, async (req, reply) => {
    reply.headers(NO_STORE);
    const body = parseBody(app, createCardGenerationRunSchema, req.body);
    try {
      const result = await createCardGenerationRun(context(req), body);
      return reply.code(202).send(result);
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/card-generation-runs/:id", async (req, reply) => {
    reply.headers(NO_STORE);
    if (!uuidParamSchema.safeParse(req.params).success) {
      return reply.code(400).send({ error: "invalid_id" });
    }
    try {
      const run = await getCardGenerationRun(context(req), req.params.id);
      return run ?? reply.code(404).send({ error: "generation_run_not_found" });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // QUAL-44 修复：GET 路由添加 try-catch 错误处理，与 POST 路由保持一致
  app.get<{ Params: { id: string } }>("/card-generation-runs/:id/events", async (req, reply) => {
    reply.headers(NO_STORE);
    if (!uuidParamSchema.safeParse(req.params).success) {
      return reply.code(400).send({ error: "invalid_id" });
    }
    try {
      const query = parseQuery(app, generationEventsQuerySchema, req.query);
      const events = await listCardGenerationEvents(context(req), req.params.id, query.after);
      return events ?? reply.code(404).send({ error: "generation_run_not_found" });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // QUAL-44 修复：GET 路由添加 try-catch 错误处理
  app.get<{ Params: { id: string } }>("/card-generation-runs/:id/agent-events", async (req, reply) => {
    reply.headers(NO_STORE);
    if (!uuidParamSchema.safeParse(req.params).success) {
      return reply.code(400).send({ error: "invalid_id" });
    }
    try {
      const query = parseQuery(app, agentEventsQuerySchema, req.query);
      const events = await listCardGenerationAgentEvents(
        context(req),
        req.params.id,
        { since: query.since, limit: query.limit, includeUsage: query.includeUsage },
      );
      return events ?? reply.code(404).send({ error: "generation_run_not_found" });
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/card-generation-runs/:id/cancel",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse(req.params).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      try {
        const run = await cancelCardGenerationRun(context(req), req.params.id);
        return run ?? reply.code(404).send({ error: "generation_run_not_found" });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/card-generation-runs/:id/retry",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse(req.params).success) {
        return reply.code(400).send({ error: "invalid_id" });
      }
      try {
        const run = await retryCardGenerationRun(context(req), req.params.id);
        return run ?? reply.code(404).send({ error: "generation_run_not_found" });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/note-versions/:id/card-generation-latest",
    async (req, reply) => {
      reply.headers(NO_STORE);
      const parsed = z.string().uuid().safeParse(req.params.id);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_id" });
      try {
        const run = await getLatestCardGenerationRun(context(req), parsed.data);
        return { run };
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );
}
