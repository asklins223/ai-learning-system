/**
 * Budget、epoch 与 kill 政策执行器（阶段 03 / W2 任务 03-6）
 *
 * 冻结依据（01-1 §4.3/§5、01-2 §7.7/§11、03-w2-session-supervisor-runtime.md 任务 03-6）：
 * - 所有 turn/tool/Critic 结果落库前重新比较 contract 的
 *   `runtimeEpochSnapshot + episodeEpoch`（checkEpochsBeforeWrite，fail closed，
 *   失配抛 LearningEpochMismatchError）；
 * - COMMIT 使用 §4.3 固定锁序（COMMIT_LOCK_ORDER）与完整 CAS
 *   （assertCommitCasValid：runtimeEpoch=snapshot、episodeEpoch 未变、
 *   Episode active && !cancelled && !stale、content fingerprint 匹配、
 *   scheduling decision hash 匹配、kill=false；任一失败整体回滚，0 副作用）；
 * - hard kill 后的迟到 Provider/ASR/Critic 响应只记录不含用户内容的审计摘要
 *   （安全摘要白名单），不写 probe/artifact/assessment staging，也不恢复为
 *   trusted（handleHardKillLateResponse）；
 * - privacy/trust/scheduler hard incident：bump runtime epoch → fence 全部未
 *   commit Episode（已 commit 保留）→ 取消未完成外部 job，禁止 trusted 恢复
 *   （handleHardIncident，§17.2）；
 * - 断线恢复只读 event/contract/artifact，不重复 Provider 调用和业务副作用
 *   （recoverAfterDisconnect，只读端口注入）；
 * - budget/context/turn deadline/inactivity/pause TTL 全部生效
 *   （enforcePolicyBounds，复用 LEARNING_LOOP_BOUNDS；0 trusted 内容性
 *   follow-up 恒等断言）。
 *
 * 实现策略：
 * - 纯逻辑 + 可注入端口：DB / 外部 job / 只读数据源全部通过接口注入
 *   （单测用内存实现，真实实现由 03-2 / 阶段 06 接入）；
 * - 本模块不写掌握 / schedule 真值：审计记录与 incident 结果都是内存结果对象，
 *   canonical 事实只允许由 deterministic COMMIT（01-1 §5）投影产生。
 */

import type { LearningAgentRole } from "./types.ts";
import {
  LEARNING_LOOP_BOUNDS,
  type LearningBudgetPolicy,
  type LearningBudgetUsage,
} from "./budget.ts";
import { LearningEpochMismatchError, assertContractEpochValid } from "./runtime.ts";

// ─── 1. 落库前 epoch 重比较（§7.7） ───────────────────────────────────────

/** 冻结在 contract 上的 epoch 快照（PREPARE 时冻结，01-2 §5.2） */
export interface ContractEpochRef {
  /** PREPARE 冻结的 runtime epoch 快照 */
  runtimeEpochSnapshot: number;
  /** PREPARE 冻结的 Episode epoch */
  episodeEpoch: number;
}

/** 「当前 epoch 未知」哨兵（fail closed 用，绝不当作合法 epoch） */
export const UNKNOWN_EPOCH_SENTINEL = -1;

/**
 * 落库前 epoch 重比较（任务 03-6）。
 *
 * 所有 turn / tool / Critic 结果落库前重新读取当前 contract 的
 * `runtimeEpoch + episodeEpoch`，与 contract 冻结快照逐项比较；
 * 失配或当前值缺失（null / 哨兵 -1）即抛 LearningEpochMismatchError
 * （fail closed，调用方转为 stale / blocked / cancelled，0 学习副作用）。
 */
export function checkEpochsBeforeWrite(
  contract: ContractEpochRef,
  current: ContractEpochRef | null,
): void {
  if (current === null || current.runtimeEpochSnapshot < 0 || current.episodeEpoch < 0) {
    throw new LearningEpochMismatchError({
      expectedRuntimeEpoch: contract.runtimeEpochSnapshot,
      actualRuntimeEpoch: current === null ? UNKNOWN_EPOCH_SENTINEL : current.runtimeEpochSnapshot,
      expectedEpisodeEpoch: contract.episodeEpoch,
      actualEpisodeEpoch: current === null ? UNKNOWN_EPOCH_SENTINEL : current.episodeEpoch,
    });
  }
  assertContractEpochValid({
    expectedRuntimeEpoch: contract.runtimeEpochSnapshot,
    actualRuntimeEpoch: current.runtimeEpochSnapshot,
    expectedEpisodeEpoch: contract.episodeEpoch,
    actualEpisodeEpoch: current.episodeEpoch,
  });
}

