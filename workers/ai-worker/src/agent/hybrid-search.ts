/**
 * 向量+词法混合检索与降级（计划 §7.4, §W3）
 *
 * 职责：
 * - 向量 cosine search（pgvector）
 * - 三元组 lexical search（trigram）
 * - 顺序 manifest + lexical search（回退）
 * - 混合模式（hybrid）
 * - 索引缺失/过期/失败时降级到顺序+词法，不影响 coverage
 *
 * 不变量（G8, §7.4）：
 * - Embedding 必须绑定 source hash、model revision 和 profile
 * - 索引为 stale/failed/unavailable 时回退到顺序 manifest + lexical search
 * - coverage 和发布资格不得因向量失败而下降
 * - 向量召回永远不作为 coverage 分母
 * - search_related_evidence 返回 retrieval mode、index coverage 和 exact evidence IDs
 */

import type {
  SearchResult,
  RetrievalMode,
} from "@ailearn/shared";
import { EMBEDDING_DIMENSIONS, EMBEDDING_PROFILE_VERSION } from "@ailearn/shared";

/** 混合搜索请求 */
export interface HybridSearchRequest {
  /** 工作区 ID */
  workspaceId: string;
  /** noteVersion ID */
  noteVersionId: string;
  /** 查询文本 */
  query: string;
  /** 返回 topK 结果 */
  topK: number;
  /** 过滤条件 */
  filters?: SearchFilters;
}

/** 搜索过滤条件 */
export interface SearchFilters {
  /** 限制在特定 section 内 */
  sectionPath?: string[];
  /** 限制证据类型 */
  evidenceKind?: "text_span" | "image_evidence" | "all";
  /** 限制 bundle 范围 */
  bundleIds?: string[];
}

/** 混合搜索结果 */
export interface HybridSearchResult {
  /** 搜索结果 */
  results: SearchResult[];
  /** 实际使用的检索模式 */
  retrievalMode: RetrievalMode;
  /** 索引覆盖率（0-1） */
  indexCoverage: number;
  /** 是否发生了降级 */
  degraded: boolean;
  /** 降级原因（如果发生） */
  degradationReason: string | null;
}

/** 向量搜索执行器接口 */
export interface VectorSearchExecutor {
  /**
   * 执行向量 cosine search。
   * 返回 null 表示索引不可用或查询失败。
   */
  search(
    workspaceId: string,
    noteVersionId: string,
    queryEmbedding: number[],
    topK: number,
    filters?: SearchFilters,
  ): Promise<VectorSearchOutput | null>;
}

/** 向量搜索输出 */
export interface VectorSearchOutput {
  results: Array<{
    evidenceRefId: string;
    score: number;
    sectionPath: string[];
  }>;
  /** 索引覆盖率 */
  indexCoverage: number;
}

/** 词法搜索执行器接口 */
export interface LexicalSearchExecutor {
  /**
   * 执行 trigram 词法搜索。
   */
  search(
    workspaceId: string,
    noteVersionId: string,
    query: string,
    topK: number,
    filters?: SearchFilters,
  ): Promise<LexicalSearchOutput>;
}

/** 词法搜索输出 */
export interface LexicalSearchOutput {
  results: Array<{
    evidenceRefId: string;
    score: number;
    sectionPath: string[];
  }>;
}

/** 顺序 manifest 搜索执行器接口 */
export interface SequentialSearchExecutor {
  /**
   * 按 source/block 顺序搜索。
   * 这是最可靠的回退方式，不依赖任何索引。
   */
  search(
    workspaceId: string,
    noteVersionId: string,
    query: string,
    topK: number,
    filters?: SearchFilters,
  ): Promise<SequentialSearchOutput>;
}

/** 顺序搜索输出 */
export interface SequentialSearchOutput {
  results: Array<{
    evidenceRefId: string;
    score: number;
    sectionPath: string[];
  }>;
}

/** Embedding provider 接口 */
export interface EmbeddingProvider {
  /**
   * 生成文本的 embedding 向量。
   * 返回 null 表示 provider 不可用。
   */
  embed(text: string): Promise<number[] | null>;

  /** provider 标识 */
  readonly id: string;
  /** model 标识 */
  readonly modelId: string;
  /** model revision */
  readonly modelRevision: string;
}

/**
 * 混合搜索引擎。
 *
 * 优先级（计划 §7.4）：
 * 1. 向量 cosine search（需要 embedding + pgvector）
 * 2. trigram lexical search（回退）
 * 3. 顺序 manifest + lexical search（最终回退）
 * 4. hybrid：向量 + 词法合并
 *
 * 索引为 stale/failed/unavailable 时使用 section/source order、trigram 和顺序 ledger。
 * 向量失败不能导致任何 required bundle 被跳过（G8）。
 */
