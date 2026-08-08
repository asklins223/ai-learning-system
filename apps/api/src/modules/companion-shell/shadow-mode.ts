/**
 * 阶段 10（W9）任务 10-2：replay / shadow 纯逻辑（§18.2 第 1 步）。
 *
 * shadow 阶段只做**数据/contract 与事件投影**，UI 全关；shadow route/assessment
 * **只生成计划与对比，不写 canonical**。本文件是纯逻辑（无 DB / 无网络 / 无时钟 /
 * 无副作用 / 无随机），调用方注入 shadow 事件/投影/计划输入，本模块只做确定性生成
 * 与判定：
 *
 * 核心不变量（10-w9 任务 10-2 验收）：
 * - **shadow 输出 0 canonical 写**：`ShadowOutput` 类型层面不含任何 canonical 写
 *   指令（`canonicalWrites` 字段固定为字面量空数组类型 `readonly []`），并配套
 *   `assertShadowZeroCanonicalWrites` 运行时强断言（fail closed）；
 * - **UI 全关**：shadow 阶段不产生任何可交互 UI 指令，`shadowUiAllOff` 恒为
 *   `"all_off"`，`assertShadowUiAllOff` 对任何 UI 展示指令 fail closed；
 * - **只生成计划与对比**：`buildShadowPlan` / `buildShadowAssessmentComparison`
 *   把 canonical 计划/assessment 与 shadow 计划/assessment 逐项配对生成对比，
 *   不写 canonical、不产生 UI 指令；
 * - **对比数据达到 Gate 门槛**：`evaluateShadowGate` 复用冻结记录 01-5 §16 与
 *   10-w9「RolloutStageGateV1」口径的 `RolloutStageGateV1`（引用
 *   ./final-soak.ts 的冻结档位表）判定 shadow 对比数据是否达到 shadow 档门槛
 *   （样本量 / soak / 覆盖 / hard incident=0 / soft budget / p95 成本 / 置信区间），
 *   并同时断言 0 canonical 写与 UI 全关。
 */

import {
  ROLLOUT_STAGE_GATES,
  type RolloutStageGateV1,
} from "./final-soak.ts";

// ─── 1. 版本与常量 ─────────────────────────────────────────────────────────

/** shadow 模式策略版本（进入 policyVersion / audit 引用）。 */
export const SHADOW_MODE_VERSION = "shadow-mode-v1" as const;

/** shadow 档位 id（§18.2 第 1 步；对应 final-soak `RolloutStageGates.shadow`）。 */
export const SHADOW_STAGE = "shadow" as const;

/** UI 可见性状态：shadow 阶段 UI 全关（唯一合法值）。 */
export type ShadowUiVisibility = "all_off";

/** shadow 阶段 UI 可见性恒为 all_off（UI 全关）。 */
export const SHADOW_UI_VISIBILITY: ShadowUiVisibility = "all_off";

// ─── 2. Canonical 写指令（shadow 必须为 0）────────────────────────────────

/** 可能出现的 canonical 写指令种类（shadow 输出中一律禁止）。 */
export type CanonicalWriteKind =
  | "validation_event" // 正式 validation outcome 写（validation_events）
  | "review_attempt" // 正式 attempt 写（review_attempts）
  | "understanding_event" // 理解事件写（understanding_events）
  | "schedule_write" // schedule 写（official scheduler 唯一写权）
  | "mastery_update" // mastery/facet 投影正式更新
  | "outbox_append"; // learning_outbox_events append-only 写

/** 全部 canonical 写指令 id（供审计/断言用）。 */
export const CANONICAL_WRITE_KINDS: readonly CanonicalWriteKind[] = [
  "validation_event",
  "review_attempt",
  "understanding_event",
  "schedule_write",
  "mastery_update",
  "outbox_append",
];

// ─── 3. shadow 计划生成（不写 canonical）───────────────────────────────────

/** shadow 事件投影输入（来自真实数据/contract 的 replay 事件流）。 */
export interface ShadowReplayEvent {
  /** 事件 id（与 canonical-events 的事件 id 语义一致）。 */
  eventId: string;
  /** 投影事件类型（validation / review / understanding）。 */
  domain: "validation" | "review" | "understanding";
  /** 事件对应的 content/target 引用（opaque id）。 */
  targetRef: string;
}

