/**
 * 任务 09-5：故障注入与降级 RC（§17.2，阶段 09 W8）。
 *
 * 本文件是故障注入 RC 的**互斥纯函数层 + 可注入演练端口**（无 DB / 无网络 /
 * 无时钟 / 无副作用 / 无随机），把任务 09-5 与冻结记录 01-5 §16.6 / §17.2 的
 * 验收要求翻译成确定性校验函数：
 * - **RC 故障注入矩阵**（`RC_FAULT_MATRIX`，11 项）：100/1K/5K 节点星图、
 *   并发 Session、ASR / LLM / 对象存储故障注入、全局壳对首屏/路由性能影响、
 *   跨设备恢复、登录过期、Companion 全故障降级——每项声明 expected 行为、
 *   hard invariant 与可验证断言，通过注入端口重复执行判定；
 * - **crash/retry/cancel/stale/rollback 重复执行**（`REPEATED_SCENARIOS`，
 *   5 项）：每次执行都必须满足 hard invariant，任何一次违反 →
 *   `rollbackEvaluationRequired = true`；
 * - **router 与 `CompanionPageCoverageRegistryV1` 100% 对账**（07-2 语义本地
 *   复刻：方向 A 真实路由全覆盖，方向 B registry 具体页面都被真实路由命中）；
 * - **重试放大系数上限**（§16.6）：同一 provider/job attempt 重复计费调用 0；
 *   重试放大系数 = 计费调用 / 唯一请求，上限 W0 冻结（默认 1.5）由本 RC 故障
 *   注入验证；
 * - **recovery queue SLA**（§16.6）：已锁答案使用预留额度完成评估；Provider
 *   故障进入有 W0 冻结 SLA 的 recovery queue，不能因后续预算耗尽永久卡在
 *   retryable；超出 SLA 后以 operational failure 结束且 0 学习副作用。
 *
 * 关于 hard invariant 判定准则（违反 → 立即回滚评估），与 08-3 fault-matrix 同源：
 * - H1 安全/隐私边界：认证页 fail closed、跨租户拒绝、stale/过期 token 拒绝；
 * - H2 学习副作用：未确认/未展示输入不得成为理解/掌握结论，故障路径 0 学习副作用；
 * - H3 权威结果一致性：commit/publish 恰好一次、未接管设备提交为 0、
 *   断线/崩溃不重复 Provider 与 commit、终态不回退；
 * - H4 恢复可信度：hard kill 后不写可恢复 staging。
 *
 * SLA/上限均为 W0 冻结口径默认值并接受注入——RC 校准 W0 阈值只改常量/注入值，
 * 不改变判定逻辑（与 08-5 `GLOBAL_OFF_PROPAGATION_SLA_MS` 的处理一致）。
 *
 * 关联契约（既有模块）：08-3 fault-matrix（judgeDrill / runMatrixDrill 编排
 * 模式）、07-2 page-coverage-registry（router 对账与 `matchesRoutePattern`）、
 * 08-4 observability（重试放大系数与成本 Gate）、06-4 race-rollback、
 * 03-6 policies（budget/recovery queue 语义）。
 */

// ─── 版本 ─────────────────────────────────────────────────────────────────

export const RC_FAULT_INJECTION_VERSION = "fault-injection-rc-v1" as const;

// ─── 预期行为类型（与 08-3 fault-matrix 同语义）──────────────────────────

export type RcExpectedBehavior =
  | "failClosed"
  | "exactlyOnce"
  | "degrade"
  | "recover"
  | "noSideEffect";

// ─── RC 故障注入矩阵 ID（09-5，11 项）────────────────────────────────────

export const RcFaultId = {
  STAR_MAP_100: "star_map_100_nodes",
  STAR_MAP_1000: "star_map_1000_nodes",
  STAR_MAP_5000: "star_map_5000_nodes",
  CONCURRENT_SESSIONS: "concurrent_sessions",
  ASR_FAILURE: "asr_failure",
  LLM_FAILURE: "llm_failure",
  OBJECT_STORAGE_FAILURE: "object_storage_failure",
  GLOBAL_SHELL_PERF_IMPACT: "global_shell_perf_impact",
  CROSS_DEVICE_RECOVERY: "cross_device_recovery",
  LOGIN_EXPIRY: "login_expiry",
  COMPANION_TOTAL_FAILURE: "companion_total_failure",
} as const;
export type RcFaultId = (typeof RcFaultId)[keyof typeof RcFaultId];

// ─── 标准化可观察事实（注入端口返回）────────────────────────────────────

/**
 * 一次故障注入演练的可观察事实（纯数据）。字段默认全部为 false（「什么都没
 * 发生」）；集成层/测试按故障契约置 true。
 */
