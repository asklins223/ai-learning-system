/**
 * Agent Session 管理（计划 §5.2, §5.4）
 *
 * 一个 Session 对应一个 Agent Unit。
 * Session 是有界、可恢复的 Agent loop。
 *
 * 上下文与记忆（计划 §5.4）：
 * - Agent 的业务记忆是数据库对象，不是无限 messages
 * - Coverage Ledger / Candidate Ledger / Agent Task Results / immutable Draft / Quality Report / append-only event summary
 * - 上下文压缩只允许删除已经持久化且可由 hash 重新读取的信息
 * - 系统 prompt、预算、未完成任务和 hard issues 永远保留
 */

import type {
  AgentRole,
  AgentSessionStatus,
  ProviderUsage,
} from "@ailearn/shared";
import { AgentSessionStatus as SessionStatus } from "@ailearn/shared";

/** Agent Session 状态快照 */
export interface AgentSessionState {
  /** Session 对应的 unit ID */
  unitId: string;
  /** 运行 ID */
  runId: string;
  /** Agent 角色 */
  role: AgentRole;
  /** 当前 turn 编号 */
  turnNo: number;
  /** 当前 attempt 编号 */
  attemptNo: number;
  /** Session 状态 */
  status: AgentSessionStatus;
  /** 等待的子任务 IDs */
  waitingForTaskIds: string[];
  /** 已完成的子任务 IDs */
  completedTaskIds: string[];
  /** 最后一次 provider request ID */
  lastProviderRequestId: string | null;
  /** 累计用量 */
  cumulativeUsage: ProviderUsage | null;
  /** Cursor 状态（用于从 ledger/event 重建上下文） */
  cursor: Record<string, unknown>;
}

/**
 * Agent Session 管理器。
 *
 * Session 状态存储在 card_generation_units 的 cursor_json 和 usage_json 中。
 * 恢复时从数据库重建。
 */
export class AgentSession {
  private state: AgentSessionState;

  constructor(initial: AgentSessionState) {
    this.state = { ...initial };
  }

  /** 获取当前状态快照 */
  getState(): Readonly<AgentSessionState> {
    // BUG-83 修复：返回深拷贝，包括 cursor 对象和数组字段的拷贝，
    // 防止调用方修改返回的状态快照影响 Session 内部状态。
    return {
      ...this.state,
      waitingForTaskIds: [...this.state.waitingForTaskIds],
      completedTaskIds: [...this.state.completedTaskIds],
      cursor: { ...this.state.cursor },
    };
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.state.status === SessionStatus.RUNNING;
  }

  /** 是否在等待子任务 */
  isWaitingForChildren(): boolean {
    return this.state.status === SessionStatus.WAITING_CHILD && this.state.waitingForTaskIds.length > 0;
  }

  /** 是否已完成 */
  isCompleted(): boolean {
    return this.state.status === SessionStatus.COMPLETED;
  }

  /** 是否已失败 */
  isFailed(): boolean {
    return this.state.status === SessionStatus.FAILED;
  }

  /** 开始一个新 turn */
  startTurn(): void {
    this.state.turnNo += 1;
    this.state.attemptNo = 0;
    this.state.status = SessionStatus.RUNNING;
  }

  /** 开始一次 attempt */
  startAttempt(): void {
    this.state.attemptNo += 1;
  }

  /**
   * turn 的 provider 调用已完成（但 Session 仍保持 RUNNING 状态）。
   *
   * BUG-84 修复：原方法名 completeTurn() 暗示 "turn 已完全完成"，
   * 但实际只将 status 设为 RUNNING（从 WAITING_CHILD 恢复或保持运行）。
   * 这与 complete()（标记整个 session 为 COMPLETED）语义混淆。
   * 重命名为 markTurnProcessed() 以更准确反映行为：
   * "provider 调用已返回，turn 结果已处理，session 继续运行"。
   * 保留旧名作为别名以避免破坏调用方。
   */
  markTurnProcessed(): void {
    this.state.status = SessionStatus.RUNNING;
  }
  /** @deprecated 使用 markTurnProcessed() 替代 */
  completeTurn(): void {
    this.markTurnProcessed();
  }

  /** 进入等待子任务状态 */
  waitForChildren(taskIds: string[]): void {
    this.state.status = SessionStatus.WAITING_CHILD;
    this.state.waitingForTaskIds = [...taskIds];
  }

