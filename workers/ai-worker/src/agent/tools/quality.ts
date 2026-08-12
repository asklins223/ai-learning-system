/**
 * Quality 工具（计划 §6.1, §4.6, §4.7, §W5）
 *
 * Supervisor 工具：
 * - request_grounding_review: 异步创建强制 Critic（幂等）
 * - read_quality_report: 读取 Critic report
 * - request_repair: 创建一次 Repair task
 * - request_verification: 关闭 Supervisor 并进入 VERIFY
 *
 * 不变量（G7, §4.6, §4.7）：
 * - 每个最终 Draft 必须经过独立 Grounding Critic
 * - Supervisor 不能自己写 supported verdict
 * - Repair 后必须针对新 draftHash 再跑一次 Critic
 * - 整 run 最多一次 Repair
 */

import { and, eq, like } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, withWorkerWorkspaceTransaction } from "../../db.ts";
import * as schema from "../../schema/index.ts";
import {
  AgentUnitKind,
  JobStatus,
  JobType,
  isTerminalUnitStatus,
  type CriticIssue,
  CriticIssueSeverity,
} from "@ailearn/shared";
import { validateRepairRequest } from "../repair.ts";
import type { BudgetTracker } from "../budget.ts";
import { logger } from "../../lib/logger.ts";
import type { ToolCallRequest, ToolCallResult } from "./executor.ts";

/** Quality 工具执行器 */
export async function executeQualityTool(
  call: ToolCallRequest,
  ctx: QualityToolContext,
): Promise<ToolCallResult> {
  switch (call.name) {
    case "request_grounding_review":
      return await handleRequestGroundingReview(call, ctx);
    case "read_quality_report":
      return await handleReadQualityReport(call, ctx);
    case "request_repair":
      return await handleRequestRepair(call, ctx);
    case "request_verification":
      return await handleRequestVerification(call, ctx);
    default:
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        result: null,
        error: `unknown quality tool: ${call.name}`,
      };
  }
}

export interface QualityToolContext {
  runId: string;
  workspaceId: string;
  noteVersionId: string;
  agentUnitId: string;
  turnNo: number;
  idempotencyKey: string;
  requestedBy: string;
  budgetTracker: import("../budget.ts").BudgetTracker;
}

/**
 * P1-1：为 draft 调度 Critic(系统级自动推进,幂等)。
 *
 * 由两处调用：
 * 1. request_grounding_review 工具(模型显式请求,兼容期)
 * 2. run-phase-executor processToolResults(submit_deck_draft 成功后系统自动创建)
 *
 * 完整保留原有幂等检查、Critic 预算自愈、终态 Critic 复用逻辑。
 * 返回 null 表示创建失败(预算或 DB 冲突无法解决)。
 */
