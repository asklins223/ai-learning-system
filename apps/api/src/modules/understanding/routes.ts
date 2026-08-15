import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { getUnderstandingStates } from "./service.ts";
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
  // 2026-08-14（星图切流收口）：旧 GET /graph reader 已删除——graph 页主渲染
  // 数据源为 UnderstandingProjectionV2（star_map_action_v1）；旧 reader 的
  // getUnderstandingGraph/buildUnderstandingGraphDto 同步移除（§11.4）。
}
