/**
 * 真桌宠记忆路由（22-real-desktop-pet-memory-context-prd-tdd.md §3.3/§13.2）。
 *
 * GET    /companion/memory                    — 列表 + 搜索 + 筛选
 * GET    /companion/memory/export             — 导出全部记忆 JSON
 * POST   /companion/memory                    — 手动新增
 * POST   /companion/memory/:id/confirm        — 确认候选
 * POST   /companion/memory/:id/reject         — 拒绝候选（soft delete）
 * POST   /companion/memory/:id/pin            — 固定
 * POST   /companion/memory/:id/unpin          — 取消固定（pin 为置 true，非 toggle）
 * POST   /companion/memory/:id/archive        — 归档
 * POST   /companion/memory/:id/restore        — 恢复
 * POST   /companion/memory/:id/dismiss        — 忽略（30 天不弹）
 * POST   /companion/memory/:id/correct        — 纠正（旧记忆 soft delete + 新候选）
 * DELETE /companion/memory/:id                — 删除记忆
 * DELETE /companion/memory                    — 一键清空（二次确认由前端保证）
 *
 * capability 门控：COMPANION_MEMORY_VECTOR_V1 或 COMPANION_JOURNEY_V2 开启时可用；
 * 否则 404 fail closed。与 canonical 学习事实解耦。
 */

import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { createJob } from "../job/service.ts";
import { companionMemoryCandidateTotal } from "../../lib/metrics.ts";
import {
  archiveMemory,
  clearMemories,
  confirmMemory,
  correctMemory,
  deleteMemory,
  dismissMemory,
  exportMemories,
  listMemories,
  listMemoryConflicts,
  pinMemory,
  resolveMemoryConflict,
  restoreMemory,
  unpinMemory,
  upsertMemory,
  type MemoryKindV2,
  type MemoryScopeV2,
  type MemorySourceTypeV2,
} from "./memory-service.ts";
import { getMemoryStarMap } from "./memory-star-map.ts";

function isMemoryContextEnabled(): boolean {
  return process.env.COMPANION_MEMORY_VECTOR_V1 === "true"
    || process.env.COMPANION_JOURNEY_V2 === "true";
}

const memoryParamsSchema = z.object({ id: z.string().uuid() });

const memoryKindSchema = z.enum([
  "preference",
  "goal",
  "learning_context",
  "interaction_note",
  "episodic",
]);

const listQuerySchema = z.object({
  kind: memoryKindSchema.optional(),
  q: z.string().min(1).max(200).optional(),
  scope: z.enum(["global", "workspace", "task"]).optional(),
  includeCandidates: z.coerce.boolean().optional().default(false),
  includeArchived: z.coerce.boolean().optional().default(false),
});

const createMemoryBodySchema = z.object({
  kind: memoryKindSchema,
  // §9.4/§25：写入端统一限制 ≤200 字。
  content: z.string().min(1).max(200),
  sourceEventId: z.string().min(1).max(240).optional(),
  sourceSessionId: z.string().uuid().optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  scope: z.enum(["global", "workspace", "task"]).optional(),
  sourceType: z.enum(["user_stated", "model_inferred", "confirmed", "summary"]).optional(),
  userStated: z.boolean().optional(),
  candidate: z.boolean().optional(),
});

const correctMemoryBodySchema = z.object({
  // §9.4/§25：写入端统一限制 ≤200 字。
  content: z.string().min(1).max(200),
  reason: z.string().min(1).max(500).optional(),
});

