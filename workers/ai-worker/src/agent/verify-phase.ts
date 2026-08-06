/**
 * VERIFY 阶段执行模块（计划 §5.1, §11.3, §W5）。
 *
 * QUAL-02/PERF-04 拆分：此模块从 card-supervisor-agent.ts 中提取，
 * 将确定性完整性门禁逻辑独立为可测试的模块。
 *
 * 确定性完整性门禁，不调用模型。
 * 调用 executeVerify 模块执行所有检查项。
 */

import { and, eq, inArray, desc } from "drizzle-orm";
import { createHash } from "node:crypto";
import { hashJson } from "../lib/card-generation-pipeline-utils.ts";
import {
  SupervisorRunStatus,
  createDefaultRunBudget,
  BundleAssignmentStatus,
  BundleDecisionStatus,
  QualityReport,
  CriticIssue,
  isRunErrorRetryable,
  CriticClaimVerdict,
  NON_TERMINAL_UNIT_STATUSES,
} from "@ailearn/shared";
import { logger } from "../lib/logger.ts";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import {
  assertJobLease,
  lockJobLease,
  withJobTransaction,
  type JobLeaseContext,
} from "../lib/job-lease.ts";
import type { JobPayload } from "../handlers/index.ts";
import { executeVerify } from "./verify.ts";
import { CoverageLedger, initLedgerFromBundlePlan } from "./coverage-ledger.ts";
import { BudgetTracker, type BudgetUsage } from "./budget.ts";
import { appendAgentEvent } from "./specialist-persist.ts";
import type {
  AgentJobPayload,
  AgentTurnExecutionResult,
  RunContext,
} from "./types.ts";
import { createPublishUnit, createNextTurnJob } from "./unit-helpers.ts";

/**
 * VERIFY 阶段执行（计划 §5.1, §11.3, §W5）。
 *
 * 确定性完整性门禁，不调用模型。
 * 调用 executeVerify 模块执行所有检查项。
 */
