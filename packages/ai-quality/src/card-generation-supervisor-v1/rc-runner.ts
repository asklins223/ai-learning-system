/**
 * Supervisor Agent v1 RC Runner — 真实 Provider 质量回归门禁（计划 §W7, §G2）
 *
 * 对应计划 G2 要求：
 * - 主 Provider 黄金集连续两轮全部达标
 * - 次级 Provider S/M/L/多模态/故障子集
 * - immutable revision、effective parameters、usage、成本和脱敏 artifact
 *
 * 与 v2 RC runner 的区别：
 * - 使用 60+ 篇黄金集（覆盖 15 个内容桶 × 三档密度）
 * - 使用 GoldenSetScorer（多维度质量评分）
 * - 支持 provider 子集测试（S/M/L/multimodal/fault）
 * - 输出 immutable revision artifact
 *
 * 依赖注入设计：
 * - SupervisorRunner 接口：生产环境传入真实 Supervisor Agent runner，测试传入 Mock
 * - 测试可在不访问网络的情况下运行
 */

import { GOLDEN_SET, GOLDEN_SET_SIZE } from "./golden-set-data.ts";
import type { GoldenSet, GoldenSample } from "./golden-set-schema.ts";
import {
  QUALITY_THRESHOLDS,
  type GoldenSet as GoldenSetType,
} from "./golden-set-schema.ts";
import {
  GoldenSetScorer,
  type SampleRunResult,
  type ScorerResult,
} from "./scorer.ts";

// ─── 类型定义 ─────────────────────────────────────────────────────────────

/** Provider 子集选择（计划 G2） */
export type ProviderSubset =
  | "full"       // 全部 60 篇，主 Provider 连续两轮
  | "S"          // 短文本子集（2k + 13k）
  | "M"          // 中等子集（50k + code + formula）
  | "L"          // 长文本子集（500k + 13k）
  | "multimodal" // 多模态子集（1img + 10img + 30img + image_only）
  | "fault";     // 故障子集（negation + contradiction + injection）

/** Supervisor Agent 运行接口 */
export interface SupervisorRunner {
  /** 对单个样本运行 Supervisor Agent v1 */
  runSample(
    sample: GoldenSample,
    signal?: AbortSignal,
  ): Promise<SupervisorRunResult>;

  /** 获取 Provider endpoint origin */
  getEndpointOrigin(): string;

  /** 获取模型 ID */
  getModelId(): string;

  /** 获取模型 revision（immutable） */
  getModelRevision(): string | null;
}

/** Supervisor Agent 单次运行结果 */
export interface SupervisorRunResult {
  /** 样本 ID */
  sampleId: string;
  /** 生成的卡片列表 */
  cards: Array<{
    cardId: string;
    title: string;
    summary: string;
    sectionKey: string;
    candidateIds: string[];
    evidenceRefIds: string[];
  }>;
  /** coverage 报告 */
  coverage: {
    sourcePhysical: number;
    bundleAssignment: number;
    explicitDecision: number;
    candidateSurvival: number;
    publishedConcept: number;
  };
  /** evidence 完整性 */
  evidenceIntegrity: {
    allowlistCompliant: boolean;
    quoteHashValid: boolean;
    typedEvidence: boolean;
  };
  /** unsupported/contradicted claim 数量 */
  unsupportedClaimCount: number;
  /** 语义支撑详情 */
  semanticSupport: {
    total: number;
    supported: number;
    partial: number;
    unsupported: number;
    contradicted: number;
  };
  /** 概念召回 */
  conceptRecall: {
    importantHits: number;
    importantTotal: number;
    criticalHits: number;
    criticalTotal: number;
  };
  /** 章节召回 */
  sectionRecall: {
    hits: number;
    total: number;
  };
  /** 预算遵循 */
  budgetCompliance: {
    turnBudgetExceeded: boolean;
    tokenBudgetExceeded: boolean;
    toolCallBudgetExceeded: boolean;
    costCapExceeded: boolean;
  };
  /** 跨卡重复 */
  crossCardDuplicates: number;
  /** 运行耗时（ms） */
  durationMs: number;
  /** 成本（美元） */
  costUsd: number;
  /** P1-14: Mock provider 标记，使 RC gate 可以拒绝 Mock 结果 */
  mockProvider?: boolean;
  /** P1-14: Provider 能力指纹 */
  providerFingerprint?: string | null;
  /** 自动化启发式评估（作为人工评估的代理） */
  humanEvaluation?: {
    deckAccepted: boolean;
    titleSummaryAccepted: boolean;
  };
  /** 运行错误（如有） */
  error: string | null;
}

