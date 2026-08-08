/**
 * 阶段 07（W6）任务 07-7：Tutor detour 编排（§5.7）。
 *
 * 有界 detour 的服务端编排层（纯逻辑 + 可注入 repo，DB 交互收敛在端口内）：
 * - **trusted → practice 原子切换**：用户在当前 Card/Episode 中提问时，若前台
 *   处于「让我试试」（trusted challenge），先询问是否切换到一起学习；用户确认后
 *   由本编排在同一事务内先记录 assistance/exposure 再开放 Grounded Tutor 权限
 *   （复用 presence-control.enterPracticeMode 的原子语义），然后才创建 detour；
 *   Agent 不能代点（userActionNonce 只在用户 UI 确认后产生）；
 * - **有界 detour 创建/结束**：每个 detour 绑定 sessionId + episodeId + targetId
 *   + questionId，一次一个问题；固定结束动作只有「返回原航程 / 结束」；问题标记
 *   是 Should 动作，仅 Should flag 开启时允许；
 * - **不建第二套无限 message API**：`TutorDetourRecord` 没有 messages 数组（类型
 *   层面 + 单测断言），前台不保留无限滚动聊天历史；detour 生命周期是有限状态机；
 * - **Session 外提问**：只有用户明确选定一个 published Key Point 才创建 scoped
 *   exploration Session；否则先请用户选择材料，不提供通用无限消息流。
 *
 * 与 worker 侧 grounded-tutor.ts 的关系：worker 角色文件负责答案分段 / 支持层级 /
 * Must 白名单 / 答案构建等纯逻辑；本文件负责 Session 生命周期编排与原子切换。
 * Tutor 仍只能提议新卡/关系/笔记（用户确认后重新走 Generation Supervisor /
 * Relationship Governance），本模块 0 直接写 mastery/schedule/canonical Card/relation。
 */

import {
  DEFAULT_LEARNING_FOREGROUND_STATE,
  resolveKnowledgeHelpGate,
  type EnterPracticeModeInput,
  type EnterPracticeModeResult,
  type LearningForegroundState,
  type LearningFrontRepo,
  type LearningScope,
} from "../companion-shell/presence-control.ts";

// ─── 有界 detour 记录（无 messages 数组：不建第二套无限 message API）─────────

export type TutorDetourStatus = "active" | "ended";
export type TutorDetourEndReason = "return_to_origin" | "end_session";

export const TUTOR_DETOUR_END_REASONS: readonly TutorDetourEndReason[] = [
  "return_to_origin",
  "end_session",
];

/**
 * 有界 detour 记录。**没有 messages 数组**：不保留无限滚动聊天历史。
 * 一次一个问题由 `questionId` 冻结保证（创建后不变，无换题动作）。
 */
