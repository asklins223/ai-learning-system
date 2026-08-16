/**
 * cross-device-recovery.ts（阶段 07 / W6，任务 07-8：跨页、跨设备与失败恢复，§5.4.7）
 *
 * 本文件是纯逻辑（无数据库 / 无网络 / 无时钟 / 无副作用源），负责 §5.4.7 的
 * 全部决策面：
 * - **跨页只携带四样东西**：有界任务摘要、`originRef`、合法 entity refs、
 *   已确认 checkpoint —— 绝不携带无限消息流（`validateCrossPageCarry` 拒绝
 *   任何携带 messages 数组的 payload）；返回时恢复来源 / 滚动位置 / 星图
 *   viewport / 选择态（viewport 只能来自冻结恢复事实，不是页面间携带数据）；
 * - **跨设备同步白名单**：同步 onboarding offer 终态 / global off / 存在感 /
 *   suggestion suppression / 学习目标 / 合法 Session checkpoint；**不同步**
 *   temporary hidden / page mute / 未提交输入 / 原始音频 / 临时敏感内容
 *   （`extractCrossDeviceSyncState` 只含白名单字段，device-local 一律排除）；
 * - **新设备续接询问**：presence/trigger 允许时至多问一次「继续上次任务 /
 *   暂不恢复」；quiet 下只提供被动续接入口，**绝不自动展开完整 Scene**；
 * - **target 展示前重查**：展示 target 名称前重查 workspace / 权限 / 内容
 *   revision / policy / assistance / capability / checkpoint 时效；任一过期
 *   说明原因并安全重建，**恢复/接管前不暴露未重验 target 名称**；
 * - **多设备显式接管**：同一 Session 多设备并发只能显式接管或只读提示；
 *   未接管设备提交为 0（`commitAllowed` 恒为 false），重复请求幂等；
 * - **登录过期恢复**：重新认证回原页面与合法 checkpoint，**不重放旧权限
 *   action**（`replayedOldPermissionActions` 恒为空数组）；
 * - **失败恢复**：Shell/角色/动画/语音/模型失败不阻塞页面；始终提供
 *   「重试 / 使用手动方式 / 退出伴星」；重试幂等（已确认步骤不丢失、
 *   已应用副作用不重复）。
 *
 * 不变量：
 * - 全部函数纯同步；`targetNameRevealed` 只有在重查全通过时才为 true；
 * - 跨 workspace context/entity 泄漏为 0（entity refs 必须绑定 workspace 且
 *   与 carry 一致）；未接管设备 `commitAllowed === false`。
 */

// ─── 1. 存在感档位与通用类型 ────────────────────────────────────────────

/** 三种存在感（与 05-5 companion-control-state 同义，模块内自包含） */
export type PresenceLevel = "quiet" | "moderate" | "active";

