/**
 * 阶段 10（W9）任务 10-4/10-6：Canary 档位纯逻辑（§18.2 RolloutStageGateV1）。
 *
 * 本文件是**纯逻辑**（无 DB / 无网络 / 无时钟 / 无副作用 / 无随机）：把 §18.2
 * 第 3/5 步的 5%/25% workspace-stable canary 档位规则与冻结记录 01-7 的
 * capability bundle 依赖图翻译成确定性函数。调用方注入样本与稳定性信号，
 * 本模块只做判定；门槛全部冻结为常量（FROZEN_*），不允许运行时调低。
 *
 * 覆盖的任务要求（10-4 §18.2 第 3 步 / 10-6 §18.2 第 5 步）：
 * - 档位模型：5%（pct-5）与 25%（pct-25）两档，25% 是 5% 的扩量档；
 * - workspace-stable 选择：以 workspace 为稳定分配单元（同一 workspace 内用户
 *   一致），确定性哈希把 workspace 稳定落入档位；稳定性信号（活跃用户数、
 *   已 commit Session 数、近期 hard incident/soft error）决定该 workspace
 *   是否真正可入选；
 * - canary 内容清单：internal atomic core + voice + silent bundle +
 *   learning-session companion + card/review 入口 + star map v2 回写 +
 *   origin-aware completion + current-target Tutor；25% 内容与 5% 一致（扩量
 *   不扩能力）；
 * - 合批规则：相邻低风险 flag 可合批，但 credential-safe、onboarding 零学习
 *   副作用、Formal/Practice、双 Critic、commit、scheduler adapter 与 RLS
 *   七个原子 bundle 不允许拆开上线；
 * - Gate 达标判定（RolloutStageGateV1）：样本量（Session/Episode/用户/
 *   workspace）、voice/silent/text 与 Provider/ASR 覆盖、最短 soak 时长、
 *   hard incident=0、soft error budget、p95 成本预算、数据置信区间；
 *   25% 档额外要求 hard-kill rollback drill 已完成（含证据引用）。
 *
 * 复用（只读）：observability/metrics-schema.ts 的 CostSample / CostDimension /
 * computeUserCostPercentile / checkP95CostCap（p95 成本预算判定）。
 */

import {
  checkP95CostCap,
  computeUserCostPercentile,
  type CostDimension,
  type CostSample,
} from "../observability/metrics-schema.ts";

// ─── 1. 档位模型（§18.2 第 3/5 步）─────────────────────────────────────────

/** Canary 档位：5%（pct-5）→ 25%（pct-25）两档递增。 */
export type CanaryTier = "pct-5" | "pct-25";

/** 档位顺序（25% 是 5% 的扩量档；样本不足不能进入下一档）。 */
export const CANARY_TIER_ORDER: readonly CanaryTier[] = ["pct-5", "pct-25"];

/** 档位 → workspace 入选比例。 */
export const CANARY_TIER_PERCENT: Record<CanaryTier, number> = {
  "pct-5": 0.05,
  "pct-25": 0.25,
};

/** 类型守卫：字符串是否为合法 canary 档位。 */
export function isCanaryTier(value: string): value is CanaryTier {
  return (CANARY_TIER_ORDER as readonly string[]).includes(value);
}

// ─── 2. workspace-stable 选择（§18.2 workspace-stable）─────────────────────

/** 确定性字符串哈希（FNV-1a 32-bit），同一 workspaceId 恒得同一分值。 */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * workspace 稳定分值：基于 workspaceId 的确定性 [0,1) 值。
 * workspace-stable 语义 = 分配单元是 workspace 而非用户；同一 workspace 的
 * 所有用户进入同一档位，避免同一 workspace 内体验不一致。
 */
export function workspaceStableScore(workspaceId: string): number {
  return fnv1a32(`ws:${workspaceId}`) / 0xffffffff;
}

/** 该 workspace 的档位候选（按确定性分值落入 5%/25% 或不入档）。 */
export function candidateTierForWorkspace(workspaceId: string): CanaryTier | null {
  const score = workspaceStableScore(workspaceId);
  if (score < CANARY_TIER_PERCENT["pct-5"]) return "pct-5";
  if (score < CANARY_TIER_PERCENT["pct-25"]) return "pct-25";
  return null;
}

