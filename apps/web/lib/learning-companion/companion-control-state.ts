/**
 * 任务 05-5：Companion 控制状态（原方案 §5.5，冻结记录 01-3）。
 *
 * 本文件是纯逻辑（无 React / 无 DOM / 无网络），负责 8 个 versioned 控制状态的：
 * - 类型、作用域、默认值与行为元数据（§5.5 完整表）；
 * - 组合/互斥规则（global_off 蕴含 temporary_hidden 语义、优先于一切）；
 * - `resolveControlEffects`：从快照 + 召唤/存在感输入解析唯一权威效果集，
 *   供 QuietAnchor / CompanionSidePanel / PageCompanionContextV1 adapter 消费；
 * - `shouldMountObserver` / `shouldConstructContext` 零构造判定（§5.4.4）：
 *   quiet 未召唤、page_context_off、temporary_hidden、global_off 时一律 false；
 * - `applyControlAction`：客户端接受 temporary_hidden/global_off 操作后**同步**
 *   本地应用（立即停渲染/observer/context），不等待网络结果；
 *   全局关闭的 CAS 失败时当前设备保持 temporary_hidden（§5.5）。
 *
 * 不变量：
 * - 全部判定函数是纯同步、无网络/无异步依赖 —— 结构上保证「UI 不等待网络才隐藏」；
 * - `temporary_hidden` / `global_off` 不留气泡、声音、context 监听/构造/发送、
 *   预取或新增 Companion job/Provider 调用（冻结记录 01-8 §7 / §5.5）；
 * - `page_context_off` 下即使用户召唤也只使用静态帮助，不升级上下文（§5.4.4）。
 */

// ─── 1. 控制状态 ID、作用域与元数据（§5.5 完整表）─────────────────────────

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
  /** 当前 route/stable page context，离开或用户恢复时结束 */
  | "route"
  /** 当前显式任务结束或用户恢复 */
  | "task"
  /** 账号级，直到用户显式恢复 */
  | "account"
  /** 设备级，跨刷新/重登保持，直到用户显式恢复 */
  | "device"
  /** 账号级显式偏好（不改变学习权限与结果资格） */
  | "account_preference";

export interface CompanionControlStateMeta {
  id: CompanionControlStateId;
  scope: CompanionControlScope;
  /** 默认是否开启（未选择前默认 quiet，全部默认关闭） */
  defaultOn: boolean;
  /** §5.5 行为描述（完整表，原方案 §5.5） */
  behavior: string;
}

export const COMPANION_CONTROL_STATE_META: Record<
  CompanionControlStateId,
  CompanionControlStateMeta
> = {
  page_muted: {
    id: "page_muted",
    scope: "route",
    defaultOn: false,
    behavior:
      "保留安静锚点与手动召唤；该页主动建议和自动语音为 0（离开或用户恢复时结束）",
  },
  page_context_off: {
    id: "page_context_off",
    scope: "route",
    defaultOn: false,
    behavior:
      "不挂载页面 observer、不构造/传输 entity refs；只提供静态页面帮助和通用导航（直到离开或用户恢复）",
  },
  focus_until_task_end: {
    id: "focus_until_task_end",
    scope: "task",
    defaultOn: false,
    behavior:
      "保留完成任务所需的手动控件；所有 Companion 主动建议为 0（任务结束或用户恢复）",
  },
  suggestion_paused: {
    id: "suggestion_paused",
    scope: "account",
    defaultOn: false,
    behavior:
      "保留锚点与手动召唤；所有设备的主动建议为 0（直到用户显式恢复）",
  },
  temporary_hidden: {
    id: "temporary_hidden",
    scope: "device",
    defaultOn: false,
    behavior:
      "当前设备无角色、面板、声音、邀请、context 监听/构造/发送、预取或新增 Companion job/Provider 调用；只留设置/帮助/全局命令恢复入口（跨刷新/重登保持，直到用户显式恢复）",
  },
  global_off: {
    id: "global_off",
    scope: "account",
    defaultOn: false,
    behavior:
      "所有设备执行 temporary hidden 的零监听/零调用语义，并关闭 Companion 通知（直到用户显式恢复）",
  },
  animation_off: {
    id: "animation_off",
    scope: "account_preference",
    defaultOn: false,
    behavior:
      "功能入口保留，改为静态角色；不改变学习权限与结果资格",
  },
  voice_output_off: {
    id: "voice_output_off",
    scope: "account_preference",
    defaultOn: false,
    behavior:
      "功能入口保留，改为静音；不改变学习权限与结果资格",
  },
};