export async function scheduleCriticForDraft(input: {
  workspaceId: string;
  runId: string;
  agentUnitId: string;
  requestedBy: string;
  draftId: string;
  draftHash: string;
  budgetTracker: BudgetTracker;
}): Promise<CriticScheduleResult | null> {
  const { workspaceId, runId, agentUnitId, requestedBy, draftId, draftHash, budgetTracker } = input;

  // 检查是否已有 Critic task(幂等)
  const criticUnitKey = `agent:grounding_critic:${draftId}`;
  const [existing] = await db
    .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.workspaceId, workspaceId),
      eq(schema.cardGenerationUnits.runId, runId),
      eq(schema.cardGenerationUnits.unitKey, criticUnitKey),
    ))
    .limit(1);

  if (existing) {
    // P1-14/Budget 修复：当 Critic 已在终态时，Supervisor 不应等待子任务，
    // 而应直接读取 Quality Report。返回 `alreadyCompleted` 标记使 Handler
    // 不将此 ID 加入 childTaskIds，避免无意义的 wait_for_children 循环。
    const alreadyCompleted = isTerminalUnitStatus(existing.status);
    return {
      criticTaskId: existing.id,
      status: existing.status,
      alreadyCompleted,
      idempotent: true,
      // 当 Critic 已完成时，引导 Supervisor 读取 report
      nextAction: alreadyCompleted ? "read_quality_report" : "wait_for_children",
    };
  }

  // 预留 Critic 预算
  // maxConcurrent 饱和时的自愈逻辑(防死循环)：
  // - 已有一个「正在运行」的 grounding_critic → 把它的 taskId 作为等待目标返回，
  //   让 Supervisor 等它完成后 read_quality_report / 重新请求，而不是硬失败后
  //   进入 childTaskIds=[] 的 waiting_critic 空转。
  // - 已有一个「已终态」的 grounding_critic → 说明其 budget slot 未随读取释放
  //   (release 只在 read_quality_report 命中终态 report 时发生；若 Supervisor
  //   只轮询新 draft 的 report，旧 critic 的 slot 会泄漏)。回收该 slot 后重试，
  //   让本 turn 能真正创建新 Critic，而不是一直撞 maxConcurrent。
  let budgetReserved = false;
  let budgetError: unknown = null;
  try {
    budgetTracker.reserveParallelTask("grounding_critic");
    budgetReserved = true;
  } catch (err) {
    budgetError = err;
    const [occupying] = await db
      .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
      .from(schema.cardGenerationUnits)
      .where(and(
        eq(schema.cardGenerationUnits.workspaceId, workspaceId),
        eq(schema.cardGenerationUnits.runId, runId),
        eq(schema.cardGenerationUnits.kind, AgentUnitKind.AGENT_RUN),
        eq(schema.cardGenerationUnits.level, 1),
        like(schema.cardGenerationUnits.unitKey, "agent:grounding_critic:%"),
      ))
      .limit(1);

    if (occupying && !isTerminalUnitStatus(occupying.status)) {
      logger.warn(
        { runId, runningCriticUnitId: occupying.id, draftHash },
        "scheduleCriticForDraft: Critic 预算已满且现有 Critic 仍在运行，等待其完成",
      );
      return {
        criticTaskId: occupying.id,
        status: occupying.status,
        alreadyCompleted: false,
        idempotent: false,
        nextAction: "wait_for_children",
      };
    }

    if (occupying && isTerminalUnitStatus(occupying.status)) {
      logger.warn(
        { runId, terminalCriticUnitId: occupying.id, status: occupying.status, draftHash },
        "scheduleCriticForDraft: 检测到已终态但未释放预算的 Critic，回收 slot 后重试",
      );
      try {
        budgetTracker.releaseParallelTask("grounding_critic");
      } catch {
        // 容忍重复释放
      }
      try {
        budgetTracker.reserveParallelTask("grounding_critic");
        budgetReserved = true;
      } catch (err2) {
        budgetError = err2;
      }
    }
  }
  if (!budgetReserved) {
    logger.warn(
      { runId, error: budgetError instanceof Error ? budgetError.message : String(budgetError) },
      "scheduleCriticForDraft: Critic 预算预留失败",
    );
    return null;
  }

  // 创建 Critic child unit
  // slot 纪律：reserve 成功后，任何“未创建可释放的 Critic”的退出路径
  // （return null / 异常抛出）都必须 release，否则 run 级并发槽永久泄漏。
  try {
  const now = new Date();
  const [criticUnit] = await db
    .insert(schema.cardGenerationUnits)
    .values({
      workspaceId,
      runId,
      parentUnitId: agentUnitId,
      kind: AgentUnitKind.AGENT_RUN,
      level: 1,
      ordinal: 90,
      unitKey: criticUnitKey,
      required: true,
      inputManifest: {
        agentRole: "grounding_critic",
        taskSpec: { draftId, draftHash },
        depth: 1,
      } as unknown as Record<string, unknown>,
      // 修复 E4(第5轮)：inputHash 必须是输入的 SHA-256 hash，不是 idempotencyKey。
      inputHash: createHash("sha256")
        .update(JSON.stringify({
          agentRole: "grounding_critic",
          draftId,
          draftHash,
        }))
        .digest("hex"),
      tokenEstimate: 0,
      status: "pending",
      scheduledAt: now,
      nodeContractVersion: "node-contract-v1",
    })
    .onConflictDoNothing()
    .returning();

  if (!criticUnit) {
    // 幂等命中(INSERT conflict)
    const [existing2] = await db
      .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
      .from(schema.cardGenerationUnits)
      .where(and(
        eq(schema.cardGenerationUnits.workspaceId, workspaceId),
        eq(schema.cardGenerationUnits.runId, runId),
        eq(schema.cardGenerationUnits.unitKey, criticUnitKey),
      ))
      .limit(1);

    if (existing2) {
      // 幂等命中（复用已存在的 Critic unit）：本次 reserve 的并发槽没有对应
      // 新任务——existing2 的槽由它自己的 reserve/完成路径管理。此处必须
      // release，否则并发窗口下 currentParallelTasks 永久 +1，累计撞
      // maxParallelTasks 卡死 run（与 330-342 的"未创建可释放 Critic 必须
      // release"纪律一致）。
      if (budgetReserved) {
        try {
          budgetTracker.releaseParallelTask("grounding_critic");
        } catch {
          // 容忍重复释放
        }
      }
      const alreadyCompleted = isTerminalUnitStatus(existing2.status);
      return {
        criticTaskId: existing2.id,
        status: existing2.status,
        alreadyCompleted,
        idempotent: true,
        nextAction: alreadyCompleted ? "read_quality_report" : "wait_for_children",
      };
    }

    // 修复(2026-08-06)：INSERT 冲突也可能是 (run, kind=agent_run, level=1, ordinal=90)
    // 唯一键被「旧 draft 的 critic」占用(其 unitKey 指向旧 draft，按 criticUnitKey 查不到)。
    // supervisor 为 apply_draft_patch/repair 后的新 draft 再次 request_grounding_review 时，
    // 需要复用该位置的 critic unit 并更新指向新 draft。仅当旧 critic 已终态时复用。
    const [oldCritic] = await db
      .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
      .from(schema.cardGenerationUnits)
      .where(and(
        eq(schema.cardGenerationUnits.workspaceId, workspaceId),
        eq(schema.cardGenerationUnits.runId, runId),
        eq(schema.cardGenerationUnits.kind, AgentUnitKind.AGENT_RUN),
        eq(schema.cardGenerationUnits.level, 1),
        eq(schema.cardGenerationUnits.ordinal, 90),
        like(schema.cardGenerationUnits.unitKey, "agent:grounding_critic:%"),
      ))
      .limit(1);

    if (oldCritic && isTerminalUnitStatus(oldCritic.status)) {
      const newInputHash = createHash("sha256")
        .update(JSON.stringify({
          agentRole: "grounding_critic",
          draftId,
          draftHash,
        }))
        .digest("hex");
      await db.update(schema.cardGenerationUnits).set({
        unitKey: criticUnitKey,
        inputManifest: {
          agentRole: "grounding_critic",
          taskSpec: { draftId, draftHash },
          depth: 1,
        } as unknown as Record<string, unknown>,
        inputHash: newInputHash,
        status: "pending",
        scheduledAt: now,
        finishedAt: null,
        errorCode: null,
        updatedAt: now,
      }).where(and(
        eq(schema.cardGenerationUnits.id, oldCritic.id),
        eq(schema.cardGenerationUnits.workspaceId, workspaceId),
      ));

      // 复用后必须创建新的 Critic job(idempotencyKey 加 draftHash，避免与旧 job 冲突)。
      // 缺失时 supervisor 等待一个永远不会执行的孩子 → 死锁。
      // jobs RLS 重开（0098）后 INSERT 需带 workspace context。
      await withWorkerWorkspaceTransaction(
        { workspaceId, userId: requestedBy },
        (tx) => tx.insert(schema.jobs).values({
          type: JobType.EXECUTE_CARD_AGENT_TURN,
          workspaceId,
          requestedBy,
          payload: {
            generationRunId: runId,
            agentUnitId: oldCritic.id,
            turnNo: 1,
            inputHash: createHash("sha256")
              .update(JSON.stringify({ runId, unitId: oldCritic.id, turnNo: 1, draftHash }))
              .digest("hex"),
            userId: requestedBy,
          },
          status: JobStatus.PENDING,
          generationRunId: runId,
          generationUnitId: oldCritic.id,
          stage: "complete",
          priority: 72,
          resourceClass: "card_foreground",
          idempotencyKey: `agent-turn:${runId}:${oldCritic.id}:1:${draftHash}`,
        }).onConflictDoNothing(),
      );

      logger.warn(
        { runId, oldCriticUnitId: oldCritic.id, newDraftHash: draftHash, oldStatus: oldCritic.status },
        "scheduleCriticForDraft: 复用已终态的旧 Critic unit 并创建新 job，更新指向新 draft 后重新调度",
      );
      return {
        criticTaskId: oldCritic.id,
        status: "pending",
        alreadyCompleted: false,
        idempotent: false,
        nextAction: "wait_for_children",
      };
    }

    logger.warn(
      { runId },
      "scheduleCriticForDraft: 无法创建 Critic unit",
    );
    // 未创建 Critic：释放本次预留的并发槽（否则同 run 后续 Critic 撞 maxConcurrent）
    if (budgetReserved) {
      try {
        budgetTracker.releaseParallelTask("grounding_critic");
      } catch {
        // 容忍重复释放
      }
    }
    return null;
  }

  // 创建 Critic job
  await withWorkerWorkspaceTransaction(
    { workspaceId, userId: requestedBy },
    (tx) => tx.insert(schema.jobs).values({
      type: JobType.EXECUTE_CARD_AGENT_TURN,
      workspaceId,
      requestedBy,
      payload: {
        generationRunId: runId,
        agentUnitId: criticUnit.id,
        turnNo: 1,
        // 修复 E4(第5轮)：原代码使用 `turn:1:${criticUnit.id}` 字符串作为 inputHash，
        // 不是 SHA-256 hash。计划 §5.2 要求 inputHash 是 turn 输入的 SHA-256 hash。
        inputHash: createHash("sha256")
          .update(JSON.stringify({
            runId,
            unitId: criticUnit.id,
            turnNo: 1,
          }))
          .digest("hex"),
        userId: requestedBy,
      },
      status: JobStatus.PENDING,
      generationRunId: runId,
      generationUnitId: criticUnit.id,
      stage: "complete",
      priority: 75,
      resourceClass: "card_foreground",
      idempotencyKey: `agent-turn:${runId}:${criticUnit.id}:1`,
    }).onConflictDoNothing(),
  );

  logger.info(
    { runId, criticUnitId: criticUnit.id, draftId },
    "scheduleCriticForDraft: Critic 任务已创建",
  );

  return {
    criticTaskId: criticUnit.id,
    status: "pending",
    alreadyCompleted: false,
    idempotent: false,
    nextAction: "wait_for_children",
  };
  } catch (err) {
    // 异常退出且未创建可释放的 Critic：释放预留槽后重抛
    if (budgetReserved) {
      try {
        budgetTracker.releaseParallelTask("grounding_critic");
      } catch {
        // 容忍重复释放
      }
    }
    throw err;
  }
}

