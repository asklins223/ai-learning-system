/**
 * QUAL-02 拆分：Unit 和 Job 创建辅助函数。
 *
 * 此前这些函数内联在 card-supervisor-agent.ts 底部（约 240 行），
 * 现提取到独立模块以降低主文件复杂度。
 *
 * 包含：
 * - persistSessionState: 持久化 AgentSession 状态
 * - createVerifyUnit: 创建 deterministic_verify unit
 * - createSupervisorUnit: 创建 Supervisor agent_run unit
 * - createPublishUnit: 创建 publish unit
 * - createNextTurnJob: 创建下一个 Agent turn 的 job
 * - handleTurnResult: 处理 turn 结果，决定后续动作
 */

import { and, eq, ne } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  AgentUnitKind,
  JobStatus,
  JobType,
  SupervisorRunStatus,
  isRunErrorRetryable,
} from "@ailearn/shared";
import { logger } from "../lib/logger.ts";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import {
  lockJobLease,
  withJobTransaction,
  type JobLeaseContext,
} from "../lib/job-lease.ts";
import type { JobPayload } from "../handlers/index.ts";
import type { AgentSession } from "./session.ts";
import type {
  AgentJobPayload,
  AgentTurnExecutionResult,
  RunContext,
} from "./types.ts";

/** 持久化 AgentSession 状态到数据库 */
export async function persistSessionState(
  job: JobPayload,
  payload: AgentJobPayload,
  session: AgentSession,
  lease: JobLeaseContext,
): Promise<void> {
  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, lease);
    await tx.update(schema.cardGenerationUnits).set({
      cursorJson: session.toCursorJson(),
      usageJson: session.toUsageJson(),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.cardGenerationUnits.id, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
    ));
  });
}

/** 创建 deterministic_verify unit */
export async function createVerifyUnit(
  job: JobPayload,
  payload: AgentJobPayload,
  _runContext: Extract<RunContext, { kind: "active" }>,
): Promise<string> {
  const now = new Date();
  // P1-2 should-fix(评审):加 onConflictDoNothing 幂等。P1-2 的 autoProgressAfterChildUnit
  // 与旧路径(scheduleNextTurn complete)可能并发创建同 key(verify:{runId})的 unit,
  // 无 onConflict 会撞唯一键(card_generation_units_run_unit_key_unique_idx)抛错。
  const [unit] = await db
    .insert(schema.cardGenerationUnits)
    .values({
      workspaceId: job.workspaceId,
      runId: payload.generationRunId,
      kind: AgentUnitKind.DETERMINISTIC_VERIFY,
      level: 0,
      ordinal: 98,
      unitKey: `verify:${payload.generationRunId}`,
      required: true,
      inputManifest: {},
      inputHash: payload.inputHash,
      tokenEstimate: 0,
      status: "pending",
      scheduledAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (unit) {
    return unit.id;
  }

  // 幂等命中：并发下已存在 verify unit，返回既有 id（调用方 createNextTurnJob 幂等）。
  const [existing] = await db
    .select({ id: schema.cardGenerationUnits.id })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      eq(schema.cardGenerationUnits.runId, payload.generationRunId),
      eq(schema.cardGenerationUnits.unitKey, `verify:${payload.generationRunId}`),
    ))
    .limit(1);

  if (existing) {
    return existing.id;
  }

  throw new Error("无法创建 verify unit");
}

