/**
 * Delegation 工具（计划 §5.3, §6.1）
 *
 * Supervisor 工具：
 * - delegate_specialist: 异步创建子 Agent（幂等，depth=1）
 * - read_agent_task_results: 读取已完成子任务
 *
 * 不变量（G6, §5.3, §6.5）：
 * - 只有 Supervisor 可以创建 specialist task
 * - child Agent depth=1，不能继续 delegate
 * - 重复 delegate toolCallId 不会创建第二个 task
 * - nesting depth 永远为 1
 */

import { and, eq, inArray } from "drizzle-orm";
import { db, withWorkerWorkspaceTransaction } from "../../db.ts";
import * as schema from "../../schema/index.ts";
import {
  AgentUnitKind,
  JobStatus,
  JobType,
  isTerminalUnitStatus,
} from "@ailearn/shared";
import {
  validateDelegation,
  buildChildTaskManifest,
  buildChildUnitKey,
} from "../delegation.ts";
import { logger } from "../../lib/logger.ts";
// BUG-85 修复：复用共享的 hashJson（基于 stableJsonStringify）替代直接 JSON.stringify，
// 确保跨进程哈希一致性。
import { hashJson } from "../../lib/card-generation-pipeline-utils.ts";
import type { ToolCallRequest, ToolCallResult } from "./executor.ts";

/**
 * P1-10 修复：验证 requested role 与 bundle 中的 evidence kind 是否匹配。
 *
 * 服务端根据 immutable evidence kind 确定性路由，
 * 不允许 Supervisor 把图片内容交给 text_extractor 处理，
 * 也不允许把纯文本内容交给 vision_specialist 处理。
 *
 * evidence kind 通过 bundle_members 表的 evidenceRefType 确定：
 * - text_span → text_extractor 或 code_extractor
 * - image_evidence → vision_specialist
 */
async function validateEvidenceKindRouting(
  runId: string,
  workspaceId: string,
  role: string,
  bundleIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  // 非提取角色（如 deck_composer, grounding_critic, repairer）不做 evidence kind 验证
  if (role !== "text_extractor" && role !== "code_extractor" && role !== "vision_specialist") {
    return { ok: true };
  }

  // 查询这些 bundle 的 member evidence types
  const members = await db
    .select({
      bundleKey: schema.cardGenerationSourceBundles.bundleKey,
      evidenceRefType: schema.cardGenerationSourceBundleMembers.evidenceRefType,
    })
    .from(schema.cardGenerationSourceBundleMembers)
    .innerJoin(
      schema.cardGenerationSourceBundles,
      eq(schema.cardGenerationSourceBundles.id, schema.cardGenerationSourceBundleMembers.bundleId),
    )
    .where(and(
      eq(schema.cardGenerationSourceBundles.workspaceId, workspaceId),
      eq(schema.cardGenerationSourceBundles.runId, runId),
      inArray(schema.cardGenerationSourceBundles.bundleKey, bundleIds),
    ));

  if (members.length === 0) {
    // 无 member 信息时允许通过（兼容旧数据或非提取角色）
    return { ok: true };
  }

  // 按 bundle 分组统计 evidence types
  const bundleEvidenceTypes = new Map<string, Set<string>>();
  for (const m of members) {
    if (!bundleEvidenceTypes.has(m.bundleKey)) {
      bundleEvidenceTypes.set(m.bundleKey, new Set());
    }
    bundleEvidenceTypes.get(m.bundleKey)!.add(m.evidenceRefType);
  }

  const mismatchedBundles: string[] = [];
  for (const [bundleKey, types] of bundleEvidenceTypes) {
    const hasImage = types.has("image_evidence");
    const hasText = types.has("text_span");

    if (role === "text_extractor" || role === "code_extractor") {
      // text/code extractor 不应处理包含 image_evidence 的 bundle
      if (hasImage && !hasText) {
        mismatchedBundles.push(`${bundleKey} (只有 image_evidence，应使用 vision_specialist)`);
      }
    } else if (role === "vision_specialist") {
      // vision specialist 不应处理纯文本 bundle
      if (hasText && !hasImage) {
        mismatchedBundles.push(`${bundleKey} (只有 text_span，应使用 text_extractor 或 code_extractor)`);
      }
    }
  }

  if (mismatchedBundles.length > 0) {
    return {
      ok: false,
      error: `evidence kind 路由不匹配：role=${role} 不适合处理以下 bundle: ${mismatchedBundles.join("; ")}`,
    };
  }

  return { ok: true };
}

/** Delegation 工具执行器 */
export async function executeDelegationTool(
  call: ToolCallRequest,
  ctx: DelegationToolContext,
): Promise<ToolCallResult> {
  switch (call.name) {
    case "delegate_specialist":
      return await handleDelegateSpecialist(call, ctx);
    case "read_agent_task_results":
      return await handleReadAgentTaskResults(call, ctx);
    default:
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        result: null,
        error: `unknown delegation tool: ${call.name}`,
      };
  }
}

