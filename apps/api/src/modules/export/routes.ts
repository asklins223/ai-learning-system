import type { FastifyInstance } from "fastify";
import { requireSession, requireOwner } from "../identity/middleware.ts";
import { exportWorkspace, exportNoteMarkdown } from "./service.ts";
import { uuidParamSchema } from "../../lib/pagination.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { recordWorkspaceAudit } from "../audit/service.ts";

export async function exportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // GET /export/workspace — 导出整个 workspace 数据为 JSON
  // F-011: 导出是高危操作，仅 owner 可执行
  app.get("/export/workspace", { preHandler: [requireOwner] }, async (req, reply) => {
    // 审查附录 C：「导出目前是一个 owner-only 的 GET，未见审计写入」。留痕必须与
    // 这次导出**同事务**——所以这里先开事务，把 tx 交给导出，再写审计行。
    const data = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      async (tx) => {
        const payload = await exportWorkspace(req.session.workspaceId, req.session.userId, tx);
        await recordWorkspaceAudit(tx, {
          workspaceId: req.session.workspaceId,
          actorUserId: req.session.userId,
          action: "export.workspace",
          targetKind: "workspace",
          targetId: req.session.workspaceId,
          // 只记"导了多少"，不记内容：审计表不该成为第二个导出渠道。
          detail: {
            noteCount: (payload.notes ?? []).length,
            sourceCount: (payload.sources ?? []).length,
            bytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
            formatVersion: payload.exportManifest?.version ?? null,
          },
        });
        return payload;
      },
    );
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
