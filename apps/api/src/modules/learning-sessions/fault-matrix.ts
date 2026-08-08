/**
 * 任务 08-3：故障矩阵演练（§17.2，阶段 08 W7）。
 *
 * 本文件是故障矩阵演练的**互斥纯函数层 + 可注入演练端口编排**：
 * - `FaultSpec` / `FAULT_MATRIX`：§17.2 表格 22 项故障的预期行为契约
 *   （expected: failClosed | exactlyOnce | degrade | recover | noSideEffect）
 *   及每条可验证断言（check 为纯函数，读标准化 `FaultObservations`）；
 * - `FaultDrillPort`：演练场景端口——由集成层/测试注入「在某故障条件下运行
 *   一次场景」的实现，返回可观察事实；本模块不接触真实系统；
 * - `judgeDrill` / `judgeFaultAcrossRuns`：结果判定（pass/fail，纯函数）；
 * - `runMatrixDrill` / `evaluateMatrixDrill`：演练编排与汇总报告；
 *   hard invariant（`FaultSpec.hardInvariant`）任何一项任何一次重复运行违反
 *   → `rollbackEvaluationRequired = true`（立即回滚评估标志）。
 *
 * 关于「23 行 / 23 项」：§17.2 表格实际为 22 项故障 + 表头 1 行 = 23 行
 * （任务文本「23 行表格」「23 项故障」对应表格总行数含表头）。本矩阵严格
 * 按规范 22 项故障建立契约，与 08-w7 阶段退出 Gate（故障矩阵全部演练通过
 * 并留档）一一对应。
 *
 * hard invariant 判定准则（违反 → 立即回滚评估）：
 * - H1 安全/隐私边界：认证页 fail closed、跨租户拒绝、stale token 拒绝；
 * - H2 学习副作用：未确认/未展示输入不得成为理解/掌握结论，无 mastery/
 *   schedule 写入，hidden/off 后零状态写入；
 * - H3 权威结果一致性：commit/publish 恰好一次、未接管设备提交为 0、
 *   断线/崩溃不重复 Provider 与 commit、终态不回退；
 * - H4 恢复可信度：hard kill 后不写可恢复 staging，隐私事故后禁止 trusted 恢复。
 *
 * 关联契约（既有模块）：06-2 episode-commit（commitKey 幂等 / 单次 CAS）、
 * 06-4 race-rollback（runtime epoch / late response after hard kill /
 * disconnect recovery）、04-5 redaction、03-6 policies、07-4 presence-control、
 * 07-8 cross-device-recovery、01-4 冻结记录。
 */

// ─── 预期行为类型 ─────────────────────────────────────────────────────────

export type ExpectedBehavior =
  | "failClosed"
  | "exactlyOnce"
  | "degrade"
  | "recover"
  | "noSideEffect";

export const FAULT_MATRIX_VERSION = "fault-matrix-v1" as const;

// ─── 故障 ID（§17.2 表格 22 项）──────────────────────────────────────────

export const FaultId = {
  GLOBAL_SHELL_FAILURE: "global_shell_failure",
  AUTH_SURFACE_MANIFEST_INVALID: "auth_surface_manifest_invalid",
  STALE_PAGE_CONTEXT_TOKEN: "stale_page_context_token",
  ONBOARDING_INTERRUPT: "onboarding_interrupt",
  MULTI_DEVICE_RECOVERY: "multi_device_recovery",
  HIDDEN_OFF_LATE_RESPONSE: "hidden_off_late_response",
  ASR_TIMEOUT: "asr_timeout",
  SUPERVISOR_CRASH: "supervisor_crash",
  CRITIC_UNAVAILABLE: "critic_unavailable",
  FORMAL_BUDGET_UNAVAILABLE: "formal_budget_unavailable",
  BUDGET_INCIDENT_AFTER_LOCK: "budget_incident_after_lock",
  TUTOR_UNAVAILABLE: "tutor_unavailable",
  DUPLICATE_TOOL_RESPONSE: "duplicate_tool_response",
  CONTENT_UPDATE: "content_update",
  CANCEL_DISCONNECT: "cancel_disconnect",
  RAW_AUDIO_FAILURE: "raw_audio_failure",
  VECTOR_RETRIEVAL_FAILURE: "vector_retrieval_failure",
  STAR_OVERLAY_FAILURE: "star_overlay_failure",
  CROSS_TENANT_FORGED_ID: "cross_tenant_forged_id",
  PUBLISH_COMMIT_RESPONSE_LOSS: "publish_commit_response_loss",
  PRIVACY_HARD_INCIDENT: "privacy_hard_incident",
  LATE_RESULT_AFTER_KILL: "late_result_after_kill",
} as const;
export type FaultId = (typeof FaultId)[keyof typeof FaultId];