/** 创建 Supervisor agent_run unit */
export async function createSupervisorUnit(
  job: JobPayload,
  payload: AgentJobPayload,
  _runContext: Extract<RunContext, { kind: "active" }>,
  density: "overview" | "standard" | "complete" = "standard",
): Promise<string> {
  const now = new Date();

  // 冲突修复（retry/恢复重跑 prepare）：supervisor unit 的唯一身份是
  // (run_id, kind=agent_run, level=0, ordinal=1)。run 被 retry 或恢复检查点
  // 时 prepare 会重跑，若上次已创建过 supervisor unit（如 terminal_failed），
  // 直接 insert 会撞 card_generation_units_identity_unique_idx。
  // 语义：已存在则复用——非终态保持，终态重置为 pending（重跑）。
  const [existing] = await db
    .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.runId, payload.generationRunId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      eq(schema.cardGenerationUnits.kind, AgentUnitKind.AGENT_RUN),
      eq(schema.cardGenerationUnits.level, 0),
      eq(schema.cardGenerationUnits.ordinal, 1),
    ))
    .limit(1);

  if (existing) {
    if (existing.status !== "pending" && existing.status !== "running") {
      await db
        .update(schema.cardGenerationUnits)
        .set({
          status: "pending",
          scheduledAt: now,
          finishedAt: null,
          errorCode: null,
          updatedAt: now,
        })
        .where(and(
          eq(schema.cardGenerationUnits.id, existing.id),
          eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        ));
    }
    return existing.id;
  }

  const [unit] = await db
    .insert(schema.cardGenerationUnits)
    .values({
      workspaceId: job.workspaceId,
      runId: payload.generationRunId,
      kind: AgentUnitKind.AGENT_RUN,
      level: 0,
      ordinal: 1,
      unitKey: `supervisor:${payload.generationRunId}`,
      required: true,
      inputManifest: {
        agentRole: "generation_supervisor",
        density,
        depth: 0,
        turnNo: 1,
      } as Record<string, unknown>,
      inputHash: payload.inputHash,
      tokenEstimate: 0,
      status: "pending",
      scheduledAt: now,
    })
    .returning();

  if (!unit) {
    throw new Error("无法创建 Supervisor agent_run unit");
  }

  return unit.id;
}

/** 创建 publish unit */
export async function createPublishUnit(
  job: JobPayload,
  payload: AgentJobPayload,
  _runContext: Extract<RunContext, { kind: "active" }>,
): Promise<string> {
  const now = new Date();
  const [unit] = await db
    .insert(schema.cardGenerationUnits)
    .values({
      workspaceId: job.workspaceId,
      runId: payload.generationRunId,
      kind: AgentUnitKind.PUBLISH,
      level: 0,
      ordinal: 99,
      unitKey: `publish:${payload.generationRunId}`,
      required: true,
      inputManifest: {},
      inputHash: payload.inputHash,
      tokenEstimate: 0,
      status: "pending",
      scheduledAt: now,
    })
    .returning();

  if (!unit) {
    throw new Error("无法创建 publish unit");
  }

  return unit.id;
}

/** P3 Planned 路径:创建 Initial Plan unit(身份 (run, supervisor_plan, 0, 10),幂等) */
export async function createPlanUnit(
  job: JobPayload,
  payload: AgentJobPayload,
): Promise<string> {
  const now = new Date();
  const unitKey = `plan:${payload.generationRunId}`;
  const [existing] = await db
    .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.runId, payload.generationRunId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      eq(schema.cardGenerationUnits.unitKey, unitKey),
    ))
    .limit(1);
  if (existing) {
    if (existing.status !== "pending" && existing.status !== "running") {
      await db
        .update(schema.cardGenerationUnits)
        .set({ status: "pending", scheduledAt: now, updatedAt: now })
        .where(eq(schema.cardGenerationUnits.id, existing.id));
    }
    return existing.id;
  }
  const [unit] = await db
    .insert(schema.cardGenerationUnits)
    .values({
      workspaceId: job.workspaceId,
      runId: payload.generationRunId,
      parentUnitId: null,
      kind: AgentUnitKind.SUPERVISOR_PLAN,
      level: 0,
      ordinal: 10,
      unitKey,
      required: true,
      inputManifest: {},
      inputHash: createHash("sha256").update(`plan:${payload.generationRunId}`).digest("hex"),
      tokenEstimate: 0,
      status: "pending",
      scheduledAt: now,
    })
    .returning();
  if (!unit) throw new Error("无法创建 plan unit");
  return unit.id;
}

/**
 * P2 Fast 路径:P2-1 Router 判定 fast 时创建 FAST_EXTRACT unit。
 * 身份:(run, kind=fast_extract, level=0, ordinal=10),幂等复用(与 createSupervisorUnit 同模式)。
 */
