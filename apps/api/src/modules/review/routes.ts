import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { listReviews, listSanitizedReviews, getSanitizedReviewMeta } from "./service.ts";
import { parseBody } from "../../lib/validate.ts";
import { parseQuery } from "../../lib/pagination.ts";
import {
  reviewAttemptStartSchema,
  reviewAttemptSubmitSchema,
  reviewAttemptLaterSchema,
  reviewAttemptHistoryPaginationSchema,
  type ReviewAttemptHistoryPagination,
} from "@ailearn/shared";
import {
  startReviewAttempt,
  submitReviewAttempt,
  laterReviewAttempt,
  listReviewAttemptHistory,
  abandonReviewAttempt,
  getActiveReviewAttempt,
  ReviewAttemptError,
} from "./attempt-service.ts";

const reviewQuerySchema = z.object({
  status: z.enum(["pending", "accepted", "completed", "dismissed", "superseded", "cancelled"]).optional(),
  includeAll: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // PERF-A#7：offset 上限从 100k 收紧到 10k，防止客户端强制深扫描；配合
  // limit≤100 与 nextReviewAt 窗口过滤，today 队列均可分页覆盖。
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
  // 2026-08-11（性能专项）：nextReviewAt 窗口过滤（today 页按天拉取，
  // 避免全量复习串行瀑布）。
  dueFromMs: z.coerce.number().int().min(0).optional(),
  dueToMs: z.coerce.number().int().min(0).optional(),
});

const reviewAttemptHistoryQuerySchema = reviewAttemptHistoryPaginationSchema.extend({
  reviewScheduleId: z.string().uuid().optional(),
});

