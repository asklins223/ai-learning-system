import type { FastifyInstance } from "fastify";
import { requireSession, requireOwner } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { parseBody } from "../../lib/validate.ts";
import {
  sourceCreateSchema,
  sourceUpdateSchema,
  sourceListQuerySchema,
} from "./schema.ts";
import { parseQuery, uuidParamSchema } from "../../lib/pagination.ts";
import {
  createSource,
  listSources,
  getSource,
  updateSource,
  deleteSource,
  createNoteFromSource,
  listNotesBySource,
} from "./service.ts";

export async function sourceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // POST /sources — 创建来源
  // RBAC: 仅 owner 可创建来源
  app.post("/sources", { preHandler: [requireOwner] }, async (req) => {
    const body = parseBody(app, sourceCreateSchema, req.body);
    return withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => createSource(
        transaction,
        req.session.workspaceId,
        req.session.userId,
        body,
      ),
    );
  });

  // GET /sources — 列表（支持 status 筛选 + cursor/limit 分页）
  // R-022: 校验失败返回 400，不再静默退回默认全量
  app.get("/sources", async (req) => {
    const opts = parseQuery(app, sourceListQuerySchema, req.query);
    return withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => listSources(transaction, req.session.workspaceId, { ...opts, userId: req.session.userId }),
    );
  });

  // POST /sources/statuses 已删除：桌面端的解析状态轮询走 source.list，该批量接口
  // 没有任何运行时调用方，按 AGENTS.md 不保留无调用方的服务端链路。

  // GET /sources/:id — 详情（含 segments）
  app.get<{ Params: { id: string } }>("/sources/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const result = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => getSource(transaction, req.params.id, req.session.workspaceId),
    );
    if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    return result;
  });

  // PATCH /sources/:id — 更新标题/状态
  // RBAC: 仅 owner 可更新来源
  app.patch<{ Params: { id: string } }>("/sources/:id", { preHandler: [requireOwner] }, async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const body = parseBody(app, sourceUpdateSchema, req.body);
    const result = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => updateSource(
        transaction,
        req.params.id,
        req.session.workspaceId,
        body,
      ),
    );
    if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    return result;
  });

  // DELETE /sources/:id — 软删除（status → archived）
  // RBAC: 仅 owner 可删除来源
  app.delete<{ Params: { id: string } }>("/sources/:id", { preHandler: [requireOwner] }, async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const result = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => deleteSource(transaction, req.params.id, req.session.workspaceId),
    );
    if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    // 2026-08-11：契约统一——软删除返回 204（与 DELETE /notes/:id 一致）
    return reply.code(204).send();
  });

  // POST /sources/:id/create-note — 从来源创建笔记草稿
  // ?force=true 时跳过内容去重检查（用户已确认要再创建一篇）
  // RBAC: 仅 owner 可从来源创建笔记
  app.post<{ Params: { id: string }; Querystring: { force?: string } }>("/sources/:id/create-note", { preHandler: [requireOwner] }, async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const force = req.query?.force === "true";
    const result = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => createNoteFromSource(
        transaction,
        req.params.id,
        req.session.workspaceId,
        req.session.userId,
        { force },
      ),
    );
    if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    if ("error" in result) {
      if (result.error === "duplicate_content") {
        return reply.code(409).send({
          error: result.error,
          message: "该来源已创建过内容相同的笔记，是否仍要再创建一篇？",
          existingNoteId: result.existingNoteId,
          existingNoteTitle: result.existingNoteTitle,
        });
      }
      const status = result.error === "source_not_ready" ? 409 : 400;
      return reply.code(status).send({
        error: result.error,
        message:
          result.error === "source_not_ready"
            ? "来源尚未解析完成，请等待状态变为就绪"
            : "该来源没有可引用的片段，请先粘贴正文内容",
      });
    }
    return result;
  });

  // GET /sources/:id/notes — 从此来源创建的笔记列表（最近 50 篇 + 真实总数）
  app.get<{ Params: { id: string } }>("/sources/:id/notes", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const result = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      (transaction) => listNotesBySource(transaction, req.params.id, req.session.workspaceId, req.session.userId),
    );
    if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    return { items: result.items, total: result.total };
  });
}
