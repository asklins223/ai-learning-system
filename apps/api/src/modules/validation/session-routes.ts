/**
 * v0.6 Validation Session Routes (计划 §8.2)
 *
 * Endpoints:
 *   POST   /cards/:cardId/validation-sessions/start
 *   GET    /validation-sessions/:submissionId
 *   PATCH  /validation-sessions/:submissionId/draft
 *   POST   /validation-sessions/:submissionId/reveal-source
 *   POST   /validation-sessions/:submissionId/reveal-result
 *   POST   /validation-sessions/:submissionId/submit
 *   POST   /validation-sessions/:submissionId/unable
 *   POST   /validation-sessions/:submissionId/retry-question
 *   POST   /validation-sessions/:submissionId/retry-evaluation
 *   POST   /validation-sessions/:submissionId/abandon
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import { uuidParamSchema, cardIdParamSchema } from "../../lib/pagination.ts";
import {
  startSessionSchema,
  draftAnswerSchema,
  revealSourceSchema,
  revealResultSchema,
  submitAnswerSchema,
  unableSchema,
  retryQuestionSchema,
  retryEvaluationSchema,
  abandonSchema,
  qualitySignalSchema,
} from "./session-schema.ts";
import {
  startValidationSession,
  getValidationSession,
  draftAnswer,
  revealSource,
  revealResult,
  submitAnswer,
  unableToAnswer,
  retryQuestion,
  retryEvaluation,
  abandonSession,
  submitQualitySignal,
  SessionError,
} from "./session-service.ts";

const NO_STORE = { "Cache-Control": "private, no-store" };

function sendSessionError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof SessionError) {
    reply.code(error.statusCode).send({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

export async function validationSessionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // POST /cards/:cardId/validation-sessions/start
  app.post<{ Params: { cardId: string } }>("/cards/:cardId/validation-sessions/start", async (req, reply) => {
    const params = cardIdParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid cardId format" });
    const body = parseBody(app, startSessionSchema, req.body);
    try {
      const result = await startValidationSession(
        req.params.cardId,
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      reply.headers(NO_STORE);
      return reply.send(result);
    } catch (error) {
      if (!sendSessionError(reply, error)) throw error;
    }
  });

  // GET /validation-sessions/:submissionId
  app.get<{ Params: { submissionId: string } }>("/validation-sessions/:submissionId", async (req, reply) => {
    const params = uuidParamSchema.safeParse({ id: req.params.submissionId });
    if (!params.success) return reply.code(400).send({ error: "invalid submissionId format" });
    const item = await getValidationSession(
      req.params.submissionId,
      req.session.workspaceId,
      req.session.userId,
    );
    if (!item) return reply.code(404).send({ error: "not found" });
    reply.headers(NO_STORE);
    return item;
  });

  // PATCH /validation-sessions/:submissionId/draft
  app.patch<{ Params: { submissionId: string } }>("/validation-sessions/:submissionId/draft", async (req, reply) => {
    const params = uuidParamSchema.safeParse({ id: req.params.submissionId });
    if (!params.success) return reply.code(400).send({ error: "invalid submissionId format" });
    const body = parseBody(app, draftAnswerSchema, req.body);
    try {
      const result = await draftAnswer(
        req.params.submissionId,
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      reply.headers(NO_STORE);
      return result;
    } catch (error) {
      if (!sendSessionError(reply, error)) throw error;
    }
  });

  // POST /validation-sessions/:submissionId/reveal-source
  app.post<{ Params: { submissionId: string } }>("/validation-sessions/:submissionId/reveal-source", async (req, reply) => {
    const params = uuidParamSchema.safeParse({ id: req.params.submissionId });
    if (!params.success) return reply.code(400).send({ error: "invalid submissionId format" });
    const body = parseBody(app, revealSourceSchema, req.body);
    try {
      const result = await revealSource(
        req.params.submissionId,
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      reply.headers(NO_STORE);
      return result;
    } catch (error) {
      if (!sendSessionError(reply, error)) throw error;
    }
  });

  // POST /validation-sessions/:submissionId/reveal-result
  app.post<{ Params: { submissionId: string } }>("/validation-sessions/:submissionId/reveal-result", async (req, reply) => {
    const params = uuidParamSchema.safeParse({ id: req.params.submissionId });
    if (!params.success) return reply.code(400).send({ error: "invalid submissionId format" });
    const body = parseBody(app, revealResultSchema, req.body);
    try {
      const result = await revealResult(
        req.params.submissionId,
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      reply.headers(NO_STORE);
      return result;
    } catch (error) {
      if (!sendSessionError(reply, error)) throw error;
    }
  });

  // POST /validation-sessions/:submissionId/submit
  app.post<{ Params: { submissionId: string } }>("/validation-sessions/:submissionId/submit", async (req, reply) => {
    const params = uuidParamSchema.safeParse({ id: req.params.submissionId });
    if (!params.success) return reply.code(400).send({ error: "invalid submissionId format" });
    const body = parseBody(app, submitAnswerSchema, req.body);
    try {
      const result = await submitAnswer(
        req.params.submissionId,
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      reply.headers(NO_STORE);
      return result;
    } catch (error) {
      if (!sendSessionError(reply, error)) throw error;
    }
  });

  // POST /validation-sessions/:submissionId/unable
  app.post<{ Params: { submissionId: string } }>("/validation-sessions/:submissionId/unable", async (req, reply) => {
    const params = uuidParamSchema.safeParse({ id: req.params.submissionId });
    if (!params.success) return reply.code(400).send({ error: "invalid submissionId format" });
    const body = parseBody(app, unableSchema, req.body);
    try {
      const result = await unableToAnswer(
        req.params.submissionId,
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      reply.headers(NO_STORE);
      return result;
    } catch (error) {
      if (!sendSessionError(reply, error)) throw error;
    }
  });

  // POST /validation-sessions/:submissionId/retry-question
  app.post<{ Params: { submissionId: string } }>("/validation-sessions/:submissionId/retry-question", async (req, reply) => {
    const params = uuidParamSchema.safeParse({ id: req.params.submissionId });
    if (!params.success) return reply.code(400).send({ error: "invalid submissionId format" });
    const body = parseBody(app, retryQuestionSchema, req.body);
    try {
      const result = await retryQuestion(
        req.params.submissionId,
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      reply.headers(NO_STORE);
      return result;
    } catch (error) {
      if (!sendSessionError(reply, error)) throw error;
    }
  });

  // POST /validation-sessions/:submissionId/retry-evaluation
  app.post<{ Params: { submissionId: string } }>("/validation-sessions/:submissionId/retry-evaluation", async (req, reply) => {
    const params = uuidParamSchema.safeParse({ id: req.params.submissionId });
    if (!params.success) return reply.code(400).send({ error: "invalid submissionId format" });
    const body = parseBody(app, retryEvaluationSchema, req.body);
    try {
      const result = await retryEvaluation(
        req.params.submissionId,
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      reply.headers(NO_STORE);
      return result;
    } catch (error) {
      if (!sendSessionError(reply, error)) throw error;
    }
  });

  // POST /validation-sessions/:submissionId/abandon
  app.post<{ Params: { submissionId: string } }>("/validation-sessions/:submissionId/abandon", async (req, reply) => {
    const params = uuidParamSchema.safeParse({ id: req.params.submissionId });
    if (!params.success) return reply.code(400).send({ error: "invalid submissionId format" });
    const body = parseBody(app, abandonSchema, req.body);
    try {
      const result = await abandonSession(
        req.params.submissionId,
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      reply.headers(NO_STORE);
      return result;
    } catch (error) {
      if (!sendSessionError(reply, error)) throw error;
    }
  });

  // POST /validation-events/:eventId/quality-signal (计划 §8.4 Should)
  app.post<{ Params: { eventId: string } }>("/validation-events/:eventId/quality-signal", async (req, reply) => {
    const params = uuidParamSchema.safeParse({ id: req.params.eventId });
    if (!params.success) return reply.code(400).send({ error: "invalid eventId format" });
    const body = parseBody(app, qualitySignalSchema, req.body);
    try {
      const result = await submitQualitySignal(
        req.params.eventId,
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      reply.headers(NO_STORE);
      return result;
    } catch (error) {
      if (!sendSessionError(reply, error)) throw error;
    }
  });
}