export interface RcFaultObservations {
  // 星图（100/1K/5K 节点）
  staticRouteFallbackRendered: boolean; // 静态路线卡/列表回退
  understandingCoreUntouched: boolean; // 理解内核不受影响
  injectedNodeScaleRespected: boolean; // 按注入节点规模降级/渲染
  // 并发 Session
  sessionIsolationPreserved: boolean; // 会话隔离
  exactlyOncePerSession: boolean; // 每会话 commit/Provider exactly-once
  crossSessionLeak: boolean; // 跨会话泄漏
  // ASR 故障
  assessmentMarkedNotAssessable: boolean; // 关键内容不可辨 → not_assessable
  retryOrModalSwitchAllowed: boolean; // 可重录/换模态
  // LLM 故障
  evaluationMarkedRetryable: boolean; // evaluation_retryable
  supervisorSubstituted: boolean; // Supervisor 替代评估
  trustedMainChainCompleted: boolean; // trusted 主链仍可完成
  // 对象存储故障
  voiceLockStoppedBeforeConfirm: boolean; // 确认前停止 voice lock
  retryOrSilentBundleAllowed: boolean; // 可重录/silent bundle
  canonicalTranscriptPreserved: boolean; // 确认后 canonical 不受影响
  // 全局壳对首屏/路由性能影响
  authNotBlocked: boolean; // 不阻塞认证
  primaryContentNotBlocked: boolean; // 不阻塞页面主内容
  shellPerfWithinBudget: boolean; // 首屏/路由性能在预算内
  // 跨设备恢复
  takeoverOrReadonlyChosen: boolean; // 显式接管或只读
  unclaimedDeviceCommitted: boolean; // 未接管设备提交
  recoveredStateConsistent: boolean; // 恢复状态一致
  // 登录过期
  actionRejected: boolean; // 过期 token 动作被拒绝
  loginPrompted: boolean; // 提示重新登录
  // Companion 全故障降级
  manualPathUsable: boolean; // 手动主路径可用
  noProviderCostAfterFailure: boolean; // 故障后零 Provider 成本
  noStateWrittenAfterFailure: boolean; // 故障后零状态写入
  // crash（Supervisor crash）
  recoveredFromPersisted: boolean; // 从持久化源恢复
  lockedInputReplayed: boolean; // 重做已锁输入
  providerCallRepeated: boolean; // 重复 Provider 调用
  commitRepeated: boolean; // 重复 commit
  // retry（重试/重复响应）
  duplicateBilledCall: boolean; // 同一 provider/job attempt 重复计费调用
  idempotentResult: boolean; // 幂等结果
  sideEffectRepeated: boolean; // 重复副作用
  // cancel（取消/断线）
  cancelConfirmed: boolean; // 取消被服务端确认
  newProviderCallAfterCancel: boolean; // 取消确认后新增 Provider 调用
  // stale（stale action / 内容更新）
  staleActionRejected: boolean; // stale 动作被拒绝
  // rollback（回滚/partial commit）
  rollbackApplied: boolean; // 回滚已应用
  partialStateRemaining: boolean; // 残留 partial 状态
  // 通用学习副作用
  learningSideEffectWritten: boolean; // 学习副作用写入（mastery/schedule/artifact）
}

/** 全 false 的观察（工厂）：演练/测试以此为基础按需覆盖。 */
export function emptyRcObservations(): RcFaultObservations {
  return {
    staticRouteFallbackRendered: false,
    understandingCoreUntouched: false,
    injectedNodeScaleRespected: false,
    sessionIsolationPreserved: false,
    exactlyOncePerSession: false,
    crossSessionLeak: false,
    assessmentMarkedNotAssessable: false,
    retryOrModalSwitchAllowed: false,
    evaluationMarkedRetryable: false,
    supervisorSubstituted: false,
    trustedMainChainCompleted: false,
    voiceLockStoppedBeforeConfirm: false,
    retryOrSilentBundleAllowed: false,
    canonicalTranscriptPreserved: false,
    authNotBlocked: false,
    primaryContentNotBlocked: false,
    shellPerfWithinBudget: false,
    takeoverOrReadonlyChosen: false,
    unclaimedDeviceCommitted: false,
    recoveredStateConsistent: false,
    actionRejected: false,
    loginPrompted: false,
    manualPathUsable: false,
    noProviderCostAfterFailure: false,
    noStateWrittenAfterFailure: false,
    recoveredFromPersisted: false,
    lockedInputReplayed: false,
    providerCallRepeated: false,
    commitRepeated: false,
    duplicateBilledCall: false,
    idempotentResult: false,
    sideEffectRepeated: false,
    cancelConfirmed: false,
    newProviderCallAfterCancel: false,
    staleActionRejected: false,
    rollbackApplied: false,
    partialStateRemaining: false,
    learningSideEffectWritten: false,
  };
}

// ─── 断言与契约 ──────────────────────────────────────────────────────────

export interface RcFaultAssertion {
  /** 断言 ID（fault 内唯一）。 */
  id: string;
  /** 人类可读断言描述（中文，§17.2 预期行为的可验证片段）。 */
  description: string;
  /** 判定谓词（纯函数）：读观察事实返回是否满足。 */
  check: (obs: RcFaultObservations) => boolean;
}

export interface RcFaultSpec {
  id: RcFaultId;
  /** 故障注入项名。 */
  title: string;
  /** 预期行为主类型。 */
  expected: RcExpectedBehavior;
  /** hard invariant：违反 → 立即回滚评估。 */
  hardInvariant: boolean;
  /** 预期行为契约原文（09-5 / §17.2）。 */
  contract: string;
  /** 该故障下必须全部满足的断言。 */
  assertions: readonly RcFaultAssertion[];
}

// ─── RC 故障注入矩阵（09-5，11 项）───────────────────────────────────────