export interface CriticScheduleResult {
  criticTaskId: string;
  status: string;
  alreadyCompleted: boolean;
  idempotent: boolean;
  nextAction: string;
}

/** request_grounding_review: 异步创建 Critic Agent 任务(幂等) */
async function handleRequestGroundingReview(
  call: ToolCallRequest,
  ctx: QualityToolContext,
): Promise<ToolCallResult> {
  const args = call.arguments as { draftHash: string };

  // 查找 draft
  const [draft] = await db
    .select({ id: schema.cardGenerationDrafts.id })
    .from(schema.cardGenerationDrafts)
    .where(and(
      eq(schema.cardGenerationDrafts.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationDrafts.runId, ctx.runId),
      eq(schema.cardGenerationDrafts.contentHash, args.draftHash),
    ))
    .limit(1);

  if (!draft) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `draft not found: hash=${args.draftHash}`,
    };
  }

  // P1-5 兼容期：工具调用转换为系统自动推进。
  // 返回 deprecated_system_managed_transition 标记，由 Handler 决定
  // 是否仍按旧路径处理(兼容期保留 1 个发布周期)。
  const scheduled = await scheduleCriticForDraft({
    workspaceId: ctx.workspaceId,
    runId: ctx.runId,
    agentUnitId: ctx.agentUnitId,
    requestedBy: ctx.requestedBy,
    draftId: draft.id,
    draftHash: args.draftHash,
    budgetTracker: ctx.budgetTracker,
  });

  if (!scheduled) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: "无法创建 Critic unit",
    };
  }

  // P1-5：request_grounding_review 已转为系统自动推进（P1-1/P1-3 在
  // submit_deck_draft 成功 / 子 Agent 完成时自动创建 Critic）。
  // 工具保留执行（幂等，命中已创建 unit 不重复），但返回
  // deprecated_system_managed_transition 标记，引导模型不再依赖此工具。
  logger.info(
    { runId: ctx.runId, draftHash: args.draftHash },
    "request_grounding_review: deprecated_system_managed_transition（系统自动推进）",
  );

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      criticTaskId: scheduled.criticTaskId,
      status: scheduled.status,
      idempotent: scheduled.idempotent,
      alreadyCompleted: scheduled.alreadyCompleted,
      nextAction: scheduled.nextAction,
      deprecatedSystemManaged: true,
      note: "deprecated_system_managed_transition: Critic 调度已由系统自动管理（P1-1/P1-3）",
    },
  };
}

