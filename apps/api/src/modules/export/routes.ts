import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession, requireOwner } from "../identity/middleware.ts";
import { exportWorkspace, restoreWorkspace, exportNoteMarkdown } from "./service.ts";
import { parseBody } from "../../lib/validate.ts";
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
    reviewAttempts: z.array(z.record(z.unknown())).optional(),
    understandingEvents: z.array(z.record(z.unknown())).optional(),
    aiArtifacts: z.array(z.record(z.unknown())).optional(),
    onboardingStates: z.array(z.record(z.unknown())).optional(),
    // N#8-2: v0.6 可信掌握闭环 8 张新表。导出侧 exportManifest.included(service.ts:772-801) 明确包含这
    // 8 表、恢复写路径 restoreTable(service.ts:1453-1615) 也逐一处理。若此处未声明，zod 默认 strip
    // 会静默剥离这些键 → 恢复时被跳过 → 数据丢失。逐一显式声明，与导出侧保持同一类型
    // （z.record(z.unknown()) 同型），并靠下方 dry-run 差集告警防止未来再漂移。
    validationQuestionRubricItems: z.array(z.record(z.unknown())).optional(),
    validationSubmissions: z.array(z.record(z.unknown())).optional(),
    validationSubmissionJobs: z.array(z.record(z.unknown())).optional(),
    validationActionCommands: z.array(z.record(z.unknown())).optional(),
    validationAssistanceExposures: z.array(z.record(z.unknown())).optional(),
    validationPointAssessments: z.array(z.record(z.unknown())).optional(),
    schedulingShadowDecisions: z.array(z.record(z.unknown())).optional(),
    validationQualitySignals: z.array(z.record(z.unknown())).optional(),
    dryRun: z.boolean().optional().default(false),
  });

  // N#7-2: restore 接收与导出无上限 JSON blob 对称的大载荷，需显式 bodyLimit（Fastify 默认 1MB 会导致 >1MB 恢复 413）。
  // 与导出上限 EXPORT_MAX_ROWS_PER_TABLE 对齐，开 100MB。
  app.post("/export/workspace/restore", { preHandler: [requireOwner], bodyLimit: 100 * 1024 * 1024 }, async (req, reply) => {
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
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const markdown = await exportNoteMarkdown(req.params.id, req.session.workspaceId, req.session.userId);
    if (!markdown) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="note-${req.params.id}.md"`);
    return markdown;
  });
}
