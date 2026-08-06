/**
 * Agent 预算追踪器（计划 §5.5, §11.2）
 *
 * 职责：
 * - 跟踪各角色的 turn/tool call/provider call/token 使用量
 * - 在 hard cap 达到时立即停止并进入 needs_attention/budget_exhausted
 * - 保守 reservation：崩溃后不因重启消失
 *
 * 不变量：
 * - 达到 hard cap 立即停止，绝不 partial publish
 * - 一次 transport attempt 对应一次 budget reservation
 * - 崩溃后的保守 reservation 不因重启消失
 */

import type {
  AgentRole,
  ProviderUsage,
  RunBudget,
} from "@ailearn/shared";
import { createDefaultRunBudget, DEFAULT_ROLE_BUDGETS } from "@ailearn/shared";

/** 预算使用快照 */
export interface BudgetUsage {
  /** 各角色的使用量 */
  roles: Record<string, RoleUsage>;
  /** 已使用 provider 调用次数 */
  providerCalls: number;
  /** 已使用输入 token */
  inputTokens: number;
  /** 已使用输出 token */
  outputTokens: number;
  /** 已使用 embedding token */
  embeddingTokens: number;
  /** 当前并行任务数 */
  currentParallelTasks: number;
}

/** 单个角色的使用量 */
export interface RoleUsage {
  turns: number;
  toolCalls: number;
  activeTasks: number;
}

/** 预算耗尽错误 */
export class BudgetExhaustedError extends Error {
  readonly role: AgentRole | "global";
  readonly limit: string;
  readonly current: number;
  readonly max: number;

  constructor(
    role: AgentRole | "global",
    limit: string,
    current: number,
    max: number,
  ) {
    super(`预算耗尽：${role} 的 ${limit} 已达上限 (${current}/${max})`);
    this.name = "BudgetExhaustedError";
    this.role = role;
    this.limit = limit;
    this.current = current;
    this.max = max;
  }
}

/**
 * Agent 预算追踪器。
 *
 * 在 PREPARE 阶段冻结预算快照，运行期间不可修改。
 * 一次 job attempt 最多一次 provider 请求。
 */
export class BudgetTracker {
  private readonly budget: RunBudget;
  private usage: BudgetUsage;
  private readonly deadline: number;

  /**
   * R26 修复：默认预算使用 createDefaultRunBudget() 获取动态截止时间。
   */
  constructor(budget: RunBudget = createDefaultRunBudget()) {
    this.budget = budget;
    this.deadline = new Date(budget.runDeadline).getTime();
    this.usage = {
      roles: {},
      providerCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      embeddingTokens: 0,
      currentParallelTasks: 0,
    };
  }

  /**
   * 从持久化的使用量快照恢复 usage 状态。
   *
   * 计划 §5.5: 崩溃后的保守 reservation 不因重启消失。
   * 每次创建 BudgetTracker 时，从 run 的 usage_summary 或 agent events 恢复已有的使用量。
   *
   * 修复前：每次 turn 重新创建 BudgetTracker，usage 从零开始，
   * 导致已用 provider calls 和 token 不被计入，可能超出 hard cap。
   */
  restoreUsage(usage: Partial<BudgetUsage>): void {
    // BUG-45 修复：验证恢复值的合法性，防止恶意或损坏的持久化数据
    // 导致负数 usage 或超出预算上限的值被接受。
    // 验证策略：非负整数检查，currentParallelTasks 额外检查不超过 maxParallelTasks。
    if (usage.providerCalls !== undefined) {
      const v = Number(usage.providerCalls);
      if (!Number.isFinite(v) || v < 0) {
        throw new Error(`restoreUsage: providerCalls 值非法 (${String(usage.providerCalls)})`);
      }
      this.usage.providerCalls = Math.floor(v);
    }
    if (usage.inputTokens !== undefined) {
      const v = Number(usage.inputTokens);
      if (!Number.isFinite(v) || v < 0) {
        throw new Error(`restoreUsage: inputTokens 值非法 (${String(usage.inputTokens)})`);
      }
      this.usage.inputTokens = Math.floor(v);
    }
    if (usage.outputTokens !== undefined) {
      const v = Number(usage.outputTokens);
      if (!Number.isFinite(v) || v < 0) {
        throw new Error(`restoreUsage: outputTokens 值非法 (${String(usage.outputTokens)})`);
      }
      this.usage.outputTokens = Math.floor(v);
    }
    if (usage.embeddingTokens !== undefined) {
      const v = Number(usage.embeddingTokens);
      if (!Number.isFinite(v) || v < 0) {
        throw new Error(`restoreUsage: embeddingTokens 值非法 (${String(usage.embeddingTokens)})`);
      }
      this.usage.embeddingTokens = Math.floor(v);
    }
    // BUG-16: 恢复 currentParallelTasks。serializeUsage 已将此字段写入持久化 JSON，
    // 但 restoreUsage 遗漏了恢复逻辑，导致 Supervisor 崩溃重启后并行任务计数从 0 开始，
    // 可能超出 maxParallelTasks 上限。
    if (usage.currentParallelTasks !== undefined) {
      const v = Number(usage.currentParallelTasks);
      if (!Number.isFinite(v) || v < 0) {
        throw new Error(`restoreUsage: currentParallelTasks 值非法 (${String(usage.currentParallelTasks)})`);
      }
      // 不超过 maxParallelTasks 上限，防止恢复后立即超限
      this.usage.currentParallelTasks = Math.min(Math.floor(v), this.budget.maxParallelTasks);
    }
    if (usage.roles) {
      for (const [role, roleUsage] of Object.entries(usage.roles)) {
        this.usage.roles[role as AgentRole] = { ...roleUsage };
      }
    }
  }

