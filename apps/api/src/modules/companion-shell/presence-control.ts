/**
 * 阶段 07（W6）任务 07-4：存在感设置与控制状态（原方案 §5.5/§5.6）。
 *
 * 本模块是三档存在感 + 三种学习前台状态的纯逻辑核心与事务语义封装：
 * - 三档存在感 `quiet/moderate/active`：每档行为元数据 + presence → reason class
 *   映射（reason class 由 trigger-arbitration 的 rule registry 消费）。任一档
 *   不自动开麦、不自动进入下一题、不因忽略而失望、不使用红色倒计时或任务债务、
 *   可一键隐藏且保留完整手动能力；quiet 未召唤时只有静态中性锚点且完整 entity
 *   context/idle 动画为 0，除新注册一次性 consent surface 外主动提示为 0；
 * - 控制状态全站接线语义：8 个 versioned 控制状态的 scope 分类；
 *   `temporary_hidden` 的持久布尔只留设备本地（authenticated 客户端另发
 *   deviceSessionId + surfaceEpoch runtime-fence）；`global_off` 经
 *   /me/companion 做 account revision CAS + 广播 fence；两者的迟到结果一律丢弃；
 *   `global_off` CAS 失败时设置页显示「仅本设备已隐藏，全局关闭尚未同步」；
 * - 首次启用中立选择，未选择前默认安静；suppressedSuggestionClassIds / 稳定页面
 *   预算 / bounded reason 预算持久化（account state suppression + 07-3 ledger）；
 * - 三种学习前台状态：一起学习（→ practice_only）、让我试试（→ 可 trusted
 *   assessment）、自由探索（→ 默认 practice_only）；「让我试试」中索要知识帮助
 *   只能呈现「切换到一起学习」确认动作，用户确认后由原子 `enter_practice_mode`
 *   端点先记录 assistance/exposure 再开放 Grounded Tutor 权限；Agent 不能代点，
 *   系统不能先提示再补记。
 *
 * 纯逻辑核心无 DB 依赖（可单测）；与 DB 的交互收敛在 `LearningFrontRepo` 注入
 * 接口与 `transaction` 运行器，production 由路由接线层用 withWorkspaceTransaction
 * 包裹（任一步抛错整体回滚，Tutor 权限绝不先于 assistance/exposure 记录开放）。
 */

import { DomainError } from "@ailearn/shared";

// ─── 1. 三档存在感（§5.5）──────────────────────────────────────────────────

export type CompanionPresenceLevel = "quiet" | "moderate" | "active";
export type CompanionPresenceLevelId = CompanionPresenceLevel;

/** reason 类别（存在感档位决定允许集；trigger rule 的 allowedPresenceLevels 落地）。 */
export type CompanionReasonClass =
  /** 恢复类（暂停任务续接 / 长时间回来非强迫恢复）。 */
  | "resume"
  /** 当前操作的可恢复错误说明。 */
  | "recoverable_error"
  /** canonical 状态变化（stale / committed change）。 */
  | "canonical_change"
  /** 主动建议档下清晰且立即可执行的下一步（普通建议）。 */
  | "ordinary_suggestion";

/**
 * presence → 允许的 reason 类别（§5.5）：
 * - quiet：除新注册一次性 consent surface 外主动提示为 0；
 * - moderate：只在恢复、可恢复错误、stale 或 committed change 给一次邀请，未响应即退场；
 * - active：在 moderate 基础上允许一条有原因说明的下一步或路线，但不自动开始。
 * 首次启用未选择前默认 quiet（中立选择）。
 */
export const PRESENCE_TO_ALLOWED_REASON_CLASSES: Record<
  CompanionPresenceLevel,
  readonly CompanionReasonClass[]
> = {
  quiet: [],
  moderate: ["resume", "recoverable_error", "canonical_change"],
  active: ["resume", "recoverable_error", "canonical_change", "ordinary_suggestion"],
};