export interface DelegationToolContext {
  runId: string;
  workspaceId: string;
  noteVersionId: string;
  agentUnitId: string;
  turnNo: number;
  idempotencyKey: string;
  requestedBy: string;
  budgetTracker: import("../budget.ts").BudgetTracker;
}

/** delegate_specialist: 异步创建子 Agent 任务 */
async function handleDelegateSpecialist(
  call: ToolCallRequest,
  ctx: DelegationToolContext,
): Promise<ToolCallResult> {
  const args = call.arguments as {
    role: string;
    bundleIds: string[];
    taskSpec: Record<string, unknown>;
  };

  const delegationRequest = {
    runId: ctx.runId,
    parentUnitId: ctx.agentUnitId,
    workspaceId: ctx.workspaceId,
    noteVersionId: ctx.noteVersionId,
    requestedBy: ctx.requestedBy,
    role: args.role as import("@ailearn/shared").AgentRole,
    bundleIds: args.bundleIds,
    taskSpec: args.taskSpec,
    toolCallId: call.id,
    turnNo: ctx.turnNo,
  };

  // 验证委派请求
  try {
    validateDelegation(delegationRequest);
  } catch (err) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // P1-10 修复：服务端根据 immutable evidence kind 确定性路由验证。
  // 不允许 Supervisor 把图片内容交给 text_extractor，或把纯文本交给 vision_specialist。
  const routingValidation = await validateEvidenceKindRouting(
    ctx.runId,
    ctx.workspaceId,
    args.role,
    args.bundleIds,
  );
  if (!routingValidation.ok) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `evidence_kind_routing_error: ${routingValidation.error}`,
    };
  }

  // 预留并行任务预算
  try {
    ctx.budgetTracker.reserveParallelTask(delegationRequest.role);
  } catch (err) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 构建子任务 manifest
  const childManifest = buildChildTaskManifest(delegationRequest);
  const childUnitKey = buildChildUnitKey(delegationRequest);

  // P0-06 修复：将 child unit 创建、child job 创建和 bundle assignment 更新
  // 放在单个事务中执行。原代码分三个独立 DB 操作，进程在中间崩溃会产生
  // 孤儿 unit/job 或 bundle 指向错误 unit。
  // 计划 §5.3 要求：parent state、child unit、outbox/job 和 assignment
  // 在一个事务中提交。
  const now = new Date();
  let childUnitId: string;

  try {
    // 计划 §5.3：parent state、child unit、outbox/job 和 assignment 在同一
    // 事务提交。jobs RLS 重开（0098）后必须带 workspace context
    //（app.workspace_id/app.user_id 满足 tenant+actor guard），
    // 裸 db.transaction 会被 RLS 拦截。
    childUnitId = await withWorkerWorkspaceTransaction(
      { workspaceId: ctx.workspaceId, userId: ctx.requestedBy },
      async (tx) => {
      // 1. 幂等创建 child unit（unitKey 唯一约束保证）
      const [unit] = await tx
        .insert(schema.cardGenerationUnits)
        .values({
          workspaceId: ctx.workspaceId,
          runId: ctx.runId,
          parentUnitId: ctx.agentUnitId,
          kind: AgentUnitKind.AGENT_RUN,
          level: 1,
          ordinal: ctx.turnNo * 100 + args.bundleIds.length,
          unitKey: childUnitKey,
          required: true,
          inputManifest: childManifest as unknown as Record<string, unknown>,
          // 修复 E4（第5轮）：inputHash 必须是输入的 SHA-256 hash，不是 idempotencyKey。
          // 计划 §5.2 要求 inputHash 是 turn 输入的 SHA-256 hash。
          // BUG-85 修复：使用 hashJson（stableJsonStringify）替代 JSON.stringify，
          // 确保 key 排序不影响哈希结果。
          inputHash: hashJson(childManifest),
          tokenEstimate: 0,
          status: "pending",
          scheduledAt: now,
          nodeContractVersion: "node-contract-v1",
        })
        .onConflictDoNothing()
        .returning();

      let unitId: string;
      if (unit) {
        unitId = unit.id;
      } else {
        // 幂等命中，查找已有 unit
        const [existing] = await tx
          .select({ id: schema.cardGenerationUnits.id })
          .from(schema.cardGenerationUnits)
          .where(and(
            eq(schema.cardGenerationUnits.workspaceId, ctx.workspaceId),
            eq(schema.cardGenerationUnits.runId, ctx.runId),
            eq(schema.cardGenerationUnits.unitKey, childUnitKey),
          ))
          .limit(1);

        if (!existing) {
          throw new Error("delegate_specialist: 无法创建或找到 child unit");
        }
        unitId = existing.id;
      }

      // 2. 创建 child job（幂等）—— 同一事务内
      await tx.insert(schema.jobs).values({
        type: JobType.EXECUTE_CARD_AGENT_TURN,
        workspaceId: ctx.workspaceId,
        requestedBy: ctx.requestedBy,
        payload: {
          generationRunId: ctx.runId,
          agentUnitId: unitId,
          turnNo: 1,
          inputHash: hashJson({
            runId: ctx.runId,
            unitId,
            turnNo: 1,
          }),
          userId: ctx.requestedBy,
        },
        status: JobStatus.PENDING,
        generationRunId: ctx.runId,
        generationUnitId: unitId,
        stage: "complete",
        priority: 70,
        resourceClass: "card_foreground",
        idempotencyKey: `agent-turn:${ctx.runId}:${unitId}:1`,
      }).onConflictDoNothing();

      // 3. 更新 source bundles 的 assignedAgentUnitId —— 同一事务内
      // R24 修复：更新 bundle 的 assignedAgentUnitId 指向子 Agent unit。
      // BUG-20/PERF-16: 批量更新（inArray 单次 SQL）。
      await tx.update(schema.cardGenerationSourceBundles).set({
        assignmentStatus: "assigned",
        assignedAgentUnitId: unitId,
        updatedAt: now,
      }).where(and(
        eq(schema.cardGenerationSourceBundles.workspaceId, ctx.workspaceId),
        eq(schema.cardGenerationSourceBundles.runId, ctx.runId),
        inArray(schema.cardGenerationSourceBundles.bundleKey, args.bundleIds),
      ));

      return unitId;
      },
    );

    logger.info(
      {
        runId: ctx.runId,
        childUnitId,
        role: args.role,
        bundleCount: args.bundleIds.length,
      },
      "delegate_specialist: 子 Agent 任务已创建（单事务），bundle assignedAgentUnitId 已更新",
    );
  } catch (err) {
    logger.error(
      { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
      "delegate_specialist: 事务化创建子 Agent 任务失败",
    );
    // 子任务未创建成功：不会有终态子任务触发 BUG-12 的 release，
    // 必须在此释放预留的并发槽，否则 run 级 currentParallelTasks 单调递增。
    try {
      ctx.budgetTracker.releaseParallelTask(delegationRequest.role);
    } catch {
      // 容忍重复释放
    }
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      childTaskId: childUnitId,
      childUnitKey,
      role: args.role,
      status: "pending",
    },
  };
}

