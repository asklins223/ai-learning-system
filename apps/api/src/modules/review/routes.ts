import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { listReviews } from "./service.ts";
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
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
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
  app.get<{ Querystring: { status?: string; includeAll?: string } }>(
    "/reviews",
    async (req) => {
      const q = parseQuery(app, reviewQuerySchema, req.query);
      const includeAll = q.includeAll === "true";
      return listReviews(req.session.workspaceId, {
        status: q.status,
        includeAll,
        limit: q.limit,
        offset: q.offset,
      }, req.session.userId);
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
    async (req) => {
      const scheduleId = req.query.reviewScheduleId;
      if (!scheduleId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scheduleId)) {
        return { activeAttempt: null };
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