export const RC_FAULT_MATRIX: readonly RcFaultSpec[] = [
  {
    id: RcFaultId.STAR_MAP_100,
    title: "星图故障注入（100 节点）",
    expected: "degrade",
    hardInvariant: false,
    contract:
      "100 节点星图在渲染/事件故障下降级为静态路线卡/列表；理解内核不受影响；按注入节点规模降级",
    assertions: [
      {
        id: "static_fallback",
        description: "静态路线卡/列表回退",
        check: (o) => o.staticRouteFallbackRendered,
      },
      {
        id: "core_intact",
        description: "理解内核不受影响",
        check: (o) => o.understandingCoreUntouched,
      },
      {
        id: "node_scale_respected",
        description: "按注入节点规模降级",
        check: (o) => o.injectedNodeScaleRespected,
      },
    ],
  },
  {
    id: RcFaultId.STAR_MAP_1000,
    title: "星图故障注入（1,000 节点）",
    expected: "degrade",
    hardInvariant: false,
    contract:
      "1,000 节点星图在渲染/事件故障下降级为静态路线卡/列表；理解内核不受影响；按注入节点规模降级",
    assertions: [
      {
        id: "static_fallback",
        description: "静态路线卡/列表回退",
        check: (o) => o.staticRouteFallbackRendered,
      },
      {
        id: "core_intact",
        description: "理解内核不受影响",
        check: (o) => o.understandingCoreUntouched,
      },
      {
        id: "node_scale_respected",
        description: "按注入节点规模降级",
        check: (o) => o.injectedNodeScaleRespected,
      },
    ],
  },
  {
    id: RcFaultId.STAR_MAP_5000,
    title: "星图故障注入（5,000 节点）",
    expected: "degrade",
    hardInvariant: false,
    contract:
      "5,000 节点星图在渲染/事件故障下降级为静态路线卡/列表；理解内核不受影响；按注入节点规模降级",
    assertions: [
      {
        id: "static_fallback",
        description: "静态路线卡/列表回退",
        check: (o) => o.staticRouteFallbackRendered,
      },
      {
        id: "core_intact",
        description: "理解内核不受影响",
        check: (o) => o.understandingCoreUntouched,
      },
      {
        id: "node_scale_respected",
        description: "按注入节点规模降级",
        check: (o) => o.injectedNodeScaleRespected,
      },
    ],
  },
  {
    id: RcFaultId.CONCURRENT_SESSIONS,
    title: "并发 Session 故障注入",
    expected: "recover",
    hardInvariant: true,
    contract:
      "并发 Session 隔离正确、无跨会话泄漏；每 Session 的 Provider/commit 恰好一次（H3）",
    assertions: [
      {
        id: "isolation_preserved",
        description: "会话隔离正确",
        check: (o) => o.sessionIsolationPreserved,
      },
      {
        id: "no_cross_session_leak",
        description: "无跨会话泄漏",
        check: (o) => !o.crossSessionLeak,
      },
      {
        id: "exactly_once_per_session",
        description: "每 Session commit/Provider exactly-once",
        check: (o) => o.exactlyOncePerSession,
      },
    ],
  },
  {
    id: RcFaultId.ASR_FAILURE,
    title: "ASR 故障注入",
    expected: "degrade",
    hardInvariant: true,
    contract:
      "ASR 故障 → 关键内容不可辨进入 not_assessable；可重录/换模态；无学习副作用（H2）",
    assertions: [
      {
        id: "not_assessable",
        description: "关键内容不可辨 → not_assessable",
        check: (o) => o.assessmentMarkedNotAssessable,
      },
      {
        id: "retry_or_modal_switch",
        description: "可重录/换模态",
        check: (o) => o.retryOrModalSwitchAllowed,
      },
      {
        id: "no_learning_side_effect",
        description: "无学习副作用",
        check: (o) => !o.learningSideEffectWritten,
      },
    ],
  },
  {
    id: RcFaultId.LLM_FAILURE,
    title: "LLM 故障注入",
    expected: "degrade",
    hardInvariant: false,
    contract:
      "LLM 故障 → evaluation_retryable，不由 Supervisor 替代评估；trusted 主链仍可完成",
    assertions: [
      {
        id: "evaluation_retryable",
        description: "evaluation_retryable",
        check: (o) => o.evaluationMarkedRetryable,
      },
      {
        id: "no_supervisor_substitute",
        description: "不由 Supervisor 替代评估",
        check: (o) => !o.supervisorSubstituted,
      },
      {
        id: "trusted_main_chain",
        description: "trusted 主链仍可完成",
        check: (o) => o.trustedMainChainCompleted,
      },
    ],
  },
  {
    id: RcFaultId.OBJECT_STORAGE_FAILURE,
    title: "对象存储故障注入",
    expected: "degrade",
    hardInvariant: true,
    contract:
      "对象存储故障 → 确认前停止 voice lock、可重录/silent bundle；确认后 canonical transcript/outcome 不受影响（H2）",
    assertions: [
      {
        id: "voice_lock_stopped",
        description: "确认前停止 voice lock",
        check: (o) => o.voiceLockStoppedBeforeConfirm,
      },
      {
        id: "retry_or_silent_bundle",
        description: "可重录或走 silent bundle",
        check: (o) => o.retryOrSilentBundleAllowed,
      },
      {
        id: "canonical_preserved",
        description: "确认后 canonical 不受影响",
        check: (o) => o.canonicalTranscriptPreserved,
      },
    ],
  },
  {
    id: RcFaultId.GLOBAL_SHELL_PERF_IMPACT,
    title: "全局壳对首屏/路由性能影响",
    expected: "degrade",
    hardInvariant: false,
    contract:
      "Global Shell、auth-surface manifest 和安静锚点不阻塞认证或页面主内容；首屏/路由性能在预算内（超限优先降级角色而不是延迟主页面）",
    assertions: [
      {
        id: "auth_not_blocked",
        description: "不阻塞认证",
        check: (o) => o.authNotBlocked,
      },
      {
        id: "primary_content_not_blocked",
        description: "不阻塞页面主内容",
        check: (o) => o.primaryContentNotBlocked,
      },
      {
        id: "perf_within_budget",
        description: "首屏/路由性能在预算内",
        check: (o) => o.shellPerfWithinBudget,
      },
    ],
  },
  {
    id: RcFaultId.CROSS_DEVICE_RECOVERY,
    title: "跨设备恢复故障注入",
    expected: "recover",
    hardInvariant: true,
    contract:
      "跨设备恢复：后进入设备显式选择接管/只读；未接管设备提交为 0；恢复状态一致（H3）",
    assertions: [
      {
        id: "takeover_or_readonly",
        description: "显式接管或只读",
        check: (o) => o.takeoverOrReadonlyChosen,
      },
      {
        id: "unclaimed_commit_zero",
        description: "未接管设备提交为 0",
        check: (o) => !o.unclaimedDeviceCommitted,
      },
      {
        id: "recovered_state_consistent",
        description: "恢复状态一致",
        check: (o) => o.recoveredStateConsistent,
      },
    ],
  },
  {
    id: RcFaultId.LOGIN_EXPIRY,
    title: "登录过期故障注入",
    expected: "failClosed",
    hardInvariant: true,
    contract:
      "登录过期 → 拒绝动作并提示重新登录；无学习副作用、无 Provider 调用（H1/H2）",
    assertions: [
      {
        id: "action_rejected",
        description: "过期 token 动作被拒绝",
        check: (o) => o.actionRejected,
      },
      {
        id: "login_prompted",
        description: "提示重新登录",
        check: (o) => o.loginPrompted,
      },
      {
        id: "no_learning_side_effect",
        description: "无学习副作用",
        check: (o) => !o.learningSideEffectWritten,
      },
    ],
  },
  {
    id: RcFaultId.COMPANION_TOTAL_FAILURE,
    title: "Companion 全故障降级",
    expected: "degrade",
    hardInvariant: false,
    contract:
      "Companion 全故障 → 同页面手动主路径可完成率 100%；零 Provider 成本；零状态写入",
    assertions: [
      {
        id: "manual_path_usable",
        description: "同页面手动主路径可完成",
        check: (o) => o.manualPathUsable,
      },
      {
        id: "zero_provider_cost",
        description: "故障后零 Provider 成本",
        check: (o) => o.noProviderCostAfterFailure,
      },
      {
        id: "zero_state_write",
        description: "故障后零状态写入",
        check: (o) => o.noStateWrittenAfterFailure,
      },
    ],
  },
];

