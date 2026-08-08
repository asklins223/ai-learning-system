/**
 * Learning Agent Session（阶段 03 / W2 任务 03-1）
 *
 * Session / Episode 状态模型（01-2 §5.2 / §7.2 / §7.7、01-1 §4 四阶段外壳）：
 * - `LearningSession` 是用户可见航程容器，串联 1~5 个 Episode；每个 Episode
 *   一个 `episodeId`，多 Episode 之间必须经过用户 checkpoint（03-2）；
 * - phase 覆盖四阶段外壳：PREPARE → SESSION_AGENT → INDEPENDENT_ASSESS → COMMIT；
 * - 每个 turn / attempt 记录留痕（审计、断线恢复只读 event/contract/artifact）。
 *
 * 本文件仅骨架：持久化（learning_sessions / learning_episodes 表，01-3 §2.1）
 * 与完整状态机迁移实现于 W2 后续任务（03-2/03-3）。
 */

import type { LearningAgentRole, LearningToolCall } from "./types.ts";

// ─── 1. Phase / Stage 枚举 ───────────────────────────────────────────────

/**
 * Session 级 phase（四阶段外壳 + 终态）。
 *
 * - prepared：PREPARE 完成，Episode contract 冻结（含 planHash/epoch/budgetEnvelope），等待 SESSION_AGENT；
 * - session_agent：有界 SESSION_AGENT 编排中（turns ≤ 8，trusted 内容性 follow-up = 0）；
 * - independent_assess：正式答案锁定后，独立 Agent Session 逐项评估中；
 * - committed：COMMIT 完成（该 Episode 已按 disposition 落 canonical / practice / operational）；
 * - cancelled：用户取消；当前与未开始 Episode 零副作用，已 commit Episode 保留（03-2 验收）；
 * - stale：fingerprint / epoch 失配，无正式副作用（01-2 §7.7）。
 */
export const LearningSessionPhase = {
  PREPARED: "prepared",
  SESSION_AGENT: "session_agent",
  INDEPENDENT_ASSESS: "independent_assess",
  COMMITTED: "committed",
  CANCELLED: "cancelled",
  STALE: "stale",
} as const;
export type LearningSessionPhase = (typeof LearningSessionPhase)[keyof typeof LearningSessionPhase];

/**
 * Episode 内 stage（细粒度子状态，供 checkpoint / 恢复 / 审计使用）。
 *
 * - episode_shell：Episode 容器刚建立（planHash 已冻结）；
 * - rubric_and_scene_prepare：RUBRIC_AND_SCENE_PREPARE 子流程（不向用户展示，01-1 §4）；
 * - formal_probes_frozen：首个 formal probe 展示前全部 trusted probes 已冻结；
 * - active：有界交互中（Scene 激活 / 用户作答）；
 * - answer_locked：正式答案已锁定（请求带 nonce + idempotency + 各 hash）；
 * - assessing：INDEPENDENT_ASSESS；
 * - committing：COMMIT 事务执行中；
 * - done / cancelled / stale：终态。
 */
export const LearningEpisodeStage = {
  EPISODE_SHELL: "episode_shell",
  RUBRIC_AND_SCENE_PREPARE: "rubric_and_scene_prepare",
  FORMAL_PROBES_FROZEN: "formal_probes_frozen",
  ACTIVE: "active",
  ANSWER_LOCKED: "answer_locked",
  ASSESSING: "assessing",
  COMMITTING: "committing",
  DONE: "done",
  CANCELLED: "cancelled",
  STALE: "stale",
} as const;
export type LearningEpisodeStage = (typeof LearningEpisodeStage)[keyof typeof LearningEpisodeStage];

// ─── 2. Turn / Attempt 记录 ──────────────────────────────────────────────

/** 一次 Agent turn 的记录（留痕，供审计与断线恢复） */
export interface LearningTurnRecord {
  turnNo: number;
  role: LearningAgentRole;
  toolCalls: LearningToolCall[];
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  error: string | null;
}

