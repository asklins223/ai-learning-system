/**
 * 阶段 08（W7）任务 08-5：全链路 E2E 0 容忍校验纯逻辑（§16.4 硬 Gate + §17.1 子集）。
 *
 * 本文件是**纯逻辑校验器**（无 DB / 无网络 / 无副作用 / 无随机），把冻结记录 01-5
 * §5.3「自主性硬 Gate」与 `08-w7-audit-observability.md` 任务 08-5 的 8 组 0 容忍
 * 要求翻译成确定性断言函数。每个校验函数输入一次全链路场景的观察记录
 * （`CompanionActivity` 事件 + 各维度上下文），输出违规列表（空 = 该维度 0 容忍通过）。
 *
 * 覆盖维度（与任务 08-5 一一对应）：
 * - D1 hidden/off 零活动矩阵：`temporary_hidden` 本地生效/runtime-fence 确认后，当前
 *   device session 的页面 context listener/DTO、角色/声音/应用内邀请/预取/新增
 *   Companion 调用为 0；`global_off` CAS 后所有设备上述活动及 Companion 系统通知为 0；
 *   可取消调用未取消或迟到结果被采用为 0；
 * - D2 epoch 传播：`global_off` account epoch 向 active devices 传播不超过 W0 SLA、
 *   旧 lease 到期后不挂载/调用、CAS 失败不显示全局成功；
 * - D3 新设备预解析：account global off 用户新设备认证后、开关状态解析前不挂载
 *   observer/context/角色或发 Companion 调用；
 * - D4 credential 页六面零进入：任意 `sensitivity=credential` 页输入值及字段交互
 *   元数据进入 DTO/日志/analytics/截图/模型/持久上下文为 0；该页 LLM/ASR/TTS、
 *   个性化预取与 DOM/selection observer 为 0；
 * - D5 quiet 与 permit：quiet 未召唤时 entity/selection observer、完整
 *   `PageCompanionContextV1` 构造/传输和 idle 动画为 0；moderate/active 在 permit +
 *   用户接受前不传输 visible/selected entity refs 或页面内容；
 * - D6 写入四重验证：未经影响预览、当前 context/permission 重验、有效用户 nonce 与
 *   显式确认而成功执行的写入/发布/偏好修改/导出/删除为 0；Global Shell 直接写领域
 *   数据为 0；
 * - D7 自主性零越界：自动开启麦克风为 0、未 opt-in 通知为 0、`later/dismiss/stop`
 *   修改 schedule/偏好/理解状态或制造负向记录为 0、用户主动停止成功率 100%、
 *   完成后自动进入下一题/路线为 0；
 * - D8 onboarding 终态：offerStatus=offered 后第二次自动展示为 0；consumed 后同版本
 *   系统自动邀请或自动重放为 0；用户主动跳过所需动作数为 1；终态被刷新/重登/旧
 *   CAS/跨设备回退为 0。
 *
 * 确定性保证：所有判定基于输入记录做穷举匹配，无时钟/随机/顺序依赖；测试对每个
 * 0 容忍项提供「干净样本全 0 + 违规样本必检」双断言。
 */

// ─── 1. 公共类型 ─────────────────────────────────────────────────────────

/** 页面敏感级（与 05-5 `PageCompanionContextV1.sensitivity` 一致，本地复刻以保持独立）。 */
export type CompanionSensitivity = "normal" | "private" | "credential";

/** 存在感三档（与 presence-control `CompanionPresenceLevel` 一致）。 */
export type CompanionPresenceLevel = "quiet" | "moderate" | "active";

/** 0 容忍违规：人类可读的确定性描述。 */
export type ZeroToleranceViolation = string;

/**
 * 全链路可观察活动（E2E harness 记录一次真实旅程的全部 Companion 相关事件）。
 * `atMs` 缺省视为「确认/检查窗口内发生」（保守判定）。
 */
