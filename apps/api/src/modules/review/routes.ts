import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { listReviews, completeReview, dismissReview } from "./service.ts";
import { parseQuery, uuidParamSchema } from "../../lib/pagination.ts";

const reviewQuerySchema = z.object({
  status: z.enum(["pending", "accepted", "completed", "dismissed", "superseded", "cancelled"]).optional(),
  includeAll: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

export async function reviewRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // GET /reviews                — 默认只返回到期的 pending（今日复习队列）
  // GET /reviews?status=pending — 同上
  // GET /reviews?status=dismissed|completed|... — 返回该状态全部（不过滤到期）
  // GET /reviews?includeAll=true — 返回该 workspace 全部复习
  // R-022: 统一 Zod 校验
  app.get<{ Querystring: { status?: string; includeAll?: string } }>(
    "/reviews",
    async (req) => {
      const q = parseQuery(app, reviewQuerySchema, req.query);
      const includeAll = q.includeAll === "true";
      return listReviews(req.session.workspaceId, {
        status: q.status,
        includeAll,
        limit: q.limit,
        offset: q.offset,
      }, req.session.userId);
    },
  );

  app.post<{ Params: { id: string } }>("/reviews/:id/complete", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const result = await completeReview(
      req.params.id,
      req.session.workspaceId,
      req.session.userId,
    );
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  app.post<{ Params: { id: string } }>("/reviews/:id/dismiss", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const result = await dismissReview(req.params.id, req.session.workspaceId, req.session.userId);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });
}