/** 首次启用未选择前默认的存在感（中立，§5.5）。 */
export const DEFAULT_PRESENCE_LEVEL: CompanionPresenceLevel = "quiet";

export interface CompanionPresenceBehaviorV1 {
  level: CompanionPresenceLevel;
  /** 该档位的主动提示行为描述（§5.5）。 */
  description: string;
  /** quiet 未召唤时只有静态中性锚点且完整 entity context/idle 动画为 0。 */
  staticAnchorOnly: boolean;
  /** 该档位允许的 reason 类别（普通下一步仅 active）。 */
  allowedReasonClasses: readonly CompanionReasonClass[];
}

export const COMPANION_PRESENCE_BEHAVIORS: Record<
  CompanionPresenceLevel,
  CompanionPresenceBehaviorV1
> = {
  quiet: {
    level: "quiet",
    description:
      "未召唤时只有静态中性锚点，完整 entity context/idle 动画为 0；除新注册一次性 consent surface 外主动提示为 0",
    staticAnchorOnly: true,
    allowedReasonClasses: [],
  },
  moderate: {
    level: "moderate",
    description:
      "只在恢复、可恢复错误、stale 或 committed change 给一次邀请，未响应即退场",
    staticAnchorOnly: false,
    allowedReasonClasses: ["resume", "recoverable_error", "canonical_change"],
  },
  active: {
    level: "active",
    description:
      "在 moderate 基础上允许一条有原因说明的下一步或路线，但不自动开始",
    staticAnchorOnly: false,
    allowedReasonClasses: ["resume", "recoverable_error", "canonical_change", "ordinary_suggestion"],
  },
};

/**
 * 解析存在感档位：未选择/非法值一律回落默认 quiet（§5.5 中立选择；
 * 首次启用未选择前默认安静）。Agent 不能静默改变偏好，本函数只做读侧解析。
 */
export function resolvePresenceLevel(selected: string | undefined): CompanionPresenceLevel {
  if (selected === "quiet" || selected === "moderate" || selected === "active") {
    return selected;
  }
  return DEFAULT_PRESENCE_LEVEL;
}

/** 该存在感档位是否允许该 reason 类别（§5.5 映射）。 */
export function presenceAllowsReasonClass(
  level: CompanionPresenceLevel,
  reasonClass: CompanionReasonClass,
): boolean {
  return COMPANION_PRESENCE_BEHAVIORS[level].allowedReasonClasses.includes(reasonClass);
}

/**
 * 任一档存在感的硬性约束（§5.5 不变量）：不自动开麦、不自动进入下一题、
 * 不因忽略而失望、不使用红色倒计时或任务债务、可一键隐藏且保留完整手动能力。
 * 全部为结构保证（常量元数据），触发/渲染层据此拒绝越界行为。
 */
export const PRESENCE_INVARIANTS = Object.freeze({
  autoMicrophoneEnabled: false,
  autoAdvanceToNextQuestion: false,
  expressDisappointmentOnIgnore: false,
  redCountdownOrTaskDebt: false,
  oneTapHideAvailable: true,
  manualCapabilitiesPreserved: true,
} as const);

// ─── 2. 控制状态全站接线（§5.5 作用域）─────────────────────────────────────

export const COMPANION_CONTROL_STATE_IDS = [
  "page_muted",
  "page_context_off",
  "focus_until_task_end",
  "suggestion_paused",
  "temporary_hidden",
  "global_off",
  "animation_off",
  "voice_output_off",
] as const;
export type CompanionControlStateId = (typeof COMPANION_CONTROL_STATE_IDS)[number];

export type CompanionControlScope =
  | "route"
  | "task"
  | "account"
  | "device"
  | "account_preference";

/** 各控制状态的 scope（§5.5 完整表；与 web 侧 05-5 一致）。 */
export const COMPANION_CONTROL_STATE_SCOPE: Record<
  CompanionControlStateId,
  CompanionControlScope