/** read_quality_report: 读取 Critic Quality Report */
async function handleReadQualityReport(
  call: ToolCallRequest,
  ctx: QualityToolContext,
): Promise<ToolCallResult> {
  const args = call.arguments as { draftHash: string };

  const [draft] = await db
    .select({ id: schema.cardGenerationDrafts.id })
    .from(schema.cardGenerationDrafts)
    .where(and(
      eq(schema.cardGenerationDrafts.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationDrafts.runId, ctx.runId),
      eq(schema.cardGenerationDrafts.contentHash, args.draftHash),
    ))
    .limit(1);

  if (!draft) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `draft not found: hash=${args.draftHash}`,
    };
  }

  const [report] = await db
    .select()
    .from(schema.cardGenerationQualityReports)
    .where(and(
      eq(schema.cardGenerationQualityReports.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationQualityReports.runId, ctx.runId),
      eq(schema.cardGenerationQualityReports.draftId, draft.id),
    ))
    .limit(1);

  if (!report) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: true,
      result: {
        report: null,
        message: "Quality report not yet available",
      },
    };
  }

  // BUG-12: 当 Critic report 已到达终态（passed/failed）时，释放并行任务预算。
  // 原代码在 handleRequestGroundingReview 中 reserveParallelTask("grounding_critic")
  // 但从不释放，导致 currentParallelTasks 单调递增，最终达到 maxParallelTasks 上限，
  // 阻止所有新的并行任务创建，run 卡死在 needs_attention。
  if (report.criticStatus === "passed" || report.criticStatus === "failed") {
    try {
      ctx.budgetTracker.releaseParallelTask("grounding_critic");
    } catch {
      // 容忍重复释放（如同一 turn 多次读取 report）
    }
  }

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      report: {
        draftHash: report.draftHash,
        criticStatus: report.criticStatus,
        deterministicStatus: report.deterministicStatus,
        hardIssueCount: ((report.hardIssues as unknown[]) ?? []).length,
        softIssueCount: ((report.softIssues as unknown[]) ?? []).length,
        hardIssues: report.hardIssues,
        softIssues: report.softIssues,
        perClaimVerdicts: report.perClaimVerdicts,
        metrics: report.metrics,
      },
    },
  };
}