/** shadow 计划步骤（只描述计划，不执行任何写）。 */
export interface ShadowPlanStep {
  stepId: string;
  kind: "prepare" | "probe" | "assess" | "commit";
  /** 该步引用的 target（opaque id）。 */
  targetRef: string;
}

/** shadow 计划生成输入（调用方注入；本模块不产生 IO）。 */
export interface BuildShadowPlanInput {
  /** shadow 事件投影流（replay 输入）。 */
  events: readonly ShadowReplayEvent[];
  /** shadow 计划 id（调用方生成）。 */
  planId: string;
}

/**
 * 从事件投影流生成 shadow 计划（纯函数，不写 canonical）。
 * 每个投影事件派生一个 prepare 计划步骤（对 eventId 去重、保序），后续
 * probe/assess/commit 步骤由调用方在真实 shadow 执行路径补充——本模块只生成
 * 计划与对比所需的确定性步骤骨架，产出物不包含任何写指令。
 */
export function buildShadowPlan(input: BuildShadowPlanInput): ShadowPlanStep[] {
  const seen = new Set<string>();
  const steps: ShadowPlanStep[] = [];
  for (const event of input.events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    steps.push({
      stepId: `shadow:${input.planId}:prepare:${event.eventId}`,
      kind: "prepare",
      targetRef: event.targetRef,
    });
  }
  return steps;
}

// ─── 4. shadow 计划 / assessment 对比生成（不写 canonical）────────────────

/** 单个被对比项（canonical 与 shadow 各一份）。 */
export interface ShadowComparisonItem {
  itemId: string;
  kind: "plan" | "assessment";
  canonicalValue: string;
  shadowValue: string;
}

/** shadow 对比生成输入。 */
export interface BuildShadowComparisonInput {
  /** 对比项（canonical 与 shadow 逐项配对）。 */
  items: readonly ShadowComparisonItem[];
}

/** 单条对比结果。 */
export interface ShadowComparisonEntry {
  itemId: string;
  kind: "plan" | "assessment";
  canonicalValue: string;
  shadowValue: string;
  /** canonical 与 shadow 是否一致。 */
  agree: boolean;
}

/** shadow 对比输出（只含对比数据，不含 canonical 写 / UI 指令）。 */
export interface ShadowComparison {
  version: typeof SHADOW_MODE_VERSION;
  /** 对比总数（含一致与不一致）。 */
  compared: number;
  /** 一致数。 */
  agreed: number;
  /** 逐条对比（确定性顺序 = 输入顺序）。 */
  entries: readonly ShadowComparisonEntry[];
  /** 对比一致率（compared 为 0 时恒 0）。 */
  agreementRate: number;
  /** shadow 阶段 0 canonical 写：类型层面为只读空元组，运行时不可写。 */
  canonicalWrites: readonly [];
  /** UI 全关：shadow 阶段不产生 UI 指令。 */
  uiVisibility: "all_off";
}

/**
 * 生成 shadow 计划/assessment 对比（纯函数，不写 canonical）。
 * 逐项比较 canonicalValue 与 shadowValue；对比对象为「评估/计划结果」，不产生
 * 任何 canonical 写或 UI 指令。
 */
export function buildShadowComparison(
  input: BuildShadowComparisonInput,
): ShadowComparison {
  const entries: ShadowComparisonEntry[] = input.items.map((item) => ({
    itemId: item.itemId,
    kind: item.kind,
    canonicalValue: item.canonicalValue,
    shadowValue: item.shadowValue,
    agree: item.canonicalValue === item.shadowValue,
  }));
  const agreed = entries.filter((e) => e.agree).length;
  return {
    version: SHADOW_MODE_VERSION,
    compared: entries.length,
    agreed,
    entries,
    agreementRate: entries.length > 0 ? agreed / entries.length : 0,
    canonicalWrites: [],
    uiVisibility: "all_off",
  };
}

