/**
 * 阶段 10（W9）任务 10-7：最终 soak 与成本观察窗（§18.2 第 6 步 + §16.6）。
 *
 * 本文件是**纯逻辑**（无 DB / 无网络 / 无时钟 / 无副作用 / 无随机）：
 * - `RolloutStageGateV1`：W0 冻结的定量扩量门槛（每档最低 Session/Episode、用户、
 *   workspace 数、voice/silent/text 与 Provider/ASR 覆盖、最短 soak 时长、hard
 *   incident=0、soft error budget、p95 成本预算与数据置信区间）——引用自
 *   10-w9 计划「前置：RolloutStageGateV1 门槛（§18.2）」；数值为 W0 冻结常量，
 *   只能改常量、不能改判定逻辑；
 * - `evaluateRolloutGateV1`：单档 Gate 判定（确定性、fail closed）；
 * - `computeCostObservation`：成本与调用放大观察窗（用户级 p50/p95、重试放大系数、
 *   hidden/off 后新增成本为 0）——复用冻结记录 08-4 / 01-5 §16.6 的
 *   metrics-schema 纯函数，不重复定义成本语义；
 * - `evaluateFinalSoak`：最终 soak（public-beta-default 档）——soak 时长达标、
 *   hard incident=0、成本曲线全部在冻结预算内；
 * - `assertFinalSoakPassed`：0 容忍 fail closed。
 *
 * 观察记录（Session/Episode、用户、workspace、覆盖、成本样本）由接线 harness
 * （09-2 / 09-5 / 09-6 与阶段 11 收尾）注入；本模块只做确定性判定。
 */

import {
  checkHiddenOffZeroNewCost,
  checkRetryAmplificationUnderCap,
  computeRetryAmplification,
  computeUserCostPercentile,
  COST_DIMENSIONS,
  DEFAULT_RETRY_AMPLIFICATION_CAP,
  type CostDimension,
  type CostSample,
} from "../observability/metrics-schema.ts";

// ═══════════════════════════════════════════════════════════════════════════
// 一、RolloutStageGateV1（W0 冻结定量门槛，§18.2）
// ═══════════════════════════════════════════════════════════════════════════

/** 扩量档位（§18.2 第 1~8 步）。 */
export type RolloutStage =
  | "shadow" // 第 1 步 replay/shadow
  | "internal" // 第 2 步 internal allowlist
  | "canary_5pct" // 第 3~5 步 5% workspace-stable canary
  | "canary_25pct" // 第 5 步 25% canary
  | "public_beta_default"; // 第 6~8 步最终 soak 后设为正式公测默认

export const ROLLOUT_STAGES: readonly RolloutStage[] = [
  "shadow",
  "internal",
  "canary_5pct",
  "canary_25pct",
  "public_beta_default",
];

/** 类型守卫：是否为合法扩量档位。 */
export function isRolloutStage(value: string): value is RolloutStage {
  return (ROLLOUT_STAGES as readonly string[]).includes(value);
}

/**
 * W0 冻结 p95 成本预算（§16.6 p95 成本上限；全档位统一封顶，扩量不放松成本）。
 * 只能改常量，不能改判定逻辑（08-4「只能改常量不能改判定逻辑」）。
 */
export const ROLLOUT_P95_COST_CAP: Readonly<Record<CostDimension, number>> = {
  llmCalls: 60,
  inputTokens: 600_000,
  outputTokens: 300_000,
  asrSeconds: 1_800,
  ttsCharacters: 100_000,
  objectStorageBytes: 500_000_000,
  tutorBudgetUnits: 20,
};

/**
 * 单档冻结门槛（§18.2）：每档最低 Session/Episode、用户、workspace 数、
 * voice/silent/text 与 Provider/ASR 覆盖、最短 soak 时长、hard incident=0、
 * soft error budget、p95 成本预算和数据置信区间。
 */