/** 星图视口快照（与 07-5 four-entry-origin 同形：offsetX/offsetY/zoom） */
export interface StarMapViewportSnapshot {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

/** 星图选择快照（恢复原 selection 并显影真实变化） */
export interface StarMapSelectionSnapshot {
  selectedId: string | null;
  highlightedNodeIds?: readonly string[];
}

/** 合法 originRef（07-5 冻结类型；ephemeral 只作 originRef，正式 target 仍是 Key Point） */
export type LearningOriginRef =
  | { type: "key_point"; id: string }
  | { type: "card"; id: string }
  | { type: "review_schedule"; id: string }
  | { type: "question_suggestion"; id: string };

export const LEGAL_ORIGIN_REF_TYPES = [
  "key_point",
  "card",
  "review_schedule",
  "question_suggestion",
] as const;

// ─── 2. 跨页：有界携带与返回恢复（§5.4.7 bullet 1）─────────────────────

/** 有界任务摘要：只有一小段目标文本，绝不含消息流 */
export interface CrossPageTaskSummary {
  /** Session 内核引用（可空：浏览态没有活跃 Session） */
  sessionId: string | null;
  episodeId: string | null;
  targetKeyPointId: string | null;
  /** 有界目标摘要文本（长度受 MAX_CARRY_SUMMARY_LENGTH 限制） */
  goalText: string;
}

/** 合法 entity ref（必须绑定 workspaceId，防跨 workspace 泄漏） */
export interface LegalEntityRef {
  kind: "key_point" | "card" | "source" | "note" | "card_set";
  id: string;
  workspaceId: string;
}

/** 已确认 checkpoint：跨设备同步的合法 Session checkpoint（§5.4.7 bullet 2） */
export interface ConfirmedCheckpoint {
  checkpointId: string;
  sessionId: string;
  episodeId: string | null;
  targetKeyPointId: string | null;
  /** 已确认时刻（重查时效的基准） */
  confirmedAt: Date;
  /** 已提交步骤的幂等键（retry 幂等去重） */
  commitKey: string | null;
  workspaceId: string;
  targetWorkspaceId: string;
  /** 内容 revision（展示 target 前重查，§5.4.7 bullet 3） */
  contentRevision: number;
}

/** 跨页携带的唯一 payload（§5.4.7：四样东西，不含消息流） */
export interface CrossPageCarryPayload {
  taskSummary: CrossPageTaskSummary;
  originRef: LearningOriginRef | null;
  entityRefs: readonly LegalEntityRef[];
  confirmedCheckpoint: ConfirmedCheckpoint | null;
}

/** 有界摘要最大长度（字符）；超出即拒绝携带 */
export const MAX_CARRY_SUMMARY_LENGTH = 200;
/** 跨页携带的合法 entity ref 数量上限 */
export const MAX_CARRY_ENTITY_REFS = 8;

export type CarryRejectionReason =
  | "not_an_object"
  | "summary_too_long"
  | "too_many_entity_refs"
  | "invalid_entity_ref"
  | "cross_workspace_entity_ref"
  | "invalid_origin_ref"
  | "invalid_checkpoint"
  | "unbounded_message_flow";

export type CrossPageCarryValidation =
  | { ok: true; payload: CrossPageCarryPayload }
  | { ok: false; reason: CarryRejectionReason };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isLegalOriginRef(value: unknown): value is LearningOriginRef {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    LEGAL_ORIGIN_REF_TYPES.includes(candidate.type as (typeof LEGAL_ORIGIN_REF_TYPES)[number])
    && isNonEmptyString(candidate.id)
  );
}

function isConfirmedCheckpoint(value: unknown): value is ConfirmedCheckpoint {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.checkpointId)
    && isNonEmptyString(candidate.sessionId)
    && (candidate.episodeId === null || isNonEmptyString(candidate.episodeId))
    && (candidate.targetKeyPointId === null || isNonEmptyString(candidate.targetKeyPointId))
    && candidate.confirmedAt instanceof Date
    && (candidate.commitKey === null || isNonEmptyString(candidate.commitKey))
    && isNonEmptyString(candidate.workspaceId)
    && isNonEmptyString(candidate.targetWorkspaceId)
    && typeof candidate.contentRevision === "number"
    && Number.isFinite(candidate.contentRevision)
  );
}

/**
 * 是否携带无限消息流：任何 `messages` / `messageHistory` / `transcript` 数组
 * 都被视为无限消息流 → 拒绝（跨页只携带四样东西，§5.4.7）。
 */
export function isUnboundedMessageFlowPresent(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  for (const key of ["messages", "messageHistory", "transcript"]) {
    if (Array.isArray(candidate[key])) return true;
  }
  // 递归只检查一层以内（有界 payload 不允许嵌套消息数组）；直接子对象再查一层
  return Object.values(candidate).some(
    (child) => child !== null && typeof child === "object"
      && Object.keys(child as Record<string, unknown>).some(
        (key) => ["messages", "messageHistory", "transcript"].includes(key)
          && Array.isArray((child as Record<string, unknown>)[key]),
      ),
  );
}

function isLegalEntityRef(value: unknown): value is LegalEntityRef {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const kinds = ["key_point", "card", "source", "note", "card_set"];
  return (
    kinds.includes(candidate.kind as string)
    && isNonEmptyString(candidate.id)
    && isNonEmptyString(candidate.workspaceId)
  );
}