/** workspace 稳定性信号（由调用方注入；本模块只判定）。 */
export interface WorkspaceStabilitySignals {
  /** 活跃用户数（must ≥ 1 才算活跃 workspace）。 */
  activeUsers: number;
  /** 已 commit Session 数（说明有真实学习写入在跑）。 */
  committedSessions: number;
  /** 近期 hard incident 数（privacy/tenant/答案泄漏/trust/Critic/schedule）。 */
  recentHardIncidents: number;
  /** 近期 soft error 数（UI/overlay/Tutor 展示类）。 */
  recentSoftErrors: number;
  /** 近期 Session 样本量（soft error rate 的分母）。 */
  recentSessionSamples: number;
}

/** workspace 稳定性门槛（冻结：至少 1 活跃用户 + 若干已 commit Session + 0 hard incident）。 */
export const FROZEN_WORKSPACE_STABILITY_THRESHOLDS = {
  minActiveUsers: 1,
  minCommittedSessions: 3,
  maxRecentHardIncidents: 0,
  maxRecentSoftErrorRate: 0.2,
} as const;

/**
 * workspace 是否稳定（决定能否真正入选 canary）：
 * - 活跃用户数 ≥ 门槛；
 * - 已 commit Session ≥ 门槛（workspace-stable 需要真实学习航迹，不只登录）；
 * - 近期 hard incident = 0（hard 违规 workspace 不得进入 canary）；
 * - 近期 soft error rate ≤ 门槛（有样本时；无样本判定为不稳定）。
 */
export function isWorkspaceStable(
  signals: WorkspaceStabilitySignals,
  thresholds: typeof FROZEN_WORKSPACE_STABILITY_THRESHOLDS =
    FROZEN_WORKSPACE_STABILITY_THRESHOLDS,
): boolean {
  if (signals.activeUsers < thresholds.minActiveUsers) return false;
  if (signals.committedSessions < thresholds.minCommittedSessions) return false;
  if (signals.recentHardIncidents > thresholds.maxRecentHardIncidents) return false;
  if (signals.recentSessionSamples <= 0) return false;
  const rate = signals.recentSoftErrors / signals.recentSessionSamples;
  return rate <= thresholds.maxRecentSoftErrorRate;
}

/** workspace-stable 选择结果。 */
export type WorkspaceSelection = {
  workspaceId: string;
  /** 候选档位（按确定性分值；null = 不入档）。 */
  candidateTier: CanaryTier | null;
  /** 是否稳定（候选档位非 null 且稳定性信号达标）。 */
  selected: boolean;
  /** 未入选原因（selected=true 时为空字符串）。 */
  reason: string;
};

/**
 * workspace-stable 选择：候选档位 + 稳定性门槛合并。
 * selected = candidateTier 非 null 且 isWorkspaceStable 通过。
 */
export function selectWorkspaceForCanary(
  workspaceId: string,
  signals: WorkspaceStabilitySignals,
): WorkspaceSelection {
  const candidateTier = candidateTierForWorkspace(workspaceId);
  if (candidateTier === null) {
    return { workspaceId, candidateTier: null, selected: false, reason: "workspace_score_out_of_range" };
  }
  if (!isWorkspaceStable(signals)) {
    return {
      workspaceId,
      candidateTier,
      selected: false,
      reason:
        "workspace_unstable(activeUsers/committedSessions/recentHardIncidents/recentSoftErrors 任一不达标)",
    };
  }
  return { workspaceId, candidateTier, selected: true, reason: "" };
}

// ─── 3. canary 内容清单（§18.2 第 3 步）───────────────────────────────────

/**
 * canary 内容 id（10-4：internal atomic core + voice + silent bundle；
 * learning-session companion + card/review 入口；star map v2 回写 +
 * origin-aware completion；current-target Tutor 进入 canary）。
 */
export type CanaryContentId =
  /** trusted_multimodal_core（internal atomic core：Session/Episode + 双 Critic + commit + outbox）。 */
  | "internal_atomic_core"
  /** multimodal_voice（voice 主路径 + text fallback）。 */
  | "voice"
  /** structured_proof_v1（silent mastery bundle）。 */
  | "silent_bundle"
  /** learning_session_companion（learning-session companion）。 */
  | "learning_session_companion"
  /** learning card / review 入口（四 origin 就地完成）。 */
  | "card_review_entries"
  /** understanding_universe_v2 星图 v2 回写。 */
  | "star_map_v2_writeback"
  /** origin-aware completion（Card/Review/Now/Star origin 就地完成语义）。 */
  | "origin_aware_completion"
  /** current_target_tutor（current-target Grounded Tutor）。 */
  | "current_target_tutor";

