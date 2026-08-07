/**
 * Supervisor Agent Handler（计划 §5, §W6）
 *
 * 这是 `execute_card_agent_turn` job 的处理入口。
 * 一个 Agent job 对应一个 durable turn（计划 §5.2）。
 *
 * 执行顺序（计划 §5.2）：
 * 1. 短事务 claim job/unit，检查 lease、run、epoch、cancel、deadline 和预算
 * 2. 从 ledger/event/task results 重建当前 turn 消息
 * 3. 在事务外执行一次 provider 请求
 * 4. 严格解析 native tool call 或 structured_action_v1
 * 5. 重新检查 lease、epoch、cancel
 * 6. 在事务中 append event、幂等执行工具副作用、更新预算和 Agent Session
 * 7. 如果需要更多模型判断，创建下一 turn job
 * 8. 如果等待 child task，当前 turn 正常结束
 * 9. child task 完成后由 scheduler 恢复 Supervisor
 *
 * 外层四节点（计划 §5.1）：
 * - PREPARE: 确定性封存、证据规划、预算冻结
 * - SUPERVISOR_AGENT: Agent runtime，全部认知决策
 *
 * ─── QUAL-01/14 拆分进度（已大幅缩减） ────────────────────────────────
 * 本文件已从 3369 行缩减至 ~370 行，主要逻辑已拆分到独立模块：
 *   - agent/prepare-phase.ts — PREPARE 阶段逻辑
 *   - agent/run-phase-context.ts — 上下文加载和 ledger 恢复
 *   - agent/run-phase-executor.ts — AGENT_RUN 阶段执行（A1 拆分）
 *   - agent/verify-phase.ts — VERIFY 阶段逻辑
 *   - agent/publish-phase.ts — PUBLISH 阶段逻辑
 *   - agent/specialist-persist.ts — Specialist 持久化辅助
 *   - agent/supervisor-auto-fallback.ts — 自动回退逻辑
 *   - agent/coverage-ledger.ts — 六层覆盖率账本
 *   - agent/candidate-ledger.ts — 候选账本
 *   - agent/context-builder.ts — 上下文构建器
 *   - agent/roles/ — 各角色实现（text-extractor、deck-composer 等）
 *
 * A1 拆分完成（计划 §2.1）：executeAgentRunPhase 已拆分为 5 个独立函数
 * （buildTurnContext、executeProviderCall、processToolResults、
 * persistTurnResult、scheduleNextTurn），位于 agent/run-phase-executor.ts。
 * ──────────────────────────────────────────────────────────────────────
 * - VERIFY: 确定性完整性门禁
 * - PUBLISH: epoch-fenced 原子发布
 *
 * 不变量（G1-G12）：
 * - 一次 job attempt 最多一次 provider 请求
 * - Agent 只写 staging，Canonical Card Set 只能由 deterministic Publish 写入
 * - stale epoch/cancel/partial/duplicate publish/tool side effect = 0
 */

import { and, eq } from "drizzle-orm";
import {
  AgentUnitKind,
  sanitizeOperationalError,
} from "@ailearn/shared";
import { logger } from "../lib/logger.ts";
import * as schema from "../schema/index.ts";
import {
  assertJobLease,
  lockJobLease,
  withJobTransaction,
  type JobLeaseContext,
} from "../lib/job-lease.ts";
import type { JobPayload } from "./index.ts";
// QUAL-02 拆分：共享类型和 unit/job 辅助函数提取到独立模块
import type {
  AgentJobPayload,
  AgentTurnExecutionResult,
  RunContext,
} from "../agent/types.ts";
import { handleTurnResult } from "../agent/unit-helpers.ts";
// QUAL-02/PERF-04 拆分：VERIFY 和 PUBLISH 阶段提取到独立模块
import { executeVerifyPhase } from "../agent/verify-phase.ts";
import { executePublishPhase } from "../agent/publish-phase.ts";
// QUAL-02/PERF-04 拆分：PREPARE 阶段提取到独立模块
import { executeFastExtractPhase, executeFastComposePhase } from "../agent/fast-path.ts";
import { executePlanGenerationPhase } from "../agent/plan-path.ts";
import { executePreparePhase } from "../agent/prepare-phase.ts";
// QUAL-02/PERF-04 拆分（第八轮）：run context 加载、payload 解析
import { extractAgentJobPayload, loadAndValidateRunContext } from "../agent/run-context.ts";
// A1 拆分（计划 §2.1）：executeAgentRunPhase 及其拆分函数提取到独立模块
import { executeAgentRunPhase } from "../agent/run-phase-executor.ts";

// countConsecutiveReadOnlySupervisorTurns 已迁移至 agent/run-phase-executor.ts（A1 拆分）
// 此处通过 re-export 保持已有导入路径兼容（supervisor-spin-detection.test.ts 依赖此导出）
export { countConsecutiveReadOnlySupervisorTurns } from "../agent/run-phase-executor.ts";

/**
 * Supervisor Agent Handler 主入口。
 *
 * 处理 `execute_card_agent_turn` job。
 * 一次 attempt 最多一次 provider 请求（计划 §5.3）。
 */