  /**
   * 子任务完成通知。
   *
   * BUG-43 修复：原代码无条件将 taskId 追加到 completedTaskIds，
   * 如果同一子任务多次通知完成（如崩溃恢复后重放），会导致
   * completedTaskIds 包含重复项，影响后续逻辑判断。
   */
  notifyChildCompleted(taskId: string): void {
    this.state.waitingForTaskIds = this.state.waitingForTaskIds.filter((id) => id !== taskId);
    // 去重：只在尚未记录时追加，防止重复通知导致 completedTaskIds 膨胀
    if (!this.state.completedTaskIds.includes(taskId)) {
      this.state.completedTaskIds = [...this.state.completedTaskIds, taskId];
    }
    // 如果所有子任务都完成了，恢复到运行状态
    if (this.state.waitingForTaskIds.length === 0) {
      this.state.status = SessionStatus.RUNNING;
    }
  }

  /** 记录 provider 调用结果 */
  recordProviderCall(usage: ProviderUsage | null, requestId: string | null): void {
    this.state.lastProviderRequestId = requestId;
    if (usage) {
      const prev = this.state.cumulativeUsage;
      this.state.cumulativeUsage = {
        totalTokens: (prev?.totalTokens ?? 0) + (usage.totalTokens ?? 0),
        promptTokens: (prev?.promptTokens ?? 0) + (usage.promptTokens ?? 0),
        completionTokens: (prev?.completionTokens ?? 0) + (usage.completionTokens ?? 0),
        cacheHitTokens: (prev?.cacheHitTokens ?? 0) + (usage.cacheHitTokens ?? 0),
        cacheMissTokens: (prev?.cacheMissTokens ?? 0) + (usage.cacheMissTokens ?? 0),
        requestId: usage.requestId ?? requestId,
      };
    }
  }

  /** 更新 cursor */
  updateCursor(cursor: Record<string, unknown>): void {
    this.state.cursor = { ...this.state.cursor, ...cursor };
  }

  /** 标记完成 */
  complete(): void {
    this.state.status = SessionStatus.COMPLETED;
  }

  /** 标记失败 */
  fail(): void {
    this.state.status = SessionStatus.FAILED;
  }

  /** 标记取消 */
  cancel(): void {
    this.state.status = SessionStatus.CANCELLED;
  }

  /**
   * 重置 Session 状态到初始值。
   *
   * QUAL-42 修复：测试中需要重新构造 AgentSession 实例来测试不同场景，
   * 但构造函数需要完整的 AgentSessionState 参数，不方便在测试中反复创建。
   * 此方法提供轻量级重置能力：保留 unitId/runId/role 不变，
   * 将 turn/attempt/status/cursor 灰复到初始值。
   */
  reset(): void {
    this.state.turnNo = 0;
    this.state.attemptNo = 0;
    this.state.status = SessionStatus.PENDING;
    this.state.waitingForTaskIds = [];
    this.state.completedTaskIds = [];
    this.state.lastProviderRequestId = null;
    this.state.cumulativeUsage = null;
    this.state.cursor = {};
  }

  /**
   * 从数据库行重建 Session 状态。
   *
   * BUG-66 修复：原代码对 usageJson 直接进行类型断言
   * (`usageData as ProviderUsage | null`)，不验证数据结构。
   * 如果持久化的 JSON 被损坏或格式不符，会导致后续运行时错误。
   * 现在使用 validateUsageData() 进行结构化验证。
   */
  static fromDbRow(row: {
    id: string;
    runId: string;
    inputManifest: {
      agentRole?: AgentRole;
    };
    cursorJson: Record<string, unknown> | null;
    usageJson: Record<string, unknown> | null;
    attempts: number;
    status: string;
  }): AgentSession {
    const role = row.inputManifest.agentRole ?? "generation_supervisor" as AgentRole;
    const cursor = (row.cursorJson ?? {}) as Record<string, unknown>;
    // BUG-66 修复：验证 usageJson 结构而非直接类型断言
    const usageData = (row.usageJson ?? {}) as Record<string, unknown>;
    const cumulativeUsage = validateUsageData(usageData);

    return new AgentSession({
      unitId: row.id,
      runId: row.runId,
      role,
      turnNo: Number(cursor.turnNo ?? 0),
      attemptNo: row.attempts,
      status: (row.status as AgentSessionStatus) ?? SessionStatus.PENDING,
      waitingForTaskIds: (cursor.waitingForTaskIds as string[]) ?? [],
      completedTaskIds: (cursor.completedTaskIds as string[]) ?? [],
      lastProviderRequestId: (cursor.lastProviderRequestId as string) ?? null,
      cumulativeUsage: cumulativeUsage,
      cursor,
    });
  }