/** RC 轮次结果 */
export interface SupervisorRCRoundResult {
  /** 轮次编号（1-based） */
  round: number;
  /** 每个样本的运行结果 */
  results: SampleRunResult[];
  /** 评分报告 */
  scorerResult: ScorerResult;
  /** 模型 revision */
  modelRevision: string | null;
  /** 本轮累计成本（美元） */
  costUsd: number;
  /** 本轮总耗时（ms） */
  totalDurationMs: number;
}

/** RC 门禁结果 */
export interface SupervisorRCGateResult {
  /** 门禁名称 */
  gate: string;
  /** 子集名称 */
  subset: ProviderSubset;
  /** 是否通过 */
  passed: boolean;
  /** Provider endpoint */
  providerEndpoint: string;
  /** 模型 ID */
  modelId: string;
  /** 模型 revision（immutable） */
  modelRevision: string | null;
  /** 每轮结果 */
  rounds: SupervisorRCRoundResult[];
  /** 两轮平均指标 */
  averageAggregate: ScorerResult["aggregate"];
  /** 未通过的维度 */
  failedDimensions: string[];
  /** 总成本（美元） */
  totalCostUsd: number;
  /** 总耗时（ms） */
  totalDurationMs: number;
  /** 失败原因 */
  failureReason: string | null;
  /** 校验错误列表 */
  errors: string[];
}

// ─── 子集筛选 ─────────────────────────────────────────────────────────────

/** 根据子集类型筛选黄金集样本 */
export function selectSubset(
  goldenSet: GoldenSetType,
  subset: ProviderSubset,
): GoldenSetType {
  switch (subset) {
    case "full":
      return goldenSet;
    case "S":
      return goldenSet.filter((s) =>
        s.contentBucket === "2k_text" || s.contentBucket === "13k_short_segments"
      );
    case "M":
      return goldenSet.filter((s) =>
        s.contentBucket === "50k_long" ||
        s.contentBucket === "code_heavy" ||
        s.contentBucket === "formula_heavy"
      );
    case "L":
      return goldenSet.filter((s) =>
        s.contentBucket === "500k_extreme" || s.contentBucket === "13k_short_segments"
      );
    case "multimodal":
      return goldenSet.filter((s) =>
        s.contentBucket === "multimodal_1img" ||
        s.contentBucket === "multimodal_10img" ||
        s.contentBucket === "multimodal_30img" ||
        s.contentBucket === "image_only"
      );
    case "fault":
      return goldenSet.filter((s) =>
        s.contentBucket === "negation_boundary" ||
        s.contentBucket === "contradiction" ||
        s.contentBucket === "prompt_injection"
      );
    default:
      return goldenSet;
  }
}

// ─── 错误分类 ─────────────────────────────────────────────────────────────

export type SupervisorErrorType =
  | "infrastructure"
  | "schema"
  | "content"
  | "budget"
  | "deadline";

