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

import { sql } from "drizzle-orm";
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
export const TUTOR_DETOUR_MAX_TURNS = 2;

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
  /** 已完成的 Tutor 回合数；只保留计数，不保存无限消息历史。 */
  readonly turnCount: number;
  readonly maxTurns: number;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export type TutorDetourErrorCode =
  | "detour_not_found"
  | "invalid_end_reason"
  | "invalid_end_transition"
  | "save_marker_flag_off"
  | "missing_switch_params"
  | "episode_not_found"
  | "turn_limit_reached";

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
    turnCount: 0,
    maxTurns: TUTOR_DETOUR_MAX_TURNS,
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

/** 消费一次 Tutor 回合：只递增计数，不写入消息历史。 */
export function advanceTutorDetourTurn(
  record: TutorDetourRecord,
): { record: TutorDetourRecord; allowed: boolean; reason: string | null } {
  if (record.status === "ended") {
    return { record: { ...record }, allowed: false, reason: "detour 已结束，不能继续提问" };
  }
  if (record.turnCount >= record.maxTurns) {
    return { record: { ...record }, allowed: false, reason: "本次陪伴最多支持两次说明" };
  }
  return {
    record: {
      ...record,
      turnCount: record.turnCount + 1,
      createdAt: record.createdAt,
      endedAt: null,
    },
    allowed: true,
    reason: null,
  };
}

// ─── 端口（可注入；production 用 withWorkspaceTransaction 接线）────────────

export interface TutorDetourRepo {
  saveDetour(scope: LearningScope, record: TutorDetourRecord): Promise<void>;
  findDetour(scope: LearningScope, detourId: string): Promise<TutorDetourRecord | null>;
  updateDetour(scope: LearningScope, record: TutorDetourRecord): Promise<void>;
}

/** Tutor PG 端口只依赖当前事务的 execute，避免把私有 Tutor 内容暴露给 Web。 */
export interface TutorDetourTx {
  execute(query: unknown): Promise<unknown>;
}

function rowToTutorDetour(row: Record<string, unknown>): TutorDetourRecord {
  return {
    detourId: String(row.detourId),
    sessionId: String(row.sessionId),
    episodeId: String(row.episodeId),
    targetId: String(row.targetId),
    questionId: String(row.questionId),
    status: row.status === "ended" ? "ended" : "active",
    endReason:
      row.endReason === "return_to_origin" || row.endReason === "end_session"
        ? row.endReason
        : null,
    questionMarkerSaved: row.questionMarkerSaved === true,
    turnCount: Number(row.turnCount ?? 0),
    maxTurns: Number(row.maxTurns ?? TUTOR_DETOUR_MAX_TURNS),
    createdAt: new Date(String(row.createdAt)).toISOString(),
    endedAt: row.endedAt === null || row.endedAt === undefined
      ? null
      : new Date(String(row.endedAt)).toISOString(),
  };
}

/** 真实 PostgreSQL detour repo：所有读写都带 workspace + user 双重边界。 */
export function createPgTutorDetourRepository(transaction: TutorDetourTx): TutorDetourRepo {
  return {
    async saveDetour(scope, record) {
      await transaction.execute(sql`
        INSERT INTO learning_tutor_detours (
          id, workspace_id, user_id, session_id, episode_id, target_id, question_id,
          status, end_reason, question_marker_saved, turn_count, max_turns,
          created_at, ended_at, last_turn_at
        ) VALUES (
          ${record.detourId}, ${scope.workspaceId}, ${scope.userId}, ${record.sessionId},
          ${record.episodeId}, ${record.targetId}, ${record.questionId}, ${record.status},
          ${record.endReason}, ${record.questionMarkerSaved}, ${record.turnCount},
          ${record.maxTurns}, ${record.createdAt}, ${record.endedAt}, NULL
        )
      `);
    },
    async findDetour(scope, detourId) {
      const rows = (await transaction.execute(sql`
        SELECT id AS "detourId", session_id AS "sessionId", episode_id AS "episodeId",
               target_id AS "targetId", question_id AS "questionId", status,
               end_reason AS "endReason", question_marker_saved AS "questionMarkerSaved",
               turn_count AS "turnCount", max_turns AS "maxTurns",
               created_at AS "createdAt", ended_at AS "endedAt"
        FROM learning_tutor_detours
        WHERE id = ${detourId} AND workspace_id = ${scope.workspaceId}
          AND user_id = ${scope.userId}
        LIMIT 1
      `)) as Array<Record<string, unknown>>;
      return rows[0] ? rowToTutorDetour(rows[0]) : null;
    },
    async updateDetour(scope, record) {
      const rows = (await transaction.execute(sql`
        UPDATE learning_tutor_detours
        SET status = ${record.status}, end_reason = ${record.endReason},
            question_marker_saved = ${record.questionMarkerSaved},
            turn_count = ${record.turnCount}, max_turns = ${record.maxTurns},
            ended_at = ${record.endedAt},
            last_turn_at = CASE WHEN ${record.turnCount} > 0 THEN now() ELSE last_turn_at END
        WHERE id = ${record.detourId} AND workspace_id = ${scope.workspaceId}
          AND user_id = ${scope.userId} AND status = 'active'
        RETURNING id
      `)) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        throw new TutorDetourError(
          "invalid_end_transition",
          "Tutor 分流已结束或并发状态已变化",
        );
      }
    },
  };
}