/** 一次 provider attempt 的记录（一次 attempt 最多一次 provider 请求） */
export interface LearningAttemptRecord {
  turnNo: number;
  attemptNo: number;
  providerRequestId: string | null;
  status: "running" | "completed" | "failed";
}

// ─── 3. Session 状态 ─────────────────────────────────────────────────────

/** Learning Agent Session 状态快照 */
export interface LearningAgentSessionState {
  sessionId: string;
  episodeId: string;
  workspaceId: string;
  userId: string;
  phase: LearningSessionPhase;
  episodeStage: LearningEpisodeStage;

  // ── contract epoch 与 planHash（任务 03-6 / 01-2 §5.3） ────────────────
  /** 冻结的 runtime epoch 快照；落库前必须重比较 */
  runtimeEpochSnapshot: number;
  /** 冻结的 Episode epoch；落库前必须重比较 */
  episodeEpoch: number;
  /** planHash：覆盖 scheduling decision、epoch、commit policy、capability closure、budget ref/hash、frozen probe hashes */
  planHash: string;

  // ── turn / attempt 游标 ────────────────────────────────────────────────
  turnNo: number;
  attemptNo: number;
  turns: LearningTurnRecord[];
  attempts: LearningAttemptRecord[];

  // ── 生命周期 / 恢复 ────────────────────────────────────────────────────
  /** 最近一次用户活动时间（inactivity 30min 判断基准） */
  lastActivityAt: string;
  /** 暂停时间（pause TTL 恢复时必须重查 source/policy/assistance stale） */
  pausedAt: string | null;
  /** 最后一次 provider request ID */
  lastProviderRequestId: string | null;
  /** Cursor（从 event/contract 重建上下文；不来自无限增长的 messages） */
  cursor: Record<string, unknown>;
}

// ─── 4. LearningAgentSession ─────────────────────────────────────────────

/**
 * Learning Agent Session 管理器。
 *
 * 有界、可恢复的 Agent loop 容器（对齐 generation AgentSession 模式，但状态模型独立）。
 * 状态持久化与恢复实现于 W2 后续任务（03-2/03-3）；此处提供内存骨架。
 */
export class LearningAgentSession {
  private state: LearningAgentSessionState;

  constructor(initial: LearningAgentSessionState) {
    this.state = { ...initial };
  }

  /**
   * 从 PREPARE 结果创建已冻结的 Session（phase = prepared）。
   * 后续仅能在有界 loop 内推进 phase。
   */
  static createPrepared(initial: {
    sessionId: string;
    episodeId: string;
    workspaceId: string;
    userId: string;
    runtimeEpochSnapshot: number;
    episodeEpoch: number;
    planHash: string;
  }): LearningAgentSession {
    return new LearningAgentSession({
      sessionId: initial.sessionId,
      episodeId: initial.episodeId,
      workspaceId: initial.workspaceId,
      userId: initial.userId,
      phase: LearningSessionPhase.PREPARED,
      episodeStage: LearningEpisodeStage.EPISODE_SHELL,
      runtimeEpochSnapshot: initial.runtimeEpochSnapshot,
      episodeEpoch: initial.episodeEpoch,
      planHash: initial.planHash,
      turnNo: 0,
      attemptNo: 0,
      turns: [],
      attempts: [],
      lastActivityAt: new Date().toISOString(),
      pausedAt: null,
      lastProviderRequestId: null,
      cursor: {},
    });
  }

  /** 获取当前状态快照（深拷贝，防止调用方修改内部状态） */
  getState(): Readonly<LearningAgentSessionState> {
    return {
      ...this.state,
      turns: this.state.turns.map((t) => ({ ...t, toolCalls: t.toolCalls.map((c) => ({ ...c })) })),
      attempts: this.state.attempts.map((a) => ({ ...a })),
      cursor: { ...this.state.cursor },
    };
  }

