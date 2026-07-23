/**
 * AIQ-01 RC Runner — 真实 Provider 质量门禁
 *
 * 对应 ADR-0005 第 3 条：
 * "RC 门禁使用固定参考 Provider 对 30 篇完整黄金集运行 2 次，
 *  两次都必须满足 90% / 85% / 85% 绝对阈值；
 *  rc.1 只使用绝对阈值并冻结为首个可比基线，
 *  后续 RC 的三项两轮平均值相对上一个同配置已接受 RC 不得下降超过 2 个百分点"。
 *
 * 与 PR runner 的区别：
 * - PR 使用 Mock 输出，只验证结构/评分逻辑
 * - RC 调用真实 Provider，验证 AI 生成质量
 * - RC 有预算控制（10 美元上限）
 * - RC 有 revision 取证（记录模型修订信息）
 * - RC 有上一 RC 比较（≤2pp 下降）
 * - RC 有基础设施失败重试（30 分钟内最多 2 次）
 *
 * 依赖注入设计：
 * - ProviderClient 接口：生产环境传入真实 DashScope client，测试传入 Mock
 * - alignEvidence 函数：生产环境传入 ai-worker alignQuote，测试传入 mockAlignEvidence
 * 这样 RC runner 可以在不访问网络的情况下进行单元测试。
 */

import { GOLDEN_DATASET } from "./dataset.ts";
import { getGoldenLabels } from "./labels.ts";
import { validateIntegrity } from "./integrity.ts";
import {
  SCORER_VERSION,
  PROMPT_VERSION,
  generateScorerReport,
  meetsRCThreshold,
  type SampleRunResult,
} from "./scorer.ts";
import type {
  AlignmentResult,
  DatasetBlock,
  ModelCardOutput,
  QualityConfigFingerprint,
  ScorerMetrics,
  ScorerReport,
} from "./types.ts";

// ─── 默认配置 ───────────────────────────────────────────────────────

export const DEFAULT_RC_CONFIG: Omit<RCRunnerConfig, "provider" | "alignEvidence"> = {
  maxBudgetUsd: 10,
  maxRounds: 2,
  maxInfraRetries: 2,
  infraRetryDelayMs: 30_000,
  maxRunDurationMs: 30 * 60_000,
  temperature: 0.2,
  previousRCMetrics: null,
};

// ─── 错误分类 ───────────────────────────────────────────────────────

/**
 * Provider 错误类型分类（ADR-0005 第 3 条）：
 * - infrastructure: 认证、额度、DNS、网络、服务商 5xx → 可重试
 * - schema: 输出结构不符合 ModelCardOutput → 不可重试
 * - content: 空结果或内容质量问题 → 不可重试
 * - budget/deadline: 预算或总运行时限超出 → 不可重试，必须停止
 */
export type ProviderErrorType =
  | "infrastructure"
  | "schema"
  | "content"
  | "budget"
  | "deadline";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly type: ProviderErrorType,
    /** Actual spend observed before a budget failure, when available. */
    public readonly budgetUsedUsd: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// ─── 依赖注入接口 ───────────────────────────────────────────────────

/**
 * Provider 客户端接口。
 * 生产环境传入真实 DashScope compatible endpoint client。
 */
export interface ProviderClient {
  /** 调用 Provider 生成学习卡 */
  generateCard(
    blocks: DatasetBlock[],
    signal?: AbortSignal,
  ): Promise<ProviderCallResult>;

  /** 获取 Provider endpoint origin（用于 manifest） */
  getEndpointOrigin(): string;

  /** 获取模型 ID（用于 manifest） */
  getModelId(): string;
}

/**
 * Provider 调用结果。
 */
export interface ProviderCallResult {
  /** 模型生成的学习卡输出 */
  output: ModelCardOutput;
  /** 模型 revision ID（从 HTTP 响应头或 body 提取） */
  revision: string | null;
  /** 本次调用估算成本（美元） */
  costUsd: number;
}

/**
 * 证据对齐函数类型。
 * 生产环境传入 ai-worker 的 alignQuote。
 */
export type AlignEvidenceFn = (
  noteFile: string,
  modelOutput: ModelCardOutput,
) => AlignmentResult[];