export interface CompanionActivity {
  kind: CompanionActivityKind;
  /** 发生活动所在的 device session（缺省 = 当前设备；hidden 只对当前设备生效）。 */
  deviceSessionId?: string;
  /** 活动发生时刻（ms；缺省视为窗口内）。 */
  atMs?: number;
  /** 活动所在页面敏感级（credential 页判定）。 */
  pageSensitivity?: CompanionSensitivity;
  /** credential 值/字段交互元数据进入的目标渠道（六面之一）。 */
  channel?: CredentialIngressChannel;
  /** 是否为完整 PageCompanionContextV1 构造/传输（缺省按完整处理）。 */
  fullContext?: boolean;
  /** 该提示/传输是否已取得合法 permit（07-3 签发）。 */
  permitGranted?: boolean;
  /** 用户是否已显式接受提示。 */
  userAccepted?: boolean;
  /** Companion 调用是否已请求取消（可取消调用判定）。 */
  cancelRequested?: boolean;
  /** 已请求取消的调用是否真正被取消。 */
  cancelled?: boolean;
  /** 麦克风是否用户显式触发（自动开麦判定的豁免）。 */
  userInitiated?: boolean;
  /** 通知发送时用户是否已 opt-in。 */
  optedIn?: boolean;
}

export const ZERO_TOLERANCE_ACTIVITY_KINDS = [
  "page_context_listener",
  "page_context_dto",
  "character",
  "voice",
  "in_app_invite",
  "prefetch",
  "companion_call",
  "system_notification",
  "observer_mount",
  "idle_animation",
  "llm_call",
  "asr_call",
  "tts_call",
  "microphone_start",
  "notification_send",
  "domain_write",
  "transfer_entity_refs",
  "credential_value_ingress",
  "credential_metadata_ingress",
  "auto_advance",
  "late_result_adopted",
] as const;
export type CompanionActivityKind = (typeof ZERO_TOLERANCE_ACTIVITY_KINDS)[number];

/** credential 值/字段交互元数据不得进入的六个渠道（§13.1/§13.3、任务 08-2）。 */
export const CREDENTIAL_INGRESS_CHANNELS = [
  "companion_dto",
  "logs",
  "analytics",
  "screenshot",
  "model_request",
  "persistent_context",
] as const;
export type CredentialIngressChannel = (typeof CREDENTIAL_INGRESS_CHANNELS)[number];

/** 类型守卫：字符串是否为合法活动 kind。 */
export function isZeroToleranceActivityKind(value: string): value is CompanionActivityKind {
  return (ZERO_TOLERANCE_ACTIVITY_KINDS as readonly string[]).includes(value);
}

/** 类型守卫：字符串是否为合法 credential 进入渠道（六面）。 */
export function isCredentialIngressChannel(value: string): value is CredentialIngressChannel {
  return (CREDENTIAL_INGRESS_CHANNELS as readonly string[]).includes(value);
}

// ─── 2. D1：hidden/off 零活动矩阵 ─────────────────────────────────────────

/**
 * temporary_hidden / global_off 确认后必须清零的活动集合（§5.5、01-5 §5.3-1）：
 * 页面 context listener/DTO、角色、声音、应用内邀请、预取、新增 Companion 调用，
 * 以及 entity/selection observer 与 idle 动画（observer/context 构造为 0）。
 * `global_off` 额外要求 Companion 系统通知为 0（所有设备）。
 */
export const HIDDEN_SUPPRESSED_ACTIVITIES: readonly CompanionActivityKind[] = [
  "page_context_listener",
  "page_context_dto",
  "character",
  "voice",
  "in_app_invite",
  "prefetch",
  "companion_call",
  "llm_call",
  "asr_call",
  "tts_call",
  "observer_mount",
  "idle_animation",
];

export interface HiddenOffActivityCheckInput {
  /** 当前 device session（temporary_hidden 只约束当前设备）。 */
  deviceSessionId?: string;
  /** temporary_hidden 是否已本地生效/runtime-fence 确认。 */
  temporaryHiddenConfirmed: boolean;
  /** global_off 是否已 account CAS 应用（所有设备生效）。 */
  globalOffCasApplied: boolean;
  /** temporary_hidden 确认时刻（ms）；缺省 = 全部活动视为确认后。 */
  hiddenConfirmedAtMs?: number;
  /** 全链路观察到的活动。 */
  activities: readonly CompanionActivity[];
}