  /**
   * 序列化当前 usage 为可持久化的 JSON。
   * BUG-81 修复：返回 roles 的浅拷贝而非直接引用，防止调用方修改影响内部状态。
   */
  serializeUsage(): Record<string, unknown> {
    const rolesCopy: Record<string, RoleUsage> = {};
    for (const [role, usage] of Object.entries(this.usage.roles)) {
      rolesCopy[role] = { ...usage };
    }
    return {
      roles: rolesCopy,
      providerCalls: this.usage.providerCalls,
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      embeddingTokens: this.usage.embeddingTokens,
      currentParallelTasks: this.usage.currentParallelTasks,
    };
  }

  /** 获取当前使用量快照（不可变） */
  getUsage(): Readonly<BudgetUsage> {
    return { ...this.usage, roles: { ...this.usage.roles } };
  }

  /** 获取预算配置（只读） */
  getBudget(): Readonly<RunBudget> {
    return this.budget;
  }

  /** 检查是否已超过截止时间 */
  isDeadlineExceeded(now: number = Date.now()): boolean {
    return now >= this.deadline;
  }

  /**
   * 检查指定角色是否已达到 maxTurns 上限。
   *
   * 用于在创建新 turn job 之前预检，避免创建注定失败的 turn。
   * 注意：此方法只读检查，不递增 turns。
   *
   * 设计决策（2026-08-04）：不再对单个角色设置 maxTurns 执行上限。
   * 每个角色（extractor/critic/supervisor）可以持续重试直到成功；
   * 防止无限循环由 run 级全局机制兜底：maxProviderCalls、runDeadline、
   * maxInputTokens/maxOutputTokens。避免出现"角色因 2-3 次 reasoning 截断
   * 失败就整个 run 死亡"的问题。
   */
  isRoleTurnsExhausted(_role: AgentRole): boolean {
    return false;
  }

  /** 检查全局 provider 调用是否已耗尽 */
  canMakeProviderCall(): boolean {
    return (
      this.usage.providerCalls < this.budget.maxProviderCalls
      && !this.isDeadlineExceeded()
    );
  }

  /**
   * 预留一次 provider 调用。
   * 如果预算不足，抛出 BudgetExhaustedError。
   */
  reserveProviderCall(role: AgentRole): void {
    if (this.isDeadlineExceeded()) {
      throw new BudgetExhaustedError("global", "runDeadline", Date.now(), this.deadline);
    }
    if (this.usage.providerCalls >= this.budget.maxProviderCalls) {
      throw new BudgetExhaustedError("global", "maxProviderCalls", this.usage.providerCalls, this.budget.maxProviderCalls);
    }
    this.checkRoleBudget(role);
  }

