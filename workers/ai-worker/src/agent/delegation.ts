/**
 * 异步子 Agent 委派（计划 §5.3）
 *
 * Supervisor 调用 delegate_specialist 时，服务端只创建持久化 child Agent Session
 * 和 job，并返回 task ID。它不会在当前 Supervisor job 内再发一次 provider 请求。
 *
 * 保证：
 * - 一次 job attempt 最多一次 provider 请求
 * - child crash 只恢复 child
 * - Supervisor 等待不占 worker slot
 * - 重复 delegate toolCallId 不会创建第二个 task
 * - child 完成事件只恢复一次 Supervisor
 * - nesting depth 永远为 1
 */

import { createHash } from "node:crypto";
import type {
  AgentRole,
  AgentTaskStatus,
} from "@ailearn/shared";

/** 委派请求 */
export interface DelegationRequest {
  /** 运行 ID */
  runId: string;
  /** 父 unit ID（Supervisor 的 unit） */
  parentUnitId: string;
  /** 工作区 ID */
  workspaceId: string;
  /** noteVersion ID */
  noteVersionId: string;
  /** 请求者 ID */
  requestedBy: string;
  /** 子 Agent 角色 */
  role: AgentRole;
  /** 分配的 bundle IDs */
  bundleIds: string[];
  /** 任务规格 */
  taskSpec: Record<string, unknown>;
  /** toolCallId（用于幂等） */
  toolCallId: string;
  /** turn 编号 */
  turnNo: number;
}

/** 委派结果 */
export interface DelegationResult {
  /** 创建的 child unit ID */
  childUnitId: string;
  /** 创建的 job ID */
  jobId: string;
  /** 是否为已存在的重复委派（幂等命中） */
  isDuplicate: boolean;
  /** 任务状态 */
  status: AgentTaskStatus;
}

/**
 * 计算委派的幂等键。
 *
 * 重复 delegate toolCallId 不会创建第二个 task（计划 §5.3）。
 * SHA256(runId | parentUnitId | toolCallId)
 */
export function computeDelegationIdempotencyKey(input: {
  runId: string;
  parentUnitId: string;
  toolCallId: string;
}): string {
  const raw = `${input.runId}|${input.parentUnitId}|${input.toolCallId}`;
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * 验证委派请求的合法性。
 *
 * 不变量（G6, §5.3, §6.5）：
 * - 只有 Supervisor 可以创建 specialist task
 * - child Agent depth 固定为一层
 * - role 必须在 specialist allowlist 中
 * - bundleIds 不能为空
 */
export function validateDelegation(request: DelegationRequest): void {
  // 验证角色是 specialist（不含 supervisor 自身）
  const specialistRoles: AgentRole[] = [
    "text_extractor",
    "code_extractor",
    "vision_specialist",
    "deck_composer",
    "grounding_critic",
    "repairer",
  ];
  if (!specialistRoles.includes(request.role)) {
    throw new DelegationError(
      `角色 ${request.role} 不是合法的 specialist 角色`,
      "invalid_role",
    );
  }

  // 验证 bundleIds 不为空
  if (request.bundleIds.length === 0) {
    throw new DelegationError(
      "delegate_specialist 必须指定至少一个 bundleId",
      "empty_bundles",
    );
  }

  // 验证 depth = 1
  // depth 验证在创建 child unit 时由数据库约束保证
}

/** 委派错误 */
export class DelegationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "DelegationError";
    this.code = code;
  }
}

/**
 * 子 Agent 任务规格。
 *
 * 创建 child unit 时使用的 input_manifest。
 */
export interface ChildTaskManifest {
  /** Agent 角色 */
  agentRole: AgentRole;
  /** 任务规格 */
  taskSpec: Record<string, unknown>;
  /** 嵌套深度（固定为 1） */
  depth: 1;
  /** 分配的 bundle IDs */
  bundleIds: string[];
  /** 父 unit ID */
  parentUnitId: string;
  /** 创建此任务的 toolCallId */
  originToolCallId: string;
  /** 创建此任务的 turn 编号 */
  originTurnNo: number;
}

/**
 * 构建 child task 的 input manifest。
 */
export function buildChildTaskManifest(request: DelegationRequest): ChildTaskManifest {
  return {
    agentRole: request.role,
    taskSpec: request.taskSpec,
    depth: 1,
    bundleIds: request.bundleIds,
    parentUnitId: request.parentUnitId,
    originToolCallId: request.toolCallId,
    originTurnNo: request.turnNo,
  };
}

/**
 * 构建 child task 的 unit key。
 *
 * unit_key 需要稳定且唯一，基于委派幂等键。
 */
export function buildChildUnitKey(request: DelegationRequest): string {
  const idempotencyKey = computeDelegationIdempotencyKey({
    runId: request.runId,
    parentUnitId: request.parentUnitId,
    toolCallId: request.toolCallId,
  });
  return `agent:${request.role}:${idempotencyKey.slice(0, 32)}`;
}
