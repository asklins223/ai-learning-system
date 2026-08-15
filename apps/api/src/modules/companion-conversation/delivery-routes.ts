/**
 * Durable delivery 消费端点（文档 16 §14.3）。
 *
 * POST /companion/deliveries/:id/lease   — claim display lease（跨设备单租约 CAS）
 * POST /companion/deliveries/:id/ack     — ACK（displayed/acted/dismissed/snoozed，幂等）
 *
 * capability 门控：COMPANION_JOURNEY_V2=true；否则 404 fail closed。
 * Pet（或任意桌面端表面）通过 inbox SSE 收到 delivery 后，先 claim lease，
 * 展示后再 ACK；lease 丢失的设备不得 ACK（服务端校验）。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../lib/validate.ts";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { assistantDeliveryAckV2Schema } from "@ailearn/shared";
import { ackDelivery, claimDisplayLease, DeliveryServiceError } from "./delivery-service.ts";

function isCompanionJourneyV2Enabled(): boolean {
  return process.env.COMPANION_JOURNEY_V2 === "true";
}

const deliveryParamsSchema = z.object({ id: z.string().uuid() });

const leaseBodySchema = z
  .object({
    version: z.literal(2),
    deviceSessionId: z.string().min(1).max(200),
    leaseToken: z.string().min(1).max(200),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export async function deliveryRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (!isCompanionJourneyV2Enabled()) {
      void req;
      return reply.code(404).send({
        error: "companion_journey_v2_disabled",
        message: "新手旅程当前未开放",
      });
    }
  });

  app.post<{ Params: { id: string } }>(
    "/companion/deliveries/:id/lease",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = deliveryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("deliveryId 非法");
      const body = parseBody(app, leaseBodySchema, req.body);
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      try {
        const delivery = await withWorkspaceTransaction(scope, (tx) =>
          claimDisplayLease(tx, scope, {
            deliveryId: params.data.id,
            deviceSessionId: body.deviceSessionId,
            leaseToken: body.leaseToken,
          }),
        );
        return reply.header("Cache-Control", "no-store").send(delivery);
      } catch (err) {
        if (err instanceof DeliveryServiceError) {
          return reply.code(err.code === "delivery_not_found" ? 404 : 409)
            .send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/deliveries/:id/ack",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = deliveryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("deliveryId 非法");
      const body = parseBody(app, assistantDeliveryAckV2Schema, req.body);
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      try {
        const delivery = await withWorkspaceTransaction(scope, (tx) =>
          ackDelivery(tx, scope, {
            deliveryId: params.data.id,
            deviceSessionId: body.deviceSessionId,
            leaseToken: body.leaseToken,
            transition: body.transition,
            snoozedUntil: body.snoozedUntil,
          }),
        );
        return reply.header("Cache-Control", "no-store").send(delivery);
      } catch (err) {
        if (err instanceof DeliveryServiceError) {
          const status = err.code === "delivery_not_found" ? 404
            : err.code === "lease_mismatch" || err.code === "lease_expired" ? 409
              : err.code === "invalid_transition" ? 409
                : 409;
          return reply.code(status).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
}
