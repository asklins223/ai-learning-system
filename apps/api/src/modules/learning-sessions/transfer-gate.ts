/**
 * transfer-gate.ts（阶段 06 / W5，任务 06-6）
 *
 * 单 Key Point transfer 最小切片守卫（01-2 §14.1/§7.4/§8.3，06-w5 任务 06-6）。
 * 全部为纯函数：不读时钟、不改状态、不调外部服务、不写掌握/schedule 真值。
 *
 * 核心不变量（验收）：
 * - transfer（试着应用）只在**完整 rubric/evidence** 下开放：rubric 或 evidence
 *   任一不完整 → disposition=`unavailable`（fail closed，无任何学习/schedule 副作用）；
 * - transfer 三种形态：`situated_application`（单 Key Point 情境）、
 *   `repair`（故障修复）、`boundary_variant`（边界变式）；
 * - **默认 `record_only` 写 facet**：只有 official policy 签发
 *   `create_initial`/`consume_pending` 且**完整 mastery plan 通过**时才影响
 *   schedule；否则 effectiveAuthorizedAction 降级为 `record_only`
 *   （0 schedule 副作用，facet-to-mastery-policy-v1 §8.3）；
 * - `explore`（随便看看）：听解释、证据浏览、开放问题、沙盘一律
 *   `practice_only` + `no_effect`，不消费 schedule。
 *
 * 收口迁移说明：authorizedAction / transfer 形态 / explore 模式的最小契约暂在
 * 本文件本地声明（structural 同型于 packages/shared/src/scene-contracts.ts 的
 * PrivateLearningEpisodeContract.schedulingDecision.authorizedAction）；
 * 主代理收口后应迁移到 @ailearn/shared。
 */

// ─── 枚举 ─────────────────────────────────────────────────────────────────

export const TransferForm = {
  /** 单 Key Point 情境应用（演：多步情境决策，01-2 §6.1/§6.2） */
  SITUATED_APPLICATION: "situated_application",
  /** 故障修复（修：定位并修复错误流程/论证/代码轨迹，01-2 §6.1） */
  REPAIR: "repair",
  /** 边界变式（演：条件变式/后果预测/反例构造，01-2 §6.2） */
  BOUNDARY_VARIANT: "boundary_variant",
} as const;
export type TransferForm = (typeof TransferForm)[keyof typeof TransferForm];

export const AuthorizedAction = {
  CREATE_INITIAL: "create_initial",
  CONSUME_PENDING: "consume_pending",
  RECORD_ONLY: "record_only",
  NO_EFFECT: "no_effect",
} as const;
export type AuthorizedAction = (typeof AuthorizedAction)[keyof typeof AuthorizedAction];

export const TransferDisposition = {
  /** 不可达：rubric/evidence 不完整或形态非法（fail closed，无副作用） */
  UNAVAILABLE: "unavailable",
  /** official create_initial/consume_pending 且完整 mastery plan 通过 → 影响 schedule */
  MASTERY_TRANSFER: "mastery_transfer",
  /** 默认 record_only → 只写 facet evidence，0 schedule */
  FACET_OBSERVATION: "facet_observation",
  /** official no_effect（practice 路径）→ 0 facet、0 schedule */
  PRACTICE_ONLY: "practice_only",
} as const;
export type TransferDisposition =
  (typeof TransferDisposition)[keyof typeof TransferDisposition];

export const TransferSceneKind = {
  /** 单 Key Point 情境应用 → 多步情境 Scene（sceneType=multi_step_scenario） */
  MULTI_STEP_SCENARIO: "multi_step_scenario",
  /** 故障修复 → 修复 Scene（sceneType=repair） */
  REPAIR: "repair",
  /** 边界变式 → 条件变式/反例 Scene（sceneType=counterexample 或 conditional-variant 模板） */
  CONDITIONAL_VARIANT: "conditional_variant",
} as const;
export type TransferSceneKind = (typeof TransferSceneKind)[keyof typeof TransferSceneKind];

export const ExploreMode = {
  /** 听解释（TTS 播放摘要/论点/证据；按实际暴露内容记录 exposure） */
  EXPLANATION: "explanation",
  /** 证据浏览（展开 exact evidence 与 semantic support） */
  EVIDENCE_BROWSE: "evidence_browse",
  /** 开放问题（问题标记；Should flag 开启才持久保存） */
  OPEN_QUESTION: "open_question",
  /** 沙盘（练习/示例材料，固定标记 practice_only） */
  SANDBOX: "sandbox",
} as const;
export type ExploreMode = (typeof ExploreMode)[keyof typeof ExploreMode];

