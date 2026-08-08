/**
 * 阶段 10（W9）任务 10-8：公测默认与旧入口退休（§18.2 第 7~8 步）。
 *
 * 本文件是**纯逻辑**（无 DB / 无网络 / 无时钟 / 无副作用 / 无随机）：
 * - **Gate 通过判定**（引用冻结 `RolloutStageGateV1`）：final soak 达标后
 *   Must capability bundle 才可设为正式公测默认（§18.2 第 7 步）；
 * - **Must bundle 设默认**：单 config revision 把 9 个 Must flags 全部置
 *   enabled；Should flags 保持独立 flag 状态（主列车外单独 shadow/canary，
 *   不阻塞第 8 步，§18.2 第 8 步）；
 * - **旧文本主入口退休**：旧文本主入口退出默认地位（companion guided 成为新
 *   默认），但旧入口能力保留可访问——退休的是「默认地位」，不是入口本身；
 * - **Should flags 独立**：问题标记 / workspace Tutor / semantic relationships
 *   保持独立 flag 状态，不阻塞第 8 步；
 * - **hard invariant 单次违规**：立即停止扩量并回滚相关 flag（§15 W9 /
 *   01-5 §5.3 语义），回滚计划引用 rollback-drill 的原子关闭闭包。
 *
 * 依赖复用：`ROLLOUT_STAGE_GATES.public_beta_default`（final-soak.ts 冻结 Gate）、
 * `applyAtomicOff`（rollback-drill.ts 单 revision 原子关闭 + 反向依赖闭包）。
 */

import {
  evaluateFinalSoak,
  ROLLOUT_STAGE_GATES,
  type FinalSoakReport,
  type SoakEvidence,
} from "./final-soak.ts";
import {
  applyAtomicOffClosure,
  atomicOffClosure,
  CAPABILITY_BUNDLE_DEPENDENCIES,
  MUST_BUNDLE_FLAG_IDS,
  SHOULD_BUNDLE_DEPENDENCIES,
  SHOULD_FLAG_IDS,
  type AtomicOffResult,
  type CapabilityConfigV1,
  type CapabilityFlagId,
  type CapabilityState,
  type MustFlagId,
  type ShouldFlagId,
} from "./rollback-drill.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 一、Gate 通过判定（引用 RolloutStageGateV1）
// ═══════════════════════════════════════════════════════════════════════════

export interface PublicBetaGateEvaluation {
  /** 引用的冻结 Gate（W0 定量门槛）。 */
  referencedGate: "RolloutStageGateV1.public_beta_default";
  gate: FinalSoakReport["gate"];
  finalSoak: FinalSoakReport;
  passed: boolean;
}

/**
 * Gate 通过判定（§18.2 第 7 步前置）：引用冻结 `RolloutStageGateV1` 的
 * public-beta-default 档判定最终 soak（样本量 / soak 时长 / 覆盖 / hard
 * incident=0 / soft budget / p95 成本 / 重试放大 / hidden-off 零成本 / 置信
 * 区间），全部达标才允许设正式公测默认。
 */
