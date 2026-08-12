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

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodTypeAny } from "zod";
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

/** Session 错误处理器：如果是 SessionError 则发送结构化错误响应，否则重新抛出 */
function sendSessionError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof SessionError) {
    reply.code(error.statusCode).send({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

// ─── QUAL-16 修复：提取共享路由辅助函数 ──────────────────────────────────
// 原代码中 8+ 个路由处理器完全复制了相同的模式：参数校验 → body 解析 →
// 服务调用 → 错误处理。以下辅助函数消除了重复代码，提升可维护性。

/** 校验 submissionId 参数格式 */
function validateSubmissionId(req: FastifyRequest, reply: FastifyReply): string | null {
  const params = uuidParamSchema.safeParse({ id: (req.params as { submissionId: string }).submissionId });
  if (!params.success) {
    reply.code(400).send({ error: "invalid submissionId format" });
    return null;
  }
  return (req.params as { submissionId: string }).submissionId;
}

/** 校验 eventId 参数格式 */
function validateEventId(req: FastifyRequest, reply: FastifyReply): string | null {
  const params = uuidParamSchema.safeParse({ id: (req.params as { eventId: string }).eventId });
  if (!params.success) {
    reply.code(400).send({ error: "invalid eventId format" });
    return null;
  }
  return (req.params as { eventId: string }).eventId;
}

/**
 * 通用 POST/PATCH 路由处理器工厂。
 * 封装参数校验 → body 解析 → 服务调用 → 错误处理的通用模式。
 */
function createSubmissionRoute<S extends ZodTypeAny, TResult>(
  schema: S,
  serviceFn: (
    submissionId: string,
    workspaceId: string,
    userId: string,
    body: z.output<S>,
  ) => Promise<TResult>,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const submissionId = validateSubmissionId(req, reply);
    if (!submissionId) return;
    const body = parseBody(req.server, schema, req.body);
    try {
      const result = await serviceFn(
        submissionId,
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      reply.headers(NO_STORE);
      return result;
    } catch (error) {
      if (!sendSessionError(reply, error)) throw error;
    }
  };
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
  // QUAL-38 修复：添加 try-catch 错误处理，与其他 POST 端点保持一致。
  app.get<{ Params: { submissionId: string } }>("/validation-sessions/:submissionId", async (req, reply) => {
    const submissionId = validateSubmissionId(req, reply);
    if (!submissionId) return;
    try {
      const item = await getValidationSession(
        submissionId,
        req.session.workspaceId,
        req.session.userId,
      );
      if (!item) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      reply.headers(NO_STORE);
      return item;
    } catch (error) {
      if (!sendSessionError(reply, error)) throw error;
    }
  });

  // PATCH /validation-sessions/:submissionId/draft
  app.patch<{ Params: { submissionId: string } }>(
    "/validation-sessions/:submissionId/draft",
    createSubmissionRoute(draftAnswerSchema, draftAnswer),
  );

  // POST /validation-sessions/:submissionId/reveal-source
  app.post<{ Params: { submissionId: string } }>(
    "/validation-sessions/:submissionId/reveal-source",
    createSubmissionRoute(revealSourceSchema, revealSource),
  );

  // POST /validation-sessions/:submissionId/reveal-result
  app.post<{ Params: { submissionId: string } }>(
    "/validation-sessions/:submissionId/reveal-result",
    createSubmissionRoute(revealResultSchema, revealResult),
  );

  // POST /validation-sessions/:submissionId/submit
  app.post<{ Params: { submissionId: string } }>(
    "/validation-sessions/:submissionId/submit",
    createSubmissionRoute(submitAnswerSchema, submitAnswer),
  );

  // POST /validation-sessions/:submissionId/unable
  app.post<{ Params: { submissionId: string } }>(
    "/validation-sessions/:submissionId/unable",
    createSubmissionRoute(unableSchema, unableToAnswer),
  );

  // POST /validation-sessions/:submissionId/retry-question
  app.post<{ Params: { submissionId: string } }>(
    "/validation-sessions/:submissionId/retry-question",
    createSubmissionRoute(retryQuestionSchema, retryQuestion),
  );

  // POST /validation-sessions/:submissionId/retry-evaluation
  app.post<{ Params: { submissionId: string } }>(
    "/validation-sessions/:submissionId/retry-evaluation",
    createSubmissionRoute(retryEvaluationSchema, retryEvaluation),
  );

  // POST /validation-sessions/:submissionId/abandon
  app.post<{ Params: { submissionId: string } }>(
    "/validation-sessions/:submissionId/abandon",
    createSubmissionRoute(abandonSchema, abandonSession),
  );

  // POST /validation-events/:eventId/quality-signal (计划 §8.4 Should)
  app.post<{ Params: { eventId: string } }>("/validation-events/:eventId/quality-signal", async (req, reply) => {
    const eventId = validateEventId(req, reply);
    if (!eventId) return;
    const body = parseBody(app, qualitySignalSchema, req.body);
    try {
      const result = await submitQualitySignal(
        eventId,
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
