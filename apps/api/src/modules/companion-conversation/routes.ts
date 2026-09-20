import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import { safeSseWrite, safeWriteWithBackpressure } from "../../lib/safe-sse-write.ts";
import { CompanionConversationError, createCompanionTurn } from "./turn-service.ts";
import { createCompanionLearningRunContextGrantRequestV1Schema, createMenuProposalRequestV1Schema, createToolProposalRequestV1Schema, proposalDecisionRequestV1Schema } from "@ailearn/shared";
import { cancelCompanionRun } from "./companion-cancel.ts";
import { openCompanionEventStream, listCompanionAgentRoutes, listCompanionRunNodes } from "./companion-events.ts";
import { openCompanionThought } from "./thought-service.ts";
import {
  ensureCompanionInbox,
  listCompanionMessages,
} from "./companion-conversations-service.ts";
import {
  createCompanionLearningRunContextGrant,
  createCompanionMenuProposal,
  createCompanionToolProposal,
  decideCompanionProposal,
  getCompanionLearningRunContext,
  getCompanionProposalSnapshot,
  resolveCompanionLearningContext,
} from "./learning-action-bridge.ts";
import { createCompanionTurnRequestV1Schema } from "@ailearn/shared";
import { allowedMainRouteV2Schema } from "@ailearn/shared";
import { exportCompanionDataStream } from "./companion-export.ts";
import {
  COMPANION_RATE_LIMITS,
  companionRateLimit,
  companionRateLimitReply,
} from "./companion-rate-limit.ts";

/**
 * §6.10 限流 helper：达限时写 429 并返回 false，调用方立即 return。
 * key 一律按 (workspace,user) 聚合；menu-proposal 与 create turn 共用
 * "write:turn" 写预算（§6.10），读查询共用 "read" 合并预算。
 */
function rateLimited(reply: FastifyReply, requestId: string, key: string, limit: number, windowMs: number): boolean {
  const result = companionRateLimit({ key, limit, windowMs });
  if (result.allowed) return true;
  companionRateLimitReply(reply, requestId, result.retryAfterSeconds);
  return false;
}

/**
 * 分页参数解析：缺省/空串 → fallback；非正整数 → 400 INVALID_REQUEST。
 * 直接 `Number(raw)` 对 "abc" 得 NaN，会生成 `LIMIT NaN` 让 PG 抛错并泄漏为 500。
 */
function parsePaginationInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CompanionConversationError("INVALID_REQUEST", 400, "limit/beforeSeq must be a positive integer");
  }
  return n;
}


/**
 * Conversation APIs must fail closed at the HTTP boundary. Checking the flag
 * only in the worker allowed disabled clients to create durable conversations
 * and turns which could never run.
 *
 * 导出仅为单测直接覆盖这条边界契约（routes.test.ts）；运行时只由下面的
 * preHandler 注册使用。
 */
export async function requireCompanionDialogue(_req: FastifyRequest, reply: FastifyReply) {
  if (process.env.COMPANION_DIALOGUE_V1_ENABLED === "true") return;
  return reply.code(404).send({
    version: 1,
    error: "NOT_FOUND",
    message: "not found",
    recoverable: false,
  });
}

