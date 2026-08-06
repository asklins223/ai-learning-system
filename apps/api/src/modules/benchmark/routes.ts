import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession, requireOwner } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import {
  getLatestBenchmarkReport,
  getSavedBenchmarkLabels,
  runBenchmark,
  saveLabelsAndCalculate,
  BUILTIN_NOTES,
} from "./service.ts";

const labelEntrySchema = z.object({
  ordinal: z.number().int().min(0),
  isCorrectlyAligned: z.boolean(),
  expectedBlockOrdinal: z.number().int().min(0).nullable(),
});

const labelFileSchema = z.object({
  noteFile: z.string().min(1).max(200),
  keyPoints: z.array(labelEntrySchema).max(100),
});

const saveLabelsSchema = z.object({
  runId: z.string().min(1).max(100),
  labels: z.array(labelFileSchema).min(1).max(BUILTIN_NOTES.length),
}).superRefine((data, context) => {
  const noteByFile = new Map(BUILTIN_NOTES.map((note) => [note.file, note]));
  const seenFiles = new Set<string>();
  data.labels.forEach((labelFile, fileIndex) => {
    const note = noteByFile.get(labelFile.noteFile);
    if (!note) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["labels", fileIndex, "noteFile"],
        message: "unknown benchmark note file",
      });
    }
    if (seenFiles.has(labelFile.noteFile)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["labels", fileIndex, "noteFile"],
        message: "duplicate benchmark note file",
      });
    }
    seenFiles.add(labelFile.noteFile);

    const seenOrdinals = new Set<number>();
    labelFile.keyPoints.forEach((label, labelIndex) => {
      if (seenOrdinals.has(label.ordinal)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["labels", fileIndex, "keyPoints", labelIndex, "ordinal"],
          message: "duplicate key-point ordinal",
        });
      }
      seenOrdinals.add(label.ordinal);
      if (
        note && label.expectedBlockOrdinal !== null &&
        label.expectedBlockOrdinal >= note.blocks.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["labels", fileIndex, "keyPoints", labelIndex, "expectedBlockOrdinal"],
          message: "expected block ordinal is outside the benchmark note",
        });
      }
    });
  });
});

export async function benchmarkRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  /**
   * POST /benchmark/run — 运行 Evidence 对齐基准测试。
   * 会创建 30 篇版本化内置笔记，触发 execute_card_agent_turn + align_evidence 全链路。
   * 需要 AI Worker 正在运行。
   */
  app.post("/benchmark/run", { preHandler: [requireOwner] }, async (req) => {
    const report = await runBenchmark(
      req.session.workspaceId,
      req.session.userId,
    );
    return report;
  });

  /**
   * POST /benchmark/labels — 提交人工标注，重新计算 precision。
   */
  app.post("/benchmark/labels", { preHandler: [requireOwner] }, async (req, reply) => {
    const body = parseBody(app, saveLabelsSchema, req.body);
    const currentReport = await getLatestBenchmarkReport(req.session.workspaceId);
    if (!currentReport) {
      return reply.code(404).send({ error: "no benchmark results found, run benchmark first" });
    }
    if (currentReport.runId !== body.runId) {
      return reply.code(409).send({ error: "benchmark run changed, reload the latest report before submitting labels" });
    }
    const report = await saveLabelsAndCalculate(
      req.session.workspaceId,
      req.session.userId,
      body.runId,
      body.labels,
    );
    if (!report) {
      return reply.code(409).send({ error: "benchmark run changed while labels were being submitted" });
    }
    return report;
  });

  /**
   * GET /benchmark/report — 返回当前 workspace 最新持久化评测报告。
   */
  app.get("/benchmark/report", async (req) => {
    return { report: await getLatestBenchmarkReport(req.session.workspaceId) };
  });

  /**
   * GET /benchmark/labels — 返回当前 workspace 已保存的人工标注。
   */
  app.get("/benchmark/labels", async (req) => {
    return { labels: await getSavedBenchmarkLabels(req.session.workspaceId) };
  });

  /**
   * GET /benchmark/notes — 返回内置基准笔记列表（供前端展示）。
   */
  app.get("/benchmark/notes", async () => {
    return {
      items: BUILTIN_NOTES.map((n) => ({
        file: n.file,
        title: n.title,
        blockCount: n.blocks.length,
      })),
    };
  });
}