export async function memoryRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (_req, reply) => {
    if (!isMemoryContextEnabled()) {
            return reply.code(404).send({
        error: "companion_memory_context_disabled",
        message: "桌宠记忆与上下文当前未开放",
      });
    }
  });

  app.get(
    "/companion/memory/star-map",
    { preHandler: [requireSession] },
    async (req, reply) => {
      // §9.8：记忆星图独立 feature flag（2026-08-19 补齐——此前路由无门控，
      // 与"每个能力独立开关、fail-closed"的约定不符）。
      if (process.env.COMPANION_MEMORY_STAR_MAP_V1 !== "true") {
        return reply.code(404).send({
          error: "companion_memory_star_map_disabled",
          message: "记忆星图当前未开放",
        });
      }
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const result = await withWorkspaceTransaction(scope, (tx) => getMemoryStarMap(tx, scope));
      return reply.header("Cache-Control", "no-store").send(result);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/conversations/:id/summarize",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("conversationId 非法");
      if (process.env.COMPANION_SUMMARIZER_V1 !== "true") {
        return reply.code(404).send({ error: "companion_summarizer_disabled", message: "会话摘要当前未开放" });
      }
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const exists = await withWorkspaceTransaction(scope, async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          SELECT id FROM companion_conversations
          WHERE id = ${params.data.id} AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          LIMIT 1
        `);
        return rows.length > 0;
      });
      if (!exists) {
        return reply.code(404).send({ error: "conversation_not_found", message: "会话不存在" });
      }
      await createJob({
        type: "companion_summarizer",
        workspaceId: scope.workspaceId,
        requestedBy: scope.userId,
        payload: {
          conversationId: params.data.id,
          userId: scope.userId,
          sourceRunId: null,
        },
      });
      return reply.header("Cache-Control", "no-store").send({ version: 1, queued: true });
    },
  );

  app.get(
    "/companion/memory/conflicts",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const items = await withWorkspaceTransaction(scope, (tx) => listMemoryConflicts(tx, scope));
      return reply.header("Cache-Control", "no-store").send({ version: 1, items });
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/companion/memory/:id/resolve-conflict",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      const body = z.object({ removeId: z.string().uuid() }).safeParse(req.body ?? {});
      if (!params.success || !body.success) throw app.httpErrors.badRequest("resolve body 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const ok = await withWorkspaceTransaction(scope, (tx) =>
        resolveMemoryConflict(tx, scope, params.data.id, body.data.removeId),
      );
      if (!ok) {
        return reply.code(409).send({ error: "memory_conflict_resolution_failed", message: "冲突裁决失败" });
      }
      return reply.header("Cache-Control", "no-store").send({ version: 1, ok: true });
    },
  );

  app.get(
    "/companion/memory/export",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const result = await withWorkspaceTransaction(scope, (tx) => exportMemories(tx, scope));
      return reply.header("Cache-Control", "no-store").send(result);
    },
  );

  app.get<{ Querystring: Record<string, string | undefined> }>(
    "/companion/memory",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const query = listQuerySchema.safeParse(req.query ?? {});
      if (!query.success) throw app.httpErrors.badRequest("memory query 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const items = await withWorkspaceTransaction(scope, (tx) =>
        listMemories(tx, scope, {
          kind: query.data.kind as MemoryKindV2 | undefined,
          q: query.data.q,
          scope: query.data.scope as MemoryScopeV2 | undefined,
          includeCandidates: query.data.includeCandidates,
          includeArchived: query.data.includeArchived,
        }),
      );
      return reply.header("Cache-Control", "no-store").send({ version: 2, items });
    },
  );

  app.post<{ Body: unknown }>(
    "/companion/memory",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = createMemoryBodySchema.safeParse(req.body ?? {});
      if (!body.success) throw app.httpErrors.badRequest("memory body 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const item = await withWorkspaceTransaction(scope, (tx) =>
        upsertMemory(tx, scope, {
          kind: body.data.kind,
          content: body.data.content,
          sourceEventId: body.data.sourceEventId,
          sourceSessionId: body.data.sourceSessionId,
          importance: body.data.importance,
          confidence: body.data.confidence,
          scope: body.data.scope,
          sourceType: body.data.sourceType as MemorySourceTypeV2 | undefined,
          userStated: body.data.userStated ?? true,
          candidate: body.data.candidate ?? false,
        }),
      );
      // §9.9：记录候选创建指标
      try {
        companionMemoryCandidateTotal.labels("created").inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      // §13.8：确认后的记忆自动触发 embedding 重建（仅非候选记忆）
      if (!body.data.candidate && process.env.COMPANION_MEMORY_VECTOR_V1 === "true") {
        try {
          await createJob({
            type: "companion_memory_embedding_rebuild",
            workspaceId: scope.workspaceId,
            requestedBy: scope.userId,
            payload: { userId: scope.userId },
          });
        } catch {
          // embedding 重建入队失败不阻断主请求
        }
      }
      return reply.header("Cache-Control", "no-store").code(201).send(item);
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
      // §9.9：记录候选确认指标
      try {
        companionMemoryCandidateTotal.labels("confirmed").inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      // §13.8：确认后的记忆自动触发 embedding 重建
      if (process.env.COMPANION_MEMORY_VECTOR_V1 === "true") {
        try {
          await createJob({
            type: "companion_memory_embedding_rebuild",
            workspaceId: scope.workspaceId,
            requestedBy: scope.userId,
            payload: { userId: scope.userId },
          });
        } catch {
          // embedding 重建入队失败不阻断主请求
        }
      }
      // §10.5 关系状态：每次确认记忆 familiarity +0.03（上限 1）。
      // 独立事务 + 失败静默：关系状态是弱事实，不影响确认主链路。
      try {
        await withWorkspaceTransaction(scope, async (tx) => {
          await tx.execute(sql`
            UPDATE pet_profiles
            SET familiarity = LEAST(familiarity + 0.03, 1), updated_at = now()
            WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          `);
        });
      } catch {
        // 无人格档案行 / 权限缺失时静默跳过
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
      // §9.9：记录候选拒绝指标（reject 路由）
      try {
        companionMemoryCandidateTotal.labels("rejected").inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/pin",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const item = await withWorkspaceTransaction(scope, (tx) =>
        pinMemory(tx, scope, params.data.id),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  // pin 端点只置 pinned=true（非 toggle）；取消固定走独立 unpin 端点。
  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/unpin",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const item = await withWorkspaceTransaction(scope, (tx) =>
        unpinMemory(tx, scope, params.data.id),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/archive",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const item = await withWorkspaceTransaction(scope, (tx) =>
        archiveMemory(tx, scope, params.data.id),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/restore",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const item = await withWorkspaceTransaction(scope, (tx) =>
        restoreMemory(tx, scope, params.data.id),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/companion/memory/:id/dismiss",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("memoryId 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const item = await withWorkspaceTransaction(scope, (tx) =>
        dismissMemory(tx, scope, params.data.id),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/companion/memory/:id/correct",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = memoryParamsSchema.safeParse(req.params);
      const body = correctMemoryBodySchema.safeParse(req.body ?? {});
      if (!params.success || !body.success) throw app.httpErrors.badRequest("correct body 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const item = await withWorkspaceTransaction(scope, (tx) =>
        correctMemory(tx, scope, params.data.id, body.data),
      );
      if (!item) {
        return reply.code(404).send({ error: "memory_not_found", message: "记忆不存在" });
      }
      return reply.header("Cache-Control", "no-store").send(item);
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
      // §9.9：记录候选删除指标（delete 路由）
      try {
        companionMemoryCandidateTotal.labels("deleted").inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      return reply.code(204).send();
    },
  );

  app.delete(
    "/companion/memory",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const deletedCount = await withWorkspaceTransaction(scope, (tx) =>
        clearMemories(tx, scope),
      );
      return reply.header("Cache-Control", "no-store").send({ deletedCount });
    },
  );

  app.post(
    "/companion/memory/rebuild-embeddings",
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (process.env.COMPANION_MEMORY_VECTOR_V1 !== "true") {
        return reply.code(404).send({ error: "companion_memory_vector_disabled", message: "向量记忆当前未开放" });
      }
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      await createJob({
        type: "companion_memory_embedding_rebuild",
        workspaceId: scope.workspaceId,
        requestedBy: scope.userId,
        payload: { userId: scope.userId },
      });
      return reply.header("Cache-Control", "no-store").send({ version: 1, queued: true });
    },
  );
}
