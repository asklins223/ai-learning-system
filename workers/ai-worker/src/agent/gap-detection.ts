import type { GenerationPlan, GenerationPlanBundleTask } from "@ailearn/shared";

/**
 * P3-2: 确定性 Gap Detection(实施计划 §3.2)。
 *
 * 纯代码信号优先;Specialist 自报(PlanMismatchSignal)只能作为 Replan 触发**加项**,
 * 不能单独作为成功判定。误报率有测试样本(见 __tests__/gap-detection.test.ts)。
 */

export type GapSeverity = "replannable" | "escalate";

export interface GapSignal {
  /** §3.2 信号代码(短英文标识,与测试样本一一对应) */
  code: string;
  severity: GapSeverity;
  /** 关联 bundleId(无则空) */
  bundleId?: string;
  message: string;
}

export interface SpecialistOutcome {
  /** Bundle 是否给出明确决策(decisionKind ∈ candidate|no_candidate) */
  hasDecision: boolean;
  decisionKind?: "candidate" | "no_candidate";
  candidateCount: number;
  /** 协议错误:引用未分配 Evidence / Bundle 类型与 Evidence 类型不匹配等 */
  protocolErrors: string[];
  /** 引用的 evidenceRefIds(是否都在允许清单内由调用方传入校验) */
  evidenceRefIds: string[];
  /** 自报 PlanMismatchSignal(仅加项,不单独作为成功判定) */
  planMismatchSignal?: string;
  finishReason?: "complete" | "truncated";
  /** 该 bundle 内按 section 归类的 candidate 数(检测重复) */
  candidatesBySection?: Record<string, number>;
  /** code/formula candidate 数(code bundle 必须 ≥1 才不触发信号) */
  codeCandidateCount?: number;
  imageEvidenceCount?: number;
}

export interface GapDetectionContext {
  plan: GenerationPlan;
  /** bundleId → 输出 */
  outcomes: Record<string, SpecialistOutcome>;
  /** 允许清单:Evidence ID(即 specialist 产出并被验证接收的 evidenceRefIds) */
  evidenceAllowlist: Set<string>;
  /** coverage ledger 是否完整(Required 均有记录) */
  coverageLedgerComplete: boolean;
  /** surviving coverage(0-1),低于阈值触发 */
  survivingCoverage: number;
  /** 阈值(由调用方按路径配置,默认 0.7) */
  coverageThreshold?: number;
  /** 单 bundle candidate 数量爆炸阈值 */
  candidateExplosionThreshold?: number;
  /** 同 section candidate 重复判定阈值(默认 3) */
  duplicateSectionThreshold?: number;
}

