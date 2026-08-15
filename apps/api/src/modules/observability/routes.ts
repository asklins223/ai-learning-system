/**
 * 方案 16 §20：学习漏斗指标只读端点。
 *
 * GET /metrics/learning-events?eventType=&from=&limit=
 * - 只读、RLS 内、limit 上限 500（防客户端放大）；
 * - 不做任何聚合/导出（dashboard 消费原始事件，聚合语义见
 *   observability/metrics-schema.ts 的纯函数）。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { listLearningMetrics, type LearningMetricEventType } from "./learning-metrics.ts";

const METRIC_EVENT_TYPES = [
  "run_created",
  "task_presented",
  "artifact_locked",
  "action",
  "run_result",
] as const;

const listQuerySchema = z.object({
  eventType: z.enum(METRIC_EVENT_TYPES).optional(),
  from: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function learningMetricRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/metrics/learning-events",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const query = listQuerySchema.safeParse(req.query ?? {});
      if (!query.success) {
        return reply.code(400).send({ error: "bad_request", message: "metric query 非法" });
      }
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const items = await listLearningMetrics(scope, {
        eventType: query.data.eventType as LearningMetricEventType | undefined,
        from: query.data.from,
        limit: query.data.limit,
      });
      return reply.header("Cache-Control", "no-store").send({ version: 1, items });
    },
  );
}