/**
 * 校验跨页 payload（§5.4.7 bullet 1）：
 * - 只含四样东西（taskSummary / originRef / entityRefs / confirmedCheckpoint）；
 * - taskSummary.goalText 有界（≤ MAX_CARRY_SUMMARY_LENGTH）；
 * - entityRefs 全部合法且与 payload 同一 workspace（跨 workspace 泄漏为 0）；
 * - originRef / confirmedCheckpoint 结构合法；
 * - 不含无限消息流（messages / messageHistory / transcript）→ 拒绝。
 */
export function validateCrossPageCarry(value: unknown): CrossPageCarryValidation {
  if (value === null || typeof value !== "object") {
    return { ok: false, reason: "not_an_object" };
  }
  const candidate = value as Record<string, unknown>;
  if (isUnboundedMessageFlowPresent(candidate)) {
    return { ok: false, reason: "unbounded_message_flow" };
  }
  if (candidate.taskSummary === null || typeof candidate.taskSummary !== "object") {
    return { ok: false, reason: "not_an_object" };
  }
  const summary = candidate.taskSummary as Record<string, unknown>;
  if (
    typeof summary.goalText !== "string"
    || summary.goalText.length > MAX_CARRY_SUMMARY_LENGTH
  ) {
    return { ok: false, reason: "summary_too_long" };
  }
  const originRef = candidate.originRef ?? null;
  if (originRef !== null && !isLegalOriginRef(originRef)) {
    return { ok: false, reason: "invalid_origin_ref" };
  }
  if (!Array.isArray(candidate.entityRefs)) {
    return { ok: false, reason: "invalid_entity_ref" };
  }
  if (candidate.entityRefs.length > MAX_CARRY_ENTITY_REFS) {
    return { ok: false, reason: "too_many_entity_refs" };
  }
  const checkpoint = candidate.confirmedCheckpoint ?? null;
  if (checkpoint !== null && !isConfirmedCheckpoint(checkpoint)) {
    return { ok: false, reason: "invalid_checkpoint" };
  }

  const entityRefs: LegalEntityRef[] = [];
  let carryWorkspace: string | null = null;
  if (checkpoint !== null) carryWorkspace = checkpoint.workspaceId;
  for (const refValue of candidate.entityRefs) {
    if (!isLegalEntityRef(refValue)) {
      return { ok: false, reason: "invalid_entity_ref" };
    }
    if (carryWorkspace === null) carryWorkspace = refValue.workspaceId;
    if (refValue.workspaceId !== carryWorkspace) {
      return { ok: false, reason: "cross_workspace_entity_ref" };
    }
    entityRefs.push(refValue);
  }
  if (carryWorkspace !== null && checkpoint !== null && checkpoint.workspaceId !== carryWorkspace) {
    return { ok: false, reason: "cross_workspace_entity_ref" };
  }

  const payload: CrossPageCarryPayload = {
    taskSummary: summary as unknown as CrossPageTaskSummary,
    originRef: originRef as LearningOriginRef | null,
    entityRefs,
    confirmedCheckpoint: checkpoint as ConfirmedCheckpoint | null,
  };
  return { ok: true, payload };
}

/** 返回时恢复的现场事实（来源 / 滚动位置 / 星图 viewport / 选择态） */
export interface CrossPageRestoreFacts {
  /** 返回来源页面（例如 "card-detail"、"star-map"） */
  origin: string;
  /** 滚动位置（离开时的现场恢复，不是跨页携带数据） */
  scrollPosition?: { x: number; y: number } | null;
  /** 星图现场：只有返回来源是星图时才存在（由调用方冻结提供，07-5 同源） */
  frozenStarMap?: {
    viewport: StarMapViewportSnapshot;
    selection: StarMapSelectionSnapshot;
  } | null;
}

/** 返回时恢复的信息（§5.4.7 bullet 1：来源 / 滚动位置 / viewport / 选择态） */
export interface CrossPageRestoreInfo {
  origin: string;
  scrollPosition: { x: number; y: number } | null;
  starMapViewport: StarMapViewportSnapshot | null;
  starMapSelection: StarMapSelectionSnapshot | null;
}

