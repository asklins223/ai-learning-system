/**
 * 任务 09-7：硬不变量与必测行为收口（§16.1 / §17.1，阶段 09 W8）。
 *
 * 本文件是硬不变量收口的**互斥纯函数层**（无 DB / 无网络 / 无副作用 / 无随机）：
 * - `HARD_INVARIANTS_16_1`：§16.1 全部 22 项硬指标清单与判定——19 项 0 容忍
 *   （`tolerance: "zero"`）+ 3 项 100% 要求（`tolerance: "percent100"`），
 *   逐项来自冻结记录 01-5 §2，每项带 `frozenText` 原文、`mapsTo` 证据链映射
 *   与一组真实断言（`HardInvariantAssertion`，读 `Section161Observations`）；
 * - `MUST_TEST_BEHAVIORS_17_1`：§17.1 全部 35 条必测行为清单与判定，
 *   逐条来自冻结记录 01-6 §2，每条带断言（读 `Section171Observations`）；
 * - `evaluateHardInvariant` / `evaluateMustTestBehavior`：单条判定（纯函数，
 *   全部断言满足才 pass，fail closed）；
 * - `detectFakePass`：**无 placeholder / skip / insufficient-data 伪通过检查**。
 *   用 Proxy 在运行时观测每条断言实际读取的观察字段：
 *   - 断言列表为空 → `placeholder`（空实现占位）；
 *   - `requires` 未声明或声明字段未被判定实际读取 → `insufficient-data`；
 *   - 判定未读取任何观察字段 → `skip`（恒真占位，无条件通过）；
 * - `runHardInvariantCloseout`：收口编排，汇总全部硬指标/必测行为/伪通过
 *   并给出 `summary.allClosed`（全部关闭）与 `rollbackEvaluationRequired`；
 * - `assertHardInvariantCloseout`：0 容忍 fail closed，未关闭即抛
 *   `HardInvariantCloseoutFailure`（CI / 接线层在收口检查点调用）。
 *
 * 确定性保证：所有判定基于注入的观察记录做穷举匹配，无时钟/随机/顺序依赖；
 * 测试对每项硬指标与必测行为提供「干净样本全 pass + 违规样本必 fail」双断言，
 * 证明每项都不是恒真/空实现。
 *
 * 关联契约（既有模块，只读复用语义，不越过它们写领域数据）：
 * 02-9 canonical-events（replayProjection / computeProjectionHash / driftCheck，
 * 支撑 p01~p03 的 100% 项）、06-2 episode-commit（evaluateCommitCas /
 * deriveEpisodeCommitDisposition / commitKey 幂等，支撑 z02/z04/z10~z15/z18）、
 * 06-4 race-rollback（evaluatePendingSingleConsumer / evaluateContentExposureRace /
 * evaluateFrozenContentIntegrity，支撑 z11/z12/z16/z20）、06-5 official-scheduler
 * （FSRS shadow 隔离，支撑 z17）、08-2 security-audit（DOM Gold / relation
 * candidate 不可经回答接口 published，支撑 z07/z08/z09、bt16）、08-5
 * e2e-zero-tolerance（hidden/off 零活动矩阵，支撑 bt11/bt32）、07-1/07-3/07-4
 * （onboarding / trigger 双预算 / quiet 控制，支撑 bt02/bt05/bt06/bt08）、
 * 04-5 redaction（tombstone 确定性重放，支撑 p02）、08-3 fault-matrix
 * （kill/cancel/stale/publish 交错，支撑 bt34）。
 */

// ═══════════════════════════════════════════════════════════════════════════
// 一、§16.1 观察模型（可信性硬指标）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * §16.1 可信性硬指标的观察记录（纯数据）。布尔字段语义统一为
 * 「true = 该项被观察到发生/被观察到成立」，断言按 0 容忍或 100% 要求取反/取正。
 * `emptyObservations161()` 返回全合规样本（19 项 0 容忍全部未发生、
 * 3 项 100% 要求全部成立、投影 hash 一致）。
 */
export interface Section161Observations {
  // z01 未知或越权 evidence/artifact/node/edge/option ref
  unknownOrUnauthorizedRefUsed: boolean;
  // z02 practice/diagnostic/not-assessable 升级
  practiceOrDiagnosticOrNotAssessableUpgraded: boolean;
  // z03 assisted/stale 训练 FSRS / 延长 interval
  assistedOrStaleTrainedFsrs: boolean;
  assistedOrStaleExtendedInterval: boolean;
  // z04 Agent direct write（outcome / due / mastery / published semantic relation）
  agentDirectWriteOutcome: boolean;
  agentDirectWriteDue: boolean;
  agentDirectWriteMastery: boolean;
  agentDirectWritePublishedRelation: boolean;
  // z05 单击选择升级
  singleClickSelectionUpgraded: boolean;
  // z06 ASR/Agent 改写伪装
  asrRewrittenAsUserOriginal: boolean;
  agentRewrittenAsUserOriginal: boolean;
  // z07 relation candidate 自动 published
  relationCandidateAutoPublished: boolean;
  // z08 未作答前四渠道泄漏
  leakedBeforeAnswerViaDom: boolean;
  leakedBeforeAnswerViaNetwork: boolean;
  leakedBeforeAnswerViaCache: boolean;
  leakedBeforeAnswerViaPrefetch: boolean;
  // z09 跨 workspace/user 泄漏
  crossWorkspaceLeak: boolean;
  crossUserLeak: boolean;
  // z10 重复 job/tool/commit 副作用
  repeatedJobSideEffect: boolean;
  repeatedToolSideEffect: boolean;
  repeatedCommitSideEffect: boolean;
  // z11 input schedule 消费超过一次
  inputScheduleConsumedMoreThanOnce: boolean;
  // z12 successor != 1
  successorCountNotOne: boolean;
  // z13 facet_eligible / incomplete silent bundle 改变 schedule
  facetEligibleChangedKeyPointSchedule: boolean;
  incompleteSilentBundleChangedKeyPointSchedule: boolean;
  // z14 record_only / no_effect 写 schedule 或结束 review attempt
  recordOnlyWroteSchedule: boolean;
  recordOnlyEndedReviewAttempt: boolean;
  noEffectWroteSchedule: boolean;
  noEffectEndedReviewAttempt: boolean;
  // z15 create_initial / consume_pending 后 active schedule != 1
  activeScheduleCountNotOneAfterCreateInitial: boolean;
  activeScheduleCountNotOneAfterConsumePending: boolean;
  // z16 legacy/new、换 Scene/policy 绕过 exposure/cooldown
  bypassedExposureViaLegacyNew: boolean;
  bypassedCooldownViaSceneOrPolicySwitch: boolean;
  // z17 FSRS shadow 进入候选/排序/理由/用户文案
  fsrsShadowInCandidates: boolean;
  fsrsShadowInRanking: boolean;
  fsrsShadowInReason: boolean;
  fsrsShadowInUserCopy: boolean;
  // z18 Episode plan 含 ineligible target / 缺 official decision ref
  ineligibleTargetInEpisodePlan: boolean;
  missingOfficialDecisionRef: boolean;
  // z19 星图无事件依据的正式状态变化
  starMapStateChangedWithoutEvent: boolean;
  // p01 未 redacted 完整语义重算 100%
  semanticRecomputeInputsComplete: boolean;
  semanticRecomputeResultMatches: boolean;
  // p02 redacted 只支持确定性重放 100%
  redactedReplayCanonicalEventsAvailable: boolean;
  redactedReplayTombstonesAvailable: boolean;
  redactedReplayOutcomeMatches: boolean;
  /** true = 违规（redacted 结果仍支持 semantic re-audit）。 */
  redactedSemanticReauditSupported: boolean;
  // p03 投影 replay hash 一致 100%
  projectionReplayHash: string;
  projectionStoredHash: string;
}

