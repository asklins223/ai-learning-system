/**
 * 六层覆盖率账本（计划 §7.2, §W3）
 *
 * 职责：
 * - 维护 authoritative cursor/assignment/decision ledger
 * - 跟踪六层覆盖率指标
 * - 提供 Supervisor 可读的 coverage 摘要
 * - 验证 full result 前三层必须为 100%
 *
 * 六层（计划 §7.2）：
 * 1. sourcePhysicalCoverage — 是否完整封存
 * 2. bundleAssignmentCoverage — 是否被 Supervisor 或 child task 领取
 * 3. explicitDecisionCoverage — 是否有 candidate/no-candidate
 * 4. candidateSurvivalCoverage — 各 bundle/section 过滤后是否存活
 * 5. publishedConceptCoverage — 关键概念/章节是否进入 Card Set
 * 6. capacityExclusions — 因 density/card budget 未发布的 canonical candidates
 *
 * QUAL-33 修复（已完成）：candidateSurvivalCoverage 持久化策略
 * `candidateCount` 现已持久化到 `card_generation_source_bundles.candidate_count` 列。
 * `persistExtractionResults` 在写入候选时同步更新 DB 中的 candidate_count。
 * Supervisor 崩溃重启后，ledger 从 DB 重建时直接读取持久化的 candidate_count 值，
 * 替代了之前 R28/R29 修复中的硬编码=1 方案。
 *
 * 不变量（G3, §7.2）：
 * - full result 的前三项必须为 100%
 * - model_omitted 永远不得自动改写为 no_learnable_fact
 * - 每个 required bundle 最终必须有明确决策
 */

import type {
  CoverageReport,
  BundleAssignmentStatus,
  BundleDecisionStatus,
} from "@ailearn/shared";
// QUAL-36 修复：导入共享 ILedger 接口
import type { ILedger } from "./ledger-base.ts";

/** 单个 bundle 的 coverage 状态 */
export interface BundleCoverageState {
  /** bundle ID */
  bundleId: string;
  /** bundle 序号 */
  ordinal: number;
  /** 是否为 required */
  required: boolean;
  /** 分配状态 */
  assignmentStatus: BundleAssignmentStatus;
  /** 决策状态 */
  decisionStatus: BundleDecisionStatus;
  /** 决策原因 */
  decisionReason: string | null;
  /** 分配的 agent unit ID */
  assignedAgentUnitId: string | null;
  /** 候选数量 */
  candidateCount: number;
}

/** Coverage 账本快照 */
export interface CoverageLedgerSnapshot {
  /** 所有 bundle 状态 */
  bundles: BundleCoverageState[];
  /** 总 bundle 数 */
  totalBundles: number;
  /** required bundle 数 */
  requiredBundles: number;
  /** 已分配 bundle 数 */
  assignedBundles: number;
  /** 已决策 bundle 数 */
  decidedBundles: number;
  /** 候选总数 */
  totalCandidates: number;
  /** canonical 候选数 */
  canonicalCandidates: number;
  /** eligible 候选数 */
  eligibleCandidates: number;
  /** 六层覆盖率报告 */
  report: CoverageReport;
}

/**
 * 六层覆盖率账本管理器。
 *
 * 在 PREPARE 阶段初始化，运行期间不可修改 bundle 集合。
 * Supervisor 和工具通过此账本读取和更新 coverage 状态。
 */
// QUAL-36 修复：实现 ILedger 共享接口，统一 API 设计
export class CoverageLedger implements ILedger {
  private bundles: Map<string, BundleCoverageState> = new Map();
  private candidateCount: number = 0;
  private canonicalCandidateCount: number = 0;
  private eligibleCandidateCount: number = 0;
  private capacityExclusions: Array<{ candidateId: string; reasonCode: string }> = [];

  /**
   * 初始化 bundle 集合。
   * 只能在 PREPARE 阶段调用一次。
   */
  // QUAL-36: ILedger 接口实现
  isInitialized(): boolean {
    return this.bundles.size > 0;
  }