export class HybridSearchEngine {
  private readonly vectorExecutor: VectorSearchExecutor | null;
  private readonly lexicalExecutor: LexicalSearchExecutor | null;
  private readonly sequentialExecutor: SequentialSearchExecutor;
  private readonly embeddingProvider: EmbeddingProvider | null;
  private readonly preferredMode: RetrievalMode;

  constructor(config: {
    vectorExecutor?: VectorSearchExecutor | null;
    lexicalExecutor?: LexicalSearchExecutor | null;
    sequentialExecutor: SequentialSearchExecutor;
    embeddingProvider?: EmbeddingProvider | null;
    preferredMode?: RetrievalMode;
  }) {
    this.vectorExecutor = config.vectorExecutor ?? null;
    this.lexicalExecutor = config.lexicalExecutor ?? null;
    this.sequentialExecutor = config.sequentialExecutor;
    this.embeddingProvider = config.embeddingProvider ?? null;
    this.preferredMode = config.preferredMode ?? "hybrid";
  }

  /**
   * 执行混合搜索。
   *
   * 自动降级策略（G8）：
   * - preferredMode = hybrid: 先尝试向量，再尝试词法，合并结果
   * - preferredMode = vector: 只用向量，失败则降级
   * - preferredMode = trigram: 只用词法
   * - preferredMode = sequential: 只用顺序
   *
   * 任何降级都不影响 coverage 和发布资格。
   */
  async search(request: HybridSearchRequest): Promise<HybridSearchResult> {
    const { workspaceId, noteVersionId, query, topK, filters } = request;

    // 根据首选模式选择策略
    if (this.preferredMode === "sequential") {
      return this.searchSequential(workspaceId, noteVersionId, query, topK, filters);
    }

    if (this.preferredMode === "trigram") {
      return this.searchLexical(workspaceId, noteVersionId, query, topK, filters);
    }

    // hybrid 或 vector：先尝试向量
    const vectorResult = await this.tryVectorSearch(workspaceId, noteVersionId, query, topK, filters);

    if (this.preferredMode === "vector") {
      if (vectorResult) {
        return vectorResult;
      }
      // 向量失败，降级到词法
      return this.searchLexical(workspaceId, noteVersionId, query, topK, filters, "vector_unavailable");
    }

    // hybrid：向量 + 词法合并
    // R53: 当向量不可用时，传递降级原因给词法搜索，确保结果标记为 degraded
    const vectorDegraded = !vectorResult || vectorResult.degraded;
    const lexicalResult = vectorDegraded
      ? await this.searchLexical(workspaceId, noteVersionId, query, topK, filters, "vector_unavailable")
      : await this.searchLexical(workspaceId, noteVersionId, query, topK, filters);

    if (vectorResult && !vectorResult.degraded) {
      // 合并向量和词法结果
      const merged = mergeSearchResults(
        vectorResult.results,
        lexicalResult.results,
        topK,
      );
      return {
        results: merged,
        retrievalMode: "hybrid",
        indexCoverage: vectorResult.indexCoverage,
        degraded: false,
        degradationReason: null,
      };
    }

    // 向量不可用，只返回词法结果（已标记为降级）
    return lexicalResult;
  }

  /**
   * 尝试向量搜索。
   * 返回 null 表示不可用。
   */
  private async tryVectorSearch(
    workspaceId: string,
    noteVersionId: string,
    query: string,
    topK: number,
    filters?: SearchFilters,
  ): Promise<HybridSearchResult | null> {
    if (!this.vectorExecutor || !this.embeddingProvider) {
      return null;
    }

    try {
      // 生成查询 embedding
      const queryEmbedding = await this.embeddingProvider.embed(query);
      if (!queryEmbedding || queryEmbedding.length !== EMBEDDING_DIMENSIONS) {
        return null;
      }

      const output = await this.vectorExecutor.search(
        workspaceId,
        noteVersionId,
        queryEmbedding,
        topK,
        filters,
      );

      if (!output || output.results.length === 0) {
        return null;
      }

      return {
        results: output.results.map((r) => ({
          evidenceRefId: r.evidenceRefId,
          retrievalMode: "vector" as const,
          score: r.score,
          sectionPath: r.sectionPath,
        })),
        retrievalMode: "vector",
        indexCoverage: output.indexCoverage,
        degraded: false,
        degradationReason: null,
      };
    } catch {
      // 向量搜索失败，返回 null 触发降级
      return null;
    }
  }

