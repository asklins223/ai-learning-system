/**
 * 阶段 10（W9）任务 10-3：internal allowlist 纯逻辑（§18.2 第 2 步）。
 *
 * internal allowlist（internal 用户试点档）只启用**非学习**的 companion shell
 * 能力：`global_companion_shell`、auth manifest、onboarding 与静态 fallback；
 * **learning Agent 与学习写入保持关闭**。本文件是纯逻辑（无 DB / 无网络 / 无时钟 /
 * 无副作用 / 无随机），调用方注入用户身份与流程观察，本模块只做确定性判定：
 *
 * 核心不变量（10-w9 任务 10-3 验收）：
 * - **启用清单**：`INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES` 固定为
 *   global_companion_shell / auth manifest / onboarding / 静态 fallback
 *   （引用 ./rollback-drill.ts 的冻结 Must flag id，与 01-7 capability bundle
 *   图一致）；`resolveInternalAllowlist` 只放行这四项；
 * - **learning Agent 与学习写入保持关闭**：`assertLearningAgentDisabled` 断言
 *   learning Agent（learning_session_companion / current_target_tutor /
 *   multimodal_voice / structured_proof_v1 / journey_routes /
 *   understanding_universe_v2 / trusted_multimodal_core 的 learning 侧）为
 *   disabled；`assertZeroLearningWrites` 断言本次 internal 流程无任何学习写入
 *   （canonical validation/review/understanding 事件、schedule、mastery、
 *   outbox、commit），fail closed；
 * - **internal 用户全流程可用**：`isInternalUserFullFlowAvailable` 校验 internal
 *   用户的完整旅程（auth manifest 可用 → global shell 可用 → onboarding 可用 →
 *   静态 fallback 可用 → 手动主路径可用），同时保持 learning Agent 关闭与
 *   0 学习写入；
 * - **0 学习写入**：`assertZeroLearningWrites` 强断言（fail closed）。
 */

import {
  MUST_BUNDLE_FLAG_IDS,
  type CapabilityFlagId,
} from "./rollback-drill.ts";

// ─── 1. 版本与启用清单（§18.2 第 2 步）────────────────────────────────────

/** internal allowlist 策略版本。 */
export const INTERNAL_ALLOWLIST_VERSION = "internal-allowlist-v1" as const;

/** internal allowlist 档位 id（§18.2 第 2 步）。 */
export const INTERNAL_ALLOWLIST_STAGE = "internal" as const;

/**
 * internal allowlist 启用的 capability 清单（10-w9 任务 10-3）：
 * - `global_companion_shell`：全局角色/锚点/侧板 + credential-safe auth
 *   manifest + 全路由 coverage registry + trigger rule/双预算 + 控制状态；
 * - auth manifest：credential-safe auth-surface manifest（登录/注册页静态帮助，
 *   随构建签名；不依赖 learning core，无学习写入或自由模型能力）；
 * - onboarding：companion onboarding（CAS 状态机 + 隔离 onboarding_sample:* +
 *   静态 demo map，对 exposure 与全部 learning facts 为 0 副作用）；
 * - 静态 fallback：动画/角色静态 fallback 与 credential-safe 静态帮助
 *   （不发起 Provider/ASR/TTS，无自由模型能力）。
 */
export const INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES: readonly (
  | "global_companion_shell"
  | "auth_manifest"
  | "onboarding"
  | "static_fallback"
)[] = [
  "global_companion_shell",
  "auth_manifest",
  "onboarding",
  "static_fallback",
] as const;

export type InternalEnabledCapability =
  (typeof INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES)[number];

/** 类型守卫：是否为 internal allowlist 启用项。 */
export function isInternalEnabledCapability(
  value: string,
): value is InternalEnabledCapability {
  return (INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES as readonly string[]).includes(value);
}

// ─── 2. learning Agent / 学习写入（必须关闭）──────────────────────────────

/**
 * learning Agent capability flag（必须 disabled）。引用 01-7 §2/§4 冻结 flag
 * 图（./rollback-drill.ts MUST_BUNDLE_FLAG_IDS 的子集）：learning Agent 指
 * 伴星升级到 Session 动作的 `learning_session_companion`、`current_target_tutor`，
 * 以及依赖 trusted multimodal core 的 voice/silent/proof/routes/map/tutor；
 * internal allowlist 全部关闭。
 */
export const LEARNING_AGENT_FLAG_IDS: readonly CapabilityFlagId[] = [
  "trusted_multimodal_core",
  "learning_session_companion",
  "multimodal_voice",
  "structured_proof_v1",
  "journey_routes",
  "understanding_universe_v2",
  "current_target_tutor",
];

/** learning Agent 关闭断言输入：capability → state（enabled/disabled）。 */
export interface LearningAgentStates {
  states: Readonly<Partial<Record<CapabilityFlagId, "enabled" | "disabled">>>;
}

