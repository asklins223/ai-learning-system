/**
 * Epoch-Fenced 原子发布（计划 §5.1, §11.4, §W5）
 *
 * PUBLISH 是四个稳定外层节点中的最后一个。
 * 单事务 canonical publish，按固定锁序执行。
 *
 * 锁序（计划 §11.4）：
 * 1. job lease
 * 2. workspace advisory lock
 * 3. run FOR UPDATE + stateVersion
 * 4. note epoch、latest run、cancel/supersede
 * 5. publish unit FOR UPDATE
 * 6. draft/candidate/source ledger/manifest/report hash
 * 7. bundle coverage、critic verdict、ownership、budget
 * 8. exact text/image evidence 重建和 hash
 * 9. 原子写 Card Set/Card/Key Point/Evidence/Search/Review 关系
 * 10. supersede 旧结果
 * 11. run CAS 终态和 result pointers
 *
 * 不变量（G9, G11, §11.4）：
 * - Agent 只写 staging，Canonical Card Set 只能由 deterministic Publish 写入
 * - publish commit 后响应丢失时，重试返回同一 Card Set
 * - 新增 Provider 调用必须为 0
 * - stale epoch/cancel/partial/duplicate publish = 0
 */

import type {
  DeckDraft,
  QualityReport,
  CoverageReport,
} from "@ailearn/shared";
import { logger } from "../lib/logger.ts";

