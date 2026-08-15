import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { withWorkspaceTransaction, SYSTEM_USER_ID } from "../../db/client.ts";
import { noteVersions } from "../../db/schema/note.ts";
import { learningCards } from "../../db/schema/card.ts";
import { requireSession, requireOwner } from "../identity/middleware.ts";
import { getCardWithDetail, listCards, regenerateCard, dismissCard } from "./service.ts";
import { parseQuery, paginationQuerySchema, uuidParamSchema } from "../../lib/pagination.ts";
import { activeLearningCardConsumerPredicate } from "./consumer-eligibility.ts";
// QUAL-59 修复：将 import 语句从文件中间移到顶部，符合 ES 模块规范
import { generateCardRequestSchema } from "./schema.ts";
import { parseBody } from "../../lib/validate.ts";
import {
  createCardGenerationRun,
  getGenerationRunStatus,
} from "../card-generation/service.ts";

export async function cardRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/cards", async (req) => {
    // R-022: 统一 Zod 校验
    const q = parseQuery(app, paginationQuerySchema, req.query);
    // R-006: 按 userId 隔离，成员只能看到自己的验证和复习状态
    return listCards(req.session.workspaceId, { cursor: q.cursor, limit: q.limit }, req.session.userId);
  });

  app.get<{ Params: { id: string } }>("/cards/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const data = await getCardWithDetail(req.params.id, req.session.workspaceId, req.session.userId);
    if (!data) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    return data;
  });

  // POST /cards/:id/regenerate — 重新生成学习卡
  // RBAC: 仅 owner 可重新生成卡片
  app.post<{ Params: { id: string } }>("/cards/:id/regenerate", { preHandler: [requireOwner] }, async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const result = await regenerateCard(req.params.id, req.session.workspaceId, req.session.userId);
    if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    return result;
  });

  // POST /cards/:id/dismiss — 忽略学习卡
  // RBAC: 仅 owner 可忽略卡片
  app.post<{ Params: { id: string } }>("/cards/:id/dismiss", { preHandler: [requireOwner] }, async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const result = await dismissCard(req.params.id, req.session.workspaceId, req.session.userId);
    if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    return result;
  });
}

export async function cardJobRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  async function getGenerationState(workspaceId: string, noteVersionId: string, noteId: string) {
    // QUAL-58/SEC-26：这些读在 RLS 事务上下文内执行（learning_cards 等表
    // RLS 重开时不被裸 db 查询静默破坏；0027 failsafe 期间行为不变）。
    return withWorkspaceTransaction({ workspaceId, userId: SYSTEM_USER_ID }, async (tx) => {
      const existingCard = await tx.query.learningCards.findFirst({
        where: and(
          eq(learningCards.workspaceId, workspaceId),
          eq(learningCards.noteVersionId, noteVersionId),
          activeLearningCardConsumerPredicate(),
        ),
        orderBy: [desc(learningCards.createdAt)],
      });
      const [previousCard] = await tx
        .select({ id: learningCards.id, noteVersionId: learningCards.noteVersionId })
        .from(learningCards)
        .innerJoin(noteVersions, eq(noteVersions.id, learningCards.noteVersionId))
        .where(and(
          eq(learningCards.workspaceId, workspaceId),
          activeLearningCardConsumerPredicate(),
          eq(noteVersions.noteId, noteId),
        ))
        .orderBy(desc(learningCards.createdAt))
        .limit(1);

      if (existingCard) {
        return {
          state: "generated" as const,
          cardId: existingCard.id,
          jobId: null,
          generatedVersionId: existingCard.noteVersionId,
        };
      }

      if (previousCard) {
        return {
          state: "generated" as const,
          cardId: previousCard.id,
          jobId: null,
          generatedVersionId: previousCard.noteVersionId,
        };
      }

      return {
        state: "idle" as const,
        cardId: null,
        jobId: null,
        generatedVersionId: null,
      };
    });
  }

  app.get<{ Params: { id: string } }>("/note-versions/:id/card-status", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const version = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: SYSTEM_USER_ID },
      (tx) => tx.query.noteVersions.findFirst({
        where: and(
          eq(noteVersions.id, req.params.id),
          eq(noteVersions.workspaceId, req.session.workspaceId),
        ),
      }),
    );
    if (!version) return reply.code(404).send({ error: "note version not found" });
    return getGenerationState(req.session.workspaceId, req.params.id, version.noteId);
  });

  // RBAC: 仅 owner 可触发生成卡片（创建 AI 任务属于数据写入）
  app.post("/cards/generate", { preHandler: [requireOwner] }, async (req, reply) => {
    const body = parseBody(app, generateCardRequestSchema, req.body);
    // 跨租户校验：noteVersion 必须属于当前 workspace（RLS 事务上下文内）
    const version = await withWorkspaceTransaction(
      { workspaceId: req.session.workspaceId, userId: SYSTEM_USER_ID },
      (tx) => tx.query.noteVersions.findFirst({
        where: and(eq(noteVersions.id, body.noteVersionId), eq(noteVersions.workspaceId, req.session.workspaceId)),
      }),
    );
    if (!version) {
      return reply.code(404).send({ error: "note version not found" });
    }
    const run = await createCardGenerationRun(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      {
        noteVersionId: body.noteVersionId,
        // N#7-4: 幂等键改为确定性派生（来自 noteVersionId），使同 noteVersionId 的
        // 双击/HTTP 重试/客户端重放命中 createCardGenerationRun 的去重逻辑，避免重复 AI 派发。
        // 参照 card-set/service.ts 的确定性键模式。
        idempotencyKey: `card-generate:${body.noteVersionId}`,
      },
    );
    return getGenerationRunStatus(
      { workspaceId: req.session.workspaceId, userId: req.session.userId },
      run.runId,
    );
  });
}