export class SupervisorRCError extends Error {
  constructor(
    message: string,
    public readonly type: SupervisorErrorType,
    public readonly costUsd: number | null = null,
  ) {
    super(message);
    this.name = "SupervisorRCError";
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 判断错误是否为基础设施失败（可重试）。
 */
export function isInfrastructureError(err: unknown): boolean {
  if (err instanceof SupervisorRCError) {
    return err.type === "infrastructure";
  }
  if (err instanceof Error) {
    const msg = `${err.name} ${err.message}`.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("etimedout") ||
      msg.includes("econnreset") ||
      msg.includes("enotfound") ||
      msg.includes("econnrefused") ||
      msg.includes("eai_again") ||
      msg.includes("fetch failed") ||
      msg.includes("network error") ||
      msg.includes("socket hang up") ||
      /\b(?:429|5\d{2})\b/.test(msg) ||
      msg.includes("rate limit") ||
      msg.includes("quota")
    );
  }
  return false;
}

/**
 * 将 SupervisorRunResult 转换为 SampleRunResult（scorer 输入格式）。
 */
function toSampleRunResult(runResult: SupervisorRunResult): SampleRunResult {
  return {
    sampleId: runResult.sampleId,
    cards: runResult.cards,
    coverage: runResult.coverage,
    evidenceIntegrity: runResult.evidenceIntegrity,
    unsupportedClaimCount: runResult.unsupportedClaimCount,
    semanticSupport: runResult.semanticSupport,
    conceptRecall: runResult.conceptRecall,
    sectionRecall: runResult.sectionRecall,
    budgetCompliance: runResult.budgetCompliance,
    crossCardDuplicates: runResult.crossCardDuplicates,
    humanEvaluation: runResult.humanEvaluation,
  };
}

// ─── 配置 ─────────────────────────────────────────────────────────────────

export interface SupervisorRCConfig {
  /** Supervisor Agent runner */
  runner: SupervisorRunner;
  /** Provider 子集（默认 full） */
  subset: ProviderSubset;
  /** 运行轮数（默认 2，G2 要求主 Provider 连续两轮） */
  maxRounds: number;
  /** 预算上限（美元），默认 50 */
  maxBudgetUsd: number;
  /** 基础设施失败最大重试次数 */
  maxInfraRetries: number;
  /** 基础设施失败重试延迟（ms） */
  infraRetryDelayMs: number;
  /** 总运行时限（ms） */
  maxRunDurationMs: number;
  /** 上一 RC 的聚合指标（用于比较），null 表示首次 */
  previousAggregate: ScorerResult["aggregate"] | null;
}

export const DEFAULT_SUPERVISOR_RC_CONFIG: Omit<SupervisorRCConfig, "runner"> = {
  subset: "full",
  maxRounds: 2,
  maxBudgetUsd: 50,
  maxInfraRetries: 2,
  infraRetryDelayMs: 30_000,
  maxRunDurationMs: 60 * 60_000, // 60 分钟
  previousAggregate: null,
};

// ─── 单轮运行 ─────────────────────────────────────────────────────────────

/**
 * 运行单轮 RC 质量门禁。
 */
async function runSingleRound(
  runner: SupervisorRunner,
  samples: GoldenSetType,
  maxBudgetUsd: number,
  budgetAlreadyUsedUsd: number,
  maxInfraRetries: number,
  infraRetryDelayMs: number,
  deadlineAt: number,
  roundNumber: number,
): Promise<SupervisorRCRoundResult> {
  const results: SampleRunResult[] = [];
  let costUsd = budgetAlreadyUsedUsd;
  let totalDurationMs = 0;
  const scorer = new GoldenSetScorer(samples as GoldenSet);

  for (const sample of samples) {
    let runResult: SupervisorRunResult | null = null;

    for (let attempt = 0; attempt <= maxInfraRetries; attempt++) {
      // 预算检查
      if (costUsd >= maxBudgetUsd) {
        throw new SupervisorRCError(
          `预算超限：已使用 $${costUsd.toFixed(4)}，上限 $${maxBudgetUsd}`,
          "budget",
          costUsd,
        );
      }

      // 时限检查
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new SupervisorRCError(
          "RC 运行超过总时限",
          "deadline",
        );
      }

      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new SupervisorRCError("RC 运行超过总时限", "deadline");
          controller.abort(error);
          reject(error);
        }, remainingMs);
      });

      try {
        const start = Date.now();
        runResult = await Promise.race([
          runner.runSample(sample as GoldenSample, controller.signal),
          deadline,
        ]);
        const elapsed = Date.now() - start;
        totalDurationMs += elapsed;

        if (runResult.error) {
          throw new SupervisorRCError(runResult.error, "content");
        }

        // P1-14: 拒绝 Mock provider 结果 — RC 门禁不得通过 Mock 成功。
        // Mock provider 返回的完美分数会制造质量假象，必须立即阻断。
        if (runResult.mockProvider === true) {
          throw new SupervisorRCError(
            `样本 ${sample.sampleId} 使用了 Mock provider (fingerprint: ${runResult.providerFingerprint ?? "null"})，RC 门禁拒绝 Mock 结果`,
            "content",
          );
        }

        costUsd += runResult.costUsd ?? 0;
        if (costUsd > maxBudgetUsd) {
          throw new SupervisorRCError(
            `预算超限：已使用 $${costUsd.toFixed(4)}，上限 $${maxBudgetUsd}`,
            "budget",
            costUsd,
          );
        }

        results.push(toSampleRunResult(runResult));
        break;
      } catch (err) {
        if (
          err instanceof SupervisorRCError &&
          (err.type === "budget" || err.type === "deadline")
        ) {
          throw err;
        }

        if (!isInfrastructureError(err) || attempt === maxInfraRetries) {
          // 非基础设施失败，记录错误结果
          results.push({
            sampleId: sample.sampleId,
            cards: [],
            coverage: {
              sourcePhysical: 0,
              bundleAssignment: 0,
              explicitDecision: 0,
              candidateSurvival: 0,
              publishedConcept: 0,
            },
            evidenceIntegrity: {
              allowlistCompliant: false,
              quoteHashValid: false,
              typedEvidence: false,
            },
            unsupportedClaimCount: 0,
            semanticSupport: { total: 0, supported: 0, partial: 0, unsupported: 0, contradicted: 0 },
            conceptRecall: { importantHits: 0, importantTotal: sample.mustLearnConcepts.length, criticalHits: 0, criticalTotal: sample.criticalConcepts.length },
            sectionRecall: { hits: 0, total: sample.expectedSections.length },
            budgetCompliance: {
              turnBudgetExceeded: false,
              tokenBudgetExceeded: false,
              toolCallBudgetExceeded: false,
              costCapExceeded: false,
            },
            crossCardDuplicates: 0,
          });
          break;
        }

        await sleep(infraRetryDelayMs);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  }

  const scorerResult = scorer.score(results);
  const modelRevision = runner.getModelRevision();

  return {
    round: roundNumber,
    results,
    scorerResult,
    modelRevision,
    costUsd,
    totalDurationMs,
  };
}