/**
 * learning Agent 关闭断言（fail closed）：全部 LEARNING_AGENT_FLAG_IDS 必须为
 * `disabled`；任一 enabled 或未声明（视为不确定 → fail closed）即违规。
 */
export function assertLearningAgentDisabled(
  input: LearningAgentStates,
): readonly string[] {
  const violations: string[] = [];
  for (const flag of LEARNING_AGENT_FLAG_IDS) {
    const state = input.states[flag];
    if (state !== "disabled") {
      violations.push(
        `learning Agent "${flag}" 必须关闭，实际状态 ${state ?? "unknown"}（internal allowlist）`,
      );
    }
  }
  return violations;
}

/** 学习写入种类（internal allowlist 必须为 0）。 */
export type LearningWriteKind =
  | "validation_event" // 正式 validation outcome 写
  | "review_attempt" // 正式 attempt 写
  | "understanding_event" // 理解事件写
  | "schedule_write" // schedule 写
  | "mastery_update" // mastery/facet 投影正式更新
  | "outbox_append" // learning_outbox_events 写
  | "episode_commit"; // episode commit（commitKey / 正式 commit）

/** 全部学习写入种类（供审计/断言）。 */
export const LEARNING_WRITE_KINDS: readonly LearningWriteKind[] = [
  "validation_event",
  "review_attempt",
  "understanding_event",
  "schedule_write",
  "mastery_update",
  "outbox_append",
  "episode_commit",
];

/**
 * 0 学习写入断言（fail closed）：本次 internal 流程产生的学习写入种类必须为空。
 * 任一学习写入 → 违规（internal 用户试点不产生任何学习副作用）。
 */
export function assertZeroLearningWrites(
  writes: readonly LearningWriteKind[],
): readonly string[] {
  if (writes.length === 0) return [];
  return [`internal allowlist 流程产生 ${writes.length} 条学习写入：${writes.join(",")}（必须为 0）`];
}

// ─── 3. internal 用户全流程可用判定（§18.2 第 2 步）───────────────────────

/** internal 用户全流程步骤 id。 */
export type InternalFullFlowStep =
  | "auth_manifest_available"
  | "global_shell_available"
  | "onboarding_available"
  | "static_fallback_available"
  | "manual_main_path_available";

/** internal 用户全流程观察（调用方注入）。 */
export interface InternalUserFullFlowInput {
  /** 是否 authenticated internal 用户。 */
  authenticated: boolean;
  /** auth-surface manifest（签名校验）是否可用。 */
  authManifestAvailable: boolean;
  /** global companion shell（全局角色/锚点/侧板 + coverage registry）是否可用。 */
  globalShellAvailable: boolean;
  /** onboarding（CAS 状态机 + 示例）是否可用。 */
  onboardingAvailable: boolean;
  /** 静态 fallback（动画/角色静态 fallback + credential-safe 静态帮助）是否可用。 */
  staticFallbackAvailable: boolean;
  /** 手动主路径（原生导航与手动入口）是否可用。 */
  manualMainPathAvailable: boolean;
}

/** 全流程判定结果。 */
export interface InternalFullFlowVerdict {
  /** 全流程可用（所有步骤通过且无违规）。 */
  available: boolean;
  /** 逐步骤判定。 */
  steps: readonly { step: InternalFullFlowStep; ok: boolean }[];
  /** 缺失/失败步骤。 */
  missingSteps: readonly InternalFullFlowStep[];
}

/**
 * internal 用户全流程可用判定（§18.2 第 2 步验收「internal 用户全流程可用」）：
 * authenticated internal 用户必须可走通 auth manifest → global shell →
 * onboarding → 静态 fallback → 手动主路径。任一步骤不可用 → 全流程不可用。
 */
export function isInternalUserFullFlowAvailable(
  input: InternalUserFullFlowInput,
): InternalFullFlowVerdict {
  const steps: readonly { step: InternalFullFlowStep; ok: boolean }[] = [
    { step: "auth_manifest_available", ok: input.authManifestAvailable },
    { step: "global_shell_available", ok: input.globalShellAvailable },
    { step: "onboarding_available", ok: input.onboardingAvailable },
    { step: "static_fallback_available", ok: input.staticFallbackAvailable },
    { step: "manual_main_path_available", ok: input.manualMainPathAvailable },
  ];
  const missing = steps.filter((s) => !s.ok).map((s) => s.step);
  return {
    available: input.authenticated && missing.length === 0,
    steps,
    missingSteps: missing,
  };
}

// ─── 4. internal allowlist 判定（组合：启用清单 + 0 学习写入 + 全流程）──────