/** §3.2 清单的确定性判定,纯函数、无副作用 */
export function detectGaps(ctx: GapDetectionContext): GapSignal[] {
  const gaps: GapSignal[] = [];
  const threshold = ctx.coverageThreshold ?? 0.7;
  const explosionThreshold = ctx.candidateExplosionThreshold ?? 500;

  const seen = new Set<string>();

  // 1) Plan 指定 Bundle 不存在或重复(§3.2:Plan 指定 Bundle 不存在或重复)
  for (const task of ctx.plan.bundleTasks) {
    if (seen.has(task.bundleId)) {
      gaps.push({
        code: "plan_bundle_duplicate",
        severity: "escalate",
        bundleId: task.bundleId,
        message: `Plan 重复指定 bundle ${task.bundleId}`,
      });
    }
    seen.add(task.bundleId);
  }

  for (const task of ctx.plan.bundleTasks) {
    const outcome = ctx.outcomes[task.bundleId];
    const b = task.bundleId;

    if (!outcome) {
      gaps.push({
        code: "bundle_no_outcome",
        severity: "replannable",
        bundleId: b,
        message: `bundle ${b} 无 Specialist 输出`,
      });
      continue;
    }

    // 2) Required Bundle 无明确决策(§3.2 首条)
    if (!outcome.hasDecision) {
      gaps.push({
        code: "bundle_no_decision",
        severity: "replannable",
        bundleId: b,
        message: `Required bundle ${b} 无明确决策`,
      });
    }

    // 3) Candidate 数量 0 或异常爆炸(§3.2 次条)
    if (outcome.hasDecision && outcome.decisionKind === "candidate" && outcome.candidateCount === 0) {
      gaps.push({
        code: "candidate_zero",
        severity: "replannable",
        bundleId: b,
        message: `bundle ${b} 决策为 candidate 但数量为 0`,
      });
    }
    if (outcome.candidateCount > explosionThreshold) {
      gaps.push({
        code: "candidate_explosion",
        severity: "escalate",
        bundleId: b,
        message: `bundle ${b} candidate 数量 ${outcome.candidateCount} 超过阈值 ${explosionThreshold}`,
      });
    }

    // 4) Specialist 协议错误(§3.2:协议错误 / 引用未分配 Evidence / 类型不匹配)
    for (const err of outcome.protocolErrors) {
      gaps.push({
        code: "specialist_protocol_error",
        severity: "escalate",
        bundleId: b,
        message: `bundle ${b} 协议错误: ${err}`,
      });
    }

    // 5) 引用未分配 Evidence(引用不在允许清单)
    for (const ref of outcome.evidenceRefIds) {
      if (!ctx.evidenceAllowlist.has(ref)) {
        gaps.push({
          code: "evidence_ref_unassigned",
          severity: "escalate",
          bundleId: b,
          message: `bundle ${b} 引用未分配 Evidence ${ref}`,
        });
      }
    }

    // 6) Code Bundle 无 Code/Formula Candidate(§3.2)
    if (task.specialist === "code_extractor" && (outcome.codeCandidateCount ?? 0) === 0) {
      gaps.push({
        code: "code_bundle_no_code_candidate",
        severity: "replannable",
        bundleId: b,
        message: `Code bundle ${b} 无 Code/Formula Candidate`,
      });
    }

    // 7) Image Bundle 缺 Required Image Evidence(§3.2)
    if (task.specialist === "vision_specialist" && (outcome.imageEvidenceCount ?? 0) === 0) {
      gaps.push({
        code: "image_bundle_missing_image_evidence",
        severity: "replannable",
        bundleId: b,
        message: `Image bundle ${b} 缺 Required Image Evidence`,
      });
    }

    // 8) 同 Section 大量重复 Candidate(§3.2)
    const bySection = outcome.candidatesBySection ?? {};
    const duplicateThreshold = ctx.duplicateSectionThreshold ?? 3;
    for (const [section, count] of Object.entries(bySection)) {
      if (count > duplicateThreshold) {
        gaps.push({
          code: "section_duplicate_candidates",
          severity: "replannable",
          bundleId: b,
          message: `section ${section} 重复 candidate ${count} 个`,
        });
      }
    }

    // 9) Finish Reason 截断(§3.2)
    if (outcome.finishReason === "truncated") {
      gaps.push({
        code: "finish_reason_truncated",
        severity: "escalate",
        bundleId: b,
        message: `bundle ${b} finish_reason 为 truncated`,
      });
    }

    // 10) Specialist 自报 PlanMismatchSignal 仅作加项(§3.2:不能单独作为成功判定)
    if (outcome.planMismatchSignal) {
      gaps.push({
        code: "specialist_self_reported_mismatch",
        severity: "replannable",
        bundleId: b,
        message: `bundle ${b} 自报 Plan 不匹配: ${outcome.planMismatchSignal}`,
      });
    }
  }

  // 11) Coverage Ledger 不完整(§3.2)
  if (!ctx.coverageLedgerComplete) {
    gaps.push({
      code: "coverage_ledger_incomplete",
      severity: "escalate",
      message: "Coverage Ledger 不完整(存在 Required 无记录)",
    });
  }

  // 12) Surviving Coverage 低于阈值(§3.2)
  if (ctx.survivingCoverage < threshold) {
    gaps.push({
      code: "surviving_coverage_below_threshold",
      severity: "escalate",
      message: `Surviving Coverage ${ctx.survivingCoverage.toFixed(3)} 低于阈值 ${threshold}`,
    });
  }

  return gaps;
}

/** 有无 gap(供调用方快速短路) */
export function hasGaps(gaps: GapSignal[]): boolean {
  return gaps.length > 0;
}

/** 是否有升级级 gap(升级而非 Replan) */
export function hasEscalateGaps(gaps: GapSignal[]): boolean {
  return gaps.some((g) => g.severity === "escalate");
}

/** bundle 是否受 gap 影响(供三分类复用:invalid_or_affected) */
export function affectedBundleIds(gaps: GapSignal[], plan: GenerationPlan): Set<string> {
  const affected = new Set<string>();
  for (const g of gaps) {
    if (g.bundleId) affected.add(g.bundleId);
  }
  // coverage/计划级 gap 影响全部 bundle
  if (gaps.some((g) => !g.bundleId)) {
    for (const t of plan.bundleTasks) affected.add(t.bundleId);
  }
  return affected;
}

/** plan 中某 bundle 的关联依赖(relatedBundleIds) */
export function dependenciesOf(task: GenerationPlanBundleTask): string[] {
  return task.relatedBundleIds ?? [];
}