// ─── 2. COMMIT 固定锁序与完整 CAS（01-1 §5） ──────────────────────────────

/**
 * COMMIT 固定锁序（01-1 §5 / 01-2 §7.7，数据库事务内按此顺序锁）：
 * runtime-control → learning_episode → authoritative target/version guard →
 * keyPoint schedule guard → input schedule（consume 时）。
 * 锁与 CAS 必须发生在同一事务内，cancel / 显式 stale / Generation publish 替换
 * 也经过相同 guard（不能在 COMMIT 检查与写入之间穿透）。
 */
export const COMMIT_LOCK_ORDER: readonly string[] = [
  "runtime-control",
  "learning_episode",
  "authoritative-target-version-guard",
  "keypoint-schedule-guard",
  "input-schedule",
] as const;

/** COMMIT 失败（fail closed：整体回滚为 stale/cancelled/blocked） */
export class LearningCommitBlockedError extends Error {
  readonly code: string;

  constructor(message: string, code = "COMMIT_BLOCKED") {
    super(message);
    this.name = "LearningCommitBlockedError";
    this.code = code;
  }
}

/** COMMIT 需要冻结的 content 引用（CAS 完整校验用） */
export interface CommitContractRef extends ContractEpochRef {
  /** 冻结的内容 fingerprint（01-2 §7.7：覆盖 Card/Key Point revision、RubricTarget、evidence、Scene 与 assistance policy） */
  episodeTargetFingerprint: string;
  /** 冻结的 scheduling decision hash */
  schedulingDecisionHash: string;
}

/** 当前 Episode 的 COMMIT 前状态（CAS 校验输入） */
export interface EpisodeCommitState {
  /** Episode 当前状态（必须 active 才可 COMMIT） */
  status: string;
  /** 当前内容 fingerprint（须与冻结一致） */
  episodeTargetFingerprint: string;
  /** 当前 scheduling decision hash（须与冻结一致） */
  schedulingDecisionHash: string;
  /** kill 开关（true = kill 生效，禁止 COMMIT） */
  kill: boolean;
}

/**
 * COMMIT 完整 CAS（01-1 §5，单次校验）：
 *
 * - `runtimeEpoch = snapshot`；
 * - `episodeEpoch` 未变；
 * - Episode `active && !cancelled && !stale`；
 * - content revision/fingerprint 匹配（与冻结一致）；
 * - scheduling decision hash 匹配；
 * - `kill = false`。
 *
 * 任一失败抛 LearningEpochMismatchError / LearningCommitBlockedError，
 * 调用方整体回滚为 stale / cancelled / blocked（0 学习副作用）。
 * 固定锁序见 COMMIT_LOCK_ORDER（数据库事务内由调用方按序锁，阶段 06 实现）。
 */
export function assertCommitCasValid(
  contract: CommitContractRef,
  current: ContractEpochRef | null,
  state: EpisodeCommitState,
): void {
  // 1) runtimeEpoch = snapshot + episodeEpoch 未变（fail closed）
  checkEpochsBeforeWrite(contract, current);
  // 2) Episode active && !cancelled && !stale
  if (state.status !== "active") {
    throw new LearningCommitBlockedError(
      `COMMIT 要求 Episode active && !cancelled && !stale（当前 status=${state.status}）`,
    );
  }
  // 3) content revision/fingerprint 匹配（与冻结一致）
  if (state.episodeTargetFingerprint !== contract.episodeTargetFingerprint) {
    throw new LearningCommitBlockedError(
      "COMMIT 内容 fingerprint 失配（fail closed，整体回滚为 stale）",
    );
  }
  // 4) scheduling decision hash 匹配（与冻结一致）
  if (state.schedulingDecisionHash !== contract.schedulingDecisionHash) {
    throw new LearningCommitBlockedError(
      "COMMIT scheduling decision hash 失配（fail closed，整体回滚为 blocked）",
    );
  }
  // 5) kill = false
  if (state.kill) {
    throw new LearningCommitBlockedError("kill=true：COMMIT 被 kill 开关阻断（fail closed）");
  }
}

