/**
 * 证据重排序服务层（SiliconFlow BAAI/bge-reranker-v2-m3）
 *
 * 独立于证据工具，解耦 rerank 调用与检索逻辑。
 * search_related_evidence 在向量+词法合并出候选后调用本层做精排。
 *
 * 不变量（G8）：
 * - rerank 是派生增强，失败/不可用时降级到原序，不改变检索正确性
 * - coverage 和发布资格不得因 rerank 失败而下降
 */

import { logger } from "../lib/logger.ts";

/** 单个待重排候选 */
export interface RerankCandidate {
  /** 证据 ID（opaque evidence refId） */
  evidenceRefId: string;
  /** 候选文本 */
  text: string;
}

/** 重排后结果 */
export interface RerankedResult {
  /** 证据 ID */
  evidenceRefId: string;
  /** 相关性分数（0-1） */
  relevanceScore: number;
}

/** Rerank provider 接口（由 SiliconFlowProvider 等实现） */
export interface RerankProvider {
  rerank(
    params: { query: string; documents: string[]; topN?: number },
    signal?: AbortSignal,
  ): Promise<Array<{ index: number; relevanceScore: number }>>;
}

/** rerank 服务层入参 */
export interface RerankEvidenceInput {
  /** 查询文本（已脱敏） */
  query: string;
  /** 待重排候选 */
  candidates: RerankCandidate[];
  /** 期望返回条数 */
  topN: number;
  /** rerank provider；null 表示未配置，直接降级 */
  provider: RerankProvider | null;
  signal?: AbortSignal;
}

/** rerank 服务层出参 */
export interface RerankEvidenceOutput {
  /** 按 relevanceScore 降序的 evidenceRefId 列表 */
  reranked: string[];
  /** 是否发生了降级（provider 缺失或调用失败） */
  degraded: boolean;
  /** 降级原因（degraded=true 时有值） */
  degradationReason: string | null;
}

/** rerank 触发的最小候选数，避免对单条结果做无意义调用 */
const MIN_RERANK_CANDIDATES = 2;

/**
 * 对候选证据执行 rerank 精排。
 *
 * provider 缺失、候选不足或调用失败时降级为原序（G8）。
 */
export async function rerankEvidenceCandidates(
  input: RerankEvidenceInput,
): Promise<RerankEvidenceOutput> {
  const { query, candidates, topN, provider, signal } = input;

  // 候选不足或未配置 provider → 直接降级
  if (candidates.length < MIN_RERANK_CANDIDATES) {
    return {
      reranked: candidates.map((c) => c.evidenceRefId),
      degraded: true,
      degradationReason: "not_enough_candidates",
    };
  }
  if (!provider) {
    return {
      reranked: candidates.map((c) => c.evidenceRefId),
      degraded: true,
      degradationReason: "rerank_provider_unavailable",
    };
  }

  try {
    const result = await provider.rerank(
      {
        query,
        documents: candidates.map((c) => c.text),
        topN,
      },
      signal,
    );

    // 按 provider 返回的顺序映射回 evidenceRefId；未返回的候选补到尾部保持不丢
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const r of result) {
      const candidate = candidates[r.index];
      if (candidate && !seen.has(candidate.evidenceRefId)) {
        seen.add(candidate.evidenceRefId);
        ordered.push(candidate.evidenceRefId);
      }
    }
    for (const c of candidates) {
      if (!seen.has(c.evidenceRefId)) {
        seen.add(c.evidenceRefId);
        ordered.push(c.evidenceRefId);
      }
    }

    return {
      reranked: ordered,
      degraded: false,
      degradationReason: null,
    };
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), candidateCount: candidates.length },
      "rerankEvidenceCandidates: rerank 失败，降级到原序",
    );
    return {
      reranked: candidates.map((c) => c.evidenceRefId),
      degraded: true,
      degradationReason: "rerank_failed",
    };
  }
}
