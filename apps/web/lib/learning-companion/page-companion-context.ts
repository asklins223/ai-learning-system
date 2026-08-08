/**
 * 任务 05-5：PageCompanionContextV1 adapter 基础设施（§5.4.4，冻结记录 01-3）。
 *
 * 本文件是纯逻辑（无 React / 无 DOM / 无网络），负责：
 * - `PageCompanionContextV1` / `CompanionTriggerContextV1` 类型（与原方案 §5.4.4 一致）；
 * - 上下文构造条件：quiet 未召唤、page_context_off、temporary_hidden、global_off
 *   时不构造/不发送完整 context snapshot（observer/context 构造为 0）；
 * - 短 TTL：召唤后构造的 context 只存活 `PAGE_CONTEXT_DEFAULT_TTL_MS`，
 *   面板关闭/动作结束即销毁（`shouldDestroyContext` / `destroyContext`）；
 * - 最小触发快照：`CompanionTriggerContextV1` 不含 visible/selected entity refs、
 *   选区文本或页面内容；只有 rule/budget/lease 签发 permit **且用户接受提示**后，
 *   才构造该 action 所需的完整净化上下文（`canUpgradeToFullContext`）；
 * - `page_context_off` 下即使用户召唤也只使用静态帮助，不升级上下文（§5.4.4）。
 *
 * 不变量（01-3 §2.2）：
 * - 完整 context 只包含 action 所需字段与 opaque 引用，不携带 URL secret/query、
 *   DOM、剪贴板、凭据或未提交输入；
 * - 短生命周期页面能力快照，不作为用户行为录像持久化。
 */

import type {
  CompanionControlStateSnapshot,
  CompanionPresence,
} from "./companion-control-state.ts";

// ─── 1. 版本与默认 TTL ──────────────────────────────────────────────────

export const PAGE_COMPANION_CONTEXT_VERSION = 1;
export const COMPANION_TRIGGER_CONTEXT_VERSION = 1;
/** 召唤后构造的 context 默认短 TTL（毫秒）。短生命周期快照，不是持续采集。 */
export const PAGE_CONTEXT_DEFAULT_TTL_MS = 30_000;

// ─── 2. 类型（原方案 §5.4.4 冻结结构）───────────────────────────────────

export type CompanionActiveMode = "browse" | "practice" | "formal" | "edit" | "settings";

export type CompanionSensitivity = "normal" | "private" | "credential";

/**
 * 净化、版本化的页面能力快照。只在召唤/会话后按 action 所需字段构造。
 * `visibleEntityRefs` / `selectedEntityRefs` 使用服务端签发的 opaque ID，
 * 不携带 URL secret/query、密码、验证码、token、隐藏答案或任意 DOM（§5.4.4）。
 */
export interface PageCompanionContextV1 {
  pageKind: string;
  pageInstanceId: string;
  originRef: string;
  visibleEntityRefs: string[];
  selectedEntityRefs: string[];
  activeMode: CompanionActiveMode;
  allowedActionIds: string[];
  capabilityFlags: string[];
  permissionSnapshotHash: string;
  hasUnsavedChanges: boolean;
  sensitivity: CompanionSensitivity;
  contextVersion: number;
}

/**
 * 最小触发快照：只用于 moderate/active 判断是否存在合法主动 reason。
 * 不含 `visibleEntityRefs`、`selectedEntityRefs`、选区文本或页面内容（§5.4.4）。
 */
export interface CompanionTriggerContextV1 {
  pageKind: string;
  stablePageContextKey: string;
  sourceEventType: string;
  canonicalTargetRef?: string;
  activeMode: CompanionActiveMode;
  capabilitySnapshotHash: string;
  permissionSnapshotHash: string;
  contextVersion: number;
}

// ─── 3. 上下文构造条件（quiet 未召唤/off/hidden → 零构造）───────────────

export type PageContextConstructionKind = "none" | "trigger_only" | "full";

export interface ContextConstructionInput {
  /** 存在感档位（未选择前默认 quiet） */
  presence: CompanionPresence;
  /** quiet 下显式召唤 / 选择「和伴星看看」 / 进入 Session 后为 true */
  surfaceActive: boolean;
  /** moderate/active 下是否存在审核过的合法主动 reason（permit 已签发） */
  validActiveReason: boolean;
}

/**
 * 决定当前应构造哪一档上下文：
 * - temporary_hidden / global_off / page_context_off → "none"（零构造，即使召唤）；
 * - surfaceActive（召唤/会话后）→ "full"（按 action 所需字段构造短 TTL context）；
 * - moderate/active + 合法 reason + 未召唤 → "trigger_only"（最小触发快照）；
 * - 其余（quiet 未召唤）→ "none"。
 */