// ─── 3. hard kill 迟到响应（§7.7） ────────────────────────────────────────

/**
 * hard kill 迟到响应审计摘要白名单（安全摘要键）。
 *
 * 只允许非内容字段：身份/定位、非内容状态、hash/版本、结构化安全摘要。
 * **绝不**允许含用户内容的键（answer / userAnswer / transcript / feedback /
 * reasoning / question 等原文，见 canonical-events PAYLOAD_DENIED_KEYS 同理念）。
 */
export const LATE_RESPONSE_AUDIT_ALLOWED_KEYS: readonly string[] = [
  // 身份与定位（不含内容）
  "eventType",
  "sessionId",
  "episodeId",
  "workspaceId",
  "userId",
  "actor",
  "turnNo",
  "attemptNo",
  "providerRequestId",
  "runId",
  // 非内容状态 / usage
  "finishReason",
  "tokensUsed",
  "occurredAt",
  "reasonCode",
  // hash / 幂等（content-free 指纹）
  "requestHash",
  "artifactHash",
  "idempotencyKey",
  // 结构化安全摘要（无原文）
  "outcomeSummary",
  "verdictSummary",
];

const LATE_RESPONSE_AUDIT_ALLOWED_SET: ReadonlySet<string> = new Set(
  LATE_RESPONSE_AUDIT_ALLOWED_KEYS,
);

/** hard kill 迟到响应审计错误（fail closed） */
export class LateResponseAuditError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "LateResponseAuditError";
    this.code = code;
  }
}

/** hard kill 生效后的迟到响应（Provider / ASR / Critic）输入 */
export interface HardKillLateResponseInput {
  /** 迟到响应来源角色（Provider / ASR / Critic 经角色归一化） */
  actor: LearningAgentRole;
  sessionId: string;
  episodeId: string;
  turnNo: number;
  attemptNo: number;
  providerRequestId: string | null;
  /** 完成原因：stop | tool_calls | length | content_filter | error */
  finishReason: string;
  tokensUsed: number;
  occurredAt?: string;
  /**
   * 附加安全摘要字段（可选）。**所有键必须位于白名单内**；含用户内容的键
   * （answer / userAnswer / transcript / feedback 等）一律抛 LateResponseAuditError，
   * 宁可丢弃整个审计也不允许用户内容进入审计记录。
   */
  auditFields?: Record<string, unknown>;
}

/** hard kill 迟到响应审计记录（不含用户内容；可持久化到 audit log） */
export interface LateResponseAuditRecord {
  eventType: "hard_kill_late_response";
  sessionId: string;
  episodeId: string;
  actor: LearningAgentRole;
  turnNo: number;
  attemptNo: number;
  providerRequestId: string | null;
  finishReason: string;
  tokensUsed: number;
  occurredAt: string;
  /** 安全摘要（仅白名单键，string/number） */
  summary: Readonly<Record<string, string | number>>;
}

function requireAuditString(value: string, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LateResponseAuditError(`审计字段 ${key} 缺失或为空（fail closed）`, "INVALID_AUDIT_FIELD");
  }
  return value;
}

function requireAuditNonNegative(value: number, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new LateResponseAuditError(`审计字段 ${key} 非法（须为非负有穷数字）`, "INVALID_AUDIT_FIELD");
  }
  return value;
}

/**
 * 从 hard kill 迟到响应构建安全审计记录（纯函数）。
 *
 * - 只保留白名单键；auditFields 中任何未知键（含用户内容的键）→ 抛错；
 * - 必填身份字段缺失 / 非法 → 抛错（fail closed）；
 * - 响应本身的 raw 内容（答案 / 音频 / 评估原文）**不进本函数**——调用方只应
 *   传入已剥离的安全摘要字段。
 */