export async function createFastExtractUnit(
  job: JobPayload,
  payload: AgentJobPayload,
  density: "overview" | "standard" | "complete" = "standard",
): Promise<string> {
  const now = new Date();
  const unitKey = `fast_extract:${payload.generationRunId}`;
  const [existing] = await db
    .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.runId, payload.generationRunId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      eq(schema.cardGenerationUnits.unitKey, unitKey),
    ))
    .limit(1);
  if (existing) {
    if (existing.status !== "pending" && existing.status !== "running") {
      await db
        .update(schema.cardGenerationUnits)
        .set({ status: "pending", scheduledAt: now, updatedAt: now })
        .where(eq(schema.cardGenerationUnits.id, existing.id));
    }
    return existing.id;
  }
  const [unit] = await db
    .insert(schema.cardGenerationUnits)
    .values({
      workspaceId: job.workspaceId,
      runId: payload.generationRunId,
      parentUnitId: null,
      kind: AgentUnitKind.FAST_EXTRACT,
      level: 0,
      ordinal: 10,
      unitKey,
      required: true,
      inputManifest: { density },
      inputHash: createHash("sha256").update(`fast_extract:${payload.generationRunId}`).digest("hex"),
      tokenEstimate: 0,
      status: "pending",
      scheduledAt: now,
    })
    .returning();
  if (!unit) throw new Error("无法创建 fast_extract unit");
  return unit.id;
}

/** P2 Fast 路径:FAST_EXTRACT 完成后创建 FAST_COMPOSE unit(身份 (run, fast_compose, 0, 20)) */
export async function createFastComposeUnit(
  job: JobPayload,
  payload: AgentJobPayload,
): Promise<string> {
  const now = new Date();
  const unitKey = `fast_compose:${payload.generationRunId}`;
  const [existing] = await db
    .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.runId, payload.generationRunId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      eq(schema.cardGenerationUnits.unitKey, unitKey),
    ))
    .limit(1);
  if (existing) {
    if (existing.status !== "pending" && existing.status !== "running") {
      await db
        .update(schema.cardGenerationUnits)
        .set({ status: "pending", scheduledAt: now, updatedAt: now })
        .where(eq(schema.cardGenerationUnits.id, existing.id));
    }
    return existing.id;
  }
  const [unit] = await db
    .insert(schema.cardGenerationUnits)
    .values({
      workspaceId: job.workspaceId,
      runId: payload.generationRunId,
      parentUnitId: null,
      kind: AgentUnitKind.FAST_COMPOSE,
      level: 0,
      ordinal: 20,
      unitKey,
      required: true,
      inputManifest: {},
      inputHash: createHash("sha256").update(`fast_compose:${payload.generationRunId}`).digest("hex"),
      tokenEstimate: 0,
      status: "pending",
      scheduledAt: now,
    })
    .returning();
  if (!unit) throw new Error("无法创建 fast_compose unit");
  return unit.id;
}

/**
 * P3 Planned 路径:创建单个 Specialist DAG unit(§3.2, P3-4)。
 * 身份:(run, planned_specialist, 0, ordinal=30+wave*10+bundleIdx),幂等;
 * parentUnitId=plan unit(等待机制由 P1-4 的 child-complete 推进驱动)。
 */
export async function createPlannedSpecialistUnit(
  job: JobPayload,
  payload: AgentJobPayload,
  planUnitId: string,
  input: {
    planVersion: number;
    bundleId: string;
    specialist: "text_extractor" | "code_extractor" | "vision_specialist";
    extractionFocus: string;
    relatedBundleIds: string[];
    waveNo: number;
    bundleOrdinal: number;
    replanVersion: number;
  },
): Promise<string> {
  const now = new Date();
  const unitKey = `planned_specialist:${payload.generationRunId}:${input.bundleId}:rv${input.replanVersion}`;
  const [existing] = await db
    .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.runId, payload.generationRunId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      eq(schema.cardGenerationUnits.unitKey, unitKey),
    ))
    .limit(1);
  if (existing) {
    if (existing.status !== "pending" && existing.status !== "running") {
      await db
        .update(schema.cardGenerationUnits)
        .set({ status: "pending", scheduledAt: now, updatedAt: now })
        .where(eq(schema.cardGenerationUnits.id, existing.id));
    }
    return existing.id;
  }
  const [unit] = await db
    .insert(schema.cardGenerationUnits)
    .values({
      workspaceId: job.workspaceId,
      runId: payload.generationRunId,
      parentUnitId: planUnitId,
      kind: AgentUnitKind.PLANNED_SPECIALIST,
      level: 0,
      ordinal: 30 + input.waveNo * 100 + input.bundleOrdinal,
      unitKey,
      required: true,
      inputManifest: {
        planVersion: input.planVersion,
        bundleId: input.bundleId,
        specialist: input.specialist,
        extractionFocus: input.extractionFocus,
        relatedBundleIds: input.relatedBundleIds,
        replanVersion: input.replanVersion,
      },
      inputHash: createHash("sha256").update(unitKey, "utf8").digest("hex"),
      tokenEstimate: 0,
      status: "pending",
      scheduledAt: now,
    })
    .returning();
  if (!unit) throw new Error("无法创建 planned_specialist unit");
  return unit.id;
}