// ─── crash/retry/cancel/stale/rollback 重复执行场景（09-5）────────────────

export const RepeatedScenarioId = {
  CRASH: "crash",
  RETRY: "retry",
  CANCEL: "cancel",
  STALE: "stale",
  ROLLBACK: "rollback",
} as const;
export type RepeatedScenarioId = (typeof RepeatedScenarioId)[keyof typeof RepeatedScenarioId];

export interface RepeatedScenarioSpec {
  id: RepeatedScenarioId;
  title: string;
  contract: string;
  assertions: readonly RcFaultAssertion[];
}

/**
 * crash/retry/cancel/stale/rollback 五类重复执行场景（§16.1 硬指标「重复
 * job/tool/commit 产生重复副作用：0」与 §17.1 必测行为收口）。每类场景的
 * 断言必须在其每次重复执行中 100% 通过，任何一次违反 → 立即回滚评估。
 */
export const REPEATED_SCENARIOS: readonly RepeatedScenarioSpec[] = [
  {
    id: RepeatedScenarioId.CRASH,
    title: "Session Supervisor crash 重复执行",
    contract: "从持久化源恢复，不重做已锁输入，不重复 Provider 调用与 commit（H3）",
    assertions: [
      {
        id: "recovered_from_persisted",
        description: "从持久化源恢复",
        check: (o) => o.recoveredFromPersisted,
      },
      {
        id: "no_locked_input_replay",
        description: "不重做已锁输入",
        check: (o) => !o.lockedInputReplayed,
      },
      {
        id: "no_provider_repeat",
        description: "不重复 Provider 调用",
        check: (o) => !o.providerCallRepeated,
      },
      {
        id: "no_commit_repeat",
        description: "不重复 commit",
        check: (o) => !o.commitRepeated,
      },
    ],
  },
  {
    id: RepeatedScenarioId.RETRY,
    title: "retry/重复响应 重复执行",
    contract: "同一 provider/job attempt 重复计费调用 0；幂等结果；0 重复副作用（H3）",
    assertions: [
      {
        id: "no_duplicate_billed_call",
        description: "同一 provider/job attempt 重复计费调用 0",
        check: (o) => !o.duplicateBilledCall,
      },
      {
        id: "idempotent_result",
        description: "幂等结果",
        check: (o) => o.idempotentResult,
      },
      {
        id: "no_side_effect_repeat",
        description: "0 重复副作用",
        check: (o) => !o.sideEffectRepeated,
      },
    ],
  },
  {
    id: RepeatedScenarioId.CANCEL,
    title: "cancel/断线 重复执行",
    contract: "取消被服务端确认后新增 Provider 调用 0；0 学习副作用（H2/H3）",
    assertions: [
      {
        id: "cancel_confirmed",
        description: "取消被服务端确认",
        check: (o) => o.cancelConfirmed,
      },
      {
        id: "no_provider_after_cancel",
        description: "取消确认后新增 Provider 调用 0",
        check: (o) => !o.newProviderCallAfterCancel,
      },
      {
        id: "no_learning_side_effect",
        description: "0 学习副作用",
        check: (o) => !o.learningSideEffectWritten,
      },
    ],
  },
  {
    id: RepeatedScenarioId.STALE,
    title: "stale action 重复执行",
    contract: "stale action/token 被拒绝；0 学习副作用（H1/H2）",
    assertions: [
      {
        id: "stale_rejected",
        description: "stale 动作被拒绝",
        check: (o) => o.staleActionRejected,
      },
      {
        id: "no_learning_side_effect",
        description: "0 学习副作用",
        check: (o) => !o.learningSideEffectWritten,
      },
    ],
  },
  {
    id: RepeatedScenarioId.ROLLBACK,
    title: "rollback/partial commit 重复执行",
    contract: "回滚已应用且无残留 partial 状态；不重复 commit；0 学习副作用（H3）",
    assertions: [
      {
        id: "rollback_applied",
        description: "回滚已应用",
        check: (o) => o.rollbackApplied,
      },
      {
        id: "no_partial_state",
        description: "无残留 partial 状态",
        check: (o) => !o.partialStateRemaining,
      },
      {
        id: "no_commit_repeat",
        description: "不重复 commit",
        check: (o) => !o.commitRepeated,
      },
      {
        id: "no_learning_side_effect",
        description: "0 学习副作用",
        check: (o) => !o.learningSideEffectWritten,
      },
    ],
  },
];

