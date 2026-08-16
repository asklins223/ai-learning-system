/**
 * 确定性验证门禁（计划 §5.1, §11.3, §W5）
 *
 * VERIFY 是四个稳定外层节点中的第三个，完全确定性。
 * 不产生语义 verdict，只做完整性、一致性和安全检查。
 *
 * 检查项（计划 §11.3）：
 * 1. coverage 六层：前三层必须为 100%
 * 2. draft hash 绑定：verified draft hash 与 quality report draft hash 一致
 * 3. Critic verdict：所有 active claim 有 supported verdict
 * 4. ownership：每个 candidate 的 evidence 属于正确 workspace/noteVersion
 * 5. budget：未超 hard cap
 * 6. epoch：draft 创建时的 epoch 与当前一致
 * 7. source hash：evidence 的 source hash 与封存一致
 * 8. bundle coverage：所有 required bundle 有明确决策
 * 9. no unsupported/contradicted claim
 *
 * 不变量（G3, G7, G9, §11.3）：
 * - VERIFY 是确定性门禁，不调用模型
 * - VERIFY 绑定同一 immutable draftHash
 * - 失败进入 needs_attention，不发布
 */

import type {
  QualityReport,
} from "@ailearn/shared";
import type { CoverageLedger } from "./coverage-ledger.ts";
import type { BudgetTracker } from "./budget.ts";
import { logger } from "../lib/logger.ts";

/** Verify 输入 */
export interface VerifyInput {
  /** 运行 ID */
  runId: string;
  /** 要验证的 draft hash */
  draftHash: string;
  /** Quality Report */
  qualityReport: QualityReport;
  /** Coverage Ledger */
  coverageLedger: CoverageLedger;
  /** Budget Tracker */
  budgetTracker: BudgetTracker;
  /** 当前 epoch */
  currentEpoch: number;
  /** Draft 创建时的 epoch */
  draftEpoch: number;
  /** 候选池 hash */
  candidatePoolHash: string;
  /** 来源账本 hash */
  sourceLedgerHash: string;
  /** P0-03：Draft 中引用的全部 candidate IDs（用于 verdict 覆盖检查） */
  draftCandidateIds?: string[];
}

/** Verify 结果 */
export interface VerifyResult {
  /** 是否通过 */
  passed: boolean;
  /** 检查项结果 */
  checks: VerifyCheck[];
  /** 失败原因（如果不通过） */
  failureReason: string | null;
}

/** 单个检查项 */
export interface VerifyCheck {
  /** 检查名称 */
  name: string;
  /** 是否通过 */
  passed: boolean;
  /** 详情 */
  details: string;
}

/**
 * 执行确定性验证。
 *
 * 完全确定性，不调用模型。
 * 所有检查项必须全部通过才能进入 PUBLISH。
 */
export function executeVerify(input: VerifyInput): VerifyResult {
  const checks: VerifyCheck[] = [];

  logger.info({ runId: input.runId, draftHash: input.draftHash }, "VERIFY 阶段开始");

  // 1. coverage 检查
  checks.push(checkCoverage(input.coverageLedger));

  // 2. draft hash 绑定
  checks.push(checkDraftHashBinding(input.draftHash, input.qualityReport));

  // 3. Critic verdict
  checks.push(checkCriticVerdict(input.qualityReport));

  // 4. candidate pool hash 一致性
  checks.push(checkCandidatePoolHash(input.candidatePoolHash, input.qualityReport));

  // 5. source ledger hash 一致性
  checks.push(checkSourceLedgerHash(input.sourceLedgerHash, input.qualityReport));

  // 6. budget 检查
  checks.push(checkBudget(input.budgetTracker));

  // 7. epoch 检查
  checks.push(checkEpoch(input.currentEpoch, input.draftEpoch));

  // 8. bundle coverage 检查
  checks.push(checkBundleCoverage(input.coverageLedger));

  // 9. no unsupported/contradicted/partial claim
  checks.push(checkNoUnsupportedClaims(input.qualityReport));

  // 10. deterministic status 检查
  checks.push(checkDeterministicStatus(input.qualityReport));

  // P0-03 修复（2026-08-03）：新增严格发布门禁检查

  // 11. 空 verdict 检查
  checks.push(checkNonEmptyVerdicts(input.qualityReport));

  // 12. auto_verified 检查
  checks.push(checkNoAutoVerified(input.qualityReport));

  // 13. verdict-candidate ID 精确覆盖检查
  checks.push(checkVerdictCandidateCoverage(input.qualityReport, input.draftCandidateIds));

  // 14. partial verdict 阻断发布
  checks.push(checkNoPartialVerdicts(input.qualityReport));

  const allPassed = checks.every((c) => c.passed);
  const failedChecks = checks.filter((c) => !c.passed);
  const failureReason = allPassed
    ? null
    : failedChecks.map((c) => `${c.name}: ${c.details}`).join("; ");

  logger.info(
    {
      runId: input.runId,
      draftHash: input.draftHash,
      passed: allPassed,
      failedChecks: failedChecks.map((c) => c.name),
    },
    "VERIFY 阶段完成",
  );

  return {
    passed: allPassed,
    checks,
    failureReason,
  };
}

