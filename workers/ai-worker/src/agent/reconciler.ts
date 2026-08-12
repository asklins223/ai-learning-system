/**
 * P0-06b 修复：终态 run reconciler。
 *
 * 审计发现终态 run 下残留 40 个 pending/running unit，说明清理、恢复和运维状态都不可信。
 *
 * reconciler 职责：
 * 1. 终态 run 下的非终态 unit → 原子取消（cancelled）
 * 2. 终态 run 下的 pending/running job → 标记为 dead
 * 3. waiting_child parent 且全部子已终态 → 创建 resume job
 *
 * 不变量：
 * - reconciler 重复运行幂等
 * - 终态 run 的非终态 unit/job 数为 0
 * - 不产生新的 Provider 调用
 */

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { logger } from "../lib/logger.ts";
import {
  SupervisorRunStatus,
  AgentUnitKind,
  SUPERVISOR_AGENT_ENGINE_MODE,
  // P0-06 统一：从共享包导入状态枚举，消除本地重复定义
  NON_TERMINAL_UNIT_STATUSES,
  TERMINAL_RUN_STATUSES,
  isTerminalUnitStatus,
  sanitizeOperationalError,
} from "@ailearn/shared";
import { hashJson } from "../lib/card-generation-pipeline-utils.ts";

/**
 * 真正"死"的终态 run（不包含 needs_attention）。
 *
 * needs_attention 虽然对 worker 是终态（不会再被 job 处理），但对用户是可恢复的：
 * `/card-generation-runs/:id/retry` 依赖 run 下残留的非终态 unit 作为重试检查点。
 * 因此 reconciler 只能清理 succeeded/partial_ready/cancelled/superseded 下的
 * dangling unit，绝不能清 needs_attention run——否则会把重试检查点一并取消，
 * 用户点击"重试失败检查点"会得到 generation_checkpoint_missing。
 */
export const DEAD_TERMINAL_RUN_STATUSES = TERMINAL_RUN_STATUSES.filter(
  (s) => s !== SupervisorRunStatus.NEEDS_ATTENTION,
);

/**
 * 执行一轮 Supervisor Agent reconciler。
 *
 * 1. 清理终态 run 下的非终态 unit 和 job
 * 2. 恢复卡死的 waiting_child parent
 *
 * @returns 清理和恢复的计数
 */
export async function reconcileSupervisorAgentRuns(): Promise<{
  cancelledUnits: number;
  deadJobs: number;
  resumedParents: number;
}> {
  const result = { cancelledUnits: 0, deadJobs: 0, resumedParents: 0 };

  try {
    result.cancelledUnits = await cancelDanglingUnitsUnderTerminalRuns();
    result.deadJobs = await markDeadJobsUnderTerminalRuns();
    result.resumedParents = await resumeStuckWaitingParents();
  } catch (err) {
    logger.error(
      { error: sanitizeOperationalError(err) },
      "reconcileSupervisorAgentRuns: 执行失败",
    );
  }

  if (result.cancelledUnits > 0 || result.deadJobs > 0 || result.resumedParents > 0) {
    logger.info(result, "reconcileSupervisorAgentRuns: 完成");
  }

  return result;
}

/**
 * 1. 清理"死"终态 run 下的非终态 unit。
 *
 * 审计发现：终态 run 下实测残留 40 个 pending/running unit。
 * 这些 unit 永远不会被执行（run 已终态），必须被取消。
 *
 * 注意：只清理 DEAD_TERMINAL_RUN_STATUSES（succeeded/partial_ready/cancelled/
 * superseded）。needs_attention run 下的非终态 unit 是 `/retry` 的重试检查点，
 * 必须原样保留（详见 DEAD_TERMINAL_RUN_STATUSES 注释）。
 */
async function cancelDanglingUnitsUnderTerminalRuns(): Promise<number> {
  const now = new Date();

  // 查找死终态 run 下的非终态 unit
  const danglingUnits = await db
    .select({
      unitId: schema.cardGenerationUnits.id,
      runId: schema.cardGenerationUnits.runId,
      runStatus: schema.cardGenerationRuns.status,
      unitStatus: schema.cardGenerationUnits.status,
    })
    .from(schema.cardGenerationUnits)
    .innerJoin(
      schema.cardGenerationRuns,
      eq(schema.cardGenerationRuns.id, schema.cardGenerationUnits.runId),
    )
    .where(
      and(
        eq(schema.cardGenerationRuns.engineMode, SUPERVISOR_AGENT_ENGINE_MODE),
        inArray(
          schema.cardGenerationRuns.status,
          DEAD_TERMINAL_RUN_STATUSES as readonly string[],
        ),
        inArray(
          schema.cardGenerationUnits.status,
          NON_TERMINAL_UNIT_STATUSES,
        ),
      ),
    )
    .limit(500);

  if (danglingUnits.length === 0) return 0;

  logger.warn(
    { count: danglingUnits.length },
    "reconciler: 发现终态 run 下的非终态 unit，正在取消",
  );

  // 批量取消
  const unitIds = danglingUnits.map((u) => u.unitId);
  await db
    .update(schema.cardGenerationUnits)
    .set({
      status: "cancelled",
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(schema.cardGenerationUnits.id, unitIds),
        inArray(schema.cardGenerationUnits.status, NON_TERMINAL_UNIT_STATUSES),
      ),
    );

  return danglingUnits.length;
}