/**
 * 解析返回时的恢复信息。viewport/selection 只允许来自冻结恢复事实
 * （不是跨页携带的 payload 字段），且仅在返回来源是星图时呈现。
 * `carry` 是恢复的前提（调用方已通过 `validateCrossPageCarry` 校验）；
 * 本函数只消费 `facts`（来源 / 滚动位置 / 冻结星图现场）。
 */
export function resolveCrossPageRestore(
  _carry: Readonly<CrossPageCarryPayload>,
  facts: CrossPageRestoreFacts,
): CrossPageRestoreInfo {
  const isStarMapOrigin = facts.origin === "star-map" || facts.origin === "star_map";
  const frozen = isStarMapOrigin ? (facts.frozenStarMap ?? null) : null;
  return {
    origin: facts.origin,
    scrollPosition: facts.scrollPosition ?? null,
    starMapViewport: frozen?.viewport ?? null,
    starMapSelection: frozen?.selection ?? null,
  };
}

// ─── 3. 跨设备同步白名单（§5.4.7 bullet 2）─────────────────────────────

/** 跨设备同步白名单字段（§5.4.7：只同步这些） */
export const CROSS_DEVICE_SYNC_WHITELIST = [
  "onboarding_offer_terminal",   // onboarding offer 终态（completed/skipped）
  "global_off",                  // 全局关闭
  "presence",                    // 存在感
  "suggestion_suppression",      // suggestion suppression
  "learning_goals",              // 学习目标
  "session_checkpoint",          // 合法 Session checkpoint
] as const;

export type CrossDeviceSyncField = (typeof CROSS_DEVICE_SYNC_WHITELIST)[number];

/** 绝不跨设备同步的字段（§5.4.7 bullet 2 明确列出） */
export const NEVER_CROSS_DEVICE_FIELDS = [
  "temporary_hidden",     // 设备本地持久化
  "page_mute",            // 页面静音（route 作用域）
  "unsubmitted_input",    // 未提交输入
  "raw_audio",            // 原始音频
  "transient_sensitive",  // 临时敏感内容
] as const;

export type NeverCrossDeviceField = (typeof NEVER_CROSS_DEVICE_FIELDS)[number];

/** 是否为跨设备同步白名单字段 */
export function isCrossDeviceSyncField(field: string): field is CrossDeviceSyncField {
  return (CROSS_DEVICE_SYNC_WHITELIST as readonly string[]).includes(field);
}

/** 是否永不跨设备同步（temporary hidden / page mute / 未提交 / 原始音频 / 临时敏感） */
export function isNeverCrossDeviceField(field: string): field is NeverCrossDeviceField {
  return (NEVER_CROSS_DEVICE_FIELDS as readonly string[]).includes(field);
}

/**
 * 账号级、可跨设备同步的状态。字段名与 `CROSS_DEVICE_SYNC_WHITELIST` 完全一致
 * （snake_case，与 DB 列名对齐），保证同步 payload 的键集合 = 白名单，
 * 防泄漏校验精确到键级。
 */
export interface AccountSyncableState {
  onboarding_offer_terminal: boolean;
  global_off: boolean;
  presence: PresenceLevel;
  suggestion_suppression: readonly string[];
  learning_goals: readonly string[];
  session_checkpoint: ConfirmedCheckpoint | null;
}

/** 设备本地状态（绝不跨设备同步，也不进入同步 payload） */
export interface DeviceLocalState {
  temporaryHidden: boolean;
  pageMuted: boolean;
  /** 未提交输入（任意结构，仅本地；不允许被同步） */
  unsubmittedInput: unknown;
  rawAudioPending: boolean;
  transientSensitive: boolean;
}

export interface FullCompanionState {
  syncable: AccountSyncableState;
  deviceLocal: DeviceLocalState;
}

/**
 * 提取可跨设备同步的状态快照（§5.4.7 bullet 2）：
 * 只含白名单字段；temporary hidden / page mute / 未提交输入 / 原始音频 /
 * 临时敏感内容一律排除（不同步）。输出键集合 = `CROSS_DEVICE_SYNC_WHITELIST`。
 */
