import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import {
  sourceCreateSchema,
  sourceUpdateSchema,
  sourceListQuerySchema,
  sourceStatusBatchSchema,
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
  listSourceStatuses,
} from "./service.ts";

export async function sourceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // POST /sources — 创建来源
  app.post("/sources", async (req) => {
    const body = parseBody(app, sourceCreateSchema, req.body);
    return createSource(req.session.workspaceId, req.session.userId, body);
  });

  // GET /sources — 列表（支持 status 筛选 + cursor/limit 分页）
  // R-022: 校验失败返回 400，不再静默退回默认全量
  app.get("/sources", async (req) => {
    const opts = parseQuery(app, sourceListQuerySchema, req.query);
    return listSources(req.session.workspaceId, opts);
  });

  // POST /sources/statuses — 批量刷新当前页面已加载来源的异步状态。
  // 使用 body 避免大量 UUID 塞入 query string，并限制为单批最多 100 条。
  app.post("/sources/statuses", async (req) => {
    const body = parseBody(app, sourceStatusBatchSchema, req.body);
    return { items: await listSourceStatuses(req.session.workspaceId, body.ids) };
  });

  // GET /sources/:id — 详情（含 segments）
  app.get<{ Params: { id: string } }>("/sources/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const result = await getSource(req.params.id, req.session.workspaceId);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  // PATCH /sources/:id — 更新标题/状态
  app.patch<{ Params: { id: string } }>("/sources/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const body = parseBody(app, sourceUpdateSchema, req.body);
    const result = await updateSource(req.params.id, req.session.workspaceId, body);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  // DELETE /sources/:id — 软删除（status → archived）
  app.delete<{ Params: { id: string } }>("/sources/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const result = await deleteSource(req.params.id, req.session.workspaceId);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  // POST /sources/:id/create-note — 从来源创建笔记草稿
  app.post<{ Params: { id: string } }>("/sources/:id/create-note", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const result = await createNoteFromSource(
      req.params.id,
      req.session.workspaceId,
      req.session.userId,
    );
    if (!result) return reply.code(404).send({ error: "not found" });
    if ("error" in result) {
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

  // §2.7: GET /sources/:id/notes — 从此来源创建的笔记列表
  app.get<{ Params: { id: string } }>("/sources/:id/notes", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const result = await listNotesBySource(req.params.id, req.session.workspaceId);
    if (!result) return reply.code(404).send({ error: "not found" });
    return { items: result };
  });
}