// ─── 主函数 ───────────────────────────────────────────────────────────────

/**
 * 运行 Supervisor Agent v1 RC 质量门禁。
 *
 * 执行步骤：
 * 1. 根据子集筛选黄金集
 * 2. 对每轮（默认 2 轮）：
 *    a. 对每个样本运行 Supervisor Agent v1
 *    b. 收集运行结果
 *    c. 使用 GoldenSetScorer 评分
 * 3. 检查每轮是否通过质量阈值
 * 4. 检查两轮一致性
 * 5. 返回结果
 */
export async function runSupervisorRCGate(
  config: SupervisorRCConfig,
): Promise<SupervisorRCGateResult> {
  const errors: string[] = [];

  // 1. 筛选子集
  const samples = selectSubset(GOLDEN_SET as unknown as GoldenSetType, config.subset);

  if (samples.length === 0) {
    return {
      gate: "supervisor-agent-v1-rc",
      subset: config.subset,
      passed: false,
      providerEndpoint: config.runner.getEndpointOrigin(),
      modelId: config.runner.getModelId(),
      modelRevision: null,
      rounds: [],
      averageAggregate: {
        passRate: 0,
        avgCoverage: 0,
        avgImportantConceptRecall: 0,
        avgCriticalConceptRecall: 0,
        avgCrossCardDuplication: 0,
        totalUnsupportedClaims: 0,
        humanDeckAcceptRate: 0,
        humanTitleSummaryAcceptRate: 0,
      },
      failedDimensions: [],
      totalCostUsd: 0,
      totalDurationMs: 0,
      failureReason: `子集 ${config.subset} 未匹配任何样本`,
      errors: [],
    };
  }

  // 2. 运行每轮
  const rounds: SupervisorRCRoundResult[] = [];
  let totalCostUsd = 0;
  const deadlineAt = Date.now() + config.maxRunDurationMs;

  for (let round = 1; round <= config.maxRounds; round++) {
    try {
      const roundResult = await runSingleRound(
        config.runner,
        samples,
        config.maxBudgetUsd,
        totalCostUsd,
        config.maxInfraRetries,
        config.infraRetryDelayMs,
        deadlineAt,
        round,
      );
      rounds.push(roundResult);
      totalCostUsd = roundResult.costUsd;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`第 ${round} 轮运行失败：${message}`);

      const costUsd = err instanceof SupervisorRCError && err.costUsd !== null
        ? err.costUsd
        : totalCostUsd;

      return {
        gate: "supervisor-agent-v1-rc",
        subset: config.subset,
        passed: false,
        providerEndpoint: config.runner.getEndpointOrigin(),
        modelId: config.runner.getModelId(),
        modelRevision: rounds[0]?.modelRevision ?? null,
        rounds,
        averageAggregate: {
          passRate: 0,
          avgCoverage: 0,
          avgImportantConceptRecall: 0,
          avgCriticalConceptRecall: 0,
          avgCrossCardDuplication: 0,
          totalUnsupportedClaims: 0,
          humanDeckAcceptRate: 0,
          humanTitleSummaryAcceptRate: 0,
        },
        failedDimensions: [],
        totalCostUsd: costUsd,
        totalDurationMs: rounds.reduce((sum, r) => sum + r.totalDurationMs, 0),
        failureReason: err instanceof SupervisorRCError && err.type === "budget"
          ? "预算超限，RC 保持阻断"
          : err instanceof SupervisorRCError && err.type === "deadline"
            ? "RC 总运行时限超出，保持阻断"
            : `第 ${round} 轮运行失败`,
        errors,
      };
    }
  }

  // 3. 检查每轮是否通过
  for (const round of rounds) {
    if (!round.scorerResult.meetsPublicBetaThreshold) {
      errors.push(
        `第 ${round.round} 轮未通过质量阈值：${round.scorerResult.failedDimensions.join(", ")}`,
      );
    }
  }

  // 4. 检查 revision 一致性
  const revisions = new Set(
    rounds
      .map((r) => r.modelRevision)
      .filter((r): r is string => Boolean(r)),
  );
  if (revisions.size > 1) {
    errors.push(`RC 调用使用了不同 model revision：${[...revisions].join(", ")}`);
  }
  if (revisions.size === 0) {
    errors.push("Provider 未返回可取证的 model revision");
  }

  // 5. 计算两轮平均
  const averageAggregate = computeAverageAggregate(rounds);

  // 6. 检查相对下降（如有上一 RC）
  if (config.previousAggregate) {
    const regressions = checkAggregateRegression(
      averageAggregate,
      config.previousAggregate,
    );
    if (regressions.length > 0) {
      errors.push(...regressions);
    }
  }

  // 7. 收集失败维度
  const allFailedDimensions = new Set<string>();
  for (const round of rounds) {
    for (const dim of round.scorerResult.failedDimensions) {
      allFailedDimensions.add(dim);
    }
  }

  const passed = errors.length === 0;
  const totalDurationMs = rounds.reduce((sum, r) => sum + r.totalDurationMs, 0);

  return {
    gate: "supervisor-agent-v1-rc",
    subset: config.subset,
    passed,
    providerEndpoint: config.runner.getEndpointOrigin(),
    modelId: config.runner.getModelId(),
    modelRevision: revisions.size === 1 ? [...revisions][0]! : null,
    rounds,
    averageAggregate,
    failedDimensions: [...allFailedDimensions],
    totalCostUsd,
    totalDurationMs,
    failureReason: passed ? null : "Supervisor Agent v1 RC 质量门禁未通过",
    errors,
  };
}