export async function runCardSupervisorAgent(job: JobPayload): Promise<void> {
  const payload = extractAgentJobPayload(job.payload);
  if (!payload) {
    throw new Error("execute_card_agent_turn: payload 缺少必要字段");
  }

  const lease: JobLeaseContext = {
    id: job.id,
    workspaceId: job.workspaceId,
    requestedBy: job.requestedBy,
    leaseToken: job.leaseToken,
    signal: job.signal,
  };

  // 1. 短事务 claim job/unit，检查 lease、run、epoch、cancel、deadline
  await assertJobLease(lease);

  const runContext = await loadAndValidateRunContext(payload, job.workspaceId);
  if (!runContext) {
    logger.warn(
      { jobId: job.id, runId: payload.generationRunId },
      "Agent job: run 已终态或不存在，跳过",
    );
    return;
  }

  if (runContext.kind === "skip") {
    logger.info(
      { jobId: job.id, runId: payload.generationRunId, reason: runContext.reason },
      "Agent job 被跳过",
    );
    return;
  }

  // 2. 根据 unit kind 分发到对应阶段
  const unitKind = runContext.unitKind;
  logger.info(
    {
      jobId: job.id,
      runId: payload.generationRunId,
      unitId: payload.agentUnitId,
      unitKind,
      turnNo: payload.turnNo,
    },
    "Agent turn 开始执行",
  );

  try {
    const result = await executeAgentPhase(
      job,
      payload,
      runContext,
      lease,
    );

    // 3. 根据结果决定下一步
    await handleTurnResult(job, payload, result, lease);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        jobId: job.id,
        runId: payload.generationRunId,
        unitId: payload.agentUnitId,
        error: sanitizeOperationalError(err),
        ...(process.env.NODE_ENV === "development"
          ? { detail: errorMessage }
          : {}),
      },
      "Agent turn 执行失败",
    );

    // P0-04 修复：第一次异常只标记 unit 为 retryable_failed，不标记 run 为 needs_attention。
    // 原代码调用 markCardGenerationRunNeedsAttention 把 run 设为 needs_attention（终态），
    // 导致队列重投后 run-context.ts 把 needs_attention 当终态直接跳过，
    // 重试实际上不会再次调用 Provider。
    // 修复后：
    // 1. 单次 attempt 失败只更新 unit 为 retryable_failed，run 继续保持可执行状态。
    // 2. 队列重投后 run-context.ts 检查 run 状态为非终态，继续执行。
    // 3. 仅在 attempts 耗尽或明确不可重试时，才把 run 投影为 needs_attention。
    //    attempts 耗尽由队列的 dead-letter 机制或 reconciler 处理（P1-13）。
    if (payload.generationRunId) {
      try {
        await withJobTransaction(job, async (tx) => {
          await lockJobLease(tx, lease);
          const now = new Date();
          await tx.update(schema.cardGenerationUnits).set({
            status: "retryable_failed",
            updatedAt: now,
          }).where(and(
            eq(schema.cardGenerationUnits.id, payload.agentUnitId),
            eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
          ));
        });
      } catch {
        // 如果标记 unit 失败（如 lease 已过期），不影响 re-throw
      }
    }
    throw err;
  }
}

// extractAgentJobPayload 和 loadAndValidateRunContext 已移至 agent/run-context.ts（第八轮拆分）

/**
 * 根据 unit kind 执行对应的 Agent 阶段。
 *
 * PREPARE → 确定性封存
 * AGENT_RUN → Supervisor 或 specialist 的 Agent turn
 * DETERMINISTIC_VERIFY → 确定性验证
 * PUBLISH → 原子发布
 */
async function executeAgentPhase(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
  lease: JobLeaseContext,
): Promise<AgentTurnExecutionResult> {
  const { unitKind } = runContext;

  switch (unitKind) {
    case AgentUnitKind.PREPARE:
      return await executePreparePhase(job, payload, runContext, lease);

    case AgentUnitKind.AGENT_RUN:
      return await executeAgentRunPhase(job, payload, runContext, lease);

    case AgentUnitKind.DETERMINISTIC_VERIFY:
      return await executeVerifyPhase(job, payload, runContext, lease);

    // P2 Fast 路径接线(审计缺口:Fast 组件此前零生产调用点;灰度开启才分发)
    case AgentUnitKind.FAST_EXTRACT:
      return await executeFastExtractPhase(job, payload, runContext, lease);

    case AgentUnitKind.FAST_COMPOSE:
      return await executeFastComposePhase(job, payload, runContext, lease);

    // P3 Planned 路径接线(审计缺口:Planned 组件此前零生产调用点;plan 生成+落库)
    case AgentUnitKind.SUPERVISOR_PLAN:
      return await executePlanGenerationPhase(job, payload, runContext, lease);

    case AgentUnitKind.PUBLISH:
      return await executePublishPhase(job, payload, runContext, lease);

    default:
      // 已声明但 worker 执行器尚未接线的 Phase 2/3/4 kind(fast_extract/fast_compose/
      // route/supervisor_plan/grounding_critic_light/grounding_critic_claim/compose/repair
      // 等)不应进入此路径;fail-closed 而非静默跳过(审计 S2)。
      logger.warn(
        { jobId: job.id, unitKind, runId: payload.generationRunId },
        "Agent handler 收到未接线的 unit kind，fail-closed 跳过（Phase 2/3 组件已交付待接线）",
      );
      return { kind: "needs_attention", reason: `未接线的 unit kind: ${unitKind}（组件已交付，待接线）` };
  }
}

// PREPARE 阶段已移至 agent/prepare-phase.ts（QUAL-02/PERF-04 拆分）
// AGENT_RUN 阶段已移至 agent/run-phase-executor.ts（A1 拆分，计划 §2.1）
// VERIFY 阶段已移至 agent/verify-phase.ts（QUAL-02/PERF-04 拆分）
// PUBLISH 阶段已移至 agent/publish-phase.ts（QUAL-02/PERF-04 拆分）
// 辅助函数已移至 agent/unit-helpers.ts（QUAL-02 拆分）