export interface RolloutStageGateV1 {
  stage: RolloutStage;
  /** 最低 Episode 数（样本量）。 */
  minEpisodes: number;
  /** 最低用户数。 */
  minUsers: number;
  /** 最低 workspace 数。 */
  minWorkspaces: number;
  /** 最短 soak 时长（小时）。 */
  minSoakHours: number;
  /** 置信区间评估的最低样本数。 */
  minConfidenceSamples: number;
  /** 模态覆盖要求（voice / silent / text 必须全部达标）。 */
  modalityCoverage: Readonly<{ voice: boolean; silent: boolean; text: boolean }>;
  /** Provider / ASR 覆盖要求。 */
  providerCoverage: Readonly<{ providers: readonly string[]; asr: boolean }>;
  /** hard incident 数量（W0 冻结恒为 0，任何一次 hard incident 即 fail）。 */
  hardIncidents: number;
  /** soft error budget（soft 错误数上限）。 */
  softErrorBudget: number;
  /** p95 成本预算（§16.6 冻结上限）。 */
  p95CostCap: Readonly<Record<CostDimension, number>>;
  /** 数据置信区间要求（§18.2：alpha 显著性水平与最大误差）。 */
  confidenceInterval: Readonly<{ alpha: number; maxMargin: number }>;
}

const MODALITY_COVERAGE = { voice: true, silent: true, text: true } as const;
const PROVIDER_COVERAGE = { providers: ["openai"], asr: true } as const;
const P95_CAP = ROLLOUT_P95_COST_CAP;

/** W0 冻结全档位 Gate 表（§18.2；数值只允许改常量）。 */
export const ROLLOUT_STAGE_GATES: Readonly<Record<RolloutStage, RolloutStageGateV1>> = {
  shadow: {
    stage: "shadow",
    minEpisodes: 500,
    minUsers: 50,
    minWorkspaces: 20,
    minSoakHours: 24,
    minConfidenceSamples: 50,
    modalityCoverage: MODALITY_COVERAGE,
    providerCoverage: { providers: ["openai"], asr: false },
    hardIncidents: 0,
    softErrorBudget: 10,
    p95CostCap: P95_CAP,
    confidenceInterval: { alpha: 0.05, maxMargin: 0.1 },
  },
  internal: {
    stage: "internal",
    minEpisodes: 2_000,
    minUsers: 200,
    minWorkspaces: 80,
    minSoakHours: 48,
    minConfidenceSamples: 200,
    modalityCoverage: MODALITY_COVERAGE,
    providerCoverage: PROVIDER_COVERAGE,
    hardIncidents: 0,
    softErrorBudget: 10,
    p95CostCap: P95_CAP,
    confidenceInterval: { alpha: 0.05, maxMargin: 0.08 },
  },
  canary_5pct: {
    stage: "canary_5pct",
    minEpisodes: 10_000,
    minUsers: 1_000,
    minWorkspaces: 400,
    minSoakHours: 72,
    minConfidenceSamples: 500,
    modalityCoverage: MODALITY_COVERAGE,
    providerCoverage: PROVIDER_COVERAGE,
    hardIncidents: 0,
    softErrorBudget: 20,
    p95CostCap: P95_CAP,
    confidenceInterval: { alpha: 0.05, maxMargin: 0.06 },
  },
  canary_25pct: {
    stage: "canary_25pct",
    minEpisodes: 50_000,
    minUsers: 5_000,
    minWorkspaces: 2_000,
    minSoakHours: 120,
    minConfidenceSamples: 800,
    modalityCoverage: MODALITY_COVERAGE,
    providerCoverage: PROVIDER_COVERAGE,
    hardIncidents: 0,
    softErrorBudget: 20,
    p95CostCap: P95_CAP,
    confidenceInterval: { alpha: 0.05, maxMargin: 0.05 },
  },
  public_beta_default: {
    stage: "public_beta_default",
    minEpisodes: 150_000,
    minUsers: 15_000,
    minWorkspaces: 6_000,
    minSoakHours: 168,
    minConfidenceSamples: 1_000,
    modalityCoverage: MODALITY_COVERAGE,
    providerCoverage: PROVIDER_COVERAGE,
    hardIncidents: 0,
    softErrorBudget: 30,
    p95CostCap: P95_CAP,
    confidenceInterval: { alpha: 0.05, maxMargin: 0.05 },
  },
};

/**
 * Gate 表自检（确定性，供测试/CI 调用）：stage 合法、数值非负、覆盖要求布尔、
 * p95 预算覆盖全部成本维度。空数组 = 全表合法。
 */
