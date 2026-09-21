/**
 * Card Generation V2 — Fastify Routes（方案 20 §17）。
 *
 * 路由前缀：/v2
 * 全部需要 requireSession（auth middleware）
 * 创建/取消/激活操作需要 requireOwner
 *
 * 端点：
 * POST   /v2/card-generation-runs                     — 创建生成运行
 * GET    /v2/card-generation-runs/:runId               — 获取运行详情
 * GET    /v2/card-generation-runs/:runId/plan          — 获取计划
 * GET    /v2/card-generation-runs/:runId/candidates    — 获取候选列表
 * GET    /v2/card-generation-runs/:runId/events        — 获取事件流
 * POST   /v2/card-generation-runs/:runId/cancel        — 取消运行
 * POST   /v2/card-generation-runs/:runId/close         — 关闭运行（不激活）
 * POST   /v2/card-generation-runs/:runId/candidate-actions — 候选审核操作
 * POST   /v2/card-generation-runs/:runId/candidates/:candidateId/reveal — 揭示答案
 * POST   /v2/card-generation-runs/:runId/activate      — 激活候选
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireOwner, requireSession } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import { uuidParamSchema } from "../../lib/pagination.ts";
import {
  createCardGenerationRunRequestV2Schema,
  candidateActionCommandV2Schema,
  revealCandidateRequestV2Schema,
  activateCardCandidatesRequestV2Schema,
} from "@ailearn/shared/card-generation-v2-contracts";
import { cardGenerationExposureEligibilityV1Schema } from "@ailearn/shared/card-generation-desktop-contracts";
import {
  revealCardRequestV2Schema,
  archiveCardRequestV2Schema,
  type RevealCardRequestV2,
  type ArchiveCardRequestV2,
} from "@ailearn/shared/learning-card-v2-contracts";
import {
  revealCardV2,
  archiveCardV2,
  updateCardPresentationV2,
  createCardRegenerationRunV2,
  listReadyRemindersV2,
  cancelReminderV2,
  readPublicCardV2,
  listActiveCardsV2,
} from "./card-service.ts";
import {
  createGenerationRunV2,
  getGenerationRunV2,
  listActiveGenerationRunsV2,
  getLatestGenerationRunForNoteV2,
  getGenerationRunPlanV2,
  getGenerationRunCandidatesV2,
  getGenerationRunEventsV2,
  closeGenerationRunV2,
  cancelGenerationRunV2,
  retryGenerationRunV2,
} from "./generation-run-service.ts";
import { getCandidateExposureEligibilityV2, revealCandidateV2 } from "./reveal-service.ts";
import { handleCandidateActionV2 } from "./candidate-review-service.ts";
import { activateCardCandidatesV2 } from "./activation-service.ts";
import {
  CardGenerationV2ServiceError,
  NO_STORE,
  type RunContext,
} from "./helpers.ts";
import { safeSseWrite } from "../../lib/safe-sse-write.ts";
// 2026-08-24（§4.4 第二批复查）：shared 纯逻辑层抛的是父类
// CardGenerationPipelineErrorV2（如 filterBlocksBySourceScope 的选区越界），
// 错误边界必须检查父类才能同时接住 IO 壳（ServiceError 子类）与纯逻辑层
// （PipelineError 本类）的领域错误——instanceof 子类会漏掉父类实例。
import { CardGenerationPipelineErrorV2 } from "@ailearn/shared/card-generation-v2-pipeline";
import {
  parseCandidateRevealV2,
  parseCardActivationReceiptV2,
  parseCardGenerationPlanV2,
  parseCardGenerationRunServerViewV2,
  projectCardGenerationCandidatesV1,
  projectCardGenerationActiveSummaryListV1,
  projectCardGenerationCancelResultV1,
  projectCardGenerationRetryResultV1,
  projectCardGenerationCloseResultV1,
  projectCardGenerationJobAcceptedV1,
  projectCardGenerationReviewResultV1,
} from "./desktop-projection.ts";

const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional().default(0),
});

const candidateExposureQuerySchema = z.object({
  revision: z.coerce.number().int().min(1),
});

// /v2/cards 列表分页：cursor 为十进制 offset 字符串（保持简单、可 clamp）。
const v2CardsQuerySchema = z.object({
  cursor: z.string().max(40).regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function context(req: { session: { workspaceId: string; userId: string } }): RunContext {
  return { workspaceId: req.session.workspaceId, userId: req.session.userId };
}

/**
 * §9.1：Idempotency-Key 只由 HTTP header 提供；缺失时 400（禁止服务端
 * 随机生成——否则"同一 key、不同 payload 必须冲突"被静默架空）。
 */
