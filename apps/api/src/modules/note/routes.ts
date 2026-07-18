import type { FastifyInstance } from "fastify";
import { noteCreateSchema, noteUpdateSchema } from "./schema.ts";
import {
  createNote,
  getNoteWithVersion,
  listNotes,
  updateNote,
  deleteNote,
  listNoteVersions,
  RevisionConflictError,
} from "./service.ts";
import { requireSession } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import { parseQuery, paginationQuerySchema, uuidParamSchema } from "../../lib/pagination.ts";

export async function noteRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/notes", async (req) => {
    // R-022: 统一 Zod 校验，非法参数返回 400 而非 NaN 进入查询
    const q = parseQuery(app, paginationQuerySchema, req.query);
    const result = await listNotes(req.session.workspaceId, {
      cursor: q.cursor,
      limit: q.limit,
    });
    return result;
  });

  app.post("/notes", async (req) => {
    const body = parseBody(app, noteCreateSchema, req.body);
    const result = await createNote(req.session.workspaceId, req.session.userId, body);
    return {
      note: result?.note,
      version: result?.version,
      blocks: result?.blocks,
    };
  });

  app.get<{ Params: { id: string } }>("/notes/:id", async (req, reply) => {
    // R-022: UUID 路径参数校验
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const result = await getNoteWithVersion(req.params.id, req.session.workspaceId);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  app.patch<{ Params: { id: string } }>("/notes/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const body = parseBody(app, noteUpdateSchema, req.body);
    try {
      const result = await updateNote(
        req.params.id,
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      if (!result) return reply.code(404).send({ error: "not found" });
      return result;
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        return reply.code(409).send({
          error: "revision_conflict",
          currentVersionId: err.currentVersionId,
          message: "内容已被改动，请刷新后重试",
        });
      }
      // R-008: 捕获唯一约束冲突（并发版本号碰撞），返回 409 而非 500
      if (err && typeof err === "object" && "code" in err && err.code === "23505") {
        return reply.code(409).send({
          error: "revision_conflict",
          message: "版本冲突，请刷新后重试",
        });
      }
      throw err;
    }
  });

  // DELETE /notes/:id — 删除笔记（级联删除 versions + blocks）
  app.delete<{ Params: { id: string } }>("/notes/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const result = await deleteNote(req.params.id, req.session.workspaceId);
    if (!result) return reply.code(404).send({ error: "not found" });
    return reply.code(204).send();
  });

  // §2.5: GET /notes/:id/versions — 笔记版本历史列表（不含 blocks 详情）
  app.get<{ Params: { id: string } }>("/notes/:id/versions", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const versions = await listNoteVersions(req.params.id, req.session.workspaceId);
    if (!versions) return reply.code(404).send({ error: "not found" });
    return { items: versions };
  });

}
