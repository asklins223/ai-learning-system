import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession, requireOwner } from "../identity/middleware.ts";
import { exportWorkspace, restoreWorkspace, exportNoteMarkdown } from "./service.ts";
import { parseBody } from "../../lib/validate.ts";

export async function exportRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // GET /export/workspace — 导出整个 workspace 数据为 JSON
  // F-011: 导出是高危操作，仅 owner 可执行
  app.get("/export/workspace", { preHandler: [requireOwner] }, async (req, reply) => {
    const data = await exportWorkspace(req.session.workspaceId);
    reply.header("Content-Type", "application/json");
    reply.header("Content-Disposition", `attachment; filename="workspace-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return data;
  });

  // N-009: POST /export/workspace/restore — 从导出的 JSON 恢复 workspace 数据
  // 仅 owner 可执行，支持 dry-run 模式预检验
  const restoreSchema = z.object({
    workspace: z.record(z.unknown()).optional(),
    exportManifest: z.record(z.unknown()).optional(),
    users: z.array(z.record(z.unknown())).optional(),
    workspaceMembers: z.array(z.record(z.unknown())).optional(),
    notes: z.array(z.record(z.unknown())).optional(),
    noteVersions: z.array(z.record(z.unknown())).optional(),
    noteBlocks: z.array(z.record(z.unknown())).optional(),
    sources: z.array(z.record(z.unknown())).optional(),
    sourceSegments: z.array(z.record(z.unknown())).optional(),
    learningCards: z.array(z.record(z.unknown())).optional(),
    cardKeyPoints: z.array(z.record(z.unknown())).optional(),
    evidences: z.array(z.record(z.unknown())).optional(),
    evidenceOverrides: z.array(z.record(z.unknown())).optional(),
    validationQuestions: z.array(z.record(z.unknown())).optional(),
    validationEvents: z.array(z.record(z.unknown())).optional(),
    reviewSchedules: z.array(z.record(z.unknown())).optional(),
    understandingEvents: z.array(z.record(z.unknown())).optional(),
    aiArtifacts: z.array(z.record(z.unknown())).optional(),
    dryRun: z.boolean().optional().default(false),
  });

  app.post("/export/workspace/restore", { preHandler: [requireOwner] }, async (req, reply) => {
    const body = parseBody(app, restoreSchema, req.body);
    const { dryRun, ...data } = body;
    const result = await restoreWorkspace(req.session.workspaceId, data, dryRun);
    if (!result.success) {
      return reply.code(409).send({ error: result.message });
    }
    return result;
  });

  // GET /export/notes/:id — 导出单篇笔记为 Markdown
  app.get<{ Params: { id: string } }>("/export/notes/:id", async (req, reply) => {
    const markdown = await exportNoteMarkdown(req.params.id, req.session.workspaceId);
    if (!markdown) return reply.code(404).send({ error: "not found" });
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="note-${req.params.id}.md"`);
    return markdown;
  });
}