> = {
  page_muted: "route",
  page_context_off: "route",
  focus_until_task_end: "task",
  suggestion_paused: "account",
  temporary_hidden: "device",
  global_off: "account",
  animation_off: "account_preference",
  voice_output_off: "account_preference",
};

/** 持久布尔只留设备本地的状态（跨设备不同步；§5.5）。 */
export const DEVICE_LOCAL_ONLY_STATES: readonly CompanionControlStateId[] = [
  "temporary_hidden",
];

/** 账号级同步状态（跨设备同步；global_off 经 revision CAS + 广播 fence）。 */
export const ACCOUNT_SYNCED_STATES: readonly CompanionControlStateId[] = [
  "suggestion_paused",
  "global_off",
  "animation_off",
  "voice_output_off",
];

/** 类型守卫：字符串是否为合法控制状态 id。 */
export function isCompanionControlStateId(value: string): value is CompanionControlStateId {
  return (COMPANION_CONTROL_STATE_IDS as readonly string[]).includes(value);
}

// ─── 3. 设备 fence 与 surface epoch（迟到结果丢弃）──────────────────────────

export interface DeviceFenceV1 {
  /** 设备本地会话 id（device-local，不持久化为账号偏好）。 */
  deviceSessionId: string;
  /** 发起时客户端看到的 account surface epoch；服务端 fence 校验用。 */
  surfaceEpoch: number;
}

/**
 * 构造 authenticated 客户端 runtime-fence（§5.5）：短生命周期
 * deviceSessionId + surfaceEpoch。deviceSessionId 必须非空且长度有界。
 */
export function buildDeviceFence(input: {
  deviceSessionId: string;
  surfaceEpoch: number;
}): DeviceFenceV1 {
  const deviceSessionId = input.deviceSessionId.trim();
  if (deviceSessionId.length === 0 || deviceSessionId.length > 200) {
    throw new RangeError("deviceSessionId must be 1..200 characters");
  }
  if (!Number.isInteger(input.surfaceEpoch) || input.surfaceEpoch < 0) {
    throw new RangeError("surfaceEpoch must be a non-negative integer");
  }
  return { deviceSessionId, surfaceEpoch: input.surfaceEpoch };
}

/**
 * 校验设备 surface epoch：落后于账号当前 epoch（global off 撤销后）→ false，
 * 该设备的迟到 Companion 结果一律丢弃（§5.5）。
 */
export function validateSurfaceEpoch(deviceSurfaceEpoch: number, accountEpoch: number): boolean {
  return deviceSurfaceEpoch >= accountEpoch;
}

// ─── 4. global_off account revision CAS（§5.5）────────────────────────────

export type GlobalOffCasResult =
  | { ok: true; code: "APPLIED" }
  | { ok: false; code: "STALE_REVISION" };

/**
 * global_off 的 account revision CAS：客户端提交 base revision 必须等于当前
 * revision；否则拒绝（另一设备已写入）。CAS 成功后账号 epoch 单调递增并广播
 * fence（service.ts updateCompanionAccountState 落库；本函数为判定语义）。
 */
export function evaluateGlobalOffCas(input: {
  baseRevision: number;
  currentRevision: number;
}): GlobalOffCasResult {
  if (input.baseRevision !== input.currentRevision) {
    return { ok: false, code: "STALE_REVISION" };
  }
  return { ok: true, code: "APPLIED" };
}

/** global off 时账号 epoch 单调递增（广播 fence 的撤销信号）。 */
export function nextEpochAfterGlobalOff(currentEpoch: number): number {
  return currentEpoch + 1;
}

export type GlobalOffSyncDescription = "synced" | "device_only_pending";

/** 设置页文案：global_off CAS 失败时明确显示「仅本设备已隐藏，全局关闭尚未同步」。 */
export const GLOBAL_OFF_DEVICE_ONLY_MESSAGE = "仅本设备已隐藏，全局关闭尚未同步";

