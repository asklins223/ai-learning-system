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
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@ailearn/shared/content-hash";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { parseBody } from "../../lib/validate.ts";
import { requireSession } from "../identity/middleware.ts";
import { checkAIConsent } from "../identity/service.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { isLearningSessionV2InternalEnabled } from "../../config/learning-companion-flags.ts";
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
import {
  TutorDetourError,
  advanceTutorDetourTurn,
  createPgTutorActionNonceRepository,
  createPgTutorDetourRepository,
  createPgTutorLearningFrontRepository,
  createScopedTutorDetour,
  endScopedTutorDetour,
  type TutorDetourEndReason,
} from "./tutor-detour.ts";
import { enterPracticeMode } from "../companion-shell/presence-control.ts";

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

const tutorDetourParamsSchema = z.object({
  id: z.string().uuid(),
  episodeId: z.string().uuid(),
});
const tutorDetourCreateBodySchema = z.object({
  targetId: z.string().uuid(),
  questionId: z.string().min(1).max(200).optional(),
  contentExposureKey: z.string().min(1).max(500).optional(),
  userActionNonce: z.string().min(8).max(128).optional(),
  deviceSessionId: z.string().min(1).max(200).optional(),
  deviceSurfaceEpoch: z.number().int().min(0).optional(),
});
const tutorPermissionNonceBodySchema = z.object({ targetId: z.string().uuid() });
const tutorTurnBodySchema = z.object({ question: z.string().trim().min(1).max(4_000) });
const tutorEndBodySchema = z.object({
  endReason: z.enum(["return_to_origin", "end_session"]),
  saveQuestionMarker: z.boolean().optional(),
  shouldFlag: z.boolean().optional(),
});
const tutorDetourIdParamsSchema = z.object({ id: z.string().uuid(), detourId: z.string().uuid() });

function tutorNonceHash(nonce: string): string {
  return sha256Hex(`tutor-action:${nonce}`);
}

