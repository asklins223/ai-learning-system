import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { noteVersions } from "../../db/schema/note.ts";
import { learningCards } from "../../db/schema/card.ts";
import { jobs } from "../../db/schema/job.ts";
import { requireSession } from "../identity/middleware.ts";
import { getCardWithDetail, listCards, regenerateCard, acceptCard, dismissCard } from "./service.ts";
import { parseQuery, paginationQuerySchema, uuidParamSchema } from "../../lib/pagination.ts";

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
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const data = await getCardWithDetail(req.params.id, req.session.workspaceId);
    if (!data) return reply.code(404).send({ error: "not found" });
    return data;
  });

  // POST /cards/:id/regenerate — 重新生成学习卡
  app.post<{ Params: { id: string } }>("/cards/:id/regenerate", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const result = await regenerateCard(req.params.id, req.session.workspaceId, req.session.userId);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  // POST /cards/:id/accept — 接受学习卡
  app.post<{ Params: { id: string } }>("/cards/:id/accept", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const result = await acceptCard(req.params.id, req.session.workspaceId);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  // POST /cards/:id/dismiss — 忽略学习卡
  app.post<{ Params: { id: string } }>("/cards/:id/dismiss", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const result = await dismissCard(req.params.id, req.session.workspaceId);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });
}

import { generateCardRequestSchema } from "./schema.ts";
import { createGenerateCardJob } from "../job/service.ts";
import { CardStatus, JobStatus, JobType } from "@ailearn/shared";
import { parseBody } from "../../lib/validate.ts";

export async function cardJobRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  async function getGenerationState(workspaceId: string, noteVersionId: string, noteId: string) {
    const existingCard = await db.query.learningCards.findFirst({
      where: and(
        eq(learningCards.workspaceId, workspaceId),
        eq(learningCards.noteVersionId, noteVersionId),
        eq(learningCards.status, CardStatus.ACTIVE),
      ),
      orderBy: [desc(learningCards.createdAt)],
    });
    const activeJob = await db.query.jobs.findFirst({
      where: and(
        eq(jobs.workspaceId, workspaceId),
        eq(jobs.type, JobType.GENERATE_CARD),
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
        sql`${jobs.payload}->>'noteVersionId' = ${noteVersionId}`,
      ),
      orderBy: [desc(jobs.scheduledAt)],
    });
    const [previousCard] = await db
      .select({ id: learningCards.id, noteVersionId: learningCards.noteVersionId })
      .from(learningCards)
      .innerJoin(noteVersions, eq(noteVersions.id, learningCards.noteVersionId))
      .where(and(
        eq(learningCards.workspaceId, workspaceId),
        eq(learningCards.status, CardStatus.ACTIVE),
        eq(noteVersions.noteId, noteId),
      ))
      .orderBy(desc(learningCards.createdAt))
      .limit(1);

    if (activeJob) {
      return {
        state: "generating" as const,
        cardId: existingCard?.id ?? previousCard?.id ?? null,
        jobId: activeJob.id,
        generatedVersionId: existingCard?.noteVersionId ?? previousCard?.noteVersionId ?? null,
      };
    }

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
  }

  app.get<{ Params: { id: string } }>("/note-versions/:id/card-status", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const version = await db.query.noteVersions.findFirst({
      where: and(
        eq(noteVersions.id, req.params.id),
        eq(noteVersions.workspaceId, req.session.workspaceId),
      ),
    });
    if (!version) return reply.code(404).send({ error: "note version not found" });
    return getGenerationState(req.session.workspaceId, req.params.id, version.noteId);
  });

  app.post("/cards/generate", async (req, reply) => {
    const body = parseBody(app, generateCardRequestSchema, req.body);
    // 跨租户校验：noteVersion 必须属于当前 workspace
    const version = await db.query.noteVersions.findFirst({
      where: and(eq(noteVersions.id, body.noteVersionId), eq(noteVersions.workspaceId, req.session.workspaceId)),
    });
    if (!version) {
      return reply.code(404).send({ error: "note version not found" });
    }
    return createGenerateCardJob({
      workspaceId: req.session.workspaceId,
      userId: req.session.userId,
      noteId: version.noteId,
      noteVersionId: body.noteVersionId,
    });
  });
}