/** 活动是否落在 hidden/off 确认之后（无时间戳 → 保守视为之后）。 */
function occursAfterHiddenConfirm(
  activity: CompanionActivity,
  confirmedAtMs: number | undefined,
): boolean {
  if (confirmedAtMs === undefined) return true;
  if (activity.atMs === undefined) return true;
  return activity.atMs >= confirmedAtMs;
}

/**
 * D1 校验：hidden/off 确认后 0 监听/0 调用；可取消调用未取消或迟到结果被采用为 0。
 */
export function checkHiddenOffZeroActivity(
  input: HiddenOffActivityCheckInput,
): readonly ZeroToleranceViolation[] {
  const violations: ZeroToleranceViolation[] = [];
  for (const activity of input.activities) {
    const suppressed =
      activity.kind === "system_notification"
      || (HIDDEN_SUPPRESSED_ACTIVITIES as readonly string[]).includes(activity.kind);
    const isThisDevice =
      activity.deviceSessionId === undefined
      || activity.deviceSessionId === input.deviceSessionId;

    if (input.temporaryHiddenConfirmed) {
      if (isThisDevice && suppressed && occursAfterHiddenConfirm(activity, input.hiddenConfirmedAtMs)) {
        violations.push(
          `temporary_hidden 确认后当前设备 ${activity.kind} 活动=0 被违反（要求 0）`,
        );
      }
    }
    if (input.globalOffCasApplied) {
      // global_off 对所有设备生效：不区分 deviceSessionId，也包含系统通知。
      if (suppressed && occursAfterHiddenConfirm(activity, input.hiddenConfirmedAtMs)) {
        violations.push(`global_off CAS 后 ${activity.kind} 活动=0 被违反（所有设备要求 0）`);
      }
    }
    if (
      activity.kind === "companion_call"
      && activity.cancelRequested === true
      && activity.cancelled !== true
    ) {
      violations.push("可取消 Companion 调用已请求取消但未取消=0 被违反");
    }
    if (activity.kind === "late_result_adopted") {
      violations.push("迟到 Companion 结果被采用=0 被违反（须丢弃不渲染不写状态）");
    }
  }
  return violations;
}

// ─── 3. D2：global_off epoch 传播 SLA 与 lease/CAS ────────────────────────

/**
 * W0 冻结：global_off account epoch 向 active devices 传播的 SLA。
 * 冻结记录 01-5 §5.3-2 只冻结「不超过 W0 SLA」；具体毫秒值未在文档给出，
 * 本记录冻结 5 秒为 W0 阈值（见 08-5 决策记录），测试可注入覆盖。
 */
export const GLOBAL_OFF_PROPAGATION_SLA_MS = 5_000;

/** 一台 active device 收到 epoch 的记录。 */
export interface DeviceEpochReceipt {
  deviceSessionId: string;
  /** 收到 epoch 的时刻（ms）。 */
  epochReceivedAtMs: number;
  /** 该设备实际收到的 account epoch。 */
  epochReceived: number;
}

export interface EpochPropagationCheckInput {
  /** global_off CAS 应用时刻（ms）。 */
  globalOffAppliedAtMs: number;
  /** global_off 后账号当前 account epoch（单调递增后的值）。 */
  accountEpochAfterGlobalOff: number;
  /** 各 active device 的 epoch 接收记录。 */
  devices: readonly DeviceEpochReceipt[];
  /** 旧 lease 到期时刻（ms）；之后不得再挂载/调用。 */
  leaseExpiredAtMs: number;
  /** 旧 lease 到期后的活动（用于检出「旧 lease 到期后仍挂载/调用」）。 */
  activities: readonly CompanionActivity[];
  /** global_off CAS 是否失败（stale revision）。 */
  globalOffCasFailed: boolean;
  /** 设置页/客户端是否显示了「全局关闭成功」。 */
  displayedGlobalSuccess: boolean;
  /** 传播 SLA（默认 W0 冻结值）。 */
  slaMs?: number;
}