/** request_repair: 创建一次 Repair task */
async function handleRequestRepair(
  call: ToolCallRequest,
  ctx: QualityToolContext,
): Promise<ToolCallResult> {
  const args = call.arguments as { draftHash: string; issueIds: string[] };

  // QUAL-30 修复：并行查询 existing repair unit 和 draft，消除串行 DB 往返。
  // 两个查询互相独立：existing 按 runId+unitKey 查询，draft 按 runId+draftHash 查询。
  const repairUnitKey = `agent:repairer:${ctx.runId}`;
  const [existing, draftResult] = await Promise.all([
    // 检查是否已有 Repair task（整 run 最多一次）
    db
      .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
      .from(schema.cardGenerationUnits)
      .where(and(
        eq(schema.cardGenerationUnits.workspaceId, ctx.workspaceId),
        eq(schema.cardGenerationUnits.runId, ctx.runId),
        eq(schema.cardGenerationUnits.unitKey, repairUnitKey),
      ))
      .limit(1),
    // 查找 draft
    db
      .select({ id: schema.cardGenerationDrafts.id })
      .from(schema.cardGenerationDrafts)
      .where(and(
        eq(schema.cardGenerationDrafts.workspaceId, ctx.workspaceId),
        eq(schema.cardGenerationDrafts.runId, ctx.runId),
        eq(schema.cardGenerationDrafts.contentHash, args.draftHash),
      ))
      .limit(1),
  ]);

  if (existing.length > 0) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `repair_limit_exceeded: Repair task already exists (status=${existing[0].status})`,
    };
  }

  const draft = draftResult[0];

  if (!draft) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `draft not found: hash=${args.draftHash}`,
    };
  }

  const [qualityReport] = await db
    .select()
    .from(schema.cardGenerationQualityReports)
    .where(and(
      eq(schema.cardGenerationQualityReports.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationQualityReports.runId, ctx.runId),
      eq(schema.cardGenerationQualityReports.draftId, draft.id),
    ))
    .limit(1);

  if (!qualityReport) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: "quality report not found",
    };
  }

  // 验证 repair 请求
  // QUAL-16 修复：将 hardIssues 从 DB 的 jsonb 还原为 CriticIssue 类型，
  // 移除原先的 `as any` 类型断言，改用类型安全的转换。
  const hardIssues = (qualityReport.hardIssues as Record<string, unknown>[]) ?? [];
  const hardIssueObjects: CriticIssue[] = hardIssues.map((h) => ({
    code: String(h.code ?? "unknown"),
    severity: CriticIssueSeverity.HARD,
    candidateId: h.candidateId ? String(h.candidateId) : undefined,
    cardDraftId: h.cardDraftId ? String(h.cardDraftId) : undefined,
    evidenceRefIds: Array.isArray(h.evidenceRefIds) ? h.evidenceRefIds as string[] : [],
    verdict: h.verdict as CriticIssue["verdict"],
    patchable: Boolean(h.patchable ?? false),
  }));

  try {
    validateRepairRequest(
      {
        runId: ctx.runId,
        agentUnitId: ctx.agentUnitId,
        draftHash: args.draftHash,
        issueIds: args.issueIds,
        repairCount: 0,
      },
      hardIssueObjects,
    );
  } catch (err) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 预留 Repairer 预算
  try {
    ctx.budgetTracker.reserveParallelTask("repairer");
  } catch (err) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 创建 Repairer child unit
  const now = new Date();
  const [repairUnit] = await db
    .insert(schema.cardGenerationUnits)
    .values({
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      parentUnitId: ctx.agentUnitId,
      kind: AgentUnitKind.AGENT_RUN,
      level: 1,
      ordinal: 95,
      unitKey: repairUnitKey,
      required: true,
      inputManifest: {
        agentRole: "repairer",
        taskSpec: { draftId: draft.id, draftHash: args.draftHash, issueIds: args.issueIds },
        depth: 1,
      } as unknown as Record<string, unknown>,
      // 修复 E4（第5轮）：inputHash 必须是输入的 SHA-256 hash，不是 idempotencyKey。
      inputHash: createHash("sha256")
        .update(JSON.stringify({
          agentRole: "repairer",
          draftId: draft.id,
          draftHash: args.draftHash,
          issueIds: args.issueIds,
        }))
        .digest("hex"),
      tokenEstimate: 0,
      status: "pending",
      scheduledAt: now,
      nodeContractVersion: "node-contract-v1",
    })
    .onConflictDoNothing()
    .returning();

  if (!repairUnit) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: "无法创建 Repair unit（可能已存在）",
    };
  }

  // 创建 Repairer job
  await withWorkerWorkspaceTransaction(
    { workspaceId: ctx.workspaceId, userId: ctx.requestedBy },
    (tx) => tx.insert(schema.jobs).values({
      type: JobType.EXECUTE_CARD_AGENT_TURN,
      workspaceId: ctx.workspaceId,
      requestedBy: ctx.requestedBy,
      payload: {
        generationRunId: ctx.runId,
        agentUnitId: repairUnit.id,
        turnNo: 1,
        // 修复 E4（第5轮）：原代码使用 `turn:1:${repairUnit.id}` 字符串作为 inputHash，
        // 不是 SHA-256 hash。计划 §5.2 要求 inputHash 是 turn 输入的 SHA-256 hash。
        inputHash: createHash("sha256")
          .update(JSON.stringify({
            runId: ctx.runId,
            unitId: repairUnit.id,
            turnNo: 1,
          }))
          .digest("hex"),
        userId: ctx.requestedBy,
      },
      status: JobStatus.PENDING,
      generationRunId: ctx.runId,
      generationUnitId: repairUnit.id,
      stage: "complete",
      priority: 72,
      resourceClass: "card_foreground",
      idempotencyKey: `agent-turn:${ctx.runId}:${repairUnit.id}:1`,
    }).onConflictDoNothing(),
  );

  logger.info(
    { runId: ctx.runId, repairUnitId: repairUnit.id, issueCount: args.issueIds.length },
    "request_repair: Repair 任务已创建",
  );

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      repairTaskId: repairUnit.id,
      status: "pending",
    },
  };
}

