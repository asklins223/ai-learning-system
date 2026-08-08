/**
 * 任务 03-2：Learning Session 路由（§4.3 PREPARE + §4.2 事务层级 + §12.5）。
 *
 * 端点（全部 requireSession，RLS 上下文由 withWorkspaceTransaction 设置）：
 * - POST   /learning-sessions                 PREPARE：创建 Session + 首个 Episode
 * - POST   /learning-sessions/:id/continue    checkpoint：confirm_continue_session /
 *                                              change_route → PREPARE 下一 Episode
 * - POST   /learning-sessions/:id/end         origin-aware completion（不强制跳页）
 * - GET    /learning-sessions/:id             仅 public Session view（01-2 §5.4）
 * - DELETE /learning-sessions/:id             cancel：当前与未开始 Episode 零副作用、
 *                                              已 commit Episode 保留
 *
 * PREPARE 不返回含答案的评分合同：全部响应都是 buildSessionPublicView 的 public
 * view（不含 scheduling decision / rubricTargets / frozenProbes / solution）。
 *
 * 错误映射：SessionServiceError → { error: code, message }（4xx/409）；其余 5xx。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../lib/validate.ts";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import {
  CheckpointAction,
  SessionServiceError,
  createPgSessionRepository,
  createSession,
  continueSession,
  endSession,
  cancelSession,
  getSessionPublicView,
} from "./session-service.ts";
import {
  AnswerSubmissionError,
  createPgAnswerSubmissionRepository,
  submitEpisodeAnswer,
} from "./answer-submission.ts";

// ─── 请求体 schema（zod，路由层校验）──────────────────────────────────────

const originSchema = z.enum(["card", "review", "star_map", "now"]);
const intentSchema = z.enum(["stabilize", "clarify", "transfer", "explore"]);

const prepareEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key_point"), keyPointId: z.string().min(1) }),
  z.object({
    kind: z.literal("temporary_question"),
    keyPointId: z.string().min(1),
    questionId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("review_entry"),
    reviewScheduleId: z.string().min(1),
    keyPointId: z.string().min(1).optional(),
  }),
]);

const budgetOptionsSchema = z.object({
  estimatedRequiredProbes: z.number().int().min(0).max(20).optional(),
  availableBudgetUnits: z.number().int().min(0).max(1_000_000).optional(),
});

const createSessionRequestSchema = budgetOptionsSchema.extend({
  origin: originSchema,
  entry: prepareEntrySchema,
  intent: intentSchema.optional(),
  preferredKeyPointId: z.string().min(1).optional(),
  providerConfigId: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  requiredCapabilityIds: z.array(z.string().min(1)).max(32).optional(),
});

const continueSessionRequestSchema = budgetOptionsSchema.extend({
  action: z.enum([CheckpointAction.CONFIRM_CONTINUE_SESSION, CheckpointAction.CHANGE_ROUTE]),
  preferredKeyPointId: z.string().min(1).optional(),
});

const sessionParamsSchema = z.object({ id: z.string().uuid() });

function parseSessionParams(
  app: FastifyInstance,
  params: unknown,
): { id: string } {
  const parsed = sessionParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw app.httpErrors.badRequest("session id 非法");
  }
  return parsed.data;
}

export async function learningSessionRoutes(app: FastifyInstance) {
  // POST /learning-sessions — PREPARE：解析入口 → 生成候选 → 冻结 → 写
  // learning_sessions + learning_episodes（status=active，prepared 语义）。
  // 返回 public Session view（不含含答案的评分合同）。
  app.post("/learning-sessions", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, createSessionRequestSchema, req.body);
    try {
      return await withWorkspaceTransaction(
        { workspaceId: req.session.workspaceId, userId: req.session.userId },
        async (tx) => {
          const repo = createPgSessionRepository(tx);
          const result = await createSession(
            {
              workspaceId: req.session.workspaceId,
              userId: req.session.userId,
              origin: body.origin,
              entry: body.entry,
              intent: body.intent,
              preferredKeyPointId: body.preferredKeyPointId,
              estimatedRequiredProbes: body.estimatedRequiredProbes,
              availableBudgetUnits: body.availableBudgetUnits,
              providerConfigId: body.providerConfigId,
              modelId: body.modelId,
              requiredCapabilityIds: body.requiredCapabilityIds,
            },
            repo,
          );
          return result.session;
        },
      );
    } catch (err) {
      if (err instanceof SessionServiceError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // POST /learning-sessions/:id/continue — 多 Episode 用户 checkpoint。
  // 只有 confirm_continue_session 才能 PREPARE 下一 Episode；无倒计时默认选择
  // （默认"结束并返回来源"由客户端在 checkpoint 后调 /end 完成）。
  app.post<{ Params: { id: string } }>(
    "/learning-sessions/:id/continue",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = parseBody(app, continueSessionRequestSchema, req.body);
      const params = parseSessionParams(app, req.params);
      try {
        return await withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          async (tx) => {
            const repo = createPgSessionRepository(tx);
            return continueSession(
              {
                workspaceId: req.session.workspaceId,
                userId: req.session.userId,
                sessionId: params.id,
                action: body.action,
                preferredKeyPointId: body.preferredKeyPointId,
                estimatedRequiredProbes: body.estimatedRequiredProbes,
                availableBudgetUnits: body.availableBudgetUnits,
              },
              repo,
            );
          },
        );
      } catch (err) {
        if (err instanceof SessionServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // POST /learning-sessions/:id/end — origin-aware completion（§4.2）：
  // 用户停止/选择返回/全部 Episode 明确结束 → ended；未完成 Episode 零副作用
  // 取消，已 commit Episode 保留；返回 public view + returnTarget（不强制跳页）。
  app.post<{ Params: { id: string } }>(
    "/learning-sessions/:id/end",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = parseSessionParams(app, req.params);
      try {
        return await withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          async (tx) => {
            const repo = createPgSessionRepository(tx);
            return endSession(
              {
                workspaceId: req.session.workspaceId,
                userId: req.session.userId,
                sessionId: params.id,
              },
              repo,
            );
          },
        );
      } catch (err) {
        if (err instanceof SessionServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // GET /learning-sessions/:id — 仅 public Session view（01-2 §5.4：
  // Private Episode Contract、RubricTarget、solution 字段级不可达）。
  app.get<{ Params: { id: string } }>(
    "/learning-sessions/:id",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = parseSessionParams(app, req.params);
      try {
        return await withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          async (tx) => {
            const repo = createPgSessionRepository(tx);
            return getSessionPublicView(
              {
                workspaceId: req.session.workspaceId,
                userId: req.session.userId,
                sessionId: params.id,
              },
              repo,
            );
          },
        );
      } catch (err) {
        if (err instanceof SessionServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // DELETE /learning-sessions/:id — cancel：当前与未开始 Episode 零副作用，
  // 已 commit Episode 保留（03-2 验收）；session → cancelled。
  app.delete<{ Params: { id: string } }>(
    "/learning-sessions/:id",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = parseSessionParams(app, req.params);
      try {
        return await withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          async (tx) => {
            const repo = createPgSessionRepository(tx);
            return cancelSession(
              {
                workspaceId: req.session.workspaceId,
                userId: req.session.userId,
                sessionId: params.id,
              },
              repo,
            );
          },
        );
      } catch (err) {
        if (err instanceof SessionServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // 救火 3a（审计 #2）：回答上传端点——写 learning_response_artifacts + 锁定 Episode。
  // POST /learning-sessions/:id/episodes/:episodeId/answer
  // body: { modality: "text_or_mixed" | "voice", text: string }
  const submitAnswerParamsSchema = z.object({
    id: z.string().uuid(),
    episodeId: z.string().uuid(),
  });
  const submitAnswerBodySchema = z.object({
    modality: z.enum(["text_or_mixed", "voice"]),
    text: z.string().min(1).max(20_000),
  });
  app.post<{ Params: { id: string; episodeId: string } }>(
    "/learning-sessions/:id/episodes/:episodeId/answer",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const parsed = submitAnswerParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        throw app.httpErrors.badRequest("session/episode id 非法");
      }
      const body = parseBody(app, submitAnswerBodySchema, req.body);
      try {
        return await withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          async (tx) => {
            const repo = createPgAnswerSubmissionRepository(tx);
            // keyPointId/probeId 由服务端从 episode 读取（客户端不传，防越权指定）。
            return submitEpisodeAnswer(
              {
                workspaceId: req.session.workspaceId,
                userId: req.session.userId,
                sessionId: parsed.data.id,
                episodeId: parsed.data.episodeId,
                modality: body.modality,
                text: body.text,
              },
              repo,
            );
          },
        );
      } catch (err) {
        if (err instanceof AnswerSubmissionError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
}