// ─── 结果判定（纯函数）───────────────────────────────────────────────────

export interface RcAssertionResult {
  assertionId: string;
  description: string;
  passed: boolean;
}

export interface RcDrillVerdict {
  id: string;
  passed: boolean;
  assertionResults: readonly RcAssertionResult[];
  failedAssertionIds: readonly string[];
}

/** 单次运行判定：所有断言满足则 pass（纯函数）。 */
export function judgeRcDrill(
  id: string,
  assertions: readonly RcFaultAssertion[],
  observations: RcFaultObservations,
): RcDrillVerdict {
  const assertionResults: RcAssertionResult[] = assertions.map((a) => ({
    assertionId: a.id,
    description: a.description,
    passed: a.check(observations),
  }));
  const failedAssertionIds = assertionResults
    .filter((r) => !r.passed)
    .map((r) => r.assertionId);
  return {
    id,
    passed: failedAssertionIds.length === 0,
    assertionResults,
    failedAssertionIds,
  };
}

/** 一个故障跨多次重复运行的判定：任何一次运行违反 → 该项 fail。 */
export function judgeRcAcrossRuns(
  id: string,
  assertions: readonly RcFaultAssertion[],
  runs: readonly RcFaultObservations[],
  runsPerFault: number,
): { passed: boolean; verdicts: readonly RcDrillVerdict[]; missingRuns?: number } {
  const verdicts = runs.map((o) => judgeRcDrill(id, assertions, o));
  // 缺测不得静默通过（[].every() 对空 runs 恒 true 会架空 hard invariant 语义）。
  const missingRuns = runsPerFault - runs.length;
  const passed = missingRuns === 0 && verdicts.every((v) => v.passed);
  return { passed, verdicts, ...(missingRuns > 0 ? { missingRuns } : {}) };
}

// ─── 注入端口与编排 ──────────────────────────────────────────────────────

/** 演练场景端口：注入「在某故障条件下运行一次场景」的实现（可重复）。 */
export interface RcFaultDrillPort {
  run(faultId: RcFaultId): RcFaultObservations;
}

/** 重复执行场景端口。 */
export interface RepeatedScenarioPort {
  run(scenarioId: RepeatedScenarioId): RcFaultObservations;
}

export interface RcFaultDrillRun {
  faultId: RcFaultId;
  runIndex: number;
  observations: RcFaultObservations;
}

export interface RcPerFaultReport {
  fault: RcFaultSpec;
  passed: boolean;
  verdicts: readonly RcDrillVerdict[];
  failedAssertionIds: readonly string[];
}

export interface RcMatrixReport {
  matrixTotal: number;
  runsPerFault: number;
  perFault: readonly RcPerFaultReport[];
  passedCount: number;
  failedFaultIds: readonly string[];
  hardInvariantTotal: number;
  hardInvariantPassedCount: number;
  hardInvariantViolatedIds: readonly string[];
  hardInvariants100Percent: boolean;
  allPassed: boolean;
  /** 任何 hard invariant 违反 → 立即回滚评估。 */
  rollbackEvaluationRequired: boolean;
}

/** 汇总：遍历全部故障与全部重复运行，计算 hard invariant 通过率（纯函数）。 */
export function evaluateRcMatrixDrill(
  matrix: readonly RcFaultSpec[],
  runs: readonly RcFaultDrillRun[],
  runsPerFault: number,
): RcMatrixReport {
  const perFault: RcPerFaultReport[] = matrix.map((spec) => {
    const specRuns = runs.filter((r) => r.faultId === spec.id);
    const { passed, verdicts } = judgeRcAcrossRuns(
      spec.id,
      spec.assertions,
      specRuns.map((r) => r.observations),
      runsPerFault,
    );
    return {
      fault: spec,
      passed,
      verdicts,
      failedAssertionIds: verdicts.flatMap((v) => v.failedAssertionIds),
    };
  });

  const failedFaultIds = perFault.filter((p) => !p.passed).map((p) => p.fault.id);
  const hardInvariantFaults = matrix.filter((s) => s.hardInvariant);
  const hardInvariantViolatedIds = perFault
    .filter((p) => p.fault.hardInvariant && !p.passed)
    .map((p) => p.fault.id);

  return {
    matrixTotal: matrix.length,
    runsPerFault,
    perFault,
    passedCount: perFault.filter((p) => p.passed).length,
    failedFaultIds,
    hardInvariantTotal: hardInvariantFaults.length,
    hardInvariantPassedCount: hardInvariantFaults.length - hardInvariantViolatedIds.length,
    hardInvariantViolatedIds,
    hardInvariants100Percent: hardInvariantViolatedIds.length === 0,
    allPassed: failedFaultIds.length === 0,
    rollbackEvaluationRequired: hardInvariantViolatedIds.length > 0,
  };
}

