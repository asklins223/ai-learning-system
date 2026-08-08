/**
 * Learning Budget Tracker（阶段 03 / W2 任务 03-1，任务 03-6 执行基础）
 *
 * 独立于 generation 的 BudgetTracker（task 03-1：budget 与 Generation Supervisor 完全独立）。
 * 冻结依据（01-1 §6 Agent Loop 硬边界、03-3）：
 * - Session Supervisor turns ≤ 8；
 * - trusted 内容性动态 follow-up = 0（公测 v1，全部 formal probe 预冻结）；
 * - 每条路线 Encounter 2~5；
 * - 同时 active 学习会话每用户 1；
 * - 单次 Agent turn deadline ≤ 120s（由 Provider/ASR policy 冻结）；
 * - Session inactivity expiry 建议 30 分钟（只结束 active UI，不回滚已 commit Episode）；
 * - Pause TTL 由 W0 冻结；恢复时必须重查 source/policy/assistance stale。
 *
 * BudgetEnvelope 不可借用语义（01-2 §5.3 / 03-2）：展示首个 formal Scene 前预留
 * 全部 required probes、一次允许的重录/结构修正上限、Assessment Critic 重试与 commit
 * 所需额度；Learning Agent 不得借用 generation run 预算，generation 也不得借用本 envelope。
 *
 * 本文件仅骨架：完整预算执行（超限即停、crash 后保守 reservation 不消失）实现于 W2 后续任务。
 */

import type { LearningAgentRole } from "./types.ts";

// ─── 1. 冻结的 Loop 硬边界 ───────────────────────────────────────────────

/** W0 冻结的 Agent Loop 硬边界（01-1 §6 / 03-3） */
export const LEARNING_LOOP_BOUNDS = {
  /** 每个 Session Supervisor turns */
  maxSessionSupervisorTurns: 8,
  /** trusted 内容性动态 follow-up（公测 v1） */
  trustedContentFollowUp: 0,
  /** 每条路线 Encounter 数 */
  routeEncounterMin: 2,
  routeEncounterMax: 5,
  /** 同时 active 学习会话每用户 */
  maxConcurrentActiveSessionsPerUser: 1,
  /** 单次 Agent turn deadline（由 Provider/ASR policy 冻结，建议 ≤120s） */
  turnDeadlineMs: 120_000,
  /** Session inactivity expiry（只结束 active UI，不回滚已 commit Episode） */
  inactivityExpiryMs: 30 * 60_000,
  /** Pause TTL：W0 冻结；恢复时必须重查 source/policy/assistance stale */
  pauseTtlMs: 30 * 60_000,
  /** Grounded Tutor 单问题补查工具调用上限（01-1 §6） */
  groundedTutorToolCallsPerQuestion: 3,
} as const;

/** Learning 预算策略（PREPARE 时冻结，运行期间不可修改） */
export interface LearningBudgetPolicy {
  maxSessionSupervisorTurns: number;
  trustedContentFollowUp: number;
  routeEncounterMin: number;
  routeEncounterMax: number;
  maxConcurrentActiveSessionsPerUser: number;
  turnDeadlineMs: number;
  inactivityExpiryMs: number;
  pauseTtlMs: number;
  groundedTutorToolCallsPerQuestion: number;
}

/** 默认预算策略（来自 W0 冻结硬边界） */
export function createDefaultLearningBudgetPolicy(): LearningBudgetPolicy {
  return { ...LEARNING_LOOP_BOUNDS };
}

// ─── 2. BudgetEnvelope（不可借用语义，01-2 §5.3） ───────────────────────

/**
 * Learning BudgetEnvelope。
 *
 * 不可借用语义：
 * - `nonBorrowable: true` 是字面量类型，类型层面禁止把本 envelope 与 generation run
 *   预算混用、也禁止 Learning 各角色之间互相借用额度；
 * - PREPARE 创建 envelope；展示首个 formal Scene 前必须预留全部 required probes、
 *   一次允许的重录/结构修正上限、Assessment Critic 重试与 commit 所需额度；
 * - 预算不足必须在用户作答前阻断（03-2 验收）。
 */
export interface LearningBudgetEnvelope {
  envelopeRef: string;
  envelopeHash: string;
  /** 字面量 true：不可借用 */
  readonly nonBorrowable: true;
  /** envelope 冻结时的 runtime epoch（任务 03-6 重比较） */
  frozenRuntimeEpoch: number;
  /** 预留额度 */
  reserved: {
    /** 完成全部 required probes 所需额度 */
    requiredProbes: number;
    /** 一次允许的重录/结构修正上限 */
    maxReRecordOrStructuralFix: number;
    /** Assessment Critic 重试次数额度 */
    assessmentCriticRetries: number;
    /** deterministic commit 所需额度 */
    commitAllocation: number;
  };
  /** practice detour 使用独立 envelope（01-w0 §16.6，Tutor 不借用本 envelope） */
  groundedTutorEnvelopeRef: string;
}

