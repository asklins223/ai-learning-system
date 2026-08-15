/**
 * Bridge context 路由（文档 16 §14.2）。
 *
 * POST   /companion/bridge/contexts          服务端 hydration 签发
 * POST   /companion/bridge/contexts/:id/renew CAS 续租（§14.2 每 10 秒续租）
 * DELETE /companion/bridge/contexts/:id      revoke（CAS）
 *
 * capability 门控：COMPANION_BRIDGE_V2=true 时开放；否则 404 fail closed。
 * renderer 提交的输入经 mainPageContextInputV2Schema strict 校验；安全字段
 * （account/workspace/user）来自 requireSession，绝不从请求体读取。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../lib/validate.ts";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { mainPageContextInputV2Schema } from "@ailearn/shared";
import {
  publishContext,
  renewContext,
  revokeContext,
} from "./context-service.ts";
import { ContextHydrationError } from "./context-hydration.ts";

function isCompanionBridgeV2Enabled(): boolean {
  return process.env.COMPANION_BRIDGE_V2 === "true";
}

const publishBodySchema = z.object({
  contextId: z.string().uuid(),
  deviceSessionId: z.string().min(1).max(200),
  pageInstanceId: z.string().min(1).max(200),
  accountSessionId: z.string().min(1).max(200),
  page: mainPageContextInputV2Schema,
});

const renewBodySchema = z.object({
  contextId: z.string().uuid(),
  pageInstanceId: z.string().min(1).max(200),
  expectedRevision: z.string().min(1).max(200),
});

export async function companionBridgeRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (!isCompanionBridgeV2Enabled()) {
      void req;
      return reply.code(404).send({
        error: "companion_bridge_v2_disabled",
        message: "伴星上下文桥当前未开放",
      });
    }
  });

  app.post("/companion/bridge/contexts", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, publishBodySchema, req.body);
    const now = new Date();
    try {
      const snapshot = await withWorkspaceTransaction(
        { workspaceId: req.session.workspaceId, userId: req.session.userId },
        (tx) => publishContext(tx, {
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
        }, {
          contextId: body.contextId,
          accountSessionId: body.accountSessionId,
          deviceSessionId: body.deviceSessionId,
          pageInstanceId: body.pageInstanceId,
          page: body.page,
          now,
        }),
      );
      return reply.code(201).header("Cache-Control", "no-store").send(snapshot);
    } catch (err) {
      if (err instanceof ContextHydrationError) {
        return reply.code(409).send({ error: "context_stale", message: err.message });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>(
    "/companion/bridge/contexts/:id/renew",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = parseBody(app, renewBodySchema, req.body);
      try {
        const renewed = await withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          (tx) => renewContext(tx, {
            workspaceId: req.session.workspaceId,
            userId: req.session.userId,
          }, {
            contextId: body.contextId,
            pageInstanceId: body.pageInstanceId,
            expectedRevision: body.expectedRevision,
            now: new Date(),
          }),
        );
        if (renewed === null) {
          return reply.code(404).send({ error: "context_not_found", message: "页面上下文不存在或已撤销" });
        }
        return reply.header("Cache-Control", "no-store").send(renewed);
      } catch (err) {
        if (err instanceof ContextHydrationError) {
          return reply.code(409).send({ error: "context_stale", message: err.message });
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/companion/bridge/contexts/:id",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = parseBody(app, renewBodySchema, req.body);
      try {
        await withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          (tx) => revokeContext(tx, {
            workspaceId: req.session.workspaceId,
            userId: req.session.userId,
          }, {
            contextId: body.contextId,
            pageInstanceId: body.pageInstanceId,
            expectedRevision: body.expectedRevision,
            now: new Date(),
          }),
        );
        return reply.code(204).header("Cache-Control", "no-store").send();
      } catch (err) {
        if (err instanceof ContextHydrationError) {
          return reply.code(409).send({ error: "context_stale", message: err.message });
        }
        throw err;
      }
    },
  );
}