/**
 * global_off 同步状态描述：CAS 应用成功 → synced；CAS 失败（stale revision）→
 * device_only_pending（本地已 temporary hidden，设置页显示未同步文案，不得谎报
 * 全局关闭成功）。
 */
export function describeGlobalOffSync(globalOffCasApplied: boolean): GlobalOffSyncDescription {
  return globalOffCasApplied ? "synced" : "device_only_pending";
}

// ─── 5. 三种学习前台状态（§5.6）────────────────────────────────────────────

export type LearningForegroundState = "together" | "let_me_try" | "free_explore";

/** 默认学习前台状态：一起学习（安全默认 → practice_only 域；不自动进入 trusted assessment）。 */
export const DEFAULT_LEARNING_FOREGROUND_STATE: LearningForegroundState = "together";

/** 前台状态的信任域：trusted assessment 只在「让我试试」中可进入。 */
export type LearningTrustDomain = "practice_only" | "trusted_assessment";

export function foregroundTrustDomain(state: LearningForegroundState): LearningTrustDomain {
  switch (state) {
    case "together":
      return "practice_only";
    case "let_me_try":
      return "trusted_assessment";
    case "free_explore":
      return "practice_only";
  }
}

export interface LearningForegroundActions {
  /** 一起学习域内容辅助：解释/举例/展示证据/给提示/生成练习。 */
  allowContentAssistance: boolean;
  /** 可进入 trusted assessment（formal 评估，§5.6）。 */
  allowTrustedAssessment: boolean;
  /** 自由探索：回答当前目标问题、操作沙盘（候选关系仅 Should flag 开启时可见）。 */
  allowFreeExploration: boolean;
  /** 索要知识帮助：let_me_try 下只能呈现「切换到一起学习」确认（Agent 不能代点）。 */
  requireSwitchToTogetherConfirmation: boolean;
}

/** 各前台状态允许的动作矩阵（§5.6）。 */
export const LEARNING_FOREGROUND_ACTIONS: Record<
  LearningForegroundState,
  LearningForegroundActions
> = {
  together: {
    allowContentAssistance: true,
    allowTrustedAssessment: false,
    allowFreeExploration: false,
    requireSwitchToTogetherConfirmation: false,
  },
  let_me_try: {
    allowContentAssistance: false,
    allowTrustedAssessment: true,
    allowFreeExploration: false,
    requireSwitchToTogetherConfirmation: true,
  },
  free_explore: {
    allowContentAssistance: true,
    allowTrustedAssessment: false,
    allowFreeExploration: true,
    requireSwitchToTogetherConfirmation: false,
  },
};

/** 前台状态是否可进入 trusted assessment（仅「让我试试」）。 */
export function canEnterTrustedAssessment(state: LearningForegroundState): boolean {
  return LEARNING_FOREGROUND_ACTIONS[state].allowTrustedAssessment;
}

export type KnowledgeHelpGateResult =
  | { kind: "allowed" }
  | { kind: "require_switch_to_together" };

/**
 * 「索要知识帮助」的门（§5.6）：let_me_try 下只能呈现「切换到一起学习」确认动作，
 * 系统不能先给提示再补记；其余状态（一起学习/自由探索）允许内容辅助。
 * 返回 require_switch_to_together 时由 UI 呈现确认，用户确认后才可调
 * enterPracticeMode —— Agent 不能代点。
 */
export function resolveKnowledgeHelpGate(
  state: LearningForegroundState,
): KnowledgeHelpGateResult {
  if (state === "let_me_try") {
    return { kind: "require_switch_to_together" };
  }
  return { kind: "allowed" };
}

// ─── 6. enter_practice_mode：原子切换（先记录 assistance/exposure 再开 Tutor）─

export interface LearningScope {
  workspaceId: string;
  userId: string;
}