// ─── 3. 预算使用快照 ─────────────────────────────────────────────────────

/** 单角色使用量 */
export interface LearningRoleUsage {
  turns: number;
  toolCalls: number;
  providerCalls: number;
}

/** 预算使用快照 */
export interface LearningBudgetUsage {
  roles: Record<LearningAgentRole, LearningRoleUsage>;
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/** 预算耗尽错误 */
export class LearningBudgetExhaustedError extends Error {
  readonly role: LearningAgentRole | "envelope";
  readonly limit: string;
  readonly current: number;
  readonly max: number;

  constructor(
    role: LearningAgentRole | "envelope",
    limit: string,
    current: number,
    max: number,
  ) {
    super(`学习预算耗尽：${role} 的 ${limit} 已达上限 (${current}/${max})`);
    this.name = "LearningBudgetExhaustedError";
    this.role = role;
    this.limit = limit;
    this.current = current;
    this.max = max;
  }
}

// ─── 4. LearningBudgetTracker ────────────────────────────────────────────

/**
 * Learning 预算追踪器。
 *
 * 不变量（对齐 generation 但独立实现）：
 * - 达到 hard cap 立即停止，绝不产生部分副作用；
 * - 一次 provider/job attempt 最多一次外部模型调用（01-3 §5）；
 * - crash 后的保守 reservation 不因重启消失（持久化实现于 W2 后续任务）。
 */
export class LearningBudgetTracker {
  private readonly policy: LearningBudgetPolicy;
  private readonly envelope: LearningBudgetEnvelope | null;
  private usage: LearningBudgetUsage;