/** P3 Planned 路径:全部 specialist 完成后创建 compose unit(身份 (run, planned_compose, 0, 200)) */
export async function createPlannedComposeUnit(
  job: JobPayload,
  payload: AgentJobPayload,
): Promise<string> {
  const now = new Date();
  const unitKey = `planned_compose:${payload.generationRunId}`;
  const [existing] = await db
    .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.runId, payload.generationRunId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      eq(schema.cardGenerationUnits.unitKey, unitKey),
    ))
    .limit(1);
  if (existing) {
    if (existing.status !== "pending" && existing.status !== "running") {
      await db
        .update(schema.cardGenerationUnits)
        .set({ status: "pending", scheduledAt: now, updatedAt: now })
        .where(eq(schema.cardGenerationUnits.id, existing.id));
    }
    return existing.id;
  }
  const [unit] = await db
    .insert(schema.cardGenerationUnits)
    .values({
      workspaceId: job.workspaceId,
      runId: payload.generationRunId,
      parentUnitId: null,
      kind: AgentUnitKind.PLANNED_COMPOSE,
      level: 0,
      ordinal: 200,
      unitKey,
      required: true,
      inputManifest: {},
      inputHash: createHash("sha256").update(`planned_compose:${payload.generationRunId}`).digest("hex"),
      tokenEstimate: 0,
      status: "pending",
      scheduledAt: now,
    })
    .returning();
  if (!unit) throw new Error("无法创建 planned_compose unit");
  return unit.id;
}