// ─── 输入 / 输出 ────────────────────────────────────────────────────────────

export interface TransferGateInput {
  keyPointId: string;
  /** 完整 rubric：全部 required rubric targets 已冻结且可评估（01-2 §7.1/§7.5） */
  rubricComplete: boolean;
  /** 完整 evidence：canonical evidence 完整且非空（RubricTarget.evidenceRefIds 覆盖，01-2 §5） */
  evidenceComplete: boolean;
  /** transfer 三种形态之一 */
  transferForm: TransferForm;
  /** official policy 签发的事前最大授权（01-2 §5.2；pre-exposure 冻结） */
  authorizedAction: AuthorizedAction;
  /** 完整 mastery plan 是否通过（voice_mastery / structured_mastery_bundle 全量通过） */
  masteryPlanPassed: boolean;
}

export interface TransferGateVerdict {
  keyPointId: string;
  transferForm: TransferForm;
  /** 是否在完整 rubric/evidence 下开放（transfer 的最小切片前提） */
  accessible: boolean;
  disposition: TransferDisposition;
  /** 最终生效授权：mastery 未通过时 create/consume 降级为 record_only */
  effectiveAuthorizedAction: AuthorizedAction;
  /** true 仅当 official create_initial/consume_pending 且完整 mastery plan 通过 */
  scheduleAffected: boolean;
  /** 形态对应的 Scene 种类（供 Supervisor 选择 Scene 模板，01-2 §6.2） */
  sceneKind: TransferSceneKind;
  reasonCodes: string[];
}

export interface ExploreAccessVerdict {
  mode: ExploreMode;
  /** explore 不要求 rubric/evidence 完整；但非法 mode fail closed */
  allowed: boolean;
  disposition: "practice_only";
  effectiveAuthorizedAction: "no_effect";
  scheduleAffected: false;
  reasonCodes: string[];
}

// ─── 运行时校验守卫（fail closed 兜底）─────────────────────────────────────

function isTransferForm(value: unknown): value is TransferForm {
  return (
    typeof value === "string" &&
    (Object.values(TransferForm) as readonly string[]).includes(value)
  );
}

function isAuthorizedAction(value: unknown): value is AuthorizedAction {
  return (
    typeof value === "string" &&
    (Object.values(AuthorizedAction) as readonly string[]).includes(value)
  );
}

function isExploreMode(value: unknown): value is ExploreMode {
  return (
    typeof value === "string" &&
    (Object.values(ExploreMode) as readonly string[]).includes(value)
  );
}

// ─── 形态 → Scene 种类映射（01-2 §6.1/§6.2）─────────────────────────────────

const TRANSFER_SCENE_KIND: Readonly<Record<TransferForm, TransferSceneKind>> = {
  [TransferForm.SITUATED_APPLICATION]: TransferSceneKind.MULTI_STEP_SCENARIO,
  [TransferForm.REPAIR]: TransferSceneKind.REPAIR,
  [TransferForm.BOUNDARY_VARIANT]: TransferSceneKind.CONDITIONAL_VARIANT,
};

// ─── 主守卫：evaluateTransferAccess ─────────────────────────────────────────

/**
 * 单 Key Point transfer 最小切片守卫（纯函数）：
 *
 * 1. 非法 transferForm → `unavailable`（fail closed）；
 * 2. rubric 或 evidence 任一不完整 → `unavailable`，不产生任何学习/schedule 副作用
 *    （transfer 只在完整 rubric/evidence 下开放，验收硬约束）；
 * 3. 完整前提下：
 *    - official `create_initial`/`consume_pending` **且** 完整 mastery plan 通过
 *      → `mastery_transfer`，`scheduleAffected=true`（create/consume 后恰好一个
 *      active/successor schedule，同 generation exactly-once，01-2 §8.3/§8.5）；
 *    - official `no_effect`（practice 路径）→ `practice_only`，0 facet、0 schedule；
 *    - 其余全部（默认，包括 create/consume 但 mastery 未通过）→ `facet_observation`
 *      以 `record_only` 写 facet，0 schedule（默认 record_only 语义）。
 */