export function extractCrossDeviceSyncState(full: Readonly<FullCompanionState>): AccountSyncableState {
  return {
    onboarding_offer_terminal: full.syncable.onboarding_offer_terminal,
    global_off: full.syncable.global_off,
    presence: full.syncable.presence,
    suggestion_suppression: [...full.syncable.suggestion_suppression],
    learning_goals: [...full.syncable.learning_goals],
    session_checkpoint: full.syncable.session_checkpoint,
  };
}

/**
 * 校验一个同步 payload 不含任何 device-local 字段（防泄漏）：
 * 键白名单之外的一切键都被视为泄漏 → false。
 */
export function assertNoDeviceLocalLeak(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  for (const key of Object.keys(payload)) {
    if (!isCrossDeviceSyncField(key)) return false;
  }
  return true;
}

// ─── 4. 新设备续接询问（§5.4.7 bullet 3）──────────────────────────────

export interface NewDeviceResumeInput {
  presence: PresenceLevel;
  /** presence/trigger 是否允许主动询问（rule/budget/lease 已放行） */
  triggerAllowed: boolean;
  /** 本设备是否已经问过一次（至多问一次） */
  alreadyAskedOnDevice: boolean;
  /** 是否存在可续接的合法 Session checkpoint */
  hasResumableCheckpoint: boolean;
}

export type ResumeOfferKind =
  | { kind: "ask_once"; text: string }
  | { kind: "passive_entry"; text: string }
  | { kind: "none" };

/**
 * 新设备续接询问（§5.4.7 bullet 3）：
 * - 无 checkpoint → none；
 * - 已问过一次 → 不重复问，只给被动入口（passive_entry）；
 * - quiet → 只给被动续接入口，**绝不自动展开完整 Scene**；
 * - trigger 不允许 → 被动入口；
 * - 其余（moderate/active + trigger 允许 + 未问过）→ `ask_once`（至多一次：
 *   「继续上次任务 / 暂不恢复」）。
 *
 * 注意：即使选择「继续」，本函数也**不展开 Scene** —— 后续仍须重查
 * （`revalidateTargetBeforeReveal`）与显式接管（`tryExplicitTakeover`）。
 */
export function deriveNewDeviceResumeOffer(input: NewDeviceResumeInput): ResumeOfferKind {
  if (!input.hasResumableCheckpoint) return { kind: "none" };
  if (input.alreadyAskedOnDevice) {
    return {
      kind: "passive_entry",
      text: "上次的任务可以随时从这里继续。",
    };
  }
  if (input.presence === "quiet") {
    return {
      kind: "passive_entry",
      text: "上次的任务保留在这里，需要时可以从这里继续。",
    };
  }
  if (!input.triggerAllowed) {
    return { kind: "passive_entry", text: "上次的任务可以随时从这里继续。" };
  }
  return {
    kind: "ask_once",
    text: "要继续上次的任务，还是暂不恢复？",
  };
}

/** 用户对续接询问的回应（选择「继续」也不自动展开 Scene） */
export type ResumeChoice =
  | { choice: "continue_task"; needsRevalidation: true; needsExplicitTakeover: true }
  | { choice: "not_now" };

export function chooseResumeResponse(choice: "continue_task" | "not_now"): ResumeChoice {
  if (choice === "not_now") return { choice: "not_now" };
  // 选择继续 ≠ 自动展开 Scene：必须重查 + 显式接管（§5.4.7 bullet 3/4）
  return { choice: "continue_task", needsRevalidation: true, needsExplicitTakeover: true };
}

// ─── 5. target 展示前重查（§5.4.7 bullet 3）───────────────────────────

/** 重查失败原因（说明原因并安全重建，绝不暴露未重验 target 名称） */
export type TargetRevalidationReason =
  | "workspace_mismatch"
  | "permission_revoked"
  | "content_revision_stale"
  | "policy_outdated"
  | "assistance_not_allowed"
  | "capability_missing"
  | "checkpoint_too_old";

/** 安全重建计划：说明重建方式（不含 target 名称） */
export interface SafeRebuildPlan {
  action:
    | "rebuild_bounded_episode"      // 在当前位置重建有界 Episode（重新生成 target）
    | "ask_user_pick_again"          // 请用户重新选择目标
    | "reevaluate_in_place";         // 就地重新评估（不展示旧 target）
  reasonText: string;
}