/**
 * 计算两轮平均聚合指标。
 */
function computeAverageAggregate(
  rounds: SupervisorRCRoundResult[],
): ScorerResult["aggregate"] {
  if (rounds.length === 0) {
    return {
      passRate: 0,
      avgCoverage: 0,
      avgImportantConceptRecall: 0,
      avgCriticalConceptRecall: 0,
      avgCrossCardDuplication: 0,
      totalUnsupportedClaims: 0,
      humanDeckAcceptRate: 0,
      humanTitleSummaryAcceptRate: 0,
    };
  }

  const sum = rounds.reduce(
    (acc, r) => ({
      passRate: acc.passRate + r.scorerResult.aggregate.passRate,
      avgCoverage: acc.avgCoverage + r.scorerResult.aggregate.avgCoverage,
      avgImportantConceptRecall: acc.avgImportantConceptRecall + r.scorerResult.aggregate.avgImportantConceptRecall,
      avgCriticalConceptRecall: acc.avgCriticalConceptRecall + r.scorerResult.aggregate.avgCriticalConceptRecall,
      avgCrossCardDuplication: acc.avgCrossCardDuplication + r.scorerResult.aggregate.avgCrossCardDuplication,
      totalUnsupportedClaims: acc.totalUnsupportedClaims + r.scorerResult.aggregate.totalUnsupportedClaims,
      humanDeckAcceptRate: acc.humanDeckAcceptRate + r.scorerResult.aggregate.humanDeckAcceptRate,
      humanTitleSummaryAcceptRate: acc.humanTitleSummaryAcceptRate + r.scorerResult.aggregate.humanTitleSummaryAcceptRate,
    }),
    {
      passRate: 0,
      avgCoverage: 0,
      avgImportantConceptRecall: 0,
      avgCriticalConceptRecall: 0,
      avgCrossCardDuplication: 0,
      totalUnsupportedClaims: 0,
      humanDeckAcceptRate: 0,
      humanTitleSummaryAcceptRate: 0,
    },
  );

  const n = rounds.length;
  return {
    passRate: sum.passRate / n,
    avgCoverage: sum.avgCoverage / n,
    avgImportantConceptRecall: sum.avgImportantConceptRecall / n,
    avgCriticalConceptRecall: sum.avgCriticalConceptRecall / n,
    avgCrossCardDuplication: sum.avgCrossCardDuplication / n,
    totalUnsupportedClaims: sum.totalUnsupportedClaims,
    humanDeckAcceptRate: sum.humanDeckAcceptRate / n,
    humanTitleSummaryAcceptRate: sum.humanTitleSummaryAcceptRate / n,
  };
}