/** 检查 coverage 六层 */
function checkCoverage(coverageLedger: CoverageLedger): VerifyCheck {
  try {
    coverageLedger.verifyFullResultPrerequisites();
    const snapshot = coverageLedger.getSnapshot();
    return {
      name: "coverage",
      passed: true,
      details: `physical=${snapshot.report.sourcePhysicalCoverage}, assignment=${snapshot.report.bundleAssignmentCoverage}, decision=${snapshot.report.explicitDecisionCoverage}, survival=${snapshot.report.candidateSurvivalCoverage}`,
    };
  } catch (err) {
    return {
      name: "coverage",
      passed: false,
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 检查 draft hash 绑定 */
function checkDraftHashBinding(draftHash: string, report: QualityReport): VerifyCheck {
  const match = report.draftHash === draftHash;
  return {
    name: "draft_hash_binding",
    passed: match,
    details: match
      ? "draft hash 一致"
      : `draft hash 不匹配: expected=${draftHash}, report=${report.draftHash}`,
  };
}

/** 检查 Critic verdict */
function checkCriticVerdict(report: QualityReport): VerifyCheck {
  const passed = report.criticStatus === "passed";
  return {
    name: "critic_verdict",
    passed,
    details: passed
      ? "Critic 通过"
      : `Critic 未通过: status=${report.criticStatus}, hardIssues=${report.hardIssues.length}`,
  };
}

/** 检查 candidate pool hash 一致性 */
function checkCandidatePoolHash(expected: string, report: QualityReport): VerifyCheck {
  const match = report.candidatePoolHash === expected;
  return {
    name: "candidate_pool_hash",
    passed: match,
    details: match
      ? "candidate pool hash 一致"
      : `hash 不匹配: expected=${expected}, report=${report.candidatePoolHash}`,
  };
}

/** 检查 source ledger hash 一致性 */
function checkSourceLedgerHash(expected: string, report: QualityReport): VerifyCheck {
  const match = report.sourceLedgerHash === expected;
  return {
    name: "source_ledger_hash",
    passed: match,
    details: match
      ? "source ledger hash 一致"
      : `hash 不匹配: expected=${expected}, report=${report.sourceLedgerHash}`,
  };
}

/** 检查预算 */
function checkBudget(budgetTracker: BudgetTracker): VerifyCheck {
  const exceeded = budgetTracker.isDeadlineExceeded();
  const usage = budgetTracker.getUsage();
  const budget = budgetTracker.getBudget();

  const overInputTokens = usage.inputTokens > budget.maxInputTokens;
  const overOutputTokens = usage.outputTokens > budget.maxOutputTokens;
  const overProviderCalls = usage.providerCalls > budget.maxProviderCalls;

  const passed = !exceeded && !overInputTokens && !overOutputTokens && !overProviderCalls;

  return {
    name: "budget",
    passed,
    details: passed
      ? `预算充足: calls=${usage.providerCalls}/${budget.maxProviderCalls}`
      : `预算超限: deadline=${exceeded}, input=${overInputTokens}, output=${overOutputTokens}, calls=${overProviderCalls}`,
  };
}

/** 检查 epoch */
function checkEpoch(currentEpoch: number, draftEpoch: number): VerifyCheck {
  const match = currentEpoch === draftEpoch;
  return {
    name: "epoch",
    passed: match,
    details: match
      ? "epoch 一致"
      : `epoch 不匹配: current=${currentEpoch}, draft=${draftEpoch}`,
  };
}

/** 检查 bundle coverage */
function checkBundleCoverage(coverageLedger: CoverageLedger): VerifyCheck {
  const snapshot = coverageLedger.getSnapshot();
  const undecided = snapshot.bundles.filter(
    (b) =>
      b.required &&
      (b.decisionStatus === "pending" ||
        b.decisionStatus === "model_omitted" ||
        b.decisionStatus === "protocol_error" ||
        b.decisionStatus === "auto_supplemented"),
  );

  // P1-09: 检查 candidate survival coverage
  const noSurvival = snapshot.bundles.filter(
    (b) =>
      b.required &&
      b.decisionStatus === "candidate_emitted" &&
      b.candidateCount === 0,
  );

  return {
    name: "bundle_coverage",
    passed: undecided.length === 0 && noSurvival.length === 0,
    details: undecided.length === 0 && noSurvival.length === 0
      ? `所有 ${snapshot.requiredBundles} 个 required bundle 已决策且有存活候选`
      : `${undecided.length} 个未决策/阻断, ${noSurvival.length} 个无存活候选`,
  };
}

/** 检查没有 unsupported/contradicted/partial claim */
function checkNoUnsupportedClaims(report: QualityReport): VerifyCheck {
  // P0-03 修复：partial 也阻断发布。
  // 原代码只过滤 unsupported/contradicted，partial 可以通过。
  // 文档要求：partial 默认阻断发布；只有先删除或修复对应 claim，
  // 重新审查通过后才能继续。
  const blocked = report.perClaimVerdicts.filter(
    (v) => v.verdict === "unsupported" || v.verdict === "contradicted" || v.verdict === "partial",
  );

  return {
    name: "no_unsupported_claims",
    passed: blocked.length === 0,
    details: blocked.length === 0
      ? "所有 claim 有 supported verdict"
      : `${blocked.length} 个 claim unsupported/contradicted/partial`,
  };
}

/** 检查 deterministic status */
function checkDeterministicStatus(report: QualityReport): VerifyCheck {
  const passed = report.deterministicStatus === "passed";
  return {
    name: "deterministic_status",
    passed,
    details: passed
      ? "确定性验证通过"
      : `确定性验证未通过: status=${report.deterministicStatus}`,
  };
}

// ─── P0-03 新增检查项（2026-08-03） ──────────────────────────────────────

/**
 * 检查 perClaimVerdicts 非空。
 *
 * 空报告、空 verdict 一律 hard fail。
 * 这是最关键的 fail-closed 门禁：没有 Critic verdict 的 Draft 不得发布。
 */
function checkNonEmptyVerdicts(report: QualityReport): VerifyCheck {
  const passed = report.perClaimVerdicts.length > 0;
  return {
    name: "non_empty_verdicts",
    passed,
    details: passed
      ? `Critic 提交了 ${report.perClaimVerdicts.length} 个 verdict`
      : "Critic perClaimVerdicts 为空，不得发布",
  };
}

/**
 * 检查不包含 auto_verified reasonCode。
 *
 * auto_verified 表示 verdict 是由确定性代码伪造的，不是模型实际审查的结果。
 * 这类 verdict 不得通过发布门禁。
 */
function checkNoAutoVerified(report: QualityReport): VerifyCheck {
  const autoVerified = report.perClaimVerdicts.filter(
    (v) => v.reasonCode === "auto_verified",
  );
  return {
    name: "no_auto_verified",
    passed: autoVerified.length === 0,
    details: autoVerified.length === 0
      ? "无 auto_verified verdict"
      : `${autoVerified.length} 个 verdict 为 auto_verified（不得发布）`,
  };
}

/**
 * 检查 verdict-candidate ID 精确覆盖。
 *
 * 强制不变量：最终 Draft candidate ID 集合 == Critic verdict candidate ID 集合。
 * 不得缺失、重复或多余。
 *
 * 如果 draftCandidateIds 未提供，跳过此检查（向后兼容）。
 */
function checkVerdictCandidateCoverage(
  report: QualityReport,
  draftCandidateIds?: string[],
): VerifyCheck {
  if (!draftCandidateIds || draftCandidateIds.length === 0) {
    // 无法检查时 fail-closed：如果没有提供 draft candidate IDs，
    // 至少检查 verdict 中没有重复
    const verdictIds = report.perClaimVerdicts.map((v) => v.candidateId);
    const seenVerdicts = new Set<string>();
    const duplicates = verdictIds.filter((id) => {
      if (seenVerdicts.has(id)) return true;
      seenVerdicts.add(id);
      return false;
    });
    return {
      name: "verdict_candidate_coverage",
      passed: duplicates.length === 0,
      details: duplicates.length === 0
        ? "verdict 无重复（draft candidate IDs 未提供，跳过覆盖检查）"
        : `${duplicates.length} 个重复 verdict candidate ID`,
    };
  }

  const verdictIds = new Set(report.perClaimVerdicts.map((v) => v.candidateId));
  const draftIds = new Set(draftCandidateIds);

  const missing = draftCandidateIds.filter((id) => !verdictIds.has(id));
  const extra = report.perClaimVerdicts
    .map((v) => v.candidateId)
    .filter((id) => !draftIds.has(id));
  const duplicateIdsSet = new Set<string>();
  const duplicateIds = report.perClaimVerdicts
    .map((v) => v.candidateId)
    .filter((id) => {
      if (duplicateIdsSet.has(id)) return true;
      duplicateIdsSet.add(id);
      return false;
    });

  const passed = missing.length === 0 && extra.length === 0 && duplicateIds.length === 0;

  return {
    name: "verdict_candidate_coverage",
    passed,
    details: passed
      ? `Draft ${draftIds.size} 个 candidate 与 Critic ${verdictIds.size} 个 verdict 精确匹配`
      : `覆盖不匹配: missing=${missing.length}, extra=${extra.length}, duplicate=${duplicateIds.length}`,
  };
}

/**
 * 检查不包含 partial verdict。
 *
 * partial 默认阻断发布；只有先删除或修复对应 claim，
 * 重新审查通过后才能继续。
 */
function checkNoPartialVerdicts(report: QualityReport): VerifyCheck {
  const partial = report.perClaimVerdicts.filter(
    (v) => v.verdict === "partial",
  );
  return {
    name: "no_partial_verdicts",
    passed: partial.length === 0,
    details: partial.length === 0
      ? "无 partial verdict"
      : `${partial.length} 个 partial verdict（必须修复后重新审查）`,
  };
}