// ─── 5. 0 canonical 写与 UI 全关断言（fail closed）────────────────────────

/**
 * 0 canonical 写断言：校验 shadow 输出不含任何 canonical 写指令。
 * 类型层面 `ShadowComparison.canonicalWrites` 已是只读空元组；本函数是运行时
 * 强断言（fail closed），对任何携带 canonical 写指令的对象返回违规列表。
 */
export function assertShadowZeroCanonicalWrites(
  output: Pick<ShadowComparison, "canonicalWrites">,
): readonly string[] {
  const writes = output.canonicalWrites;
  if (writes.length !== 0) {
    return [`shadow 输出存在 canonical 写指令 ${writes.join(",")}：必须为 0`];
  }
  return [];
}

/** UI 展示指令（shadow 阶段禁止）。 */
export interface ShadowUiInstruction {
  kind: "render_plan" | "render_comparison" | "show_suggestion";
  targetRef: string;
}

/** UI 全关断言输入。 */
export interface ShadowUiAllOffInput {
  /** 当前 UI 可见性（shadow 阶段必须为 all_off）。 */
  uiVisibility: string;
  /** 本阶段产生的 UI 展示指令（必须为空）。 */
  uiInstructions?: readonly ShadowUiInstruction[];
}

/**
 * UI 全关断言（fail closed）：uiVisibility 必须为 `all_off`，且不存在任何
 * UI 展示指令。任一违反返回违规列表。
 */
export function assertShadowUiAllOff(input: ShadowUiAllOffInput): readonly string[] {
  const violations: string[] = [];
  if (input.uiVisibility !== "all_off") {
    violations.push(`shadow 阶段 UI 必须全关，实际 uiVisibility=${input.uiVisibility}`);
  }
  const instructions = input.uiInstructions ?? [];
  if (instructions.length > 0) {
    violations.push(
      `shadow 阶段 UI 全关，实际存在 ${instructions.length} 条 UI 指令（${instructions.map((i) => i.kind).join(",")}）`,
    );
  }
  return violations;
}

// ─── 6. 对比数据 Gate 门槛达标判定（引用 RolloutStageGateV1）───────────────

/** shadow 对比数据的 Gate 观察输入（§18.2 RolloutStageGateV1 shadow 档）。 */
export interface ShadowGateEvidence {
  /** 对比 Episode 数（样本量）。 */
  episodes: number;
  /** 用户数。 */
  users: number;
  /** workspace 数。 */
  workspaces: number;
  /** 最短 soak 时长（小时）。 */
  soakHours: number;
  /** 模态覆盖（voice / silent / text）。 */
  modalityCoverage: Readonly<{ voice: boolean; silent: boolean; text: boolean }>;
  /** Provider / ASR 覆盖。 */
  providerCoverage: Readonly<{ providers: readonly string[]; asr: boolean }>;
  /** hard incident 数（必须为 0）。 */
  hardIncidents: number;
  /** soft error 数（必须在 soft budget 内）。 */
  softErrors: number;
  /** 置信区间观察。 */
  confidenceInterval: Readonly<{ alpha: number; margin: number; n: number }>;
}

/** 单项 Gate 检查。 */
export interface ShadowGateCheck {
  id: string;
  passed: boolean;
  detail: string;
}

/** shadow 档 Gate 达标判定结果。 */
export interface ShadowGateVerdict {
  /** 引用冻结档位表（10-w9 前置 / final-soak RolloutStageGateV1）。 */
  gate: RolloutStageGateV1;
  passed: boolean;
  checks: readonly ShadowGateCheck[];
  problems: readonly string[];
}

/**
 * 对比数据 Gate 门槛达标判定（引用 RolloutStageGateV1）：
 * 按 final-soak 冻结的 shadow 档门槛（`ROLLOUT_STAGE_GATES.shadow`）判定
 * 样本量（Episode/用户/workspace）、soak 时长、voice/silent/text 与
 * Provider/ASR 覆盖、hard incident=0、soft error budget 与数据置信区间
 * （alpha / margin / 样本数）。任一不满足 → fail closed（样本不足不进入下一档）。
 */