function tutorErrorStatus(code: TutorDetourError["code"]): number {
  if (code === "detour_not_found" || code === "episode_not_found") return 404;
  if (code === "invalid_end_transition" || code === "invalid_end_reason" || code === "turn_limit_reached") return 409;
  return 400;
}

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
  const requireInternalRollout = (reply: { code: (statusCode: number) => { send: (body: unknown) => unknown } }) => {
    if (isLearningSessionV2InternalEnabled()) return null;
    // 2026-08-12（错误契约审计 P1-1）：大写枚举码放 error 字段会被前端
    // parseApiError 的小写蛇形正则忽略（code 恒 undefined）——统一小写。
    return reply.code(404).send({
      error: "learning_session_v2_disabled",
      message: "学习伴星重构路径当前仅供内部验证",
    });
  };

  // POST /learning-sessions — PREPARE：解析入口 → 生成候选 → 冻结 → 写
  // learning_sessions + learning_episodes（status=active，prepared 语义）。
  // 返回 public Session view（不含含答案的评分合同）。
  app.post("/learning-sessions", { preHandler: [requireSession] }, async (req, reply) => {
    const rollout = requireInternalRollout(reply);
    if (rollout !== null) return rollout;
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
        return reply.code(err.statusCode).send({
          error: err.code,
          message: err.message,
          ...err.recoveryData,
        });
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
      const rollout = requireInternalRollout(reply);
      if (rollout !== null) return rollout;
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
        // 并发 continue：第二个请求撞 learning_episodes_session_active_unique_idx
        // （同一 Session 至多一个未终态 Episode）→ 409 而非 500。
        if (
          err && typeof err === "object" && "code" in err && err.code === "23505"
          && (err as { constraint?: string }).constraint === "learning_episodes_session_active_unique_idx"
        ) {
          return reply.code(409).send({
            error: "episode_limit_reached",
            message: "同一 Session 已有未终态 Episode，不能并发 continue",
          });
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
      const rollout = requireInternalRollout(reply);
      if (rollout !== null) return rollout;
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
      const rollout = requireInternalRollout(reply);
      if (rollout !== null) return rollout;
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
      const rollout = requireInternalRollout(reply);
      if (rollout !== null) return rollout;
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
      const rollout = requireInternalRollout(reply);
      if (rollout !== null) return rollout;
      const parsed = submitAnswerParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        throw app.httpErrors.badRequest("session/episode id 非法");
      }
      const body = parseBody(app, submitAnswerBodySchema, req.body);
      if (!(await checkAIConsent(req.session.workspaceId))) {
        return reply.code(409).send({
          error: "ai_consent_required",
          message: "当前工作区需要先签署 AI 使用协议",
        });
      }
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

  // POST /learning-sessions/:id/episodes/:episodeId/tutor-permission-nonce
  // 仅签发一次性切换凭证，不改变学习事实；前端应在用户确认切换到一起学习后调用。
  app.post<{ Params: { id: string; episodeId: string } }>(
    "/learning-sessions/:id/episodes/:episodeId/tutor-permission-nonce",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const rollout = requireInternalRollout(reply);
      if (rollout !== null) return rollout;
      const params = tutorDetourParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("session/episode id 非法");
      const body = parseBody(app, tutorPermissionNonceBodySchema, req.body);
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      try {
        return await withWorkspaceTransaction(scope, async (tx) => {
          const episodeRows = (await tx.execute(sql`
            SELECT id
            FROM learning_episodes
            WHERE id = ${params.data.episodeId} AND session_id = ${params.data.id}
              AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
              AND key_point_id = ${body.targetId} AND status = 'active'
            LIMIT 1
          `)) as Array<Record<string, unknown>>;
          if (episodeRows.length === 0) {
            throw new TutorDetourError("episode_not_found", "Episode 不存在或不属于当前 Session");
          }
          const nonce = randomUUID();
          const expiresAt = new Date(Date.now() + 60_000);
          await createPgTutorActionNonceRepository(tx).issue({
            scope,
            sessionId: params.data.id,
            keyPointId: body.targetId,
            nonceHash: tutorNonceHash(nonce),
            expiresAt,
          });
          return { userActionNonce: nonce, expiresAt: expiresAt.toISOString() };
        });
      } catch (err) {
        if (err instanceof TutorDetourError) {
          return reply.code(tutorErrorStatus(err.code)).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // POST /learning-sessions/:id/episodes/:episodeId/tutor-detour
  // 创建与当前 Episode 绑定的有限 Tutor 分流；不创建独立聊天会话。
  app.post<{ Params: { id: string; episodeId: string } }>(
    "/learning-sessions/:id/episodes/:episodeId/tutor-detour",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const rollout = requireInternalRollout(reply);
      if (rollout !== null) return rollout;
      const params = tutorDetourParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("session/episode id 非法");
      const body = parseBody(app, tutorDetourCreateBodySchema, req.body);
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      try {
        return await withWorkspaceTransaction(scope, async (tx) => {
          const episodeRows = (await tx.execute(sql`
            SELECT id, key_point_id AS "keyPointId", content_exposure_key AS "contentExposureKey"
            FROM learning_episodes
            WHERE id = ${params.data.episodeId} AND session_id = ${params.data.id}
              AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
              AND status = 'active'
            LIMIT 1
          `)) as Array<Record<string, unknown>>;
          const episode = episodeRows[0];
          if (!episode || String(episode.keyPointId) !== body.targetId) {
            throw new TutorDetourError("episode_not_found", "Episode 不存在或目标已变化");
          }

          const accountRows = (await tx.execute(sql`
            SELECT epoch FROM user_companion_account_state
            WHERE user_id = ${scope.userId}
            LIMIT 1
          `)) as Array<Record<string, unknown>>;
          const accountEpoch = Number(accountRows[0]?.epoch ?? 0);
          const frontRepo = createPgTutorLearningFrontRepository(tx);
          const nonceRepo = createPgTutorActionNonceRepository(tx);
          const detourRepo = createPgTutorDetourRepository(tx);
          const result = await createScopedTutorDetour(
            {
              repo: frontRepo,
              transaction: async <T>(fn: () => Promise<T>) => fn(),
              now: () => new Date(),
              detourRepo,
              enterPractice: (input) => enterPracticeMode(
                {
                  repo: frontRepo,
                  transaction: async <T>(fn: () => Promise<T>) => fn(),
                  now: () => new Date(),
                  validateAndConsumeUserActionNonce: async (innerScope, keyPointId, nonce) =>
                    nonceRepo.consume({
                      scope: innerScope,
                      sessionId: params.data.id,
                      keyPointId,
                      nonceHash: tutorNonceHash(nonce),
                      now: new Date(),
                    }),
                },
                input,
              ),
            },
            {
              scope,
              detourId: randomUUID(),
              sessionId: params.data.id,
              episodeId: params.data.episodeId,
              targetId: body.targetId,
              questionId: body.questionId ?? `question:${randomUUID()}`,
              // 只用服务端 episode 值：客户端不能指定任意 exposure key（避免
              // 污染其它 key 的 exposure 记录；trusted→practice 切换也依赖服务端推导）。
              contentExposureKey: String(episode.contentExposureKey ?? ""),
              userActionNonce: body.userActionNonce,
              deviceSessionId: body.deviceSessionId,
              deviceSurfaceEpoch: body.deviceSurfaceEpoch,
              accountEpoch,
            },
          );
          return result;
        });
      } catch (err) {
        if (err instanceof TutorDetourError) {
          return reply.code(tutorErrorStatus(err.code)).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // POST /learning-sessions/:id/tutor-detours/:detourId/turn
  // 只返回当前 Key Point 的有据说明；不保存 raw question/message history。
  app.post<{ Params: { id: string; detourId: string } }>(
    "/learning-sessions/:id/tutor-detours/:detourId/turn",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const rollout = requireInternalRollout(reply);
      if (rollout !== null) return rollout;
      const params = tutorDetourIdParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("session/detour id 非法");
      const body = parseBody(app, tutorTurnBodySchema, req.body);
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      try {
        return await withWorkspaceTransaction(scope, async (tx) => {
          const detourRepo = createPgTutorDetourRepository(tx);
          const current = await detourRepo.findDetour(scope, params.data.detourId);
          if (!current || current.sessionId !== params.data.id) {
            throw new TutorDetourError("detour_not_found", "Tutor 分流不存在");
          }
          const next = advanceTutorDetourTurn(current);
          if (!next.allowed) {
            throw new TutorDetourError(
              current.status === "ended" ? "invalid_end_transition" : "turn_limit_reached",
              next.reason ?? "Tutor 回合不可用",
            );
          }
          const rows = (await tx.execute(sql`
            SELECT rev.objective_statement AS claim
            FROM learning_objectives_v2 o
            JOIN learning_objective_revisions_v2 rev
              ON rev.objective_id = o.objective_id
              AND rev.workspace_id = o.workspace_id
              AND rev.revision = o.current_revision
            WHERE o.objective_id = ${current.targetId}
              AND o.workspace_id = ${scope.workspaceId}
            LIMIT 1
          `)) as Array<Record<string, unknown>>;
          const claim = String(rows[0]?.claim ?? "当前学习卡还没有可展开的核心理解。");
          const evidence: Array<{ evidenceId: string; quote: string }> = [];
          await detourRepo.updateDetour(scope, next.record);
          return {
            detour: next.record,
            turn: {
              turnCount: next.record.turnCount,
              maxTurns: next.record.maxTurns,
              source: "current_target",
              text: next.record.turnCount === 1
                ? `先把这张卡的核心放在这里：${claim}`
                : `沿着你刚才的追问，再回到这张卡的依据：${claim}`,
              evidence,
              followUpAvailable: next.record.turnCount < next.record.maxTurns,
              questionAccepted: body.question.length > 0,
            },
          };
        });
      } catch (err) {
        if (err instanceof TutorDetourError) {
          return reply.code(tutorErrorStatus(err.code)).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // POST /learning-sessions/:id/tutor-detours/:detourId/end
  app.post<{ Params: { id: string; detourId: string } }>(
    "/learning-sessions/:id/tutor-detours/:detourId/end",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const rollout = requireInternalRollout(reply);
      if (rollout !== null) return rollout;
      const params = tutorDetourIdParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("session/detour id 非法");
      const body = parseBody(app, tutorEndBodySchema, req.body);
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      try {
        return await withWorkspaceTransaction(scope, async (tx) => {
          const detourRepo = createPgTutorDetourRepository(tx);
          const current = await detourRepo.findDetour(scope, params.data.detourId);
          if (!current || current.sessionId !== params.data.id) {
            throw new TutorDetourError("detour_not_found", "Tutor 分流不存在");
          }
          return endScopedTutorDetour(
            {
              repo: createPgTutorLearningFrontRepository(tx),
              transaction: async <T>(fn: () => Promise<T>) => fn(),
              now: () => new Date(),
              detourRepo,
              enterPractice: async () => ({
                state: "together",
                assistanceRecorded: false,
                tutorPermissionOpened: true,
              }),
            },
            {
              scope,
              detourId: params.data.detourId,
              endReason: body.endReason as TutorDetourEndReason,
              saveQuestionMarker: body.saveQuestionMarker,
              shouldFlag: body.shouldFlag,
            },
          );
        });
      } catch (err) {
        if (err instanceof TutorDetourError) {
          return reply.code(tutorErrorStatus(err.code)).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
}