/**
 * 学习前台状态与 Tutor 权限 repo（production 由路由接线层基于 drizzle tx 提供；
 * 事务由 `transaction` 运行器统一包裹）。
 */
export interface LearningFrontRepo {
  /** 读取当前前台状态；未记录返回 null（按默认「一起学习」处理）。 */
  readForegroundState(scope: LearningScope): Promise<LearningForegroundState | null>;
  /** 先记录 assistance 与 exposure（practice_only 生效；§5.6「不能先提示再补记」）。 */
  recordAssistanceAndExposure(
    scope: LearningScope,
    input: RecordAssistanceInput,
  ): Promise<void>;
  /** 开放 Grounded Tutor 权限（必须晚于 assistance/exposure 记录；同事务）。 */
  openTutorPermission(scope: LearningScope, input: { keyPointId: string }): Promise<void>;
  /** 写入前台状态（进入 practice_only 的「一起学习」）。 */
  writeForegroundState(scope: LearningScope, state: LearningForegroundState): Promise<void>;
}

export interface RecordAssistanceInput {
  keyPointId: string;
  /** 稳定 exposure 键（由 exposure-service.computeContentExposureKey 计算）。 */
  contentExposureKey: string;
  /** 用户确认动作的 nonce（Agent 不能代点；仅用户 UI 确认后才产生）。 */
  userActionNonce: string;
  now: Date;
}

export interface EnterPracticeModeInput {
  scope: LearningScope;
  deviceSessionId: string;
  deviceSurfaceEpoch: number;
  accountEpoch: number;
  keyPointId: string;
  contentExposureKey: string;
  /** 用户确认动作的 nonce：只有用户在「切换到一起学习」确认后才会调用本端点。 */
  userActionNonce: string;
  now?: Date;
}

export interface EnterPracticeModeResult {
  state: "together";
  /** 本次是否记录了 assistance/exposure（已在 together 时幂等不重复记录）。 */
  assistanceRecorded: boolean;
  tutorPermissionOpened: boolean;
}

export const PresenceControlErrorCode = {
  /** 设备 surface epoch 落后于账号（global off 撤销后）→ 迟到结果丢弃。 */
  STALE_SURFACE_EPOCH: "STALE_SURFACE_EPOCH",
  /** 当前前台状态不允许该切换（free_explore 无需切换；unknown 拒绝）。 */
  INVALID_FOREGROUND_TRANSITION: "INVALID_FOREGROUND_TRANSITION",
  /** Agent 不能代点：enter_practice_mode 必须携带用户 UI 确认产生的 nonce。 */
  USER_CONFIRMATION_REQUIRED: "USER_CONFIRMATION_REQUIRED",
} as const;
export type PresenceControlErrorCode =
  (typeof PresenceControlErrorCode)[keyof typeof PresenceControlErrorCode];

export class PresenceControlError extends DomainError {
  readonly code: PresenceControlErrorCode;
  constructor(code: PresenceControlErrorCode, message: string) {
    super({ name: "PresenceControlError", code, message, statusCode: 400 });
    this.code = code;
  }
}

export interface EnterPracticeModeDeps {
  repo: LearningFrontRepo;
  /**
   * 事务运行器：把回调包进同一 DB 事务；回调内任一步抛错整体回滚——
   * 「先记录 assistance/exposure 再开放 Tutor 权限」的原子性由此保证。
   * production 注入 withWorkspaceTransaction(scope, ...) 适配器。
   */
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  now: () => Date;
  /**
   * 校验并消费用户确认 nonce（security_review MEDIUM #1 修复）：
   * 必须由服务端签发（短 TTL、绑定 (workspace,user,keyPointId)、一次性）；
   * 仅当 nonce 合法且未被消费才返回 true（实现负责原子消费）。
   * Agent 不能代点：没有合法 nonce，任何调用方都无法伪造用户确认。
   */
  validateAndConsumeUserActionNonce(
    scope: LearningScope,
    keyPointId: string,
    nonce: string,
  ): Promise<boolean>;
}