export async function executeVerifyPhase(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
  lease: JobLeaseContext,
): Promise<AgentTurnExecutionResult> {
  logger.info(
    { runId: payload.generationRunId, unitId: payload.agentUnitId },
    "VERIFY 阶段执行",
  );

  await assertJobLease(lease);

  // 更新 run 状态为 validating
  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, lease);
    await tx.update(schema.cardGenerationRuns).set({
      status: SupervisorRunStatus.VALIDATING,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ));
  });

  // 加载 source bundles 重建 CoverageLedger
  const sourceBundles = await db
    .select()
    .from(schema.cardGenerationSourceBundles)
    .where(and(
      eq(schema.cardGenerationSourceBundles.runId, payload.generationRunId),
      eq(schema.cardGenerationSourceBundles.workspaceId, job.workspaceId),
    ))
    .orderBy(schema.cardGenerationSourceBundles.bundleOrdinal);

  const coverageLedger = new CoverageLedger();
  initLedgerFromBundlePlan(coverageLedger, sourceBundles.map((b) => ({
    bundleId: b.bundleKey,
    ordinal: b.bundleOrdinal,
    required: b.required,
  })));
  for (const b of sourceBundles) {
    if (b.assignmentStatus && b.assignmentStatus !== "pending") {
      coverageLedger.updateAssignment(b.bundleKey, b.assignmentStatus as BundleAssignmentStatus, b.assignedAgentUnitId);
    }
    if (b.decisionStatus && b.decisionStatus !== "pending") {
      coverageLedger.updateDecision(b.bundleKey, b.decisionStatus as BundleDecisionStatus, b.decisionReason);
    }
  }

  // QUAL-33 修复：从 DB 恢复每 bundle 的持久化候选计数
  // 替代 R29 中的硬编码 candidateCount=1 方案，使用实际持久化的值
  for (const b of sourceBundles) {
    if (b.candidateCount > 0) {
      coverageLedger.updateCandidateCount(b.bundleKey, b.candidateCount);
    }
  }

  // 加载 latest draft（按 draftVersion 降序获取最新版本）
  const [latestDraft] = await db
    .select()
    .from(schema.cardGenerationDrafts)
    .where(and(
      eq(schema.cardGenerationDrafts.runId, payload.generationRunId),
      eq(schema.cardGenerationDrafts.workspaceId, job.workspaceId),
    ))
    .orderBy(desc(schema.cardGenerationDrafts.draftVersion))
    .limit(1);

  if (!latestDraft) {
    // 没有 draft，验证失败
    await withJobTransaction(job, async (tx) => {
      await lockJobLease(tx, lease);
      const now = new Date();
      await tx.update(schema.cardGenerationRuns).set({
        status: SupervisorRunStatus.NEEDS_ATTENTION,
        errorCode: "no_draft_for_verify",
        // 确定性门禁失败：同一 draft 重跑结果必然相同，重试无意义（只保留重新生成）。
        retryable: isRunErrorRetryable("no_draft_for_verify"),
        updatedAt: now,
        finishedAt: now,
      }).where(and(
        eq(schema.cardGenerationRuns.id, payload.generationRunId),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
      ));
      await tx.update(schema.cardGenerationUnits).set({
        status: "terminal_failed",
        finishedAt: now,
        updatedAt: now,
      }).where(and(
        eq(schema.cardGenerationUnits.id, payload.agentUnitId),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      ));
    });
    return { kind: "needs_attention", reason: "no_draft_for_verify" };
  }

  // 加载 quality report
  const [qualityReport] = await db
    .select()
    .from(schema.cardGenerationQualityReports)
    .where(and(
      eq(schema.cardGenerationQualityReports.draftId, latestDraft.id),
      eq(schema.cardGenerationQualityReports.workspaceId, job.workspaceId),
    ))
    .limit(1);

  if (!qualityReport) {
    await withJobTransaction(job, async (tx) => {
      await lockJobLease(tx, lease);
      const now = new Date();
      await tx.update(schema.cardGenerationRuns).set({
        status: SupervisorRunStatus.NEEDS_ATTENTION,
        errorCode: "no_quality_report",
        // 确定性门禁失败：重试不会让质量报告凭空出现，重试无意义（只保留重新生成）。
        retryable: isRunErrorRetryable("no_quality_report"),
        updatedAt: now,
        finishedAt: now,
      }).where(and(
        eq(schema.cardGenerationRuns.id, payload.generationRunId),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
      ));
      // 检查点保留修复：标记当前 verify unit 为 terminal_failed，
      // 使其成为用户 `/retry` 可恢复的检查点（否则会被清理逻辑取消）。
      await tx.update(schema.cardGenerationUnits).set({
        status: "terminal_failed",
        finishedAt: now,
        updatedAt: now,
      }).where(and(
        eq(schema.cardGenerationUnits.id, payload.agentUnitId),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      ));
    });
    return { kind: "needs_attention", reason: "no_quality_report" };
  }

  // 构建 BudgetTracker
  const [runDetail] = await db
    .select()
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ))
    .limit(1);

  const budgetTracker = new BudgetTracker(
    runDetail?.budgetSnapshot ?? createDefaultRunBudget(),
  );

  // R14 修复：从 run 的 usageSummary 恢复预算使用量
  // 原代码不调用 restoreUsage，导致 BudgetTracker 从零开始计数，
  // budget 检查可能错误通过（即使执行期间已超 hard cap）。
  const verifyUsageSummary = runDetail?.usageSummary ?? null;
  if (verifyUsageSummary) {
    budgetTracker.restoreUsage(verifyUsageSummary as Partial<BudgetUsage>);
  }

  // R43 修复：VERIFY 阶段的 candidatePoolHash 和 sourceLedgerHash 必须从当前 DB 状态独立计算，
  // 不能直接从 Quality Report 中复制。原代码将 Quality Report 中的 hash 值同时用作
  // "期望值"和"实际值"，导致 checkCandidatePoolHash 和 checkSourceLedgerHash 永远通过。
  // 这意味着如果 Critic 运行后候选池或来源账本发生了变化（如并发修改或 bug），
  // VERIFY 无法检测到不一致，可能发布基于过期审查的 Card Set。
  // 修复后：从 DB 查询当前候选和 source bundles，独立计算 hash，与 Quality Report 中的 hash 比较。

  // 从 DB 加载当前候选并计算 candidatePoolHash
  // 使用与 CandidateLedger.recomputeHash() 相同的字段和格式
  const verifyCandidates = await db
    .select({
      id: schema.cardGenerationCandidates.id,
      claim: schema.cardGenerationCandidates.claim,
      candidateKind: schema.cardGenerationCandidates.candidateKind,
      validationStatus: schema.cardGenerationCandidates.validationStatus,
      topic: schema.cardGenerationCandidates.topic,
      cognitiveType: schema.cardGenerationCandidates.cognitiveType,
      importance: schema.cardGenerationCandidates.importance,
      sectionKey: schema.cardGenerationCandidates.sectionKey,
      groupKey: schema.cardGenerationCandidates.groupKey,
      exclusionReason: schema.cardGenerationCandidates.exclusionReason,
      derivedCandidateIds: schema.cardGenerationCandidates.derivedCandidateIds,
      // P1-14 fix: bundleId must be included in the hash to match
      // CandidateLedger._recomputeHashInternal() format.
      // `as any` needed because @ailearn/db types may lag behind raw SQL migrations.
      bundleId: (schema.cardGenerationCandidates as any).bundleId,
    })
    .from(schema.cardGenerationCandidates)
    .where(and(
      eq(schema.cardGenerationCandidates.workspaceId, job.workspaceId),
      eq(schema.cardGenerationCandidates.runId, payload.generationRunId),
    ));
  // 加载候选的证据引用（存储在单独的 card_generation_candidate_evidence 表中）
  const verifyCandidateIds = verifyCandidates.map((c) => c.id);
  const verifyCandidateEvidenceRows = verifyCandidateIds.length > 0
    ? await db
        .select({
          candidateId: schema.cardGenerationCandidateEvidence.candidateId,
          evidenceSpanId: schema.cardGenerationCandidateEvidence.evidenceSpanId,
          imageEvidenceUnitId: schema.cardGenerationCandidateEvidence.imageEvidenceUnitId,
        })
        .from(schema.cardGenerationCandidateEvidence)
        .where(and(
          eq(schema.cardGenerationCandidateEvidence.workspaceId, job.workspaceId),
          eq(schema.cardGenerationCandidateEvidence.runId, payload.generationRunId),
          inArray(schema.cardGenerationCandidateEvidence.candidateId, verifyCandidateIds),
        ))
        .orderBy(schema.cardGenerationCandidateEvidence.ordinal)
    : [];
  // 构建候选 ID → evidenceRefIds 映射
  const verifyEvidenceMap = new Map<string, string[]>();
  for (const ce of verifyCandidateEvidenceRows) {
    const refId = ce.evidenceSpanId ?? ce.imageEvidenceUnitId;
    if (refId) {
      const existing = verifyEvidenceMap.get(ce.candidateId) ?? [];
      existing.push(refId);
      verifyEvidenceMap.set(ce.candidateId, existing);
    }
  }
  // 与 CandidateLedger._recomputeHashInternal() 格式严格一致
  // 必须包含所有 CandidateLedger 用于哈希计算的字段，否则 VERIFY 会因 hash 不匹配而失败
  //
  // P1-15 一致性修复：ledger 已移除 operationCount 字段（审计字段，每次 turn
  // 从 DB 重建时 operations=[] 导致内存 hash 与 DB 校验永远不一致）。
  // verify 重算逻辑必须同步移除，否则 candidate_pool_hash 校验永远失败。
  const actualCandidatePoolHash = createHash("sha256")
    .update(JSON.stringify({
      candidates: verifyCandidates
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((c) => ({
          id: c.id,
          kind: c.candidateKind,
          // P1-14 fix: bundleId must be included to match CandidateLedger._recomputeHashInternal()
          bundleId: c.bundleId ?? null,
          claim: c.claim,
          topic: c.topic,
          cognitiveType: c.cognitiveType,
          importance: c.importance,
          sectionKey: c.sectionKey,
          status: c.validationStatus,
          evidence: verifyEvidenceMap.get(c.id) ?? [],
          groupKey: c.groupKey,
          exclusionReason: c.exclusionReason,
          derivedCandidateIds: c.derivedCandidateIds ?? [],
        })),
    }), "utf8")
    .digest("hex");

  // 从 DB 加载当前 source bundles 并计算 sourceLedgerHash
  // 与 Critic 执行路径一致：使用 hashJson（stableJsonStringify 排序 key），
  // 而非 JSON.stringify（保留插入顺序），否则 hash 永远不匹配
  const actualSourceLedgerHash = hashJson(sourceBundles.map((b) => ({
    bundleKey: b.bundleKey,
    inputHash: b.inputHash,
    decisionStatus: b.decisionStatus,
  })));

  // P0-03 修复：从 Draft contentJson 中提取全部 candidate IDs，
  // 用于 verify 的 verdict-candidate 覆盖率检查。
  // 强制不变量：Draft candidate ID 集合 == Critic verdict candidate ID 集合。
  const draftContentJson = (latestDraft.contentJson as Record<string, unknown>) ?? {};
  const draftCards = Array.isArray(draftContentJson.cards) ? draftContentJson.cards as Array<Record<string, unknown>> : [];
  const draftCandidateIds: string[] = [];
  for (const card of draftCards) {
    const ids = Array.isArray(card.canonicalCandidateIds)
      ? card.canonicalCandidateIds as string[]
      : (Array.isArray(card.candidateIds) ? card.candidateIds as string[] : []);
    for (const id of ids) {
      if (!draftCandidateIds.includes(id)) {
        draftCandidateIds.push(id);
      }
    }
  }

  // 调用 executeVerify
  const verifyResult = executeVerify({
    runId: payload.generationRunId,
    draftHash: latestDraft.contentHash,
    qualityReport: {
      draftHash: qualityReport.draftHash,
      candidatePoolHash: qualityReport.candidatePoolHash,
      sourceLedgerHash: qualityReport.sourceLedgerHash,
      criticVersion: qualityReport.criticVersion,
      verifierVersion: qualityReport.verifierVersion,
      hardIssues: (qualityReport.hardIssues as unknown as CriticIssue[]) ?? [],
      softIssues: (qualityReport.softIssues as unknown as CriticIssue[]) ?? [],
      perClaimVerdicts: (qualityReport.perClaimVerdicts as unknown as CriticClaimVerdict[]) ?? [],
      metrics: qualityReport.metrics ?? {},
      criticStatus: qualityReport.criticStatus as QualityReport["criticStatus"],
      deterministicStatus: qualityReport.deterministicStatus as QualityReport["deterministicStatus"],
    },
    coverageLedger,
    budgetTracker,
    currentEpoch: runDetail?.generationEpoch ?? 0,
    draftEpoch: runDetail?.generationEpoch ?? 0,
    candidatePoolHash: actualCandidatePoolHash,
    sourceLedgerHash: actualSourceLedgerHash,
    draftCandidateIds,
  });

  // 记录 verify event
  await appendAgentEvent({
    workspaceId: job.workspaceId,
    runId: payload.generationRunId,
    unitId: payload.agentUnitId,
    eventKey: `verify:${payload.agentUnitId}`,
    eventType: "tool_result",
    agentRole: null,
    turnNo: payload.turnNo,
    safePayload: {
      passed: verifyResult.passed,
      checks: verifyResult.checks.map((c) => ({ name: c.name, passed: c.passed })),
    },
  });

  if (!verifyResult.passed) {
    // 验证失败，标记 needs_attention
    // P1-13 修复：errorCode 只存有限枚举和长度受限的 typed code。
    // 详细诊断脱敏后进入受控日志。
    const typedErrorCode = sanitizeVerifyErrorCode(verifyResult.failureReason);
    logger.warn(
      { runId: payload.generationRunId, failureReason: verifyResult.failureReason, typedErrorCode },
      "VERIFY 失败",
    );
    await withJobTransaction(job, async (tx) => {
      await lockJobLease(tx, lease);
      const now = new Date();
      await tx.update(schema.cardGenerationRuns).set({
        status: SupervisorRunStatus.NEEDS_ATTENTION,
        errorCode: typedErrorCode,
        // 确定性门禁失败：同一 draft 重跑校验结果必然相同，重试无意义（只保留重新生成）。
        retryable: isRunErrorRetryable(typedErrorCode),
        updatedAt: now,
        finishedAt: now,
      }).where(and(
        eq(schema.cardGenerationRuns.id, payload.generationRunId),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
      ));
      await tx.update(schema.cardGenerationUnits).set({
        status: "terminal_failed",
        finishedAt: now,
        updatedAt: now,
      }).where(and(
        eq(schema.cardGenerationUnits.id, payload.agentUnitId),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      ));
      // P1-13 修复：run 终态化时原子取消所有非终态 unit。
      // P0-06 修复：使用共享的 NON_TERMINAL_UNIT_STATUSES 常量替代硬编码数组。
      await tx.update(schema.cardGenerationUnits).set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
      }).where(and(
        eq(schema.cardGenerationUnits.runId, payload.generationRunId),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        inArray(schema.cardGenerationUnits.status, NON_TERMINAL_UNIT_STATUSES),
      ));
    });
    return { kind: "needs_attention", reason: typedErrorCode };
  }

  // 验证通过，更新 run 和 unit
  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, lease);
    const now = new Date();
    await tx.update(schema.cardGenerationRuns).set({
      verifiedDraftId: latestDraft.id,
      verifiedDraftHash: latestDraft.contentHash,
      qualityReportId: qualityReport.id,
      updatedAt: now,
    }).where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ));
    await tx.update(schema.cardGenerationUnits).set({
      status: "succeeded",
      finishedAt: now,
      updatedAt: now,
    }).where(and(
      eq(schema.cardGenerationUnits.id, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
    ));
  });

  // 创建 publish unit 和 job
  const publishUnitId = await createPublishUnit(job, payload, runContext);
  await createNextTurnJob(job, payload.generationRunId, publishUnitId, payload.turnNo + 1);

  return { kind: "continue", nextTurnNo: payload.turnNo + 1 };
}

