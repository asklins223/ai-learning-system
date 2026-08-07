import type { GenerationExecutionMode } from "@ailearn/shared";

/**
 * P3-6/P3-7: Planned → Full 升级条件与三路径升级矩阵(实施计划 §3.2/§5.3)。
 *
 * **升级条件**(P3-6):
 * - Replan 后仍失败(仍有 escalate 级 gap / Replan 次数用尽由 run 预算判定);
 * - Coverage 不足(survivingCoverage < 阈值);
 * - 上下文不足(上下文利用率超限或 token 预算告急);
 * - 复杂 Hard Issue(critical/high 且 deterministic=false 的 issue)。
 *
 * **不变量**:
 * - 升级**不重置 repairCount**(观测计数,见 §7 不变量);
 * - 失败 Artifact **不发布**(Fast/Planned 失败 Artifact 不直接发布,§7);
 * - 升级矩阵启用需四项验证通过(见 verifyUpgradeMatrixPrerequisites)。
 */

export type PathMode = Exclude<GenerationExecutionMode, "full_supervisor_v1"> | "full_supervisor_v1";

export interface UpgradeEvaluationInput {
  /** Replan 后仍存在 escalate 级 gap */
  escalateGapsRemain: boolean;
  /** coverage ledger 完整且 surviving coverage(0-1) */
  coverageComplete: boolean;
  survivingCoverage: number;
  coverageThreshold: number;
  /** 上下文利用率(0-1),超限视为上下文不足 */
  contextUtilization: number;
  contextThreshold: number;
  /** 复杂 Hard Issue 存在(critical/high 且 deterministic=false) */
  hasComplexHardIssue: boolean;
  /** 当前路径(含 full:full 自身不升级,运行时防御) */
  currentMode: "fast_two_stage_v1" | "adaptive_planned_v1" | "full_supervisor_v1";
}

export interface UpgradeDecision {
  /** 是否升级到 full_supervisor_v1 */
  escalate: boolean;
  reason: string[];
}

/** 升级条件判定(纯函数;任一命中即升级) */
export function decideUpgrade(input: UpgradeEvaluationInput): UpgradeDecision {
  // P3-6: 仅 fast/planned 可升级到 full;full 自身不升级(类型层面已排除,运行时防御)
  if (input.currentMode === "full_supervisor_v1") {
    return { escalate: false, reason: [] };
  }

  const reason: string[] = [];

  if (input.escalateGapsRemain) reason.push("replan_后仍有_escalate_级_gap");
  if (!input.coverageComplete || input.survivingCoverage < input.coverageThreshold) {
    reason.push(`coverage_不足(${input.survivingCoverage.toFixed(3)} < ${input.coverageThreshold})`);
  }
  if (input.contextUtilization > input.contextThreshold) {
    reason.push(`上下文不足(利用率 ${(input.contextUtilization * 100).toFixed(0)}% > ${(input.contextThreshold * 100).toFixed(0)}%)`);
  }
  if (input.hasComplexHardIssue) reason.push("存在复杂_Hard_Issue");

  return { escalate: reason.length > 0, reason };
}

// ─── P3-7: 升级矩阵切换前置验证 ─────────────────────────────────────────

export interface UpgradeMatrixPrerequisites {
  /** Fast ExtractArtifact 可复用(验证过且未受影响) */
  reusableArtifacts: boolean;
  /** Gap Detection 能识别 Fast 遗留(覆盖检查) */
  gapDetectionCatchesFastLeftovers: boolean;
  /** Repair 不重置(升级路径不重置 repairCount) */
  repairNotReset: boolean;
  /** 成本叠加统计(成本模型按路径叠加,不重复计数) */
  costStacking: boolean;
}

export interface PrerequisiteViolation {
  code: "reusable_artifacts" | "gap_detection_fast_leftovers" | "repair_not_reset" | "cost_stacking";
  message: string;
}

/**
 * 升级矩阵启用前置四项验证(§5.3 P3-7 验收):
 * 全部通过才允许 Fast→Planned/Planned→Full 切换。
 */
export function verifyUpgradeMatrixPrerequisites(p: UpgradeMatrixPrerequisites): PrerequisiteViolation[] {
  const violations: PrerequisiteViolation[] = [];
  if (!p.reusableArtifacts) violations.push({ code: "reusable_artifacts", message: "Fast ExtractArtifact 不可复用,不能安全升级" });
  if (!p.gapDetectionCatchesFastLeftovers) violations.push({ code: "gap_detection_fast_leftovers", message: "Gap Detection 无法识别 Fast 遗留,升级后缺口不可见" });
  if (!p.repairNotReset) violations.push({ code: "repair_not_reset", message: "升级路径会重置 repairCount,违反不变量" });
  if (!p.costStacking) violations.push({ code: "cost_stacking", message: "成本叠加统计未就绪,升级后成本失真" });
  return violations;
}