/** 当前学习前台与 Tutor 权限的 PostgreSQL 适配器。 */
export function createPgTutorLearningFrontRepository(transaction: TutorDetourTx): LearningFrontRepo {
  return {
    async readForegroundState(scope) {
      const rows = (await transaction.execute(sql`
        SELECT explicit_preferences ->> 'learningForegroundState' AS state
        FROM user_learning_preferences
        WHERE user_id = ${scope.userId}
          AND (workspace_id = ${scope.workspaceId} OR workspace_id IS NULL)
        ORDER BY CASE WHEN workspace_id IS NULL THEN 1 ELSE 0 END, updated_at DESC
        LIMIT 1
      `)) as Array<Record<string, unknown>>;
      const state = rows[0]?.state;
      return state === "together" || state === "let_me_try" || state === "free_explore"
        ? state
        : null;
    },
    async recordAssistanceAndExposure(scope, input) {
      const snapshot = JSON.stringify({
        assistanceLevel: "practice_only",
        contentAssisted: false,
        capturedAt: input.now.toISOString(),
        capturedBy: "tutor_detour",
      });
      await transaction.execute(sql`
        INSERT INTO learning_unit_exposure (
          workspace_id, user_id, content_exposure_key, assistance_snapshot,
          assisted_at, practice_only_since, revision
        ) VALUES (
          ${scope.workspaceId}, ${scope.userId}, ${input.contentExposureKey},
          ${snapshot}::jsonb, ${input.now}, ${input.now}, 1
        )
        ON CONFLICT (workspace_id, content_exposure_key)
        DO UPDATE SET
          -- 不覆盖已有更高等级：lock 先赢（content_assisted）时 detour 的
          -- practice_only 不得降级已冻结快照（exposure-service guard 语义：
          -- 正式作答后 assistance 不得被 detour 入口重置）。
          assistance_snapshot = CASE
            WHEN learning_unit_exposure.assistance_snapshot IS NULL
              OR learning_unit_exposure.assistance_snapshot->>'assistanceLevel'
                 IS DISTINCT FROM 'content_assisted'
            THEN EXCLUDED.assistance_snapshot
            ELSE learning_unit_exposure.assistance_snapshot
          END,
          assisted_at = COALESCE(learning_unit_exposure.assisted_at, EXCLUDED.assisted_at),
          practice_only_since = COALESCE(
            learning_unit_exposure.practice_only_since, EXCLUDED.practice_only_since
          ),
          revision = learning_unit_exposure.revision + 1,
          updated_at = now()
      `);
    },
    async openTutorPermission(scope, input) {
      await transaction.execute(sql`
        INSERT INTO learning_tutor_permissions (workspace_id, user_id, target_id)
        VALUES (${scope.workspaceId}, ${scope.userId}, ${input.keyPointId})
        ON CONFLICT (workspace_id, user_id, target_id)
        DO UPDATE SET updated_at = now()
      `);
    },
    async writeForegroundState(scope, state) {
      const preferences = JSON.stringify({ learningForegroundState: state });
      if (scope.workspaceId === "") throw new Error("workspaceId is required");
      await transaction.execute(sql`
        INSERT INTO user_learning_preferences (
          user_id, workspace_id, explicit_preferences, suggested_preferences
        ) VALUES (
          ${scope.userId}, ${scope.workspaceId}, ${preferences}::jsonb, '{}'::jsonb
        )
        ON CONFLICT (user_id, workspace_id) WHERE workspace_id IS NOT NULL
        DO UPDATE SET explicit_preferences =
          user_learning_preferences.explicit_preferences || EXCLUDED.explicit_preferences,
          updated_at = now()
      `);
    },
  };
}

/** 服务端签发的一次性切换 nonce，绑定当前 user/workspace/session/target。 */
export interface TutorActionNonceRepo {
  issue(input: {
    scope: LearningScope;
    sessionId: string;
    keyPointId: string;
    nonceHash: string;
    expiresAt: Date;
  }): Promise<void>;
  consume(input: {
    scope: LearningScope;
    sessionId: string;
    keyPointId: string;
    nonceHash: string;
    now: Date;
  }): Promise<boolean>;
}

export function createPgTutorActionNonceRepository(transaction: TutorDetourTx): TutorActionNonceRepo {
  return {
    async issue(input) {
      await transaction.execute(sql`
        INSERT INTO learning_tutor_action_nonces (
          workspace_id, user_id, session_id, key_point_id, nonce_hash, expires_at
        ) VALUES (
          ${input.scope.workspaceId}, ${input.scope.userId}, ${input.sessionId},
          ${input.keyPointId}, ${input.nonceHash}, ${input.expiresAt}
        )
      `);
    },
    async consume(input) {
      const rows = (await transaction.execute(sql`
        UPDATE learning_tutor_action_nonces
        SET consumed_at = ${input.now}
        WHERE workspace_id = ${input.scope.workspaceId} AND user_id = ${input.scope.userId}
          AND session_id = ${input.sessionId} AND key_point_id = ${input.keyPointId}
          AND nonce_hash = ${input.nonceHash} AND consumed_at IS NULL
          AND expires_at > ${input.now}
        RETURNING id
      `)) as Array<Record<string, unknown>>;
      return rows.length > 0;
    },
  };
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
          "missing_switch_params",
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
      throw new TutorDetourError("detour_not_found", `detour ${input.detourId} 不存在`);
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
          ? "invalid_end_reason"
          : next.reason?.startsWith("保存为问题标记")
            ? "save_marker_flag_off"
            : "invalid_end_transition",
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