/**
 * 原子 enter_practice_mode（§5.6）：
 * 1. 迟到 fence（surfaceEpoch 落后）→ 拒绝，不记录不开放；
 * 2. 读取前台状态：let_me_try 才执行切换；已在 together（含默认）→ 幂等返回；
 *    free_explore → 拒绝（无需切换）；
 * 3. **先** recordAssistanceAndExposure（先记录 assistance 和 exposure）；
 * 4. **后** openTutorPermission（开放 Grounded Tutor 权限）；
 * 5. 写入「一起学习」前台状态。
 * 任一步抛错 → transaction 回滚：assistance/exposure 不残留、Tutor 权限不开放。
 * Agent 不能代点：本函数只接受用户 UI 确认后产生的 userActionNonce。
 */
export async function enterPracticeMode(
  deps: EnterPracticeModeDeps,
  input: EnterPracticeModeInput,
): Promise<EnterPracticeModeResult> {
  return deps.transaction(async () => {
    const now = input.now ?? deps.now();
    // Agent 不能代点：必须携带服务端签发的一次性 nonce（security_review MEDIUM #1）。
    // 非空校验只是第一道；真实校验/消费委托 deps.validateAndConsumeUserActionNonce
    //（短 TTL、绑定 (workspace,user,keyPointId)、原子消费）。
    if (!input.userActionNonce || input.userActionNonce.trim().length === 0) {
      throw new PresenceControlError(
        PresenceControlErrorCode.USER_CONFIRMATION_REQUIRED,
        "enter_practice_mode requires a user-confirmed action nonce; Agent cannot act on behalf of the user",
      );
    }
    const nonceValid = await deps.validateAndConsumeUserActionNonce(
      input.scope,
      input.keyPointId,
      input.userActionNonce,
    );
    if (!nonceValid) {
      throw new PresenceControlError(
        PresenceControlErrorCode.USER_CONFIRMATION_REQUIRED,
        "user action nonce is invalid, expired, or already consumed; Agent cannot act on behalf of the user",
      );
    }
    if (!validateSurfaceEpoch(input.deviceSurfaceEpoch, input.accountEpoch)) {
      throw new PresenceControlError(
        PresenceControlErrorCode.STALE_SURFACE_EPOCH,
        "device surface epoch is stale; late practice-mode switch discarded",
      );
    }

    const state = await deps.repo.readForegroundState(input.scope);
    if (state === "together" || state === null) {
      // 已处于「一起学习」域（含未选择默认）：幂等返回，不重复记录 assistance。
      // security_review MEDIUM #2：不谎报权限已开放——真实调用 openTutorPermission
      // 确保 Tutor 权限确实就绪（同事务幂等）；返回 tutorPermissionOpened=true 仅当成功。
      await deps.repo.openTutorPermission(input.scope, { keyPointId: input.keyPointId });
      return { state: "together", assistanceRecorded: false, tutorPermissionOpened: true };
    }
    if (state === "free_explore") {
      throw new PresenceControlError(
        PresenceControlErrorCode.INVALID_FOREGROUND_TRANSITION,
        "free_explore does not require switching to together mode",
      );
    }

    // 3. 先记录 assistance 与 exposure（practice_only 生效）。
    await deps.repo.recordAssistanceAndExposure(input.scope, {
      keyPointId: input.keyPointId,
      contentExposureKey: input.contentExposureKey,
      userActionNonce: input.userActionNonce,
      now,
    });
    // 4. 后开放 Grounded Tutor 权限（同事务；失败则整体回滚）。
    await deps.repo.openTutorPermission(input.scope, { keyPointId: input.keyPointId });
    // 5. 写入「一起学习」前台状态。
    await deps.repo.writeForegroundState(input.scope, "together");

    return { state: "together", assistanceRecorded: true, tutorPermissionOpened: true };
  });
}