// ─── 2. 快照 ─────────────────────────────────────────────────────────────

export interface CompanionControlStateSnapshot {
  pageMuted: boolean;
  pageContextOff: boolean;
  focusUntilTaskEnd: boolean;
  suggestionPaused: boolean;
  temporaryHidden: boolean;
  globalOff: boolean;
  animationOff: boolean;
  voiceOutputOff: boolean;
}

/** 默认快照：未选择前默认 quiet，全部控制状态关闭（§5.5） */
export const DEFAULT_COMPANION_CONTROL_SNAPSHOT: CompanionControlStateSnapshot = {
  pageMuted: false,
  pageContextOff: false,
  focusUntilTaskEnd: false,
  suggestionPaused: false,
  temporaryHidden: false,
  globalOff: false,
  animationOff: false,
  voiceOutputOff: false,
};

export const COMPANION_CONTROL_STATE_TO_KEY: Record<
  CompanionControlStateId,
  keyof CompanionControlStateSnapshot
> = {
  page_muted: "pageMuted",
  page_context_off: "pageContextOff",
  focus_until_task_end: "focusUntilTaskEnd",
  suggestion_paused: "suggestionPaused",
  temporary_hidden: "temporaryHidden",
  global_off: "globalOff",
  animation_off: "animationOff",
  voice_output_off: "voiceOutputOff",
};

/** 隐藏语义：global_off 蕴含 temporary_hidden（§5.5），任一为 true 即隐藏 */
export function isSnapshotHidden(snapshot: CompanionControlStateSnapshot): boolean {
  return snapshot.globalOff || snapshot.temporaryHidden;
}

// ─── 3. 存在感与召唤输入 ─────────────────────────────────────────────────

/** 三种存在感（§5.5）：安静 / 适度陪伴 / 主动建议 */
export type CompanionPresence = "quiet" | "moderate" | "active";

export interface ControlEffectsInput {
  /** 存在感档位（未选择前默认 quiet） */
  presence: CompanionPresence;
  /**
   * quiet 下用户显式召唤、选择「和伴星看看」或进入 Session 后为 true。
   * 在此之前不挂载 entity/selection observer、不构造完整 context（§5.4.4）。
   */
  surfaceActive: boolean;
  /**
   * moderate/active 下是否存在审核过的合法主动 reason
   * （rule/budget/lease 签发 permit；§5.4.4：只能在审核过的 source event 上产生最小触发快照）。
   */
  validActiveReason: boolean;
}

// ─── 4. 效果解析（唯一权威入口）─────────────────────────────────────────

export interface CompanionControlEffects {
  /** 整体表面隐藏（temporary_hidden/global_off → true；立即停渲染，不等待网络） */
  surfaceHidden: boolean;
  /** 安静锚点是否保留（hidden → false；其余保留，包括 page_context_off） */
  anchorVisible: boolean;
  /** 手动召唤是否保留（hidden → false；其余保留） */
  manualSummonAllowed: boolean;
  /** 是否挂载 entity/selection observer（召唤/会话后 && 非 hidden && 非 page_context_off） */
  observerMounted: boolean;
  /** 是否可构造完整 PageCompanionContextV1（召唤后 && 非 hidden && 非 page_context_off） */
  contextConstructible: boolean;
  /**
   * 是否可产生最小 CompanionTriggerContextV1（非 hidden && 非 page_context_off
   * && presence 非 quiet && 存在合法 reason；不含 entity refs，§5.4.4）。
   */
  triggerContextAllowed: boolean;
  /** 主动建议（邀请/下一步/自动语音）是否被抑制（page_muted/focus_until_task_end/suggestion_paused/hidden） */
  proactiveSuppressed: boolean;
  /** 语音输出能力（voice_output_off/hidden → false；功能入口保留但静音） */
  voiceOutputEnabled: boolean;
  /** 自动语音（page_muted/hidden/voice_output_off → false） */
  autoVoiceEnabled: boolean;
  /** 动画（animation_off/hidden → false；功能入口保留但静态角色） */
  animationEnabled: boolean;
}