  /**
   * 结算一次 provider 调用的实际用量。
   * BUG-91 修复：先检查是否会超限，再递增，避免超限后无法回滚。
   */
  settleProviderCall(_role: AgentRole, usage: ProviderUsage | null): void {
    // 先计算预期值，检查是否会超限
    const expectedProviderCalls = this.usage.providerCalls + 1;
    const expectedInputTokens = this.usage.inputTokens + (usage?.promptTokens ?? 0);
    const expectedOutputTokens = this.usage.outputTokens + (usage?.completionTokens ?? 0);

    if (expectedProviderCalls > this.budget.maxProviderCalls) {
      throw new BudgetExhaustedError("global", "maxProviderCalls", expectedProviderCalls, this.budget.maxProviderCalls);
    }
    if (expectedInputTokens > this.budget.maxInputTokens) {
      throw new BudgetExhaustedError("global", "maxInputTokens", expectedInputTokens, this.budget.maxInputTokens);
    }
    if (expectedOutputTokens > this.budget.maxOutputTokens) {
      throw new BudgetExhaustedError("global", "maxOutputTokens", expectedOutputTokens, this.budget.maxOutputTokens);
    }

    // 检查通过后再递增
    this.usage.providerCalls = expectedProviderCalls;
    if (usage) {
      if (usage.promptTokens) this.usage.inputTokens += usage.promptTokens;
      if (usage.completionTokens) this.usage.outputTokens += usage.completionTokens;
    }
  }

  /**
   * 预留一次 turn。
   *
   * 设计决策（2026-08-04）：不再检查角色级 maxTurns。角色可一直重试，
   * 由 run 级 maxProviderCalls / runDeadline 兜底。
   */
  reserveTurn(role: AgentRole): void {
    this.ensureRoleUsage(role);
    this.usage.roles[role]!.turns += 1;
  }

  /**
   * 预留一次 tool call。
   *
   * 设计决策（2026-08-04）：不再检查角色级 maxToolCalls。角色可一直调用，
   * 由 run 级 maxProviderCalls / maxToolCalls 对应全局上限兜底。
   */
  reserveToolCall(role: AgentRole): void {
    this.ensureRoleUsage(role);
    this.usage.roles[role]!.toolCalls += 1;
  }

  /**
   * 预留一个并行任务。
   */
  reserveParallelTask(role: AgentRole): void {
    this.ensureRoleUsage(role);
    const roleBudget = this.budget.roles[role] ?? DEFAULT_ROLE_BUDGETS[role];
    const roleUsage = this.usage.roles[role]!;
    if (roleUsage.activeTasks >= roleBudget.maxConcurrent) {
      throw new BudgetExhaustedError(role, "maxConcurrent", roleUsage.activeTasks, roleBudget.maxConcurrent);
    }
    if (this.usage.currentParallelTasks >= this.budget.maxParallelTasks) {
      throw new BudgetExhaustedError("global", "maxParallelTasks", this.usage.currentParallelTasks, this.budget.maxParallelTasks);
    }
    roleUsage.activeTasks += 1;
    this.usage.currentParallelTasks += 1;
  }

  /**
   * 释放一个并行任务。
   */
  releaseParallelTask(role: AgentRole): void {
    this.ensureRoleUsage(role);
    const roleUsage = this.usage.roles[role]!;
    if (roleUsage.activeTasks > 0) roleUsage.activeTasks -= 1;
    if (this.usage.currentParallelTasks > 0) this.usage.currentParallelTasks -= 1;
  }

  /**
   * 预留 embedding token 用量。
   */
  reserveEmbeddingTokens(tokens: number): void {
    if (this.usage.embeddingTokens + tokens > this.budget.maxEmbeddingTokens) {
      throw new BudgetExhaustedError("global", "maxEmbeddingTokens", this.usage.embeddingTokens + tokens, this.budget.maxEmbeddingTokens);
    }
    this.usage.embeddingTokens += tokens;
  }

  /**
   * 检查角色级预算。
   *
   * 设计决策（2026-08-04）：不再检查角色级 maxTurns/maxToolCalls。
   * 角色可一直重试，由 run 级 maxProviderCalls / runDeadline / token 上限兜底。
   */
  private checkRoleBudget(_role: AgentRole): void {
    // 角色级执行上限已移除，保留此方法为空实现以维持调用契约。
  }

  /** 确保角色使用量记录存在 */
  private ensureRoleUsage(role: AgentRole): void {
    if (!this.usage.roles[role]) {
      this.usage.roles[role] = { turns: 0, toolCalls: 0, activeTasks: 0 };
    }
  }
}