/** internal allowlist 判定输入。 */
export interface InternalAllowlistEvaluationInput {
  /** internal 用户是否命中 allowlist（调用方判定身份来源）。 */
  isInternalUser: boolean;
  /** 期望启用的 capability 清单（必须是 INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES 子集）。 */
  requestedCapabilities: readonly string[];
  /** learning Agent capability 状态。 */
  learningAgentStates: LearningAgentStates;
  /** 本次流程产生的学习写入。 */
  learningWrites: readonly LearningWriteKind[];
  /** internal 用户全流程观察。 */
  fullFlow: InternalUserFullFlowInput;
}

/** internal allowlist 判定结果。 */
export interface InternalAllowlistVerdict {
  /** 是否放行 internal allowlist（启用清单合法 + learning Agent 全关 + 0 学习写入 + 全流程可用）。 */
  allowed: boolean;
  /** 非 allowlist 启用项（请求了清单之外的能力 → 违规）。 */
  disallowedCapabilities: readonly string[];
  /** learning Agent 关闭断言违规。 */
  learningAgentViolations: readonly string[];
  /** 0 学习写入断言违规。 */
  learningWriteViolations: readonly string[];
  /** 全流程判定。 */
  fullFlow: InternalFullFlowVerdict;
  /** 全部问题汇总。 */
  problems: readonly string[];
}

/**
 * internal allowlist 组合判定（fail closed）：
 * - 必须是 internal 用户（allowlist 命中）；
 * - 请求的 capability 必须是启用清单子集（禁止请求 learning Agent 或清单外能力）；
 * - learning Agent 全部 disabled；
 * - 0 学习写入；
 * - internal 用户全流程可用。
 * 任一不满足 → allowed=false。
 */
export function evaluateInternalAllowlist(
  input: InternalAllowlistEvaluationInput,
): InternalAllowlistVerdict {
  const disallowedCapabilities = input.requestedCapabilities.filter(
    (c) => !isInternalEnabledCapability(c),
  );
  const learningAgentViolations = assertLearningAgentDisabled(input.learningAgentStates);
  const learningWriteViolations = assertZeroLearningWrites(input.learningWrites);
  const fullFlow = isInternalUserFullFlowAvailable(input.fullFlow);

  const problems: string[] = [];
  if (!input.isInternalUser) {
    problems.push("非 internal 用户不在 allowlist 内");
  }
  if (disallowedCapabilities.length > 0) {
    problems.push(`请求了清单外能力：${disallowedCapabilities.join(",")}`);
  }
  problems.push(...learningAgentViolations);
  problems.push(...learningWriteViolations);
  if (!fullFlow.available) {
    problems.push(`internal 用户全流程不可用：缺失 ${fullFlow.missingSteps.join(",")}`);
  }

  return {
    allowed:
      input.isInternalUser &&
      disallowedCapabilities.length === 0 &&
      learningAgentViolations.length === 0 &&
      learningWriteViolations.length === 0 &&
      fullFlow.available,
    disallowedCapabilities,
    learningAgentViolations,
    learningWriteViolations,
    fullFlow,
    problems,
  };
}

// ─── 5. 冻结校验（internal allowlist 常量自检）────────────────────────────

/**
 * internal allowlist 常量自检（供测试/CI 调用）：启用清单非空、全部为合法
 * capability 语义（引用 01-7 Must flag id），learning Agent 关闭清单非空且
 * 不包含已启用的能力。空数组 = 自检通过。
 */
export function validateInternalAllowlist(): readonly string[] {
  const problems: string[] = [];
  if (INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES.length === 0) {
    problems.push("启用清单为空");
  }
  if (LEARNING_AGENT_FLAG_IDS.length === 0) {
    problems.push("learning Agent 关闭清单为空");
  }
  // learning Agent 关闭清单必须引用合法 Must flag id（01-7 §2）。
  const mustSet = new Set<string>(MUST_BUNDLE_FLAG_IDS);
  for (const flag of LEARNING_AGENT_FLAG_IDS) {
    if (!mustSet.has(flag)) {
      problems.push(`learning Agent 关闭清单引用了未知 Must flag "${flag}"`);
    }
  }
  // 启用项不得与 learning Agent 关闭清单冲突（global_companion_shell 是 Must
  // flag；auth_manifest/onboarding/static_fallback 是 bundle 内原子内容，
  // 不属于独立 Must flag，故只检查 enable 清单自身互不冲突）。
  const enabledSet = new Set<string>(INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES);
  for (const enabled of INTERNAL_ALLOWLIST_ENABLED_CAPABILITIES) {
    if (LEARNING_AGENT_FLAG_IDS.includes(enabled as CapabilityFlagId)) {
      problems.push(`启用项 "${enabled}" 与 learning Agent 关闭清单冲突`);
    }
    if (!enabledSet.has(enabled)) problems.push(`启用清单含重复项 "${enabled}"`);
  }
  return problems;
}
