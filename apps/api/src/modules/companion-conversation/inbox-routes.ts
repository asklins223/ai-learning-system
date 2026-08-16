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
import { safeSseWrite } from "../../lib/safe-sse-write.ts";
import { listInbox } from "./delivery-service.ts";
import { subscribeCompanionInboxEvents } from "./companion-notify.ts";

// ─── 连接限制（对齐 companion-events.ts 的每用户槽位模式）────────────────
// 部署标注同 companion-events：连接计数为单进程内存态；多实例部署时每实例可
// 各自打满上限，上线多实例前需换共享存储（Redis/Postgres）。
const SLOTS_PER_INBOX_USER = 5;
const inboxUserSlots = new Map<string, number>();

function acquireInboxSlot(key: string): boolean {
  const count = inboxUserSlots.get(key) ?? 0;
  if (count >= SLOTS_PER_INBOX_USER) return false;
  inboxUserSlots.set(key, count + 1);
  return true;
}

function releaseInboxSlot(key: string): void {
  const count = inboxUserSlots.get(key) ?? 0;
  if (count <= 1) inboxUserSlots.delete(key);
  else inboxUserSlots.set(key, count - 1);
}

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
      const slotKey = `${scope.userId}:${scope.workspaceId}`;
      if (!acquireInboxSlot(slotKey)) {
        return reply.code(429).send({
          error: "too_many_connections",
          message: "inbox stream connection limit reached",
        });
      }
      let slotReleased = false;
      const releaseSlot = (): void => {
        if (slotReleased) return;
        slotReleased = true;
        releaseInboxSlot(slotKey);
      };

      // fastify 5：先 hijack 再 writeHead——writeHead 抛 ERR_STREAM_WRITE_AFTER_END
      // 只会发生在客户端已断开、socket 已终结时；hijack 前调用会让框架在
      // handler 返回时自动终结流（16-remaining-issues #1 同模式防御）。
      reply.hijack();
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        req.log.warn("inbox sse: socket already closed before hijack");
        releaseSlot();
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
        releaseSlot();
        return reply;
      }
      let cursor = afterSequence;
      let closed = false;
      // PERF: in-flight guard——上一次轮询事务未结束时跳过本 tick，避免 DB 拥塞
      // 下同连接并发事务叠加放大负载。
      let pumping = false;
      // PERF: NOTIFY 是即时唤醒主路径（deliver() 随事务 NOTIFY inbox 通道），
      // durable poll 仅作兜底（防通知丢失/重启间隙）。为减少 idle 长连接每
      // 3s 全量开事务的背景负载：NOTIFY 唤醒时立即 pump，durable poll 放宽为
      // 只在最近一次 NOTIFY 驱动的 pump 结束后较长间隔再跑一次（仍保留 fallback）。
      let lastWakeAt = 0;
      let interval: ReturnType<typeof setInterval> | null = null;
      const pump = async (): Promise<void> => {
        if (closed || pumping) return;
        pumping = true;
        lastWakeAt = Date.now();
        try {
          const deliveries = await withWorkspaceTransaction(scope, (tx) =>
            listInbox(tx, scope, { afterSequence: cursor, limit: 50 }),
          );
          for (const delivery of deliveries) {
            cursor = delivery.inboxSequence;
            if (!closed) {
              safeSseWrite(
                reply.raw,
                `id: ${delivery.inboxSequence}\nevent: assistant.delivery\ndata: ${JSON.stringify(delivery)}\n\n`,
              );
            }
          }
        } catch (err) {
          if (interval) clearInterval(interval);
          if (!closed && !reply.raw.writableEnded) reply.raw.end();
          req.log.warn({ err }, "proactive inbox stream error");
        } finally {
          pumping = false;
        }
      };
      const unsubscribeInbox = subscribeCompanionInboxEvents(scope.userId, () => {
        if (!closed) void pump();
      });
      // durable fallback 轮询：NOTIFY 已在提交时即时唤醒，这里仅兜底错过通知/
      // 重启间隙，间隔放宽到 10s 显著降低 idle 长连接群的事务频率。
      interval = setInterval(() => {
        if (closed || pumping) return;
        // NOTIFY 驱动 pump 刚结束不久时跳过冗余轮询（其已拉取到最新数据）。
        if (Date.now() - lastWakeAt < 8_000) return;
        void pump();
      }, 10_000);
      // PERF-B6 修复：加 15s heartbeat comment，防止 idle 长连接被代理/负载
      // 均衡空闲超时端到端切断（对齐 companion-events.ts 的保活写法）。
      const heartbeatTimer = setInterval(() => {
        if (!closed) {
          safeSseWrite(reply.raw, `: heartbeat ${Date.now()}\n\n`);
        }
      }, 15_000);
      heartbeatTimer.unref();
      interval.unref();
      // 连接打开即做首次拉取（避免依赖首个 NOTIFY/等待轮询）。
      void pump();
      reply.raw.on("close", () => {
        closed = true;
        clearInterval(interval);
        clearInterval(heartbeatTimer);
        unsubscribeInbox();
        releaseSlot();
      });
      reply.raw.on("error", (err) => {
        closed = true;
        unsubscribeInbox();
        req.log.warn({ err }, "inbox sse: socket error");
        releaseSlot();
      });
      return reply;
    },
  );
}