export function buildLateResponseAudit(input: HardKillLateResponseInput): LateResponseAuditRecord {
  const sessionId = requireAuditString(input.sessionId, "sessionId");
  const episodeId = requireAuditString(input.episodeId, "episodeId");
  const actor = requireAuditString(input.actor, "actor") as LearningAgentRole;
  const turnNo = requireAuditNonNegative(input.turnNo, "turnNo");
  const attemptNo = requireAuditNonNegative(input.attemptNo, "attemptNo");
  const finishReason = requireAuditString(input.finishReason, "finishReason");
  const tokensUsed = requireAuditNonNegative(input.tokensUsed, "tokensUsed");
  const occurredAt = requireAuditString(input.occurredAt ?? new Date().toISOString(), "occurredAt");

  const summary: Record<string, string | number> = {};
  if (input.auditFields) {
    for (const [key, value] of Object.entries(input.auditFields)) {
      if (!LATE_RESPONSE_AUDIT_ALLOWED_SET.has(key)) {
        throw new LateResponseAuditError(
          `hard kill 迟到响应审计摘要禁止键 "${key}"（只允许安全摘要白名单，不含用户内容）`,
          "SENSITIVE_AUDIT_FIELD_DENIED",
        );
      }
      if (typeof value === "string") summary[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) summary[key] = value;
      // 其他类型不进入摘要（白名单只存 string/number）
    }
  }

  return {
    eventType: "hard_kill_late_response",
    sessionId,
    episodeId,
    actor,
    turnNo,
    attemptNo,
    providerRequestId: input.providerRequestId,
    finishReason,
    tokensUsed,
    occurredAt,
    summary,
  };
}

/**
 * hard kill 后的迟到 Provider/ASR/Critic 响应处理（§7.7）：
 *
 * - **只记录**不含用户内容的审计摘要（安全摘要白名单）；
 * - **不写** probe / artifact / assessment staging（stagingWritten 恒 false）；
 * - **不能恢复为 trusted**（trustedRestored 恒 false）。
 *
 * 返回值中的 audit 记录由调用方持久化到 audit log；本函数不做任何 DB 写入。
 */
export function handleHardKillLateResponse(
  input: HardKillLateResponseInput,
): {
  audited: boolean;
  audit: LateResponseAuditRecord;
  /** 字面量 false：绝不写 probe/artifact/assessment staging */
  stagingWritten: false;
  /** 字面量 false：hard kill 后绝不恢复 trusted */
  trustedRestored: false;
} {
  return {
    audited: true,
    audit: buildLateResponseAudit(input),
    stagingWritten: false,
    trustedRestored: false,
  };
}

// ─── 4. privacy/trust/scheduler hard incident（§17.2） ───────────────────

/** policy 执行的作用域（workspace + user） */
export interface PolicyScope {
  workspaceId: string;
  userId: string;
}

/** runtime-control 端口（可注入；bump 必须返回新 epoch） */
export interface RuntimeControlPort {
  /** 读取当前 runtime epoch */
  getRuntimeEpoch(): Promise<number>;
  /** bump runtime epoch（+1）并返回新值（hard incident 用） */
  bumpRuntimeEpoch(): Promise<number>;
}

/** Episode fence 端口（可注入；已 commit Episode 保留） */
export interface EpisodeFencePort {
  /** 列出全部未 commit Episode（status 非 completed/cancelled/stale） */
  listUncommittedEpisodes(
    scope: PolicyScope,
  ): Promise<ReadonlyArray<{ episodeId: string; status: string }>>;
  /** fence 一个 Episode：状态 → cancelled（零副作用，不写掌握/schedule） */
  fenceEpisode(episodeId: string): Promise<void>;
}

/** 外部 job 端口（可注入；取消未完成外部 job） */
export interface ExternalJobPort {
  /** 取消全部未完成外部 job；返回取消数 */
  cancelExternalJobs(scope: PolicyScope): Promise<{ cancelled: number }>;
}

/** hard incident 输入 */
export interface HardIncidentInput {
  scope: PolicyScope;
  /** incident 原因码（privacy_breach / trust_violation / scheduler_hard_failure ...） */
  reasonCode: string;
  ports: {
    runtime: RuntimeControlPort;
    episodeFence: EpisodeFencePort;
    externalJobs: ExternalJobPort;
  };
}

/** 被 fence 的未 commit Episode */
export interface FencedEpisode {
  episodeId: string;
  /** 恒为 cancelled：fence = 终止当前/未开始，已 commit 保留 */
  status: "cancelled";
}

/** hard incident 处理结果 */
export interface HardIncidentResult {
  reasonCode: string;
  /** bump 后的新 runtime epoch */
  newRuntimeEpoch: number;
  /** 被 fence 的未 commit Episode（已 commit Episode 不在其中） */
  fencedEpisodes: readonly FencedEpisode[];
  /** 取消的未完成外部 job 数 */
  cancelledExternalJobs: number;
  /** 字面量 false：hard incident 后禁止 trusted 恢复（§17.2） */
  trustedRecoveryAllowed: false;
}