/** 完整矩阵演练执行器：对每项故障重复执行 `runsPerFault` 次（默认 5）。 */
export function runRcMatrixDrill(
  port: RcFaultDrillPort,
  runsPerFault = 5,
  matrix: readonly RcFaultSpec[] = RC_FAULT_MATRIX,
): { runs: readonly RcFaultDrillRun[]; report: RcMatrixReport } {
  const runs: RcFaultDrillRun[] = [];
  for (const spec of matrix) {
    for (let i = 0; i < runsPerFault; i++) {
      runs.push({ faultId: spec.id, runIndex: i, observations: port.run(spec.id) });
    }
  }
  return { runs, report: evaluateRcMatrixDrill(matrix, runs, runsPerFault) };
}

export interface RepeatedScenarioReport {
  scenarioTotal: number;
  runsPerScenario: number;
  perScenario: readonly {
    scenario: RepeatedScenarioSpec;
    passed: boolean;
    verdicts: readonly RcDrillVerdict[];
    failedAssertionIds: readonly string[];
  }[];
  allPassed: boolean;
  /** 任何一次重复执行违反任何 hard invariant → 立即回滚评估。 */
  rollbackEvaluationRequired: boolean;
}

/** crash/retry/cancel/stale/rollback 重复执行：hard invariant 100% 判定。 */
export function runRepeatedHardInvariantScenarios(
  port: RepeatedScenarioPort,
  runsPerScenario = 5,
  scenarios: readonly RepeatedScenarioSpec[] = REPEATED_SCENARIOS,
): RepeatedScenarioReport {
  const perScenario = scenarios.map((scenario) => {
    const observations = Array.from({ length: runsPerScenario }, () => port.run(scenario.id));
    const { passed, verdicts } = judgeRcAcrossRuns(
      scenario.id,
      scenario.assertions,
      observations,
      runsPerScenario,
    );
    return {
      scenario,
      passed,
      verdicts,
      failedAssertionIds: verdicts.flatMap((v) => v.failedAssertionIds),
    };
  });
  const allPassed = perScenario.every((p) => p.passed);
  return {
    scenarioTotal: scenarios.length,
    runsPerScenario,
    perScenario,
    allPassed,
    rollbackEvaluationRequired: !allPassed,
  };
}

// ─── router 与 CompanionPageCoverageRegistryV1 100% 对账（07-2）───────────

/**
 * 路由模式匹配（07-2 `matchesRoutePattern` 语义本地复刻）：`:name` 匹配单个
 * 路径段，无通配符；忽略 route group。真实路由展开时 `[param]` 已转 `:param`。
 */
export function matchesRoutePattern(pattern: string, pathname: string): boolean {
  if (pattern === pathname) return true;
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every(
    (segment, index) => segment.startsWith(":") || segment === pathSegments[index],
  );
}

/** 对账用 entry 的最小结构（本模块不 import web 侧文件，保持独立可测）。 */
export interface RouterCoverageEntryLite {
  routePattern: string;
  /** 无自动化覆盖时的手动测试兜底 ID（有兜底的 entry 不要求命中真实路由）。 */
  manualFallbackTestId?: string;
}

/** router 与 coverage registry 对账输入。 */
export interface RouterCoverageReconciliation {
  /** apps/web/app 下展开的真实路由模式（`[param]` 已转 `:param`）。 */
  actualRoutePatterns: readonly string[];
  /** `CompanionPageCoverageRegistryV1` 的全部 entry。 */
  registryEntries: readonly RouterCoverageEntryLite[];
}

/**
 * router 与 `CompanionPageCoverageRegistryV1` 100% 对账（07-2）：
 * - 方向 A：每个真实路由必须被至少一个 entry 覆盖（未分类 → 违规）；
 * - 方向 B：registry 中无 `manualFallbackTestId` 的具体 entry 必须命中真实路由。
 */
export function checkRouterCoverageReconciliation(
  rec: RouterCoverageReconciliation,
): readonly string[] {
  const problems: string[] = [];
  for (const route of rec.actualRoutePatterns) {
    if (!rec.registryEntries.some((entry) => matchesRoutePattern(entry.routePattern, route))) {
      problems.push(`未分类路由（${route}）：未被 CompanionPageCoverageRegistryV1 覆盖`);
    }
  }
  for (const entry of rec.registryEntries) {
    if (entry.manualFallbackTestId) continue;
    const covered = rec.actualRoutePatterns.some((route) =>
      matchesRoutePattern(entry.routePattern, route),
    );
    if (!covered) {
      problems.push(
        `registry 声明了无手动兜底的具体页面但路由不存在（${entry.routePattern}）`,
      );
    }
  }
  return problems;
}

// ─── 重试放大系数上限（§16.6）────────────────────────────────────────────

/** 一次计费调用记录（去重 key = provider + jobAttemptId）。 */
export interface BilledCallRecord {
  /** Provider 名（如 "llm" / "asr" / "tts" / "object_storage"）。 */
  provider: string;
  /** job attempt 唯一键（同一 provider 下同一 job attempt 只允许计费 1 次）。 */
  jobAttemptId: string;
  /** 该 (provider, jobAttemptId) 上发生的计费调用次数。 */
  billedCount: number;
}

/**
 * §16.6 硬 Gate：同一 provider/job attempt 的重复计费调用必须为 0。
 * 任一 (provider, jobAttemptId) 计费次数 > 1 → 违规。
 */
export function checkNoDuplicateBilledCalls(
  records: readonly BilledCallRecord[],
): readonly string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const record of records) {
    if (record.billedCount < 0) {
      problems.push(`billedCount 为负（${record.provider}/${record.jobAttemptId}）`);
      continue;
    }
    if (record.billedCount > 1) {
      const key = `${record.provider}/${record.jobAttemptId}`;
      problems.push(
        `同一 provider/job attempt 重复计费调用 ${record.billedCount} 次（${key}），必须为 0 重复`,
      );
      continue;
    }
    const key = `${record.provider}/${record.jobAttemptId}`;
    if (seen.has(key)) {
      problems.push(`重复的计费记录键（${key}）：同一 attempt 出现多条记录`);
    }
    seen.set(key, (seen.get(key) ?? 0) + record.billedCount);
  }
  return problems;
}