/** 5% 档 canary 内容（§18.2 第 3 步的完整清单）。 */
export const CANARY_5PCT_CONTENTS: readonly CanaryContentId[] = [
  "internal_atomic_core",
  "voice",
  "silent_bundle",
  "learning_session_companion",
  "card_review_entries",
  "star_map_v2_writeback",
  "origin_aware_completion",
  "current_target_tutor",
];

/**
 * 25% 档 canary 内容：与 5% 一致（§18.2 第 5 步是扩量档，不扩能力；
 * 能力升级/Should flags 独立 shadow/canary，不属于本档内容）。
 */
export const CANARY_25PCT_CONTENTS: readonly CanaryContentId[] = [
  ...CANARY_5PCT_CONTENTS,
];

/** 档位 → canary 内容清单。 */
export function canaryContentsForTier(tier: CanaryTier): readonly CanaryContentId[] {
  return tier === "pct-5" ? CANARY_5PCT_CONTENTS : CANARY_25PCT_CONTENTS;
}

// ─── 4. 合批规则（§18.2 第 3 步：不可拆开的原子 bundle）────────────────────

/**
 * 不可拆开的原子 bundle（01-7 冻结记录 §4 原子内容 + §18.2 第 3 步明确列出的
 * 七项）。任一成员的 flag 一旦被 proposed，整个 bundle 必须同时上线；
 * 只上部分成员 = 拆开上线 = 违规。
 */
export const ATOMIC_BUNDLES = [
  {
    id: "credential_safe",
    members: ["auth_manifest_signed", "credential_pages_allowlist"],
    description: "credential-safe auth manifest（01-7 §4 global_companion_shell 原子内容）",
  },
  {
    id: "onboarding_zero_side_effect",
    members: ["onboarding_sample_isolation", "demo_card_scene_renderer", "cas_state_machine"],
    description: "onboarding 零学习副作用（01-7 §4 companion_onboarding_v1 原子内容）",
  },
  {
    id: "formal_practice",
    members: ["formal_probes", "practice_entries"],
    description: "Formal/Practice 数据与视觉副作用分离（01-7 §4 trusted_multimodal_core 原子内容）",
  },
  {
    id: "dual_critic",
    members: ["scene_critic", "assessment_critic"],
    description: "双 Critic（Scene Critic + Assessment Critic 相互独立且 mandatory）",
  },
  {
    id: "commit",
    members: ["existing_domain_commit", "outbox"],
    description: "existing-domain commit + outbox（01-7 §4 trusted_multimodal_core 原子内容）",
  },
  {
    id: "scheduler_adapter",
    members: ["official_scheduler_adapter"],
    description: "official scheduler adapter（01-7 §4 journey_routes 依赖；FSRS shadow 不是依赖）",
  },
  {
    id: "rls",
    members: ["rls_matrix"],
    description: "RLS（audit user-private / ledger user-private-in-workspace，02-2 矩阵）",
  },
] as const;

export type AtomicBundleId = (typeof ATOMIC_BUNDLES)[number]["id"];

/** 合批校验结果。 */
export interface BatchCheckVerdict {
  /** 是否合规（未拆开任何原子 bundle；空 proposed 视为无操作，合规）。 */
  compliant: boolean;
  /** 违规详情列表（拆开上线的原子 bundle）。 */
  violations: string[];
}

/**
 * 合批规则：相邻低风险 flag 可合批（不在任何原子 bundle 成员集合内的 flag
 * 都是可合批的），但七个原子 bundle 不允许拆开上线——proposed 与某 bundle
 * 成员的交集非空且未包含全部成员即判违规。
 */
export function checkAtomicBundleIntegrity(
  proposedFlags: readonly string[],
): BatchCheckVerdict {
  const violations: string[] = [];
  for (const bundle of ATOMIC_BUNDLES) {
    const present = bundle.members.filter((m) => proposedFlags.includes(m));
    if (present.length > 0 && present.length < bundle.members.length) {
      violations.push(
        `atomic bundle "${bundle.id}" 被拆开上线：仅 ${present.join(",")}，必须整组 ${bundle.members.join(",")} 一起（${bundle.description}）`,
      );
    }
  }
  return { compliant: violations.length === 0, violations };
}

