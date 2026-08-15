/**
 * Proactive inbox SSE（文档 16 §14.3：Assistant Delivery 的唯一交付通道）。
 *
 * GET /companion/deliveries/inbox/stream?after=<inboxSequence>
 * 事件流：id=inboxSequence、event=assistant.delivery、data=delivery JSON。
 * 断线重连从 Last-Event-ID 继续（durable inbox 语义）；过期项由服务端清理
 * （不在此端点复活）。capability：COMPANION_JOURNEY_V2 同开关。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { listInbox } from "./delivery-service.ts";

function isCompanionJourneyV2Enabled(): boolean {
  return process.env.COMPANION_JOURNEY_V2 === "true";
}

const inboxStreamQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
});

export async function proactiveInboxRoutes(app: FastifyInstance) {
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
  app.get<{ Querystring: { after?: string } }>(
    "/companion/deliveries/inbox/stream",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const query = inboxStreamQuerySchema.safeParse(req.query ?? {});
      if (!query.success) throw app.httpErrors.badRequest("inbox stream query 非法");
      // Last-Event-ID 语义：after query 缺失时 fallback 到 SSE 标准头
      // （断线重连不重放整个 inbox）。
      const headerLastEventId = typeof req.headers["last-event-id"] === "string"
        ? Number(req.headers["last-event-id"])
        : NaN;
      const afterSequence = query.data.after
        ?? (Number.isSafeInteger(headerLastEventId) && headerLastEventId >= 0 ? headerLastEventId : 0);
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };

      // fastify 5：先 hijack 再 writeHead——writeHead 抛 ERR_STREAM_WRITE_AFTER_END
      // 只会发生在客户端已断开、socket 已终结时；hijack 前调用会让框架在
      // handler 返回时自动终结流（16-remaining-issues #1 同模式防御）。
      reply.hijack();
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        req.log.warn("inbox sse: socket already closed before hijack");
        return reply;
      }
      try {
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
      } catch (err) {
        req.log.error({ err }, "inbox sse: writeHead failed");
        return reply;
      }
      let cursor = afterSequence;
      let closed = false;
      const interval = setInterval(async () => {
        if (closed) return;
        try {
          const deliveries = await withWorkspaceTransaction(scope, (tx) =>
            listInbox(tx, scope, { afterSequence: cursor, limit: 50 }),
          );
          for (const delivery of deliveries) {
            cursor = delivery.inboxSequence;
            if (!closed && !reply.raw.writableEnded) {
              reply.raw.write(
                `id: ${delivery.inboxSequence}\nevent: assistant.delivery\ndata: ${JSON.stringify(delivery)}\n\n`,
              );
            }
          }
        } catch (err) {
          clearInterval(interval);
          if (!closed && !reply.raw.writableEnded) reply.raw.end();
          req.log.warn({ err }, "proactive inbox stream error");
        }
      }, 3000);
      // PERF-B6 修复：加 15s heartbeat comment，防止 idle 长连接被代理/负载
      // 均衡空闲超时端到端切断（对齐 companion-events.ts 的保活写法）。
      const heartbeatTimer = setInterval(() => {
        if (!closed && !reply.raw.writableEnded) {
          reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
        }
      }, 15_000);
      heartbeatTimer.unref();
      interval.unref();
      reply.raw.on("close", () => {
        closed = true;
        clearInterval(interval);
        clearInterval(heartbeatTimer);
      });
      reply.raw.on("error", (err) => {
        closed = true;
        req.log.warn({ err }, "inbox sse: socket error");
      });
      return reply;
    },
  );
}