export type TargetRevalidationResult =
  | {
    ok: true;
    /** 重查全通过才允许暴露 target 名称（恢复/接管前不暴露未重验名称） */
    targetNameRevealed: true;
    targetName: string;
  }
  | {
    ok: false;
    targetNameRevealed: false;
    reason: TargetRevalidationReason;
    rebuild: SafeRebuildPlan;
  };

/** checkpoint 时效阈值（超过视为过期 → 安全重建） */
export const CHECKPOINT_STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1_000; // 7 天

export interface TargetRevalidationInput {
  /** 当前请求所在的 workspace */
  currentWorkspaceId: string;
  /** checkpoint / target 所属 workspace */
  targetWorkspaceId: string;
  /** target 名称：只在重查通过后可见 */
  targetName: string;
  permissionGranted: boolean;
  /** 内容 revision 是否与 checkpoint 一致（未过期） */
  contentRevisionFresh: boolean;
  /** 相关 policy 版本是否匹配 */
  policyMatches: boolean;
  /** assistance cooldown 是否允许 */
  assistanceAllowed: boolean;
  /** 所需 capability 是否具备 */
  capabilityGranted: boolean;
  /** 本次重查时刻 */
  revalidationAt: Date;
  /** checkpoint 已确认时刻（null → 视为过旧） */
  checkpointAt: Date | null;
  /** 时效阈值（默认 7 天；测试可注入） */
  staleThresholdMs?: number;
}

/**
 * 展示 target 名称前重查（§5.4.7 bullet 3）：workspace / 权限 / 内容 revision /
 * policy / assistance / capability / checkpoint 时效。任一过期 → 说明原因并
 * 安全重建；`targetNameRevealed` 恒为 false，**不暴露未重验 target 名称**。
 */
export function revalidateTargetBeforeReveal(
  input: TargetRevalidationInput,
): TargetRevalidationResult {
  const staleMs = input.staleThresholdMs ?? CHECKPOINT_STALE_THRESHOLD_MS;
  const tooOld =
    input.checkpointAt === null
    || (input.revalidationAt.getTime() - input.checkpointAt.getTime()) > staleMs;

  const fail = (reason: TargetRevalidationReason, reasonText: string): TargetRevalidationResult => ({
    ok: false,
    targetNameRevealed: false,
    reason,
    rebuild: {
      action: reason === "permission_revoked" || reason === "workspace_mismatch"
        ? "ask_user_pick_again"
        : "rebuild_bounded_episode",
      reasonText,
    },
  });

  if (input.currentWorkspaceId !== input.targetWorkspaceId) {
    return fail("workspace_mismatch", "目标来自其他工作区，无法在当前位置展示。请重新选择目标。");
  }
  if (!input.permissionGranted) {
    return fail("permission_revoked", "当前没有查看该目标的权限。请重新选择目标。");
  }
  if (tooOld) {
    return fail("checkpoint_too_old", "上次的任务信息已经过时。需要重新确认当前内容后继续。");
  }
  if (!input.contentRevisionFresh) {
    return fail("content_revision_stale", "内容已更新，之前的任务摘要可能不再适用。需要重建本轮任务。");
  }
  if (!input.policyMatches) {
    return fail("policy_outdated", "相关策略已更新，需要按新策略重建本轮任务。");
  }
  if (!input.assistanceAllowed) {
    return fail("assistance_not_allowed", "当前处于协助冷却或协助不可用状态，先恢复正式模式。");
  }
  if (!input.capabilityGranted) {
    return fail("capability_missing", "当前环境缺少该任务所需能力。请选择手动方式或重试。");
  }
  return { ok: true, targetNameRevealed: true, targetName: input.targetName };
}

// ─── 6. 多设备显式接管（§5.4.7 bullet 4）──────────────────────────────

export type SessionDeviceRole = "owner" | "readonly";