// ─── 5. RolloutStageGateV1 门槛（§18.2，冻结）──────────────────────────────

/** Gate 数据输入（样本量 / soak / incident / 覆盖 / 成本 / 置信区间 / drill）。 */
export interface CanaryGateInput {
  /** 最低样本量：Session / Episode / 用户 / workspace 数。 */
  sessions: number;
  episodes: number;
  users: number;
  workspaces: number;
  /** 最短 soak 时长（天）。 */
  soakDays: number;
  /** hard incident 数（privacy/tenant/答案泄漏/trust/Critic/schedule 不变量）。 */
  hardIncidents: number;
  /** soft error 数（UI/overlay/Tutor 展示类）。 */
  softErrors: number;
  /** 覆盖：voice / silent / text 与 Provider / ASR（0..1）。 */
  coverage: {
    voice: number;
    silent: number;
    text: number;
    provider: number;
    asr: number;
  };
  /** 用户级成本样本（p95 预算判定用；每个用户一个样本）。 */
  userCostSamples: readonly CostSample[];
  /** 数据置信区间（下界/上界；用于要求 CI 下界高于阈值的档位）。 */
  confidenceInterval: { lower: number; upper: number } | null;
  /** hard-kill rollback drill 完成证据（25% 档强制；含证据引用）。 */
  hardKillDrill: { completed: boolean; evidenceRef: string } | null;
}

/** 单档冻结门槛（RolloutStageGateV1，§18.2 概述 + 08-4/09-4 口径冻结）。 */
export interface CanaryGateThresholds {
  minSessions: number;
  minEpisodes: number;
  minUsers: number;
  minWorkspaces: number;
  /** 最短 soak 时长（天）。 */
  minSoakDays: number;
  /** hard incident 上限（冻结为 0；>0 即不达标）。 */
  maxHardIncidents: number;
  /** soft error budget（0..1；softErrors / sessions 不得超过）。 */
  softErrorBudget: number;
  /** 覆盖门槛（voice/silent/text/provider/asr 统一最低比例，0..1）。 */
  minCoverage: number;
  /** p95 成本预算（按维度；任一维度 p95 越限即不达标）。 */
  p95CostCaps: Partial<Record<CostDimension, number>>;
  /** 是否要求数据置信区间（并要求下界 ≥ minConfidenceLowerBound）。 */
  requireConfidenceInterval: boolean;
  minConfidenceLowerBound: number;
  /** 是否强制要求 hard-kill drill 已完成（25% 档为 true）。 */
  requireHardKillDrill: boolean;
}

/**
 * 冻结的 RolloutStageGateV1（W9 冻结，§18.2 第 3/5 步；样本量随档位递增，
 * hard incident 上限恒为 0，p95 成本预算与覆盖门槛 25% 档更严）。
 */
export const FROZEN_CANARY_GATES: Record<CanaryTier, CanaryGateThresholds> = {
  "pct-5": {
    minSessions: 300,
    minEpisodes: 400,
    minUsers: 60,
    minWorkspaces: 25,
    minSoakDays: 3,
    maxHardIncidents: 0,
    softErrorBudget: 0.05,
    minCoverage: 0.8,
    p95CostCaps: {
      llmCalls: 40,
      inputTokens: 20000,
      outputTokens: 8000,
      asrSeconds: 300,
      ttsCharacters: 4000,
      objectStorageBytes: 10 * 1024 * 1024,
      tutorBudgetUnits: 50,
    },
    requireConfidenceInterval: true,
    minConfidenceLowerBound: 0.8,
    requireHardKillDrill: false,
  },
  "pct-25": {
    minSessions: 1500,
    minEpisodes: 2000,
    minUsers: 300,
    minWorkspaces: 125,
    minSoakDays: 7,
    maxHardIncidents: 0,
    softErrorBudget: 0.02,
    minCoverage: 0.9,
    p95CostCaps: {
      llmCalls: 40,
      inputTokens: 20000,
      outputTokens: 8000,
      asrSeconds: 300,
      ttsCharacters: 4000,
      objectStorageBytes: 10 * 1024 * 1024,
      tutorBudgetUnits: 50,
    },
    requireConfidenceInterval: true,
    minConfidenceLowerBound: 0.9,
    requireHardKillDrill: true,
  },
};