export function validateRolloutStageGates(): readonly string[] {
  const problems: string[] = [];
  for (const stage of ROLLOUT_STAGES) {
    const gate = ROLLOUT_STAGE_GATES[stage];
    if (gate === undefined) {
      problems.push(`stage ${stage}: 缺少 Gate`);
      continue;
    }
    if (gate.stage !== stage) problems.push(`stage ${stage}: gate.stage 不匹配`);
    for (const [key, value] of Object.entries({
      minEpisodes: gate.minEpisodes,
      minUsers: gate.minUsers,
      minWorkspaces: gate.minWorkspaces,
      minSoakHours: gate.minSoakHours,
      minConfidenceSamples: gate.minConfidenceSamples,
      softErrorBudget: gate.softErrorBudget,
    })) {
      if (!Number.isFinite(value) || value < 0) {
        problems.push(`stage ${stage}: ${key} 非法 ${value}`);
      }
    }
    if (gate.hardIncidents !== 0) {
      problems.push(`stage ${stage}: hardIncidents 必须为 0（W0 冻结）`);
    }
    const mods = gate.modalityCoverage;
    if (!mods.voice || !mods.silent || !mods.text) {
      problems.push(`stage ${stage}: voice/silent/text 覆盖要求必须全部为 true`);
    }
    if (gate.providerCoverage.providers.length === 0) {
      problems.push(`stage ${stage}: 缺少 Provider 覆盖要求`);
    }
    for (const dim of COST_DIMENSIONS) {
      const cap = gate.p95CostCap[dim];
      if (!Number.isFinite(cap) || cap < 0) {
        problems.push(`stage ${stage}: p95CostCap.${dim} 非法 ${cap}`);
      }
    }
    if (gate.confidenceInterval.alpha < 0 || gate.confidenceInterval.alpha > 1) {
      problems.push(`stage ${stage}: alpha 必须在 0..1`);
    }
    if (gate.confidenceInterval.maxMargin < 0) {
      problems.push(`stage ${stage}: maxMargin 非法`);
    }
  }
  return problems;
}

// ═══════════════════════════════════════════════════════════════════════════
// 二、Soak 观察输入与成本观察窗（§16.6）
// ═══════════════════════════════════════════════════════════════════════════

/** 数据置信区间观察（§18.2：评估样本的显著性水平 / 误差 / 样本数）。 */
export interface ConfidenceIntervalObservation {
  /** 显著性水平（≤ gate.alpha 才达标）。 */
  alpha: number;
  /** 误差边界（≤ gate.maxMargin 才达标）。 */
  margin: number;
  /** 评估样本数（≥ gate.minConfidenceSamples 才达标）。 */
  n: number;
}

/** 最终 soak / 扩量 Gate 的观察输入（由接线 harness 注入）。 */
export interface SoakEvidence {
  stage: RolloutStage;
  episodeCount: number;
  userCount: number;
  workspaceCount: number;
  /** 已完成的 soak 时长（小时）。 */
  soakHours: number;
  modalityCoverage: Readonly<{ voice: boolean; silent: boolean; text: boolean }>;
  providerCoverage: Readonly<{ providers: readonly string[]; asr: boolean }>;
  /** hard incident 数（必须为 0）。 */
  hardIncidents: number;
  /** soft 错误数（必须在预算内）。 */
  softErrors: number;
  /** 用户级成本样本（每用户一个 CostSample）。 */
  userCosts: readonly CostSample[];
  /** 唯一请求数 / 计费调用数（重试放大系数）。 */
  uniqueRequests: number;
  billedCalls: number;
  /** hidden/off 确认后仍发生的成本样本（必须全为 0）。 */
  callsAfterHiddenOff: readonly CostSample[];
  confidenceInterval: ConfidenceIntervalObservation;
}

/** 成本与调用放大观察窗（§16.6 / 08-4）。 */
export interface CostObservationWindow {
  /** 用户级 p50 成本（逐维度）。 */
  p50: Readonly<Record<CostDimension, number>>;
  /** 用户级 p95 成本（逐维度）。 */
  p95: Readonly<Record<CostDimension, number>>;
  /** 重试放大系数（计费调用 / 唯一请求）。 */
  retryAmplification: number;
  /** 重试放大系数是否在冻结上限内（默认 1.5）。 */
  retryAmplificationUnderCap: boolean;
  /** hidden/off 后新增成本是否为 0（§16.6 硬 Gate）。 */
  hiddenOffZeroNewCost: boolean;
  /** 参与观察的用户成本样本数。 */
  totalUserCostSamples: number;
}

