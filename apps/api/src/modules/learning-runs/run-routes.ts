/**
 * LearningRun API 路由（文档 16 §13.1）。
 *
 * 端点（全部 requireSession；RLS 上下文由 withWorkspaceTransaction 设置）：
 * - POST   /learning-runs                                 创建并 PREPARE Run
 * - GET    /learning-runs/:runId                          公共快照（ETag=revision）
 * - GET    /learning-runs/:runId/events                   SSE（Last-Event-ID 重放）
 * - PUT    /learning-runs/:runId/tasks/:taskId/draft      CAS 保存草稿
 * - DELETE /learning-runs/:runId/tasks/:taskId/draft      删除草稿
 * - POST   /learning-runs/:runId/tasks/:taskId/submissions 原子锁定 + 排队评估
 * - POST   /learning-runs/:runId/actions                  严格 action union
 * - GET    /learning-runs/:runId/result                   学习结算 / 202
 * - GET    /learning-runs/:runId/return-contract          返回持久语义
 * - POST   /learning-runs/:runId/activity-lease           §13.3 active time 续租
 *
 * 响应纪律（§13.1）：Action response 一律 Cache-Control: no-store；
 * Return Contract 一律 no-store；public snapshot 用 ETag/revision。
 * declared_unable 只走 submissions，不在 action union。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../lib/validate.ts";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import {
  createLearningRunRequestSchema,
  learningRunActionRequestSchema,
  putLearningTaskDraftRequestSchema,
  submitTaskArtifactSchema,
} from "@ailearn/shared";
import {
  applyAction,
  createRun,
  createRunV2,
  deleteDraft,
  getDraft,
  getEventsAfter,
  getResultPayload,
  getReturnContract,
  getRunPublicView,
  putDraft,
  recordActivityLease,
  submitArtifact,
  type CreateLearningRunV2Request,
} from "./run-service.ts";
import {
  createLearningRunV2RequestSchema,
} from "@ailearn/shared";
import { LearningRunServiceError } from "./run-errors.ts";
import { safeSseWrite } from "../../lib/safe-sse-write.ts";
import { companionRateLimit } from "../companion-conversation/companion-rate-limit.ts";
// 方案 16 §20：学习漏斗埋点（服务端权威写入，尽力而为）。
import { recordLearningMetric, recordLearningMetrics, type LearningMetricEventV1, type LearningMetricScope } from "../observability/learning-metrics.ts";
import { isLearningRunV1Enabled } from "../../config/learning-companion-flags.ts";

// PERF-A#10：fire-and-forget 学习埋点加背压——有界在途/排队，溢出即丢弃
// （与 recordLearningMetric 的静默尽力而为语义一致），避免高流量下无界堆积
// DB 写事务。单实例内存队列；无需持久化（埋点可丢）。
const METRIC_MAX_INFLIGHT = 8;
const METRIC_MAX_QUEUE = 100;
let metricInFlight = 0;
const metricQueue: Array<() => Promise<void>> = [];

function drainMetricQueue(): void {
  while (metricInFlight < METRIC_MAX_INFLIGHT && metricQueue.length > 0) {
    const task = metricQueue.shift()!;
    metricInFlight += 1;
    void task().finally(() => {
      metricInFlight -= 1;
      drainMetricQueue();
    });
  }
}

function enqueueLearningMetric(
  scope: LearningMetricScope,
  event: LearningMetricEventV1,
): void {
  const task = () => recordLearningMetric(scope, event);
  if (metricInFlight >= METRIC_MAX_INFLIGHT) {
    // 队列已满：直接丢弃（尽力而为，埋点失败/丢弃均无学习副作用）。
    if (metricQueue.length >= METRIC_MAX_QUEUE) return;
    metricQueue.push(task);
    return;
  }
  metricInFlight += 1;
  void task().finally(() => {
    metricInFlight -= 1;
    drainMetricQueue();
  });
}

const runParamsSchema = z.object({ runId: z.string().uuid() });
const taskDraftParamsSchema = z.object({ runId: z.string().uuid(), taskId: z.string().uuid() });
const activityLeaseBodySchema = z.object({
  deviceSessionId: z.string().min(1).max(200),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1),
});

// 运维护栏（2026-08-15 审计）：learning-runs 写端点此前无限流——高频
// create/submit 会持续排满评估任务队列。与 companion 限流同模式（内存
// 固定窗口 per (workspace,user) + bucket；单实例部署语义）。
const RUN_WRITE_LIMITS = {
  createPerMinute: 20,
  submitPerMinute: 60,
  actionPerMinute: 120,
  draftPerMinute: 120,
} as const;

function runRateLimited(
  reply: import("fastify").FastifyReply,
  requestId: string,
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const decision = companionRateLimit({ key, limit, windowMs });
  if (decision.allowed) return false;
  reply.code(429).header("Retry-After", String(decision.retryAfterSeconds)).send({
    version: 1,
    error: "RATE_LIMITED",
    message: "操作过于频繁，请稍后重试",
    recoverable: true,
    requestId,
  });
  return true;
}

export async function learningRunRoutes(app: FastifyInstance) {
  // learning_run_v1 capability 门控：Card/Review/Player/submission/consumer
  // 同一次切换原子开启（§22.2）。未开启时本插件内全部端点 404 fail closed。
  app.addHook("onRequest", async (_req, reply) => {
    if (!isLearningRunV1Enabled()) {
            return reply.code(404).send({
        error: "learning_run_v1_disabled",
        message: "统一学习运行当前未开放",
      });
    }
  });
  const scopeOf = (req: { session: { workspaceId: string; userId: string } }) => ({
    workspaceId: req.session.workspaceId,
    userId: req.session.userId,
  });

  // POST /learning-runs — PREPARE：origin 解析 → 调度授权 → 确定性规划 → 原子写入。
  app.post("/learning-runs", { preHandler: [requireSession] }, async (req, reply) => {
    if (runRateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:run:create`, RUN_WRITE_LIMITS.createPerMinute, 60_000)) return;
    // §16.3：请求体带 originV2 → V2 PREPARE 路径；否则 V1 origin 路径。
    const raw = req.body as Record<string, unknown>;
    if (raw && typeof raw === "object" && "originV2" in raw && (raw as { originV2?: unknown }).originV2 !== undefined) {
      const body = parseBody(app, createLearningRunV2RequestSchema, req.body);
      const req2 = body as CreateLearningRunV2Request;
      try {
        const result = await withWorkspaceTransaction(scopeOf(req), async (tx) =>
          createRunV2(tx, {
            workspaceId: req.session.workspaceId,
            userId: req.session.userId,
            request: req2,
          }),
        );
        // §16.1/§16.3：V2 只下发 LearningRunTargetPublicV2 投影（绝不含
        // canonicalAnswer/scoringRubric/evidence/planningExposure）。
        return reply.code(201).header("Cache-Control", "no-store").send({
          version: 2,
          runId: result.runId,
          snapshotId: result.snapshotId,
          target: result.frozen.publicTarget,
          publishedTargetEligibility: result.frozen.snapshot.publishedTargetEligibility,
        });
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...err.recoveryData });
        }
        throw err;
      }
    }
    const body = parseBody(app, createLearningRunRequestSchema, req.body);
    try {
      const run = await withWorkspaceTransaction(scopeOf(req), async (tx) =>
        createRun(tx, { workspaceId: req.session.workspaceId, userId: req.session.userId, request: body }),
      );
      // 方案 16 §20：funnel 第一层（origin×goal）+ 任务呈现（intent×interaction×
      // purpose×trustClass 授权上限；非 active task 无 variant 信息，留空）。
      // R8（round-3 审计）：原来每个任务逐条 recordLearningMetric（每事件 1 事务 +
      // 1 RTT）；现在收集为数组、单事务批量写入（尽力而为，失败静默不阻塞主链路）。
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const activeTaskId = run.activeTask?.taskId ?? null;
      const metricEvents = [
        {
          eventType: "run_created" as const,
          runId: run.runId,
          origin: run.origin,
          goal: run.goal,
        },
        ...run.taskSummaries.map((task) => ({
          eventType: "task_presented" as const,
          runId: run.runId,
          taskId: task.taskId,
          intent: task.intent,
          interactionKind: task.taskId === activeTaskId && run.activeTask
            ? run.activeTask.activeVariant.interaction.kind
            : undefined,
          variantPurpose: task.taskId === activeTaskId && run.activeTask
            ? run.activeTask.activeVariant.purpose
            : undefined,
          trustClass: task.taskId === activeTaskId && run.activeTask
            ? run.activeTask.activeVariant.templateTrustCeiling
            : undefined,
        })),
      ];
      await recordLearningMetrics(scope, metricEvents);
      return reply.code(201).header("Cache-Control", "no-store").send(run);
    } catch (err) {
      if (err instanceof LearningRunServiceError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...err.recoveryData });
      }
      throw err;
    }
  });

  // GET /learning-runs/:runId — 公共快照；ETag=revision。
  app.get<{ Params: { runId: string } }>(
    "/learning-runs/:runId",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      try {
        const view = await withWorkspaceTransaction(scopeOf(req), async (tx) =>
          getRunPublicView(tx, { workspaceId: req.session.workspaceId, userId: req.session.userId, runId: params.data.runId }),
        );
        return reply.header("ETag", `"${view.revision}"`).send(view);
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // GET /learning-runs/:runId/events — SSE；Last-Event-ID = 最后收到的 sequence。
  app.get<{ Params: { runId: string }; Querystring: { lastEventId?: string } }>(
    "/learning-runs/:runId/events",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      const afterSequence = Number(req.query?.lastEventId ?? 0);
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw app.httpErrors.badRequest("lastEventId 非法");
      }
      // fastify 5：先 hijack 再 writeHead——writeHead 抛 ERR_STREAM_WRITE_AFTER_END
      // 只会发生在客户端已断开、socket 已终结时；hijack 前调用会让框架在
      // handler 返回时自动终结流（16-remaining-issues #1：间歇 500 根源之一）。
      reply.hijack();
      if (reply.raw.writableEnded || reply.raw.destroyed) {
        req.log.warn({ runId: params.data.runId }, "sse: socket already closed before hijack");
        return reply;
      }
      try {
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
      } catch (err) {
        // 客户端在 writeHead 前断开：记录并安静结束，不再冒泡为 500。
        req.log.error({ err, runId: params.data.runId }, "sse: writeHead failed");
        return reply;
      }
      const scope = scopeOf(req);
      let closed = false;
      let cursor = afterSequence;
      // socket 级错误（EPIPE/ECONNRESET）必须吞掉：未处理会冒泡为
      // unhandled error 并可能在 fastify 错误链产生 500。
      reply.raw.on("error", (err) => {
        closed = true;
        req.log.warn({ err, runId: params.data.runId }, "sse: socket error");
      });
      // PERF-A#9：in-flight guard——DB poll 慢于 3s 时跳过本次 tick，防止
      // 重叠 interval 在慢 DB 下堆积（N 客户端 × 每 3s 一次 DB 往返不叠加）。
      // 空闲（无事件）时指数退避到 SSE_MAX_INTERVAL_MS，有事件立即恢复 3s。
      let polling = false;
      let pollIntervalMs = 3000;
      const SSE_MAX_INTERVAL_MS = 30_000;
      const SSE_EVENTS_BATCH = 200; // 对齐 run-service.getEventsAfter 的 LIMIT 值
      const SSE_DRAIN_ROUNDS = 5;   // 单 tick 最多续读轮次，限制突发 drain 的峰值
      let interval: ReturnType<typeof setInterval> | null = null;
      const schedulePoll = () => {
        if (interval) clearInterval(interval);
        interval = setInterval(pollEvents, pollIntervalMs);
        interval.unref();
      };
      const pollEvents = async () => {
        if (closed || polling) return;
        polling = true;
        try {
          // F8（round-5 审计）：getEventsAfter 有 WHERE seq > after + LIMIT SSE_EVENTS_BATCH(200)。
          // 突发攒 >200 条时若只拉一批、余条要等下一 3s tick 才能续读，端到端延迟放大。
          // 本轮 tick 内做有界 drain：每轮读到满批（==batch）则继续 round 续读，不足一批
          // 即排空；受 SSE_DRAIN_ROUNDS 上限约束，cursor 每轮推进，Last-Event-ID 无缝隙无重复。
          let emittedAny = false;
          for (let round = 0; round < SSE_DRAIN_ROUNDS && !closed; round++) {
            const events = await withWorkspaceTransaction(scope, async (tx) =>
              getEventsAfter(tx, { ...scope, runId: params.data.runId, afterSequence: cursor }),
            );
            for (const event of events) {
              cursor = event.sequence;
              emittedAny = true;
              if (!closed) {
                safeSseWrite(reply.raw, `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`);
              }
            }
            if (events.length < SSE_EVENTS_BATCH) break;
          }
          // 空闲退避：无事件时逐步拉长轮询间隔（上限 30s），有事件立即恢复 3s。
          if (emittedAny) {
            if (pollIntervalMs !== 3000) {
              pollIntervalMs = 3000;
              schedulePoll();
            }
          } else if (pollIntervalMs < SSE_MAX_INTERVAL_MS) {
            pollIntervalMs = Math.min(pollIntervalMs * 2, SSE_MAX_INTERVAL_MS);
            schedulePoll();
          }
        } catch (err) {
          if (interval) clearInterval(interval);
          if (!closed && !reply.raw.writableEnded) reply.raw.end();
          req.log.warn({ err }, "learning-run events stream error");
        } finally {
          polling = false;
        }
      };
      interval = setInterval(pollEvents, pollIntervalMs);
      interval.unref();
      // PERF-B6 修复：加 15s heartbeat comment，防止 idle 长连接被代理空闲超时切断
      //（对齐 companion-events.ts 的保活写法）。
      const heartbeatTimer = setInterval(() => {
        if (!closed) {
          safeSseWrite(reply.raw, `: heartbeat ${Date.now()}\n\n`);
        }
      }, 15_000);
      heartbeatTimer.unref();
      reply.raw.on("close", () => {
        closed = true;
        if (interval) clearInterval(interval);
        clearInterval(heartbeatTimer);
      });
      return reply;
    },
  );

  // PUT /learning-runs/:runId/tasks/:taskId/draft — CAS/If-Match。
  app.put<{ Params: { runId: string; taskId: string } }>(
    "/learning-runs/:runId/tasks/:taskId/draft",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = taskDraftParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("run/task id 非法");
      const body = parseBody(app, putLearningTaskDraftRequestSchema, req.body);
      try {
        const draft = await withWorkspaceTransaction(scopeOf(req), async (tx) =>
          putDraft(tx, {
            workspaceId: req.session.workspaceId,
            userId: req.session.userId,
            runId: params.data.runId,
            taskId: params.data.taskId,
            variantId: body.variantId,
            variantRevision: body.variantRevision,
            taskRevision: body.taskRevision,
            expectedDraftRevision: body.expectedDraftRevision,
            payload: body.payload,
            rendererState: body.rendererState,
            idempotencyKey: body.idempotencyKey,
          }),
        );
        return reply.code(200).header("Cache-Control", "no-store").send(draft);
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...err.recoveryData });
        }
        throw err;
      }
    },
  );

  // GET /learning-runs/:runId/tasks/:taskId/draft — 跨设备恢复（解密返回）。
  app.get<{ Params: { runId: string; taskId: string } }>(
    "/learning-runs/:runId/tasks/:taskId/draft",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = taskDraftParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("run/task id 非法");
      try {
        const draft = await withWorkspaceTransaction(scopeOf(req), async (tx) =>
          getDraft(tx, { workspaceId: req.session.workspaceId, userId: req.session.userId, runId: params.data.runId, taskId: params.data.taskId }),
        );
        if (draft === null) {
          return reply.code(404).send({ error: "draft_not_found", message: "没有已保存的草稿" });
        }
        return reply.header("Cache-Control", "no-store").send(draft);
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...err.recoveryData });
        }
        throw err;
      }
    },
  );

  // DELETE /learning-runs/:runId/tasks/:taskId/draft
  app.delete<{ Params: { runId: string; taskId: string } }>(
    "/learning-runs/:runId/tasks/:taskId/draft",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = taskDraftParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("run/task id 非法");
      try {
        await withWorkspaceTransaction(scopeOf(req), async (tx) =>
          deleteDraft(tx, { workspaceId: req.session.workspaceId, userId: req.session.userId, runId: params.data.runId, taskId: params.data.taskId }),
        );
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // POST /learning-runs/:runId/tasks/:taskId/submissions — 原子锁定 + 排队评估。
  app.post<{ Params: { runId: string; taskId: string } }>(
    "/learning-runs/:runId/tasks/:taskId/submissions",
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (runRateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:run:submit`, RUN_WRITE_LIMITS.submitPerMinute, 60_000)) return;
      const params = taskDraftParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("run/task id 非法");
      const body = parseBody(app, submitTaskArtifactSchema, req.body);
      try {
        const receipt = await withWorkspaceTransaction(scopeOf(req), async (tx) =>
          submitArtifact(tx, {
            workspaceId: req.session.workspaceId,
            userId: req.session.userId,
            runId: params.data.runId,
            taskId: params.data.taskId,
            request: body,
          }),
        );
        // 方案 16 §20：task_presented → artifact_locked 转化（receipt 不含 variant
        // purpose；变体维度以 task_presented 的授权上限为准）。
        // F7（round-4）：此热路径每次请求只发 1 条事件（无“同请求多处埋点”可合并），
        // 故不再 await 阻塞 response（原在 reply.send 前加一个独立事务 RTT + 占用
        // 连接池 slot）。改为 fire-and-forget：recordLearningMetric 内部已 try/catch
        // 静默失败，void 不会产生 unhandled rejection，语义与 run-create 的尽力而为一致。
        // PERF-A#10：经有界队列（在途/排队上限 + 溢出丢弃）加背压，防高流量堆积。
        enqueueLearningMetric(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          {
            eventType: "artifact_locked",
            runId: params.data.runId,
            taskId: params.data.taskId,
          },
        );
        return reply.code(202).header("Cache-Control", "no-store").send(receipt);
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...err.recoveryData });
        }
        throw err;
      }
    },
  );

  // POST /learning-runs/:runId/actions — 严格 action union。
  app.post<{ Params: { runId: string } }>(
    "/learning-runs/:runId/actions",
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (runRateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:run:action`, RUN_WRITE_LIMITS.actionPerMinute, 60_000)) return;
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      const body = parseBody(app, learningRunActionRequestSchema, req.body);
      try {
        const result = await withWorkspaceTransaction(scopeOf(req), async (tx) =>
          applyAction(tx, {
            workspaceId: req.session.workspaceId,
            userId: req.session.userId,
            runId: params.data.runId,
            runRevision: body.runRevision,
            runtimeEpoch: body.runtimeEpoch,
            taskRevision: body.taskRevision,
            action: body.action,
            idempotencyKey: body.idempotencyKey,
          }),
        );
        // 方案 16 §20：行为 funnel（hint 曝光/变体切换/skip/pause 等）。
        const actionKind = result.hint
          ? "hint_revealed"
          : result.previousVariantId !== undefined
            ? "variant_switched"
            : body.action.kind;
        // F7（round-4）：同 artifact_locked，每次请求仅 1 条事件，改 fire-and-forget
        // 释放 response 前的连接池 slot（recordLearningMetric 内部静默吞错，void 安全）。
        // PERF-A#10：经有界队列（在途/排队上限 + 溢出丢弃）加背压，防高流量堆积。
        enqueueLearningMetric(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          {
            eventType: "action",
            runId: params.data.runId,
            taskId: result.snapshot.activeTask?.taskId ?? undefined,
            actionKind,
            variantPurpose: result.hint ? `hint_level_${result.hint.level}` : undefined,
          },
        );
        return reply.code(200).header("Cache-Control", "no-store").send({
          version: 1,
          acceptedActionId: result.acceptedActionId,
          actionResult: result.hint
            ? { kind: "hint_revealed", ...result.hint, resultingTrustCeiling: "practice_only" }
            : result.previousVariantId !== undefined
              ? { kind: "variant_switched", previousVariantId: result.previousVariantId, activeVariantId: result.activeVariantId }
              : { kind: "state_changed" },
          snapshot: result.snapshot,
        });
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...err.recoveryData });
        }
        throw err;
      }
    },
  );

  // GET /learning-runs/:runId/result — 学习结算 / 202。
  app.get<{ Params: { runId: string } }>(
    "/learning-runs/:runId/result",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      try {
        const result = await withWorkspaceTransaction(scopeOf(req), async (tx) =>
          getResultPayload(tx, { workspaceId: req.session.workspaceId, userId: req.session.userId, runId: params.data.runId }),
        );
        return reply.code(result.httpStatus).header("Cache-Control", "no-store").send(result);
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // GET /learning-runs/:runId/return-contract — 返回持久语义。
  app.get<{ Params: { runId: string } }>(
    "/learning-runs/:runId/return-contract",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      try {
        const contract = await withWorkspaceTransaction(scopeOf(req), async (tx) =>
          getReturnContract(tx, { workspaceId: req.session.workspaceId, userId: req.session.userId, runId: params.data.runId }),
        );
        return reply.header("Cache-Control", "no-store").send(contract);
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // POST /learning-runs/:runId/activity-lease — §13.3 每 15 秒续租。
  app.post<{ Params: { runId: string } }>(
    "/learning-runs/:runId/activity-lease",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      const body = parseBody(app, activityLeaseBodySchema, req.body);
      try {
        await withWorkspaceTransaction(scopeOf(req), async (tx) =>
          recordActivityLease(tx, {
            workspaceId: req.session.workspaceId,
            userId: req.session.userId,
            runId: params.data.runId,
            deviceSessionId: body.deviceSessionId,
            startedAt: body.startedAt,
            endedAt: body.endedAt,
          }),
        );
        return reply.code(204).header("Cache-Control", "no-store").send();
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
}