export function pageContextConstructionKind(
  snapshot: CompanionControlStateSnapshot,
  input: ContextConstructionInput,
): PageContextConstructionKind {
  if (
    snapshot.globalOff
    || snapshot.temporaryHidden
    || snapshot.pageContextOff
  ) {
    return "none";
  }
  if (input.surfaceActive) return "full";
  if (input.presence !== "quiet" && input.validActiveReason) return "trigger_only";
  return "none";
}

// ─── 4. 构造净化上下文 ──────────────────────────────────────────────────

export interface PageContextBuildInput {
  pageKind: string;
  pageInstanceId: string;
  originRef: string;
  activeMode: CompanionActiveMode;
  allowedActionIds: readonly string[];
  capabilityFlags: readonly string[];
  permissionSnapshotHash: string;
  hasUnsavedChanges: boolean;
  sensitivity: CompanionSensitivity;
  /**
   * 按当前 action 所需字段显式传入的 opaque entity refs。
   * 缺省为空数组 —— 不发送完整实体列表，不读取选区文本或页面内容（§5.4.4）。
   */
  visibleEntityRefs?: readonly string[];
  selectedEntityRefs?: readonly string[];
}

/** 按 action 所需字段构造净化 context（副本化输入，防外部变异） */
export function buildPageContextV1(input: PageContextBuildInput): PageCompanionContextV1 {
  return {
    pageKind: input.pageKind,
    pageInstanceId: input.pageInstanceId,
    originRef: input.originRef,
    visibleEntityRefs: [...(input.visibleEntityRefs ?? [])],
    selectedEntityRefs: [...(input.selectedEntityRefs ?? [])],
    activeMode: input.activeMode,
    allowedActionIds: [...input.allowedActionIds],
    capabilityFlags: [...input.capabilityFlags],
    permissionSnapshotHash: input.permissionSnapshotHash,
    hasUnsavedChanges: input.hasUnsavedChanges,
    sensitivity: input.sensitivity,
    contextVersion: PAGE_COMPANION_CONTEXT_VERSION,
  };
}

export interface TriggerContextBuildInput {
  pageKind: string;
  stablePageContextKey: string;
  sourceEventType: string;
  activeMode: CompanionActiveMode;
  capabilitySnapshotHash: string;
  permissionSnapshotHash: string;
  canonicalTargetRef?: string;
}

/** 构造最小触发快照（不含 entity refs / 选区文本 / 页面内容） */
export function buildTriggerContextV1(input: TriggerContextBuildInput): CompanionTriggerContextV1 {
  return {
    pageKind: input.pageKind,
    stablePageContextKey: input.stablePageContextKey,
    sourceEventType: input.sourceEventType,
    canonicalTargetRef: input.canonicalTargetRef,
    activeMode: input.activeMode,
    capabilitySnapshotHash: input.capabilitySnapshotHash,
    permissionSnapshotHash: input.permissionSnapshotHash,
    contextVersion: COMPANION_TRIGGER_CONTEXT_VERSION,
  };
}

// ─── 5. 短 TTL 与销毁时机（面板关闭/动作结束即销毁）─────────────────────

export type CompanionContextLifecycle = "idle" | "constructed" | "active" | "destroyed";

/** 构造后超过短 TTL 即过期（短生命周期快照，不是持续采集） */
export function contextExpired(
  createdAt: number,
  now: number,
  ttlMs: number = PAGE_CONTEXT_DEFAULT_TTL_MS,
): boolean {
  return now - createdAt > ttlMs;
}

/**
 * 销毁时机：面板关闭或当前 action 结束即销毁（§5.4.4）。
 * idle（未构造）不需要销毁；已 destroyed 保持 destroyed。
 */
export function shouldDestroyContext(
  lifecycle: CompanionContextLifecycle,
  input: { panelClosed: boolean; actionEnded: boolean },
): boolean {
  if (lifecycle === "idle") return false;
  if (lifecycle === "destroyed") return true;
  return input.panelClosed || input.actionEnded;
}

/** 销毁（面板关闭/动作结束/TTL 过期时调用）；idle 不产生状态变化 */
export function destroyContext(lifecycle: CompanionContextLifecycle): CompanionContextLifecycle {
  return lifecycle === "idle" ? lifecycle : "destroyed";
}

// ─── 6. 最小上下文升级（permit + 用户接受后才升级完整上下文）────────────

/**
 * 是否可升级为完整净化上下文：
 * - hidden / page_context_off 下恒不可升级（页面只提供静态帮助）；
 * - 必须同时满足：surface active、rule/budget/lease 已签发 permit、用户已接受提示。
 */
export function canUpgradeToFullContext(
  snapshot: CompanionControlStateSnapshot,
  input: {
    surfaceActive: boolean;
    permitGranted: boolean;
    userAccepted: boolean;
  },
): boolean {
  if (snapshot.globalOff || snapshot.temporaryHidden || snapshot.pageContextOff) {
    return false;
  }
  return input.surfaceActive && input.permitGranted && input.userAccepted;
}