export interface MultiDeviceSessionState {
  sessionId: string;
  currentDeviceId: string;
  /** 当前显式接管者（null = 尚无接管者） */
  ownerDeviceId: string | null;
  /** 接管 epoch（单调递增，由调用方递增提供） */
  takeoverEpoch: number;
}

export interface TakeoverAttemptResult {
  granted: boolean;
  role: SessionDeviceRole;
  /** 未接管设备提交为 0（owner 才为 true） */
  commitAllowed: boolean;
  /** 只读提示（未接管时提供；不含 target 名称） */
  readonlyNotice: string | null;
  takeoverEpoch: number;
}

/**
 * 同一 Session 多设备并发显式接管（§5.4.7 bullet 4）：
 * - 无接管者 → 首个显式请求成功接管（owner）；
 * - 已是本设备 → 幂等：重复请求返回同一结果；
 * - 已由其它设备接管 → 只读提示，`commitAllowed=false`（未接管设备提交为 0）。
 *
 * 接管的显式性由调用方保证：只有用户显式选择「在此设备继续」才调用本函数；
 * 本函数绝不自动接管（不因被动续接而接管）。
 */
export function tryExplicitTakeover(
  state: Readonly<MultiDeviceSessionState>,
  requestingDeviceId: string,
  nextEpoch: number,
): TakeoverAttemptResult {
  if (state.ownerDeviceId === null || state.ownerDeviceId === requestingDeviceId) {
    return {
      granted: true,
      role: "owner",
      commitAllowed: true,
      readonlyNotice: null,
      takeoverEpoch: state.ownerDeviceId === requestingDeviceId ? state.takeoverEpoch : nextEpoch,
    };
  }
  return {
    granted: false,
    role: "readonly",
    commitAllowed: false,
    readonlyNotice: "该任务正在另一台设备上进行中；当前设备保持只读，不会提交任何结果。",
    takeoverEpoch: state.takeoverEpoch,
  };
}

/** 未接管设备是否可提交：恒为 false（提交为 0，§5.4.7 bullet 4 验收） */
export function isCommitAllowedForDevice(
  state: Readonly<MultiDeviceSessionState>,
  deviceId: string,
): boolean {
  return state.ownerDeviceId === deviceId;
}

// ─── 7. 登录过期恢复（§5.4.7 bullet 5）────────────────────────────────

export interface ReauthResumeInput {
  /** 登录过期前确认的合法 checkpoint（若无 → null） */
  checkpoint: ConfirmedCheckpoint | null;
  /** 登录过期前所在的页面 */
  originalPage: string;
  /** 重新认证是否成功 */
  authFresh: boolean;
  /** 重新认证后新授予的权限 scope（不重放旧权限 action） */
  grantedScopes: readonly string[];
  /** 过期前想要执行的动作（例如 "commit_episode"；重新认证后须重新显式确认） */
  pendingAction: string | null;
}

export interface ReauthResumeResult {
  /** 重新认证后回到原页面 */
  restorePage: string;
  /** 回到合法 checkpoint（若有） */
  restoreCheckpoint: ConfirmedCheckpoint | null;
  /** 重新认证后可执行的动作 scope（新授权） */
  availableScopes: readonly string[];
  /** 恒为空数组：绝不重放旧权限 action（重新认证后必须重新显式确认） */
  replayedOldPermissionActions: readonly [];
  /** 需要用户重新显式确认的动作（pendingAction 的新授权路径） */
  pendingExplicitConfirmation: string | null;
}

/**
 * 登录过期后重新认证恢复（§5.4.7 bullet 5）：
 * 回到原页面与合法 checkpoint；**不重放旧权限 action** —— 过期前的 pending
 * action 一律转为「需要用户重新显式确认」；`replayedOldPermissionActions`
 * 在类型面与运行面都恒为空数组。
 */
export function reauthResumeAfterExpiry(input: ReauthResumeInput): ReauthResumeResult {
  if (!input.authFresh) {
    return {
      restorePage: input.originalPage,
      restoreCheckpoint: null,
      availableScopes: [],
      replayedOldPermissionActions: [],
      pendingExplicitConfirmation: null,
    };
  }
  return {
    restorePage: input.originalPage,
    restoreCheckpoint: input.checkpoint,
    availableScopes: [...input.grantedScopes],
    replayedOldPermissionActions: [],
    pendingExplicitConfirmation: input.pendingAction,
  };
}