/** read_agent_task_results: 读取已完成子任务 */
async function handleReadAgentTaskResults(
  call: ToolCallRequest,
  ctx: DelegationToolContext,
): Promise<ToolCallResult> {
  const args = call.arguments as { taskIds: string[] };

  if (!args.taskIds || args.taskIds.length === 0) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: "taskIds 不能为空",
    };
  }

  // 查询子任务（只能读取当前 Supervisor 的 children）
  const tasks = await db
    .select({
      id: schema.cardGenerationUnits.id,
      kind: schema.cardGenerationUnits.kind,
      status: schema.cardGenerationUnits.status,
      inputManifest: schema.cardGenerationUnits.inputManifest,
      artifactJson: schema.cardGenerationUnits.artifactJson,
      artifactHash: schema.cardGenerationUnits.artifactHash,
      errorCode: schema.cardGenerationUnits.errorCode,
      finishedAt: schema.cardGenerationUnits.finishedAt,
    })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationUnits.runId, ctx.runId),
      eq(schema.cardGenerationUnits.parentUnitId, ctx.agentUnitId),
      inArray(schema.cardGenerationUnits.id, args.taskIds),
    ));

  // BUG-12: 当子任务到达终态时，释放对应角色的并行任务预算。
  // 原代码在 handleRequestGroundingReview/handleRequestRepair 中 reserveParallelTask
  // 但从不释放，导致 currentParallelTasks 单调递增。
  // 这里在 Supervisor 读取子任务结果时释放，确保预算正确回收。
  // P0-06 修复：使用统一的 isTerminalUnitStatus helper 替代硬编码状态检查。
  // 原代码检查 "completed"/"failed"，但 DB 中实际值是 "succeeded"/"terminal_failed"。
  for (const t of tasks) {
    if (isTerminalUnitStatus(t.status)) {
      const role = (t.inputManifest as Record<string, unknown>)?.agentRole;
      if (typeof role === "string") {
        try {
          ctx.budgetTracker.releaseParallelTask(role as import("@ailearn/shared").AgentRole);
        } catch {
          // 容忍重复释放（如同一 turn 多次读取结果）
        }
      }
    }
  }

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      taskCount: tasks.length,
      tasks: tasks.map((t) => ({
        taskId: t.id,
        status: t.status,
        role: (t.inputManifest as Record<string, unknown>)?.agentRole ?? null,
        outputHash: t.artifactHash,
        outputSummary: t.artifactJson,
        errorCode: t.errorCode,
        finishedAt: t.finishedAt?.toISOString() ?? null,
      })),
    },
  };
}