/**
 * D2 校验：epoch 传播 ≤ SLA；设备必须收到最新 epoch；旧 lease 到期后不挂载/调用；
 * CAS 失败不得显示全局成功（只显示「仅本设备已隐藏」）。
 */
export function checkEpochPropagationSla(
  input: EpochPropagationCheckInput,
): readonly ZeroToleranceViolation[] {
  const violations: ZeroToleranceViolation[] = [];
  const slaMs = input.slaMs ?? GLOBAL_OFF_PROPAGATION_SLA_MS;

  for (const device of input.devices) {
    if (device.epochReceived !== input.accountEpochAfterGlobalOff) {
      violations.push(
        `设备 ${device.deviceSessionId} 收到旧 epoch ${device.epochReceived}（应为 ${input.accountEpochAfterGlobalOff}）：旧 epoch 传播=0 被违反`,
      );
    }
    if (device.epochReceivedAtMs - input.globalOffAppliedAtMs > slaMs) {
      violations.push(
        `设备 ${device.deviceSessionId} epoch 传播耗时 ${
          device.epochReceivedAtMs - input.globalOffAppliedAtMs
        }ms 超过 W0 SLA ${slaMs}ms`,
      );
    }
  }

  for (const activity of input.activities) {
    if (activity.atMs !== undefined && activity.atMs > input.leaseExpiredAtMs) {
      if ((HIDDEN_SUPPRESSED_ACTIVITIES as readonly string[]).includes(activity.kind)) {
        violations.push(
          `旧 lease 到期后仍发生 ${activity.kind}=0 被违反（到期后不挂载/调用）`,
        );
      }
    }
  }

  if (input.globalOffCasFailed && input.displayedGlobalSuccess) {
    violations.push("global_off CAS 失败却显示全局成功=0 被违反（只能显示「仅本设备已隐藏，全局关闭尚未同步」）");
  }
  return violations;
}

// ─── 4. D3：新设备认证后、开关状态解析前零挂载 ───────────────────────────

export type NewDeviceEvent =
  | { kind: "auth_completed"; atMs: number }
  | { kind: "account_state_resolved"; atMs: number }
  | { kind: "mount_activity"; atMs: number; activity: CompanionActivity };

/**
 * D3 校验：account global off 用户在新设备认证完成后、account state 开关状态解析
 * 完成前，不得挂载 observer/context/角色或发 Companion 调用（01-5 §5.3-3）。
 */
export function checkNewDevicePreResolutionZeroMount(
  events: readonly NewDeviceEvent[],
): readonly ZeroToleranceViolation[] {
  const violations: ZeroToleranceViolation[] = [];
  const sorted = [...events].sort((a, b) => a.atMs - b.atMs);
  let authCompleted = false;
  let stateResolved = false;
  for (const event of sorted) {
    if (event.kind === "auth_completed") {
      authCompleted = true;
    } else if (event.kind === "account_state_resolved") {
      stateResolved = true;
    } else if (event.kind === "mount_activity" && authCompleted && !stateResolved) {
      violations.push(
        `新设备认证后、开关状态解析前挂载 ${event.activity.kind}=0 被违反（须先解析 global off）`,
      );
    }
  }
  return violations;
}

// ─── 5. D4：credential 页六面零进入 + 零模型/预取/observer ───────────────

export interface CredentialPageCheckInput {
  /** credential 页上观察到的活动（含输入值/字段交互元数据进入渠道）。 */
  activities: readonly CompanionActivity[];
}

/**
 * D4 校验：
 * - 输入值及字段焦点/长度/粘贴/自动填充/时序元数据进入六面（DTO/日志/analytics/
 *   截图/模型/持久上下文）= 0；
 * - 该页 LLM/ASR/TTS、个性化预取与 DOM/selection observer = 0（01-5 §5.3-4）。
 */