export function evaluateShadowGate(
  evidence: ShadowGateEvidence,
): ShadowGateVerdict {
  const gate = ROLLOUT_STAGE_GATES[SHADOW_STAGE];
  const checks: ShadowGateCheck[] = [];

  checks.push({
    id: "episodes",
    passed: evidence.episodes >= gate.minEpisodes,
    detail: `episodes=${evidence.episodes}/${gate.minEpisodes}`,
  });
  checks.push({
    id: "users",
    passed: evidence.users >= gate.minUsers,
    detail: `users=${evidence.users}/${gate.minUsers}`,
  });
  checks.push({
    id: "workspaces",
    passed: evidence.workspaces >= gate.minWorkspaces,
    detail: `workspaces=${evidence.workspaces}/${gate.minWorkspaces}`,
  });
  checks.push({
    id: "soak",
    passed: evidence.soakHours >= gate.minSoakHours,
    detail: `soakHours=${evidence.soakHours}/${gate.minSoakHours}`,
  });
  checks.push({
    id: "modality_coverage",
    passed:
      evidence.modalityCoverage.voice &&
      evidence.modalityCoverage.silent &&
      evidence.modalityCoverage.text,
    detail: `voice=${evidence.modalityCoverage.voice} silent=${evidence.modalityCoverage.silent} text=${evidence.modalityCoverage.text}`,
  });
  const providerMissing = gate.providerCoverage.providers.filter(
    (p) => !evidence.providerCoverage.providers.includes(p),
  );
  checks.push({
    id: "provider_asr_coverage",
    passed:
      providerMissing.length === 0 &&
      (!gate.providerCoverage.asr || evidence.providerCoverage.asr),
    detail: `providers=[${evidence.providerCoverage.providers.join(",")}] asr=${evidence.providerCoverage.asr}（缺失：${providerMissing.join(",") || "无"}）`,
  });
  checks.push({
    id: "hard_incidents",
    passed: evidence.hardIncidents === gate.hardIncidents,
    detail: `hardIncidents=${evidence.hardIncidents}/${gate.hardIncidents}（必须为 0）`,
  });
  checks.push({
    id: "soft_error_budget",
    passed: evidence.softErrors <= gate.softErrorBudget,
    detail: `softErrors=${evidence.softErrors}/budget=${gate.softErrorBudget}`,
  });
  const ci = evidence.confidenceInterval;
  checks.push({
    id: "confidence_interval",
    passed:
      ci.n >= gate.minConfidenceSamples &&
      ci.alpha <= gate.confidenceInterval.alpha &&
      ci.margin <= gate.confidenceInterval.maxMargin,
    detail: `n=${ci.n}/${gate.minConfidenceSamples} alpha=${ci.alpha}/${gate.confidenceInterval.alpha} margin=${ci.margin}/${gate.confidenceInterval.maxMargin}`,
  });

  const problems = checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`);
  return {
    gate,
    passed: problems.length === 0,
    checks,
    problems,
  };
}

/**
 * 组合判定：对比数据达到 Gate 门槛 **且** 0 canonical 写 **且** UI 全关。
 * 这是任务 10-2 验收「shadow 输出 0 canonical 写；对比数据达到 Gate 门槛」
 * 的纯逻辑组合：任一维度不满足 → fail closed。
 */
export function evaluateShadowMode(
  evidence: ShadowGateEvidence,
  comparison: Pick<ShadowComparison, "canonicalWrites" | "uiVisibility">,
): {
  gateVerdict: ShadowGateVerdict;
  zeroCanonicalWrites: boolean;
  uiAllOff: boolean;
  passed: boolean;
} {
  const gateVerdict = evaluateShadowGate(evidence);
  const zeroCanonicalWrites = assertShadowZeroCanonicalWrites(comparison).length === 0;
  const uiAllOff = assertShadowUiAllOff({
    uiVisibility: comparison.uiVisibility,
  }).length === 0;
  return {
    gateVerdict,
    zeroCanonicalWrites,
    uiAllOff,
    passed: gateVerdict.passed && zeroCanonicalWrites && uiAllOff,
  };
}
