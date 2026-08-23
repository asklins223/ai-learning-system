/**
 * Plan 23 W3-06：Dashboard route + ETag。
 * GET /v2/learning-dashboard —— private 缓存语义（user-scoped personal state）；
 * Cache-Control 用 `private, no-cache`：仍强制每次与服务器协商（发条件请求），
 * 但允许 If-None-Match → 304 复用；no-store 会禁用条件请求，使 ETag 形同虚设。
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
    // no-cache（而非 no-store）：每次协商，但 304 可达；dashboardRevision
    // 只哈希稳定内容（见 service.ts），内容不变时返回 304。
    reply.header("cache-control", "private, no-cache");
    return dashboard;
  });
}