export function checkCredentialPageZeroIngress(
  input: CredentialPageCheckInput,
): readonly ZeroToleranceViolation[] {
  const violations: ZeroToleranceViolation[] = [];
  for (const activity of input.activities) {
    if (activity.kind === "credential_value_ingress") {
      violations.push(
        `credential 页输入值进入 ${activity.channel ?? "未知渠道"}=0 被违反（六面全 0）`,
      );
    }
    if (activity.kind === "credential_metadata_ingress") {
      violations.push(
        `credential 页字段交互元数据（焦点/长度/粘贴/自动填充/时序）进入 ${
          activity.channel ?? "未知渠道"
        }=0 被违反`,
      );
    }
    if (
      activity.pageSensitivity === "credential"
      && (activity.kind === "llm_call"
        || activity.kind === "asr_call"
        || activity.kind === "tts_call"
        || activity.kind === "prefetch"
        || activity.kind === "observer_mount")
    ) {
      violations.push(`credential 页 ${activity.kind}=0 被违反（LLM/ASR/TTS/个性化预取/observer 全 0）`);
    }
  }
  return violations;
}

// ─── 6. D5：quiet 零 observer/context/idle；permit+accept 前零传输 ────────

export interface QuietAndTransferCheckInput {
  /** 存在感档位（未选择前默认 quiet）。 */
  presence: CompanionPresenceLevel;
  /** quiet 下是否已显式召唤/进入 Session（surface active）。 */
  surfaceActive: boolean;
  /** 观察到的活动。 */
  activities: readonly CompanionActivity[];
}

/**
 * D5 校验（01-5 §5.3-8）：
 * - quiet 未召唤：entity/selection observer、完整 PageCompanionContextV1 构造/传输、
 *   idle 动画 = 0；
 * - moderate/active：在 permit + 用户接受前不传输 visible/selected entity refs 或
 *   页面内容。
 */
export function checkQuietZeroAndPrePermitTransfer(
  input: QuietAndTransferCheckInput,
): readonly ZeroToleranceViolation[] {
  const violations: ZeroToleranceViolation[] = [];
  if (input.presence === "quiet" && !input.surfaceActive) {
    for (const activity of input.activities) {
      if (activity.kind === "observer_mount") {
        violations.push("quiet 未召唤时挂载 entity/selection observer=0 被违反");
      }
      if (activity.kind === "idle_animation") {
        violations.push("quiet 未召唤时产生 idle 动画=0 被违反");
      }
      if (activity.kind === "page_context_dto" && activity.fullContext !== false) {
        violations.push("quiet 未召唤时构造/传输完整 PageCompanionContextV1=0 被违反");
      }
    }
  }
  for (const activity of input.activities) {
    if (
      activity.kind === "transfer_entity_refs"
      && (activity.permitGranted !== true || activity.userAccepted !== true)
    ) {
      violations.push(
        "moderate/active 在 permit+用户接受前传输 visible/selected entity refs 或页面内容=0 被违反",
      );
    }
  }
  return violations;
}

// ─── 7. D6：写入/发布/偏好/导出/删除需四重验证；Global Shell 零领域写 ─────

export type MutationActionKind =
  | "write"
  | "publish"
  | "preference_change"
  | "export"
  | "delete";

export interface MutationAttempt {
  actionKind: MutationActionKind;
  /** 是否展示过影响预览。 */
  impactPreviewSeen: boolean;
  /** 是否完成当前 context/permission 重验。 */
  contextPermissionRevalidated: boolean;
  /** 是否携带有效用户 nonce（服务端签发、一次性）。 */
  userNonceValid: boolean;
  /** 用户是否显式确认。 */
  explicitConfirmed: boolean;
  /** 是否最终执行成功（只有成功才算违规）。 */
  executed: boolean;
  /** 是否由 Global Shell 直接发出（Global Shell 不得直接写领域数据）。 */
  viaGlobalShell?: boolean;
}

export interface MutationGateCheckInput {
  mutations: readonly MutationAttempt[];
}

/**
 * D6 校验（01-5 §5.3-11）：
 * - 未经「影响预览 + context/permission 重验 + 有效用户 nonce + 显式确认」四重验证
 *   而成功执行的写入/发布/偏好修改/导出/删除 = 0；
 * - Global Shell 直接写领域数据 = 0（shell-actions 的 canonicalWrite 恒 false）。
 */
