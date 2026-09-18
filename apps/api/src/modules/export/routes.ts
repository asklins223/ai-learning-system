import type { FastifyInstance } from "fastify";
import { requireSession, requireOwner } from "../identity/middleware.ts";
import { exportWorkspace, exportNoteMarkdown } from "./service.ts";
import { uuidParamSchema } from "../../lib/pagination.ts";

export async function exportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // GET /export/workspace — 导出整个 workspace 数据为 JSON
  // F-011: 导出是高危操作，仅 owner 可执行
  app.get("/export/workspace", { preHandler: [requireOwner] }, async (req, reply) => {
    const data = await exportWorkspace(req.session.workspaceId, req.session.userId);
    reply.header("Content-Type", "application/json");
    reply.header("Content-Disposition", `attachment; filename="workspace-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return data;
  });

  // GET /export/notes/:id — 导出单篇笔记为 Markdown
  app.get<{ Params: { id: string } }>("/export/notes/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const markdown = await exportNoteMarkdown(req.params.id, req.session.workspaceId, req.session.userId);
    if (!markdown) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="note-${req.params.id}.md"`);
    return markdown;
  });
}