/** 不可 fence 的终态（已 commit / 取消 / stale：保留，不重复标记） */
const NON_FENCEABLE_EPISODE_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "stale",
]);

/**
 * privacy/trust/scheduler hard incident 处理（§17.2）：
 *
 * 固定顺序（类比 COMMIT 固定锁序，先隔离再收尾）：
 *   ① bump runtime epoch（先隔离：旧 snapshot 全部失配，之后任何写入都 fail closed）
 *   → ② fence 全部未 commit Episode（终止当前与未开始，已 commit 保留）
 *   → ③ 取消未完成外部 job
 *   → ④ 禁止 trusted 恢复（trustedRecoveryAllowed 恒 false）。
 *
 * 全程零学习副作用：fence 只改 Episode 状态为 cancelled，不写掌握/schedule/artifact。
 */
export async function handleHardIncident(input: HardIncidentInput): Promise<HardIncidentResult> {
  // ① bump runtime epoch（先隔离）
  const newRuntimeEpoch = await input.ports.runtime.bumpRuntimeEpoch();
  // ② fence 全部未 commit Episode（防御性过滤：终态/已 commit 不 fence）
  const uncommitted = await input.ports.episodeFence.listUncommittedEpisodes(input.scope);
  const fencedEpisodes: FencedEpisode[] = [];
  for (const episode of uncommitted) {
    if (NON_FENCEABLE_EPISODE_STATUSES.has(episode.status)) continue;
    await input.ports.episodeFence.fenceEpisode(episode.episodeId);
    fencedEpisodes.push({ episodeId: episode.episodeId, status: "cancelled" });
  }
  // ③ 取消未完成外部 job
  const { cancelled } = await input.ports.externalJobs.cancelExternalJobs(input.scope);
  return {
    reasonCode: input.reasonCode,
    newRuntimeEpoch,
    fencedEpisodes,
    cancelledExternalJobs: cancelled,
    // ④ 禁止 trusted 恢复
    trustedRecoveryAllowed: false,
  };
}

// ─── 5. 断线恢复（只读 event/contract/artifact，§7.7） ────────────────────

/** 断线恢复只读端口（event/contract/artifact；只读，不调用 Provider） */
export interface DisconnectRecoveryReadPort {
  /** 只读：读取已落库事件流（供重建上下文，01-2 §7.7） */
  readEvents(scope: PolicyScope): Promise<ReadonlyArray<Record<string, unknown>>>;
  /** 只读：读取当前 contract（不可读 → fail closed，无法恢复） */
  readContract(scope: PolicyScope): Promise<Record<string, unknown> | null>;
  /** 只读：读取已落库 artifact */
  readArtifacts(scope: PolicyScope): Promise<ReadonlyArray<Record<string, unknown>>>;
}

/** 断线恢复输入 */
export interface DisconnectRecoveryInput {
  scope: PolicyScope;
  sessionId: string;
  episodeId: string;
  /** 只读数据源（event/contract/artifact） */
  read: DisconnectRecoveryReadPort;
}

/** 断线恢复结果 */
export interface DisconnectRecoveryResult {
  ok: boolean;
  /** 从 event/contract/artifact 重建的上下文（不来自无限增长的 messages） */
  rebuiltContext: Record<string, unknown>;
  /** 读取的只读数据源数量（恒为 3：event/contract/artifact） */
  sourcesRead: number;
  /** 字面量 false：断线恢复不重复 Provider 调用 */
  providerCallMade: false;
  /** 字面量 false：断线恢复不产生业务副作用 */
  sideEffects: false;
  reason: string | null;
}

/** 从 contract 提取 content-free 引用字段（不读取用户内容） */
function pickContractRef(contract: Record<string, unknown>): Record<string, unknown> {
  const ref: Record<string, unknown> = {};
  for (const key of ["id", "contractRef", "planHash", "episodeTargetFingerprint", "commitKey"]) {
    if (contract[key] !== undefined) ref[key] = contract[key];
  }
  return ref;
}