export function checkMutationRequiresFourGates(
  input: MutationGateCheckInput,
): readonly ZeroToleranceViolation[] {
  const violations: ZeroToleranceViolation[] = [];
  for (const mutation of input.mutations) {
    const fourGatesPassed =
      mutation.impactPreviewSeen
      && mutation.contextPermissionRevalidated
      && mutation.userNonceValid
      && mutation.explicitConfirmed;
    if (mutation.executed && !fourGatesPassed) {
      const missing: string[] = [];
      if (!mutation.impactPreviewSeen) missing.push("影响预览");
      if (!mutation.contextPermissionRevalidated) missing.push("context/permission 重验");
      if (!mutation.userNonceValid) missing.push("有效用户 nonce");
      if (!mutation.explicitConfirmed) missing.push("显式确认");
      violations.push(
        `${mutation.actionKind} 在缺 ${missing.join("、")} 的情况下成功执行=0 被违反`,
      );
    }
    if (mutation.executed && mutation.viaGlobalShell === true) {
      violations.push("Global Shell 直接写领域数据=0 被违反（canonicalWrite 必须为 false）");
    }
  }
  return violations;
}

// ─── 8. D7：自动开麦/未 opt-in 通知/later 零副作用/停止 100%/零自动续题 ───

export type LaterDismissStopAction = "later" | "dismiss" | "stop";

export interface LaterDismissStopEffect {
  action: LaterDismissStopAction;
  /** later/dismiss/stop 允许的副作用只有 none（route-launcher sideEffects）。 */
  sideEffectKind: "schedule" | "preference" | "understanding" | "negative_record" | "none";
}

export interface AutonomyCheckInput {
  /** 观察到的活动（自动开麦/未 opt-in 通知/自动续题）。 */
  activities: readonly CompanionActivity[];
  /** later/dismiss/stop 的副作用记录。 */
  laterDismissStopEffects: readonly LaterDismissStopEffect[];
  /** 用户主动停止尝试（每项须 100% 成功）。 */
  stopAttempts: readonly { requested: boolean; completed: boolean }[];
}

/**
 * D7 校验（01-5 §5.3-16/17/18、§16.4）：
 * - 自动开启麦克风 = 0（用户显式触发豁免）；
 * - 未 opt-in 通知 = 0；
 * - later/dismiss/stop 修改 schedule/偏好/理解状态或制造负向记录 = 0；
 * - 用户主动停止成功率 = 100%；
 * - 完成后自动进入下一题/路线 = 0。
 */
export function checkAutonomyZero(
  input: AutonomyCheckInput,
): readonly ZeroToleranceViolation[] {
  const violations: ZeroToleranceViolation[] = [];
  for (const activity of input.activities) {
    if (activity.kind === "microphone_start" && activity.userInitiated !== true) {
      violations.push("自动开启麦克风=0 被违反");
    }
    if (activity.kind === "notification_send" && activity.optedIn !== true) {
      violations.push("未 opt-in 通知=0 被违反");
    }
    if (activity.kind === "auto_advance") {
      violations.push("完成后自动进入下一题/路线=0 被违反（是否继续由用户主动决定）");
    }
  }
  for (const effect of input.laterDismissStopEffects) {
    if (effect.sideEffectKind !== "none") {
      violations.push(
        `${effect.action} 修改 ${effect.sideEffectKind}=0 被违反（later/dismiss/stop 必须零副作用）`,
      );
    }
  }
  for (const attempt of input.stopAttempts) {
    if (attempt.requested && !attempt.completed) {
      violations.push("用户主动停止未成功（停止成功率必须 100%）");
    }
  }
  return violations;
}

/** 停止成功率（0..1）：所有「已请求停止」中成功完成的比例。 */
export function computeStopSuccessRate(
  attempts: readonly { requested: boolean; completed: boolean }[],
): number {
  const requested = attempts.filter((a) => a.requested);
  if (requested.length === 0) return 1;
  const completed = requested.filter((a) => a.completed).length;
  return completed / requested.length;
}