/**
 * 从控制快照 + 召唤/存在感输入解析唯一权威效果集（§5.5 全表语义的合流）。
 * 纯同步：输入只有快照与本地 UI 状态，无网络 —— UI 不等待网络才隐藏。
 */
export function resolveControlEffects(
  snapshot: CompanionControlStateSnapshot,
  input: ControlEffectsInput,
): CompanionControlEffects {
  const hidden = isSnapshotHidden(snapshot);
  const contextOff = snapshot.pageContextOff;

  // observer 与完整 context 只在「召唤/会话后 && 非 hidden && 非 page_context_off」构造（§5.4.4）
  const observerMounted = !hidden && !contextOff && input.surfaceActive;
  const contextConstructible = !hidden && !contextOff && input.surfaceActive;

  // 主动建议抑制：page_muted / focus_until_task_end / suggestion_paused / hidden（§5.5）
  const proactiveSuppressed =
    hidden || snapshot.pageMuted || snapshot.focusUntilTaskEnd || snapshot.suggestionPaused;

  // 最小触发快照：moderate/active 在审核过的合法 reason 上产生（§5.4.4）；
  // 主动建议被抑制（page_muted/focus_until_task_end/suggestion_paused/hidden）时
  // 也不产生，避免为被抑制的建议做内部评估。
  const triggerContextAllowed =
    !hidden
    && !contextOff
    && input.presence !== "quiet"
    && input.validActiveReason
    && !proactiveSuppressed;

  return {
    surfaceHidden: hidden,
    anchorVisible: !hidden,
    manualSummonAllowed: !hidden,
    observerMounted,
    contextConstructible,
    triggerContextAllowed,
    proactiveSuppressed,
    voiceOutputEnabled: !hidden && !snapshot.voiceOutputOff,
    autoVoiceEnabled: !hidden && !snapshot.voiceOutputOff && !snapshot.pageMuted,
    animationEnabled: !hidden && !snapshot.animationOff,
  };
}

// ─── 5. observer / context 零构造判定（§5.4.4）──────────────────────────

/**
 * 是否挂载 entity/selection observer。
 * quiet 未召唤、page_context_off、temporary_hidden、global_off 时恒为 false
 * （observer/context 构造为 0，验收标准）。
 */
export function shouldMountObserver(
  snapshot: CompanionControlStateSnapshot,
  input: ControlEffectsInput,
): boolean {
  return (
    !snapshot.globalOff
    && !snapshot.temporaryHidden
    && !snapshot.pageContextOff
    && input.surfaceActive
  );
}

/**
 * 是否可构造完整 PageCompanionContextV1（与 observer 同门，§5.4.4）。
 * page_context_off 下即使用户召唤也只使用静态帮助，不升级上下文。
 */
export function shouldConstructContext(
  snapshot: CompanionControlStateSnapshot,
  input: ControlEffectsInput,
): boolean {
  return shouldMountObserver(snapshot, input);
}

// ─── 6. 立即生效：本地动作应用（不等待网络）─────────────────────────────

export type CompanionControlAction = {
  kind: "set";
  state: CompanionControlStateId;
  value: boolean;
};

/**
 * 客户端接受控制状态操作后**同步**应用：返回新快照，UI 立即据此停渲染/
 * 停 observer/停 context，不等待网络（§5.5「UI 不等待网络才隐藏」）。
 *
 * 特殊规则：
 * - 设置 global_off=true 时同时本地应用 temporary_hidden=true（立即隐藏；
 *   若后续 account CAS 失败，当前设备保持 temporary_hidden，不得谎报全局关闭成功）；
 * - 恢复 global_off=false 只关闭账号级开关，不静默撤销用户自己的设备级隐藏。
 */
export function applyControlAction(
  snapshot: CompanionControlStateSnapshot,
  action: CompanionControlAction,
): CompanionControlStateSnapshot {
  if (action.state === "global_off") {
    return {
      ...snapshot,
      globalOff: action.value,
      temporaryHidden: action.value ? true : snapshot.temporaryHidden,
    };
  }
  return { ...snapshot, [COMPANION_CONTROL_STATE_TO_KEY[action.state]]: action.value };
}