export function evaluateTransferAccess(input: TransferGateInput): TransferGateVerdict {
  const reasonCodes: string[] = [];

  if (!isTransferForm(input.transferForm)) {
    return {
      keyPointId: input.keyPointId,
      transferForm: input.transferForm,
      accessible: false,
      disposition: TransferDisposition.UNAVAILABLE,
      effectiveAuthorizedAction: AuthorizedAction.RECORD_ONLY,
      scheduleAffected: false,
      sceneKind: TransferSceneKind.MULTI_STEP_SCENARIO,
      reasonCodes: ["invalid_transfer_form"],
    };
  }

  const sceneKind = TRANSFER_SCENE_KIND[input.transferForm];

  if (!input.rubricComplete) {
    reasonCodes.push("incomplete_rubric_transfer_unavailable");
  }
  if (!input.evidenceComplete) {
    reasonCodes.push("incomplete_evidence_transfer_unavailable");
  }
  const accessible = input.rubricComplete && input.evidenceComplete;

  if (!accessible) {
    return {
      keyPointId: input.keyPointId,
      transferForm: input.transferForm,
      accessible: false,
      disposition: TransferDisposition.UNAVAILABLE,
      effectiveAuthorizedAction: AuthorizedAction.RECORD_ONLY,
      scheduleAffected: false,
      sceneKind,
      reasonCodes,
    };
  }

  if (!isAuthorizedAction(input.authorizedAction)) {
    // 非官方 policy 签发的授权视为缺省：默认 record_only 写 facet，0 schedule。
    reasonCodes.push("non_official_authorized_action_default_record_only");
    return {
      keyPointId: input.keyPointId,
      transferForm: input.transferForm,
      accessible: true,
      disposition: TransferDisposition.FACET_OBSERVATION,
      effectiveAuthorizedAction: AuthorizedAction.RECORD_ONLY,
      scheduleAffected: false,
      sceneKind,
      reasonCodes,
    };
  }

  const isMasteryAuthorization =
    input.authorizedAction === AuthorizedAction.CREATE_INITIAL ||
    input.authorizedAction === AuthorizedAction.CONSUME_PENDING;

  if (isMasteryAuthorization && input.masteryPlanPassed) {
    reasonCodes.push(`transfer_mastery_authorized:${input.authorizedAction}`);
    return {
      keyPointId: input.keyPointId,
      transferForm: input.transferForm,
      accessible: true,
      disposition: TransferDisposition.MASTERY_TRANSFER,
      effectiveAuthorizedAction: input.authorizedAction,
      scheduleAffected: true,
      sceneKind,
      reasonCodes,
    };
  }

  if (input.authorizedAction === AuthorizedAction.NO_EFFECT) {
    reasonCodes.push("transfer_practice_only_official_no_effect");
    return {
      keyPointId: input.keyPointId,
      transferForm: input.transferForm,
      accessible: true,
      disposition: TransferDisposition.PRACTICE_ONLY,
      effectiveAuthorizedAction: AuthorizedAction.NO_EFFECT,
      scheduleAffected: false,
      sceneKind,
      reasonCodes,
    };
  }

  // 默认 record_only：写 facet，0 schedule。
  if (isMasteryAuthorization && !input.masteryPlanPassed) {
    reasonCodes.push("transfer_mastery_plan_not_passed_downgraded_to_record_only");
  } else {
    reasonCodes.push("transfer_default_facet_record_only");
  }
  return {
    keyPointId: input.keyPointId,
    transferForm: input.transferForm,
    accessible: true,
    disposition: TransferDisposition.FACET_OBSERVATION,
    effectiveAuthorizedAction: AuthorizedAction.RECORD_ONLY,
    scheduleAffected: false,
    sceneKind,
    reasonCodes,
  };
}

// ─── explore 守卫：evaluateExploreAccess ────────────────────────────────────

/**
 * explore（随便看看）守卫（纯函数）：听解释、证据浏览、开放问题、沙盘
 * 全部 practice-only、不消费 schedule。explore 不要求 rubric/evidence 完整；
 * 非法 mode fail closed（allowed=false）。
 */
export function evaluateExploreAccess(mode: ExploreMode): ExploreAccessVerdict {
  if (!isExploreMode(mode)) {
    return {
      mode,
      allowed: false,
      disposition: "practice_only",
      effectiveAuthorizedAction: "no_effect",
      scheduleAffected: false,
      reasonCodes: ["invalid_explore_mode"],
    };
  }
  return {
    mode,
    allowed: true,
    disposition: "practice_only",
    effectiveAuthorizedAction: "no_effect",
    scheduleAffected: false,
    reasonCodes: ["explore_practice_only_no_schedule_effect"],
  };
}