/**
 * 成本与调用放大观察窗（纯函数）：用户级 p50/p95 成本、重试放大系数、
 * hidden/off 后新增成本 0——全部复用 08-4 metrics-schema 冻结语义。
 */
export function computeCostObservation(
  userCosts: readonly CostSample[],
  uniqueRequests: number,
  billedCalls: number,
  callsAfterHiddenOff: readonly CostSample[],
): CostObservationWindow {
  const p50 = {} as Record<CostDimension, number>;
  const p95 = {} as Record<CostDimension, number>;
  for (const dim of COST_DIMENSIONS) {
    p50[dim] = computeUserCostPercentile(userCosts, dim, 0.5);
    p95[dim] = computeUserCostPercentile(userCosts, dim, 0.95);
  }
  const retryAmplification = computeRetryAmplification(uniqueRequests, billedCalls);
  return {
    p50,
    p95,
    retryAmplification,
    retryAmplificationUnderCap:
      checkRetryAmplificationUnderCap(uniqueRequests, billedCalls).length === 0,
    hiddenOffZeroNewCost:
      checkHiddenOffZeroNewCost(callsAfterHiddenOff, "hidden_off").length === 0,
    totalUserCostSamples: userCosts.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 三、Gate 判定（确定性、fail closed）
// ═══════════════════════════════════════════════════════════════════════════

export interface RolloutGateEvaluation {
  stage: RolloutStage;
  /** Gate 是否可查（stage 合法且 gate 存在）。 */
  checked: boolean;
  passed: boolean;
  violations: readonly string[];
  gate: RolloutStageGateV1 | undefined;
}

/**
 * 单档 Gate 判定（§18.2）：样本量（Episode/用户/workspace）、最短 soak 时长、
 * voice/silent/text 与 Provider/ASR 覆盖、hard incident=0、soft error budget、
 * p95 成本预算、重试放大上限、hidden/off 后新增成本 0 与数据置信区间。
 * 任一不满足 → fail；未知 stage → checked=false 且 fail。
 */
export function evaluateRolloutGateV1(evidence: SoakEvidence): RolloutGateEvaluation {
  const gate = ROLLOUT_STAGE_GATES[evidence.stage];
  if (gate === undefined) {
    return {
      stage: evidence.stage,
      checked: false,
      passed: false,
      violations: [`unknown rollout stage: ${evidence.stage}`],
      gate: undefined,
    };
  }
  const violations: string[] = [];
  if (evidence.episodeCount < gate.minEpisodes) {
    violations.push(
      `Episode 样本不足：${evidence.episodeCount} < ${gate.minEpisodes}（stage ${gate.stage}）`,
    );
  }
  if (evidence.userCount < gate.minUsers) {
    violations.push(`用户样本不足：${evidence.userCount} < ${gate.minUsers}`);
  }
  if (evidence.workspaceCount < gate.minWorkspaces) {
    violations.push(`workspace 样本不足：${evidence.workspaceCount} < ${gate.minWorkspaces}`);
  }
  if (evidence.soakHours < gate.minSoakHours) {
    violations.push(
      `soak 时长不足：${evidence.soakHours}h < ${gate.minSoakHours}h（stage ${gate.stage}）`,
    );
  }
  const mods = evidence.modalityCoverage;
  for (const [name, required] of Object.entries(gate.modalityCoverage)) {
    if (required && !mods[name as keyof typeof mods]) {
      violations.push(`模态覆盖不足：${name}`);
    }
  }
  for (const provider of gate.providerCoverage.providers) {
    if (!evidence.providerCoverage.providers.includes(provider)) {
      violations.push(`Provider 覆盖不足：缺少 ${provider}`);
    }
  }
  if (gate.providerCoverage.asr && !evidence.providerCoverage.asr) {
    violations.push("ASR 覆盖不足");
  }
  if (evidence.hardIncidents !== gate.hardIncidents) {
    violations.push(
      `hard incident 必须为 0，实际 ${evidence.hardIncidents}（停止扩量并回滚相关 flag）`,
    );
  }
  if (evidence.softErrors > gate.softErrorBudget) {
    violations.push(
      `soft 错误 ${evidence.softErrors} 超过预算 ${gate.softErrorBudget}`,
    );
  }
  // p95 成本预算（§16.6）：任一维度 p95 越限即违规。
  for (const dim of COST_DIMENSIONS) {
    const cap = gate.p95CostCap[dim];
    const p95 = computeUserCostPercentile(evidence.userCosts, dim, 0.95);
    if (p95 > cap) {
      violations.push(`p95 ${dim}=${p95} 超过冻结预算 ${cap}`);
    }
  }
  // 重试放大上限（默认 1.5，W0 冻结）。
  violations.push(
    ...checkRetryAmplificationUnderCap(evidence.uniqueRequests, evidence.billedCalls),
  );
  // hidden/off 后新增成本必须为 0（§16.6 硬 Gate）。
  violations.push(...checkHiddenOffZeroNewCost(evidence.callsAfterHiddenOff, "hidden_off"));
  // 数据置信区间（§18.2）。
  const ci = evidence.confidenceInterval;
  if (ci.alpha > gate.confidenceInterval.alpha) {
    violations.push(`置信区间 alpha ${ci.alpha} > ${gate.confidenceInterval.alpha}`);
  }
  if (ci.margin > gate.confidenceInterval.maxMargin) {
    violations.push(`置信区间误差 ${ci.margin} > ${gate.confidenceInterval.maxMargin}`);
  }
  if (ci.n < gate.minConfidenceSamples) {
    violations.push(
      `置信区间样本 ${ci.n} < ${gate.minConfidenceSamples}`,
    );
  }

  return {
    stage: evidence.stage,
    checked: true,
    passed: violations.length === 0,
    violations,
    gate,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 四、最终 soak 与成本观察窗（§18.2 第 6 步）
// ═══════════════════════════════════════════════════════════════════════════

export interface FinalSoakReport {
  /** 最终 soak 固定为 public-beta-default 档。 */
  stage: "public_beta_default";
  /** 引用的冻结 Gate。 */
  gate: RolloutStageGateV1;
  gateEvaluation: RolloutGateEvaluation;
  cost: CostObservationWindow;
  /** soak 期无 hard incident。 */
  noHardIncident: boolean;
  /** 成本曲线在冻结预算内（p95/重试放大/hidden-off 零成本全过）。 */
  costWithinBudget: boolean;
  /** 最终 soak 全部达标。 */
  passed: boolean;
}

/**
 * 最终 soak（§18.2 第 6 步 + §16.6）：以 public-beta-default 档冻结 Gate 判定，
 * 组合成本观察窗（p50/p95、重试放大系数、hidden/off 后新增成本 0）。
 * 产出确定性报告供成本面板与扩量决策消费。
 */
export function evaluateFinalSoak(evidence: SoakEvidence): FinalSoakReport {
  const gateEvaluation = evaluateRolloutGateV1({
    ...evidence,
    stage: "public_beta_default",
  });
  const cost = computeCostObservation(
    evidence.userCosts,
    evidence.uniqueRequests,
    evidence.billedCalls,
    evidence.callsAfterHiddenOff,
  );
  const gate = ROLLOUT_STAGE_GATES.public_beta_default;
  const noHardIncident = evidence.hardIncidents === 0;
  const costWithinBudget =
    gateEvaluation.violations.every((v) => !v.startsWith("p95 ")) &&
    cost.retryAmplificationUnderCap &&
    cost.hiddenOffZeroNewCost;
  return {
    stage: "public_beta_default",
    gate,
    gateEvaluation,
    cost,
    noHardIncident,
    costWithinBudget,
    passed: gateEvaluation.passed && noHardIncident && costWithinBudget,
  };
}

/** 最终 soak 0 容忍 fail closed：未达标即抛错（供收尾 Gate 消费）。 */
export class FinalSoakFailure extends Error {
  constructor(public readonly report: FinalSoakReport) {
    super(
      `final soak failed: ` +
        `gatePassed=${report.gateEvaluation.passed}, ` +
        `noHardIncident=${report.noHardIncident}, ` +
        `costWithinBudget=${report.costWithinBudget}, ` +
        `violations=[${report.gateEvaluation.violations.join("; ") || "-"}]`,
    );
    this.name = "FinalSoakFailure";
  }
}

/** 断言最终 soak 达标；任一门槛未满足即抛错。 */
export function assertFinalSoakPassed(report: FinalSoakReport): void {
  if (!report.passed) {
    throw new FinalSoakFailure(report);
  }
}

/** 重试放大默认上限（W0 冻结，复用 metrics-schema）。 */
export const RETRY_AMPLIFICATION_CAP = DEFAULT_RETRY_AMPLIFICATION_CAP;