export function evaluatePublicBetaGate(evidence: SoakEvidence): PublicBetaGateEvaluation {
  const finalSoak = evaluateFinalSoak(evidence);
  return {
    referencedGate: "RolloutStageGateV1.public_beta_default",
    gate: ROLLOUT_STAGE_GATES.public_beta_default,
    finalSoak,
    passed: finalSoak.passed,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、配置合法性校验（01-7 §5 fail startup 规则，作为默认发布的前置防御）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 配置合法性校验（01-7 §5）：任一 flag enabled 而它的 required capability 被
 * disabled 即非法组合（onboarding 开而 global shell 关、Session Companion 开而
 * trusted core 关、Scene 开而 Critic/commit 关、map 开而 projection 关、Tutor 开
 * 而 Grounded Answer Critic 关等）。返回问题列表，空数组 = 合法。
 */
export function validateConfigLegal(config: CapabilityConfigV1): readonly string[] {
  const problems: string[] = [];
  const state = (flag: CapabilityFlagId): CapabilityState => config.states[flag];
  for (const dep of CAPABILITY_BUNDLE_DEPENDENCIES) {
    if (state(dep.flag) !== "disabled") {
      for (const req of dep.requires) {
        if (state(req) === "disabled") {
          problems.push(`非法组合：${dep.flag} 开而 required capability ${req} 关（fail startup）`);
        }
      }
    }
  }
  for (const dep of SHOULD_BUNDLE_DEPENDENCIES) {
    if (state(dep.flag) !== "disabled") {
      for (const req of dep.requires) {
        if (state(req) === "disabled") {
          problems.push(`非法组合：Should ${dep.flag} 开而 required capability ${req} 关（fail startup）`);
        }
      }
    }
  }
  return problems;
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、Must bundle 设默认（§18.2 第 7 步）
// ═══════════════════════════════════════════════════════════════════════════

export interface PublicBetaDefaultConfig {
  ok: boolean;
  /** 应用后的配置（失败时原样返回）。 */
  config: CapabilityConfigV1;
  revision: number;
  /** 被置为默认 enabled 的 Must flags。 */
  defaultFlags: readonly MustFlagId[];
  /** Should flags 保持独立（不强制；各自 flag 状态不变）。 */
  shouldFlagsIndependent: boolean;
  problems: readonly string[];
}

/**
 * Must bundle 设正式公测默认（§18.2 第 7 步）：单 config revision 把全部 9 个
 * Must flags 置 enabled；Should flags 保持原独立 flag 状态。发布前校验配置
 * 合法性（非法组合 fail closed，不发布）。
 */
export function applyPublicBetaDefaults(config: CapabilityConfigV1): PublicBetaDefaultConfig {
  const problems = validateConfigLegal(config);
  if (problems.length > 0) {
    return {
      ok: false,
      config,
      revision: config.revision,
      defaultFlags: [],
      shouldFlagsIndependent: true,
      problems,
    };
  }
  const states = { ...config.states } as Record<CapabilityFlagId, CapabilityState>;
  const changed = MUST_BUNDLE_FLAG_IDS.filter((flag) => states[flag] !== "enabled");
  for (const flag of MUST_BUNDLE_FLAG_IDS) {
    states[flag] = "enabled";
  }
  const nextConfig: CapabilityConfigV1 = {
    ...config,
    revision: changed.length > 0 ? config.revision + 1 : config.revision,
    states,
  };
  return {
    ok: true,
    config: nextConfig,
    revision: nextConfig.revision,
    defaultFlags: [...MUST_BUNDLE_FLAG_IDS],
    shouldFlagsIndependent: true,
    problems: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、旧文本主入口退休（§18.2 第 8 步）
// ═══════════════════════════════════════════════════════════════════════════

export const ENTRY_POINT_IDS = ["legacy_text_first", "companion_guided"] as const;
export type EntryPointId = (typeof ENTRY_POINT_IDS)[number];

/** 入口默认配置（旧文本主入口 vs 伴星引导入口）。 */
export interface EntryPointDefaults {
  defaultEntry: EntryPointId;
  /** 旧文本入口是否保留可访问（退休默认地位，不删除入口能力）。 */
  legacyEntryAvailable: boolean;
}

export interface RetireLegacyEntryResult {
  previousDefault: EntryPointId;
  newDefault: EntryPointId;
  legacyEntryAvailable: boolean;
  /** 是否完成了退休（仅在旧文本主入口是默认时发生）。 */
  retired: boolean;
}

/**
 * 退休旧文本主入口默认地位（§18.2 第 8 步）：旧文本主入口不再是默认入口，
 * companion guided 成为新默认；旧入口保留可访问（不隐式删除/替换）。幂等：
 * 若已是 companion_guided 默认则 retired=false 且不变化。
 */
export function retireLegacyTextEntryDefault(
  current: EntryPointDefaults,
): RetireLegacyEntryResult {
  if (current.defaultEntry !== "legacy_text_first") {
    return {
      previousDefault: current.defaultEntry,
      newDefault: current.defaultEntry,
      legacyEntryAvailable: current.legacyEntryAvailable,
      retired: false,
    };
  }
  return {
    previousDefault: "legacy_text_first",
    newDefault: "companion_guided",
    legacyEntryAvailable: current.legacyEntryAvailable,
    retired: true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 五、Should flags 独立（§18.2 第 8 步 / 01-7 §4）
// ═══════════════════════════════════════════════════════════════════════════

export interface ShouldFlagsIndependenceEvaluation {
  /** Should flags 保持独立 flag 状态（不并入 Must 默认 bundle）。 */
  independent: boolean;
  /** 任何 Should flag 状态都不阻塞第 8 步。 */
  blockingStep8: boolean;
  states: Readonly<Record<ShouldFlagId, CapabilityState>>;
}

/**
 * Should flags 独立评估：问题标记 / workspace Tutor / semantic relationships 在
 * 主列车外单独 shadow/canary，保持独立 flag 状态（enabled/degraded/disabled），
 * 不影响、也不被 Must 默认发布强制改变；不阻塞第 8 步。
 */
export function evaluateShouldFlagsIndependence(
  config: CapabilityConfigV1,
): ShouldFlagsIndependenceEvaluation {
  const states = {} as Record<ShouldFlagId, CapabilityState>;
  for (const flag of SHOULD_FLAG_IDS) {
    states[flag] = config.states[flag];
  }
  return { independent: true, blockingStep8: false, states };
}

// ═══════════════════════════════════════════════════════════════════════════
// 六、hard invariant 单次违规 → 立即停止扩量并回滚相关 flag（§15 W9）
// ═══════════════════════════════════════════════════════════════════════════

export type HardInvariantViolationKind =
  | "privacy"
  | "tenant"
  | "answer_leak"
  | "trust"
  | "critic"
  | "schedule_invariant";

export const HARD_INVARIANT_VIOLATION_KINDS: readonly HardInvariantViolationKind[] = [
  "privacy",
  "tenant",
  "answer_leak",
  "trust",
  "critic",
  "schedule_invariant",
];

/** 违规类别 → 需要回滚的相关 flag（§15 W9「回滚相关 flag」）。 */
export const HARD_INVARIANT_ROLLBACK_TARGETS: Readonly<
  Record<HardInvariantViolationKind, readonly MustFlagId[]>
> = {
  privacy: ["trusted_multimodal_core", "understanding_universe_v2"],
  tenant: ["trusted_multimodal_core"],
  answer_leak: ["trusted_multimodal_core", "current_target_tutor", "structured_proof_v1"],
  trust: ["trusted_multimodal_core", "current_target_tutor"],
  critic: ["current_target_tutor", "structured_proof_v1"],
  schedule_invariant: ["journey_routes", "structured_proof_v1"],
};

export interface HardInvariantViolationEvaluation {
  kind: HardInvariantViolationKind;
  /** 单次违规立即停止扩量（字面量 true）。 */
  stopScaling: true;
  /** 需回滚的 flag（含闭包原子关闭计划）。 */
  rollbackFlags: readonly MustFlagId[];
  rollbackPlan: AtomicOffResult;
  message: string;
}

/**
 * hard invariant 单次违规评估（§15 W9 / §18.2 第 8 步）：任一违规立即停止扩量，
 * 并以**单 config revision** 原子关闭相关 flag 的全部反向依赖闭包（引用
 * rollback-drill 的 `applyAtomicOffClosure`，闭包取各目标的并集，保证相关 flag
 * 一个 revision 全部回滚）。同一违规重复演练结果一致（确定性）。
 */
export function evaluateHardInvariantViolation(
  kind: HardInvariantViolationKind,
  config: CapabilityConfigV1,
): HardInvariantViolationEvaluation {
  const targets = HARD_INVARIANT_ROLLBACK_TARGETS[kind];
  const closure = targets.flatMap((t) => atomicOffClosure(t));
  const rollbackPlan = applyAtomicOffClosure(config, closure);
  const allRolledBack = targets.every((flag) => rollbackPlan.config.states[flag] === "disabled");
  return {
    kind,
    stopScaling: true,
    rollbackFlags: [...targets],
    rollbackPlan,
    message: allRolledBack
      ? `hard invariant 违规（${kind}）：停止扩量并单 revision 原子回滚相关 flag [${targets.join(",")}] 及其反向依赖闭包`
      : `hard invariant 违规（${kind}）：停止扩量；回滚未完全覆盖相关 flag（需人工介入）`,
  };
}

/** 类型守卫：是否合法 hard invariant 违规类别。 */
export function isHardInvariantViolationKind(value: string): value is HardInvariantViolationKind {
  return (HARD_INVARIANT_VIOLATION_KINDS as readonly string[]).includes(value);
}

// ═══════════════════════════════════════════════════════════════════════════
// 七、公测默认序列编排（§18.2 第 7~8 步）
// ═══════════════════════════════════════════════════════════════════════════

export interface PublicBetaDefaultInput {
  evidence: SoakEvidence;
  config: CapabilityConfigV1;
  entryPointDefaults: EntryPointDefaults;
  /** 演练注入的 hard invariant 违规（任一 → 停止扩量并回滚）。 */
  hardInvariantViolations?: readonly HardInvariantViolationKind[];
}

export interface PublicBetaDefaultReport {
  gate: PublicBetaGateEvaluation;
  mustDefault: PublicBetaDefaultConfig;
  legacyEntry: RetireLegacyEntryResult;
  shouldFlags: ShouldFlagsIndependenceEvaluation;
  hardInvariant: readonly HardInvariantViolationEvaluation[];
  /** 是否有任何 hard invariant 单次违规。 */
  anyHardInvariantViolation: boolean;
  /** 全部通过：Gate 达标 + Must 默认发布 + 旧入口退休 + Should 独立 + 无违规。 */
  passed: boolean;
}

/**
 * 公测默认序列（§18.2 第 7~8 步）：
 * ① Gate 通过判定（引用 RolloutStageGateV1）→ ② Must bundle 设默认 →
 * ③ 旧文本主入口退休 → ④ Should flags 独立不阻塞；任何 hard invariant 单次违规
 * 立即停止扩量并回滚相关 flag，序列不通过。
 */
export function runPublicBetaDefaultSequence(
  input: PublicBetaDefaultInput,
): PublicBetaDefaultReport {
  const gate = evaluatePublicBetaGate(input.evidence);
  const mustDefault = applyPublicBetaDefaults(input.config);
  const legacyEntry = retireLegacyTextEntryDefault(input.entryPointDefaults);
  const shouldFlags = evaluateShouldFlagsIndependence(input.config);
  const violations = (input.hardInvariantViolations ?? []).map((kind) =>
    evaluateHardInvariantViolation(kind, input.config),
  );
  const anyHardInvariantViolation = violations.length > 0;
  const passed =
    gate.passed &&
    mustDefault.ok &&
    legacyEntry.retired &&
    shouldFlags.independent &&
    !shouldFlags.blockingStep8 &&
    !anyHardInvariantViolation;
  return {
    gate,
    mustDefault,
    legacyEntry,
    shouldFlags,
    hardInvariant: violations,
    anyHardInvariantViolation,
    passed,
  };
}