// ─── 标准化可观察事实（演练场景返回）────────────────────────────────────

/**
 * 一次故障演练的可观察事实（纯数据）。所有字段布尔，默认全部为 false
 * （「什么都没发生」）；集成层/测试按故障契约置 true。
 */
export interface FaultObservations {
  // Global Shell / 角色资源失败
  coreLoadedFirst: boolean;
  staticFallbackProvided: boolean;
  primaryTaskBlocked: boolean;
  // auth-surface manifest 无效 / cross-tenant / stale token（安全面）
  authPageWithoutCompanion: boolean;
  modelGeneratedHelpUsed: boolean;
  formRead: boolean;
  actionAccepted: boolean;
  securityEventRecorded: boolean;
  contextPurgedAndRefreshed: boolean;
  bypassedUnsavedWorkspacePermission: boolean;
  // onboarding 中断
  confirmedStepsPersisted: boolean;
  recoveredFromLegalStepOrigin: boolean;
  consumedOfferRolledBack: boolean;
  offerAutoReplayed: boolean;
  // 多设备恢复
  takeoverOrReadonlyChosen: boolean;
  unclaimedDeviceCommitted: boolean;
  // hidden/off 后 late response
  rendered: boolean;
  stateWritten: boolean;
  followUpJobTriggered: boolean;
  lockedCoreContractViolated: boolean;
  // ASR timeout
  transcriptConfirmed: boolean;
  assessmentMarkedNotAssessable: boolean;
  retryOrModalSwitchAllowed: boolean;
  // Supervisor crash
  recoveredFromPersistedSources: boolean;
  replayedLockedInput: boolean;
  // Critic unavailable
  evaluationMarkedRetryable: boolean;
  supervisorSubstitutedEvaluation: boolean;
  // formal budget unavailable / budget incident after lock
  sceneShown: boolean;
  answerCollected: boolean;
  nonPenalizingPathOffered: boolean;
  reservedEnvelopeUsedOrQueueEnqueued: boolean;
  markedOperationalOnly: boolean;
  // Tutor unavailable
  trustedMainChainCompleted: boolean;
  extraQuestionsDeferrable: boolean;
  // duplicate tool/response
  artifactDuplicated: boolean;
  sideEffectRepeated: boolean;
  // Card/Key Point/Evidence 更新
  episodeMarkedStale: boolean;
  historyPreserved: boolean;
  masteryOrScheduleWritten: boolean;
  // cancel/断线
  persistedEventsRestored: boolean;
  providerCallRepeated: boolean;
  commitRepeated: boolean;
  // raw audio storage failure
  voiceLockStoppedBeforeConfirm: boolean;
  retryOrSilentBundleAllowed: boolean;
  canonicalTranscriptPreserved: boolean;
  // vector/retrieval failure
  publishedExactEvidenceUsed: boolean;
  shouldSearchLayerOff: boolean;
  sourceFabricatedOrWidened: boolean;
  // star overlay failure
  staticRouteFallbackRendered: boolean;
  understandingCoreUntouched: boolean;
  // publish/commit 响应丢失
  sameCanonicalResultPersisted: boolean;
  sameSchedulePersisted: boolean;
  // privacy/trust/scheduler hard incident
  runtimeEpochBumped: boolean;
  uncommittedEpisodesFenced: boolean;
  outstandingExternalJobsCancelled: boolean;
  trustedRestored: boolean;
  // late result after hard kill
  lowSensitivityAuditWritten: boolean;
  recoveryStagingWritten: boolean;
  // 通用学习副作用（ASR / budget incident 共用）
  learningSideEffectWritten: boolean;
}