/**
 * P1-13 修复：将验证失败的 failureReason 转换为有限枚举和长度受限的 typed code。
 *
 * errorCode 只存有限枚举和长度受限的 typed code；详细诊断脱敏后进入受控日志。
 * 原代码把完整 failureReason 拼入 errorCode，可能泄露候选 claim 文本、SQL 参数或 credential。
 */
function sanitizeVerifyErrorCode(failureReason: string | null | undefined): string {
  if (!failureReason) return "verify_failed";

  const lower = failureReason.toLowerCase();

  if (lower.includes("coverage") || lower.includes("覆盖率")) return "coverage_insufficient";
  if (lower.includes("critic") || lower.includes("verdict") || lower.includes("报告")) return "critic_check_failed";
  if (lower.includes("draft") || lower.includes("hash")) return "draft_hash_mismatch";
  if (lower.includes("quality") || lower.includes("report")) return "quality_report_missing";
  if (lower.includes("candidate") || lower.includes("候选")) return "candidate_check_failed";
  if (lower.includes("evidence") || lower.includes("证据") || lower.includes("unaligned")) return "evidence_check_failed";
  if (lower.includes("empty") || lower.includes("为空")) return "empty_result";
  if (lower.includes("pending")) return "pending_candidate";
  if (lower.includes("partial")) return "partial_verdict";
  if (lower.includes("unsupported")) return "unsupported_verdict";
  if (lower.includes("contradicted")) return "contradicted_verdict";
  if (lower.includes("auto_verified")) return "auto_verified_blocked";
  if (lower.includes("survival")) return "survival_coverage_incomplete";

  // 兜底：截断到 80 字符，移除可能的敏感信息
  const truncated = failureReason.slice(0, 80);
  return `verify_failed:${truncated}`;
}