/** 注入门槛低于冻结值 → 抛错（门槛冻结，不允许调低；09-2 同款 fail closed 模式）。 */
export class CanaryStageError extends Error {
  readonly code = "CANARY_STAGE_GATE_FROZEN" as const;
  constructor(message: string) {
    super(message);
    this.name = "CanaryStageError";
  }
}

/** 断言注入门槛不低于冻结值；任一字段更低即抛 CanaryStageError。 */
export function assertGateThresholdsFrozen(
  tier: CanaryTier,
  injected: CanaryGateThresholds,
): void {
  const frozen = FROZEN_CANARY_GATES[tier];
  const numericFields: Array<keyof Pick<
    CanaryGateThresholds,
    | "minSessions"
    | "minEpisodes"
    | "minUsers"
    | "minWorkspaces"
    | "minSoakDays"
    | "softErrorBudget"
    | "minCoverage"
    | "minConfidenceLowerBound"
  >> = [
    "minSessions",
    "minEpisodes",
    "minUsers",
    "minWorkspaces",
    "minSoakDays",
    "softErrorBudget",
    "minCoverage",
    "minConfidenceLowerBound",
  ];
  for (const field of numericFields) {
    if (injected[field] < frozen[field]) {
      throw new CanaryStageError(
        `canary gate 门槛冻结：${tier}.${field}=${injected[field]} 低于冻结值 ${frozen[field]}`,
      );
    }
  }
  if (injected.maxHardIncidents > frozen.maxHardIncidents) {
    throw new CanaryStageError(
      `canary gate 门槛冻结：${tier}.maxHardIncidents=${injected.maxHardIncidents} 高于冻结值 0（hard incident 必须为 0）`,
    );
  }
  if (injected.requireHardKillDrill !== frozen.requireHardKillDrill) {
    throw new CanaryStageError(
      `canary gate 门槛冻结：${tier}.requireHardKillDrill 必须为 ${frozen.requireHardKillDrill}`,
    );
  }
}

// ─── 6. Gate 达标判定（§18.2）─────────────────────────────────────────────

/** 单项 Gate 检查结果。 */
export interface GateCheck {
  id: string;
  passed: boolean;
  detail: string;
}

/** Gate 判定结果。 */
export interface CanaryGateVerdict {
  tier: CanaryTier;
  passed: boolean;
  checks: readonly GateCheck[];
  problems: readonly string[];
}

/**
 * 5% 档达到冻结 Gate（§18.2 第 3 步验收）与 25% 档按冻结 Gate 验证
 * （§18.2 第 5 步验收，含 hard-kill drill 完成证据）。
 *
 * 检查项（RolloutStageGateV1）：
 * 1. samples：Session/Episode/用户/workspace 全部 ≥ 门槛；
 * 2. soak：soakDays ≥ 最短 soak；
 * 3. hard_incidents：hardIncidents = 0；
 * 4. soft_error_budget：softErrors / sessions ≤ softErrorBudget；
 * 5. coverage：voice/silent/text/provider/asr 全部 ≥ minCoverage；
 * 6. p95_cost：复用 metrics-schema checkP95CostCap（任一维度 p95 越限违规；
 *    每用户成本由 computeUserCostPercentile 计算）；
 * 7. confidence_interval：requireConfidenceInterval 时要求
 *    confidenceInterval 非 null 且下界 ≥ minConfidenceLowerBound、下界 ≤ 上界；
 * 8. hard_kill_drill：requireHardKillDrill 时要求 drill.completed=true 且
 *    evidenceRef 非空（25% 档强制；5% 档跳过）。
 */