/** Publish 输入 */
export interface PublishInput {
  /** 运行 ID */
  runId: string;
  /** 工作区 ID */
  workspaceId: string;
  /** noteVersion ID */
  noteVersionId: string;
  /** 用户 ID */
  userId: string;
  /** 要发布的 Draft */
  draft: DeckDraft;
  /** Quality Report */
  qualityReport: QualityReport;
  /** Coverage Report */
  coverageReport: CoverageReport;
  /** 验证的 draft hash */
  verifiedDraftHash: string;
  /** 当前 epoch */
  currentEpoch: number;
  /** Budget 使用量（只读检查） */
  budgetUsage: {
    providerCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
}

/** Publish 结果 */
export interface PublishResult {
  /** 是否成功 */
  success: boolean;
  /** 创建的 Card Set ID */
  cardSetId: string | null;
  /** 创建的 Card IDs */
  cardIds: string[];
  /** 发布的 epoch */
  publishedEpoch: number | null;
  /** 失败原因 */
  failureReason: string | null;
}

/**
 * 执行原子发布。
 *
 * 所有 Provider、Embedding、Supervisor、Critic 操作在事务外完成。
 * Publish 在单个事务内按固定锁序执行。
 *
 * 不变量（§11.4）：
 * - publish commit 后响应丢失时，重试返回同一 Card Set
 * - 新增 Provider 调用必须为 0
 */
export async function executePublish(
  input: PublishInput,
  /** 事务执行器（由调用方提供数据库连接） */
  txExecutor: PublishTransactionExecutor,
): Promise<PublishResult> {
  logger.info(
    {
      runId: input.runId,
      draftHash: input.verifiedDraftHash,
      cardCount: input.draft.cards.length,
    },
    "PUBLISH 阶段开始",
  );

  // 前置检查：draft hash 必须与验证的一致
  if (input.draft.contentHash !== input.verifiedDraftHash) {
    return {
      success: false,
      cardSetId: null,
      cardIds: [],
      publishedEpoch: null,
      failureReason: `draft hash 不匹配: draft=${input.draft.contentHash}, verified=${input.verifiedDraftHash}`,
    };
  }

  // 前置检查：Critic 必须通过
  if (input.qualityReport.criticStatus !== "passed") {
    return {
      success: false,
      cardSetId: null,
      cardIds: [],
      publishedEpoch: null,
      failureReason: `Critic 未通过: status=${input.qualityReport.criticStatus}`,
    };
  }

  // P0-03 修复（2026-08-03）：严格发布门禁检查
  // 这些检查与 VERIFY 阶段的检查对齐，作为 fail-closed 的最后一道防线。

  // 前置检查：perClaimVerdicts 不得为空
  if (input.qualityReport.perClaimVerdicts.length === 0) {
    return {
      success: false,
      cardSetId: null,
      cardIds: [],
      publishedEpoch: null,
      failureReason: "Critic perClaimVerdicts 为空，不得发布",
    };
  }

  // 前置检查：不得包含 auto_verified reasonCode
  const autoVerified = input.qualityReport.perClaimVerdicts.filter(
    (v) => v.reasonCode === "auto_verified",
  );
  if (autoVerified.length > 0) {
    return {
      success: false,
      cardSetId: null,
      cardIds: [],
      publishedEpoch: null,
      failureReason: `${autoVerified.length} 个 verdict 为 auto_verified（不得发布）`,
    };
  }

  // 前置检查：不得包含 partial/unsupported/contradicted verdict
  const blocked = input.qualityReport.perClaimVerdicts.filter(
    (v) => v.verdict === "partial" || v.verdict === "unsupported" || v.verdict === "contradicted",
  );
  if (blocked.length > 0) {
    return {
      success: false,
      cardSetId: null,
      cardIds: [],
      publishedEpoch: null,
      failureReason: `${blocked.length} 个 verdict 为 partial/unsupported/contradicted（不得发布）`,
    };
  }

  // 前置检查：coverage 前四层必须为 100%
  if (
    input.coverageReport.sourcePhysicalCoverage < 1.0 ||
    input.coverageReport.bundleAssignmentCoverage < 1.0 ||
    input.coverageReport.explicitDecisionCoverage < 1.0 ||
    input.coverageReport.candidateSurvivalCoverage < 1.0
  ) {
    return {
      success: false,
      cardSetId: null,
      cardIds: [],
      publishedEpoch: null,
      failureReason: `coverage 不足: physical=${input.coverageReport.sourcePhysicalCoverage}, assignment=${input.coverageReport.bundleAssignmentCoverage}, decision=${input.coverageReport.explicitDecisionCoverage}, survival=${input.coverageReport.candidateSurvivalCoverage}`,
    };
  }

  // P1-09 前置检查：发布集合不变量
  // 发布集合必须等于：active supported candidates - 有明确原因的 capacity exclusions
  // 即每个 supported candidate 必须被发布或有明确的 capacity exclusion
  const supportedCandidateIds = new Set(
    input.qualityReport.perClaimVerdicts
      .filter((v) => v.verdict === "supported")
      .map((v) => v.candidateId),
  );
  const exclusionCandidateIds = new Set(
    (input.coverageReport.capacityExclusions ?? []).map((e) => e.candidateId),
  );
  // 从 Draft cards 中提取全部已发布 candidate IDs
  const publishedCandidateIds = new Set<string>();
  for (const card of input.draft.cards) {
    const ids = Array.isArray(card.canonicalCandidateIds)
      ? card.canonicalCandidateIds
      : [];
    for (const id of ids) {
      publishedCandidateIds.add(id);
    }
    // 也检查 summarySupportCandidateIds（摘要支撑候选）
    if (Array.isArray(card.summarySupportCandidateIds)) {
      for (const id of card.summarySupportCandidateIds) {
        publishedCandidateIds.add(id);
      }
    }
  }
  // 检查：每个 supported candidate 必须被发布或有 capacity exclusion
  const unpublishedWithoutExclusion: string[] = [];
  for (const candidateId of supportedCandidateIds) {
    if (!publishedCandidateIds.has(candidateId) && !exclusionCandidateIds.has(candidateId)) {
      unpublishedWithoutExclusion.push(candidateId);
    }
  }
  if (unpublishedWithoutExclusion.length > 0) {
    return {
      success: false,
      cardSetId: null,
      cardIds: [],
      publishedEpoch: null,
      failureReason: `P1-09: ${unpublishedWithoutExclusion.length} 个 supported candidate 未发布且无 capacity exclusion: ${unpublishedWithoutExclusion.slice(0, 10).join(", ")}`,
    };
  }
  // 检查：发布的 candidate 必须是 supported 或有 capacity exclusion 的（不允许发布 unsupported 的）
  const publishedNotSupported: string[] = [];
  for (const candidateId of publishedCandidateIds) {
    if (!supportedCandidateIds.has(candidateId)) {
      publishedNotSupported.push(candidateId);
    }
  }
  if (publishedNotSupported.length > 0) {
    return {
      success: false,
      cardSetId: null,
      cardIds: [],
      publishedEpoch: null,
      failureReason: `P1-09: ${publishedNotSupported.length} 个已发布 candidate 不是 supported verdict: ${publishedNotSupported.slice(0, 10).join(", ")}`,
    };
  }

  try {
    // 在事务中执行原子发布
    const result = await txExecutor.executePublishTransaction(input);

    logger.info(
      {
        runId: input.runId,
        cardSetId: result.cardSetId,
        cardCount: result.cardIds.length,
        epoch: result.publishedEpoch,
      },
      "PUBLISH 阶段完成",
    );

    return {
      success: true,
      cardSetId: result.cardSetId,
      cardIds: result.cardIds,
      publishedEpoch: result.publishedEpoch,
      failureReason: null,
    };
  } catch (err) {
    logger.error(
      {
        runId: input.runId,
        error: err instanceof Error ? err.message : String(err),
      },
      "PUBLISH 阶段失败",
    );

    return {
      success: false,
      cardSetId: null,
      cardIds: [],
      publishedEpoch: null,
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 发布事务执行器接口 */
export interface PublishTransactionExecutor {
  /**
   * 在单个事务中执行原子发布。
   *
   * 实现必须按以下锁序（计划 §11.4）：
   * 1. job lease
   * 2. workspace advisory lock
   * 3. run FOR UPDATE + stateVersion
   * 4. note epoch、latest run、cancel/supersede
   * 5. publish unit FOR UPDATE
   * 6. draft/candidate/source ledger/manifest/report hash
   * 7. bundle coverage、critic verdict、ownership、budget
   * 8. exact text/image evidence 重建和 hash
   * 9. 原子写 Card Set/Card/Key Point/Evidence/Search/Review 关系
   * 10. supersede 旧结果
   * 11. run CAS 终态和 result pointers
   */
  executePublishTransaction(input: PublishInput): Promise<{
    cardSetId: string;
    cardIds: string[];
    publishedEpoch: number;
  }>;
}

/** Publish 错误 */
export class PublishError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PublishError";
    this.code = code;
  }
}

/**
 * 幂等检查：如果 run 已经成功发布过，返回同一 Card Set。
 *
 * 不变量（§11.4）：
 * - publish commit 后响应丢失时，重试返回同一 Card Set
 * - 新增 Provider 调用必须为 0
 */
export function checkIdempotentPublish(
  runStatus: string,
  existingCardSetId: string | null,
): { isIdempotent: boolean; cardSetId: string | null } {
  if (runStatus === "succeeded" && existingCardSetId) {
    return { isIdempotent: true, cardSetId: existingCardSetId };
  }
  return { isIdempotent: false, cardSetId: null };
}