// ─── 9. D8：onboarding 终态与主动跳过 ─────────────────────────────────────

export type OnboardingOfferStatus = "not_offered" | "offered" | "consumed";

export interface OnboardingCheckInput {
  /** 当前版本 onboarding offerStatus。 */
  offerStatus: OnboardingOfferStatus;
  /** offered 后第二次自动展示计数（>0 = 违规）。 */
  autoShowsAfterOffer: number;
  /** consumed 后同版本由系统自动邀请或自动重放的次数（>0 = 违规）。 */
  autoInviteOrReplayAfterConsumed: number;
  /** 用户主动跳过所需动作数（必须恰好 1：一次「我自己看看」）。 */
  skipActionCount: number;
  /** 终态被刷新/重登/旧 CAS/跨设备回退次数（consumed 下 >0 = 违规）。 */
  terminalRollbackCount: number;
}

/**
 * D8 校验（01-5 §5.3-6）：
 * - offerStatus=offered 后第二次自动展示 = 0；
 * - consumed 后同版本系统自动邀请或自动重放 = 0；
 * - 用户主动跳过所需动作数 = 1；
 * - 终态被刷新/重登/旧 CAS/跨设备回退 = 0（manual replay 不计为违规）。
 */
export function checkOnboardingZero(
  input: OnboardingCheckInput,
): readonly ZeroToleranceViolation[] {
  const violations: ZeroToleranceViolation[] = [];
  if (input.offerStatus === "offered" && input.autoShowsAfterOffer > 0) {
    violations.push(`offerStatus=offered 后第二次自动展示=0 被违反（已 ${input.autoShowsAfterOffer} 次）`);
  }
  if (input.offerStatus === "consumed" && input.autoInviteOrReplayAfterConsumed > 0) {
    violations.push(
      `consumed 后同版本系统自动邀请/自动重放=0 被违反（已 ${input.autoInviteOrReplayAfterConsumed} 次）`,
    );
  }
  if (input.skipActionCount !== 1) {
    violations.push(`用户主动跳过所需动作数为 ${input.skipActionCount}（必须恰好 1）`);
  }
  if (input.offerStatus === "consumed" && input.terminalRollbackCount > 0) {
    violations.push(
      `终态被刷新/重登/旧 CAS/跨设备回退=0 被违反（已 ${input.terminalRollbackCount} 次）`,
    );
  }
  return violations;
}

// ─── 10. 聚合：全链路 0 容忍套件 ──────────────────────────────────────────

export const ZERO_TOLERANCE_DIMENSION_IDS = [
  "hidden_off",
  "epoch_propagation",
  "new_device",
  "credential_page",
  "quiet_transfer",
  "mutation_gates",
  "autonomy",
  "onboarding",
] as const;
export type ZeroToleranceDimensionId = (typeof ZERO_TOLERANCE_DIMENSION_IDS)[number];

/** 一次全链路 E2E 场景（8 个维度各自的观察输入）。 */
export interface ZeroToleranceScenario {
  hiddenOff: HiddenOffActivityCheckInput;
  epochPropagation: EpochPropagationCheckInput;
  /** D3：新设备认证后事件序列。 */
  newDevice: readonly NewDeviceEvent[];
  credentialPage: CredentialPageCheckInput;
  quietTransfer: QuietAndTransferCheckInput;
  mutationGates: MutationGateCheckInput;
  autonomy: AutonomyCheckInput;
  onboarding: OnboardingCheckInput;
}

export interface ZeroToleranceReport {
  ok: boolean;
  /** 全部维度违规合并（空数组 = 全链路 0 容忍通过）。 */
  violations: readonly ZeroToleranceViolation[];
  /** 各维度独立违规。 */
  dimensions: Record<ZeroToleranceDimensionId, readonly ZeroToleranceViolation[]>;
}