/** 重试放大系数 = 计费调用数 / 唯一请求数（§16.6）。唯一请求为 0 时确定性返回 0。 */
export function computeRetryAmplification(uniqueRequests: number, billedCalls: number): number {
  if (
    !Number.isFinite(uniqueRequests) ||
    !Number.isFinite(billedCalls) ||
    uniqueRequests <= 0 ||
    billedCalls < 0
  ) {
    return 0;
  }
  return billedCalls / uniqueRequests;
}

/** 重试放大系数默认上限（W0 冻结口径，01-5 §16.6；与 08-4 同源）。 */
export const DEFAULT_RETRY_AMPLIFICATION_CAP = 1.5;

/** §16.6 硬 Gate：重试放大系数必须 ≤ 冻结上限（越限 → 违规）。 */
export function checkRetryAmplificationCap(
  uniqueRequests: number,
  billedCalls: number,
  cap = DEFAULT_RETRY_AMPLIFICATION_CAP,
): readonly string[] {
  const factor = computeRetryAmplification(uniqueRequests, billedCalls);
  if (factor > cap) {
    return [
      `重试放大系数 ${factor.toFixed(3)} 超过冻结上限 ${cap}（unique=${uniqueRequests}, billed=${billedCalls}）`,
    ];
  }
  return [];
}

// ─── recovery queue SLA（§16.6）──────────────────────────────────────────

/**
 * recovery queue SLA 默认值（W0 冻结口径；01-5 §16.6「Provider 故障进入有 W0
 * 冻结 SLA 的 recovery queue」未给具体毫秒值，本记录按 W0 冻结口径定义默认
 * 5 分钟——与 08-5 `GLOBAL_OFF_PROPAGATION_SLA_MS` 处理一致；CI 校准只改常量）。
 */
export const RECOVERY_QUEUE_SLA_MS = 300_000;

/** recovery queue job 的终结/进行中状态。 */
export type RecoveryJobOutcome =
  | "evaluated" // 已用预留额度/恢复完成评估
  | "operational_failure" // 超出 SLA，以 operational failure 结束
  | "retryable" // 仍在 SLA 内的可重试状态
  | "pending"; // 排队中

/** recovery queue 中的单个 job 快照（含时钟由调用方注入）。 */
export interface RecoveryQueueJob {
  jobId: string;
  /** Provider 类型（llm/asr/critic/object_storage/tutor）。 */
  provider: "llm" | "asr" | "critic" | "object_storage" | "tutor";
  /** 是否已锁答案（已锁答案必须用预留额度完成评估，不能中途放弃）。 */
  lockedAnswer: boolean;
  /** 预留额度是否足以完成评估。 */
  reservedEnvelopeSufficient: boolean;
  /** 进入 recovery queue 的时间（ms，调用方时钟）。 */
  enqueuedAtMs: number;
  /** 当前时间（ms，调用方时钟）。 */
  nowMs: number;
  /** 当前是否处于 retryable 状态。 */
  retryable: boolean;
  /** 后续预算是否已耗尽。 */
  budgetExhausted: boolean;
  /** 当前 outcome。 */
  outcome: RecoveryJobOutcome;
  /** 学习副作用计数（mastery/schedule/artifact 写入）。 */
  learningSideEffects: number;
}

/**
 * §16.6：已锁答案必须使用预留额度完成评估。
 * `lockedAnswer && reservedEnvelopeSufficient` 时 outcome 必须为 `evaluated`
 * （不得停在 pending/retryable，更不得因预算耗尽转 operational_failure）。
 */
export function checkLockedAnswerUsesReservedEnvelope(
  job: RecoveryQueueJob,
): readonly string[] {
  if (!job.lockedAnswer || !job.reservedEnvelopeSufficient) return [];
  const problems: string[] = [];
  if (job.outcome !== "evaluated") {
    problems.push(
      `job ${job.jobId}：已锁答案且预留额度充足，outcome 必须为 evaluated（实际 ${job.outcome}）`,
    );
  }
  if (job.learningSideEffects !== 0) {
    problems.push(`job ${job.jobId}：已锁答案评估产生学习副作用 ${job.learningSideEffects}`);
  }
  return problems;
}

/**
 * §16.6：recovery queue SLA。超 SLA 仍 retryable → 违规（不得永久卡在
 * retryable）；超 SLA 后必须以 operational failure 结束。
 */
export function checkRecoveryQueueSla(
  job: RecoveryQueueJob,
  slaMs = RECOVERY_QUEUE_SLA_MS,
): readonly string[] {
  const problems: string[] = [];
  const elapsed = job.nowMs - job.enqueuedAtMs;
  if (elapsed < 0) {
    problems.push(`job ${job.jobId}：时钟异常（nowMs < enqueuedAtMs）`);
    return problems;
  }
  if (job.retryable && elapsed > slaMs) {
    problems.push(
      `job ${job.jobId}：超过 SLA ${slaMs}ms 仍处于 retryable（已等待 ${elapsed}ms），不得永久卡在 retryable`,
    );
  }
  if (elapsed > slaMs && job.outcome !== "operational_failure" && job.outcome !== "evaluated") {
    problems.push(
      `job ${job.jobId}：超过 SLA ${slaMs}ms 后 outcome 必须为 operational failure（实际 ${job.outcome}）`,
    );
  }
  return problems;
}

/**
 * §16.6：不得因后续预算耗尽永久卡在 retryable。
 * `budgetExhausted && retryable` 在 SLA 内允许（Provider 恢复中），但一旦超过
 * SLA 仍未结束 → 违规；正确行为是超 SLA 以 operational failure 收尾。
 */