  constructor(
    policy: LearningBudgetPolicy = createDefaultLearningBudgetPolicy(),
    envelope: LearningBudgetEnvelope | null = null,
  ) {
    this.policy = { ...policy };
    this.envelope = envelope ? { ...envelope, reserved: { ...envelope.reserved } } : null;
    this.usage = {
      roles: {
        session_supervisor: { turns: 0, toolCalls: 0, providerCalls: 0 },
        scene_author: { turns: 0, toolCalls: 0, providerCalls: 0 },
        rubric_scene_critic: { turns: 0, toolCalls: 0, providerCalls: 0 },
        assessment_critic: { turns: 0, toolCalls: 0, providerCalls: 0 },
        grounded_tutor: { turns: 0, toolCalls: 0, providerCalls: 0 },
        grounded_answer_critic: { turns: 0, toolCalls: 0, providerCalls: 0 },
        scene_activation: { turns: 0, toolCalls: 0, providerCalls: 0 },
        deterministic_core: { turns: 0, toolCalls: 0, providerCalls: 0 },
      },
      providerCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  /** 获取预算策略（只读快照） */
  getPolicy(): Readonly<LearningBudgetPolicy> {
    return { ...this.policy };
  }

  /** 获取 envelope（只读；null 表示尚未 PREPARE 冻结） */
  getEnvelope(): Readonly<LearningBudgetEnvelope> | null {
    return this.envelope;
  }

  /** 获取使用量快照（只读） */
  getUsage(): Readonly<LearningBudgetUsage> {
    const roles: Record<LearningAgentRole, LearningRoleUsage> = {} as Record<LearningAgentRole, LearningRoleUsage>;
    for (const [role, usage] of Object.entries(this.usage.roles)) {
      roles[role as LearningAgentRole] = { ...usage };
    }
    return { ...this.usage, roles };
  }

  /**
   * 校验 BudgetEnvelope 不可借用语义。
   * 本 tracker 绑定的是 Learning 专用 envelope；generation 的 RunBudget 不可注入。
   */
  assertEnvelopeNonBorrowable(): void {
    if (this.envelope === null) {
      // 骨架：无 envelope 时允许纯 loop 预算（practice/diagnostic 路径）；
      // formal Episode 必须绑定 envelope，强制检查实现于 W2 后续任务。
      return;
    }
    if (!this.envelope.nonBorrowable) {
      throw new Error("BudgetEnvelope 必须为不可借用（nonBorrowable=true）");
    }
  }

  /**
   * PREPARE 预算充足性预检（03-2）：预算不足必须在用户作答前阻断。
   * 骨架仅做结构性检查；真实额度计算实现于 W2 后续任务。
   */
  isEnvelopeSufficient(): boolean {
    if (this.envelope === null) return true;
    const reserved = this.envelope.reserved;
    return reserved.requiredProbes >= 0
      && reserved.maxReRecordOrStructuralFix >= 0
      && reserved.assessmentCriticRetries >= 0
      && reserved.commitAllocation >= 0;
  }

  // ── turn / provider / tool 预算 ────────────────────────────────────────

  /** 预留一次 turn。Session Supervisor 上限 = 8（W0 冻结）；其他角色骨架不限 */
  reserveTurn(role: LearningAgentRole): void {
    this.ensureRoleUsage(role);
    const usage = this.usage.roles[role]!;
    if (role === "session_supervisor") {
      const max = this.policy.maxSessionSupervisorTurns;
      if (usage.turns >= max) {
        throw new LearningBudgetExhaustedError(role, "maxSessionSupervisorTurns", usage.turns, max);
      }
    }
    usage.turns += 1;
  }

  /** 预留一次 tool call（骨架：envelope 校验后递增） */
  reserveToolCall(role: LearningAgentRole): void {
    this.assertEnvelopeNonBorrowable();
    this.ensureRoleUsage(role);
    this.usage.roles[role]!.toolCalls += 1;
  }

  /** 预留一次 provider 调用（骨架：一次 attempt 最多一次 provider 请求） */
  reserveProviderCall(role: LearningAgentRole): void {
    this.assertEnvelopeNonBorrowable();
    this.ensureRoleUsage(role);
    this.usage.roles[role]!.providerCalls += 1;
    this.usage.providerCalls += 1;
  }

  /** 结算一次 provider 调用的实际用量 */
  settleProviderCall(_role: LearningAgentRole, usage: { promptTokens?: number; completionTokens?: number } | null): void {
    if (usage) {
      this.usage.inputTokens += usage.promptTokens ?? 0;
      this.usage.outputTokens += usage.completionTokens ?? 0;
    }
  }

  // ── deadline / inactivity / pause TTL ──────────────────────────────────

  /** 单次 Agent turn deadline 是否超时（≤120s，W0 冻结） */
  isTurnDeadlineExceeded(startedAtMs: number, now: number = Date.now()): boolean {
    return now - startedAtMs > this.policy.turnDeadlineMs;
  }

  /** Session inactivity 是否过期（30 分钟；只结束 active UI，不回滚已 commit Episode） */
  isSessionInactive(lastActivityAtMs: number, now: number = Date.now()): boolean {
    return now - lastActivityAtMs > this.policy.inactivityExpiryMs;
  }

  /** Pause TTL 是否过期（W0 冻结；恢复时必须重查 source/policy/assistance stale） */
  isPauseExpired(pausedAtMs: number, now: number = Date.now()): boolean {
    return now - pausedAtMs > this.policy.pauseTtlMs;
  }

  // ── 序列化 / 恢复 ──────────────────────────────────────────────────────

  /** 序列化为可持久化 JSON（crash 后保守 reservation 不消失，01-3 §5） */
  serializeUsage(): Record<string, unknown> {
    const roles: Record<string, LearningRoleUsage> = {};
    for (const [role, usage] of Object.entries(this.usage.roles)) {
      roles[role] = { ...usage };
    }
    return {
      roles,
      providerCalls: this.usage.providerCalls,
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
    };
  }

  /** 从持久化快照恢复（骨架：负值/越界值校验实现于 W2 后续任务） */
  restoreUsage(usage: Partial<LearningBudgetUsage>): void {
    if (usage.providerCalls !== undefined && usage.providerCalls >= 0) {
      this.usage.providerCalls = Math.floor(usage.providerCalls);
    }
    if (usage.inputTokens !== undefined && usage.inputTokens >= 0) {
      this.usage.inputTokens = Math.floor(usage.inputTokens);
    }
    if (usage.outputTokens !== undefined && usage.outputTokens >= 0) {
      this.usage.outputTokens = Math.floor(usage.outputTokens);
    }
    if (usage.roles) {
      for (const [role, roleUsage] of Object.entries(usage.roles)) {
        const r = role as LearningAgentRole;
        if (this.usage.roles[r]) {
          this.usage.roles[r] = { ...roleUsage };
        }
      }
    }
  }

  /** 确保角色使用量记录存在 */
  private ensureRoleUsage(role: LearningAgentRole): void {
    if (!this.usage.roles[role]) {
      this.usage.roles[role] = { turns: 0, toolCalls: 0, providerCalls: 0 };
    }
  }
}
