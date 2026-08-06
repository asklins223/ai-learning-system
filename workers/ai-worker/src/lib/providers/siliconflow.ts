/**
 * SiliconFlow Provider（BAAI/bge-m3 嵌入向量 + BAAI/bge-reranker-v2-m3 重排序）
 *
 * SiliconFlow 的 `/v1/embeddings` 与 OpenAI 兼容格式一致（model/input/encoding_format），
 * `/v1/rerank` 是独立格式（model/query/documents/top_n）。
 *
 * 本 Provider 只实现 embedding 和 rerank 两种能力，不实现文本生成：
 * 文本/视觉主 provider 仍由 AI_PROVIDER_AGENT_TURN 决定（如 openai_compatible）。
 * 这符合设计文档 §7.4 的 "Embedding Provider 与生成 Provider 分开配置"。
 *
 * 环境变量：
 *   SILICONFLOW_API_KEY             必需
 *   SILICONFLOW_BASE_URL            默认 https://api.siliconflow.cn/v1
 *   SILICONFLOW_EMBEDDING_MODEL     默认 BAAI/bge-m3
 *   SILICONFLOW_RERANK_MODEL        默认 BAAI/bge-reranker-v2-m3
 *
 * 降级契约：embed() 失败返回 null（上游 HybridSearchEngine 自动降级到 lexical/sequential），
 * rerank() 失败抛出或返回空结果，由 reranker.ts 服务层降级到原序。
 */

import type { PublicJsonRequester } from "@ailearn/shared/public-json-http";
import { postJsonToPublicEndpoint } from "@ailearn/shared/public-json-http";
import { logger } from "../../lib/logger.ts";
import type { EmbeddingProviderLike } from "../ai-provider.ts";

/** SiliconFlow rerank 单条结果 */
export interface SiliconFlowRerankResult {
  /** 原始 documents 数组中的索引 */
  index: number;
  /** 相关性分数（0-1） */
  relevanceScore: number;
}

/** SiliconFlow provider 构造选项 */
export interface SiliconFlowProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  embeddingModel?: string;
  rerankModel?: string;
  request?: PublicJsonRequester;
}

/** 归一化 baseUrl，去掉尾部斜杠 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * SiliconFlow Provider。
 *
 * 实现 EmbeddingProviderLike 接口（embed），并额外提供 rerank。
 */
export class SiliconFlowProvider implements EmbeddingProviderLike {
  id = "siliconflow";
  readonly embeddingModelId: string;
  readonly rerankModelId: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly request: PublicJsonRequester;

  constructor(options: SiliconFlowProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.SILICONFLOW_API_KEY;
    if (!apiKey) {
      throw new Error("SILICONFLOW_API_KEY is required for SiliconFlowProvider");
    }
    this.apiKey = apiKey;
    this.embeddingModelId = options.embeddingModel
      ?? process.env.SILICONFLOW_EMBEDDING_MODEL
      ?? "BAAI/bge-m3";
    this.rerankModelId = options.rerankModel
      ?? process.env.SILICONFLOW_RERANK_MODEL
      ?? "BAAI/bge-reranker-v2-m3";
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl
        ?? process.env.SILICONFLOW_BASE_URL
        ?? "https://api.siliconflow.cn/v1",
    );
    this.request = options.request ?? postJsonToPublicEndpoint;
  }

  /** 生成文本 embedding 向量。失败返回 null 触发上游降级。 */
  async embed(text: string, signal?: AbortSignal): Promise<number[] | null> {
    try {
      const response = await this.request(
        `${this.baseUrl}/embeddings`,
        {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        {
          model: this.embeddingModelId,
          // 保守字符上限：CJK 约 1 token ≈ 1.5 chars，1500 chars ≈ 1000-1500 tokens，
          // 安全落在 bge-m3 的 8192 token 上限内。
          input: [text.slice(0, 1500)],
          encoding_format: "float",
        },
        signal,
      );

      if (response.status < 200 || response.status >= 300) {
        logger.warn(
          { status: response.status, statusText: response.statusText, model: this.embeddingModelId },
          "SiliconFlow embedding request failed — falling back to null (lexical search)",
        );
        return null;
      }

      const body = response.body as Record<string, unknown>;
      const data = (body?.data as Array<Record<string, unknown>>) ?? [];
      const embedding = data[0]?.embedding;
      if (!Array.isArray(embedding)) return null;
      return embedding as number[];
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err), model: this.embeddingModelId },
        "SiliconFlow embedding threw — falling back to null (lexical search)",
      );
      return null;
    }
  }

  /**
   * 调用 SiliconFlow rerank API 重排 documents。
   *
   * 返回按 relevanceScore 降序排列的结果（含原始 index）。
   * 失败时抛出错误，由调用方（reranker.ts 服务层）降级到原序。
   */
  async rerank(
    params: { query: string; documents: string[]; topN?: number },
    signal?: AbortSignal,
  ): Promise<SiliconFlowRerankResult[]> {
    if (params.documents.length === 0) return [];

    const response = await this.request(
      `${this.baseUrl}/rerank`,
      {
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      {
        model: this.rerankModelId,
        query: params.query,
        documents: params.documents,
        top_n: params.topN ?? params.documents.length,
      },
      signal,
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `SiliconFlow rerank request failed with HTTP ${response.status}: ${response.statusText}`,
      );
    }

    const body = response.body as Record<string, unknown>;
    const results = (body?.results as Array<Record<string, unknown>>) ?? [];
    return results.map((r) => ({
      index: Number(r.index ?? -1),
      relevanceScore: Number(r.relevance_score ?? 0),
    }));
  }
}

// ─── R2: Factory registrations for SiliconFlow ──────────────────────────
// SiliconFlow currently supports embedding + rerank only.
// text_generation will be added in the future via OpenAICompatibleProvider reuse.

import { registerFactory } from "../provider-factory.ts";
import type { CapabilityImpl } from "@ailearn/shared";

registerFactory("siliconflow", "embedding", (config) => {
  const apiKey = config.apiKey ?? process.env.SILICONFLOW_API_KEY;
  if (!apiKey) return null;
  return new SiliconFlowProvider({
    apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.model ? { embeddingModel: config.model } : {}),
  }) as unknown as CapabilityImpl;
});

registerFactory("siliconflow", "rerank", (config) => {
  const apiKey = config.apiKey ?? process.env.SILICONFLOW_API_KEY;
  if (!apiKey) return null;
  return new SiliconFlowProvider({
    apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.model ? { rerankModel: config.model } : {}),
  }) as unknown as CapabilityImpl;
});
