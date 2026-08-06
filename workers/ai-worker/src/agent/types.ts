/**
 * QUAL-02 拆分：Agent 共享类型定义。
 *
 * 此前这些类型内联在 card-supervisor-agent.ts 中，
 * 现提取到独立模块以便 unit-helpers.ts 等子模块复用。
 */

import type { AgentRole } from "@ailearn/shared";

/** Agent job payload 结构（计划 §5.2） */
export interface AgentJobPayload {
  generationRunId: string;
  agentUnitId: string;
  turnNo: number;
  inputHash: string;
}

/** Agent turn 执行结果 */
export type AgentTurnExecutionResult =
  | { kind: "continue"; nextTurnNo: number }
  | { kind: "wait_for_children"; childTaskIds: string[] }
  | { kind: "complete" }
  | { kind: "needs_attention"; reason: string }
  | { kind: "failed"; error: string };

/** 加载并验证 run 上下文的返回类型 */
export type RunContext =
  | { kind: "skip"; reason: string }
  | {
      kind: "active";
      runId: string;
      workspaceId: string;
      noteVersionId: string;
      noteId: string;
      generationEpoch: number;
      unitKind: string;
      agentRole: AgentRole | null;
      status: string;
    };