export async function companionConversationRoutes(app: FastifyInstance) {
  // P5 §6.7 POST /companion/menu-proposals：菜单 proposal create（原子）。
  app.post(
    "/companion/menu-proposals",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      const session = req.session!;
      const idempotencyKey = req.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
        return reply.code(400).send({ version: 1, error: "INVALID_REQUEST", message: "idempotency-key required", recoverable: false, requestId: req.id });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!rateLimited(reply, req.id, `${session.workspaceId}:${session.userId}:write:turn`, COMPANION_RATE_LIMITS.menuProposalPerMinute.limit, COMPANION_RATE_LIMITS.menuProposalPerMinute.windowMs)) return;
      const parsed = createMenuProposalRequestV1Schema.safeParse(body);
      if (!parsed.success) {
        return reply.code(400).send({ version: 1, error: "INVALID_REQUEST", message: "menu proposal body invalid", recoverable: false, requestId: req.id });
      }
      try {
        const result = await createCompanionMenuProposal({
          workspaceId: session.workspaceId,
          userId: session.userId,
          body: parsed.data,
          idempotencyKey,
        });
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          return reply.code(err.statusCode).send({ version: 1, error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message, recoverable: false, requestId: req.id });
        }
        throw err;
      }
    },
  );

  // 方案 16 §18.1 POST /companion/tool-proposals：Orchestrator/桌宠工具网关
  // 入口（payload 全量校验 → 原子 proposal；确认后由 decision 同步执行）。
  app.post(
    "/companion/tool-proposals",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      const session = req.session!;
      const idempotencyKey = req.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
        return reply.code(400).send({ version: 1, error: "INVALID_REQUEST", message: "idempotency-key required", recoverable: false, requestId: req.id });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!rateLimited(reply, req.id, `${session.workspaceId}:${session.userId}:write:turn`, COMPANION_RATE_LIMITS.menuProposalPerMinute.limit, COMPANION_RATE_LIMITS.menuProposalPerMinute.windowMs)) return;
      const parsed = createToolProposalRequestV1Schema.safeParse(body);
      if (!parsed.success) {
        return reply.code(400).send({ version: 1, error: "INVALID_REQUEST", message: "tool proposal body invalid", recoverable: false, requestId: req.id });
      }
      try {
        const result = await createCompanionToolProposal({
          workspaceId: session.workspaceId,
          userId: session.userId,
          body: parsed.data,
          idempotencyKey,
        });
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          return reply.code(err.statusCode).send({ version: 1, error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message, recoverable: false, requestId: req.id });
        }
        throw err;
      }
    },
  );

  // GET /companion/proposals/:id — §6.6 durable proposal/action snapshot.
  app.get<{ Params: { id: string } }>(
    "/companion/proposals/:id",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      try {
        if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:read`, COMPANION_RATE_LIMITS.readQueriesPerMinute.limit, COMPANION_RATE_LIMITS.readQueriesPerMinute.windowMs)) return;
        const result = await getCompanionProposalSnapshot({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          proposalId: req.params.id,
        });
        return reply.code(result.statusCode).header("cache-control", "no-store").send(result.body);
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          return reply.code(err.statusCode).send({ version: 1, error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message, recoverable: true, requestId: req.id });
        }
        throw err;
      }
    },
  );

  // P5 §6.6 POST /companion/proposals/:id/decision（confirm/reject 原子消费）。
  app.post<{ Params: { id: string } }>(
    "/companion/proposals/:id/decision",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      const session = req.session!;
      const idempotencyKey = req.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
        return reply.code(400).send({ version: 1, error: "INVALID_REQUEST", message: "idempotency-key required", recoverable: false, requestId: req.id });
      }
      if (!rateLimited(reply, req.id, `${session.workspaceId}:${session.userId}:decision`, COMPANION_RATE_LIMITS.proposalDecisionPerMinute.limit, COMPANION_RATE_LIMITS.proposalDecisionPerMinute.windowMs)) return;
      const parsed = proposalDecisionRequestV1Schema.safeParse({
        ...((req.body ?? {}) as Record<string, unknown>),
        proposalId: req.params.id,
      });
      if (!parsed.success) {
        return reply.code(400).send({ version: 1, error: "INVALID_REQUEST", message: "decision body invalid", recoverable: false, requestId: req.id });
      }
      try {
        const result = await decideCompanionProposal({
          workspaceId: session.workspaceId,
          userId: session.userId,
          proposalId: parsed.data.proposalId,
          decision: parsed.data.decision,
          idempotencyKey,
          expectedPayloadSha256: parsed.data.expectedPayloadSha256,
        });
        return reply.code(parsed.data.decision === "reject" || (result as { status: string }).status === "succeeded" ? 200 : 202).send(result);
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          return reply.code(err.statusCode).send({ version: 1, error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message, recoverable: false, requestId: req.id });
        }
        throw err;
      }
    },
  );

  // LearningRun 是当前正式学习页面；授权携带 frozen snapshot + active task，
  // 使 worker 永远不会把旧 Session 的可变上下文混进新的 Run。
  app.post<{ Params: { runId: string } }>(
    "/learning-runs/:runId/companion-context-grants",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      const parsed = createCompanionLearningRunContextGrantRequestV1Schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ version: 1, error: "INVALID_REQUEST", message: "grant body invalid", recoverable: false, requestId: req.id });
      }
      try {
        const result = await createCompanionLearningRunContextGrant({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          runId: req.params.runId,
          body: parsed.data,
        });
        return reply.header("cache-control", "no-store").code(200).send(result);
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          return reply.code(err.statusCode).send({ version: 1, error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message, recoverable: false, requestId: req.id });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/learning-runs/:runId/companion-context",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      try {
        const result = await getCompanionLearningRunContext({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          runId: req.params.runId,
        });
        return reply.code(result.statusCode).header("cache-control", "no-store").send(result.body);
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          return reply.code(err.statusCode).send({ version: 1, error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message, recoverable: true, requestId: req.id });
        }
        throw err;
      }
    },
  );
  // P5 §6.7 GET /companion/learning-context：只读 menu context（零写入/零模型调用）。
  app.get("/companion/learning-context", { preHandler: [requireSession, requireCompanionDialogue] }, async (req, reply) => {
    const session = req.session!;
    if (!rateLimited(reply, req.id, `${session.workspaceId}:${session.userId}:learning-context`, COMPANION_RATE_LIMITS.learningContextPerMinute.limit, COMPANION_RATE_LIMITS.learningContextPerMinute.windowMs)) return;
    const context = await resolveCompanionLearningContext({
      workspaceId: session.workspaceId,
      userId: session.userId,
    });
    return reply.send(context);
  });

  // POST /companion/conversations/:id/turns — 03 §6.5/§8.1 原子 turn 创建。
  // Idempotency-Key header 必填（UUID）；服务端只保存其 SHA-256。
  app.post<{ Params: { id: string } }>(
    "/companion/conversations/:id/turns",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      const idempotencyKey = String(req.headers["idempotency-key"] ?? "");
      if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(idempotencyKey)) {
        return reply.code(400).send({
          version: 1,
          error: "INVALID_REQUEST",
          message: "Idempotency-Key header must be a UUID",
          recoverable: false,
          requestId: req.id,
        });
      }
      const body = parseBody(app, createCompanionTurnRequestV1Schema, req.body);
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:write:turn`, COMPANION_RATE_LIMITS.createTurnPerMinute.limit, COMPANION_RATE_LIMITS.createTurnPerMinute.windowMs)) return;
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:write:turn:hour`, COMPANION_RATE_LIMITS.createTurnPerHour.limit, COMPANION_RATE_LIMITS.createTurnPerHour.windowMs)) return;
      try {
        const result = await createCompanionTurn({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          conversationId: req.params.id,
          idempotencyKey,
          body,
        });
        return reply.code(result.statusCode).send(result.body);
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          // 5xx 业务错误也脱敏（与 server.ts setErrorHandler 的 5xx 占位一致）
          const is5xx = err.statusCode >= 500;
          return reply.code(err.statusCode).send({
            version: 1,
            error: err.code,
            message: is5xx ? "服务器内部错误" : err.message,
            recoverable: !is5xx,
            requestId: req.id,
          });
        }
        throw err;
      }
    },
  );

  // GET /companion/conversations/:id/events — 03 §5.3 SSE。
  // 先完成全部校验（cursor/连接限制/404/409），成功才 writeHead 进入流。
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/companion/conversations/:id/events",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      const afterRaw = typeof req.query?.after === "string" ? req.query.after : null;
      const lastEventId =
        typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : null;
      const result = await openCompanionEventStream({
        workspaceId: req.session.workspaceId,
        userId: req.session.userId,
        conversationId: req.params.id,
        afterRaw,
        lastEventId,
        writer: {
          write: (chunk) => {
            return safeSseWrite(reply.raw, chunk);
          },
          onAbort: (cb) => {
            req.raw.on("close", cb);
          },
          close: () => {
            if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
          },
        },
      });
      if (result.statusCode !== 200) {
        return reply.code(result.statusCode).send({
          version: 1,
          error: result.error.code,
          message: result.error.message,
          recoverable: true,
          requestId: req.id,
        });
      }
      reply.hijack();
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        result.stream.close();
        return reply;
      }
      try {
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
          "Connection": "keep-alive",
        });
      } catch (err) {
        result.stream.close();
        req.log.warn({ err, conversationId: req.params.id }, "companion SSE writeHead failed");
        return reply;
      }
      // §5.3：retry 指令属于 SSE 事件流本身，不在 HTTP 头（规范要求）。
      if (!safeSseWrite(reply.raw, "retry: 1500\n\n")) {
        result.stream.close();
        return reply;
      }
      result.stream.start();
      return reply;
    },
  );

  // GET /companion/conversations/:id/agent-routes — 2026-09-18 桌面轮询窗口。
  // 只读投影：agent.tool 事件里带 route 的 succeeded 形态（导航类工具结果），
  // 供无 SSE 消费者的桌面聊天抽屉按 seq 游标拉取。UI 提示用途，不做 SSE 的
  // 连续 replay 校验；route 形状不合 V2 的事件跳过，不整单失败。
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/companion/conversations/:id/agent-routes",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:read`, COMPANION_RATE_LIMITS.readQueriesPerMinute.limit, COMPANION_RATE_LIMITS.readQueriesPerMinute.windowMs)) return;
      const afterRaw = typeof req.query?.after === "string" ? req.query.after : "0";
      const after = Number(afterRaw);
      if (!Number.isInteger(after) || after < 0) {
        return reply.code(400).send({
          version: 1,
          error: "INVALID_REQUEST",
          message: "after must be a non-negative integer",
          recoverable: false,
          requestId: req.id,
        });
      }
      try {
        const result = await listCompanionAgentRoutes({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          conversationId: req.params.id,
          after,
        });
        if (!result.ok) {
          return reply.code(result.statusCode).header("cache-control", "no-store").send({
            version: 1,
            error: result.code,
            message: result.statusCode >= 500 ? "服务器内部错误" : result.message,
            recoverable: true,
            requestId: req.id,
          });
        }
        const items = result.items.flatMap((item) => {
          const parsed = allowedMainRouteV2Schema.safeParse(item.route);
          if (!parsed.success) return [];
          return [{
            version: 1 as const,
            seq: item.seq,
            tool: item.tool,
            safeSummary: item.safeSummary,
            route: parsed.data,
            ...(item.autoExecute ? { autoExecute: true as const } : {}),
          }];
        });
        return reply.code(200).header("cache-control", "no-store").send({
          version: 1,
          items,
          latestSeq: result.latestSeq,
        });
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          return reply.code(err.statusCode).send({ version: 1, error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message, recoverable: true, requestId: req.id });
        }
        throw err;
      }
    },
  );

  // GET /companion/conversations/:id/run-nodes — 2026-09-19 过程留痕只读窗口。
  // 与 agent-routes 同形状（seq 游标 + latestSeq）：节点事件原样透传，由桌面端复用
  // 实时链路那个收敛函数折成节点，避免"实时的过程"和"翻历史的过程"两套口径。
  // 另外按 run 返回步数/工具次数摘要与当前仍可读的节点条数——后者是"过程记录已过期"
  // 的唯一诚实判据（消息不随 TTL 消失，事件会）。
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/companion/conversations/:id/run-nodes",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:read`, COMPANION_RATE_LIMITS.readQueriesPerMinute.limit, COMPANION_RATE_LIMITS.readQueriesPerMinute.windowMs)) return;
      const afterRaw = typeof req.query?.after === "string" ? req.query.after : "0";
      const after = Number(afterRaw);
      if (!Number.isInteger(after) || after < 0) {
        return reply.code(400).send({
          version: 1,
          error: "INVALID_REQUEST",
          message: "after must be a non-negative integer",
          recoverable: false,
          requestId: req.id,
        });
      }
      try {
        const result = await listCompanionRunNodes({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          conversationId: req.params.id,
          after,
        });
        if (!result.ok) {
          return reply.code(result.statusCode).header("cache-control", "no-store").send({
            version: 1,
            error: result.code,
            message: result.message,
            recoverable: true,
            requestId: req.id,
          });
        }
        return reply.code(200).header("cache-control", "no-store").send({
          version: 1,
          items: result.items.map((item) => ({
            version: 1 as const,
            seq: item.seq,
            runId: item.runId,
            type: item.type,
            payload: item.payload,
          })),
          runs: result.runs.map((run) => ({
            version: 1 as const,
            runId: run.runId,
            status: run.status,
            generation: run.generation,
            mode: run.mode === "single_step" ? ("single_step" as const) : ("hybrid" as const),
            stepCount: run.stepCount,
            toolCallCount: run.toolCallCount,
            maxSteps: run.maxSteps,
            maxToolCalls: run.maxToolCalls,
            assistantMessageId: run.assistantMessageId,
            nodeCount: run.nodeCount,
          })),
          latestSeq: result.latestSeq,
        });
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          return reply.code(err.statusCode).send({ version: 1, error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message, recoverable: true, requestId: req.id });
        }
        throw err;
      }
    },
  );

  // POST /companion/thoughts/:id/open — 念头管线切片④（2026-09-18）。
  // 气泡点击主动开场：念头的表达落为 kind='proactive' 的 assistant 开场消息，
  // 念头 delivered → spent（不可重复点开）。
  app.post<{ Params: { id: string } }>(
    "/companion/thoughts/:id/open",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:read`, COMPANION_RATE_LIMITS.readQueriesPerMinute.limit, COMPANION_RATE_LIMITS.readQueriesPerMinute.windowMs)) return;
      try {
        const result = await openCompanionThought({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          thoughtId: req.params.id,
        });
        return reply.code(result.statusCode).header("cache-control", "no-store").send(result.body);
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          return reply.code(err.statusCode).send({ version: 1, error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message, recoverable: true, requestId: req.id });
        }
        throw err;
      }
    },
  );

  // POST /companion/runs/:id/cancel — 03 §8.2。202 首次取消 / 200 幂等。
  app.post<{ Params: { id: string } }>(
    "/companion/runs/:id/cancel",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:cancel`, COMPANION_RATE_LIMITS.cancelPerMinute.limit, COMPANION_RATE_LIMITS.cancelPerMinute.windowMs)) return;
      try {
        const result = await cancelCompanionRun({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          runId: req.params.id,
          body: req.body,
        });
        return reply.code(result.statusCode).send(result.body);
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          // 5xx 业务错误也脱敏（与 server.ts setErrorHandler 的 5xx 占位一致）
          const is5xx = err.statusCode >= 500;
          return reply.code(err.statusCode).send({
            version: 1,
            error: err.code,
            message: is5xx ? "服务器内部错误" : err.message,
            recoverable: !is5xx,
            requestId: req.id,
          });
        }
        throw err;
      }
    },
  );
}