/** 运行一次全链路 0 容忍套件，返回确定性报告。 */
export function runZeroToleranceSuite(scenario: ZeroToleranceScenario): ZeroToleranceReport {
  const dimensions: Record<ZeroToleranceDimensionId, readonly ZeroToleranceViolation[]> = {
    hidden_off: checkHiddenOffZeroActivity(scenario.hiddenOff),
    epoch_propagation: checkEpochPropagationSla(scenario.epochPropagation),
    new_device: checkNewDevicePreResolutionZeroMount(scenario.newDevice),
    credential_page: checkCredentialPageZeroIngress(scenario.credentialPage),
    quiet_transfer: checkQuietZeroAndPrePermitTransfer(scenario.quietTransfer),
    mutation_gates: checkMutationRequiresFourGates(scenario.mutationGates),
    autonomy: checkAutonomyZero(scenario.autonomy),
    onboarding: checkOnboardingZero(scenario.onboarding),
  };
  const violations: ZeroToleranceViolation[] = [];
  for (const key of ZERO_TOLERANCE_DIMENSION_IDS) {
    violations.push(...dimensions[key]);
  }
  return { ok: violations.length === 0, violations, dimensions };
}

export class ZeroToleranceFailure extends Error {
  readonly violations: readonly ZeroToleranceViolation[];
  constructor(violations: readonly ZeroToleranceViolation[]) {
    super(`全链路 0 容忍校验失败（${violations.length} 项违规）：\n- ${violations.join("\n- ")}`);
    this.name = "ZeroToleranceFailure";
    this.violations = violations;
  }
}

/**
 * 确定性断言入口：任一维度违规即抛 `ZeroToleranceFailure`（0 容忍 fail closed）。
 * 供 CI/E2E harness 在真实旅程结束点调用；单测用 `runZeroToleranceSuite` 逐维断言。
 */
export function assertZeroTolerance(scenario: ZeroToleranceScenario): ZeroToleranceReport {
  const report = runZeroToleranceSuite(scenario);
  if (!report.ok) {
    throw new ZeroToleranceFailure(report.violations);
  }
  return report;
}

/** 维度到任务 08-5 要求的说明（供报告/决策记录引用）。 */
export const ZERO_TOLERANCE_DIMENSION_DESCRIPTIONS: Record<
  ZeroToleranceDimensionId,
  string
> = {
  hidden_off:
    "temporary_hidden 本地生效/runtime-fence 确认后当前 device session 的页面 context listener/DTO、角色/声音/应用内邀请/预取/新增 Companion 调用为 0；global_off CAS 后所有设备上述活动及 Companion 系统通知为 0；可取消调用未取消或迟到结果被采用为 0",
  epoch_propagation:
    "global_off account epoch 向 active devices 传播不超过 W0 SLA、旧 lease 到期后不挂载/调用、CAS 失败不显示全局成功",
  new_device:
    "account global off 用户新设备认证后、开关状态解析前不挂载 observer/context/角色或发 Companion 调用",
  credential_page:
    "任意 sensitivity=credential 页输入值及字段交互元数据零进入；该页 LLM/ASR/TTS、个性化预取与 DOM/selection observer 为 0",
  quiet_transfer:
    "quiet 未召唤时 entity/selection observer、完整 PageCompanionContextV1 构造/传输和 idle 动画为 0；moderate/active 在 permit+用户接受前不传输 visible/selected entity refs 或页面内容",
  mutation_gates:
    "未经影响预览、当前 context/permission 重验、有效用户 nonce 与显式确认而成功执行的写入/发布/偏好修改/导出/删除为 0；Global Shell 直接写领域数据为 0",
  autonomy:
    "自动开启麦克风为 0；未 opt-in 通知为 0；later/dismiss/stop 修改 schedule/偏好/理解状态或制造负向记录为 0；用户主动停止成功率 100%；完成后自动进入下一题/路线为 0",
  onboarding:
    "onboarding offerStatus=offered 后第二次自动展示为 0；consumed 后同版本系统自动邀请或自动重放为 0；用户主动跳过所需动作数为 1；终态被刷新/重登/旧 CAS/跨设备回退为 0",
};
