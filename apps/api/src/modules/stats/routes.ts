import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { getStatsOverview } from "./service.ts";

export async function statsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/stats/overview", async (req) => {
    // R-006: 按 userId 隔离，成员只能看到自己的验证和复习统计
    const overview = await getStatsOverview(req.session.workspaceId, req.session.userId);
    return overview;
  });
}