/**
 * 断线恢复（§7.7）：
 *
 * - **只读** event/contract/artifact 三个数据源重建上下文；
 * - **不重复 Provider 调用**（本函数签名不含 provider 端口，类型层面保证）；
 * - **不产生业务副作用**（sideEffects 恒 false；已 commit Episode 由事件流保留）。
 *
 * contract 不可读 → fail closed（ok=false，拒绝以不完整上下文继续）。
 */
export async function recoverAfterDisconnect(
  input: DisconnectRecoveryInput,
): Promise<DisconnectRecoveryResult> {
  const [events, contract, artifacts] = await Promise.all([
    input.read.readEvents(input.scope),
    input.read.readContract(input.scope),
    input.read.readArtifacts(input.scope),
  ]);

  const rebuiltContext: Record<string, unknown> = {
    eventCount: events.length,
    artifactCount: artifacts.length,
    contractPresent: contract !== null,
    ...(contract !== null ? { contractRef: pickContractRef(contract) } : {}),
  };

  return {
    ok: contract !== null,
    rebuiltContext,
    sourcesRead: 3,
    providerCallMade: false,
    sideEffects: false,
    reason: contract === null ? "contract 不可读：无法恢复上下文（fail closed）" : null,
  };
}

// ─── 6. budget/context/turn deadline/inactivity/pause TTL 执行 ───────────

/** enforcePolicyBounds 输入（全部来自编排运行时快照；缺失即跳过对应检查） */
export interface PolicyBoundsInput {
  /** Session Supervisor 已用 turns（≤8，W0 冻结） */
  supervisorTurnsUsed: number;
  /** trusted 内容性动态 follow-up（恒等 = 0，公测 v1；全部 formal probe 预冻结） */
  trustedContentFollowUpUsed: number;
  /** 当前路线已进行的 Encounter 数（2~5） */
  routeEncounterCount: number;
  /** 该用户同时 active 学习会话数（每用户 ≤1） */
  activeSessionsForUser: number;
  /** 当前 turn 起始时间（ms）；0 = 无进行中 turn（跳过 deadline 检查） */
  turnStartedAtMs: number;
  /** 最近用户活动时间（ms）；0 = 未知（跳过 inactivity 检查） */
  lastActivityAtMs: number;
  /** 当前时间（ms） */
  nowMs: number;
  /** 是否从 Pause 恢复（恢复时必须重查 source/policy/assistance stale） */
  resumingFromPause: boolean;
  /** Pause 恢复时的 stale 重查结果；null = 尚未重查 */
  staleRecheck: { checked: boolean; stale: boolean } | null;
  /** Pause 起始时间（ms）；null = 未暂停（跳过 pause TTL 检查） */
  pausedAtMs: number | null;
  /** Learning budget 使用量快照（可选；提供时做非负恒等断言） */
  budgetUsage?: Readonly<LearningBudgetUsage> | null;
}

/** enforcePolicyBounds 结果 */
export interface PolicyBoundsResult {
  allowed: boolean;
  /** 全部违反的边界名（allowed=true 时为空数组；去重） */
  violatedBounds: readonly string[];
  /** 与 violatedBounds 一一对应的原因 */
  reasons: readonly string[];
}

/**
 * budget/context/turn deadline/inactivity/pause TTL 政策执行（任务 03-6）：
 *
 * - 复用 LEARNING_LOOP_BOUNDS（W0 冻结值，budget.ts 单一来源），全量逐项检查
 *   全部边界（turns / Encounter / active 会话 / deadline / inactivity / pause
 *   stale 重查 / pause TTL / budget 非负），一次列出全部违反；
 * - **0 trusted 内容性 follow-up 恒等断言**：必须恰为 0（比 loopGuard 的
 *   「>0 拒绝」更严格，-1/1 等异常值一律拒绝）；
 * - Pause TTL 过期（> pauseTtlMs）禁止继续（恢复时必须重查 stale）；
 * - budget 使用量非负恒等断言（损坏的负数状态拒绝继续）；
 * - 任一违反返回 allowed=false，0 副作用；全部满足才放行。
 */
