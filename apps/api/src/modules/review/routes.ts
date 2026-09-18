import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { deferReviewSchedule } from "./review-defer-service.ts";
import { listSanitizedReviews, projectReviewQueueV2, ReviewQueueProjectionError } from "./service.ts";
import { reviewDeferRequestV2Schema } from "@ailearn/shared";
import { paginationQuerySchema } from "../../lib/pagination.ts";

export async function reviewRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // Member V2 queue: the desktop client consumes only the strict sanitized
  // identity/startability projection. 分页沿用 R-019 的 (nextReviewAt, id)
  // 复合 cursor：到期队列会在两次翻页之间被复习完成或延后改变长度，offset
  // 翻页会因此静默漏项。
  app.get<{ Querystring: { cursor?: string; limit?: string } }>(
    "/reviews/v2/queue",
    async (req, reply) => {
      const parsedQuery = paginationQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return reply.code(400).send({ error: "validation", message: "分页参数非法" });
      }
      const { cursor, limit } = parsedQuery.data;
      try {
        const sanitized = await withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          (tx) => listSanitizedReviews(req.session.workspaceId, {
            status: "pending",
            limit: limit ?? 50,
            ...(cursor ? { cursor } : {}),
          }, req.session.userId, tx),
        );
        const queue = projectReviewQueueV2(sanitized);
        return reply.header("Cache-Control", "private, no-store").send(queue);
      } catch (error) {
        if (error instanceof ReviewQueueProjectionError) {
          return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  // 方案 16 §18.1：展示层延后——只写 user_deferred_until，到期队列在延后期内
  // 不再返回这张卡；official nextReviewAt 与 schedule 均不变。
  app.post("/reviews/v2/defer", async (req, reply) => {
    const parsed = reviewDeferRequestV2Schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", message: "延后请求参数非法" });
    }
    const outcome = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (tx) => deferReviewSchedule(
        tx,
        { workspaceId: req.session.workspaceId, userId: req.session.userId },
        {
          scheduleId: parsed.data.scheduleId,
          scheduleGeneration: parsed.data.scheduleGeneration,
          deferredUntil: new Date(parsed.data.deferredUntil),
          reasonCode: parsed.data.reasonCode,
        },
      ),
    );
    if (outcome.status === "not_found") {
      return reply.code(404).send({ error: "not_found", message: "复习排期不存在" });
    }
    if (outcome.status === "stale") {
      return reply.code(409).send({ error: "conflict", message: "这张卡的状态已变化，请刷新队列" });
    }
    return reply.header("Cache-Control", "private, no-store").send({
      version: 2 as const,
      scheduleId: outcome.scheduleId,
      scheduleGeneration: outcome.generation,
      userDeferredUntil: outcome.userDeferredUntil,
      officialNextReviewAt: outcome.officialNextReviewAt,
    });
  });

}
