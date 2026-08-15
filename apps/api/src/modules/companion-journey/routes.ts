/**
 * Journey V2 路由（文档 16 §10.1）。
 *
 * GET  /companion/journey/bootstrap
 * POST /companion/invitation/actions（账号级 CAS）
 * POST /companion/journeys/:journeyId/actions（workspace/RLS/CAS）
 * GET  /companion/journeys/:journeyId
 *
 * capability 门控：COMPANION_JOURNEY_V2=true；否则 404 fail closed。
 * 公共 API 只暴露用户意图，不暴露 next_step/complete/update_refs。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../lib/validate.ts";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import {
  companionInvitationActionRequestSchema,
  companionJourneyActionRequestSchema,
} from "@ailearn/shared";
import {
  applyInvitationAction,
  applyJourneyActionRequest,
  bootstrapJourney,
  JourneyServiceError,
} from "./journey-service.ts";
import { companionJourneys } from "../../db/schema/companion-journey.ts";
import { and, eq } from "drizzle-orm";

function isCompanionJourneyV2Enabled(): boolean {
  return process.env.COMPANION_JOURNEY_V2 === "true";
}

const journeyParamsSchema = z.object({ journeyId: z.string().uuid() });

export async function companionJourneyRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (!isCompanionJourneyV2Enabled()) {
      void req;
      return reply.code(404).send({
        error: "companion_journey_v2_disabled",
        message: "新手旅程当前未开放",
      });
    }
  });

  app.get("/companion/journey/bootstrap", { preHandler: [requireSession] }, async (req, reply) => {
    try {
      const bootstrap = await withWorkspaceTransaction(
        { workspaceId: req.session.workspaceId, userId: req.session.userId },
        (tx) => bootstrapJourney(tx, {
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
        }),
      );
      return reply.header("Cache-Control", "no-store").send(bootstrap);
    } catch (err) {
      if (err instanceof JourneyServiceError) {
        return reply.code(409).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post("/companion/invitation/actions", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, companionInvitationActionRequestSchema, req.body);
    try {
      const invitation = await withWorkspaceTransaction(
        { workspaceId: req.session.workspaceId, userId: req.session.userId },
        (tx) => applyInvitationAction(tx, {
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
        }, {
          expectedRevision: body.expectedRevision,
          action: body.action,
          idempotencyKey: body.idempotencyKey,
        }),
      );
      return reply.header("Cache-Control", "no-store").send(invitation);
    } catch (err) {
      if (err instanceof JourneyServiceError) {
        // N#8-4(批次 5): 清理冗余三元（原先 `stale_revision ? 409 : 409` 两分支同为 409）。
        // 现统一直接返回 409；客户端按 body.error 区分具体错误码（stale_revision 等）。
        return reply.code(409).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post<{ Params: { journeyId: string } }>(
    "/companion/journeys/:journeyId/actions",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = journeyParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("journeyId 非法");
      const body = parseBody(app, companionJourneyActionRequestSchema, req.body);
      try {
        const journey = await withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          (tx) => applyJourneyActionRequest(tx, {
            workspaceId: req.session.workspaceId,
            userId: req.session.userId,
          }, params.data.journeyId, {
            expectedRevision: body.expectedRevision,
            action: body.action,
            idempotencyKey: body.idempotencyKey,
          }),
        );
        return reply.header("Cache-Control", "no-store").send(journey);
      } catch (err) {
        if (err instanceof JourneyServiceError) {
          return reply.code(409).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { journeyId: string } }>(
    "/companion/journeys/:journeyId",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = journeyParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("journeyId 非法");
      try {
        const rows = await withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          (tx) => tx
            .select()
            .from(companionJourneys)
            .where(and(
              eq(companionJourneys.id, params.data.journeyId),
              eq(companionJourneys.workspaceId, req.session.workspaceId),
              eq(companionJourneys.userId, req.session.userId),
            ))
            .limit(1),
        );
        const row = rows[0];
        if (!row) {
          return reply.code(404).send({ error: "journey_not_found", message: "旅程不存在" });
        }
        return reply.header("Cache-Control", "no-store").send({
          version: 2,
          journeyId: row.id,
          userId: row.userId,
          workspaceId: row.workspaceId,
          assistantSessionId: row.assistantSessionId,
          status: row.status,
          branch: row.branch,
          currentStep: row.currentStep,
          stepRevision: row.stepRevision,
          dismissedNarrationSteps: row.dismissedNarrationSteps,
          refs: row.refs,
          lastDomainEventId: row.lastDomainEventId,
          pausedAt: row.pausedAt?.toISOString() ?? null,
          pauseReason: row.pauseReason,
          resumeTokenRef: row.resumeTokenRef,
          resumeExpiresAt: row.resumeExpiresAt?.toISOString() ?? null,
          completionKind: row.completionKind,
          error: row.error,
          revision: row.revision,
        });
      } catch (err) {
        if (err instanceof JourneyServiceError) {
          return reply.code(409).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
}