// ─── 配置与结果类型 ─────────────────────────────────────────────────

export interface RCRunnerConfig {
  /** Provider 客户端 */
  provider: ProviderClient;
  /** 证据对齐函数 */
  alignEvidence: AlignEvidenceFn;
  /** 预算上限（美元），默认 10 */
  maxBudgetUsd: number;
  /** 运行轮数，默认 2 */
  maxRounds: number;
  /** 基础设施失败最大重试次数，默认 2 */
  maxInfraRetries: number;
  /** 基础设施失败重试延迟（毫秒），默认 30000 */
  infraRetryDelayMs: number;
  /** 两轮和全部重试的总运行时限（毫秒），默认 30 分钟 */
  maxRunDurationMs: number;
  /** 温度参数，默认 0.2 */
  temperature: number;
  /** 上一已接受 RC 的指标（用于比较），null 表示这是 rc.1 */
  previousRCMetrics: ScorerMetrics | null;
}

export interface RCRoundResult {
  /** 轮次编号（1-based） */
  round: number;
  /** 每个样本的运行结果 */
  results: SampleRunResult[];
  /** 评分报告 */
  report: ScorerReport;
  /** 模型 revision ID */
  modelRevision: string | null;
  /** 本轮每次成功 Provider 调用返回的 revision 证据。 */
  modelRevisions: Array<string | null>;
  /** 截至本轮结束累计使用的预算（美元） */
  budgetUsedUsd: number;
}

export interface RCGateResult {
  /** 门禁名称 */
  gate: string;
  /** 门禁是否通过 */
  passed: boolean;
  /** 运行配置指纹 */
  config: QualityConfigFingerprint;
  /** 每轮结果 */
  rounds: RCRoundResult[];
  /** 两轮平均指标 */
  averageMetrics: ScorerMetrics;
  /** 失败原因（未通过时） */
  failureReason: string | null;
  /** 总预算使用（美元） */
  budgetUsedUsd: number;
  /** 校验错误列表 */
  errors: string[];
}

// ─── 辅助函数 ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 判断错误是否为基础设施失败（可重试）。
 */
