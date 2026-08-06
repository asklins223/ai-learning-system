/**
 * Durable Pagination 模块（P1-08, 计划 §8.3）
 *
 * 当 InputOverContextError 发生时，将大输入拆分为可独立处理的页面。
 * 每页可以独立执行、崩溃恢复后从 page cursor 继续。
 *
 * 核心原则：
 * - 禁止截断 primary evidence 或 JSON（P1-08 不变量）
 * - 超限时拆分为更小的子任务，而非截断
 * - 每页独立处理，结果确定性合并
 * - 分页是幂等的：同一输入总是产生相同的分页方案
 *
 * 使用场景：
 * 1. Extractor：bundle 数量或体积超过 context window → 按 bundle/token 分页
 * 2. Critic：candidate + evidence 超过 context window → 按 candidate 批次分页
 */

import { estimateTokens } from "./request-packer.ts";
import { logger } from "../lib/logger.ts";

// ─── Extractor 分页 ─────────────────────────────────────────────────────────

/** Extractor 分配的 bundle 数据 */
export interface ExtractorBundle {
  bundleId: string;
  sectionPath: string[];
  evidenceUnits: Array<{
    refId: string;
    kind: string;
    text: string;
    contextOnly: boolean;
  }>;
}

/** 分页结果 */
export interface BundlePage {
  /** 页码（从 0 开始） */
  pageIndex: number;
  /** 总页数 */
  totalPages: number;
  /** 该页包含的 bundles */
  bundles: ExtractorBundle[];
  /** 该页的 token 估算 */
  tokenEstimate: number;
}

/**
 * 估算单个 bundle 的 token 数。
 */
function estimateBundleTokens(bundle: ExtractorBundle): number {
  const json = JSON.stringify(bundle);
  return estimateTokens(json);
}

/**
 * 将 assigned bundles 按 token 预算分成多个页面。
 *
 * 算法：
 * 1. 按 bundleOrdinal 顺序遍历
 * 2. 累积 token，当超过单页预算时开始新页
 * 3. 单个 bundle 超过单页预算时，该 bundle 独占一页
 *    （上层应通过更小的 bundle 规划解决，此处不拆分 bundle 内部）
 *
 * @param bundles 已分配的 bundles
 * @param maxTokensPerPage 每页最大 token（应为 availableTokens - overhead）
 * @returns 分页结果数组
 */
export function splitBundlesIntoPages(
  bundles: ExtractorBundle[],
  maxTokensPerPage: number,
): BundlePage[] {
  if (bundles.length === 0) {
    return [];
  }

  // 安全余量：预留 20% 给 instructions 和 JSON 结构开销
  const budgetPerPage = Math.floor(maxTokensPerPage * 0.8);

  const pages: BundlePage[] = [];
  let currentPageBundles: ExtractorBundle[] = [];
  let currentPageTokens = 0;

  for (const bundle of bundles) {
    const bundleTokens = estimateBundleTokens(bundle);

    // 如果当前页已有内容且加入此 bundle 会超限，先 flush 当前页
    if (currentPageBundles.length > 0 && currentPageTokens + bundleTokens > budgetPerPage) {
      pages.push({
        pageIndex: pages.length,
        totalPages: 0, // 稍后更新
        bundles: currentPageBundles,
        tokenEstimate: currentPageTokens,
      });
      currentPageBundles = [];
      currentPageTokens = 0;
    }

    currentPageBundles.push(bundle);
    currentPageTokens += bundleTokens;

    // 单个 bundle 就超过页预算 → 该 bundle 独占一页
    // （不拆分 bundle 内部，上层应通过更小的 bundle 规划解决）
    if (bundleTokens > budgetPerPage && currentPageBundles.length === 1) {
      logger.warn(
        {
          bundleId: bundle.bundleId,
          bundleTokens,
          budgetPerPage,
        },
        "单个 bundle 超过单页 token 预算，该 bundle 将独占一页",
      );
    }
  }

  // flush 最后一页
  if (currentPageBundles.length > 0) {
    pages.push({
      pageIndex: pages.length,
      totalPages: 0,
      bundles: currentPageBundles,
      tokenEstimate: currentPageTokens,
    });
  }

  // 更新 totalPages
  const totalPages = pages.length;
  for (const page of pages) {
    page.totalPages = totalPages;
  }

  return pages;
}

