import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { parseBody } from "../../lib/validate.ts";
import { safeSseWrite } from "../../lib/safe-sse-write.ts";
import { getCompanionBootstrap } from "./bootstrap-service.ts";
import { CompanionConversationError, createCompanionTurn, createCompanionConversation } from "./turn-service.ts";
import { createCompanionContextGrantRequestV1Schema, createMenuProposalRequestV1Schema, createToolProposalRequestV1Schema, proposalDecisionRequestV1Schema } from "@ailearn/shared";
import { cancelCompanionRun } from "./companion-cancel.ts";
import { openCompanionEventStream } from "./companion-events.ts";
import {
  ensureCompanionInbox,
  getCompanionConversationSnapshot,
  listCompanionConversations,
  listCompanionMessages,
  deleteCompanionConversation,
} from "./companion-conversations-service.ts";
import {
  createCompanionContextGrant,
  createCompanionMenuProposal,
  createCompanionToolProposal,
  decideCompanionProposal,
  getCompanionLearningSessionContext,
  getCompanionProposalSnapshot,
  resolveCompanionLearningContext,
} from "./learning-action-bridge.ts";
import { createCompanionTurnRequestV1Schema } from "@ailearn/shared";
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
 */
async function requireCompanionDialogue(_req: FastifyRequest, reply: FastifyReply) {
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
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED !== "true") {
        return reply.code(404).send({ version: 1, error: "NOT_FOUND", message: "not found", recoverable: false, requestId: req.id });
      }
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
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED !== "true") {
        return reply.code(404).send({ version: 1, error: "NOT_FOUND", message: "not found", recoverable: false, requestId: req.id });
      }
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
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED !== "true") {
        return reply.code(404).send({ version: 1, error: "NOT_FOUND", message: "not found", recoverable: false, requestId: req.id });
      }
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
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED !== "true") {
        return reply.code(404).send({ version: 1, error: "NOT_FOUND", message: "not found", recoverable: false, requestId: req.id });
      }
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

  // P5 §6.7 POST /learning-sessions/:id/companion-context-grants（grounded grant HMAC/5min TTL）。
  // Keep the companion-scoped alias for clients that already shipped against the
  // earlier handoff draft, but prefer the path-scoped endpoint so the session
  // relationship is explicit at the HTTP boundary.
  const contextGrantHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    if (process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED !== "true") {
      return reply.code(404).send({ version: 1, error: "NOT_FOUND", message: "not found", recoverable: false, requestId: req.id });
    }
    const session = req.session!;
    const params = (req.params ?? {}) as { sessionId?: string };
    const parsed = createCompanionContextGrantRequestV1Schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ version: 1, error: "INVALID_REQUEST", message: "grant body invalid", recoverable: false, requestId: req.id });
    }
    try {
      const result = await createCompanionContextGrant({
        workspaceId: session.workspaceId,
        userId: session.userId,
        sessionId: params.sessionId,
        body: parsed.data,
      });
      return reply.header("cache-control", "no-store").code(200).send(result);
    } catch (err) {
      if (err instanceof CompanionConversationError) {
        return reply.code(err.statusCode).send({ version: 1, error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message, recoverable: false, requestId: req.id });
      }
      throw err;
    }
  };
  app.post(
    "/learning-sessions/:sessionId/companion-context-grants",
    { preHandler: [requireSession] },
    contextGrantHandler,
  );

  // GET /learning-sessions/:sessionId/companion-context — page adapter 的
  // 权威 revision；不含 grant，不写数据，不调用模型。
  app.get<{ Params: { sessionId: string }; Querystring: { episodeId?: string } }>(
    "/learning-sessions/:sessionId/companion-context",
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED !== "true") {
        return reply.code(404).send({ version: 1, error: "NOT_FOUND", message: "not found", recoverable: false, requestId: req.id });
      }
      try {
        const result = await getCompanionLearningSessionContext({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          sessionId: req.params.sessionId,
          episodeId: req.query.episodeId,
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
  app.post(
    "/companion/context-grants",
    { preHandler: [requireSession] },
    contextGrantHandler,
  );

  // P5 §6.7 GET /companion/learning-context：只读 menu context（零写入/零模型调用）。
  app.get("/companion/learning-context", { preHandler: [requireSession] }, async (req, reply) => {
    if (process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED !== "true") {
      return reply.code(404).send({ version: 1, error: "NOT_FOUND", message: "not found", recoverable: false, requestId: req.id });
    }
    const session = req.session!;
    if (!rateLimited(reply, req.id, `${session.workspaceId}:${session.userId}:learning-context`, COMPANION_RATE_LIMITS.learningContextPerMinute.limit, COMPANION_RATE_LIMITS.learningContextPerMinute.windowMs)) return;
    const context = await resolveCompanionLearningContext({
      workspaceId: session.workspaceId,
      userId: session.userId,
    });
    return reply.send(context);
  });

  // GET /companion/bootstrap — 03 §6.0。无副作用：当前 scope 的 account 状态 +
  // 服务端能力投影；响应禁止缓存（每次会话进入都必须重新评估 capability）。
  app.get(
    "/companion/bootstrap",
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:read`, COMPANION_RATE_LIMITS.readQueriesPerMinute.limit, COMPANION_RATE_LIMITS.readQueriesPerMinute.windowMs)) return;
      const { body } = await getCompanionBootstrap(
        req.session.userId,
        req.session.workspaceId,
      );
      return body;
    },
  );

  // POST /companion/conversations — 03 §6.1 创建 dialogue（client 不能创建 inbox）。
  app.post(
    "/companion/conversations",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      const raw = (req.body ?? {}) as { version?: unknown; kind?: unknown; title?: unknown };
      if (raw.version !== 1 || raw.kind !== "dialogue") {
        return reply.code(400).send({
          version: 1,
          error: "INVALID_REQUEST",
          message: "request must be { version: 1, kind: 'dialogue' }",
          recoverable: false,
          requestId: req.id,
        });
      }
      const title = typeof raw.title === "string" ? raw.title : undefined;
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:create-conversation`, COMPANION_RATE_LIMITS.createConversationPerMinute.limit, COMPANION_RATE_LIMITS.createConversationPerMinute.windowMs)) return;
      try {
        const result = await createCompanionConversation({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          title,
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
            safeSseWrite(reply.raw, chunk);
          },
          onAbort: (cb) => {
            req.raw.on("close", cb);
          },
          close: () => {
            if (!reply.raw.writableEnded) reply.raw.end();
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
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
      });
      // §5.3：retry 指令属于 SSE 事件流本身，不在 HTTP 头（规范要求）。
      safeSseWrite(reply.raw, "retry: 1500\n\n");
      result.stream.start();
      return reply;
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

  // GET /companion/conversations — §6.3 签名 keyset 分页列表。
  app.get<{ Querystring: { limit?: string; cursor?: string; kind?: string; status?: string } }>(
    "/companion/conversations",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:read`, COMPANION_RATE_LIMITS.readQueriesPerMinute.limit, COMPANION_RATE_LIMITS.readQueriesPerMinute.windowMs)) return;
      const kind = req.query?.kind === "inbox" ? "inbox" : "dialogue";
      const status = req.query?.status === "archived" ? "archived" : "active";
      try {
        const limit = parsePaginationInt(req.query?.limit, 20);
        const result = await listCompanionConversations({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          limit,
          cursor: req.query?.cursor ?? null,
          kind,
          status,
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

  // GET /companion/conversations/:id — §6.4 原子恢复快照（含 P5 proposal/action）。
  app.get<{ Params: { id: string } }>(
    "/companion/conversations/:id",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:read`, COMPANION_RATE_LIMITS.readQueriesPerMinute.limit, COMPANION_RATE_LIMITS.readQueriesPerMinute.windowMs)) return;
      try {
        const result = await getCompanionConversationSnapshot({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          conversationId: req.params.id,
        });
        return reply.code(result.statusCode).header("cache-control", "no-store").send(result.body);
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

  // DELETE /companion/conversations/:id — §12 hard delete（active turn supersede fence）。
  app.delete<{ Params: { id: string } }>(
    "/companion/conversations/:id",
    { preHandler: [requireSession, requireCompanionDialogue] },
    async (req, reply) => {
      if (!rateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:mutate`, COMPANION_RATE_LIMITS.mutateConversationPerMinute.limit, COMPANION_RATE_LIMITS.mutateConversationPerMinute.windowMs)) return;
      try {
        const result = await deleteCompanionConversation({
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          conversationId: req.params.id,
        });
        return reply.code(result.statusCode).send();
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
      const result = await exportCompanionDataStream({
        workspaceId: req.session.workspaceId,
        userId: req.session.userId,
      }, (line) => {
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
        // 流式写出失败即中止导出（safeSseWrite 返回 false）。
        if (!safeSseWrite(reply.raw, `${line}\n`)) {
          const err = new Error("companion export stream closed");
          (err as Error & { code?: string }).code = "EXPORT_STREAM_CLOSED";
          throw err;
        }
      });
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
