/**
 * LearningRun API 路由（文档 16 §13.1）。
 *
 * 端点（全部 requireSession；RLS 上下文由 withWorkspaceTransaction 设置）：
 * - POST   /learning-runs                                 创建并 PREPARE Run
 * - GET    /learning-runs/:runId/events                   SSE（Last-Event-ID 重放）
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
  learningTaskDraftSchema,
  learningTaskDraftWriteReceiptSchema,
  submitTaskArtifactReceiptSchema,
} from "@ailearn/shared";
import {
  applyAction,
  createRunV2,
  getDraft,
  getEventsAfter,
  getResultPayloadV2,
  getReturnContractV2,
  getLearningRunPublicSnapshotV2,
  getLearningRunPublicSnapshotV2FromView,
  recordActivityLease,
  putDraft,
  revealRunTargetV2,
  submitArtifact,
} from "./run-service.ts";
import { wakeLearningRunProcessing } from "./run-processing-tick.ts";
import { createLearningRunV2RequestSchema } from "@ailearn/shared";
import { LearningRunServiceError } from "./run-errors.ts";
import { safeSseWrite } from "../../lib/safe-sse-write.ts";
import { companionRateLimit } from "../companion-conversation/companion-rate-limit.ts";
// 方案 16 §20：学习漏斗埋点（服务端权威写入，尽力而为）。
import { recordLearningMetric, insertLearningMetricEvent, type LearningMetricEventV1, type LearningMetricScope } from "../observability/learning-metrics.ts";
import { isLearningRunEnabled } from "../../config/learning-companion-flags.ts";
import {
  learningRunActionRequestV2Schema,
  learningRunActionResponseV2Schema,
  learningRunPublicSnapshotV2Schema,
  putLearningTaskDraftRequestV2Schema,
  learningTaskDraftV2Schema,
  learningTaskDraftWriteReceiptV2Schema,
  recordLearningRunActivityLeaseRequestV2Schema,
  submitTaskArtifactV2Schema,
  submitTaskArtifactReceiptV2Schema,
} from "@ailearn/shared";

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

type V2Snapshot = z.infer<typeof learningRunPublicSnapshotV2Schema>;

// The service ledger receipt carries the original runRevision; the public
// receipt stays strict and exposes the current V2 wire shape only.
const learningTaskDraftWriteReceiptServiceSchema = learningTaskDraftWriteReceiptSchema.extend({
  runRevision: z.number().int().min(1).optional(),
});

function requireV2SnapshotBinding(snapshot: V2Snapshot, snapshotId: string): void {
  if (snapshot.snapshotId !== snapshotId || snapshot.runId.length === 0) {
    throw new LearningRunServiceError("context_stale", "V2 snapshot binding 已失效", 409);
  }
}

function parseServiceValue<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new LearningRunServiceError("unsupported_contract", `${label} 不是 canonical service 形状`, 409);
  return parsed.data;
}

function isV2ActionAllowed(
  snapshot: V2Snapshot,
  action: z.infer<typeof learningRunActionRequestV2Schema>["action"],
): boolean {
  return snapshot.allowedActions.some((allowed) => {
    switch (allowed.kind) {
      case "pause":
      case "resume":
      case "skip_run":
      case "finish_current_evidence":
      case "finish_without_commit":
      case "retry_prepare":
      case "retry_commit":
        return action.kind === allowed.kind;
      case "switch_variant":
        return action.kind === "switch_variant" && action.alternativeId === allowed.alternativeId;
      case "request_hint":
        return action.kind === "request_hint" && action.level === allowed.level;
      case "activate_followup":
        return action.kind === "activate_followup" && action.followupId === allowed.followupId;
      case "retry_assessment":
        return action.kind === "retry_assessment" && action.assessmentId === allowed.assessmentId;
      case "end":
        return action.kind === "end" && action.abandonLockedEvidence === allowed.abandonLockedEvidence;
    }
  });
}

// 运维护栏（2026-08-15 审计）：learning-runs 写端点此前无限流——高频
// create/submit 会持续排满评估任务队列。与 companion 限流同模式（内存
// 固定窗口 per (workspace,user) + bucket；单实例部署语义）。
const RUN_WRITE_LIMITS = {
  createPerMinute: 20,
  submitPerMinute: 60,
  actionPerMinute: 120,
  draftPerMinute: 120,
  // M8（2026-08-24 审查）：activity-lease 每次调用都拿 run 行锁 + 两条 DELETE，
  // 客户端正常节奏是每 15s 一次；此前无限流，高频调用可放大锁竞争与 DB 消耗。
  leasePerMinute: 60,
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
  // LearningRun capability 门控：同一次切换原子开启（§22.2）。
  // 未开启时全部端点 404 fail closed。
  app.addHook("onRequest", async (_req, reply) => {
    if (!isLearningRunEnabled()) {
      return reply.code(404).send({
        error: "learning_run_disabled",
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
    const body = parseBody(app, createLearningRunV2RequestSchema, req.body);
    try {
      const snapshot = await withWorkspaceTransaction(scopeOf(req), async (tx) => {
        const result = await createRunV2(tx, {
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          request: body,
        });
        const created = await getLearningRunPublicSnapshotV2(tx, {
          workspaceId: req.session.workspaceId,
          userId: req.session.userId,
          runId: result.runId,
        });
        // §20 / 16.2 G2：run-routes create 必须写入 funnel 第一层两类事件
        // （run_created = origin×goal；task_presented = intent×interaction.kind×
        // variant.purpose×templateTrustCeiling）。此前只声明了事件类型却从未发射，
        // funnel 第一层恒为空。这里在**创建事务内**写入（insertLearningMetricEvent
        // 即为此提供）：201 返回即代表事件已持久化，避免 fire-and-forget 队列与断言/
        // dashboard 竞争；每个 run 恒定两行，不构成 §20 背压顾虑。
        await insertLearningMetricEvent(tx, scopeOf(req), {
          eventType: "run_created",
          runId: created.runId,
          origin: body.originV2,
          goal: body.goal,
          activeSecondsUsed: body.requestedTimeBudgetSeconds,
        });
        if (created.activeTask) {
          await insertLearningMetricEvent(tx, scopeOf(req), {
            eventType: "task_presented",
            runId: created.runId,
            taskId: created.activeTask.taskId,
            intent: created.activeTask.intent,
            interactionKind: created.activeTask.activeVariant.interaction.kind,
            variantPurpose: created.activeTask.activeVariant.purpose,
            trustClass: created.activeTask.activeVariant.templateTrustCeiling,
          });
        }
        return created;
      });
      // §16.1/§16.3：创建与后续 GET 使用同一 public snapshot 形状；
      // canonicalAnswer/scoringRubric/evidence/planningExposure 不出 server。
      return reply.code(201).header("Cache-Control", "no-store").send(snapshot);
    } catch (err) {
      if (err instanceof LearningRunServiceError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...err.recoveryData });
      }
      throw err;
    }
  });

  // ─── Explicit V2 wire endpoints ───────────────────────────────────────
  app.get<{ Params: { runId: string } }>(
    "/learning-runs/:runId/v2",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      try {
        const snapshot = await withWorkspaceTransaction(scopeOf(req), (tx) =>
          getLearningRunPublicSnapshotV2(tx, {
            workspaceId: req.session.workspaceId,
            userId: req.session.userId,
            runId: params.data.runId,
          }),
        );
        // L8（2026-08-24 审查）：ETag 必须可协商——此前只发不校验
        // If-None-Match，每次全量 200（头形同虚设）。runRevision 是公开快照的
        // 稳定版本号，未变即 304（与 projection-routes 的 ETag 写法一致）。
        const etag = `"${snapshot.runRevision}"`;
        if (req.headers["if-none-match"] === etag) {
          return reply.code(304).header("ETag", etag).header("Cache-Control", "no-store").send();
        }
        return reply
          .header("ETag", etag)
          .header("Cache-Control", "no-store")
          .send(snapshot);
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/learning-runs/:runId/result/v2",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      try {
        const result = await withWorkspaceTransaction(scopeOf(req), (tx) =>
          getResultPayloadV2(tx, {
            workspaceId: req.session.workspaceId,
            userId: req.session.userId,
            runId: params.data.runId,
          }),
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

  // POST /learning-runs/:runId/reveal/v2 —— 答后揭示（2026-09-18）
  app.post<{ Params: { runId: string } }>(
    "/learning-runs/:runId/reveal/v2",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      try {
        const reveal = await withWorkspaceTransaction(scopeOf(req), (tx) =>
          revealRunTargetV2(tx, {
            workspaceId: req.session.workspaceId,
            userId: req.session.userId,
            runId: params.data.runId,
          }),
        );
        return reply.code(200).header("Cache-Control", "no-store").send(reveal);
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/learning-runs/:runId/return-contract/v2",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      try {
        const contract = await withWorkspaceTransaction(scopeOf(req), (tx) =>
          getReturnContractV2(tx, {
            workspaceId: req.session.workspaceId,
            userId: req.session.userId,
            runId: params.data.runId,
          }),
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

  app.put<{ Params: { runId: string; taskId: string } }>(
    "/learning-runs/:runId/tasks/:taskId/draft/v2",
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (runRateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:run:draft`, RUN_WRITE_LIMITS.draftPerMinute, 60_000)) return;
      const params = taskDraftParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("run/task id 非法");
      const body = parseBody(app, putLearningTaskDraftRequestV2Schema, req.body);
      try {
        const receipt = await withWorkspaceTransaction(scopeOf(req), async (tx) => {
          const snapshot = await getLearningRunPublicSnapshotV2(tx, { ...scopeOf(req), runId: params.data.runId });
          requireV2SnapshotBinding(snapshot, body.snapshotId);
          const raw = await putDraft(tx, {
            ...scopeOf(req),
            runId: params.data.runId,
            taskId: params.data.taskId,
            variantId: body.variantId,
            variantRevision: body.variantRevision,
            taskRevision: body.taskRevision,
            expectedDraftRevision: body.expectedDraftRevision,
            payload: body.payload,
            rendererState: body.rendererState,
            idempotencyKey: body.idempotencyKey,
            requestContext: { version: 2, snapshotId: body.snapshotId },
            assertDraftAllowed: () => {
              if (snapshot.activeTask?.taskId !== params.data.taskId) {
                throw new LearningRunServiceError("task_not_active", "该任务不是当前任务", 409);
              }
            },
          });
          const parsed = parseServiceValue(learningTaskDraftWriteReceiptServiceSchema, raw, "draft receipt");
          return learningTaskDraftWriteReceiptV2Schema.parse({
            version: 2,
            runId: parsed.runId,
            snapshotId: snapshot.snapshotId,
            taskId: parsed.taskId,
            variantId: parsed.variantId,
            // Keep the revision from the original ledger receipt on exact
            // replay. Falling back to the current snapshot only covers old
            // V2 ledger rows created before this metadata was persisted.
            runRevision: parsed.runRevision ?? snapshot.runRevision,
            taskRevision: parsed.taskRevision,
            draftRevision: parsed.draftRevision,
            savedAt: parsed.savedAt,
            expiresAt: parsed.expiresAt,
          });
        });
        return reply.header("Cache-Control", "no-store").send(receipt);
      } catch (err) {
        if (err instanceof LearningRunServiceError) return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...err.recoveryData });
        throw err;
      }
    },
  );

  app.get<{ Params: { runId: string; taskId: string } }>(
    "/learning-runs/:runId/tasks/:taskId/draft/v2",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = taskDraftParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("run/task id 非法");
      try {
        const draft = await withWorkspaceTransaction(scopeOf(req), async (tx) => {
          const snapshot = await getLearningRunPublicSnapshotV2(tx, { ...scopeOf(req), runId: params.data.runId });
          const raw = await getDraft(tx, { ...scopeOf(req), runId: params.data.runId, taskId: params.data.taskId });
          if (raw === null) return null;
          const parsed = parseServiceValue(learningTaskDraftSchema, raw, "draft");
          if (parsed.runId !== params.data.runId || parsed.taskId !== params.data.taskId) {
            throw new LearningRunServiceError("unsupported_contract", "draft scope 与 route 不一致", 409);
          }
          return learningTaskDraftV2Schema.parse({ ...parsed, version: 2, snapshotId: snapshot.snapshotId });
        });
        if (draft === null) return reply.code(404).send({ error: "draft_not_found", message: "没有已保存的草稿" });
        return reply.header("Cache-Control", "no-store").send(draft);
      } catch (err) {
        if (err instanceof LearningRunServiceError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        throw err;
      }
    },
  );

  app.post<{ Params: { runId: string; taskId: string } }>(
    "/learning-runs/:runId/tasks/:taskId/submissions/v2",
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (runRateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:run:submit`, RUN_WRITE_LIMITS.submitPerMinute, 60_000)) return;
      const params = taskDraftParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("run/task id 非法");
      const body = parseBody(app, submitTaskArtifactV2Schema, req.body);
      try {
        const receipt = await withWorkspaceTransaction(scopeOf(req), async (tx) => {
          const snapshot = await getLearningRunPublicSnapshotV2(tx, { ...scopeOf(req), runId: params.data.runId });
          requireV2SnapshotBinding(snapshot, body.snapshotId);
          const raw = await submitArtifact(tx, {
            ...scopeOf(req),
            runId: params.data.runId,
            taskId: params.data.taskId,
            request: {
              version: 1,
              variantId: body.variantId,
              variantRevision: body.variantRevision,
              runRevision: body.runRevision,
              taskRevision: body.taskRevision,
              inputSchemaHash: body.inputSchemaHash,
              payload: body.payload,
              ...(body.baseArtifactId ? { baseArtifactId: body.baseArtifactId } : {}),
              ...(body.baseRevision !== undefined ? { baseRevision: body.baseRevision } : {}),
              idempotencyKey: body.idempotencyKey,
            },
            requestContext: { version: 2, snapshotId: body.snapshotId },
          });
          const parsed = parseServiceValue(submitTaskArtifactReceiptSchema, raw, "artifact receipt");
          return submitTaskArtifactReceiptV2Schema.parse({ ...parsed, version: 2, snapshotId: snapshot.snapshotId });
        });
        // 提交就是"该去打分了"的明确信号：喊一声让处理循环立刻跑一轮，
        // 而不是让用户在 10 秒轮询的节奏里干等（复盘 #6）。必须在事务外调用，
        // 否则唤醒的那轮看不到刚提交的 outbox 行。
        wakeLearningRunProcessing();
        enqueueLearningMetric(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          { eventType: "artifact_locked", runId: params.data.runId, taskId: params.data.taskId },
        );
        return reply.code(202).header("Cache-Control", "no-store").send(receipt);
      } catch (err) {
        if (err instanceof LearningRunServiceError) return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...err.recoveryData });
        throw err;
      }
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/learning-runs/:runId/actions/v2",
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (runRateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:run:action`, RUN_WRITE_LIMITS.actionPerMinute, 60_000)) return;
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      const body = parseBody(app, learningRunActionRequestV2Schema, req.body);
      try {
        const response = await withWorkspaceTransaction(scopeOf(req), async (tx) => {
          const before = await getLearningRunPublicSnapshotV2(tx, { ...scopeOf(req), runId: params.data.runId });
          requireV2SnapshotBinding(before, body.snapshotId);
          const result = await applyAction(tx, {
            ...scopeOf(req),
            runId: params.data.runId,
            runRevision: body.runRevision,
            runtimeEpoch: body.runtimeEpoch,
            taskRevision: body.taskRevision,
            action: body.action,
            idempotencyKey: body.idempotencyKey,
            requestContext: { version: 2, snapshotId: body.snapshotId },
            assertActionAllowed: () => {
              if (!isV2ActionAllowed(before, body.action)) {
                throw new LearningRunServiceError("action_not_allowed", "该 action 不在服务端签发的允许集合中", 409);
              }
            },
          });
          const snapshot = await getLearningRunPublicSnapshotV2FromView(
            tx,
            { ...scopeOf(req), runId: params.data.runId },
            result.snapshot,
          );
          const actionResult = result.hint
            ? { kind: "hint_revealed" as const, ...result.hint, resultingTrustCeiling: "practice_only" as const }
            : result.previousVariantId !== undefined
              ? { kind: "variant_switched" as const, previousVariantId: result.previousVariantId, activeVariantId: result.activeVariantId ?? "" }
              : { kind: "state_changed" as const };
          return learningRunActionResponseV2Schema.parse({
            version: 2,
            runId: snapshot.runId,
            snapshotId: snapshot.snapshotId,
            originV2: snapshot.originV2,
            acceptedActionId: result.acceptedActionId,
            actionResult,
            snapshot,
          });
        });
        // retry_assessment / retry_commit / retry_prepare 都是"该重新干活了"的信号，
        // 同样不该等 10 秒轮询（复盘 #6）。这里不按 action 类型枚举：多喊一轮的代价
        // 只是一条 claim 查询（FOR UPDATE SKIP LOCKED，无活即空转），而一份类型清单
        // 会随 service 新增入队分支而失真。必须在事务外调用。
        wakeLearningRunProcessing();
        return reply.header("Cache-Control", "no-store").send(response);
      } catch (err) {
        if (err instanceof LearningRunServiceError) return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...err.recoveryData });
        throw err;
      }
    },
  );

  app.post<{ Params: { runId: string } }>(
    "/learning-runs/:runId/activity-lease/v2",
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (runRateLimited(reply, req.id, `${req.session.workspaceId}:${req.session.userId}:run:lease`, RUN_WRITE_LIMITS.leasePerMinute, 60_000)) return;
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      const body = parseBody(app, recordLearningRunActivityLeaseRequestV2Schema, req.body);
      try {
        await withWorkspaceTransaction(scopeOf(req), async (tx) => {
          const snapshot = await getLearningRunPublicSnapshotV2(tx, { ...scopeOf(req), runId: params.data.runId });
          requireV2SnapshotBinding(snapshot, body.snapshotId);
          if (snapshot.runRevision !== body.runRevision || snapshot.runtimeEpoch !== body.runtimeEpoch) {
            throw new LearningRunServiceError("context_stale", "activity lease 的 run revision/epoch 已过期", 409);
          }
          await recordActivityLease(tx, {
            ...scopeOf(req),
            runId: params.data.runId,
            deviceSessionId: body.deviceSessionId,
            startedAt: body.startedAt,
            endedAt: body.endedAt,
          });
        });
        return reply.code(204).header("Cache-Control", "no-store").send();
      } catch (err) {
        if (err instanceof LearningRunServiceError) return reply.code(err.statusCode).send({ error: err.code, message: err.message, ...err.recoveryData });
        throw err;
      }
    },
  );

  // GET /learning-runs/:runId/events — SSE；Last-Event-ID = 最后收到的 sequence。
  app.get<{ Params: { runId: string }; Querystring: { lastEventId?: string; snapshotId?: string } }>(
    "/learning-runs/:runId/events",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const params = runParamsSchema.safeParse(req.params);
      if (!params.success) throw app.httpErrors.badRequest("runId 非法");
      const scope = scopeOf(req);
      const parsedSnapshotId = z.string().uuid().safeParse(req.query?.snapshotId);
      if (!parsedSnapshotId.success) throw app.httpErrors.badRequest("snapshotId 非法");
      try {
        await withWorkspaceTransaction(scope, async (tx) => {
          const snapshot = await getLearningRunPublicSnapshotV2(tx, { ...scope, runId: params.data.runId });
          requireV2SnapshotBinding(snapshot, parsedSnapshotId.data);
        });
      } catch (err) {
        if (err instanceof LearningRunServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
      // Browser EventSource traditionally uses Last-Event-ID; query remains
      // supported for existing clients and deterministic integration probes.
      const headerLastEventId = req.headers["last-event-id"];
      const lastEventId = Array.isArray(headerLastEventId) ? headerLastEventId[0] : headerLastEventId;
      const afterSequence = Number(req.query?.lastEventId ?? lastEventId ?? 0);
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
      let closed = false;
      let cursor = afterSequence;
      // socket 级错误（EPIPE/ECONNRESET）必须吞掉：未处理会冒泡为
      // unhandled error 并可能在 fastify 错误链产生 500。
      reply.raw.on("error", (err) => {
        stopStream();
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
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      const stopStream = (): void => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
      };
      const schedulePoll = () => {
        if (interval) clearInterval(interval);
        interval = setInterval(pollEvents, pollIntervalMs);
        interval?.unref();
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
              if (!closed) {
                const accepted = safeSseWrite(
                  reply.raw,
                  `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`,
                );
                if (!accepted) {
                  // 不推进 cursor；客户端重连时从上一条确认过的事件继续，允许重复但不丢失。
                  stopStream();
                  break;
                }
                cursor = event.sequence;
                emittedAny = true;
              }
            }
            if (closed) break;
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
          stopStream();
          req.log.warn({ err }, "learning-run events stream error");
        } finally {
          polling = false;
        }
      };
      interval = setInterval(pollEvents, pollIntervalMs);
      interval?.unref();
      // PERF-B6 修复：加 15s heartbeat comment，防止 idle 长连接被代理空闲超时切断
      //（对齐 companion-events.ts 的保活写法）。
      heartbeatTimer = setInterval(() => {
        if (!closed) {
          if (!safeSseWrite(reply.raw, `: heartbeat ${Date.now()}\n\n`)) stopStream();
        }
      }, 15_000);
      heartbeatTimer?.unref();
      reply.raw.on("close", () => {
        stopStream();
      });
      return reply;
    },
  );

}
