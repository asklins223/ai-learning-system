import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { getUnderstandingGraph, getUnderstandingStates } from "./service.ts";
import { parseQuery } from "../../lib/pagination.ts";

const understandingQuerySchema = z.object({
  state: z.enum(["unseen", "seen", "preliminary_understood", "reviewed", "misunderstood", "due_review"]).optional(),
});

export async function understandingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // GET /understanding/states — 聚合理解状态列表
  app.get("/understanding/states", async (req) => {
    // R-022: 统一 Zod 校验
    const q = parseQuery(app, understandingQuerySchema, req.query);
    // R-006: 按 userId 隔离，成员只能看到自己的理解状态
    const items = await getUnderstandingStates(req.session.workspaceId, {
      state: q.state,
    }, req.session.userId);
    return { items };
  });

  // GET /graph — 真实来源血缘与学习对象关系图。
  app.get("/graph", async (req) => {
    return getUnderstandingGraph(req.session.workspaceId, req.session.userId);
  });
}