/** 全 false 的观察（工厂）：演练/测试以此为基础按需覆盖。 */
export function emptyObservations(): FaultObservations {
  return {
    coreLoadedFirst: false,
    staticFallbackProvided: false,
    primaryTaskBlocked: false,
    authPageWithoutCompanion: false,
    modelGeneratedHelpUsed: false,
    formRead: false,
    actionAccepted: false,
    securityEventRecorded: false,
    contextPurgedAndRefreshed: false,
    bypassedUnsavedWorkspacePermission: false,
    confirmedStepsPersisted: false,
    recoveredFromLegalStepOrigin: false,
    consumedOfferRolledBack: false,
    offerAutoReplayed: false,
    takeoverOrReadonlyChosen: false,
    unclaimedDeviceCommitted: false,
    rendered: false,
    stateWritten: false,
    followUpJobTriggered: false,
    lockedCoreContractViolated: false,
    transcriptConfirmed: false,
    assessmentMarkedNotAssessable: false,
    retryOrModalSwitchAllowed: false,
    recoveredFromPersistedSources: false,
    replayedLockedInput: false,
    evaluationMarkedRetryable: false,
    supervisorSubstitutedEvaluation: false,
    sceneShown: false,
    answerCollected: false,
    nonPenalizingPathOffered: false,
    reservedEnvelopeUsedOrQueueEnqueued: false,
    markedOperationalOnly: false,
    trustedMainChainCompleted: false,
    extraQuestionsDeferrable: false,
    artifactDuplicated: false,
    sideEffectRepeated: false,
    episodeMarkedStale: false,
    historyPreserved: false,
    masteryOrScheduleWritten: false,
    persistedEventsRestored: false,
    providerCallRepeated: false,
    commitRepeated: false,
    voiceLockStoppedBeforeConfirm: false,
    retryOrSilentBundleAllowed: false,
    canonicalTranscriptPreserved: false,
    publishedExactEvidenceUsed: false,
    shouldSearchLayerOff: false,
    sourceFabricatedOrWidened: false,
    staticRouteFallbackRendered: false,
    understandingCoreUntouched: false,
    sameCanonicalResultPersisted: false,
    sameSchedulePersisted: false,
    runtimeEpochBumped: false,
    uncommittedEpisodesFenced: false,
    outstandingExternalJobsCancelled: false,
    trustedRestored: false,
    lowSensitivityAuditWritten: false,
    recoveryStagingWritten: false,
    learningSideEffectWritten: false,
  };
}

// ─── 断言与故障契约 ──────────────────────────────────────────────────────

export interface FaultAssertion {
  /** 断言 ID（fault 内唯一） */
  id: string;
  /** 人类可读断言描述（中文，§17.2 预期行为的可验证片段） */
  description: string;
  /** 判定谓词（纯函数）：读观察事实返回是否满足 */
  check: (obs: FaultObservations) => boolean;
}

export interface FaultSpec {
  id: FaultId;
  /** §17.2 表格故障名 */
  title: string;
  /** 预期行为主类型 */
  expected: ExpectedBehavior;
  /** hard invariant：违反 → 立即回滚评估 */
  hardInvariant: boolean;
  /** §17.2 表格预期行为原文 */
  contract: string;
  /** 该故障下必须全部满足的断言 */
  assertions: readonly FaultAssertion[];
}

// ─── 故障矩阵（§17.2 表格 22 项）────────────────────────────────────────