// ─── 8. 失败恢复与重试幂等（§5.4.7 bullet 6）──────────────────────────

export type CompanionFailureKind = "shell" | "role" | "animation" | "voice" | "model";

export const RECOVERY_CHOICES = ["retry", "manual", "exit"] as const;
export type RecoveryChoice = (typeof RECOVERY_CHOICES)[number];

export interface FailureRecoveryInput {
  failureKind: CompanionFailureKind;
  /** 当前流程步骤 */
  steps: readonly string[];
  /** 已确认的步骤（不得丢失） */
  confirmedSteps: readonly string[];
  /** 已应用副作用（幂等键集合；不得重复应用） */
  appliedSteps: readonly string[];
  /** 已重试次数 */
  retryCount: number;
  /** 重试上限（达到后不再允许 retry） */
  maxRetries: number;
  /** 手动方式是否可用 */
  manualFallbackAvailable: boolean;
}

export interface RetryPlan {
  /** 需要重试的步骤（尚未应用；幂等：只重放未应用部分） */
  stepsToRetry: readonly string[];
  /** 已应用、不会重复执行的步骤 */
  alreadyApplied: readonly string[];
  /** 是否还可以重试（retryCount < maxRetries 且存在可重试步骤） */
  canRetry: boolean;
  /** 重试幂等：已确认步骤不重放、已应用副作用不重复 */
  retryIdempotent: boolean;
  /** 丢失的已确认步骤（正常情况下恒为空；存在丢失则不能安全重试） */
  lostConfirmedSteps: readonly string[];
}

export interface FailureRecoveryOffer {
  /** 始终提供「重试 / 使用手动方式 / 退出伴星」 */
  options: readonly RecoveryChoice[];
  retryPlan: RetryPlan;
  /** 失败不阻塞页面（恒 true）：页面原功能始终可用 */
  neverBlockPage: true;
  guidance: string;
}

function buildRetryPlan(input: FailureRecoveryInput): RetryPlan {
  const applied = new Set(input.appliedSteps);
  const stepsSet = new Set(input.steps);
  const stepsToRetry = input.steps.filter((step) => !applied.has(step));
  const lost = input.confirmedSteps.filter((step) => !applied.has(step) && !stepsSet.has(step));
  const canRetry = input.retryCount < input.maxRetries && stepsToRetry.length > 0;
  const retryIdempotent = lost.length === 0;
  return {
    stepsToRetry,
    alreadyApplied: [...applied],
    canRetry: canRetry && retryIdempotent,
    retryIdempotent,
    lostConfirmedSteps: lost,
  };
}

/**
 * 失败恢复（§5.4.7 bullet 6）：Shell/角色/动画/语音/模型失败不阻塞页面；
 * 始终提供「重试 / 使用手动方式 / 退出伴星」；重试幂等 —— 已确认步骤不丢失
 * （`lostConfirmedSteps` 恒为空才允许 retry）、已应用副作用不重复（只重放
 * `stepsToRetry` = 未应用步骤）。
 */
export function buildFailureRecoveryOffer(input: FailureRecoveryInput): FailureRecoveryOffer {
  const retryPlan = buildRetryPlan(input);
  const options: readonly RecoveryChoice[] = [
    "retry",
    "manual",
    "exit",
  ];
  const kindLabel: Record<CompanionFailureKind, string> = {
    shell: "伴星外壳",
    role: "角色组件",
    animation: "动画",
    voice: "语音",
    model: "模型",
  };
  let guidance = `${kindLabel[input.failureKind]}暂时不可用，但页面本身不受影响。`;
  if (retryPlan.canRetry) {
    guidance += `可以重试（${retryPlan.stepsToRetry.length} 个未完成步骤会继续，已完成的不会重复）；也可以使用手动方式，或退出伴星。`;
  } else {
    guidance += "建议使用手动方式继续，或退出伴星；页面与已确认的步骤不受影响。";
  }
  return { options, retryPlan, neverBlockPage: true, guidance };
}