export interface TutorDetourRecord {
  readonly detourId: string;
  readonly sessionId: string;
  readonly episodeId: string;
  /** 当前 target（published Key Point id）。 */
  readonly targetId: string;
  readonly questionId: string;
  readonly status: TutorDetourStatus;
  readonly endReason: TutorDetourEndReason | null;
  /** 是否已保存为问题标记（Should 动作；仅 Should flag 开启时可 true）。 */
  readonly questionMarkerSaved: boolean;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export type TutorDetourErrorCode =
  | "DETOUR_NOT_FOUND"
  | "INVALID_END_REASON"
  | "INVALID_END_TRANSITION"
  | "SAVE_MARKER_FLAG_OFF"
  | "MISSING_SWITCH_PARAMS";

export class TutorDetourError extends Error {
  readonly code: TutorDetourErrorCode;
  constructor(code: TutorDetourErrorCode, message: string) {
    super(message);
    this.name = "TutorDetourError";
    this.code = code;
  }
}

/** 创建有界 detour 记录（纯函数）：绑定四元组，status=active，无 endReason。 */
export function buildTutorDetourRecord(input: {
  detourId: string;
  sessionId: string;
  episodeId: string;
  targetId: string;
  questionId: string;
  now: Date;
}): TutorDetourRecord {
  return {
    detourId: input.detourId,
    sessionId: input.sessionId,
    episodeId: input.episodeId,
    targetId: input.targetId,
    questionId: input.questionId,
    status: "active",
    endReason: null,
    questionMarkerSaved: false,
    createdAt: input.now.toISOString(),
    endedAt: null,
  };
}

export interface EndTutorDetourOptions {
  /** 固定结束动作：返回原航程 / 结束。 */
  readonly endReason: TutorDetourEndReason;
  /** 保存为问题标记（Should 动作；仅 shouldFlag=true 时允许）。 */
  readonly saveQuestionMarker?: boolean;
  readonly shouldFlag?: boolean;
  readonly now?: Date;
}

/**
 * 有界 detour 生命周期状态机（纯函数）。
 * - 固定结束动作只有 return_to_origin / end_session；
 * - ended 终态不可再次动作；
 * - save_question_marker 是 Should 动作：shouldFlag 未开一律拒绝。
 */
export function transitionTutorDetourStatus(
  record: TutorDetourRecord,
  options: EndTutorDetourOptions,
): { record: TutorDetourRecord; allowed: boolean; reason: string | null } {
  if (record.status === "ended") {
    return { record: { ...record }, allowed: false, reason: "detour 已结束，不能再次动作" };
  }
  if (!(TUTOR_DETOUR_END_REASONS as readonly string[]).includes(options.endReason)) {
    return { record, allowed: false, reason: `非法结束动作 ${options.endReason}` };
  }
  if (options.saveQuestionMarker === true && options.shouldFlag !== true) {
    return { record, allowed: false, reason: "保存为问题标记是 Should 动作，flag 未开启" };
  }
  const now = options.now ?? new Date();
  return {
    record: {
      ...record,
      status: "ended",
      endReason: options.endReason,
      questionMarkerSaved: options.saveQuestionMarker === true,
      endedAt: now.toISOString(),
    },
    allowed: true,
    reason: `detour 结束（${options.endReason}）`,
  };
}

// ─── 端口（可注入；production 用 withWorkspaceTransaction 接线）────────────

export interface TutorDetourRepo {
  saveDetour(scope: LearningScope, record: TutorDetourRecord): Promise<void>;
  findDetour(scope: LearningScope, detourId: string): Promise<TutorDetourRecord | null>;
  updateDetour(scope: LearningScope, record: TutorDetourRecord): Promise<void>;
}

export interface TutorDetourDeps {
  /** 前台学习状态读取（复用 presence-control 的 LearningFrontRepo）。 */
  repo: LearningFrontRepo;
  /**
   * 事务运行器：把「原子切换 + detour 创建/结束」包进同一 DB 事务；
   * 回调内任一步抛错整体回滚——Tutor 权限绝不先于 assistance/exposure 记录开放。
   * production 注入 withWorkspaceTransaction(scope, ...) 适配器。
   */
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  now: () => Date;
  detourRepo: TutorDetourRepo;
  /**
   * trusted → practice 原子切换（先记录 assistance/exposure 再开放 Grounded Tutor
   * 权限）。默认接线为 presence-control.enterPracticeMode；注入以便单测断言顺序。
   */
  enterPractice: (input: EnterPracticeModeInput) => Promise<EnterPracticeModeResult>;
}

// ─── 创建有界 detour（含 trusted → practice 原子切换）──────────────────────

export interface CreateScopedTutorDetourInput {
  readonly scope: LearningScope;
  readonly detourId: string;
  readonly sessionId: string;
  readonly episodeId: string;
  readonly targetId: string;
  readonly questionId: string;
  /** 前台状态快照（trusted challenge 判定）；null = 未记录（默认「一起学习」）。 */
  readonly foregroundState?: LearningForegroundState | null;
  /** trusted→practice 切换参数（仅 let_me_try 需要；Agent 不能代点）。 */
  readonly deviceSessionId?: string;
  readonly deviceSurfaceEpoch?: number;
  /**
   * 账号级 epoch（security_review MEDIUM #3 修复）：由服务端读取并强制传入，
   * 禁止缺省 0（缺省会导致迟到 fence 恒通过）。trusted→practice 切换路径必填。
   */
  readonly accountEpoch?: number;
  readonly contentExposureKey?: string;
  readonly userActionNonce?: string;
  readonly now?: Date;
}

export interface CreateScopedTutorDetourResult {
  readonly detour: TutorDetourRecord;
  /** true = 从 trusted challenge（让我试试）原子切到 practice 后才开放 Tutor。 */
  readonly switchedFromTrustedToPractice: boolean;
  readonly foregroundBefore: LearningForegroundState;
}

/**
 * 创建有界 detour 编排（§5.7）：
 * 1. 读取前台状态；「让我试试」（trusted challenge）→ 先询问切换到一起学习，
 *    用户确认后在同一事务内先记录 assistance/exposure 再开放 Tutor 权限
 *    （deps.enterPractice，Agent 不能代点）；
 * 2. 创建有界 detour（绑定 sessionId+episodeId+targetId+questionId，一次一问题）；
 * 3. 任一步抛错 → transaction 回滚：不残留 assistance 副作用、不开放权限、不建 detour。
 */
export async function createScopedTutorDetour(
  deps: TutorDetourDeps,
  input: CreateScopedTutorDetourInput,
): Promise<CreateScopedTutorDetourResult> {
  return deps.transaction(async () => {
    const now = input.now ?? deps.now();
    const foregroundBefore =
      input.foregroundState ?? (await deps.repo.readForegroundState(input.scope))
        ?? DEFAULT_LEARNING_FOREGROUND_STATE;

    let switchedFromTrustedToPractice = false;
    const gate = resolveKnowledgeHelpGate(foregroundBefore);
    if (gate.kind === "require_switch_to_together") {
      // trusted challenge：先原子记录 assistance/exposure，再开放 Tutor 权限。
      if (
        input.contentExposureKey === undefined ||
        input.userActionNonce === undefined ||
        input.deviceSessionId === undefined ||
        input.accountEpoch === undefined
      ) {
        throw new TutorDetourError(
          "MISSING_SWITCH_PARAMS",
          "trusted challenge 切换需要 contentExposureKey/userActionNonce/deviceSessionId/accountEpoch",
        );
      }
      const switched = await deps.enterPractice({
        scope: input.scope,
        deviceSessionId: input.deviceSessionId,
        deviceSurfaceEpoch: input.deviceSurfaceEpoch ?? 0,
        accountEpoch: input.accountEpoch,
        keyPointId: input.targetId,
        contentExposureKey: input.contentExposureKey,
        userActionNonce: input.userActionNonce,
        now,
      });
      switchedFromTrustedToPractice = switched.assistanceRecorded;
    }

    const detour = buildTutorDetourRecord({
      detourId: input.detourId,
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      targetId: input.targetId,
      questionId: input.questionId,
      now,
    });
    await deps.detourRepo.saveDetour(input.scope, detour);

    return { detour, switchedFromTrustedToPractice, foregroundBefore };
  });
}

// ─── 结束有界 detour（固定结束动作 + 可选问题标记）──────────────────────────

export interface EndScopedTutorDetourInput {
  readonly scope: LearningScope;
  readonly detourId: string;
  readonly endReason: TutorDetourEndReason;
  readonly saveQuestionMarker?: boolean;
  readonly shouldFlag?: boolean;
  readonly now?: Date;
}

export interface EndScopedTutorDetourResult {
  readonly detour: TutorDetourRecord;
  /** true = 用户选择了固定结束动作之外并保存为问题标记（Should flag 已开）。 */
  readonly questionMarkerSaved: boolean;
}

/**
 * 结束有界 detour（§5.7）：只允许固定结束动作 return_to_origin / end_session；
 * ended 终态不可再次动作；问题标记是 Should 动作，flag 未开拒绝。
 */
export async function endScopedTutorDetour(
  deps: TutorDetourDeps,
  input: EndScopedTutorDetourInput,
): Promise<EndScopedTutorDetourResult> {
  return deps.transaction(async () => {
    const current = await deps.detourRepo.findDetour(input.scope, input.detourId);
    if (current === null) {
      throw new TutorDetourError("DETOUR_NOT_FOUND", `detour ${input.detourId} 不存在`);
    }
    const next = transitionTutorDetourStatus(current, {
      endReason: input.endReason,
      saveQuestionMarker: input.saveQuestionMarker,
      shouldFlag: input.shouldFlag,
      now: input.now ?? deps.now(),
    });
    if (!next.allowed) {
      throw new TutorDetourError(
        next.reason?.startsWith("非法结束动作")
          ? "INVALID_END_REASON"
          : next.reason?.startsWith("保存为问题标记")
            ? "SAVE_MARKER_FLAG_OFF"
            : "INVALID_END_TRANSITION",
        next.reason ?? "结束转移不允许",
      );
    }
    await deps.detourRepo.updateDetour(input.scope, next.record);
    return { detour: next.record, questionMarkerSaved: next.record.questionMarkerSaved };
  });
}

// ─── Session 外提问 gate（§5.7：需明确选定 published Key Point）─────────────

export type OutsideSessionEntryResolution =
  | { kind: "create_scoped_exploration"; keyPointId: string }
  | { kind: "ask_select_material" };

/**
 * Session 外提问的入口 gate（纯函数）：
 * 只有用户明确选定一个 published Key Point 才创建 scoped exploration Session；
 * 否则先请用户选择材料，不提供通用无限消息流。
 */
export function resolveOutsideSessionEntry(input: {
  selectedKeyPointId: string | null;
  publishedKeyPointIds: readonly string[];
}): OutsideSessionEntryResolution {
  if (
    input.selectedKeyPointId !== null &&
    input.selectedKeyPointId !== "" &&
    input.publishedKeyPointIds.includes(input.selectedKeyPointId)
  ) {
    return { kind: "create_scoped_exploration", keyPointId: input.selectedKeyPointId };
  }
  return { kind: "ask_select_material" };
}
