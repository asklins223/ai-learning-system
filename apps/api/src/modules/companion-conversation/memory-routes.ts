/**
 * 分层记忆路由（文档 16 §10.3：有来源、可审计、可删除）。
 *
 * GET    /companion/memory              — 列出（默认不含 candidate；可 includeCandidates）
 * POST   /companion/memory/:id/confirm  — 候选 → 确认（参与主动策略）
 * POST   /companion/memory/:id/reject   — 拒绝候选（soft delete，审计保留）
 * DELETE /companion/memory/:id          — 删除记忆（soft delete；canonical 学习事实不受影响）
 *
 * capability 门控：COMPANION_JOURNEY_V2=true；否则 404 fail closed。
 * 与 canonical 学习事实解耦：记忆删除绝不回滚已提交的学习事实或 schedule。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { confirmMemory, deleteMemory, listMemories } from "./memory-service.ts";

function isCompanionJourneyV2Enabled(): boolean {
  return process.env.COMPANION_JOURNEY_V2 === "true";
}

const memoryParamsSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  kind: z.enum(["preference", "goal", "learning_context", "interaction_note"]).optional(),
  includeCandidates: z.coerce.boolean().optional().default(false),
});

export async function memoryRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (!isCompanionJourneyV2Enabled()) {
      void req;
      return reply.code(404).send({
        error: "companion_journey_v2_disabled",
        message: "新手旅程当前未开放",
      });
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/companion/memory",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const query = listQuerySchema.safeParse(req.query ?? {});
      if (!query.success) throw app.httpErrors.badRequest("memory query 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const items = await withWorkspaceTransaction(scope, (tx) =>
        listMemories(tx, scope, {
          kind: query.data.kind,
          includeCandidates: query.data.includeCandidates,
        }),
      );
      return reply.header("Cache-Control", "no-store").send({ version: 1, items });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/confirm",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const item = await withWorkspaceTransaction(scope, (tx) =>
        confirmMemory(tx, scope, params.data.id),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/reject",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const deleted = await withWorkspaceTransaction(scope, (tx) =>
        deleteMemory(tx, scope, params.data.id),
      );
      if (!deleted) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/companion/memory/:id",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const deleted = await withWorkspaceTransaction(scope, (tx) =>
        deleteMemory(tx, scope, params.data.id),
      );
      if (!deleted) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.code(204).send();
    },
  );
}