/** 创建下一个 Agent turn 的 job */
export async function createNextTurnJob(
  job: JobPayload,
  runId: string,
  unitId: string,
  turnNo: number,
): Promise<void> {
  const now = new Date();
  // 修复 D5（第5轮）：原代码使用 `turn:${turnNo}` 字符串作为 inputHash，
  // 不是 SHA-256 hash。计划 §5.2 要求 inputHash 是 turn 输入的 SHA-256 hash。
  // 修复后：使用 runId + unitId + turnNo 的 SHA-256 hash。
  const turnInputHash = createHash("sha256")
    .update(JSON.stringify({ runId, unitId, turnNo }))
    .digest("hex");
  const idempotencyKey = `agent-turn:${runId}:${unitId}:${turnNo}`;

  // 冲突修复（retry/恢复重跑）：jobs_workspace_idempotency_unique_idx 是全状态
  // 唯一（含 succeeded），而 retry 重跑 prepare/恢复检查点会为同一 (run, unit, turn)
  // 再次创建 job。直接 insert 会撞唯一键（此前表现为 "Agent turn 执行失败" +
  // duplicate key，run 被标 agent_database 并陷入新的失败循环）。
  // 语义：同 key job 已存在——非终态（pending/running）跳过（已有调度）；
  // 终态（succeeded/failed/dead）重置为 pending 复用（重跑语义）。
  const [existingJob] = await db
    .select({ id: schema.jobs.id, status: schema.jobs.status })
    .from(schema.jobs)
    .where(and(
      eq(schema.jobs.workspaceId, job.workspaceId),
      eq(schema.jobs.idempotencyKey, idempotencyKey),
    ))
    .limit(1);

  if (existingJob) {
    if (existingJob.status === JobStatus.PENDING || existingJob.status === JobStatus.RUNNING) {
      return;
    }
    await db
      .update(schema.jobs)
      .set({
        status: JobStatus.PENDING,
        attempts: 0,
        lastError: null,
        scheduledAt: now,
        startedAt: null,
        finishedAt: null,
        leaseToken: null,
        repairState: "none",
        repairAttemptCount: 0,
      })
      .where(eq(schema.jobs.id, existingJob.id));
    return;
  }

  await db
    .insert(schema.jobs)
    .values({
      type: JobType.EXECUTE_CARD_AGENT_TURN,
      workspaceId: job.workspaceId,
      requestedBy: job.requestedBy,
      payload: {
        generationRunId: runId,
        agentUnitId: unitId,
        turnNo,
        inputHash: turnInputHash,
        userId: job.requestedBy,
      },
      status: JobStatus.PENDING,
      generationRunId: runId,
      generationUnitId: unitId,
      stage: "complete",
      priority: 80,
      resourceClass: "card_foreground",
      idempotencyKey,
    })
    .returning();

  // 更新 unit 的 scheduledAt
  await db
    .update(schema.cardGenerationUnits)
    .set({ scheduledAt: now, updatedAt: now })
    .where(and(
      eq(schema.cardGenerationUnits.id, unitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
    ));
}

/** 处理 turn 结果，决定是否创建下一 turn 或标记终态 */
export async function handleTurnResult(
  job: JobPayload,
  payload: AgentJobPayload,
  result: AgentTurnExecutionResult,
  lease: JobLeaseContext,
): Promise<void> {
  switch (result.kind) {
    case "continue":
      // 下一 turn job 已在 executeAgentPhase 中创建
      logger.info(
        { runId: payload.generationRunId, nextTurnNo: result.nextTurnNo },
        "Agent turn 完成，已创建下一 turn job",
      );
      break;

    case "wait_for_children":
      // 等待子任务完成，不创建下一 turn job
      // 子任务完成后由 scheduler 恢复 Supervisor
      logger.info(
        { runId: payload.generationRunId, childTaskIds: result.childTaskIds },
        "Agent turn 完成，等待子任务",
      );
      break;

    case "complete":
      logger.info(
        { runId: payload.generationRunId },
        "Agent 流程完成",
      );
      break;

    case "needs_attention": {
      // 标记 run 为 needs_attention
      logger.warn(
        { runId: payload.generationRunId, reason: result.reason },
        "Agent 进入 needs_attention",
      );
      await withJobTransaction(job, async (tx) => {
        await lockJobLease(tx, lease);
        const now = new Date();
        // F4 修复：避免重复标记。PREPARE/VERIFY/PUBLISH 阶段可能已经标记了 needs_attention。
        // 只在 run 尚未处于 needs_attention 状态时才更新。
        const [updatedRun] = await tx
          .update(schema.cardGenerationRuns)
          .set({
            status: SupervisorRunStatus.NEEDS_ATTENTION,
            errorCode: result.reason,
            // 按错误码判定可重试性：预算耗尽/确定性门禁/快照漂移等重试必然失败，
            // 不展示"重试"入口（只保留"重新生成"）；瞬时故障保留重试能力。
            retryable: isRunErrorRetryable(result.reason),
            updatedAt: now,
            finishedAt: now,
          })
          .where(and(
            eq(schema.cardGenerationRuns.id, payload.generationRunId),
            eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
            ne(schema.cardGenerationRuns.status, SupervisorRunStatus.NEEDS_ATTENTION),
          ))
          .returning({ id: schema.cardGenerationRuns.id });

        // 恢复检查点（检查点保留修复）：run 进入 needs_attention 时，当前 unit 就是
        // 用户 `/retry` 要恢复的检查点。必须显式标记为 terminal_failed，否则它只会
        // 停留在 pending/waiting_child，随后被清理逻辑取消，重试时报
        // "没有可恢复的生成检查点"（generation_checkpoint_missing）。
        // 幂等：PREPARE/VERIFY/PUBLISH 阶段若已把该 unit 标记为 terminal_failed，
        // 重复更新同值无害。
        if (updatedRun) {
          await tx
            .update(schema.cardGenerationUnits)
            .set({
              status: "terminal_failed",
              errorCode: result.reason,
              finishedAt: now,
              updatedAt: now,
            })
            .where(and(
              eq(schema.cardGenerationUnits.id, payload.agentUnitId),
              eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
            ));
        }
      });
      break;
    }

    case "failed":
      throw new Error(result.error);
  }
}
