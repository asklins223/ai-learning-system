/**
 * Delivery 时间线审计端点（文档 16 §14.3：action/result 时间线）。
 *
 * GET /companion/deliveries/timeline?after=<inboxSequence>&limit=50
 * 返回该 workspace 用户的 delivery 时间线（含 action/result/session/失效），
 * 倒序。审计用（无写权限）。capability：COMPANION_JOURNEY_V2 同开关。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import type { AssistantDeliveryV2 } from "@ailearn/shared";
import { listInbox } from "./delivery-service.ts";

function isCompanionJourneyV2Enabled(): boolean {
  return process.env.COMPANION_JOURNEY_V2 === "true";
}

const DELIVERY_KINDS = ["message", "proposal", "action_result", "proactive_cue", "system_event", "memory_candidate"] as const;

const timelineQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  kind: z.enum(DELIVERY_KINDS).optional(),
});

export async function deliveryTimelineRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    // capability 门控（与 companion-journey routes 同开关）：off 时 404 fail closed。
    if (!isCompanionJourneyV2Enabled()) {
      void req;
      return reply.code(404).send({
        error: "companion_journey_v2_disabled",
        message: "新手旅程当前未开放",
      });
    }
  });
  app.get<{ Querystring: Record<string, string> }>(
    "/companion/deliveries/timeline",
    { preHandler: [requireSession] },
    async (req) => {
      const query = timelineQuerySchema.safeParse(req.query ?? {});
      if (!query.success) throw app.httpErrors.badRequest("timeline query 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const deliveries = await withWorkspaceTransaction(scope, (tx) =>
        listInbox(tx, scope, {
          afterSequence: query.data.after ?? 0,
          limit: query.data.limit ?? 50,
          kind: query.data.kind,
        }),
      );
      const items: Array<AssistantDeliveryV2 & { expired: boolean }> = deliveries.map((d) => ({
        ...d,
        expired: d.expiresAt !== null && new Date(d.expiresAt).getTime() <= Date.now(),
      }));
      return {
        items,
        nextCursor: items.length > 0 ? items[items.length - 1].inboxSequence : (query.data.after ?? 0),
        serverTime: new Date().toISOString(),
      };
    },
  );
}
