import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import { validationSubmitSchema, createQuestionSchema } from "./schema.ts";
import {
  submitValidation,
  listValidations,
  getValidation,
  getValidationByJobId,
  createValidationQuestion,
} from "./service.ts";
import { uuidParamSchema, cardIdParamSchema } from "../../lib/pagination.ts";

export async function validationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  /**
   * N-003: 服务端创建验证题。
   * 题目持久化到 validation_questions 表，返回 questionId。
   * 客户端使用 questionId 提交验证答案。
   */
  app.post<{ Params: { cardId: string } }>("/cards/:cardId/questions", async (req, reply) => {
    const params = cardIdParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid cardId format" });
    const body = parseBody(app, createQuestionSchema, req.body);
    const result = await createValidationQuestion(
      req.params.cardId,
      req.session.workspaceId,
      req.session.userId,
      body,
    );
    if (!result) return reply.code(404).send({ error: "not found" });
    if ("error" in result) {
      if (result.error === "no_hard_evidence") {
        return reply.code(422).send({ error: result.error, message: "该关键要点暂无有效硬证据，无法验证" });
      }
      return reply.code(409).send({ error: result.error, message: "该学习卡暂无关键要点，无法验证" });
    }
    return result;
  });

  /** 提交一次理解验证 → 入队 evaluate_validation job，返回 jobId */
  app.post<{ Params: { cardId: string } }>("/cards/:cardId/validate", async (req, reply) => {
    // R-022: UUID 路径参数校验
    const params = cardIdParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid cardId format" });
    const body = parseBody(app, validationSubmitSchema, req.body);
    const result = await submitValidation(
      req.params.cardId,
      req.session.workspaceId,
      req.session.userId,
      body,
    );
    if (!result) return reply.code(404).send({ error: "not found" });
    if ("error" in result) {
      // N-004: 无硬证据的 keyPoint 返回 422
      if (result.error === "no_hard_evidence") {
        return reply.code(422).send({ error: result.error, message: "该关键要点暂无有效硬证据，无法验证" });
      }
      if (result.error === "invalid_question") {
        return reply.code(404).send({ error: result.error, message: "题目不存在或不属于该卡片" });
      }
      if (result.error === "question_expired") {
        return reply.code(410).send({ error: result.error, message: "题目已过期，请重新生成" });
      }
      return reply.code(409).send({ error: result.error, message: "该学习卡暂无关键要点，无法验证" });
    }
    return result;
  });

  /** 列某张学习卡的验证历史
   * F-011: 按 userId 隔离，普通成员只能看到自己的验证记录
   */
  app.get<{ Params: { cardId: string } }>("/cards/:cardId/validations", async (req, reply) => {
    // R-022: UUID 路径参数校验
    const params = cardIdParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid cardId format" });
    const items = await listValidations(req.params.cardId, req.session.workspaceId, req.session.userId);
    if (!items) return reply.code(404).send({ error: "not found" });
    return { items };
  });

  /** 取单条验证结果（含结构化 feedback） */
  app.get<{ Params: { id: string } }>("/validations/:id", async (req, reply) => {
    // R-022: UUID 路径参数校验
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const item = await getValidation(req.params.id, req.session.workspaceId, req.session.userId);
    if (!item) return reply.code(404).send({ error: "not found" });
    return item;
  });

  /**
   * N-003: 按 jobId 查询验证结果。
   * 客户端提交验证后获得 jobId，通过此接口直接取回结果，
   * 不再需要通过 key point、题目、答案和时间窗猜测匹配。
   */
  app.get<{ Params: { jobId: string } }>("/validations/by-job/:jobId", async (req, reply) => {
    const jobIdSchema = z.object({ jobId: z.string().uuid() });
    const params = jobIdSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid jobId format" });
    const item = await getValidationByJobId(req.params.jobId, req.session.workspaceId, req.session.userId);
    if (!item) return reply.code(404).send({ error: "not found" });
    return item;
  });
}