export const FAULT_MATRIX: readonly FaultSpec[] = [
  {
    id: FaultId.GLOBAL_SHELL_FAILURE,
    title: "Global Shell/角色资源失败",
    expected: "degrade",
    hardInvariant: false,
    contract:
      "页面、认证和全部手动功能先加载；降级为静态帮助或完全不显示，不阻塞主任务",
    assertions: [
      {
        id: "core_loaded_first",
        description: "页面/认证/全部手动功能先加载",
        check: (o) => o.coreLoadedFirst,
      },
      {
        id: "static_fallback",
        description: "降级为静态帮助或完全不显示",
        check: (o) => o.staticFallbackProvided,
      },
      {
        id: "no_primary_block",
        description: "不阻塞主任务",
        check: (o) => !o.primaryTaskBlocked,
      },
    ],
  },
  {
    id: FaultId.AUTH_SURFACE_MANIFEST_INVALID,
    title: "auth-surface manifest 无效",
    expected: "failClosed",
    hardInvariant: true,
    contract:
      "fail closed 为无伴星的标准认证页；不得改用模型生成帮助或读取表单",
    assertions: [
      {
        id: "fail_closed_auth_page",
        description: "fail closed 为无伴星的标准认证页",
        check: (o) => o.authPageWithoutCompanion,
      },
      {
        id: "no_model_help",
        description: "不得改用模型生成帮助",
        check: (o) => !o.modelGeneratedHelpUsed,
      },
      {
        id: "no_form_read",
        description: "不得读取表单",
        check: (o) => !o.formRead,
      },
    ],
  },
  {
    id: FaultId.STALE_PAGE_CONTEXT_TOKEN,
    title: "page context/action token stale",
    expected: "failClosed",
    hardInvariant: true,
    contract:
      "拒绝动作，刷新净化上下文；未保存内容、workspace 和权限状态不被绕过",
    assertions: [
      {
        id: "action_rejected",
        description: "拒绝动作",
        check: (o) => !o.actionAccepted,
      },
      {
        id: "context_purged",
        description: "刷新净化上下文",
        check: (o) => o.contextPurgedAndRefreshed,
      },
      {
        id: "no_unsaved_bypass",
        description: "未保存内容/workspace/权限状态不被绕过",
        check: (o) => !o.bypassedUnsavedWorkspacePermission,
      },
    ],
  },
  {
    id: FaultId.ONBOARDING_INTERRUPT,
    title: "onboarding 中断/登录过期",
    expected: "recover",
    hardInvariant: true,
    contract:
      "保存已确认步骤；重新认证后只用 scoped token + revision CAS 从合法 step/origin 恢复，offer consumed 不回退或被系统主动重放",
    assertions: [
      {
        id: "confirmed_steps_saved",
        description: "保存已确认步骤",
        check: (o) => o.confirmedStepsPersisted,
      },
      {
        id: "legal_origin_recovery",
        description: "只用 scoped token + revision CAS 从合法 step/origin 恢复",
        check: (o) => o.recoveredFromLegalStepOrigin,
      },
      {
        id: "no_consumed_rollback",
        description: "offer consumed 不回退",
        check: (o) => !o.consumedOfferRolledBack,
      },
      {
        id: "no_auto_replay",
        description: "不被系统主动重放",
        check: (o) => !o.offerAutoReplayed,
      },
    ],
  },
  {
    id: FaultId.MULTI_DEVICE_RECOVERY,
    title: "多设备同时恢复同一 Session",
    expected: "recover",
    hardInvariant: true,
    contract: "后进入设备明确选择接管或只读；未接管设备不能提交",
    assertions: [
      {
        id: "explicit_takeover_or_readonly",
        description: "后进入设备明确选择接管或只读",
        check: (o) => o.takeoverOrReadonlyChosen,
      },
      {
        id: "no_unclaimed_commit",
        description: "未接管设备不能提交",
        check: (o) => !o.unclaimedDeviceCommitted,
      },
    ],
  },
  {
    id: FaultId.HIDDEN_OFF_LATE_RESPONSE,
    title: "hidden/off 后 Companion late response",
    expected: "noSideEffect",
    hardInvariant: true,
    contract:
      "丢弃且不渲染、不写状态、不触发后续 job；必要的 locked formal core 只按原 contract 完成",
    assertions: [
      {
        id: "not_rendered",
        description: "丢弃且不渲染",
        check: (o) => !o.rendered,
      },
      {
        id: "no_state_write",
        description: "不写状态",
        check: (o) => !o.stateWritten,
      },
      {
        id: "no_followup_job",
        description: "不触发后续 job",
        check: (o) => !o.followUpJobTriggered,
      },
      {
        id: "locked_core_contract",
        description: "必要的 locked formal core 只按原 contract 完成",
        check: (o) => !o.lockedCoreContractViolated,
      },
    ],
  },
  {
    id: FaultId.ASR_TIMEOUT,
    title: "ASR timeout/low confidence",
    expected: "degrade",
    hardInvariant: true,
    contract:
      "transcript 未确认，not_assessable；允许重录/换模态，无理解副作用",
    assertions: [
      {
        id: "transcript_unconfirmed",
        description: "transcript 未确认",
        check: (o) => !o.transcriptConfirmed,
      },
      {
        id: "marked_not_assessable",
        description: "标记 not_assessable",
        check: (o) => o.assessmentMarkedNotAssessable,
      },
      {
        id: "retry_or_modal_allowed",
        description: "允许重录/换模态",
        check: (o) => o.retryOrModalSwitchAllowed,
      },
      {
        id: "no_learning_side_effect",
        description: "无理解副作用",
        check: (o) => !o.learningSideEffectWritten,
      },
    ],
  },
  {
    id: FaultId.SUPERVISOR_CRASH,
    title: "Session Supervisor crash",
    expected: "recover",
    hardInvariant: true,
    contract: "从 contract/probe/artifact/event 恢复，不重做已锁输入",
    assertions: [
      {
        id: "recovered_from_persisted",
        description: "从 contract/probe/artifact/event 恢复",
        check: (o) => o.recoveredFromPersistedSources,
      },
      {
        id: "no_locked_replay",
        description: "不重做已锁输入",
        check: (o) => !o.replayedLockedInput,
      },
    ],
  },
  {
    id: FaultId.CRITIC_UNAVAILABLE,
    title: "Critic unavailable",
    expected: "degrade",
    hardInvariant: false,
    contract: "evaluation_retryable，不由 Supervisor 替代",
    assertions: [
      {
        id: "evaluation_retryable",
        description: "评估标记 evaluation_retryable",
        check: (o) => o.evaluationMarkedRetryable,
      },
      {
        id: "no_supervisor_substitute",
        description: "不由 Supervisor 替代",
        check: (o) => !o.supervisorSubstitutedEvaluation,
      },
    ],
  },
  {
    id: FaultId.FORMAL_BUDGET_UNAVAILABLE,
    title: "formal budget unavailable before start",
    expected: "degrade",
    hardInvariant: true,
    contract: "不展示 Scene、不收回答，给出非惩罚稍后/换 practice 路径",
    assertions: [
      {
        id: "no_scene",
        description: "不展示 Scene",
        check: (o) => !o.sceneShown,
      },
      {
        id: "no_answer_collected",
        description: "不收回答",
        check: (o) => !o.answerCollected,
      },
      {
        id: "non_penalizing_path",
        description: "给出非惩罚稍后/换 practice 路径",
        check: (o) => o.nonPenalizingPathOffered,
      },
    ],
  },
  {
    id: FaultId.BUDGET_INCIDENT_AFTER_LOCK,
    title: "budget/Provider incident after answer lock",
    expected: "noSideEffect",
    hardInvariant: true,
    contract:
      "使用预留 envelope 或进入有 SLA 的 recovery queue；超时 operational-only，0 学习副作用",
    assertions: [
      {
        id: "envelope_or_queue",
        description: "使用预留 envelope 或进入有 SLA 的 recovery queue",
        check: (o) => o.reservedEnvelopeUsedOrQueueEnqueued,
      },
      {
        id: "operational_only",
        description: "超时标记 operational-only",
        check: (o) => o.markedOperationalOnly,
      },
      {
        id: "no_learning_side_effect",
        description: "0 学习副作用",
        check: (o) => !o.learningSideEffectWritten,
      },
    ],
  },
  {
    id: FaultId.TUTOR_UNAVAILABLE,
    title: "Grounded Tutor unavailable",
    expected: "degrade",
    hardInvariant: false,
    contract: "trusted 主链仍可完成，额外问题可稍后恢复",
    assertions: [
      {
        id: "trusted_main_chain",
        description: "trusted 主链仍可完成",
        check: (o) => o.trustedMainChainCompleted,
      },
      {
        id: "extra_questions_deferred",
        description: "额外问题可稍后恢复",
        check: (o) => o.extraQuestionsDeferrable,
      },
    ],
  },
  {
    id: FaultId.DUPLICATE_TOOL_RESPONSE,
    title: "duplicate tool/response",
    expected: "exactlyOnce",
    hardInvariant: true,
    contract: "artifact 与副作用 exactly-once",
    assertions: [
      {
        id: "artifact_not_duplicated",
        description: "artifact 不重复创建",
        check: (o) => !o.artifactDuplicated,
      },
      {
        id: "side_effects_once",
        description: "副作用 exactly-once",
        check: (o) => !o.sideEffectRepeated,
      },
    ],
  },
  {
    id: FaultId.CONTENT_UPDATE,
    title: "Card/Key Point/Evidence 更新",
    expected: "noSideEffect",
    hardInvariant: true,
    contract: "对应未提交 Episode stale，保留历史，无 mastery/schedule 写入",
    assertions: [
      {
        id: "episode_stale",
        description: "对应未提交 Episode 标记 stale",
        check: (o) => o.episodeMarkedStale,
      },
      {
        id: "history_preserved",
        description: "保留历史",
        check: (o) => o.historyPreserved,
      },
      {
        id: "no_mastery_schedule_write",
        description: "无 mastery/schedule 写入",
        check: (o) => !o.masteryOrScheduleWritten,
      },
    ],
  },
  {
    id: FaultId.CANCEL_DISCONNECT,
    title: "cancel/断线",
    expected: "recover",
    hardInvariant: true,
    contract: "持久化事件恢复，不重复 Provider 和 commit",
    assertions: [
      {
        id: "events_restored",
        description: "持久化事件恢复",
        check: (o) => o.persistedEventsRestored,
      },
      {
        id: "no_provider_repeat",
        description: "不重复 Provider",
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
    id: FaultId.RAW_AUDIO_FAILURE,
    title: "raw audio storage failure",
    expected: "degrade",
    hardInvariant: true,
    contract:
      "transcript 确认前停止 voice lock，可重录或走 silent bundle；确认后 raw audio 丢失不影响 canonical transcript/outcome",
    assertions: [
      {
        id: "voice_lock_stopped",
        description: "transcript 确认前停止 voice lock",
        check: (o) => o.voiceLockStoppedBeforeConfirm,
      },
      {
        id: "retry_or_silent_bundle",
        description: "可重录或走 silent bundle",
        check: (o) => o.retryOrSilentBundleAllowed,
      },
      {
        id: "canonical_preserved",
        description: "确认后 raw audio 丢失不影响 canonical transcript/outcome",
        check: (o) => o.canonicalTranscriptPreserved,
      },
    ],
  },
  {
    id: FaultId.VECTOR_RETRIEVAL_FAILURE,
    title: "vector/retrieval failure",
    expected: "degrade",
    hardInvariant: true,
    contract:
      "当前-target Tutor 直接用 published exact evidence；Should 搜索层关闭，不扩大或伪造来源",
    assertions: [
      {
        id: "published_exact_evidence",
        description: "当前-target Tutor 直接用 published exact evidence",
        check: (o) => o.publishedExactEvidenceUsed,
      },
      {
        id: "should_search_off",
        description: "Should 搜索层关闭",
        check: (o) => o.shouldSearchLayerOff,
      },
      {
        id: "no_source_fabrication",
        description: "不扩大或伪造来源",
        check: (o) => !o.sourceFabricatedOrWidened,
      },
    ],
  },
  {
    id: FaultId.STAR_OVERLAY_FAILURE,
    title: "star overlay failure",
    expected: "degrade",
    hardInvariant: false,
    contract: "静态路线卡/列表回退，理解内核不受影响",
    assertions: [
      {
        id: "static_route_fallback",
        description: "静态路线卡/列表回退",
        check: (o) => o.staticRouteFallbackRendered,
      },
      {
        id: "understanding_core_intact",
        description: "理解内核不受影响",
        check: (o) => o.understandingCoreUntouched,
      },
    ],
  },
  {
    id: FaultId.CROSS_TENANT_FORGED_ID,
    title: "cross-tenant/forged ID",
    expected: "failClosed",
    hardInvariant: true,
    contract: "拒绝并记录安全事件",
    assertions: [
      {
        id: "request_rejected",
        description: "拒绝请求",
        check: (o) => !o.actionAccepted,
      },
      {
        id: "security_event_recorded",
        description: "记录安全事件",
        check: (o) => o.securityEventRecorded,
      },
    ],
  },
  {
    id: FaultId.PUBLISH_COMMIT_RESPONSE_LOSS,
    title: "publish/commit 响应丢失",
    expected: "exactlyOnce",
    hardInvariant: true,
    contract: "同一 canonical result 和 schedule，0 重复副作用",
    assertions: [
      {
        id: "same_canonical_result",
        description: "同一 canonical result 落库",
        check: (o) => o.sameCanonicalResultPersisted,
      },
      {
        id: "same_schedule",
        description: "同一 schedule 落库",
        check: (o) => o.sameSchedulePersisted,
      },
      {
        id: "no_repeated_side_effect",
        description: "0 重复副作用",
        check: (o) => !o.sideEffectRepeated,
      },
    ],
  },
  {
    id: FaultId.PRIVACY_HARD_INCIDENT,
    title: "privacy/trust/scheduler hard incident",
    expected: "failClosed",
    hardInvariant: true,
    contract:
      "bump runtime epoch、fence 全部未 commit Episode、取消未完成外部 job，禁止 trusted 恢复",
    assertions: [
      {
        id: "epoch_bumped",
        description: "bump runtime epoch",
        check: (o) => o.runtimeEpochBumped,
      },
      {
        id: "episodes_fenced",
        description: "fence 全部未 commit Episode",
        check: (o) => o.uncommittedEpisodesFenced,
      },
      {
        id: "external_jobs_cancelled",
        description: "取消未完成外部 job",
        check: (o) => o.outstandingExternalJobsCancelled,
      },
      {
        id: "no_trusted_restore",
        description: "禁止 trusted 恢复",
        check: (o) => !o.trustedRestored,
      },
    ],
  },
  {
    id: FaultId.LATE_RESULT_AFTER_KILL,
    title: "late result after hard kill",
    expected: "noSideEffect",
    hardInvariant: true,
    contract: "仅低敏审计摘要，不写可恢复 probe/artifact/assessment staging",
    assertions: [
      {
        id: "low_sensitivity_audit_only",
        description: "仅低敏审计摘要",
        check: (o) => o.lowSensitivityAuditWritten,
      },
      {
        id: "no_recovery_staging",
        description: "不写可恢复 probe/artifact/assessment staging",
        check: (o) => !o.recoveryStagingWritten,
      },
    ],
  },
];

// ─── 演练端口与运行 ──────────────────────────────────────────────────────

/**
 * 演练场景端口：注入「在某故障条件下运行一次场景」的实现。
 * 契约：对同一 faultId 的重复调用必须可重复（同一观察结果），
 * 以便演练可重复执行；实现不得越过本矩阵直接写领域数据。
 */
export interface FaultDrillPort {
  run(faultId: FaultId): FaultObservations;
}

export interface FaultDrillRun {
  faultId: FaultId;
  /** 重复执行序号（0 起） */
  runIndex: number;
  observations: FaultObservations;
}

// ─── 结果判定（纯函数）──────────────────────────────────────────────────

export interface AssertionResult {
  assertionId: string;
  description: string;
  passed: boolean;
}

export interface FaultDrillVerdict {
  faultId: FaultId;
  passed: boolean;
  assertionResults: readonly AssertionResult[];
  failedAssertionIds: readonly string[];
}

/** 单次运行判定：所有断言满足则 pass（纯函数）。 */
export function judgeDrill(
  spec: FaultSpec,
  observations: FaultObservations,
): FaultDrillVerdict {
  const assertionResults: AssertionResult[] = spec.assertions.map((a) => ({
    assertionId: a.id,
    description: a.description,
    passed: a.check(observations),
  }));
  const failedAssertionIds = assertionResults
    .filter((r) => !r.passed)
    .map((r) => r.assertionId);
  return {
    faultId: spec.id,
    passed: failedAssertionIds.length === 0,
    assertionResults,
    failedAssertionIds,
  };
}

/** 一个故障跨多次重复运行的判定：任何一次运行违反 → 该项 fail。 */
export function judgeFaultAcrossRuns(
  spec: FaultSpec,
  runs: readonly FaultObservations[],
  runsPerFault: number,
): {
  passed: boolean;
  verdicts: readonly FaultDrillVerdict[];
  /** runs 数不足 runsPerFault 时的缺失数（0 = 无缺测；security_review MEDIUM 修复）。 */
  missingRuns?: number;
} {
  const verdicts = runs.map((o) => judgeDrill(spec, o));
  // security_review MEDIUM 修复：缺测不得静默通过——`[].every()` 对空 runs 恒 true
  // 会架空「hard invariant 100%」语义；runs 数不足 → 显式 fail。
  const missingRuns = runsPerFault - runs.length;
  const passed = missingRuns === 0 && verdicts.every((v) => v.passed);
  return {
    passed,
    verdicts,
    ...(missingRuns > 0 ? { missingRuns } : {}),
  };
}

// ─── 编排与汇总报告 ─────────────────────────────────────────────────────

export interface FaultPerFaultReport {
  fault: FaultSpec;
  passed: boolean;
  verdicts: readonly FaultDrillVerdict[];
  failedAssertionIds: readonly string[];
}

export interface FaultMatrixReport {
  /** 矩阵故障总数（22） */
  matrixTotal: number;
  /** 每项重复执行次数 */
  runsPerFault: number;
  perFault: readonly FaultPerFaultReport[];
  passedCount: number;
  failedFaultIds: readonly string[];
  /** hard invariant 统计 */
  hardInvariantTotal: number;
  hardInvariantPassedCount: number;
  hardInvariantViolatedIds: readonly string[];
  /** hard invariant 100% 通过 */
  hardInvariants100Percent: boolean;
  /** 全部 22 项演练通过 */
  allPassed: boolean;
  /** 任何 hard invariant 违反 → 立即回滚评估 */
  rollbackEvaluationRequired: boolean;
}

/**
 * 汇总：遍历所有故障与所有重复运行，逐项判定并计算 hard invariant
 * 通过率与回滚评估标志（纯函数）。
 */
export function evaluateMatrixDrill(
  matrix: readonly FaultSpec[],
  runs: readonly FaultDrillRun[],
  runsPerFault: number,
): FaultMatrixReport {
  const perFault: FaultPerFaultReport[] = matrix.map((spec) => {
    const specRuns = runs.filter((r) => r.faultId === spec.id);
    const { passed, verdicts } = judgeFaultAcrossRuns(
      spec,
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

  const failedFaultIds = perFault
    .filter((p) => !p.passed)
    .map((p) => p.fault.id);
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
    hardInvariantPassedCount:
      hardInvariantFaults.length - hardInvariantViolatedIds.length,
    hardInvariantViolatedIds,
    hardInvariants100Percent: hardInvariantViolatedIds.length === 0,
    allPassed: failedFaultIds.length === 0,
    rollbackEvaluationRequired: hardInvariantViolatedIds.length > 0,
  };
}

/**
 * 完整演练执行器：对矩阵每项故障重复执行 `runsPerFault` 次（默认 3），
 * 判定并返回报告。重复执行保证关键 crash/retry/cancel/stale/并发场景
 * 的 hard invariant 100% 通过；任何违反置 rollbackEvaluationRequired。
 */
export function runMatrixDrill(
  port: FaultDrillPort,
  runsPerFault = 3,
  matrix: readonly FaultSpec[] = FAULT_MATRIX,
): { runs: readonly FaultDrillRun[]; report: FaultMatrixReport } {
  const runs: FaultDrillRun[] = [];
  for (const spec of matrix) {
    for (let i = 0; i < runsPerFault; i++) {
      runs.push({ faultId: spec.id, runIndex: i, observations: port.run(spec.id) });
    }
  }
  return { runs, report: evaluateMatrixDrill(matrix, runs, runsPerFault) };
}