export function checkRecoveryNoBudgetDeadlock(
  job: RecoveryQueueJob,
  slaMs = RECOVERY_QUEUE_SLA_MS,
): readonly string[] {
  if (!job.budgetExhausted) return [];
  const elapsed = job.nowMs - job.enqueuedAtMs;
  if (job.retryable && elapsed > slaMs) {
    return [
      `job ${job.jobId}：预算耗尽且超过 SLA ${slaMs}ms 仍卡在 retryable（已等待 ${elapsed}ms），因预算耗尽永久卡死`,
    ];
  }
  return [];
}

/**
 * §16.6：以 operational failure 结束的 job 必须 0 学习副作用。
 * （超出 SLA 的 provider 故障不能把未确认/未展示输入变成理解/掌握结论。）
 */
export function checkOperationalFailureZeroSideEffects(
  job: RecoveryQueueJob,
): readonly string[] {
  if (job.outcome !== "operational_failure") return [];
  if (job.learningSideEffects !== 0) {
    return [
      `job ${job.jobId}：operational failure 产生学习副作用 ${job.learningSideEffects}，必须为 0`,
    ];
  }
  return [];
}

/** recovery queue 全量校验（SLA + 预留额度 + 预算死锁 + 0 副作用）。 */
export function checkRecoveryQueuePolicy(
  job: RecoveryQueueJob,
  slaMs = RECOVERY_QUEUE_SLA_MS,
): readonly string[] {
  return [
    ...checkLockedAnswerUsesReservedEnvelope(job),
    ...checkRecoveryQueueSla(job, slaMs),
    ...checkRecoveryNoBudgetDeadlock(job, slaMs),
    ...checkOperationalFailureZeroSideEffects(job),
  ];
}

// ─── 汇总报告 ────────────────────────────────────────────────────────────

/** 故障注入 RC 全量汇总报告。 */
export interface FaultInjectionRcReport {
  version: typeof RC_FAULT_INJECTION_VERSION;
  matrix: RcMatrixReport;
  repeatedScenarios: RepeatedScenarioReport;
  routerReconciliationViolations: readonly string[];
  retryAmplificationViolations: readonly string[];
  recoveryQueueViolations: readonly string[];
  /** 全部故障注入、重复执行、对账、重试放大、recovery SLA 通过。 */
  allPassed: boolean;
  /** 任何 hard invariant 违反 → 立即回滚评估。 */
  rollbackEvaluationRequired: boolean;
}

/** 故障注入 RC 输入（由 RC harness 注入；本模块只做确定性判定）。 */
export interface FaultInjectionRcInput {
  /** RC 故障注入矩阵演练（每项默认重复 5 次）。 */
  matrix: { runs: readonly RcFaultDrillRun[]; runsPerFault: number };
  /** crash/retry/cancel/stale/rollback 重复执行（每类默认 5 次）。 */
  repeatedScenarios: { observations: readonly (readonly RcFaultObservations[])[] };
  /** router 与 coverage registry 对账。 */
  routerReconciliation: RouterCoverageReconciliation;
  /** 重试放大验证。 */
  retryAmplification: { uniqueRequests: number; billedCalls: number; records: readonly BilledCallRecord[] };
  /** recovery queue job 快照列表。 */
  recoveryQueueJobs: readonly RecoveryQueueJob[];
}

/** 汇总判定：故障矩阵 + 重复执行 + 对账 + 重试放大 + recovery SLA。 */
export function evaluateFaultInjectionRc(input: FaultInjectionRcInput): FaultInjectionRcReport {
  const matrix = evaluateRcMatrixDrill(
    RC_FAULT_MATRIX,
    input.matrix.runs,
    input.matrix.runsPerFault,
  );

  const perScenario = REPEATED_SCENARIOS.map((scenario, index) => {
    const observations = input.repeatedScenarios.observations[index] ?? [];
    const { passed, verdicts } = judgeRcAcrossRuns(
      scenario.id,
      scenario.assertions,
      observations,
      observations.length,
    );
    return {
      scenario,
      passed,
      verdicts,
      failedAssertionIds: verdicts.flatMap((v) => v.failedAssertionIds),
    };
  });
  const repeatedScenarios: RepeatedScenarioReport = {
    scenarioTotal: REPEATED_SCENARIOS.length,
    runsPerScenario: perScenario[0]?.verdicts.length ?? 0,
    perScenario,
    allPassed: perScenario.every((p) => p.passed),
    rollbackEvaluationRequired: !perScenario.every((p) => p.passed),
  };

  const routerReconciliationViolations = checkRouterCoverageReconciliation(
    input.routerReconciliation,
  );
  const retryAmplificationViolations = [
    ...checkNoDuplicateBilledCalls(input.retryAmplification.records),
    ...checkRetryAmplificationCap(
      input.retryAmplification.uniqueRequests,
      input.retryAmplification.billedCalls,
    ),
  ];
  const recoveryQueueViolations = input.recoveryQueueJobs.flatMap((job) =>
    checkRecoveryQueuePolicy(job),
  );

  const allPassed =
    matrix.allPassed &&
    repeatedScenarios.allPassed &&
    routerReconciliationViolations.length === 0 &&
    retryAmplificationViolations.length === 0 &&
    recoveryQueueViolations.length === 0;

  return {
    version: RC_FAULT_INJECTION_VERSION,
    matrix,
    repeatedScenarios,
    routerReconciliationViolations,
    retryAmplificationViolations,
    recoveryQueueViolations,
    allPassed,
    rollbackEvaluationRequired:
      matrix.rollbackEvaluationRequired || repeatedScenarios.rollbackEvaluationRequired,
  };
}
