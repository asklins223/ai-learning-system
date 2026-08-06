/**
 * QUAL-02/PERF-04 拆分：Agent 运行上下文加载与校验。
 *
 * 此模块从 card-supervisor-agent.ts 中提取 run context 加载逻辑，
 * 包括 job payload 解析和 run/unit 状态校验。
 */

import { and, eq } from "drizzle-orm";
import {
  AgentRole,
  AgentUnitKind,
  SupervisorRunStatus,
  isTerminalUnitStatus,
} from "@ailearn/shared";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import type { AgentJobPayload, RunContext } from "./types.ts";

/** 从 job payload 中提取 Agent job 必要字段 */
export function extractAgentJobPayload(
  payload: Record<string, unknown>,
): AgentJobPayload | null {
  const generationRunId = payload.generationRunId;
  const agentUnitId = payload.agentUnitId;
  const turnNo = payload.turnNo;
  const inputHash = payload.inputHash;

  if (
    typeof generationRunId !== "string"
    || typeof agentUnitId !== "string"
    || typeof turnNo !== "number"
    || typeof inputHash !== "string"
  ) {
    return null;
  }

  return { generationRunId, agentUnitId, turnNo, inputHash };
}

/**
 * 加载并校验 Agent run context。
 *
 * 从数据库查询 run 和 unit 状态，判断是否应跳过当前 turn。
 * 返回值：
 * - null: run 不存在
 * - { kind: "skip", reason }: run/unit 已终态，应跳过
 * - { kind: "active", ... }: 正常执行，包含完整上下文信息
 */
export async function loadAndValidateRunContext(
  payload: AgentJobPayload,
  workspaceId: string,
): Promise<RunContext | null> {
  const [run] = await db
    .select({
      id: schema.cardGenerationRuns.id,
      status: schema.cardGenerationRuns.status,
      noteVersionId: schema.cardGenerationRuns.noteVersionId,
      noteId: schema.cardGenerationRuns.noteId,
      generationEpoch: schema.cardGenerationRuns.generationEpoch,
      workspaceId: schema.cardGenerationRuns.workspaceId,
    })
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, workspaceId),
    ))
    .limit(1);

  if (!run) return null;

  // 检查终态
  const terminalStatuses = new Set([
    // Supervisor Agent 终态
    SupervisorRunStatus.SUCCEEDED,
    SupervisorRunStatus.NEEDS_ATTENTION,
    SupervisorRunStatus.PARTIAL_READY,
    SupervisorRunStatus.CANCELLED,
    SupervisorRunStatus.SUPERSEDED,
    // v2 终态（兼容）
    "failed",
    "terminal_failed",
  ]);
  if (terminalStatuses.has(run.status as string)) {
    return { kind: "skip", reason: `run 已终态: ${run.status}` };
  }

  // 加载 unit 信息
  const [unit] = await db
    .select({
      id: schema.cardGenerationUnits.id,
      kind: schema.cardGenerationUnits.kind,
      status: schema.cardGenerationUnits.status,
      inputManifest: schema.cardGenerationUnits.inputManifest,
    })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.id, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, workspaceId),
      eq(schema.cardGenerationUnits.runId, payload.generationRunId),
    ))
    .limit(1);

  if (!unit) {
    return { kind: "skip", reason: "agent unit 不存在" };
  }

  // P0-06 修复：使用统一的 isTerminalUnitStatus helper 检查终态。
  // 终态 unit（succeeded/terminal_failed/cancelled/superseded）不应被重新处理。
  // retryable_failed 不是终态，队列重试时应重新处理。
  if (isTerminalUnitStatus(unit.status)) {
    return { kind: "skip", reason: `unit 已终态: ${unit.status}` };
  }

  const agentRole = (unit.inputManifest as Record<string, unknown>).agentRole as AgentRole | undefined ?? null;

  return {
    kind: "active",
    runId: run.id,
    workspaceId: run.workspaceId,
    noteVersionId: run.noteVersionId,
    noteId: run.noteId,
    generationEpoch: run.generationEpoch,
    unitKind: unit.kind,
    agentRole,
    status: run.status,
  };
}

// 保留 AgentUnitKind 导入用于类型参考
void AgentUnitKind;