/**
 * 检查聚合指标相对上一 RC 的下降是否超过 2 个百分点。
 */
function checkAggregateRegression(
  current: ScorerResult["aggregate"],
  previous: ScorerResult["aggregate"],
): string[] {
  const MAX_DROP = 0.02;
  const regressions: string[] = [];

  const checkMetric = (name: string, curr: number, prev: number) => {
    if (prev - curr > MAX_DROP) {
      regressions.push(
        `${name} 下降 ${((prev - curr) * 100).toFixed(2)}pp（从 ${(prev * 100).toFixed(2)}% 到 ${(curr * 100).toFixed(2)}%）`,
      );
    }
  };

  checkMetric("passRate", current.passRate, previous.passRate);
  checkMetric("avgCoverage", current.avgCoverage, previous.avgCoverage);
  checkMetric("avgImportantConceptRecall", current.avgImportantConceptRecall, previous.avgImportantConceptRecall);
  checkMetric("avgCriticalConceptRecall", current.avgCriticalConceptRecall, previous.avgCriticalConceptRecall);

  // 跨卡重复率：上升超过 2pp 也是回退
  if (current.avgCrossCardDuplication - previous.avgCrossCardDuplication > MAX_DROP) {
    regressions.push(
      `avgCrossCardDuplication 上升 ${((current.avgCrossCardDuplication - previous.avgCrossCardDuplication) * 100).toFixed(2)}pp`,
    );
  }

  return regressions;
}

/**
 * 生成 immutable RC artifact JSON（计划 §G2, §18.1）。
 *
 * 包含：
 * - engine/shell/Supervisor version
 * - provider model/revision
 * - dataset/scorer digest
 * - 两轮质量指标
 * - 成本/耗时
 * - passed/failedDimensions
 */
export function generateRCArtifact(
  result: SupervisorRCGateResult,
  metadata: {
    engineVersion: string;
    shellVersion: string;
    supervisorVersion: string;
    toolVersions: Record<string, string>;
    criticVersion: string;
    verifierVersion: string;
    datasetDigest: string;
    scorerDigest: string;
  },
): string {
  const artifact = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    gate: result.gate,
    subset: result.subset,
    passed: result.passed,
    engine: {
      engineVersion: metadata.engineVersion,
      shellVersion: metadata.shellVersion,
      supervisorVersion: metadata.supervisorVersion,
      toolVersions: metadata.toolVersions,
      criticVersion: metadata.criticVersion,
      verifierVersion: metadata.verifierVersion,
    },
    provider: {
      endpoint: result.providerEndpoint,
      modelId: result.modelId,
      modelRevision: result.modelRevision,
    },
    dataset: {
      digest: metadata.datasetDigest,
      subsetSize: result.rounds[0]?.results.length ?? 0,
      goldenSetSize: GOLDEN_SET_SIZE,
    },
    scorer: {
      digest: metadata.scorerDigest,
    },
    rounds: result.rounds.map((r) => ({
      round: r.round,
      aggregate: r.scorerResult.aggregate,
      meetsThreshold: r.scorerResult.meetsPublicBetaThreshold,
      failedDimensions: r.scorerResult.failedDimensions,
      costUsd: r.costUsd,
      durationMs: r.totalDurationMs,
      modelRevision: r.modelRevision,
    })),
    averageAggregate: result.averageAggregate,
    totalCostUsd: result.totalCostUsd,
    totalDurationMs: result.totalDurationMs,
    failedDimensions: result.failedDimensions,
    failureReason: result.failureReason,
    errors: result.errors,
    thresholds: QUALITY_THRESHOLDS,
  };

  return JSON.stringify(artifact, null, 2);
}