/**
 * 2. 标记死终态 run 下的 pending/running job 为 dead。
 *
 * 这些 job 永远不会被执行（run 已终态），保留它们会占用队列配额。
 * 与 cancelDanglingUnitsUnderTerminalRuns 一致，只处理 DEAD_TERMINAL_RUN_STATUSES，
 * 不清 needs_attention run 的 job——那是一个可恢复状态，正等待用户重试。
 */
async function markDeadJobsUnderTerminalRuns(): Promise<number> {
  // 0098 起 jobs RLS 重新启用：跨 workspace 维护写路径收口为
  // SECURITY DEFINER 函数 ailearn_mark_dead_jobs_under_terminal_runs()
  // （migrator owner + BYPASSRLS，函数内绕过 RLS；worker 仅 EXECUTE）。
  const result = await db.execute(sql`
    SELECT public.ailearn_mark_dead_jobs_under_terminal_runs() AS marked
  `);

  const row = (result as unknown as Array<{ marked: number | string }>)[0];
  return typeof row?.marked === "number" ? row.marked : Number(row?.marked ?? 0);
}

/**
 * 3. 恢复卡死的 waiting_child parent。
 *
 * 竞态条件：子任务先于父状态提交完成时，parent 还不是 waiting_child，
 * resumeParentSupervisorIfNeeded 的 CAS 检查会失败。
 * 当 parent 最终切到 waiting_child 时，子任务已完成但没有触发 resume。
 *
 * 此函数查找所有 waiting_child parent，检查其子任务是否全部终态，
 * 如果是则创建 resume job。
 *
 * 只处理非终态 run 下的 parent：终态 run（含 needs_attention）不会再被 job 处理，
 * 为它们创建 resume job 只会被 run-context 以"run 已终态"跳过，造成无效 job 刷屏。
 * needs_attention run 的 waiting_child parent 由用户 `/retry` 恢复。
 */
async function resumeStuckWaitingParents(): Promise<number> {
  // 查找所有 waiting_child 状态的 Supervisor unit（仅限非终态 run）
  const waitingParents = await db
    .select({
      unitId: schema.cardGenerationUnits.id,
      runId: schema.cardGenerationUnits.runId,
      workspaceId: schema.cardGenerationUnits.workspaceId,
      cursorJson: schema.cardGenerationUnits.cursorJson,
    })
    .from(schema.cardGenerationUnits)
    .innerJoin(
      schema.cardGenerationRuns,
      eq(schema.cardGenerationRuns.id, schema.cardGenerationUnits.runId),
    )
    .where(
      and(
        eq(schema.cardGenerationUnits.status, "waiting_child"),
        eq(schema.cardGenerationUnits.kind, AgentUnitKind.AGENT_RUN),
        notInArray(
          schema.cardGenerationRuns.status,
          TERMINAL_RUN_STATUSES as string[],
        ),
      ),
    )
    .limit(100);

  if (waitingParents.length === 0) return 0;

  let resumed = 0;

  for (const parent of waitingParents) {
    // 检查所有子任务是否都已终态
    const children = await db
      .select({
        id: schema.cardGenerationUnits.id,
        status: schema.cardGenerationUnits.status,
      })
      .from(schema.cardGenerationUnits)
      .where(
        and(
          eq(schema.cardGenerationUnits.parentUnitId, parent.unitId),
          eq(schema.cardGenerationUnits.workspaceId, parent.workspaceId),
        ),
      );

    if (children.length === 0) {
      // 没有子任务但仍在 waiting_child → 状态错误，标记为 running 以重新处理
      logger.warn(
        { unitId: parent.unitId, runId: parent.runId },
        "reconciler: waiting_child parent 没有子任务，恢复为 running",
      );
    } else {
      const stillRunning = children.filter(
        (c) => !isTerminalUnitStatus(c.status),
      );
      if (stillRunning.length > 0) continue;
    }

    // CAS: waiting_child → running，确保原子性
    const now = new Date();
    const [updated] = await db
      .update(schema.cardGenerationUnits)
      .set({ status: "running", updatedAt: now })
      .where(
        and(
          eq(schema.cardGenerationUnits.id, parent.unitId),
          eq(schema.cardGenerationUnits.workspaceId, parent.workspaceId),
          eq(schema.cardGenerationUnits.status, "waiting_child"),
        ),
      )
      .returning({ id: schema.cardGenerationUnits.id });

    if (!updated) continue;

    // 创建 resume job（jobs RLS 重开：跨 workspace 对账写经 SECURITY DEFINER 函数）
    await db.execute(sql`
      SELECT public.ailearn_enqueue_agent_turn_job(
        ${parent.workspaceId}, NULL, ${parent.runId}, ${parent.unitId}, 999,
        ${hashJson({
          runId: parent.runId,
          unitId: parent.unitId,
          resume: true,
          reconciler: true,
        })},
        80, 'card_foreground',
        ${`agent-reconcile:${parent.runId}:${parent.unitId}`},
        'system-reconciler'
      )
    `);

    resumed++;
    logger.info(
      { unitId: parent.unitId, runId: parent.runId },
      "reconciler: 恢复卡死的 waiting_child parent",
    );
  }

  return resumed;
}
