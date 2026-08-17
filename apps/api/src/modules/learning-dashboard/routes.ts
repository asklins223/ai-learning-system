/**
 * Plan 23 W3-06：Dashboard route + ETag。
 * GET /v2/learning-dashboard —— private/no-store 语义（user-scoped personal state）；
 * 支持 If-None-Match → 304。
 */
import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { buildLearningDashboardV2 } from "./service.ts";

export async function learningDashboardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/v2/learning-dashboard", async (req, reply) => {
    const ctx = { workspaceId: req.session.workspaceId, userId: req.session.userId };
    const dashboard = await withWorkspaceTransaction(ctx, (tx) =>
      buildLearningDashboardV2(tx, ctx),
    );
    const etag = '"' + dashboard.dashboardRevision + '"';
    if (req.headers["if-none-match"] === etag) {
      return reply.code(304).send();
    }
    reply.header("etag", etag);
    reply.header("cache-control", "private, no-store");
    return dashboard;
  });
}