function requireIdempotencyKey(req: { headers: Record<string, string | string[] | undefined> }): string {
  const key = req.headers["x-idempotency-key"];
  const value = Array.isArray(key) ? key[0] : key;
  if (!value || value.length === 0 || value.length > 200) {
    throw new CardGenerationV2ServiceError("idempotency_key_required", 400, "缺少 X-Idempotency-Key 请求头");
  }
  return value;
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  // 检查基类：子类（api IO 壳）与父类（shared 纯逻辑）实例都会命中。
  if (error instanceof CardGenerationPipelineErrorV2) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

export async function cardGenerationV2Routes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // ─── POST /v2/card-generation-runs ─ 创建生成运行 ──────────────────────
  app.post("/v2/card-generation-runs", { preHandler: [requireOwner] }, async (req, reply) => {
    reply.headers(NO_STORE);
    const body = parseBody(app, createCardGenerationRunRequestV2Schema, req.body);
    const idempotencyKey = requireIdempotencyKey(req);
    try {
      const result = await createGenerationRunV2(context(req), body.noteVersionId, body, idempotencyKey);
      return reply.code(202).send(projectCardGenerationJobAcceptedV1(result));
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // ─── GET /v2/card-generation-runs/active ─ Owner Room/Desk recovery ─────
  // Must precede the :runId route so the literal path is never parsed as UUID.
  app.get("/v2/card-generation-runs/active", { preHandler: [requireOwner] }, async (req, reply) => {
    reply.headers(NO_STORE);
    try {
      const runs = await listActiveGenerationRunsV2(context(req));
      return projectCardGenerationActiveSummaryListV1(runs);
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // ─── GET /v2/notes/:noteId/card-generation-runs/latest ─ 最近一次生成 ───
  // 笔记页用它给"按反馈重新生成"找到要回应的那次运行；没有记录时 404。
  app.get<{ Params: { noteId: string } }>("/v2/notes/:noteId/card-generation-runs/latest", { preHandler: [requireOwner] }, async (req, reply) => {
    reply.headers(NO_STORE);
    if (!uuidParamSchema.safeParse({ id: req.params.noteId }).success) {
      return reply.code(400).send({ error: "invalid_id", message: "无效的 noteId 格式" });
    }
    try {
      const run = await getLatestGenerationRunForNoteV2(context(req), req.params.noteId);
      if (!run) return reply.code(404).send({ error: "run_not_found", message: "这篇笔记还没有生成记录" });
      return parseCardGenerationRunServerViewV2(run);
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // ─── GET /v2/card-generation-runs/:runId ─ 获取运行详情 ─────────────────
  app.get<{ Params: { runId: string } }>("/v2/card-generation-runs/:runId", { preHandler: [requireOwner] }, async (req, reply) => {
    reply.headers(NO_STORE);
    if (!uuidParamSchema.safeParse({ id: req.params.runId }).success) {
      return reply.code(400).send({ error: "invalid_id", message: "无效的 runId 格式" });
    }
    try {
      const run = await getGenerationRunV2(context(req), req.params.runId);
      if (!run) return reply.code(404).send({ error: "run_not_found", message: "生成运行不存在" });
      return parseCardGenerationRunServerViewV2(run);
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // ─── GET /v2/card-generation-runs/:runId/plan ─ 获取计划 ───────────────
  app.get<{ Params: { runId: string } }>("/v2/card-generation-runs/:runId/plan", { preHandler: [requireOwner] }, async (req, reply) => {
    reply.headers(NO_STORE);
    if (!uuidParamSchema.safeParse({ id: req.params.runId }).success) {
      return reply.code(400).send({ error: "invalid_id", message: "无效的 runId 格式" });
    }
    try {
      const plan = await getGenerationRunPlanV2(context(req), req.params.runId);
      if (!plan) return reply.code(404).send({ error: "run_not_found", message: "生成运行不存在" });
      return parseCardGenerationPlanV2(plan);
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // ─── GET /v2/card-generation-runs/:runId/candidates ─ 获取候选列表 ──────
  app.get<{ Params: { runId: string } }>("/v2/card-generation-runs/:runId/candidates", { preHandler: [requireOwner] }, async (req, reply) => {
    reply.headers(NO_STORE);
    if (!uuidParamSchema.safeParse({ id: req.params.runId }).success) {
      return reply.code(400).send({ error: "invalid_id", message: "无效的 runId 格式" });
    }
    try {
      const candidateList = await getGenerationRunCandidatesV2(context(req), req.params.runId);
      if (!candidateList) return reply.code(404).send({ error: "run_not_found", message: "生成运行不存在" });
      return projectCardGenerationCandidatesV1(req.params.runId, candidateList);
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // ─── GET .../:candidateId/exposure ─ activation preflight ─────────────
  // Exact candidate revision + current user only; answer/evidence never cross
  // this projection boundary.
  app.get<{ Params: { runId: string; candidateId: string } }>(
    "/v2/card-generation-runs/:runId/candidates/:candidateId/exposure",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse({ id: req.params.runId }).success ||
          !uuidParamSchema.safeParse({ id: req.params.candidateId }).success) {
        return reply.code(400).send({ error: "invalid_id", message: "无效的 ID 格式" });
      }
      const query = candidateExposureQuerySchema.safeParse(req.query);
      if (!query.success) {
        return reply.code(400).send({ error: "invalid_request", message: "缺少有效 candidate revision" });
      }
      try {
        const projection = await getCandidateExposureEligibilityV2(
          context(req),
          req.params.runId,
          req.params.candidateId,
          query.data.revision,
        );
        if (!projection) return reply.code(404).send({ error: "candidate_not_found", message: "候选不存在" });
        return cardGenerationExposureEligibilityV1Schema.parse(projection);
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  // ─── GET /v2/card-generation-runs/:runId/events ─ 获取事件流 ────────────
  app.get<{ Params: { runId: string } }>("/v2/card-generation-runs/:runId/events", { preHandler: [requireOwner] }, async (req, reply) => {
    reply.headers(NO_STORE);
    if (!uuidParamSchema.safeParse({ id: req.params.runId }).success) {
      return reply.code(400).send({ error: "invalid_id", message: "无效的 runId 格式" });
    }
    const query = eventsQuerySchema.parse(req.query);
    try {
      const events = await getGenerationRunEventsV2(context(req), req.params.runId, query.after);
      return { events };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // ─── GET /v2/card-generation-runs/:runId/events/stream ─ SSE 实时事件流 ─
  app.get<{ Params: { runId: string } }>("/v2/card-generation-runs/:runId/events/stream", { preHandler: [requireOwner] }, async (req, reply) => {
    if (!uuidParamSchema.safeParse({ id: req.params.runId }).success) {
      return reply.code(400).send({ error: "invalid_id", message: "无效的 runId 格式" });
    }
    const lastEventId = req.headers["last-event-id"];
    const afterSequence = lastEventId === undefined
      ? 0
      : typeof lastEventId === "string" && /^\d+$/.test(lastEventId)
        ? Number(lastEventId)
        : Number.NaN;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      return reply.code(400).send({ error: "invalid_last_event_id", message: "无效的 Last-Event-ID" });
    }
    reply.hijack();
    if (reply.raw.writableEnded || reply.raw.destroyed) return reply;
    // SSE headers
    try {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
    } catch (error) {
      req.log.warn({ error, runId: req.params.runId }, "card generation SSE writeHead failed");
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
      return reply;
    }
    let lastSeq = afterSequence;
    const runId = req.params.runId;
    const ctx = context(req);
    let closed = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const stopStream = (): void => {
      if (closed) return;
      closed = true;
      if (interval) clearInterval(interval);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
    };
    // Send initial comment
    if (!safeSseWrite(reply.raw, ": connected\n\n")) {
      stopStream();
      return reply;
    }
    // B6（round-3 审计）：socket 级错误（EPIPE/ECONNRESET）必须吞掉——未处理会
    // 冒泡为 unhandled error 并可能在 fastify 错误链产生 500（对齐 run-routes.ts）。
    reply.raw.on("error", (err) => {
      stopStream();
      req.log.warn({ err, runId }, "sse: socket error");
    });
    // Poll for new events
    interval = setInterval(async () => {
      try {
        const events = await getGenerationRunEventsV2(ctx, runId, lastSeq);
        for (const e of events) {
          // B6：轮询写也要受 writableEnded 守卫（原只查 closed）——断开竞态窗口下
          // 向已结束的 socket 写可能触发 EPIPE unhandled。
          if (closed || reply.raw.writableEnded) return;
          const accepted = safeSseWrite(
            reply.raw,
            `id: ${e.eventSeq}\nevent: ${e.eventType}\ndata: ${JSON.stringify(e)}\n\n`,
          );
          if (!accepted) {
            // 不推进 lastSeq；客户端重连时从上一条确认过的事件继续。
            stopStream();
            return;
          }
          lastSeq = e.eventSeq;
        }
      } catch {
        // Silently skip errors, client will reconnect
      }
    }, 2000);
    interval?.unref();
    // PERF-B6/N4 修复：加 15s heartbeat comment，防止 idle 长连接被代理空闲超时
    // 端到端切断（对齐 companion-events.ts 的保活写法）。
    heartbeatTimer = setInterval(() => {
      if (!closed && !reply.raw.writableEnded) {
        if (!safeSseWrite(reply.raw, `: heartbeat ${Date.now()}\n\n`)) stopStream();
      }
    }, 15_000);
    heartbeatTimer?.unref();
    // Clean up on disconnect
    req.raw.on("close", () => {
      stopStream();
    });
    return reply;
  });

  // ─── POST /v2/card-generation-runs/:runId/cancel ─ 取消运行 ────────────
  app.post<{ Params: { runId: string } }>(
    "/v2/card-generation-runs/:runId/cancel",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse({ id: req.params.runId }).success) {
        return reply.code(400).send({ error: "invalid_id", message: "无效的 runId 格式" });
      }
      try {
        const result = await cancelGenerationRunV2(context(req), req.params.runId);
        if (!result) return reply.code(404).send({ error: "run_not_found", message: "生成运行不存在" });
        return projectCardGenerationCancelResultV1(result);
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  // ─── POST /v2/card-generation-runs/:runId/close ─ 关闭运行 ─────────────
  app.post<{ Params: { runId: string } }>(
    "/v2/card-generation-runs/:runId/close",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse({ id: req.params.runId }).success) {
        return reply.code(400).send({ error: "invalid_id", message: "无效的 runId 格式" });
      }
      const body = parseBody(app, z.strictObject({
        expectedReviewDraftRevision: z.number().int().min(1),
      }), req.body);
      try {
        const result = await closeGenerationRunV2(context(req), req.params.runId, body.expectedReviewDraftRevision);
        if (!result) return reply.code(404).send({ error: "run_not_found", message: "生成运行不存在" });
        return projectCardGenerationCloseResultV1(result);
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  // ─── POST /v2/card-generation-runs/:runId/retry ─ 就地重试 ──────────────
  // 唯一候选被 critic 否决的 run 会终态化为 needs_attention，且没有候选可审核。
  // 此前用户只能回笔记重开一次全新生成（重付 planner + 全部 critic 的 token）；
  // 这个端点在**同一条 run** 上派发一次重规划，复用已封存的来源与输入快照。
  // 守卫在 service 内独立校验（状态 / 失败码 / 来源新鲜度 / 在飞行任务），
  // 与恢复投影是否签发该动作无关——投影只是 UI 提示，不构成授权。
  app.post<{ Params: { runId: string } }>(
    "/v2/card-generation-runs/:runId/retry",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse({ id: req.params.runId }).success) {
        return reply.code(400).send({ error: "invalid_id", message: "无效的 runId 格式" });
      }
      try {
        const result = await retryGenerationRunV2(context(req), req.params.runId);
        if (!result) return reply.code(404).send({ error: "run_not_found", message: "生成运行不存在" });
        return projectCardGenerationRetryResultV1(result);
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  // ─── POST /v2/card-generation-runs/:runId/candidate-actions ─ 候选审核操作 ─
  app.post<{ Params: { runId: string } }>(
    "/v2/card-generation-runs/:runId/candidate-actions",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse({ id: req.params.runId }).success) {
        return reply.code(400).send({ error: "invalid_id", message: "无效的 runId 格式" });
      }
      const command = parseBody(app, candidateActionCommandV2Schema, req.body);
      // 确保 URL 中的 runId 与 body 中的 runId 一致
      if (command.runId !== req.params.runId) {
        return reply.code(400).send({ error: "run_id_mismatch", message: "URL 中的 runId 与请求体不一致" });
      }
      const idempotencyKey = requireIdempotencyKey(req);
      try {
        const result = await handleCandidateActionV2(context(req), command, idempotencyKey);
        return projectCardGenerationReviewResultV1(result);
      } catch (error) {
        if (error instanceof CardGenerationPipelineErrorV2) {
          req.log.warn({ code: error.code, runId: req.params.runId }, "card-generation candidate action rejected");
        }
        return sendServiceError(reply, error);
      }
    },
  );

  // ─── POST /v2/card-generation-runs/:runId/candidates/:candidateId/reveal ─ 揭示答案 ─
  app.post<{ Params: { runId: string; candidateId: string } }>(
    "/v2/card-generation-runs/:runId/candidates/:candidateId/reveal",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse({ id: req.params.runId }).success ||
          !uuidParamSchema.safeParse({ id: req.params.candidateId }).success) {
        return reply.code(400).send({ error: "invalid_id", message: "无效的 ID 格式" });
      }
      const body = parseBody(app, revealCandidateRequestV2Schema, req.body);
      // 确保 URL 中的 candidateId 与 body 中的一致
      if (body.candidateId !== req.params.candidateId) {
        return reply.code(400).send({ error: "candidate_id_mismatch", message: "URL 中的 candidateId 与请求体不一致" });
      }
      const idempotencyKey = requireIdempotencyKey(req);
      try {
        const reveal = await revealCandidateV2(
          context(req),
          req.params.runId,
          body.candidateId,
          body.expectedCandidateRevision,
          body.expectedCandidateRevisionHash,
          idempotencyKey,
        );
        return parseCandidateRevealV2(reveal);
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  // ─── POST /v2/card-generation-runs/:runId/activate ─ 激活候选 ──────────
  app.post<{ Params: { runId: string } }>(
    "/v2/card-generation-runs/:runId/activate",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse({ id: req.params.runId }).success) {
        return reply.code(400).send({ error: "invalid_id", message: "无效的 runId 格式" });
      }
      const body = parseBody(app, activateCardCandidatesRequestV2Schema, req.body);
      // 确保 URL 中的 runId 与 body 中的一致
      if (body.runId !== req.params.runId) {
        return reply.code(400).send({ error: "run_id_mismatch", message: "URL 中的 runId 与请求体不一致" });
      }
      const idempotencyKey = requireIdempotencyKey(req);
      try {
        const receipt = await activateCardCandidatesV2(context(req), body, idempotencyKey);
        return reply.code(200).send(parseCardActivationReceiptV2(receipt));
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  // ─── §17.6 Card 端点 ───────────────────────────────────────────────────

  // GET /v2/cards — active V2 card 列表（§19.5，支持 limit/cursor 分页）
  app.get("/v2/cards", async (req, reply) => {
    reply.headers(NO_STORE);
    try {
      const query = v2CardsQuerySchema.parse(req.query);
      const result = await listActiveCardsV2(context(req), {
        limit: query.limit,
        cursor: query.cursor,
      });
      return result;
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // GET /v2/cards/:cardId — Public Card（§15.1）
  app.get<{ Params: { cardId: string } }>("/v2/cards/:cardId", async (req, reply) => {
    reply.headers(NO_STORE);
    if (!uuidParamSchema.safeParse({ id: req.params.cardId }).success) {
      return reply.code(400).send({ error: "invalid_id", message: "无效的 cardId 格式" });
    }
    try {
      const card = await readPublicCardV2(context(req), req.params.cardId);
      if (!card) return reply.code(404).send({ error: "card_not_found", message: "卡片不存在" });
      return card;
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // POST /v2/cards/:cardId/reveal — exposure-first（§15.2/§17.6）
  app.post<{ Params: { cardId: string } }>("/v2/cards/:cardId/reveal", async (req, reply) => {
    reply.headers(NO_STORE);
    if (!uuidParamSchema.safeParse({ id: req.params.cardId }).success) {
      return reply.code(400).send({ error: "invalid_id", message: "无效的 cardId 格式" });
    }
    const body = parseBody(app, revealCardRequestV2Schema, req.body) as RevealCardRequestV2;
    if (body.cardId !== req.params.cardId) {
      return reply.code(400).send({ error: "card_id_mismatch", message: "URL 中的 cardId 与请求体不一致" });
    }
    const idempotencyKey = requireIdempotencyKey(req);
    try {
      const reveal = await revealCardV2(context(req), body, idempotencyKey);
      return reveal;
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // POST /v2/cards/:cardId/archive — §16.7 lifecycle close
  app.post<{ Params: { cardId: string } }>(
    "/v2/cards/:cardId/archive",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse({ id: req.params.cardId }).success) {
        return reply.code(400).send({ error: "invalid_id", message: "无效的 cardId 格式" });
      }
      const body = parseBody(app, archiveCardRequestV2Schema, req.body) as ArchiveCardRequestV2;
      if (body.cardId !== req.params.cardId) {
        return reply.code(400).send({ error: "card_id_mismatch", message: "URL 中的 cardId 与请求体不一致" });
      }
      const idempotencyKey = requireIdempotencyKey(req);
      try {
        const result = await archiveCardV2(context(req), body, idempotencyKey);
        return result;
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  // POST /v2/cards/:cardId/revisions — presentation-only patch（§15.4）
  app.post<{ Params: { cardId: string } }>(
    "/v2/cards/:cardId/revisions",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse({ id: req.params.cardId }).success) {
        return reply.code(400).send({ error: "invalid_id", message: "无效的 cardId 格式" });
      }
      const body = parseBody(app, z.strictObject({
        expectedPublicationRevision: z.number().int().min(1),
        expectedPublicPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
        patch: z.strictObject({
          front: z.strictObject({
            cue: z.string().min(1).max(2000).optional(),
            context: z.string().min(1).max(3000).optional(),
            prompt: z.string().min(1).max(2000),
          }).optional(),
          strategy: z.enum(["recall", "cloze", "compare", "sequence", "why", "boundary", "application"]).optional(),
        }),
      }), req.body);
      try {
        const result = await updateCardPresentationV2(
          context(req),
          req.params.cardId,
          body.expectedPublicationRevision,
          body.expectedPublicPayloadHash,
          body.patch,
        );
        return result;
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  // POST /v2/cards/:cardId/regeneration-runs — §6.8/§17.6
  app.post<{ Params: { cardId: string } }>(
    "/v2/cards/:cardId/regeneration-runs",
    { preHandler: [requireOwner] },
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse({ id: req.params.cardId }).success) {
        return reply.code(400).send({ error: "invalid_id", message: "无效的 cardId 格式" });
      }
      const body = parseBody(app, z.strictObject({
        noteVersionId: z.string().uuid().optional(),
        learningGoal: z.enum(["remember", "understand", "apply", "exam"]).default("understand"),
        detailThreshold: z.enum(["concise", "balanced", "deep"]).default("balanced"),
        quantity: z.strictObject({ kind: z.literal("adaptive"), hardMaxCards: z.number().int().min(0).max(50).optional() }).default({ kind: "adaptive" }),
        clientRequestId: z.string().min(1).max(200).default(`regenerate-${Date.now()}`),
      }), req.body ?? {});
      const idempotencyKey = requireIdempotencyKey(req);
      try {
        const result = await createCardRegenerationRunV2(
          context(req),
          req.params.cardId,
          body.noteVersionId,
          body.learningGoal,
          body.detailThreshold,
          body.quantity,
          body.clientRequestId,
          idempotencyKey,
        );
        return reply.code(202).send(result);
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  // ─── §17.3 Initial Validation Reminder 端点 ─────────────────────────────

  // GET /v2/initial-validation-reminders?status=ready
  app.get("/v2/initial-validation-reminders", async (req, reply) => {
    reply.headers(NO_STORE);
    try {
      const reminders = await listReadyRemindersV2(context(req));
      return { reminders };
    } catch (error) {
      return sendServiceError(reply, error);
    }
  });

  // POST /v2/initial-validation-reminders/:reminderId/cancel
  app.post<{ Params: { reminderId: string } }>(
    "/v2/initial-validation-reminders/:reminderId/cancel",
    async (req, reply) => {
      reply.headers(NO_STORE);
      if (!uuidParamSchema.safeParse({ id: req.params.reminderId }).success) {
        return reply.code(400).send({ error: "invalid_id", message: "无效的 reminderId 格式" });
      }
      try {
        const result = await cancelReminderV2(context(req), req.params.reminderId);
        return result;
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );
}