  // ── turn / attempt ─────────────────────────────────────────────────────

  /** 开始一个新 turn（turnNo 递增，attemptNo 重置） */
  startTurn(role: LearningAgentRole): void {
    this.state.turnNo += 1;
    this.state.attemptNo = 0;
    this.state.turns.push({
      turnNo: this.state.turnNo,
      role,
      toolCalls: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      error: null,
    });
  }

  /** 开始一次 attempt */
  startAttempt(): void {
    this.state.attemptNo += 1;
    this.state.attempts.push({
      turnNo: this.state.turnNo,
      attemptNo: this.state.attemptNo,
      providerRequestId: null,
      status: "running",
    });
  }

  /** 记录 provider 调用结果并完成当前 attempt */
  recordProviderCall(usage: { requestId?: string | null }, requestId: string | null): void {
    this.state.lastProviderRequestId = requestId ?? usage.requestId ?? null;
    const lastAttempt = this.state.attempts[this.state.attempts.length - 1];
    if (lastAttempt) {
      lastAttempt.providerRequestId = this.state.lastProviderRequestId;
      lastAttempt.status = "completed";
    }
  }

  /** 完成当前 turn（写入 toolCalls 与 finish 时间） */
  completeTurn(toolCalls: LearningToolCall[]): void {
    const lastTurn = this.state.turns[this.state.turns.length - 1];
    if (lastTurn) {
      lastTurn.toolCalls = toolCalls.map((c) => ({ ...c }));
      lastTurn.status = "completed";
      lastTurn.finishedAt = new Date().toISOString();
    }
  }

  /** 标记当前 turn 失败 */
  failTurn(error: string): void {
    const lastTurn = this.state.turns[this.state.turns.length - 1];
    if (lastTurn) {
      lastTurn.status = "failed";
      lastTurn.finishedAt = new Date().toISOString();
      lastTurn.error = error;
    }
    const lastAttempt = this.state.attempts[this.state.attempts.length - 1];
    if (lastAttempt && lastAttempt.status === "running") {
      lastAttempt.status = "failed";
    }
  }

  // ── phase / stage 迁移 ─────────────────────────────────────────────────

  /** 推进 Session phase（骨架：合法迁移矩阵实现于 W2 后续任务 03-2/03-3） */
  transitionPhase(next: LearningSessionPhase): void {
    this.state.phase = next;
  }

  /** 推进 Episode stage */
  transitionStage(next: LearningEpisodeStage): void {
    this.state.episodeStage = next;
  }

  /** 记录用户活动（inactivity 判断基准更新） */
  touchActivity(): void {
    this.state.lastActivityAt = new Date().toISOString();
    this.state.pausedAt = null;
  }

  /** 标记暂停（pause TTL 起点） */
  pause(): void {
    this.state.pausedAt = new Date().toISOString();
  }

  // ── 终态 ───────────────────────────────────────────────────────────────

  /** 标记 cancelled（当前与未开始 Episode 零副作用；已 commit 保留） */
  cancel(): void {
    this.state.phase = LearningSessionPhase.CANCELLED;
    this.state.episodeStage = LearningEpisodeStage.CANCELLED;
  }

  /** 标记 stale（fingerprint/epoch 失配，无正式副作用） */
  markStale(): void {
    this.state.phase = LearningSessionPhase.STALE;
    this.state.episodeStage = LearningEpisodeStage.STALE;
  }

  /** 标记 failed（内部失败，非用户取消；对齐 generation session.fail） */
  fail(): void {
    // 骨架：保留 phase，由上层决定 stale / cancelled / operational 归并；
    // 完整失败语义实现于 W2 后续任务。
  }

  /** 更新 cursor（从 event/contract 重建上下文） */
  updateCursor(cursor: Record<string, unknown>): void {
    this.state.cursor = { ...this.state.cursor, ...cursor };
  }
}