export function enforcePolicyBounds(
  input: PolicyBoundsInput,
  policy: LearningBudgetPolicy = LEARNING_LOOP_BOUNDS,
): PolicyBoundsResult {
  const violatedBounds: string[] = [];
  const reasons: string[] = [];
  const record = (bound: string, reason: string): void => {
    if (!violatedBounds.includes(bound)) {
      violatedBounds.push(bound);
      reasons.push(reason);
    }
  };

  // 1. Session Supervisor turns（≤8，W0 冻结）
  if (input.supervisorTurnsUsed > policy.maxSessionSupervisorTurns) {
    record(
      "maxSessionSupervisorTurns",
      `Session Supervisor turns 超限：${input.supervisorTurnsUsed}/${policy.maxSessionSupervisorTurns}`,
    );
  }
  // 2. 0 trusted 内容性 follow-up 恒等断言（必须恰为 0）
  if (input.trustedContentFollowUpUsed !== 0) {
    record(
      "trustedContentFollowUp",
      `trusted 内容性动态 follow-up 必须恒等 0（当前 ${input.trustedContentFollowUpUsed}）`,
    );
  }
  // 3. route Encounter 2~5
  if (
    input.routeEncounterCount < policy.routeEncounterMin
    || input.routeEncounterCount > policy.routeEncounterMax
  ) {
    record(
      "routeEncounter",
      `route Encounter 越界：${input.routeEncounterCount}（允许 ${policy.routeEncounterMin}~${policy.routeEncounterMax}）`,
    );
  }
  // 4. 同时 active 学习会话每用户 ≤1
  if (input.activeSessionsForUser > policy.maxConcurrentActiveSessionsPerUser) {
    record(
      "maxConcurrentActiveSessionsPerUser",
      `同时 active 学习会话超限：${input.activeSessionsForUser}/${policy.maxConcurrentActiveSessionsPerUser}（每用户 1）`,
    );
  }
  // 5. 单次 Agent turn deadline（≤120s，W0 冻结）
  if (input.turnStartedAtMs > 0 && input.nowMs - input.turnStartedAtMs > policy.turnDeadlineMs) {
    record("turnDeadlineMs", `单次 Agent turn deadline 超时（>${policy.turnDeadlineMs}ms）`);
  }
  // 6. Session inactivity expiry（30min；只结束 active UI，不回滚已 commit Episode）
  if (input.lastActivityAtMs > 0 && input.nowMs - input.lastActivityAtMs > policy.inactivityExpiryMs) {
    record(
      "inactivityExpiryMs",
      "Session inactivity 过期（只结束 active UI，不回滚已 commit Episode）",
    );
  }
  // 7. Pause 恢复必须重查 source/policy/assistance stale
  if (input.resumingFromPause) {
    if (input.staleRecheck === null || !input.staleRecheck.checked) {
      record(
        "pauseTtlStaleRecheck",
        "Pause TTL 恢复必须重查 source/policy/assistance stale 后才能继续",
      );
    } else if (input.staleRecheck.stale) {
      record(
        "pauseTtlStaleRecheck",
        "Pause 恢复后检测到 stale，禁止继续（无正式副作用）",
      );
    }
  }
  // 8. Pause TTL 过期（W0 冻结；恢复时必须重查 stale，见第 7 项）
  if (input.pausedAtMs !== null && input.nowMs - input.pausedAtMs > policy.pauseTtlMs) {
    record("pauseTtlMs", `Pause TTL 过期（>${policy.pauseTtlMs}ms），禁止继续`);
  }
  // 9. budget 使用量非负恒等断言（损坏的负数状态拒绝继续）
  if (input.budgetUsage) {
    const usage = input.budgetUsage;
    if (usage.providerCalls < 0) record("budget.providerCalls", "providerCalls 为负（预算状态损坏）");
    if (usage.inputTokens < 0) record("budget.inputTokens", "inputTokens 为负（预算状态损坏）");
    if (usage.outputTokens < 0) record("budget.outputTokens", "outputTokens 为负（预算状态损坏）");
    for (const [role, roleUsage] of Object.entries(usage.roles)) {
      if (roleUsage.turns < 0) record(`budget.roles.${role}.turns`, `${role}.turns 为负（预算状态损坏）`);
      if (roleUsage.toolCalls < 0) {
        record(`budget.roles.${role}.toolCalls`, `${role}.toolCalls 为负（预算状态损坏）`);
      }
      if (roleUsage.providerCalls < 0) {
        record(`budget.roles.${role}.providerCalls`, `${role}.providerCalls 为负（预算状态损坏）`);
      }
    }
  }

  return { allowed: violatedBounds.length === 0, violatedBounds, reasons };
}