/** request_verification: 关闭 Supervisor 并进入 VERIFY */
async function handleRequestVerification(
  call: ToolCallRequest,
  ctx: QualityToolContext,
): Promise<ToolCallResult> {
  const args = call.arguments as { draftHash: string };

  // QUAL-29 修复：并行查询 draft 和 run，消除串行 DB 往返。
  // draft 按 runId+draftHash 查询，run 按 runId 查询，两者互相独立。
  const [draftResult, runResult] = await Promise.all([
    // 验证 draftHash 存在
    db
      .select({ id: schema.cardGenerationDrafts.id })
      .from(schema.cardGenerationDrafts)
      .where(and(
        eq(schema.cardGenerationDrafts.workspaceId, ctx.workspaceId),
        eq(schema.cardGenerationDrafts.runId, ctx.runId),
        eq(schema.cardGenerationDrafts.contentHash, args.draftHash),
      ))
      .limit(1),
    // 前置检查：coverage、Critic、budget
    db
      .select({
        budgetSnapshot: schema.cardGenerationRuns.budgetSnapshot,
        coverageReport: schema.cardGenerationRuns.coverageReport,
      })
      .from(schema.cardGenerationRuns)
      .where(eq(schema.cardGenerationRuns.id, ctx.runId))
      .limit(1),
  ]);

  const draft = draftResult[0];
  const run = runResult[0];

  if (!run) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: "run not found",
    };
  }

  // security_review MEDIUM:模型伪造 draftHash 时 draft 为 undefined，
  // 下方 draft.id 会抛 TypeError 并把 JS 错误原文返回给模型(内部信息泄漏)。
  // 与 handleRequestGroundingReview 一致返回 draft not found。
  if (!draft) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `draft not found: hash=${args.draftHash}`,
    };
  }

  // 检查 Critic 是否通过
  const [qualityReport] = await db
    .select({
      criticStatus: schema.cardGenerationQualityReports.criticStatus,
      deterministicStatus: schema.cardGenerationQualityReports.deterministicStatus,
    })
    .from(schema.cardGenerationQualityReports)
    .where(and(
      eq(schema.cardGenerationQualityReports.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationQualityReports.runId, ctx.runId),
      eq(schema.cardGenerationQualityReports.draftId, draft.id),
    ))
    .limit(1);

  if (!qualityReport || qualityReport.criticStatus !== "passed") {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: "Critic report missing or not passed",
    };
  }

  // R35 修复：检查 deterministic preflight 是否通过（计划 §11.3）。
  // 原代码只检查 Critic 是否通过，不检查 deterministicStatus。
  // Supervisor 可能在调用 validate_draft 之前就请求 verification，
  // 导致 VERIFY 阶段因 deterministicStatus="pending" 而失败。
  // 修复后：如果 deterministicStatus 不是 "passed"，拒绝 verification 请求，
  // 迫使 Supervisor 先调用 validate_draft 工具。
  if (qualityReport.deterministicStatus !== "passed") {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `deterministic_preflight_not_passed: status=${qualityReport.deterministicStatus}, please call validate_draft first`,
    };
  }

  // R32 修复：添加 coverage 和 budget 前置检查（计划 §6.1: request_verification 需要 coverage、Critic、budget 前置检查）。
  // 原代码只检查 Critic 是否通过，不检查 coverage 和 budget。
  // 这导致 Supervisor 可能在 coverage 不完整或预算耗尽时请求 Verify，
  // 虽然确定性 VERIFY 阶段会拒绝，但浪费了一个 turn 的 provider 调用预算。
  const coverageReport = run.coverageReport as Record<string, unknown> | null;
  if (coverageReport) {
    const physical = Number(coverageReport.sourcePhysicalCoverage ?? 0);
    const assignment = Number(coverageReport.bundleAssignmentCoverage ?? 0);
    const decision = Number(coverageReport.explicitDecisionCoverage ?? 0);
    if (physical < 1.0 || assignment < 1.0 || decision < 1.0) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        result: null,
        error: `coverage_incomplete: physical=${physical}, assignment=${assignment}, decision=${decision}`,
      };
    }
  }

  // 检查预算是否已耗尽
  if (ctx.budgetTracker.isDeadlineExceeded()) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: "budget_exhausted: deadline exceeded",
    };
  }

  logger.info(
    { runId: ctx.runId, draftHash: args.draftHash },
    "request_verification: Supervisor 请求 Verify（deprecated_system_managed_transition）",
  );

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      action: "request_verification",
      draftHash: args.draftHash,
      // P1-5：VERIFY 创建已由系统自动推进（P1-2：Critic passed 后自动创建
      // deterministic_verify unit）。工具保留 action 以兼容现有 scheduleNextTurn
      // complete 分支，但标记 deprecated 引导模型不再依赖。
      deprecatedSystemManaged: true,
      message: "deprecated_system_managed_transition: VERIFY 已由系统自动管理（P1-2）。",
    },
  };
}