  /**
   * 词法搜索（trigram）。
   */
  private async searchLexical(
    workspaceId: string,
    noteVersionId: string,
    query: string,
    topK: number,
    filters?: SearchFilters,
    degradationReason: string | null = null,
  ): Promise<HybridSearchResult> {
    if (!this.lexicalExecutor) {
      // 词法也不可用，降级到顺序
      return this.searchSequential(
        workspaceId,
        noteVersionId,
        query,
        topK,
        filters,
        degradationReason ?? "lexical_unavailable",
      );
    }

    try {
      const output = await this.lexicalExecutor.search(
        workspaceId,
        noteVersionId,
        query,
        topK,
        filters,
      );

      return {
        results: output.results.map((r) => ({
          evidenceRefId: r.evidenceRefId,
          retrievalMode: "trigram" as const,
          score: r.score,
          sectionPath: r.sectionPath,
        })),
        retrievalMode: "trigram",
        indexCoverage: 0,
        degraded: degradationReason !== null,
        degradationReason,
      };
    } catch {
      return this.searchSequential(
        workspaceId,
        noteVersionId,
        query,
        topK,
        filters,
        "lexical_failed",
      );
    }
  }

  /**
   * 顺序搜索（最终回退）。
   *
   * 这是最可靠的方式，不依赖任何索引（G8）。
   */
  private async searchSequential(
    workspaceId: string,
    noteVersionId: string,
    query: string,
    topK: number,
    filters?: SearchFilters,
    degradationReason: string | null = null,
  ): Promise<HybridSearchResult> {
    const output = await this.sequentialExecutor.search(
      workspaceId,
      noteVersionId,
      query,
      topK,
      filters,
    );

    return {
      results: output.results.map((r) => ({
        evidenceRefId: r.evidenceRefId,
        retrievalMode: "sequential" as const,
        score: r.score,
        sectionPath: r.sectionPath,
      })),
      retrievalMode: "sequential",
      indexCoverage: 0,
      degraded: true,
      degradationReason: degradationReason ?? "no_vector_index",
    };
  }
}

/**
 * 合并向量和词法搜索结果。
 *
 * 使用 reciprocal rank fusion (RRF) 算法。
 */
function mergeSearchResults(
  vectorResults: SearchResult[],
  lexicalResults: SearchResult[],
  topK: number,
): SearchResult[] {
  const RRF_K = 60; // RRF 常数

  const scores = new Map<string, { score: number; result: SearchResult }>();

  // 向量结果排名
  vectorResults.forEach((r, i) => {
    const rankScore = 1 / (RRF_K + i + 1);
    const existing = scores.get(r.evidenceRefId);
    if (existing) {
      existing.score += rankScore;
    } else {
      scores.set(r.evidenceRefId, { score: rankScore, result: { ...r, retrievalMode: "hybrid" } });
    }
  });

  // 词法结果排名
  lexicalResults.forEach((r, i) => {
    const rankScore = 1 / (RRF_K + i + 1);
    const existing = scores.get(r.evidenceRefId);
    if (existing) {
      existing.score += rankScore;
    } else {
      scores.set(r.evidenceRefId, { score: rankScore, result: { ...r, retrievalMode: "hybrid" } });
    }
  });

  // 按合并分数排序
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((entry) => ({
      ...entry.result,
      score: Math.min(1, entry.score), // 归一化到 0-1
    }));
}

/**
 * 检查 embedding 是否需要更新。
 *
 * 不变量（G8）：
 * - Embedding 必须绑定 source hash、model revision 和 profile
 * - source hash 变化时需要重新生成
 * - model revision 变化时需要重新生成
 * - profile version 变化时需要重新生成
 */
export function isEmbeddingStale(params: {
  currentSourceHash: string;
  embeddingSourceHash: string;
  currentModelRevision: string;
  embeddingModelRevision: string;
  currentProfileVersion: string;
  embeddingProfileVersion: string;
}): boolean {
  return (
    params.currentSourceHash !== params.embeddingSourceHash ||
    params.currentModelRevision !== params.embeddingModelRevision ||
    params.currentProfileVersion !== params.embeddingProfileVersion
  );
}

/**
 * 获取默认的 embedding profile 信息。
 */
export function getDefaultEmbeddingProfile(): {
  dimensions: number;
  profileVersion: string;
} {
  return {
    dimensions: EMBEDDING_DIMENSIONS,
    profileVersion: EMBEDDING_PROFILE_VERSION,
  };
}