// ─── P2-8 会话管理（§6.2/§6.3/§6.4/§12） ─────────────────────────────────

export async function companionConversationManagementRoutes(app: FastifyInstance) {
  // POST /companion/inbox/ensure — §6.2 幂等唯一 inbox（201 首次 / 200 已有）。
  app.post(
    "/companion/inbox/ensure",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      const result = await ensureCompanionInbox({
        workspaceId: req.session.workspaceId,
        userId: req.session.userId,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  // GET /companion/conversations/:id/messages — §6.4 历史消息（beforeSeq 分页）。
  app.get<{ Params: { id: string }; Querystring: { limit?: string; beforeSeq?: string } }>(
    "/companion/conversations/:id/messages",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:read`, COMPANION_RATE_LIMITS.readQueriesPerMinute.limit, COMPANION_RATE_LIMITS.readQueriesPerMinute.windowMs)) return;
      try {
        const limit = parsePaginationInt(req.query?.limit, 50);
        const beforeSeq = req.query?.beforeSeq != null ? parsePaginationInt(req.query.beforeSeq, 0) : null;
        const result = await listCompanionMessages({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          conversationId: req.params.id,
          limit,
          beforeSeq,
        });
        return reply.code(result.statusCode).send(result.body);
      } catch (err) {
        if (err instanceof CompanionConversationError) {
          return reply.code(err.statusCode).send({
            version: 1,
            error: err.code,
            message: err.statusCode >= 500 ? "服务器内部错误" : err.message,
            recoverable: false,
            requestId: req.id,
          });
        }
        throw err;
      }
    },
  );

}

// ─── §12 Export（NDJSON） ─────────────────────────────────────────────────

export async function companionExportRoutes(app: FastifyInstance) {
  app.get(
    "/companion/export",
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:export`, COMPANION_RATE_LIMITS.exportPerHour.limit, COMPANION_RATE_LIMITS.exportPerHour.windowMs)) return;
      // PERF（round-5）：改为流式导出——每一行 NDJSON 产生后立即写出到 socket，
      // 不再把整份输出（最多 6×50k 行）累积进内存数组。错误（如 active turn 409）
      // 都发生在首行 manifest 写出之前，此时尚未 hijack/发响应头，可按原契约返回
      // 错误 JSON。
      let started = false;
      let result;
      try {
        result = await exportCompanionDataStream({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
        }, async (line) => {
          if (!started) {
            started = true;
            reply.hijack();
            reply.raw.writeHead(200, {
              "Content-Type": "application/x-ndjson; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Content-Disposition": 'attachment; filename="companion-export-v1.ndjson"',
            });
          }
          // NDJSON 没有 SSE cursor；命中 high-water mark 时等待 drain，避免
          // 生成无 footer 的半截导出，也避免继续把数据堆进 Node 缓冲区。
          if (!await safeWriteWithBackpressure(reply.raw, `${line}\n`)) {
            const err = new Error("companion export stream closed");
            (err as Error & { code?: string }).code = "EXPORT_STREAM_CLOSED";
            throw err;
          }
        });
      } catch (err) {
        if (started || (err && typeof err === "object" && "code" in err && err.code === "EXPORT_STREAM_CLOSED")) {
          if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.destroy();
          return reply;
        }
        throw err;
      }
      if (!result.ok) {
        // 错误只可能发生在首行写出前（active-turn 检查），此时未 hijack。
        return reply.code(result.statusCode).send({
          version: 1,
          error: result.code,
          message: result.message,
          recoverable: false,
          requestId: req.id,
        });
      }
      if (!started) {
        // 防御：极端情况下无任何行输出（manifest 恒为首行，正常不会走到）。
        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": 'attachment; filename="companion-export-v1.ndjson"',
        });
      }
      reply.raw.end();
      return reply;
    },
  );
}