export function isInfrastructureError(err: unknown): boolean {
  if (err instanceof ProviderError) {
    return err.type === "infrastructure";
  }
  // 网络/DNS/超时等也归为基础设施失败
  if (err instanceof Error) {
    const cause = err.cause;
    const causeDetails = cause instanceof Error
      ? `${cause.name} ${cause.message} ${(cause as NodeJS.ErrnoException).code ?? ""}`
      : String(cause ?? "");
    const msg = `${err.name} ${err.message} ${causeDetails}`.toLowerCase();
    return (
      err.name === "InfrastructureError" ||
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
 * 计算两轮指标的平均值。
 */
export function averageMetrics(rounds: RCRoundResult[]): ScorerMetrics {
  if (rounds.length === 0) {
    return {
      hardCitationPrecision: null,
      keyPointHardCoverage: null,
      validationExpectedPointsHardCoverage: null,
      metricsVerified: false,
    };
  }

  const validRounds = rounds.filter((r) => r.report.metrics.metricsVerified);
  if (validRounds.length === 0) {
    return {
      hardCitationPrecision: null,
      keyPointHardCoverage: null,
      validationExpectedPointsHardCoverage: null,
      metricsVerified: false,
    };
  }

  const sum = validRounds.reduce(
    (acc, r) => {
      const m = r.report.metrics;
      return {
        hcp: acc.hcp + (m.hardCitationPrecision ?? 0),
        kphc: acc.kphc + (m.keyPointHardCoverage ?? 0),
        vepc: acc.vepc + (m.validationExpectedPointsHardCoverage ?? 0),
      };
    },
    { hcp: 0, kphc: 0, vepc: 0 },
  );

  const n = validRounds.length;
  return {
    hardCitationPrecision: sum.hcp / n,
    keyPointHardCoverage: sum.kphc / n,
    validationExpectedPointsHardCoverage: sum.vepc / n,
    metricsVerified: validRounds.length === rounds.length,
  };
}

/**
 * 检查相对上一 RC 的下降是否超过 2 个百分点。
 * rc.1 没有上一 RC，跳过此检查。
 */
export function checkRegression(
  current: ScorerMetrics,
  previous: ScorerMetrics | null,
): { passed: boolean; regressions: string[] } {
  if (!previous || !previous.metricsVerified) {
    return { passed: true, regressions: [] };
  }

  const MAX_DROP = 0.02; // 2 percentage points
  const regressions: string[] = [];

  const checkMetric = (name: string, curr: number | null, prev: number | null) => {
    if (curr !== null && prev !== null && prev - curr > MAX_DROP) {
      regressions.push(
        `${name} 下降 ${((prev - curr) * 100).toFixed(2)}pp（从 ${(prev * 100).toFixed(2)}% 到 ${(curr * 100).toFixed(2)}%）`,
      );
    }
  };

  checkMetric("hardCitationPrecision", current.hardCitationPrecision, previous.hardCitationPrecision);
  checkMetric("keyPointHardCoverage", current.keyPointHardCoverage, previous.keyPointHardCoverage);
  checkMetric("validationExpectedPointsHardCoverage", current.validationExpectedPointsHardCoverage, previous.validationExpectedPointsHardCoverage);

  return { passed: regressions.length === 0, regressions };
}

async function callProviderBeforeDeadline(
  provider: ProviderClient,
  blocks: DatasetBlock[],
  deadlineAt: number,
): Promise<ProviderCallResult> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new ProviderError("RC 运行超过 30 分钟总时限", "deadline");
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new ProviderError("RC 运行超过 30 分钟总时限", "deadline");
      controller.abort(error);
      reject(error);
    }, remainingMs);
  });

  try {
    return await Promise.race([
      provider.generateCard(blocks, controller.signal),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ─── 主函数 ─────────────────────────────────────────────────────────

/**
 * 运行单轮 RC 质量门禁。
 * 对每个样本调用 Provider，对齐证据，计算指标。
 */
async function runSingleRound(
  provider: ProviderClient,
  alignEvidence: AlignEvidenceFn,
  maxBudgetUsd: number,
  budgetAlreadyUsedUsd: number,
  maxInfraRetries: number,
  infraRetryDelayMs: number,
  deadlineAt: number,
  roundNumber: number,
): Promise<RCRoundResult> {
  const results: SampleRunResult[] = [];
  let budgetUsedUsd = budgetAlreadyUsedUsd;
  const modelRevisions: Array<string | null> = [];

  for (const sample of GOLDEN_DATASET) {
    let lastError: string | null = null;
    let sampleResult: SampleRunResult | null = null;

    for (let attempt = 0; attempt <= maxInfraRetries; attempt++) {
      // 预算检查
      if (budgetUsedUsd >= maxBudgetUsd) {
        throw new ProviderError(
          `预算超限：已使用 $${budgetUsedUsd.toFixed(4)}，上限 $${maxBudgetUsd}`,
          "budget",
          budgetUsedUsd,
        );
      }

      try {
        const callResult = await callProviderBeforeDeadline(
          provider,
          sample.blocks,
          deadlineAt,
        );

        if (!Number.isFinite(callResult.costUsd) || callResult.costUsd < 0) {
          throw new ProviderError(
            `Provider 返回无效成本：${String(callResult.costUsd)}`,
            "content",
          );
        }

        // 保存每次成功调用的 revision 证据，避免只看本轮第一次调用而
        // 漏掉 Provider 在同一轮黄金集运行期间发生的模型漂移。
        modelRevisions.push(callResult.revision);

        // 预算累加
        budgetUsedUsd += callResult.costUsd;
        if (budgetUsedUsd > maxBudgetUsd) {
          throw new ProviderError(
            `预算超限：已使用 $${budgetUsedUsd.toFixed(4)}，上限 $${maxBudgetUsd}`,
            "budget",
            budgetUsedUsd,
          );
        }

        // 对齐证据
        const alignments = alignEvidence(sample.file, callResult.output);

        sampleResult = {
          noteFile: sample.file,
          keyPoints: alignments,
          error: null,
        };
        lastError = null;
        break; // 成功，跳出重试循环
      } catch (err) {
        if (
          err instanceof ProviderError
          && (err.type === "budget" || err.type === "deadline")
        ) {
          throw err; // 预算/总时限超出，立即停止
        }

        if (!isInfrastructureError(err) || attempt === maxInfraRetries) {
          // 非基础设施失败，或重试次数用完
          lastError = err instanceof Error ? err.message : String(err);
          break;
        }

        // 基础设施失败，等待后重试
        await sleep(infraRetryDelayMs);
      }
    }

    if (sampleResult) {
      results.push(sampleResult);
    } else {
      results.push({
        noteFile: sample.file,
        keyPoints: [],
        error: lastError ?? "unknown error",
      });
    }
  }

  const labels = getGoldenLabels();
  const report = generateScorerReport(results, labels);
  const observedRevisions = new Set(
    modelRevisions.filter((revision): revision is string => Boolean(revision)),
  );
  const modelRevision = modelRevisions.length === GOLDEN_DATASET.length
    && !modelRevisions.includes(null)
    && observedRevisions.size === 1
    ? [...observedRevisions][0]!
    : null;

  return {
    round: roundNumber,
    results,
    report,
    modelRevision,
    modelRevisions,
    budgetUsedUsd,
  };
}

/**
 * 运行 RC 质量门禁。
 *
 * 执行步骤：
 * 1. 校验数据集和标签完整性
 * 2. 对每轮（默认 2 轮）：
 *    a. 对每个样本调用 Provider 生成学习卡
 *    b. 对齐证据
 *    c. 计算指标
 *    d. 检查预算
 * 3. 计算两轮平均指标
 * 4. 检查绝对阈值（90%/85%/85%）
 * 5. 如果有上一 RC，检查相对下降（≤2pp）
 * 6. 返回结果
 *
 * @param config - RC runner 配置
 * @returns RC 门禁结果
 */
export async function runRCGate(config: RCRunnerConfig): Promise<RCGateResult> {
  const errors: string[] = [];

  // 1. 校验数据集和标签完整性
  const integrity = validateIntegrity();
  if (!integrity.valid) {
    return {
      gate: "ai-quality-rc",
      passed: false,
      config: {
        datasetVersion: "unknown",
        labelVersion: "unknown",
        scorerVersion: SCORER_VERSION,
        promptVersion: PROMPT_VERSION,
        providerEndpointOrigin: config.provider.getEndpointOrigin(),
        modelId: config.provider.getModelId(),
        modelRevision: null,
        temperature: config.temperature,
      },
      rounds: [],
      averageMetrics: {
        hardCitationPrecision: null,
        keyPointHardCoverage: null,
        validationExpectedPointsHardCoverage: null,
        metricsVerified: false,
      },
      failureReason: "数据集或标签完整性校验失败",
      budgetUsedUsd: 0,
      errors: integrity.errors,
    };
  }

  // 2. 运行每轮
  const rounds: RCRoundResult[] = [];
  let totalBudgetUsedUsd = 0;
  if (!Number.isFinite(config.maxRunDurationMs) || config.maxRunDurationMs <= 0) {
    throw new Error("maxRunDurationMs 必须是正的有限数字");
  }
  const deadlineAt = Date.now() + config.maxRunDurationMs;

  for (let round = 1; round <= config.maxRounds; round++) {
    try {
      const roundResult = await runSingleRound(
        config.provider,
        config.alignEvidence,
        config.maxBudgetUsd,
        totalBudgetUsedUsd,
        config.maxInfraRetries,
        config.infraRetryDelayMs,
        deadlineAt,
        round,
      );
      rounds.push(roundResult);
      totalBudgetUsedUsd = roundResult.budgetUsedUsd;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`第 ${round} 轮运行失败：${message}`);
      if (
        err instanceof ProviderError
        && err.type === "budget"
        && err.budgetUsedUsd !== null
      ) {
        totalBudgetUsedUsd = err.budgetUsedUsd;
      }

      return {
        gate: "ai-quality-rc",
        passed: false,
        config: {
          datasetVersion: "unknown",
          labelVersion: "unknown",
          scorerVersion: SCORER_VERSION,
          promptVersion: PROMPT_VERSION,
          providerEndpointOrigin: config.provider.getEndpointOrigin(),
          modelId: config.provider.getModelId(),
          modelRevision: rounds[0]?.modelRevision ?? null,
          temperature: config.temperature,
        },
        rounds,
        averageMetrics: {
          hardCitationPrecision: null,
          keyPointHardCoverage: null,
          validationExpectedPointsHardCoverage: null,
          metricsVerified: false,
        },
        failureReason: err instanceof ProviderError && err.type === "budget"
          ? "预算超限，RC 保持阻断"
          : err instanceof ProviderError && err.type === "deadline"
            ? "RC 总运行时限超出，保持阻断"
            : `第 ${round} 轮运行失败`,
        budgetUsedUsd: totalBudgetUsedUsd,
        errors,
      };
    }
  }

  // 3. 计算两轮平均指标
  const avgMetrics = averageMetrics(rounds);

  // ADR-0005 要求每一轮都独立达到绝对阈值；平均值只用于与上一 RC
  // 比较，不能用一轮高分抵消另一轮不达标。
  for (const round of rounds) {
    if (!meetsRCThreshold(round.report.metrics)) {
      errors.push(`第 ${round.round} 轮指标未达到 RC 绝对阈值`);
    }
  }

  const revisionEvidence = rounds.flatMap((round) => round.modelRevisions);
  const revisions = new Set(
    revisionEvidence.filter((revision): revision is string => Boolean(revision)),
  );
  if (
    revisionEvidence.length !== GOLDEN_DATASET.length * rounds.length
    || revisionEvidence.some((revision) => !revision)
  ) {
    errors.push("Provider 未返回可取证的 model revision");
  }
  if (revisions.size !== 1) {
    errors.push(`RC 调用使用了不同 model revision：${[...revisions].join(", ")}`);
  }

  // 4. 检查绝对阈值
  if (!avgMetrics.metricsVerified) {
    errors.push("平均指标 metricsVerified 为 false，存在运行失败的样本或标签覆盖不完整");
  }

  if (avgMetrics.metricsVerified && !meetsRCThreshold(avgMetrics)) {
    errors.push(
      `平均指标未达到 RC 绝对阈值：` +
        `hardCitationPrecision=${avgMetrics.hardCitationPrecision !== null ? (avgMetrics.hardCitationPrecision * 100).toFixed(2) + "%" : "null"}（需 ≥90%），` +
        `keyPointHardCoverage=${avgMetrics.keyPointHardCoverage !== null ? (avgMetrics.keyPointHardCoverage * 100).toFixed(2) + "%" : "null"}（需 ≥85%），` +
        `validationExpectedPointsHardCoverage=${avgMetrics.validationExpectedPointsHardCoverage !== null ? (avgMetrics.validationExpectedPointsHardCoverage * 100).toFixed(2) + "%" : "null"}（需 ≥85%）`,
    );
  }

  // 5. 检查相对下降
  const regression = checkRegression(avgMetrics, config.previousRCMetrics);
  if (!regression.passed) {
    errors.push(...regression.regressions);
  }

  // 6. 构建配置指纹
  const configFingerprint: QualityConfigFingerprint = {
    datasetVersion: rounds[0]?.report.datasetVersion ?? "unknown",
    labelVersion: rounds[0]?.report.labelVersion ?? "unknown",
    scorerVersion: SCORER_VERSION,
    promptVersion: PROMPT_VERSION,
    providerEndpointOrigin: config.provider.getEndpointOrigin(),
    modelId: config.provider.getModelId(),
    modelRevision: revisions.size === 1 && !revisionEvidence.includes(null)
      ? [...revisions][0]!
      : null,
    temperature: config.temperature,
  };

  const passed = errors.length === 0;

  return {
    gate: "ai-quality-rc",
    passed,
    config: configFingerprint,
    rounds,
    averageMetrics: avgMetrics,
    failureReason: passed ? null : "RC 质量门禁未通过",
    budgetUsedUsd: totalBudgetUsedUsd,
    errors,
  };
}