/** §16.1 全合规样本（工厂）：测试/接线层以此为基础按需覆盖。 */
export function emptyObservations161(): Section161Observations {
  return {
    unknownOrUnauthorizedRefUsed: false,
    practiceOrDiagnosticOrNotAssessableUpgraded: false,
    assistedOrStaleTrainedFsrs: false,
    assistedOrStaleExtendedInterval: false,
    agentDirectWriteOutcome: false,
    agentDirectWriteDue: false,
    agentDirectWriteMastery: false,
    agentDirectWritePublishedRelation: false,
    singleClickSelectionUpgraded: false,
    asrRewrittenAsUserOriginal: false,
    agentRewrittenAsUserOriginal: false,
    relationCandidateAutoPublished: false,
    leakedBeforeAnswerViaDom: false,
    leakedBeforeAnswerViaNetwork: false,
    leakedBeforeAnswerViaCache: false,
    leakedBeforeAnswerViaPrefetch: false,
    crossWorkspaceLeak: false,
    crossUserLeak: false,
    repeatedJobSideEffect: false,
    repeatedToolSideEffect: false,
    repeatedCommitSideEffect: false,
    inputScheduleConsumedMoreThanOnce: false,
    successorCountNotOne: false,
    facetEligibleChangedKeyPointSchedule: false,
    incompleteSilentBundleChangedKeyPointSchedule: false,
    recordOnlyWroteSchedule: false,
    recordOnlyEndedReviewAttempt: false,
    noEffectWroteSchedule: false,
    noEffectEndedReviewAttempt: false,
    activeScheduleCountNotOneAfterCreateInitial: false,
    activeScheduleCountNotOneAfterConsumePending: false,
    bypassedExposureViaLegacyNew: false,
    bypassedCooldownViaSceneOrPolicySwitch: false,
    fsrsShadowInCandidates: false,
    fsrsShadowInRanking: false,
    fsrsShadowInReason: false,
    fsrsShadowInUserCopy: false,
    ineligibleTargetInEpisodePlan: false,
    missingOfficialDecisionRef: false,
    starMapStateChangedWithoutEvent: false,
    semanticRecomputeInputsComplete: true,
    semanticRecomputeResultMatches: true,
    redactedReplayCanonicalEventsAvailable: true,
    redactedReplayTombstonesAvailable: true,
    redactedReplayOutcomeMatches: true,
    redactedSemanticReauditSupported: false,
    projectionReplayHash: "clean-projection-hash-v1",
    projectionStoredHash: "clean-projection-hash-v1",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、§17.1 观察模型（必测行为）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * §17.1 必测行为观察记录（纯数据）。字段语义统一为「true = 该行为已按
 * 冻结契约通过对应测试/演练」。`emptyObservations171()` 返回全合规样本
 * （35 条必测行为全部满足）。
 */
export interface Section171Observations {
  // bt01 credential 页零采集 fuzz
  credentialSignatureManifestValid: boolean;
  credentialFuzzAllVariantsBlocked: boolean;
  credentialAuthDataIngressZero: boolean;
  // bt02 首次引导全路径与 CAS 竞争
  onboardingFullPathCompleted: boolean;
  onboardingCasCompetitionSafe: boolean;
  onboardingConsumedNeverRollbackOrReplay: boolean;
  // bt03 onboarding sandbox 隔离
  onboardingSampleNamespaceIsolated: boolean;
  onboardingSampleZeroLearningSideEffect: boolean;
  // bt04 router 与 coverage registry 对账
  routerCoverageReconciled: boolean;
  // bt05 trigger 双预算与多设备竞争
  triggerDualBudgetCompetitionSafe: boolean;
  triggerIllegalSuggestionsZero: boolean;
  // bt06 quiet 零主动面与 context 升级门
  quietZeroProactiveSurface: boolean;
  contextUpgradeGateHeld: boolean;
  // bt07 原生确认不依赖伴星
  nativeConfirmationsShownWhenCompanionHidden: boolean;
  nativeConfirmationsZeroCompanionBudget: boolean;
  // bt08 stale action 与多设备恢复/接管
  staleActionRejected: boolean;
  takeoverRequiredBeforeCommit: boolean;
  // bt09 上下文关闭零传输与 action 重验
  contextClosedZeroTransfer: boolean;
  actionRevalidatedBeforeExecute: boolean;
  globalShellZeroDirectWrite: boolean;
  // bt10 audit/ledger 用途隔离与 TTL
  auditLedgerPurposeIsolated: boolean;
  auditLedgerTtlEnforced: boolean;
  auditLedgerDeletedNoResidual: boolean;
  // bt11 hidden/off 边界
  hiddenOffDeviceSessionZeroActivity: boolean;
  hiddenOffGlobalOffAllDevicesZero: boolean;
  lockedFormalCoreOnlyDrained: boolean;
  // bt12 新设备 account bootstrap
  newDeviceBootstrapResolvedBeforeMount: boolean;
  // bt13 A11y 焦点/读屏/zoom
  a11yFocusNotTrapped: boolean;
  a11yScreenReaderLiveRegion: boolean;
  a11yZoom390NoOcclusion: boolean;
  // bt14 语音 Teach-back 全流程
  teachbackFullFlowCompleted: boolean;
  teachbackRerecordConfirmLowConfidenceSwitchSafe: boolean;
  // bt15 structured-proof-v1 bundle
  proofBundleComplete: boolean;
  proofMissingSceneHandled: boolean;
  proofCrossModalFairness: boolean;
  // bt16 Public Scene 零 private 字段
  publicSceneZeroPrivateFields: boolean;
  // bt17 assistance 先写后返回
  assistanceWriteBeforeReturn: boolean;
  // bt18 多标签并发 reveal/lock/submit
  multitabRevealLockSubmitExactlyOnce: boolean;
  // bt19 legacy/new exposure 竞态三组
  exposureRaceLegacyRevealNewLockSafe: boolean;
  exposureRaceNewRevealLegacySubmitSafe: boolean;
  exposureRaceRolloverSafe: boolean;
  // bt20 lock 后不可变
  lockedArtifactImmutable: boolean;
  // bt21 Supervisor turn/deadline 上限
  supervisorFollowUpTurnsCapped: boolean;
  supervisorDeadlineEnforced: boolean;
  // bt22 Critic mandatory
  criticMandatoryNoSubstitute: boolean;
  // bt23 multi-Episode partial commit
  partialCommitMarkedNotSilentlyRolledBack: boolean;
  partialCommitNoCrossEpisodeRollback: boolean;
  // bt24 schedule exactly-once 与 successor
  inputScheduleExactlyOnce: boolean;
  exactlyOneSuccessor: boolean;
  facetOnlyZeroScheduleSideEffect: boolean;
  // bt25 disposition 矩阵
  createInitialConsumePendingExactlyOnce: boolean;
  recordOnlyNoEffectMatrixComplete: boolean;
  unexpiredUserSelectedEarlyReviewPolicyHeld: boolean;
  // bt26 semantic relation 不可经验证路径 published
  relationNotPublishedViaUnverifiedPath: boolean;
  // bt27 hidden-answer 负向权限
  hiddenAnswerNegativePermission: boolean;
  // bt28 问题标记 RLS
  flagRlsUserPrivateExportDelete: boolean;
  // bt29 四 origin 就地完成
  fourOriginInPlaceCompletion: boolean;
  fourOriginEventDrivenStarUpdate: boolean;
  // bt30 无键盘主路径
  keyboardlessMainPath: boolean;
  // bt31 无任务债务文案
  noTaskDebtCopy: boolean;
  // bt32 temporary_hidden / global_off 完整边界
  temporaryHiddenManualProductComplete: boolean;
  temporaryHiddenDeviceSessionZeroActivity: boolean;
  globalOffAllDevicesAndPushZero: boolean;
  // bt33 transcript 治理
  transcriptRevisionHandled: boolean;
  rawAudioTtlEnforced: boolean;
  allCopySurfacesRedacted: boolean;
  // bt34 kill/cancel/stale/publish 与 COMMIT 交错
  killCancelStalePublishCommitInterleaveSafe: boolean;
  lateProviderCriticResponseHandled: boolean;
  softDrainLegacyReaderCompatible: boolean;
  // bt35 root capability 闭包与原子 apply/rollback
  rootCapabilityReverseDependencyClosure: boolean;
  singleConfigRevisionAtomicApply: boolean;
  applyRollbackAllOrNothing: boolean;
  noIllegalFlagCombinationExposed: boolean;
}

/** §17.1 全合规样本（工厂）：测试/接线层以此为基础按需覆盖。 */
export function emptyObservations171(): Section171Observations {
  return {
    credentialSignatureManifestValid: true,
    credentialFuzzAllVariantsBlocked: true,
    credentialAuthDataIngressZero: true,
    onboardingFullPathCompleted: true,
    onboardingCasCompetitionSafe: true,
    onboardingConsumedNeverRollbackOrReplay: true,
    onboardingSampleNamespaceIsolated: true,
    onboardingSampleZeroLearningSideEffect: true,
    routerCoverageReconciled: true,
    triggerDualBudgetCompetitionSafe: true,
    triggerIllegalSuggestionsZero: true,
    quietZeroProactiveSurface: true,
    contextUpgradeGateHeld: true,
    nativeConfirmationsShownWhenCompanionHidden: true,
    nativeConfirmationsZeroCompanionBudget: true,
    staleActionRejected: true,
    takeoverRequiredBeforeCommit: true,
    contextClosedZeroTransfer: true,
    actionRevalidatedBeforeExecute: true,
    globalShellZeroDirectWrite: true,
    auditLedgerPurposeIsolated: true,
    auditLedgerTtlEnforced: true,
    auditLedgerDeletedNoResidual: true,
    hiddenOffDeviceSessionZeroActivity: true,
    hiddenOffGlobalOffAllDevicesZero: true,
    lockedFormalCoreOnlyDrained: true,
    newDeviceBootstrapResolvedBeforeMount: true,
    a11yFocusNotTrapped: true,
    a11yScreenReaderLiveRegion: true,
    a11yZoom390NoOcclusion: true,
    teachbackFullFlowCompleted: true,
    teachbackRerecordConfirmLowConfidenceSwitchSafe: true,
    proofBundleComplete: true,
    proofMissingSceneHandled: true,
    proofCrossModalFairness: true,
    publicSceneZeroPrivateFields: true,
    assistanceWriteBeforeReturn: true,
    multitabRevealLockSubmitExactlyOnce: true,
    exposureRaceLegacyRevealNewLockSafe: true,
    exposureRaceNewRevealLegacySubmitSafe: true,
    exposureRaceRolloverSafe: true,
    lockedArtifactImmutable: true,
    supervisorFollowUpTurnsCapped: true,
    supervisorDeadlineEnforced: true,
    criticMandatoryNoSubstitute: true,
    partialCommitMarkedNotSilentlyRolledBack: true,
    partialCommitNoCrossEpisodeRollback: true,
    inputScheduleExactlyOnce: true,
    exactlyOneSuccessor: true,
    facetOnlyZeroScheduleSideEffect: true,
    createInitialConsumePendingExactlyOnce: true,
    recordOnlyNoEffectMatrixComplete: true,
    unexpiredUserSelectedEarlyReviewPolicyHeld: true,
    relationNotPublishedViaUnverifiedPath: true,
    hiddenAnswerNegativePermission: true,
    flagRlsUserPrivateExportDelete: true,
    fourOriginInPlaceCompletion: true,
    fourOriginEventDrivenStarUpdate: true,
    keyboardlessMainPath: true,
    noTaskDebtCopy: true,
    temporaryHiddenManualProductComplete: true,
    temporaryHiddenDeviceSessionZeroActivity: true,
    globalOffAllDevicesAndPushZero: true,
    transcriptRevisionHandled: true,
    rawAudioTtlEnforced: true,
    allCopySurfacesRedacted: true,
    killCancelStalePublishCommitInterleaveSafe: true,
    lateProviderCriticResponseHandled: true,
    softDrainLegacyReaderCompatible: true,
    rootCapabilityReverseDependencyClosure: true,
    singleConfigRevisionAtomicApply: true,
    applyRollbackAllOrNothing: true,
    noIllegalFlagCombinationExposed: true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、清单类型
// ═══════════════════════════════════════════════════════════════════════════

/** 一条断言：必须是真实判定，且 `requires` 声明其证据字段（伪通过检测依据）。 */
export interface HardInvariantAssertion<Obs> {
  /** 断言 ID（spec 内唯一） */
  id: string;
  /** 人类可读断言描述（中文，冻结文本的可验证片段） */
  description: string;
  /**
   * 该断言判定所依赖的证据字段（观察模型上的点号路径，如
   * `"unknownOrUnauthorizedRefUsed"`、`"projectionReplayHash"`）。
   * 非空；`detectFakePass` 会用 Proxy 验证判定运行时确实读取了它们。
   */
  requires: readonly string[];
  /** 判定谓词（纯函数）：读观察记录返回是否满足。 */
  check: (obs: Obs) => boolean;
}

/** §16.1 硬指标 spec。 */
export interface HardInvariantSpec {
  /** 形如 `16.1-z01` / `16.1-p01` */
  id: string;
  /** 容忍级别：`zero` = 0 容忍；`percent100` = 100% 要求 */
  tolerance: "zero" | "percent100";
  /** §16.1 条目标题 */
  title: string;
  /** 冻结记录 01-5 §2 原文 */
  frozenText: string;
  /** 证据链映射（对应的既有模块/判定/接线来源，供收口审计） */
  mapsTo: string;
  assertions: readonly HardInvariantAssertion<Section161Observations>[];
}

/** §17.1 必测行为 spec。 */
export interface MustTestBehaviorSpec {
  /** 形如 `17.1-01` */
  id: string;
  /** §17.1 条目标题 */
  title: string;
  /** 冻结记录 01-6 §2 原文 */
  frozenText: string;
  /** 证据链映射 */
  mapsTo: string;
  assertions: readonly HardInvariantAssertion<Section171Observations>[];
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、§16.1 硬指标清单（22 项）
// ═══════════════════════════════════════════════════════════════════════════

export const HARD_INVARIANTS_16_1: readonly HardInvariantSpec[] = [
  {
    id: "16.1-z01",
    tolerance: "zero",
    title: "未知或越权 evidence/artifact/node/edge/option ref：0",
    frozenText: "未知或越权 evidence/artifact/node/edge/option ref：0",
    mapsTo: "08-2 security-audit（伪 evidence/node/token/option ID 拒绝）+ trust-service（evidence ref 注册表）",
    assertions: [
      {
        id: "z01_unknown_or_unauthorized_ref",
        description: "未知或越权 evidence/artifact/node/edge/option ref 出现次数为 0",
        requires: ["unknownOrUnauthorizedRefUsed"],
        check: (o) => !o.unknownOrUnauthorizedRefUsed,
      },
    ],
  },
  {
    id: "16.1-z02",
    tolerance: "zero",
    title: "practice/diagnostic/not-assessable 导致 mastery 或 schedule 升级：0",
    frozenText: "practice/diagnostic/not-assessable 导致 mastery 或 schedule 升级：0",
    mapsTo: "06-2 episode-commit deriveEpisodeCommitDisposition（practice_or_diagnostic → 0 review/0 schedule）",
    assertions: [
      {
        id: "z02_no_practice_diagnostic_notassessable_upgrade",
        description: "practice/diagnostic/not-assessable 结果不得导致 mastery 或 schedule 升级",
        requires: ["practiceOrDiagnosticOrNotAssessableUpgraded"],
        check: (o) => !o.practiceOrDiagnosticOrNotAssessableUpgraded,
      },
    ],
  },
  {
    id: "16.1-z03",
    tolerance: "zero",
    title: "assisted/stale 结果训练 FSRS 或延长 interval：0",
    frozenText: "assisted/stale 结果训练 FSRS 或延长 interval：0",
    mapsTo: "06-2 episode-commit disposition + 06-5 official-scheduler（assisted/stale 不进 FSRS、不延长 interval）",
    assertions: [
      {
        id: "z03_no_assisted_stale_fsrs",
        description: "assisted/stale 结果不得训练 FSRS",
        requires: ["assistedOrStaleTrainedFsrs"],
        check: (o) => !o.assistedOrStaleTrainedFsrs,
      },
      {
        id: "z03_no_assisted_stale_interval",
        description: "assisted/stale 结果不得延长 interval",
        requires: ["assistedOrStaleExtendedInterval"],
        check: (o) => !o.assistedOrStaleExtendedInterval,
      },
    ],
  },
  {
    id: "16.1-z04",
    tolerance: "zero",
    title: "Agent 直接修改 outcome、due、mastery、published semantic relation：0",
    frozenText: "Agent 直接修改 outcome、due、mastery、published semantic relation：0",
    mapsTo: "06-2 episode-commit（唯一事实落点只经 COMMIT）+ 08-5 D6（Global Shell 零领域写）+ 08-2 relation 审核发布",
    assertions: [
      {
        id: "z04_no_agent_outcome",
        description: "Agent 不得直接修改 outcome",
        requires: ["agentDirectWriteOutcome"],
        check: (o) => !o.agentDirectWriteOutcome,
      },
      {
        id: "z04_no_agent_due",
        description: "Agent 不得直接修改 due",
        requires: ["agentDirectWriteDue"],
        check: (o) => !o.agentDirectWriteDue,
      },
      {
        id: "z04_no_agent_mastery",
        description: "Agent 不得直接修改 mastery",
        requires: ["agentDirectWriteMastery"],
        check: (o) => !o.agentDirectWriteMastery,
      },
      {
        id: "z04_no_agent_published_relation",
        description: "Agent 不得直接修改 published semantic relation",
        requires: ["agentDirectWritePublishedRelation"],
        check: (o) => !o.agentDirectWritePublishedRelation,
      },
    ],
  },
  {
    id: "16.1-z05",
    tolerance: "zero",
    title: "单击选择/判断单独产生 mastery upgrade：0",
    frozenText: "单击选择/判断单独产生 mastery upgrade：0",
    mapsTo: "05-2 scene-runtime（单项作答不得独立产生 mastery；升级需完整 assessable 证据链）",
    assertions: [
      {
        id: "z05_no_single_click_upgrade",
        description: "单击选择/判断不得单独产生 mastery upgrade",
        requires: ["singleClickSelectionUpgraded"],
        check: (o) => !o.singleClickSelectionUpgraded,
      },
    ],
  },
  {
    id: "16.1-z06",
    tolerance: "zero",
    title: "ASR/Agent 改写后的答案伪装为用户原始答案：0",
    frozenText: "ASR/Agent 改写后的答案伪装为用户原始答案：0",
    mapsTo: "08-2 security-audit（音频替换 hash 校验）+ 04-1 voice-pipeline（transcript 确认/不可辨 → not_assessable）",
    assertions: [
      {
        id: "z06_no_asr_mask",
        description: "ASR 改写后的答案不得伪装为用户原始答案",
        requires: ["asrRewrittenAsUserOriginal"],
        check: (o) => !o.asrRewrittenAsUserOriginal,
      },
      {
        id: "z06_no_agent_mask",
        description: "Agent 改写后的答案不得伪装为用户原始答案",
        requires: ["agentRewrittenAsUserOriginal"],
        check: (o) => !o.agentRewrittenAsUserOriginal,
      },
    ],
  },
  {
    id: "16.1-z07",
    tolerance: "zero",
    title: "semantic relation candidate 自动转 published：0",
    frozenText: "semantic relation candidate 自动转 published：0",
    mapsTo: "08-2 checkRelationCandidatePublish（只能经 relation review + 有审核权限 actor 发布）+ relation-governance",
    assertions: [
      {
        id: "z07_no_relation_auto_publish",
        description: "semantic relation candidate 不得自动转 published",
        requires: ["relationCandidateAutoPublished"],
        check: (o) => !o.relationCandidateAutoPublished,
      },
    ],
  },
  {
    id: "16.1-z08",
    tolerance: "zero",
    title: "未作答前 DOM/network/cache/prefetch 答案泄漏：0",
    frozenText: "未作答前 DOM/network/cache/prefetch 答案泄漏：0",
    mapsTo: "08-2 DOM Gold（allowlist + denylist）+ 08-5 D4 + Public Scene 零 private 字段（bt16）",
    assertions: [
      {
        id: "z08_no_dom_leak",
        description: "未作答前 DOM 不得泄漏答案",
        requires: ["leakedBeforeAnswerViaDom"],
        check: (o) => !o.leakedBeforeAnswerViaDom,
      },
      {
        id: "z08_no_network_leak",
        description: "未作答前 network 不得泄漏答案",
        requires: ["leakedBeforeAnswerViaNetwork"],
        check: (o) => !o.leakedBeforeAnswerViaNetwork,
      },
      {
        id: "z08_no_cache_leak",
        description: "未作答前 cache 不得泄漏答案",
        requires: ["leakedBeforeAnswerViaCache"],
        check: (o) => !o.leakedBeforeAnswerViaCache,
      },
      {
        id: "z08_no_prefetch_leak",
        description: "未作答前 prefetch 不得泄漏答案",
        requires: ["leakedBeforeAnswerViaPrefetch"],
        check: (o) => !o.leakedBeforeAnswerViaPrefetch,
      },
    ],
  },
  {
    id: "16.1-z09",
    tolerance: "zero",
    title: "跨 workspace/user 学习数据泄漏：0",
    frozenText: "跨 workspace/user 学习数据泄漏：0",
    mapsTo: "08-2 checkCrossWorkspaceRefReuse + 02-2 RLS 矩阵（workspace/user 行级隔离）",
    assertions: [
      {
        id: "z09_no_cross_workspace_leak",
        description: "跨 workspace 学习数据不得泄漏",
        requires: ["crossWorkspaceLeak"],
        check: (o) => !o.crossWorkspaceLeak,
      },
      {
        id: "z09_no_cross_user_leak",
        description: "跨 user 学习数据不得泄漏",
        requires: ["crossUserLeak"],
        check: (o) => !o.crossUserLeak,
      },
    ],
  },
  {
    id: "16.1-z10",
    tolerance: "zero",
    title: "重复 job/tool/commit 产生重复副作用：0",
    frozenText: "重复 job/tool/commit 产生重复副作用：0",
    mapsTo: "06-2 commitKey 幂等 + 08-3 故障矩阵（duplicate tool/response、publish/commit 响应丢失 exactly-once）",
    assertions: [
      {
        id: "z10_no_repeated_job_side_effect",
        description: "重复 job 不得产生重复副作用",
        requires: ["repeatedJobSideEffect"],
        check: (o) => !o.repeatedJobSideEffect,
      },
      {
        id: "z10_no_repeated_tool_side_effect",
        description: "重复 tool 不得产生重复副作用",
        requires: ["repeatedToolSideEffect"],
        check: (o) => !o.repeatedToolSideEffect,
      },
      {
        id: "z10_no_repeated_commit_side_effect",
        description: "重复 commit 不得产生重复副作用",
        requires: ["repeatedCommitSideEffect"],
        check: (o) => !o.repeatedCommitSideEffect,
      },
    ],
  },
  {
    id: "16.1-z11",
    tolerance: "zero",
    title: "一个 input schedule 被成功消费超过一次：0",
    frozenText: "一个 input schedule 被成功消费超过一次：0",
    mapsTo: "06-4 evaluatePendingSingleConsumer + review_schedules_pending_unique_idx + 06-2 consume_pending 单次 CAS",
    assertions: [
      {
        id: "z11_no_multi_consume",
        description: "一个 input schedule 不得被成功消费超过一次",
        requires: ["inputScheduleConsumedMoreThanOnce"],
        check: (o) => !o.inputScheduleConsumedMoreThanOnce,
      },
    ],
  },
  {
    id: "16.1-z12",
    tolerance: "zero",
    title: "每个成功提交的 schedule-bearing Episode 的 successor schedule 数不等于 1：0",
    frozenText: "每个成功提交的 schedule-bearing Episode 的 successor schedule 数不等于 1：0",
    mapsTo: "06-2 planCommitSideEffects（create/consume 后恰一 active schedule）+ 06-4 evaluatePendingSingleConsumer",
    assertions: [
      {
        id: "z12_successor_is_one",
        description: "每个成功提交的 schedule-bearing Episode 必须恰好产生 1 个 successor schedule",
        requires: ["successorCountNotOne"],
        check: (o) => !o.successorCountNotOne,
      },
    ],
  },
  {
    id: "16.1-z13",
    tolerance: "zero",
    title: "facet_eligible 或 incomplete silent bundle 改变 Key Point schedule：0",
    frozenText: "`facet_eligible` 或 incomplete silent bundle 改变 Key Point schedule：0",
    mapsTo: "06-2 canonical_facet_observation（0 overall/0 review/0 schedule）+ silent-profile-registry（incomplete bundle 无 schedule 副作用）",
    assertions: [
      {
        id: "z13_no_facet_eligible_schedule",
        description: "facet_eligible 不得改变 Key Point schedule",
        requires: ["facetEligibleChangedKeyPointSchedule"],
        check: (o) => !o.facetEligibleChangedKeyPointSchedule,
      },
      {
        id: "z13_no_incomplete_bundle_schedule",
        description: "incomplete silent bundle 不得改变 Key Point schedule",
        requires: ["incompleteSilentBundleChangedKeyPointSchedule"],
        check: (o) => !o.incompleteSilentBundleChangedKeyPointSchedule,
      },
    ],
  },
  {
    id: "16.1-z14",
    tolerance: "zero",
    title: "record_only/no_effect 写 schedule 或结束 review attempt：0",
    frozenText: "`record_only/no_effect` 写 schedule 或结束 review attempt：0",
    mapsTo: "06-2 disposition（record_only → canonical_facet_observation 0 schedule；no_effect → practice_or_diagnostic）+ 06-3 disposition 矩阵",
    assertions: [
      {
        id: "z14_no_record_only_schedule",
        description: "record_only 不得写 schedule",
        requires: ["recordOnlyWroteSchedule"],
        check: (o) => !o.recordOnlyWroteSchedule,
      },
      {
        id: "z14_no_record_only_attempt",
        description: "record_only 不得结束 review attempt",
        requires: ["recordOnlyEndedReviewAttempt"],
        check: (o) => !o.recordOnlyEndedReviewAttempt,
      },
      {
        id: "z14_no_noeffect_schedule",
        description: "no_effect 不得写 schedule",
        requires: ["noEffectWroteSchedule"],
        check: (o) => !o.noEffectWroteSchedule,
      },
      {
        id: "z14_no_noeffect_attempt",
        description: "no_effect 不得结束 review attempt",
        requires: ["noEffectEndedReviewAttempt"],
        check: (o) => !o.noEffectEndedReviewAttempt,
      },
    ],
  },
  {
    id: "16.1-z15",
    tolerance: "zero",
    title: "create_initial/consume_pending 提交后 active schedule 数不等于 1：0",
    frozenText: "`create_initial/consume_pending` 提交后 active schedule 数不等于 1：0",
    mapsTo: "06-2 planCommitSideEffects（create/consume 后恰一 active schedule）+ 06-4 单消费者",
    assertions: [
      {
        id: "z15_active_one_after_create",
        description: "create_initial 提交后 active schedule 数必须等于 1",
        requires: ["activeScheduleCountNotOneAfterCreateInitial"],
        check: (o) => !o.activeScheduleCountNotOneAfterCreateInitial,
      },
      {
        id: "z15_active_one_after_consume",
        description: "consume_pending 提交后 active schedule 数必须等于 1",
        requires: ["activeScheduleCountNotOneAfterConsumePending"],
        check: (o) => !o.activeScheduleCountNotOneAfterConsumePending,
      },
    ],
  },
  {
    id: "16.1-z16",
    tolerance: "zero",
    title: "同一内容通过 legacy/new、换 Scene/policy 绕过 exposure/cooldown：0",
    frozenText: "同一内容通过 legacy/new、换 Scene/policy 绕过 exposure/cooldown：0",
    mapsTo: "06-4 evaluateContentExposureRace（三组 contentExposureKey 竞态）+ 02-8 exposure/cooldown",
    assertions: [
      {
        id: "z16_no_legacy_new_exposure_bypass",
        description: "同一内容不得通过 legacy/new 绕过 exposure/cooldown",
        requires: ["bypassedExposureViaLegacyNew"],
        check: (o) => !o.bypassedExposureViaLegacyNew,
      },
      {
        id: "z16_no_scene_policy_bypass",
        description: "同一内容不得通过换 Scene/policy 绕过 exposure/cooldown",
        requires: ["bypassedCooldownViaSceneOrPolicySwitch"],
        check: (o) => !o.bypassedCooldownViaSceneOrPolicySwitch,
      },
    ],
  },
  {
    id: "16.1-z17",
    tolerance: "zero",
    title: "FSRS shadow 进入候选、排序、推荐理由或用户文案：0",
    frozenText: "FSRS shadow 进入候选、排序、推荐理由或用户文案：0",
    mapsTo: "06-5 official-scheduler（FSRS shadow 隔离，官方调度器只消费 official 输出）",
    assertions: [
      {
        id: "z17_no_shadow_in_candidates",
        description: "FSRS shadow 不得进入候选",
        requires: ["fsrsShadowInCandidates"],
        check: (o) => !o.fsrsShadowInCandidates,
      },
      {
        id: "z17_no_shadow_in_ranking",
        description: "FSRS shadow 不得进入排序",
        requires: ["fsrsShadowInRanking"],
        check: (o) => !o.fsrsShadowInRanking,
      },
      {
        id: "z17_no_shadow_in_reason",
        description: "FSRS shadow 不得进入推荐理由",
        requires: ["fsrsShadowInReason"],
        check: (o) => !o.fsrsShadowInReason,
      },
      {
        id: "z17_no_shadow_in_user_copy",
        description: "FSRS shadow 不得进入用户文案",
        requires: ["fsrsShadowInUserCopy"],
        check: (o) => !o.fsrsShadowInUserCopy,
      },
    ],
  },
  {
    id: "16.1-z18",
    tolerance: "zero",
    title: "Episode plan 包含 ineligible target 或缺少 official decision ref：0",
    frozenText: "Episode plan 包含 ineligible target 或缺少 official decision ref：0",
    mapsTo: "03-2 session-service（PREPARE 计划构造）+ official-scheduler（ineligible 判定/decision ref 落点）",
    assertions: [
      {
        id: "z18_no_ineligible_target",
        description: "Episode plan 不得包含 ineligible target",
        requires: ["ineligibleTargetInEpisodePlan"],
        check: (o) => !o.ineligibleTargetInEpisodePlan,
      },
      {
        id: "z18_no_missing_decision_ref",
        description: "Episode plan 不得缺少 official decision ref",
        requires: ["missingOfficialDecisionRef"],
        check: (o) => !o.missingOfficialDecisionRef,
      },
    ],
  },
  {
    id: "16.1-z19",
    tolerance: "zero",
    title: "星图无事件依据的正式状态变化：0",
    frozenText: "星图无事件依据的正式状态变化：0",
    mapsTo: "02-9 canonical-events（star map projection 只由 canonical event 驱动）+ 07-6 star-map",
    assertions: [
      {
        id: "z19_no_eventless_star_change",
        description: "星图正式状态变化必须有事件依据",
        requires: ["starMapStateChangedWithoutEvent"],
        check: (o) => !o.starMapStateChangedWithoutEvent,
      },
    ],
  },
  {
    id: "16.1-p01",
    tolerance: "percent100",
    title: "未 redacted 结果可完整语义重算：100%",
    frozenText:
      "未 redacted 结果从 contract + frozen probes + artifacts + EpisodeTrustDecision + assessments + scheduling decision + reducer 可做完整语义重算：100%",
    mapsTo: "02-9 canonical-events（重放语义）+ 04-5 redaction（未 redacted 全输入保留）",
    assertions: [
      {
        id: "p01_inputs_complete",
        description:
          "重算所需输入（contract + frozen probes + artifacts + EpisodeTrustDecision + assessments + scheduling decision + reducer）必须全部可获得",
        requires: ["semanticRecomputeInputsComplete"],
        check: (o) => o.semanticRecomputeInputsComplete,
      },
      {
        id: "p01_recompute_matches",
        description: "由上述输入重算得到的结果必须与原始结果一致",
        requires: ["semanticRecomputeResultMatches"],
        check: (o) => o.semanticRecomputeResultMatches,
      },
    ],
  },
  {
    id: "16.1-p02",
    tolerance: "percent100",
    title: "redacted 只支持确定性重放：100%",
    frozenText:
      "redacted 结果只要求由 canonical event + content-free tombstone 确定性重放既有 outcome/投影，且明确不支持 semantic re-audit：100%",
    mapsTo: "04-5 redaction（tombstone/content-free）+ 02-9 canonical-events（确定性重放）",
    assertions: [
      {
        id: "p02_canonical_events_available",
        description: "redacted 结果重放所需 canonical event 必须可获得",
        requires: ["redactedReplayCanonicalEventsAvailable"],
        check: (o) => o.redactedReplayCanonicalEventsAvailable,
      },
      {
        id: "p02_tombstones_available",
        description: "redacted 结果重放所需 content-free tombstone 必须可获得",
        requires: ["redactedReplayTombstonesAvailable"],
        check: (o) => o.redactedReplayTombstonesAvailable,
      },
      {
        id: "p02_outcome_matches",
        description: "由 canonical event + tombstone 重放必须确定性还原既有 outcome/投影",
        requires: ["redactedReplayOutcomeMatches"],
        check: (o) => o.redactedReplayOutcomeMatches,
      },
      {
        id: "p02_no_semantic_reaudit",
        description: "redacted 结果必须明确不支持 semantic re-audit（不提供语义重算路径）",
        requires: ["redactedSemanticReauditSupported"],
        check: (o) => !o.redactedSemanticReauditSupported,
      },
    ],
  },
  {
    id: "16.1-p03",
    tolerance: "percent100",
    title: "投影 replay hash 一致：100%",
    frozenText: "投影 replay hash 一致：100%",
    mapsTo: "02-9 canonical-events（replayProjection / computeProjectionHash / driftCheck）——重放 hash 由接线层用 replayProjection 计算后注入，本模块判定一致",
    assertions: [
      {
        id: "p03_replay_hash_matches",
        description: "重放投影 hash 必须与存储 hash 一致（且重放 hash 非空，拒绝空 hash 伪通过）",
        requires: ["projectionReplayHash", "projectionStoredHash"],
        check: (o) =>
          o.projectionReplayHash !== "" &&
          o.projectionReplayHash === o.projectionStoredHash,
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// 五、§17.1 必测行为清单（35 条）
// ═══════════════════════════════════════════════════════════════════════════

export const MUST_TEST_BEHAVIORS_17_1: readonly MustTestBehaviorSpec[] = [
  {
    id: "17.1-01",
    title: "credential 页零采集 fuzz",
    frozenText:
      "public-auth 与 authenticated credential 页的签名 manifest、字段/焦点/长度/粘贴/自动填充/时序 fuzz；认证数据流入 Companion DTO / RSC / hydration / cache / 日志 / analytics / 模型为 0；防枚举归一错误码，只提供纯静态帮助",
    mapsTo: "08-2 security-audit（credential 六面零采集 + 错误码归一化）+ 08-5 D4",
    assertions: [
      {
        id: "bt01_signature_manifest",
        description: "credential 页签名 manifest 校验通过",
        requires: ["credentialSignatureManifestValid"],
        check: (o) => o.credentialSignatureManifestValid,
      },
      {
        id: "bt01_fuzz_all_blocked",
        description: "字段/焦点/长度/粘贴/自动填充/时序 fuzz 全部被拦截",
        requires: ["credentialFuzzAllVariantsBlocked"],
        check: (o) => o.credentialFuzzAllVariantsBlocked,
      },
      {
        id: "bt01_auth_data_ingress_zero",
        description: "认证数据流入 Companion DTO / RSC / hydration / cache / 日志 / analytics / 模型为 0",
        requires: ["credentialAuthDataIngressZero"],
        check: (o) => o.credentialAuthDataIngressZero,
      },
    ],
  },
  {
    id: "17.1-02",
    title: "首次引导全路径与 CAS 竞争",
    frozenText:
      "首次引导完整流程、一步跳过、每步返回/暂停、刷新/重登/跨设备恢复、manual replay、版本升级和老用户 quiet/off；not_offered→offered 双标签/双设备 CAS；CAS 成功但首帧前崩溃不重弹；offer consumed 单调；scoped resume token/expiry；旧设备不能回退终态",
    mapsTo: "07-1 onboarding-first-guide + 08-5 D8（终态不回退/consumed 不重放）",
    assertions: [
      {
        id: "bt02_full_path",
        description: "首次引导完整流程（含一步跳过/返回/暂停/刷新/重登/跨设备恢复/manual replay/版本升级/老用户 quiet/off）全部通过",
        requires: ["onboardingFullPathCompleted"],
        check: (o) => o.onboardingFullPathCompleted,
      },
      {
        id: "bt02_cas_competition",
        description: "not_offered→offered 双标签/双设备 CAS 竞争安全（首帧前崩溃不重弹、consumed 单调、scoped token/expiry、旧设备不回退终态）",
        requires: ["onboardingCasCompetitionSafe"],
        check: (o) => o.onboardingCasCompetitionSafe,
      },
      {
        id: "bt02_consumed_monotonic",
        description: "offer consumed 后不得回退或系统自动重放",
        requires: ["onboardingConsumedNeverRollbackOrReplay"],
        check: (o) => o.onboardingConsumedNeverRollbackOrReplay,
      },
    ],
  },
  {
    id: "17.1-03",
    title: "onboarding sandbox 隔离",
    frozenText:
      "onboarding_sample:* namespace 物理隔离、publishedTargetEligibility=false、demo map 还原；对 assessment/mastery/exposure/schedule 为 0；own-content 分支先终止 sandbox，并进入正常 capability/exposure 合同",
    mapsTo: "07-1 onboarding（sample namespace + publishedTargetEligibility=false）",
    assertions: [
      {
        id: "bt03_namespace_isolated",
        description: "onboarding_sample:* namespace 物理隔离且 publishedTargetEligibility=false",
        requires: ["onboardingSampleNamespaceIsolated"],
        check: (o) => o.onboardingSampleNamespaceIsolated,
      },
      {
        id: "bt03_zero_learning_side_effect",
        description: "sandbox 对 assessment/mastery/exposure/schedule 的学习副作用为 0",
        requires: ["onboardingSampleZeroLearningSideEffect"],
        check: (o) => o.onboardingSampleZeroLearningSideEffect,
      },
    ],
  },
  {
    id: "17.1-04",
    title: "router 与 coverage registry 对账",
    frozenText:
      "router 全量 route 与 CompanionPageCoverageRegistryV1 对账、PageCompanionContextV1/action manifest、四种 surface mode、移动端收起、未接入 fallback、未保存离页保护和关闭后手动主路径",
    mapsTo: "07-2 page-coverage-registry（router/coverage 100% 对账）+ 08-5",
    assertions: [
      {
        id: "bt04_router_coverage_reconciled",
        description: "router 全量 route 与 CompanionPageCoverageRegistryV1 100% 对账",
        requires: ["routerCoverageReconciled"],
        check: (o) => o.routerCoverageReconciled,
      },
    ],
  },
  {
    id: "17.1-05",
    title: "trigger 双预算与多设备竞争",
    frozenText:
      "CompanionTriggerRuleV1 registry、presence reason 映射、context/reason 唯一约束 + account suggestion lease + permit 的多标签/多设备事务竞争、targetChangeEpoch、onboarding 独立预算、稳定 cooldown 与 suggestion class suppression；quiet/page-muted/context-off/focus/paused/hidden/off 和 formal/录音/输入/拖拽期间 0 非法内容建议",
    mapsTo: "07-3 trigger-arbitration + 08-5 D1/D7 + 01-5 §5.3",
    assertions: [
      {
        id: "bt05_dual_budget_competition",
        description: "context/reason 双预算 + account lease + permit 的多标签/多设备事务竞争安全",
        requires: ["triggerDualBudgetCompetitionSafe"],
        check: (o) => o.triggerDualBudgetCompetitionSafe,
      },
      {
        id: "bt05_illegal_suggestions_zero",
        description: "quiet/page-muted/context-off/focus/paused/hidden/off 与 formal/录音/输入/拖拽期间非法内容建议为 0",
        requires: ["triggerIllegalSuggestionsZero"],
        check: (o) => o.triggerIllegalSuggestionsZero,
      },
    ],
  },
  {
    id: "17.1-06",
    title: "quiet 零主动面与完整 context 升级门",
    frozenText:
      "quiet 静态锚点、零 idle 动画、显式召唤后短 TTL context；moderate/active 只用 CompanionTriggerContextV1，permit + 接受后才升级完整 context",
    mapsTo: "07-4 presence-control + 08-5 D5（quiet 零 observer/idle/完整 context）",
    assertions: [
      {
        id: "bt06_quiet_zero_proactive",
        description: "quiet 未召唤时 entity/selection observer、完整 PageCompanionContextV1 构造/传输和 idle 动画为 0",
        requires: ["quietZeroProactiveSurface"],
        check: (o) => o.quietZeroProactiveSurface,
      },
      {
        id: "bt06_context_upgrade_gate",
        description: "moderate/active 只在 permit + 用户接受后才升级完整 context",
        requires: ["contextUpgradeGateHeld"],
        check: (o) => o.contextUpgradeGateHeld,
      },
    ],
  },
  {
    id: "17.1-07",
    title: "认证/安全/权限/破坏性确认不依赖伴星",
    frozenText:
      "认证、安全、权限和破坏性确认在 Companion hidden/off 时仍由页面原生 UI 完整展示，且不消费 Companion budget",
    mapsTo: "01-5 §5.3（页面原生确认）+ 03-5 global-shell",
    assertions: [
      {
        id: "bt07_native_ui_when_hidden",
        description: "Companion hidden/off 时认证/安全/权限/破坏性确认仍由页面原生 UI 完整展示",
        requires: ["nativeConfirmationsShownWhenCompanionHidden"],
        check: (o) => o.nativeConfirmationsShownWhenCompanionHidden,
      },
      {
        id: "bt07_zero_companion_budget",
        description: "上述原生确认不消费 Companion budget",
        requires: ["nativeConfirmationsZeroCompanionBudget"],
        check: (o) => o.nativeConfirmationsZeroCompanionBudget,
      },
    ],
  },
  {
    id: "17.1-08",
    title: "stale action 与多设备恢复/接管",
    frozenText:
      "页面切换、workspace/角色切换、权限撤回和 contextVersion 变化后的 stale action；跨设备恢复前重验与多设备显式接管",
    mapsTo: "08-2 evaluateStaleAction（五维 stale fail closed）+ 07-8 cross-device-recovery（显式接管）",
    assertions: [
      {
        id: "bt08_stale_rejected",
        description: "页面/workspace/角色/权限/contextVersion 变化后的 stale action 全部被拒绝",
        requires: ["staleActionRejected"],
        check: (o) => o.staleActionRejected,
      },
      {
        id: "bt08_takeover_before_commit",
        description: "跨设备恢复前重验、多设备显式接管后才允许提交",
        requires: ["takeoverRequiredBeforeCommit"],
        check: (o) => o.takeoverRequiredBeforeCommit,
      },
    ],
  },
  {
    id: "17.1-09",
    title: "上下文关闭零传输与 action 重验",
    frozenText:
      "当前页面上下文关闭后的零 entity/context 传输；页面 action 的影响预览、nonce、permission/context 重验、domain service 再鉴权和 Global Shell 零直接写",
    mapsTo: "08-2 + 08-5 D6（写入四重验证 + shell 零领域写）+ 03-4 tool-gateway",
    assertions: [
      {
        id: "bt09_context_closed_zero_transfer",
        description: "当前页面上下文关闭后 entity/context 传输为 0",
        requires: ["contextClosedZeroTransfer"],
        check: (o) => o.contextClosedZeroTransfer,
      },
      {
        id: "bt09_action_revalidated",
        description: "页面 action 经影响预览、nonce、permission/context 重验、domain service 再鉴权后执行",
        requires: ["actionRevalidatedBeforeExecute"],
        check: (o) => o.actionRevalidatedBeforeExecute,
      },
      {
        id: "bt09_shell_zero_direct_write",
        description: "Global Shell 对领域数据零直接写",
        requires: ["globalShellZeroDirectWrite"],
        check: (o) => o.globalShellZeroDirectWrite,
      },
    ],
  },
  {
    id: "17.1-10",
    title: "audit/ledger 用途隔离与 TTL",
    frozenText:
      "Companion page/action audit 与 invitation ledger 的用途隔离、TTL expiry、content-free tombstone、导出/删除、全存储残留扫描和删除后不重新打扰",
    mapsTo: "02-4 audit-privacy-lifecycle + 08-5（audit 用途隔离/导出）",
    assertions: [
      {
        id: "bt10_purpose_isolated",
        description: "page/action audit 与 invitation ledger 用途隔离",
        requires: ["auditLedgerPurposeIsolated"],
        check: (o) => o.auditLedgerPurposeIsolated,
      },
      {
        id: "bt10_ttl_enforced",
        description: "audit/ledger 超过冻结 TTL 即过期并转 content-free tombstone",
        requires: ["auditLedgerTtlEnforced"],
        check: (o) => o.auditLedgerTtlEnforced,
      },
      {
        id: "bt10_deleted_no_residual",
        description: "用户删除后无存储残留、导出/删除完整、删除后不重新打扰",
        requires: ["auditLedgerDeletedNoResidual"],
        check: (o) => o.auditLedgerDeletedNoResidual,
      },
    ],
  },
  {
    id: "17.1-11",
    title: "hidden/off 边界",
    frozenText:
      "device-local hidden 与 ephemeral runtime-fence、account global-off CAS/epoch fanout/active-device lease expiry/CAS 失败诚实状态；确认后的页面 observer/context、预取、Companion Provider/job 与迟到结果为 0；domain import/generation 可手动移交、Tutor 必须取消、已锁 formal core 只 drain 的分离",
    mapsTo: "08-5 D1/D2（hidden/off 零活动矩阵 + epoch 传播 SLA）+ 07-4",
    assertions: [
      {
        id: "bt11_device_session_zero",
        description: "temporary_hidden/runtime-fence 确认后当前 device session 的 observer/context/预取/调用/迟到结果为 0",
        requires: ["hiddenOffDeviceSessionZeroActivity"],
        check: (o) => o.hiddenOffDeviceSessionZeroActivity,
      },
      {
        id: "bt11_global_off_all_devices_zero",
        description: "global_off CAS/epoch fanout 后所有设备上述活动为 0、lease 到期不挂载、CAS 失败诚实状态",
        requires: ["hiddenOffGlobalOffAllDevicesZero"],
        check: (o) => o.hiddenOffGlobalOffAllDevicesZero,
      },
      {
        id: "bt11_locked_core_drain_only",
        description: "已锁 formal core 只按原 contract drain，domain import/generation 可手动移交、Tutor 已取消",
        requires: ["lockedFormalCoreOnlyDrained"],
        check: (o) => o.lockedFormalCoreOnlyDrained,
      },
    ],
  },
  {
    id: "17.1-12",
    title: "新设备 account bootstrap",
    frozenText:
      "新设备认证后的 account state bootstrap；global off 解析前不挂载 authenticated Companion surface；未登录页只使用不关联身份的 local hide",
    mapsTo: "08-5 D3（新设备预解析零挂载）+ 07-8",
    assertions: [
      {
        id: "bt12_resolved_before_mount",
        description: "新设备认证后、global off 开关状态解析前不挂载 authenticated Companion surface",
        requires: ["newDeviceBootstrapResolvedBeforeMount"],
        check: (o) => o.newDeviceBootstrapResolvedBeforeMount,
      },
    ],
  },
  {
    id: "17.1-13",
    title: "A11y 焦点/读屏/zoom",
    frozenText:
      "onboarding tooltip/侧板焦点不陷阱、跳过一级动作、关闭后焦点返回、读屏 live region、200% zoom 与 390 px 不遮挡",
    mapsTo: "08-1 a11y-onboarding-audit + 04-6 alternative-inputs-a11y",
    assertions: [
      {
        id: "bt13_focus_not_trapped",
        description: "onboarding tooltip/侧板焦点不陷阱、跳过一级动作、关闭后焦点返回",
        requires: ["a11yFocusNotTrapped"],
        check: (o) => o.a11yFocusNotTrapped,
      },
      {
        id: "bt13_screen_reader",
        description: "读屏 live region 正确播报",
        requires: ["a11yScreenReaderLiveRegion"],
        check: (o) => o.a11yScreenReaderLiveRegion,
      },
      {
        id: "bt13_zoom_390",
        description: "200% zoom 与 390px 宽度下不遮挡主内容",
        requires: ["a11yZoom390NoOcclusion"],
        check: (o) => o.a11yZoom390NoOcclusion,
      },
    ],
  },
  {
    id: "17.1-14",
    title: "语音 Teach-back 全流程",
    frozenText: "语音 Teach-back、重录、确认、低置信和切模态",
    mapsTo: "04-1 voice-pipeline + 04-4 assessment-critic（低置信 → not_assessable）",
    assertions: [
      {
        id: "bt14_full_flow",
        description: "语音 Teach-back 全流程完成",
        requires: ["teachbackFullFlowCompleted"],
        check: (o) => o.teachbackFullFlowCompleted,
      },
      {
        id: "bt14_rerecord_confirm_low_confidence",
        description: "重录、确认、低置信与切模态路径安全（低置信不产生理解副作用）",
        requires: ["teachbackRerecordConfirmLowConfidenceSwitchSafe"],
        check: (o) => o.teachbackRerecordConfirmLowConfidenceSwitchSafe,
      },
    ],
  },
  {
    id: "17.1-15",
    title: "structured-proof-v1 bundle 完整性",
    frozenText:
      "structured-proof-v1 全 bundle、缺一 Scene、跨模态公平性，以及 ordering/graph/repair 的 formal/practice 两态",
    mapsTo: "09-1 多模态 Gold + 04-4 assessment-critic（rubric/facet 分层）",
    assertions: [
      {
        id: "bt15_bundle_complete",
        description: "structured-proof-v1 全 bundle 通过",
        requires: ["proofBundleComplete"],
        check: (o) => o.proofBundleComplete,
      },
      {
        id: "bt15_missing_scene",
        description: "缺一 Scene 时按冻结契约处理（不误判掌握）",
        requires: ["proofMissingSceneHandled"],
        check: (o) => o.proofMissingSceneHandled,
      },
      {
        id: "bt15_cross_modal_fairness",
        description: "ordering/graph/repair 的 formal/practice 两态按相同 rubric/facet 分层、模态间只比较相同 facet",
        requires: ["proofCrossModalFairness"],
        check: (o) => o.proofCrossModalFairness,
      },
    ],
  },
  {
    id: "17.1-16",
    title: "Public Scene 零 private 字段",
    frozenText: "Public Scene 的 network/RSC/prefetch/cache/DOM 零 private contract/solution/rubric/evidence 字段",
    mapsTo: "08-2 DOM Gold 双校验（allowlist + denylist）+ 05-2 scene-runtime",
    assertions: [
      {
        id: "bt16_public_scene_zero_private",
        description: "Public Scene 的 network/RSC/prefetch/cache/DOM 零 private contract/solution/rubric/evidence 字段",
        requires: ["publicSceneZeroPrivateFields"],
        check: (o) => o.publicSceneZeroPrivateFields,
      },
    ],
  },
  {
    id: "17.1-17",
    title: "assistance 先写后返回",
    frozenText: "用户请求提示时 assistance 先写后返回内容",
    mapsTo: "07-7 grounded-tutor（assistance 先落 audit/写后返回）",
    assertions: [
      {
        id: "bt17_assistance_write_before_return",
        description: "用户请求提示时 assistance 先写后返回内容",
        requires: ["assistanceWriteBeforeReturn"],
        check: (o) => o.assistanceWriteBeforeReturn,
      },
    ],
  },
  {
    id: "17.1-18",
    title: "多标签并发 reveal/lock/submit",
    frozenText: "同一 target 在多标签页/多设备并发 reveal/lock/submit",
    mapsTo: "06-4 race-rollback（contentExposureKey 竞态）+ 06-2（lock 先赢）",
    assertions: [
      {
        id: "bt18_multitab_exactly_once",
        description: "同一 target 多标签/多设备并发 reveal/lock/submit exactly-once、无重复副作用",
        requires: ["multitabRevealLockSubmitExactlyOnce"],
        check: (o) => o.multitabRevealLockSubmitExactlyOnce,
      },
    ],
  },
  {
    id: "17.1-19",
    title: "legacy/new exposure 竞态三组",
    frozenText:
      "legacy reveal → new Episode lock、new reveal → legacy submit、Scene/Rubric/policy rollover 三组共享 contentExposureKey 竞态",
    mapsTo: "06-4 evaluateContentExposureRace（三组竞态逐组判定）",
    assertions: [
      {
        id: "bt19_legacy_reveal_new_lock",
        description: "legacy reveal → new Episode lock 竞态正确（lock 必须看到 practice-only）",
        requires: ["exposureRaceLegacyRevealNewLockSafe"],
        check: (o) => o.exposureRaceLegacyRevealNewLockSafe,
      },
      {
        id: "bt19_new_reveal_legacy_submit",
        description: "new reveal → legacy submit 竞态正确（legacy submit 被阻止）",
        requires: ["exposureRaceNewRevealLegacySubmitSafe"],
        check: (o) => o.exposureRaceNewRevealLegacySubmitSafe,
      },
      {
        id: "bt19_rollover",
        description: "Scene/Rubric/policy rollover 竞态正确（新 lock 被阻止、已锁 artifact 冻结保留）",
        requires: ["exposureRaceRolloverSafe"],
        check: (o) => o.exposureRaceRolloverSafe,
      },
    ],
  },
  {
    id: "17.1-20",
    title: "lock 后不可变",
    frozenText: "first artifact lock 后 rubric/target/evidence 不能改变",
    mapsTo: "06-4 evaluateFrozenContentIntegrity（lock 后冻结内容不可变 → stale，0 正式副作用）",
    assertions: [
      {
        id: "bt20_locked_immutable",
        description: "first artifact lock 后 rubric/target/evidence 不能改变",
        requires: ["lockedArtifactImmutable"],
        check: (o) => o.lockedArtifactImmutable,
      },
    ],
  },
  {
    id: "17.1-21",
    title: "Supervisor turn/deadline 上限",
    frozenText: "Session Supervisor 最多 follow-up、最大 turns 和 deadline",
    mapsTo: "03-2 session-service（turn/deadline 上限）+ 03-6 budget-epoch-kill",
    assertions: [
      {
        id: "bt21_followup_turns_capped",
        description: "Session Supervisor 最多 follow-up 与最大 turns 上限执行",
        requires: ["supervisorFollowUpTurnsCapped"],
        check: (o) => o.supervisorFollowUpTurnsCapped,
      },
      {
        id: "bt21_deadline_enforced",
        description: "Session Supervisor deadline 强制执行",
        requires: ["supervisorDeadlineEnforced"],
        check: (o) => o.supervisorDeadlineEnforced,
      },
    ],
  },
  {
    id: "17.1-22",
    title: "Critic mandatory",
    frozenText: "Critic mandatory，Supervisor/Tutor 不能代签",
    mapsTo: "04-4 assessment-critic + 08-3 故障矩阵（Critic unavailable → evaluation_retryable，不由 Supervisor 替代）",
    assertions: [
      {
        id: "bt22_critic_mandatory",
        description: "正式评估 Critic mandatory，Supervisor/Tutor 不能代签",
        requires: ["criticMandatoryNoSubstitute"],
        check: (o) => o.criticMandatoryNoSubstitute,
      },
    ],
  },
  {
    id: "17.1-23",
    title: "multi-Episode partial commit",
    frozenText: "multi-Episode partial commit/stale/cancel",
    mapsTo: "06-2（单 Episode 幂等、独立 Episode 不回滚）+ 06-4 evaluateCancelSemantics（partial 明确标记）",
    assertions: [
      {
        id: "bt23_partial_marked",
        description: "multi-Episode partial commit 状态明确标记，不静默回滚",
        requires: ["partialCommitMarkedNotSilentlyRolledBack"],
        check: (o) => o.partialCommitMarkedNotSilentlyRolledBack,
      },
      {
        id: "bt23_no_cross_episode_rollback",
        description: "任一 Episode stale/cancel 不影响其它已 commit Episode",
        requires: ["partialCommitNoCrossEpisodeRollback"],
        check: (o) => o.partialCommitNoCrossEpisodeRollback,
      },
    ],
  },
  {
    id: "17.1-24",
    title: "schedule exactly-once 与 successor",
    frozenText: "input schedule exactly-once、恰好一个 successor、facet-only 零 schedule side effect",
    mapsTo: "06-4 evaluatePendingSingleConsumer + 06-2 planCommitSideEffects + 06-5 official-scheduler",
    assertions: [
      {
        id: "bt24_input_exactly_once",
        description: "input schedule exactly-once 消费",
        requires: ["inputScheduleExactlyOnce"],
        check: (o) => o.inputScheduleExactlyOnce,
      },
      {
        id: "bt24_successor_one",
        description: "消费后恰好一个 successor schedule",
        requires: ["exactlyOneSuccessor"],
        check: (o) => o.exactlyOneSuccessor,
      },
      {
        id: "bt24_facet_only_zero_side_effect",
        description: "facet-only 结果零 schedule 副作用",
        requires: ["facetOnlyZeroScheduleSideEffect"],
        check: (o) => o.facetOnlyZeroScheduleSideEffect,
      },
    ],
  },
  {
    id: "17.1-25",
    title: "disposition 矩阵",
    frozenText:
      "并发 create_initial、consume_pending exactly-once；完整 record_only/no_effect disposition 矩阵；未到期 user-selected 与 early-review policy",
    mapsTo: "06-3 disposition-coverage + 06-4（create/consume 并发）+ 06-2（disposition 六步优先级）",
    assertions: [
      {
        id: "bt25_create_consume_exactly_once",
        description: "并发 create_initial / consume_pending exactly-once",
        requires: ["createInitialConsumePendingExactlyOnce"],
        check: (o) => o.createInitialConsumePendingExactlyOnce,
      },
      {
        id: "bt25_record_only_no_effect_matrix",
        description: "完整 record_only / no_effect disposition 矩阵正确（0 学习副作用）",
        requires: ["recordOnlyNoEffectMatrixComplete"],
        check: (o) => o.recordOnlyNoEffectMatrixComplete,
      },
      {
        id: "bt25_early_review_policy",
        description: "未到期 user-selected 与 early-review policy 按冻结语义执行",
        requires: ["unexpiredUserSelectedEarlyReviewPolicyHeld"],
        check: (o) => o.unexpiredUserSelectedEarlyReviewPolicyHeld,
      },
    ],
  },
  {
    id: "17.1-26",
    title: "semantic relation 不可经验证路径 published",
    frozenText: "semantic relation candidate 无法通过验证路径 published（启用 Should flag 时）",
    mapsTo: "08-2 checkRelationCandidatePublish + relation-governance",
    assertions: [
      {
        id: "bt26_no_unverified_publish",
        description: "semantic relation candidate 无法通过任何未经审核/验证的路径 published",
        requires: ["relationNotPublishedViaUnverifiedPath"],
        check: (o) => o.relationNotPublishedViaUnverifiedPath,
      },
    ],
  },
  {
    id: "17.1-27",
    title: "hidden-answer 负向权限",
    frozenText: "companion hidden-answer 工具负向权限",
    mapsTo: "07-7 grounded-tutor（hidden-answer 工具负向权限：禁止泄题/禁止读取 hidden answer）",
    assertions: [
      {
        id: "bt27_hidden_answer_negative_permission",
        description: "companion hidden-answer 工具负向权限生效（不可读取/展示 hidden answer）",
        requires: ["hiddenAnswerNegativePermission"],
        check: (o) => o.hiddenAnswerNegativePermission,
      },
    ],
  },
  {
    id: "17.1-28",
    title: "问题标记 RLS",
    frozenText: "问题标记 user-private/RLS/export/delete（启用 Should flag 时）",
    mapsTo: "02-2 RLS 矩阵 + 02-4 audit-privacy-lifecycle（user-private/export/delete）",
    assertions: [
      {
        id: "bt28_flag_rls",
        description: "问题标记 user-private/RLS 隔离、支持 export/delete",
        requires: ["flagRlsUserPrivateExportDelete"],
        check: (o) => o.flagRlsUserPrivateExportDelete,
      },
    ],
  },
  {
    id: "17.1-29",
    title: "四 origin 就地完成",
    frozenText: "Card/Review/Now/Star 四种 origin 的就地完成、可选查看星图和事件驱动变化",
    mapsTo: "07-6 star-map（事件驱动变化）+ 05-2 scene-runtime（就地完成）",
    assertions: [
      {
        id: "bt29_four_origin_in_place",
        description: "Card/Review/Now/Star 四种 origin 均可就地完成",
        requires: ["fourOriginInPlaceCompletion"],
        check: (o) => o.fourOriginInPlaceCompletion,
      },
      {
        id: "bt29_event_driven_star",
        description: "完成后可选查看星图且星图变化由事件驱动",
        requires: ["fourOriginEventDrivenStarUpdate"],
        check: (o) => o.fourOriginEventDrivenStarUpdate,
      },
    ],
  },
  {
    id: "17.1-30",
    title: "无键盘主路径",
    frozenText: "所有入口无键盘主路径",
    mapsTo: "04-6 alternative-inputs-a11y + 08-1 a11y-onboarding-audit",
    assertions: [
      {
        id: "bt30_keyboardless_main_path",
        description: "所有入口均有无键盘主路径",
        requires: ["keyboardlessMainPath"],
        check: (o) => o.keyboardlessMainPath,
      },
    ],
  },
  {
    id: "17.1-31",
    title: "无任务债务文案",
    frozenText: "长时间回归无任务债务文案",
    mapsTo: "01-5 §5.2（不得制造 streak/任务债务/伴侣催促文案）+ 09 回归验证",
    assertions: [
      {
        id: "bt31_no_task_debt_copy",
        description: "长时间回归中不出现任务债务/催促类文案",
        requires: ["noTaskDebtCopy"],
        check: (o) => o.noTaskDebtCopy,
      },
    ],
  },
  {
    id: "17.1-32",
    title: "temporary_hidden/global_off 完整边界",
    frozenText:
      "temporary_hidden 时手动产品完整，当前 device session 的页面 context listener/DTO、角色/声音/应用内邀请/应用内通知/预取/后台调用为 0，另行 opt-in 的系统 push 偏好不变；global_off 时上述边界扩展到全部设备，且 Companion 系统 push 为 0",
    mapsTo: "08-5 D1（temporary_hidden/global_off 零活动矩阵）+ 01-5 §5.3",
    assertions: [
      {
        id: "bt32_manual_complete",
        description: "temporary_hidden 时手动产品完整、opt-in 系统 push 偏好不变",
        requires: ["temporaryHiddenManualProductComplete"],
        check: (o) => o.temporaryHiddenManualProductComplete,
      },
      {
        id: "bt32_device_session_zero",
        description: "temporary_hidden 确认后当前 device session 的 listener/DTO/角色/声音/邀请/通知/预取/后台调用为 0",
        requires: ["temporaryHiddenDeviceSessionZeroActivity"],
        check: (o) => o.temporaryHiddenDeviceSessionZeroActivity,
      },
      {
        id: "bt32_global_off_all_devices_and_push_zero",
        description: "global_off 后边界扩展到全部设备且 Companion 系统 push 为 0",
        requires: ["globalOffAllDevicesAndPushZero"],
        check: (o) => o.globalOffAllDevicesAndPushZero,
      },
    ],
  },
  {
    id: "17.1-33",
    title: "transcript 治理",
    frozenText:
      "transcript revision、raw audio TTL、全复制面 transcript redaction/残留扫描、semantic re-audit 与 learning-result/schedule invalidation",
    mapsTo: "04-5 redaction-two-level-replay + 04-2 voice-artifact-governance（raw audio TTL）",
    assertions: [
      {
        id: "bt33_revision",
        description: "transcript revision 治理（修订可追溯、旧版本清理）",
        requires: ["transcriptRevisionHandled"],
        check: (o) => o.transcriptRevisionHandled,
      },
      {
        id: "bt33_raw_audio_ttl",
        description: "raw audio 超过冻结 TTL 即删除",
        requires: ["rawAudioTtlEnforced"],
        check: (o) => o.rawAudioTtlEnforced,
      },
      {
        id: "bt33_all_copy_surfaces_redacted",
        description: "全复制面 transcript redaction 与残留扫描通过、learning-result/schedule 失效正确",
        requires: ["allCopySurfacesRedacted"],
        check: (o) => o.allCopySurfacesRedacted,
      },
    ],
  },
  {
    id: "17.1-34",
    title: "kill/cancel/stale/publish 与 COMMIT 交错",
    frozenText:
      "kill/cancel/stale/publish 与 COMMIT 的双顺序交错、late Provider/Critic response、soft drain 与 legacy reader compatibility",
    mapsTo: "06-4 race-rollback（late response after hard kill）+ 06-2（CAS 单点归因）+ 08-3（交错演练）+ 02-9（legacy reader 兼容）",
    assertions: [
      {
        id: "bt34_interleave_safe",
        description: "kill/cancel/stale/publish 与 COMMIT 双顺序交错全部安全（0 重复副作用）",
        requires: ["killCancelStalePublishCommitInterleaveSafe"],
        check: (o) => o.killCancelStalePublishCommitInterleaveSafe,
      },
      {
        id: "bt34_late_response",
        description: "late Provider/Critic response 被丢弃且不写状态、不触发后续 job",
        requires: ["lateProviderCriticResponseHandled"],
        check: (o) => o.lateProviderCriticResponseHandled,
      },
      {
        id: "bt34_soft_drain_legacy_reader",
        description: "soft drain 后 legacy reader 仍可读 pending schedule/attempt/结果",
        requires: ["softDrainLegacyReaderCompatible"],
        check: (o) => o.softDrainLegacyReaderCompatible,
      },
    ],
  },
  {
    id: "17.1-35",
    title: "root capability 反向依赖闭包与原子 apply/rollback",
    frozenText:
      "root capability 关闭的反向依赖闭包、单 config revision 原子 apply/rollback、任一节点失败整体回滚，以及运行中从不暴露非法 flag 组合",
    mapsTo: "01-7 feature-flags-capability-bundles（root capability 反向依赖闭包 + 单 revision 原子 apply）",
    assertions: [
      {
        id: "bt35_reverse_dependency_closure",
        description: "root capability 关闭时反向依赖闭包完整计算",
        requires: ["rootCapabilityReverseDependencyClosure"],
        check: (o) => o.rootCapabilityReverseDependencyClosure,
      },
      {
        id: "bt35_single_revision_atomic",
        description: "单 config revision 原子 apply（一个 revision 整体生效）",
        requires: ["singleConfigRevisionAtomicApply"],
        check: (o) => o.singleConfigRevisionAtomicApply,
      },
      {
        id: "bt35_all_or_nothing",
        description: "apply 任一节点失败整体回滚",
        requires: ["applyRollbackAllOrNothing"],
        check: (o) => o.applyRollbackAllOrNothing,
      },
      {
        id: "bt35_no_illegal_flag_combo",
        description: "运行中从不暴露非法 flag 组合",
        requires: ["noIllegalFlagCombinationExposed"],
        check: (o) => o.noIllegalFlagCombinationExposed,
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// 六、单条判定（纯函数，fail closed）
// ═══════════════════════════════════════════════════════════════════════════

export interface AssertionResult {
  assertionId: string;
  description: string;
  passed: boolean;
}

export interface InvariantEvaluation {
  /** 对应 spec 的 id（`16.1-z01` / `17.1-01` 等） */
  specId: string;
  /** 该条对应的 spec 引用 */
  spec: HardInvariantSpec | MustTestBehaviorSpec;
  passed: boolean;
  assertionResults: readonly AssertionResult[];
  failedAssertionIds: readonly string[];
}

function judgeAssertions<Obs>(
  assertions: readonly HardInvariantAssertion<Obs>[],
  observations: Obs,
): {
  passed: boolean;
  assertionResults: readonly AssertionResult[];
  failedAssertionIds: readonly string[];
} {
  const assertionResults: AssertionResult[] = assertions.map((a) => ({
    assertionId: a.id,
    description: a.description,
    passed: a.check(observations),
  }));
  const failedAssertionIds = assertionResults
    .filter((r) => !r.passed)
    .map((r) => r.assertionId);
  return {
    passed: failedAssertionIds.length === 0,
    assertionResults,
    failedAssertionIds,
  };
}

/** §16.1 单条硬指标判定：全部断言满足才 pass（0 容忍 / 100% 均 fail closed）。 */
export function evaluateHardInvariant(
  spec: HardInvariantSpec,
  observations: Section161Observations,
): InvariantEvaluation {
  const { passed, assertionResults, failedAssertionIds } = judgeAssertions(
    spec.assertions,
    observations,
  );
  return { specId: spec.id, spec, passed, assertionResults, failedAssertionIds };
}

/** §17.1 单条必测行为判定：全部断言满足才 pass（fail closed）。 */
export function evaluateMustTestBehavior(
  spec: MustTestBehaviorSpec,
  observations: Section171Observations,
): InvariantEvaluation {
  const { passed, assertionResults, failedAssertionIds } = judgeAssertions(
    spec.assertions,
    observations,
  );
  return { specId: spec.id, spec, passed, assertionResults, failedAssertionIds };
}

// ═══════════════════════════════════════════════════════════════════════════
// 七、无 placeholder / skip / insufficient-data 伪通过检查
// ═══════════════════════════════════════════════════════════════════════════

export type FakePassKind = "placeholder" | "skip" | "insufficient-data";

export interface FakePassIssue {
  specId: string;
  /** 有问题的断言 id；spec 级问题（断言列表为空）用 `"*"`。 */
  assertionId: string;
  kind: FakePassKind;
  detail: string;
  /** 该断言在判定运行时实际读取的观察字段（点号路径）。 */
  fieldsRead: readonly string[];
}

/**
 * 用 Proxy 观测断言判定运行时实际读取的观察字段（确定性、无副作用）。
 * proxy 对任意键都返回一个 truthy 的嵌套 proxy，因此布尔/字符串/对象字段
 * 的读取都会被记录；断言判定结果本身无关紧要（只关心读取路径）。
 */
export function probeReadFields<Obs>(check: (obs: Obs) => boolean): readonly string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  const makeProxy = (path: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, key) {
        if (typeof key === "symbol") return undefined;
        const next = path.length === 0 ? String(key) : `${path}.${String(key)}`;
        if (!seen.has(next)) {
          seen.add(next);
          fields.push(next);
        }
        return makeProxy(next);
      },
    };
    return new Proxy(function noop() {}, handler);
  };
  // 运行一次判定以采集其真实读取的字段（结果不用于通过/失败判定）。
  void check(makeProxy("") as Obs);
  return fields;
}

/**
 * 伪通过检查（确定性纯函数）。对每条 spec 的每条断言判定：
 * - 断言列表为空 → `placeholder`（空实现占位，没有任何实际判定）；
 * - `requires` 为空 → `insufficient-data`（未声明证据依赖）；
 * - 判定运行时未读取任何观察字段 → `skip`（恒真占位，无条件通过）；
 * - 声明的 `requires` 字段未被判定实际读取 → `insufficient-data`
 *   （声明证据与实际判定不一致，可能是写错字段名或短路漏读）。
 * 无问题返回空数组。此检查是 `runHardInvariantCloseout` 的常驻环节——
 * 任何伪通过都会让 `summary.allClosed` 变为 false。
 */
export function detectFakePass<Obs>(
  spec: { id: string; assertions: readonly HardInvariantAssertion<Obs>[] },
): readonly FakePassIssue[] {
  const issues: FakePassIssue[] = [];
  if (spec.assertions.length === 0) {
    issues.push({
      specId: spec.id,
      assertionId: "*",
      kind: "placeholder",
      detail: "断言列表为空：没有任何实际断言（空实现占位，不具备判定能力）",
      fieldsRead: [],
    });
    return issues;
  }
  for (const assertion of spec.assertions) {
    if (assertion.requires.length === 0) {
      issues.push({
        specId: spec.id,
        assertionId: assertion.id,
        kind: "insufficient-data",
        detail: "未声明该断言依赖的证据字段（requires 为空）",
        fieldsRead: [],
      });
      continue;
    }
    const fieldsRead = probeReadFields(assertion.check);
    if (fieldsRead.length === 0) {
      issues.push({
        specId: spec.id,
        assertionId: assertion.id,
        kind: "skip",
        detail: "判定未读取任何观察字段（恒真占位，等同于无条件通过）",
        fieldsRead: [],
      });
      continue;
    }
    const missing = assertion.requires.filter((f) => !fieldsRead.includes(f));
    if (missing.length > 0) {
      issues.push({
        specId: spec.id,
        assertionId: assertion.id,
        kind: "insufficient-data",
        detail: `声明的证据字段未被判定实际读取：${missing.join(", ")}`,
        fieldsRead,
      });
    }
  }
  return issues;
}

// ═══════════════════════════════════════════════════════════════════════════
// 八、收口编排与断言
// ═══════════════════════════════════════════════════════════════════════════

export interface InvariantCloseoutInput {
  section161: Section161Observations;
  section171: Section171Observations;
}

export interface InvariantCloseoutSummary {
  /** §16.1 硬指标总数（22） */
  invariantTotal: number;
  /** §16.1 通过的硬指标数 */
  invariantPassed: number;
  /** 0 容忍项违反的 id（= 0 即全部关闭） */
  zeroToleranceViolatedIds: readonly string[];
  /** 100% 项未达成的 id */
  percent100FailedIds: readonly string[];
  /** §17.1 必测行为总数（35） */
  behaviorsTotal: number;
  /** §17.1 通过的必测行为数 */
  behaviorsPassed: number;
  /** §17.1 未通过的必测行为 id */
  behaviorsFailedIds: readonly string[];
  /** 缺测的 §16.1 硬指标 id（清单被裁剪为空/缺项 → 不得静默通过，见 08-3 空 runs 教训） */
  missingInvariantIds: readonly string[];
  /** 缺测的 §17.1 必测行为 id */
  missingBehaviorIds: readonly string[];
  /** 伪通过问题数（placeholder + skip + insufficient-data） */
  fakePassCount: number;
  /**
   * 全部硬不变量关闭：
   * §16.1 全部通过（0 容忍 0 违规 + 100% 项 100%）且 §17.1 全部通过且
   * 无缺测、无伪通过。
   */
  allClosed: boolean;
  /** 任何硬指标违反或伪通过 → 立即回滚评估。 */
  rollbackEvaluationRequired: boolean;
}

export interface InvariantCloseoutReport {
  invariants: readonly InvariantEvaluation[];
  behaviors: readonly InvariantEvaluation[];
  fakePass: readonly FakePassIssue[];
  summary: InvariantCloseoutSummary;
}

/**
 * 收口编排（纯函数）：对 §16.1 全部 22 项与 §17.1 全部 35 条逐项判定，
 * 并常驻运行伪通过检查；汇总 `allClosed` 与 `rollbackEvaluationRequired`。
 */
export function runHardInvariantCloseout(
  input: InvariantCloseoutInput,
  section161: readonly HardInvariantSpec[] = HARD_INVARIANTS_16_1,
  section171: readonly MustTestBehaviorSpec[] = MUST_TEST_BEHAVIORS_17_1,
): InvariantCloseoutReport {
  const invariants = section161.map((spec) =>
    evaluateHardInvariant(spec, input.section161),
  );
  const behaviors = section171.map((spec) =>
    evaluateMustTestBehavior(spec, input.section171),
  );
  const fakePass = [
    ...section161.map((spec) => detectFakePass(spec)),
    ...section171.map((spec) => detectFakePass(spec)),
  ].flat();

  const failedInvariantIds = invariants
    .filter((i) => !i.passed)
    .map((i) => i.specId);
  const zeroToleranceViolatedIds = section161
    .filter((s) => s.tolerance === "zero" && failedInvariantIds.includes(s.id))
    .map((s) => s.id);
  const percent100FailedIds = section161
    .filter((s) => s.tolerance === "percent100" && failedInvariantIds.includes(s.id))
    .map((s) => s.id);
  const behaviorsFailedIds = behaviors
    .filter((b) => !b.passed)
    .map((b) => b.specId);
  // 清单完整性防御：传入清单缺项/被裁剪为空 → 缺测，不得静默通过
  // （同 08-3 对空 runs 的 security_review MEDIUM 修复精神）。
  const missingInvariantIds = HARD_INVARIANTS_16_1.filter(
    (s) => !section161.some((p) => p.id === s.id),
  ).map((s) => s.id);
  const missingBehaviorIds = MUST_TEST_BEHAVIORS_17_1.filter(
    (s) => !section171.some((p) => p.id === s.id),
  ).map((s) => s.id);

  const allClosed =
    failedInvariantIds.length === 0 &&
    behaviorsFailedIds.length === 0 &&
    missingInvariantIds.length === 0 &&
    missingBehaviorIds.length === 0 &&
    fakePass.length === 0;

  const summary: InvariantCloseoutSummary = {
    invariantTotal: section161.length,
    invariantPassed: invariants.filter((i) => i.passed).length,
    zeroToleranceViolatedIds,
    percent100FailedIds,
    behaviorsTotal: section171.length,
    behaviorsPassed: behaviors.filter((b) => b.passed).length,
    behaviorsFailedIds,
    missingInvariantIds,
    missingBehaviorIds,
    fakePassCount: fakePass.length,
    allClosed,
    rollbackEvaluationRequired: !allClosed,
  };

  return { invariants, behaviors, fakePass, summary };
}

/** 收口 0 容忍 fail closed：未全部关闭时抛出的确定性失败。 */
export class HardInvariantCloseoutFailure extends Error {
  constructor(public readonly report: InvariantCloseoutReport) {
    super(
      `hard invariant closeout failed: ` +
        `zeroViolated=${report.summary.zeroToleranceViolatedIds.join(",") || "-"}, ` +
        `percent100Failed=${report.summary.percent100FailedIds.join(",") || "-"}, ` +
        `behaviorsFailed=${report.summary.behaviorsFailedIds.join(",") || "-"}, ` +
        `missingInvariants=${report.summary.missingInvariantIds.join(",") || "-"}, ` +
        `missingBehaviors=${report.summary.missingBehaviorIds.join(",") || "-"}, ` +
        `fakePass=${report.summary.fakePassCount}`,
    );
    this.name = "HardInvariantCloseoutFailure";
  }
}

/** 断言收口全部关闭；任一硬指标违反、必测行为未通过或伪通过即抛错。 */
export function assertHardInvariantCloseout(report: InvariantCloseoutReport): void {
  if (!report.summary.allClosed) {
    throw new HardInvariantCloseoutFailure(report);
  }
}