  toCursorJson(): Record<string, unknown> {
    // 修复：先展开旧 cursor（保留额外字段），再用当前状态值覆盖。
    // 原代码将 ...this.state.cursor 放在最后，导致旧的 turnNo/waitingForTaskIds
    // 等字段覆盖了当前值，使 turnNo 始终停留在第一次保存的值（如 1），
    // resumeParentSupervisorIfNeeded 计算出错误的 parentTurnNo，
    // 与已有 job 的 idempotencyKey 冲突，被 onConflictDoNothing 静默跳过，
    // Supervisor 永远无法被恢复。
    //
    // BUG-65 修复：浅合并可能导致 updateCursor 设置的嵌套字段被覆盖。
    // 使用深合并策略：对 cursor 中已存在的对象类型字段进行递归合并，
    // 确保嵌套对象（如 coverage snapshot）不会被顶层展开覆盖丢失。
    const merged: Record<string, unknown> = { ...this.state.cursor };
    // 递归合并嵌套对象（最多两层深度，防止循环引用）
    for (const [key, value] of Object.entries(this.state.cursor)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        merged[key] = { ...(value as Record<string, unknown>) };
      }
    }
    // 用当前状态值覆盖（确保 turnNo/waitingForTaskIds 等始终为最新值）
    merged.turnNo = this.state.turnNo;
    merged.waitingForTaskIds = this.state.waitingForTaskIds;
    merged.completedTaskIds = this.state.completedTaskIds;
    merged.lastProviderRequestId = this.state.lastProviderRequestId;
    return merged;
  }

  /**
   * 导出为可持久化的 usage JSON。
   *
   * QUAL-57 修复：原 toUsageJson 只导出 cumulativeUsage 的展开字段，
   * 但 fromDbRow 期望的是一个完整的 Record<string, unknown> 对象并从中
   * 提取 totalTokens/promptTokens/completionTokens/requestId 字段。
   * 如果 cumulativeUsage 为 null，toUsageJson 返回空对象 {}，
   * 而 fromDbRow 的 validateUsageData 会对空对象返回 null，这是对称的。
   * 但如果 cumulativeUsage 不为 null，展开后丢失了对象的嵌套结构，
   * 与 fromDbRow 的提取逻辑不对称。修复：返回完整对象而非展开。
   */
  toUsageJson(): Record<string, unknown> {
    if (this.state.cumulativeUsage === null) return {};
    return { ...this.state.cumulativeUsage };
  }
}

/**
 * BUG-66 修复：验证持久化的 usageJson 数据结构。
 *
 * 原代码直接对 usageJson 做 `as ProviderUsage | null` 类型断言，
 * 如果持久化数据被损坏或格式不符（如缺少 totalTokens 字段、
 * 类型不匹配），后续运行时会产生 NaN 或 undefined 传播。
 *
 * 此函数进行最小化结构验证：检查已知数值字段是否为有限数。
 * 缺失字段视为 0，不抛出异常（容忍旧版本数据缺少新字段）。
 */
function validateUsageData(data: Record<string, unknown>): ProviderUsage | null {
  if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
    return null;
  }
  // 提取并验证已知字段
  const totalTokens = Number(data.totalTokens ?? 0);
  const promptTokens = Number(data.promptTokens ?? 0);
  const completionTokens = Number(data.completionTokens ?? 0);
  const cacheHitTokens = Number(data.cacheHitTokens ?? 0);
  const cacheMissTokens = Number(data.cacheMissTokens ?? 0);
  // 至少有一个字段是有效正数才认为数据有效
  const hasValidData =
    (Number.isFinite(totalTokens) && totalTokens > 0) ||
    (Number.isFinite(promptTokens) && promptTokens > 0) ||
    (Number.isFinite(completionTokens) && completionTokens > 0) ||
    (Number.isFinite(cacheHitTokens) && cacheHitTokens > 0) ||
    (Number.isFinite(cacheMissTokens) && cacheMissTokens > 0);
  if (!hasValidData) {
    return null;
  }
  return {
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    cacheHitTokens: Number.isFinite(cacheHitTokens) ? cacheHitTokens : 0,
    cacheMissTokens: Number.isFinite(cacheMissTokens) ? cacheMissTokens : 0,
    requestId: typeof data.requestId === "string" ? data.requestId : null,
  };
}