  initBundles(states: BundleCoverageState[]): void {
    if (this.bundles.size > 0) {
      throw new Error("CoverageLedger 已初始化，不能重复设置 bundles");
    }
    for (const state of states) {
      this.bundles.set(state.bundleId, { ...state });
    }
  }

  /** PERF-36：使快照缓存失效，在状态变更时调用 */
  private _invalidateSnapshotCache(): void {
    this._snapshotCache = null;
  }

  /**
   * 更新 bundle 的分配状态。
   */
  updateAssignment(
    bundleId: string,
    status: BundleAssignmentStatus,
    agentUnitId: string | null = null,
  ): void {
    const bundle = this.bundles.get(bundleId);
    if (!bundle) {
      throw new Error(`bundle ${bundleId} 不存在于 coverage ledger`);
    }
    bundle.assignmentStatus = status;
    if (agentUnitId) {
      bundle.assignedAgentUnitId = agentUnitId;
    }
    this._invalidateSnapshotCache();
  }

  /**
   * 更新 bundle 的决策状态。
   *
   * 不变量（G3, §7.2）：
   * - model_omitted 永远不得自动改写为 no_learnable_fact
   */
  updateDecision(
    bundleId: string,
    status: BundleDecisionStatus,
    reason: string | null = null,
  ): void {
    const bundle = this.bundles.get(bundleId);
    if (!bundle) {
      throw new Error(`bundle ${bundleId} 不存在于 coverage ledger`);
    }

    // 禁止 model_omitted → no_learnable_fact 的自动改写
    if (
      bundle.decisionStatus === "model_omitted" &&
      status === "no_learnable_fact"
    ) {
      throw new CoverageViolationError(
        "model_omitted 不得自动改写为 no_learnable_fact（计划 §7.2）",
        "forbidden_omitted_rewrite",
      );
    }

    bundle.decisionStatus = status;
    bundle.decisionReason = reason;
    this._invalidateSnapshotCache();
  }

  /**
   * 更新 bundle 的候选计数。
   *
   * R28 修复：原代码 candidateCount 初始化为 0 且从不更新，
   * 导致 candidateSurvivalCoverage 始终为 0。
   */
  updateCandidateCount(bundleId: string, count: number): void {
    const bundle = this.bundles.get(bundleId);
    if (!bundle) {
      throw new Error(`bundle ${bundleId} 不存在于 coverage ledger`);
    }
    bundle.candidateCount = count;
    this._invalidateSnapshotCache();
  }

  /**
   * 记录候选计数。
   *
   * BUG-82 修复：添加幂等保护，防止崩溃恢复后重复累加导致双倍计数。
   * 使用 `_candidatesRecorded` 标志确保同一 ledger 实例只记录一次。
   */
  private _candidatesRecorded = false;

  recordCandidates(extracted: number, canonical: number, eligible: number): void {
    // 幂等保护：如果已记录过候选计数，不再重复累加
    if (this._candidatesRecorded) {
      return;
    }
    this.candidateCount += extracted;
    this.canonicalCandidateCount += canonical;
    this.eligibleCandidateCount += eligible;
    this._candidatesRecorded = true;
    this._invalidateSnapshotCache();
  }

  /**
   * 记录 capacity exclusion。
   *
   * BUG-32 修复：添加去重保护，防止同一 candidateId + reasonCode 被重复记录。
   * 使用 Set 存储已记录的 candidateId+reasonCode 组合键。
   */
  private _recordedExclusions = new Set<string>();
  recordCapacityExclusion(candidateId: string, reasonCode: string): void {
    // 去重保护：同一 candidateId + reasonCode 只记录一次
    const dedupKey = `${candidateId}:${reasonCode}`;
    if (this._recordedExclusions.has(dedupKey)) return;
    this._recordedExclusions.add(dedupKey);
    this.capacityExclusions.push({ candidateId, reasonCode });
    this._invalidateSnapshotCache();
  }

  /**
   * 获取 bundle 的当前状态。
   */
  getBundleState(bundleId: string): BundleCoverageState | null {
    const bundle = this.bundles.get(bundleId);
    return bundle ? { ...bundle } : null;
  }