export function evaluateCanaryGate(
  tier: CanaryTier,
  input: CanaryGateInput,
  thresholds: CanaryGateThresholds = FROZEN_CANARY_GATES[tier],
): CanaryGateVerdict {
  assertGateThresholdsFrozen(tier, thresholds);
  const checks: GateCheck[] = [];

  // 1. 样本量
  const samplesPassed =
    input.sessions >= thresholds.minSessions &&
    input.episodes >= thresholds.minEpisodes &&
    input.users >= thresholds.minUsers &&
    input.workspaces >= thresholds.minWorkspaces;
  checks.push({
    id: "samples",
    passed: samplesPassed,
    detail:
      `sessions=${input.sessions}/${thresholds.minSessions} episodes=${input.episodes}/${thresholds.minEpisodes} ` +
      `users=${input.users}/${thresholds.minUsers} workspaces=${input.workspaces}/${thresholds.minWorkspaces}`,
  });

  // 2. soak
  checks.push({
    id: "soak",
    passed: input.soakDays >= thresholds.minSoakDays,
    detail: `soakDays=${input.soakDays}/${thresholds.minSoakDays}`,
  });

  // 3. hard incident = 0
  checks.push({
    id: "hard_incidents",
    passed: input.hardIncidents <= thresholds.maxHardIncidents,
    detail: `hardIncidents=${input.hardIncidents}/${thresholds.maxHardIncidents}（必须为 0）`,
  });

  // 4. soft error budget
  const softRate = input.sessions > 0 ? input.softErrors / input.sessions : 1;
  checks.push({
    id: "soft_error_budget",
    passed: softRate <= thresholds.softErrorBudget,
    detail:
      `softErrors/sessions=${softRate.toFixed(4)}/budget=${thresholds.softErrorBudget}`,
  });

  // 5. 覆盖（voice/silent/text + Provider/ASR）
  const coverageEntries: Array<[string, number]> = [
    ["voice", input.coverage.voice],
    ["silent", input.coverage.silent],
    ["text", input.coverage.text],
    ["provider", input.coverage.provider],
    ["asr", input.coverage.asr],
  ];
  const coveragePassed = coverageEntries.every(([, ratio]) => ratio >= thresholds.minCoverage);
  checks.push({
    id: "coverage",
    passed: coveragePassed,
    detail:
      coverageEntries
        .map(([kind, ratio]) => `${kind}=${ratio.toFixed(3)}`)
        .join(" ") +
      ` min=${thresholds.minCoverage}`,
  });

  // 6. p95 成本（复用 metrics-schema）
  const costProblems = checkP95CostCap(input.userCostSamples, thresholds.p95CostCaps);
  const p95Violations = Object.keys(thresholds.p95CostCaps).filter((dim) => {
    const cap = thresholds.p95CostCaps[dim as CostDimension];
    if (cap === undefined || cap < 0) return false;
    return computeUserCostPercentile(input.userCostSamples, dim as CostDimension, 0.95) > cap;
  });
  checks.push({
    id: "p95_cost",
    passed: costProblems.length === 0,
    detail:
      costProblems.length > 0
        ? costProblems.join("; ")
        : `p95 成本全部在预算内（越限维度：${p95Violations.length > 0 ? p95Violations.join(",") : "无"}）`,
  });

  // 7. 数据置信区间
  const ci = input.confidenceInterval;
  const ciPassed =
    !thresholds.requireConfidenceInterval ||
    (ci !== null &&
      ci.lower >= thresholds.minConfidenceLowerBound &&
      ci.lower <= ci.upper);
  checks.push({
    id: "confidence_interval",
    passed: ciPassed,
    detail: thresholds.requireConfidenceInterval
      ? ci === null
        ? "未提供置信区间（required）"
        : `CI lower=${ci.lower}/min=${thresholds.minConfidenceLowerBound} upper=${ci.upper}`
      : "不要求（5% 档可跳过）",
  });

  // 8. hard-kill drill（25% 档强制）
  const drill = input.hardKillDrill;
  const drillPassed =
    !thresholds.requireHardKillDrill ||
    (drill !== null && drill.completed && drill.evidenceRef.trim().length > 0);
  checks.push({
    id: "hard_kill_drill",
    passed: drillPassed,
    detail: thresholds.requireHardKillDrill
      ? drill === null
        ? "未提供 hard-kill drill 证据（required）"
        : `completed=${drill.completed} evidenceRef="${drill.evidenceRef}"`
      : "5% 档不要求（drill 在进入 25% 前完成）",
  });

  const problems = checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`);
  return {
    tier,
    passed: problems.length === 0,
    checks,
    problems,
  };
}

/** 检查 5% 档已达标后是否可进入 25% 档（还需 25% 档自身 Gate + drill 证据）。 */
export function canEscalateFrom5To25(
  fivePctVerdict: CanaryGateVerdict,
): boolean {
  if (fivePctVerdict.tier !== "pct-5") return false;
  if (!fivePctVerdict.passed) return false;
  // 5% 档必须已完成（含已达标）；25% 档 gate 由 evaluateCanaryGate("pct-25", …) 判定。
  return true;
}