function sendReviewAttemptError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof ReviewAttemptError) {
    reply.code(error.statusCode).send({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

export async function reviewRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  // GET /reviews                — 默认只返回到期的 pending（今日复习队列）
  // GET /reviews?status=pending — 同上
  // GET /reviews?status=dismissed|completed|... — 返回该状态全部（不过滤到期）
  // GET /reviews?includeAll=true — 返回该 workspace 全部复习
  // R-022: 统一 Zod 校验
  // v0.6: GET /reviews?sanitized=true — 返回安全版本（不含 card title/claim/quote/blockContent）
  app.get<{ Querystring: { status?: string; includeAll?: string; sanitized?: string } }>(
    "/reviews",
    async (req, reply) => {
      const q = parseQuery(app, reviewQuerySchema, req.query);
      const includeAll = q.includeAll === "true";
      const sanitized = req.query.sanitized === "true";
      if (sanitized) {
        // v0.6 安全列表（计划 §9.4/§10.4）
        // Cache-Control: private, no-store — 不进入 Service Worker/共享缓存
        reply.header("Cache-Control", "private, no-store");
        return withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          (tx) => listSanitizedReviews(req.session.workspaceId, {
            status: q.status,
            includeAll,
            limit: q.limit,
            offset: q.offset,
          }, req.session.userId, tx),
        );
      }
      return withWorkspaceTransaction(
        { workspaceId: req.session.workspaceId, userId: req.session.userId },
        (tx) => listReviews(req.session.workspaceId, {
          status: q.status,
          includeAll,
          limit: q.limit,
          offset: q.offset,
          dueFromMs: q.dueFromMs,
          dueToMs: q.dueToMs,
        }, req.session.userId, tx),
      );
    },
  );

  // v0.6: GET /reviews/:scheduleId/sanitized — 返回单个 schedule 的安全元数据（计划 §9.4/§10.4）
  // 只包含 cardId、keyPointId、nextReviewAt、intervalDays、status、reviewReason
  // 不包含 card title、claim、quoteText、blockContent
  app.get<{ Params: { scheduleId: string } }>(
    "/reviews/:scheduleId/sanitized",
    async (req, reply) => {
      const result = await withWorkspaceTransaction(
        { workspaceId: req.session.workspaceId, userId: req.session.userId },
        (tx) => getSanitizedReviewMeta(
          req.session.workspaceId,
          req.params.scheduleId,
          req.session.userId,
          tx,
        ),
      );
      if (!result) {
        return reply.code(404).send({ error: "not_found", message: "复习任务不存在" });
      }
      // Cache-Control: private, no-store — 不进入 Service Worker/共享缓存（计划 §8.2）
      reply.header("Cache-Control", "private, no-store");
      return reply.send(result);
    },
  );

  // ─── LOOP-01 / LOOP-02: Review Attempt API (ADR-0004) ──────────────

  /**
   * POST /reviews/attempts/start
   * Begin a review attempt. Returns an attemptId that must be used in the
   * subsequent submit call. Idempotent on (workspace, user, idempotencyKey).
   */
  app.post("/reviews/attempts/start", async (req, reply) => {
    const body = parseBody(app, reviewAttemptStartSchema, req.body);
    try {
      const result = await startReviewAttempt(
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      return reply.code(201).send(result);
    } catch (error) {
      if (!sendReviewAttemptError(reply, error)) throw error;
    }
  });

  /**
   * POST /reviews/attempts/submit
   * Submit a review attempt with answer, outcome and confidence. Computes the
   * ADR-0004 scheduling decision, updates the review schedule, and conditionally
   * emits an understanding event — all in one transaction.
   * Idempotent: returns the existing result if the attempt was already completed.
   */
  app.post("/reviews/attempts/submit", async (req, reply) => {
    const body = parseBody(app, reviewAttemptSubmitSchema, req.body);
    try {
      const result = await submitReviewAttempt(
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      return result;
    } catch (error) {
      if (!sendReviewAttemptError(reply, error)) throw error;
    }
  });

  /**
   * POST /reviews/attempts/later
   * Defer a review with a "later" skip reason. Applies a short deferral
   * (REVIEW_LATER_DELAY_HOURS) and keeps the interval unchanged.
   * Idempotent on (workspace, user, idempotencyKey).
   */
  app.post("/reviews/attempts/later", async (req, reply) => {
    const body = parseBody(app, reviewAttemptLaterSchema, req.body);
    try {
      const result = await laterReviewAttempt(
        req.session.workspaceId,
        req.session.userId,
        body,
      );
      return reply.code(201).send(result);
    } catch (error) {
      if (!sendReviewAttemptError(reply, error)) throw error;
    }
  });

  /**
   * GET /reviews/attempts/active
   * V05-RISK-04: Find the active (started) review attempt for a given schedule.
   * Returns the attempt or null. Enables cross-device/cross-tab recovery.
   * Query: ?reviewScheduleId=uuid
   */
  app.get<{ Querystring: { reviewScheduleId?: string } }>(
    "/reviews/attempts/active",
    async (req, reply) => {
      const scheduleId = req.query.reviewScheduleId;
      if (!scheduleId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scheduleId)) {
        // 2026-08-11：契约统一——非法 UUID 一律 400（此前静默返回 200 {activeAttempt:null}）
        return reply.code(400).send({ error: "invalid_id_format", message: "无效的 reviewScheduleId" });
      }
      const activeAttempt = await getActiveReviewAttempt(
        req.session.workspaceId,
        req.session.userId,
        scheduleId,
      );
      return { activeAttempt };
    },
  );

  /**
   * POST /reviews/attempts/:attemptId/abandon
   * V05-RISK-04: Abandon a started review attempt, transitioning it to
   * "abandoned" status. This frees the schedule for a new start.
   * Idempotent: if already abandoned, returns the existing state.
   */
  app.post<{ Params: { attemptId: string } }>(
    "/reviews/attempts/:attemptId/abandon",
    async (req, reply) => {
      try {
        const result = await abandonReviewAttempt(
          req.session.workspaceId,
          req.session.userId,
          req.params.attemptId,
        );
        return reply.code(200).send(result);
      } catch (error) {
        if (!sendReviewAttemptError(reply, error)) throw error;
      }
    },
  );

  /**
   * GET /reviews/attempts/history
   * Paginated list of the authenticated user's review attempts.
   * Privacy: answer_text is intentionally excluded from history summaries.
   * Optional ?reviewScheduleId= resolves that schedule's subject and returns
   * history across its completed and current pending schedule generations.
   */
  app.get("/reviews/attempts/history", async (req) => {
    const q = parseQuery(app, reviewAttemptHistoryQuerySchema, req.query) as ReviewAttemptHistoryPagination & {
      reviewScheduleId?: string;
    };
    return listReviewAttemptHistory(
      req.session.workspaceId,
      req.session.userId,
      { limit: q.limit, cursor: q.cursor },
      q.reviewScheduleId,
    );
  });
}