// ─── Critic 分页 ────────────────────────────────────────────────────────────

/** Critic 审查的候选条目 */
export interface CriticCandidateEntry {
  candidateId: string;
  claim: string;
  topic: string;
  cognitiveType: string;
  importance: string;
  bundleId: string | null;
  evidenceRefIds: string[];
}

/** Critic 分批结果 */
export interface CriticBatch {
  /** 批次号（从 0 开始） */
  batchIndex: number;
  /** 总批次数 */
  totalBatches: number;
  /** 该批次包含的候选 */
  candidates: CriticCandidateEntry[];
  /** 该批次的 token 估算 */
  tokenEstimate: number;
}

/**
 * 将候选列表按 token 预算分成多个批次，供 Critic 分批审查。
 *
 * 算法：
 * 1. 按 candidateId 顺序遍历（确定性）
 * 2. 累积 token，当超过单批预算时开始新批
 * 3. 单个 candidate 超过单批预算时，该 candidate 独占一批
 *
 * 服务端按 candidate ID 聚合各批 verdicts，最后做全局重复和覆盖检查。
 *
 * @param candidates 待审查的候选列表
 * @param maxTokensPerBatch 每批最大 token
 * @returns 分批结果数组
 */
export function splitCandidatesIntoBatches(
  candidates: CriticCandidateEntry[],
  maxTokensPerBatch: number,
): CriticBatch[] {
  if (candidates.length === 0) {
    return [];
  }

  // 安全余量：预留 20% 给 instructions 和 JSON 结构开销
  const budgetPerBatch = Math.floor(maxTokensPerBatch * 0.8);

  const batches: CriticBatch[] = [];
  let currentBatchCandidates: CriticCandidateEntry[] = [];
  let currentBatchTokens = 0;

  for (const candidate of candidates) {
    const candidateTokens = estimateTokens(JSON.stringify(candidate));

    if (currentBatchCandidates.length > 0 && currentBatchTokens + candidateTokens > budgetPerBatch) {
      batches.push({
        batchIndex: batches.length,
        totalBatches: 0,
        candidates: currentBatchCandidates,
        tokenEstimate: currentBatchTokens,
      });
      currentBatchCandidates = [];
      currentBatchTokens = 0;
    }

    currentBatchCandidates.push(candidate);
    currentBatchTokens += candidateTokens;
  }

  if (currentBatchCandidates.length > 0) {
    batches.push({
      batchIndex: batches.length,
      totalBatches: 0,
      candidates: currentBatchCandidates,
      tokenEstimate: currentBatchTokens,
    });
  }

  const totalBatches = batches.length;
  for (const batch of batches) {
    batch.totalBatches = totalBatches;
  }

  return batches;
}

// ─── 分页 Cursor ────────────────────────────────────────────────────────────

/** 分页 cursor，用于崩溃恢复 */
export interface PaginationCursor {
  /** 当前页/批索引 */
  currentIndex: number;
  /** 总页/批数 */
  totalPages: number;
  /** 已完成的页/批索引集合 */
  completedIndices: number[];
}

/** 从 cursor 恢复：返回下一个需要处理的页/批索引 */
export function getNextPageFromCursor(cursor: PaginationCursor): number | null {
  if (cursor.currentIndex >= cursor.totalPages) {
    return null;
  }
  return cursor.currentIndex;
}

/** 更新 cursor：标记当前页为已完成 */
export function markPageCompleted(cursor: PaginationCursor, pageIndex: number): PaginationCursor {
  return {
    ...cursor,
    currentIndex: pageIndex + 1,
    completedIndices: [...cursor.completedIndices, pageIndex].sort((a, b) => a - b),
  };
}

// ─── InputOverContextError 检测 ──────────────────────────────────────────────

/**
 * 检测错误是否为 InputOverContextError。
 *
 * 由于 InputOverContextError 在不同模块中可能被包装，
 * 通过 error code 或 name 进行检测。
 */
export function isInputOverContextError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "InputOverContextError" ||
      (err as unknown as Record<string, unknown>).code === "input_over_context";
  }
  return false;
}

/**
 * 检测 Extractor/Composer/Critic 返回的 error 字符串是否表示 input_over_context。
 */
export function isInputOverContextErrorMessage(error: string | undefined): boolean {
  if (!error) return false;
  return error.includes("input_over_context") || error.includes("超出 contextWindow");
}