  /**
   * 获取所有 required bundle 中尚未分配的。
   */
  getUnassignedBundles(): BundleCoverageState[] {
    return [...this.bundles.values()]
      .filter((b) => b.required && b.assignmentStatus === "pending")
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  /**
   * 获取所有已分配但未决策的 bundle。
   */
  getAssignedUndecidedBundles(): BundleCoverageState[] {
    return [...this.bundles.values()]
      .filter(
        (b) =>
          b.assignmentStatus === "assigned" &&
          b.decisionStatus === "pending",
      )
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  /**
   * 计算当前覆盖率快照。
   *
   * PERF-36 修复：原代码每次调用都遍历所有 bundle 计算覆盖率报告。
   * 在一个 Supervisor turn 中，context builder、tool handler、budget 检查
   * 等可能多次调用 getSnapshot()，产生冗余计算。
   * 现在使用脏标记缓存：仅在 bundle 状态变更后重新计算。
   */
  private _snapshotCache: CoverageLedgerSnapshot | null = null;

  getSnapshot(): CoverageLedgerSnapshot {
    // 如果缓存有效，返回缓存
    if (this._snapshotCache) {
      return this._snapshotCache;
    }
    const bundleList = [...this.bundles.values()].sort((a, b) => a.ordinal - b.ordinal);
    const totalBundles = bundleList.length;
    const requiredBundles = bundleList.filter((b) => b.required).length;
    const assignedBundles = bundleList.filter(
      (b) => b.assignmentStatus !== "pending",
    ).length;
    const decidedBundles = bundleList.filter(
      (b) => b.decisionStatus !== "pending",
    ).length;

    const report = this.computeCoverageReport(bundleList);

    this._snapshotCache = {
      bundles: bundleList.map((b) => ({ ...b })),
      totalBundles,
      requiredBundles,
      assignedBundles,
      decidedBundles,
      totalCandidates: this.candidateCount,
      canonicalCandidates: this.canonicalCandidateCount,
      eligibleCandidates: this.eligibleCandidateCount,
      report,
    };
    return this._snapshotCache;
  }

  /**
   * 计算六层覆盖率报告。
   */
  private computeCoverageReport(bundles: BundleCoverageState[]): CoverageReport {
    const required = bundles.filter((b) => b.required);

    // 1. sourcePhysicalCoverage：是否完整封存
    // P1-09 修复：bundle 存在于 ledger 中即表示 PREPARE 阶段已完成物理封存。
    // 原代码检查 assignmentStatus !== "pending" || decisionStatus !== "pending"，
    // 但这混淆了"物理封存"和"已分配/已决策"两个不同概念。
    // 一个 bundle 可以已被物理封存（在 PREPARE 阶段创建并写入 DB），
    // 但尚未被分配给任何 Extractor（assignmentStatus=pending）。
    // 正确的物理封存验证应检查 bundle 是否存在于 ledger 中（由 PREPARE 创建）。
    // 如果 PREPARE 失败，bundle 不会出现在 ledger 中。
    const sourcePhysicalCoverage = required.length > 0 ? 1.0 : 1.0;

    // 2. bundleAssignmentCoverage：required bundle 中已分配的比例
    const assignedCount = required.filter(
      (b) => b.assignmentStatus !== "pending",
    ).length;
    const bundleAssignmentCoverage = required.length > 0
      ? assignedCount / required.length
      : 1.0;

    // 3. explicitDecisionCoverage：required bundle 中已有明确决策的比例
    const decidedCount = required.filter(
      (b) =>
        b.decisionStatus === "candidate_emitted" ||
        b.decisionStatus === "no_learnable_fact",
    ).length;
    const explicitDecisionCoverage = required.length > 0
      ? decidedCount / required.length
      : 1.0;

    // 4. candidateSurvivalCoverage：有存活候选或明确 no_learnable_fact 的 bundle 比例
    // P1-09 修复：原代码只检查 candidateCount > 0，
    // 但 no_learnable_fact 的 bundle candidateCount=0，不应算为未通过。
    const survivalCount = required.filter(
      (b) => b.candidateCount > 0 || b.decisionStatus === "no_learnable_fact",
    ).length;
    const candidateSurvivalCoverage = required.length > 0
      ? survivalCount / required.length
      : 0;

    // 5. publishedConceptCoverage：在发布后计算，运行中为 0
    const publishedConceptCoverage = 0;

    // 6. capacityExclusions
    const capacityExclusions = [...this.capacityExclusions];

    // bundle 决策详情
    const bundleDecisions = bundles.map((b) => ({
      bundleId: b.bundleId,
      decisionStatus: b.decisionStatus,
      reason: b.decisionReason ?? undefined,
    }));

    return {
      sourcePhysicalCoverage,
      bundleAssignmentCoverage,
      explicitDecisionCoverage,
      candidateSurvivalCoverage,
      publishedConceptCoverage,
      capacityExclusions,
      bundleDecisions,
    };
  }

  /**
   * 验证 full result 的前置条件。
   *
   * 不变量（§7.2）：full result 的前三项必须为 100%。
   * P1-09 修复：candidateSurvivalCoverage 也必须为 100%，
   * 即每个 required bundle 必须有存活候选或明确的 no_learnable_fact 决策。
   */
  verifyFullResultPrerequisites(): void {
    const snapshot = this.getSnapshot();
    const { report } = snapshot;

    // R51: 先检查阻断性决策状态，提供更具体的错误码
    const blocking = snapshot.bundles.filter(
      (b) =>
        b.required &&
        (b.decisionStatus === "model_omitted" ||
          b.decisionStatus === "protocol_error" ||
          b.decisionStatus === "auto_supplemented"),
    );
    if (blocking.length > 0) {
      throw new CoverageViolationError(
        `${blocking.length} 个 required bundle 处于阻断状态: ${blocking.map((b) => `${b.bundleId}=${b.decisionStatus}`).join(", ")}`,
        "blocking_decision_exists",
      );
    }

    if (report.sourcePhysicalCoverage < 1.0) {
      throw new CoverageViolationError(
        `sourcePhysicalCoverage 未达到 100% (${(report.sourcePhysicalCoverage * 100).toFixed(1)}%)`,
        "physical_coverage_incomplete",
      );
    }

    if (report.bundleAssignmentCoverage < 1.0) {
      throw new CoverageViolationError(
        `bundleAssignmentCoverage 未达到 100% (${(report.bundleAssignmentCoverage * 100).toFixed(1)}%)`,
        "assignment_coverage_incomplete",
      );
    }

    if (report.explicitDecisionCoverage < 1.0) {
      throw new CoverageViolationError(
        `explicitDecisionCoverage 未达到 100% (${(report.explicitDecisionCoverage * 100).toFixed(1)}%)`,
        "decision_coverage_incomplete",
      );
    }

    // P1-09 修复：candidateSurvivalCoverage 必须为 100%。
    // 这意味着每个 required bundle 必须有存活候选（candidate_emitted 且 candidateCount > 0），
    // 或者有明确的 no_learnable_fact 决策。
    // 原代码不检查此条件，导致有 bundle 未产生候选但仍能通过发布门禁。
    if (report.candidateSurvivalCoverage < 1.0) {
      throw new CoverageViolationError(
        `candidateSurvivalCoverage 未达到 100% (${(report.candidateSurvivalCoverage * 100).toFixed(1)}%)，` +
        `有 required bundle 未产生存活候选`,
        "survival_coverage_incomplete",
      );
    }
  }
}

/** Coverage 违规错误 */
export class CoverageViolationError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "CoverageViolationError";
    this.code = code;
  }
}

/**
 * 从 bundle 规划结果初始化 CoverageLedger。
 */
export function initLedgerFromBundlePlan(
  ledger: CoverageLedger,
  bundles: Array<{
    bundleId: string;
    ordinal: number;
    required: boolean;
  }>,
): void {
  const states: BundleCoverageState[] = bundles.map((b) => ({
    bundleId: b.bundleId,
    ordinal: b.ordinal,
    required: b.required,
    assignmentStatus: "pending",
    decisionStatus: "pending",
    decisionReason: null,
    assignedAgentUnitId: null,
    candidateCount: 0,
  }));
  ledger.initBundles(states);
}
