/**
 * Evidence 工具（计划 §6.1, §7.4）
 *
 * Supervisor 工具：
 * - ensure_semantic_index: 异步补齐派生 embedding
 * - search_related_evidence: vector + lexical 关联召回
 *
 * 不变量（G8, §7.4）：
 * - 向量是派生索引，失败不影响 correctness
 * - 返回 exact evidence IDs
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db.ts";
import * as schema from "../../schema/index.ts";
// SEC-25 修复：导入 PII 检测函数，用于在 embedding 查询前脱敏
import { detectAndSanitizePII } from "../../lib/governance.ts";
import { logger } from "../../lib/logger.ts";
import type { ToolCallRequest, ToolCallResult } from "./executor.ts";
import { rerankEvidenceCandidates, type RerankProvider } from "../reranker.ts";
// E1（计划 §2.8）：HybridSearchEngine 接线——feature flag 灰度
import { isHybridSearchEnabled, getHybridSearchMode, type RetrievalMode } from "@ailearn/shared";
import {
  HybridSearchEngine,
  type VectorSearchExecutor,
  type LexicalSearchExecutor,
  type SequentialSearchExecutor,
  type EmbeddingProvider as HybridEmbeddingProvider,
} from "../hybrid-search.ts";

/** Evidence 工具执行器 */
export async function executeEvidenceTool(
  call: ToolCallRequest,
  ctx: EvidenceToolContext,
): Promise<ToolCallResult> {
  switch (call.name) {
    case "ensure_semantic_index":
      return await handleEnsureSemanticIndex(call, ctx);
    case "search_related_evidence":
      return await handleSearchRelatedEvidence(call, ctx);
    default:
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        result: null,
        error: `unknown evidence tool: ${call.name}`,
      };
  }
}

/** Embedding provider 接口（计划 §7.4, §W3） */
export interface EvidenceEmbeddingProvider {
  /** 生成文本的 embedding 向量。返回 null 表示不可用。 */
  embed(text: string, signal?: AbortSignal): Promise<number[] | null>;
  /** provider 标识 */
  readonly id: string;
  /** model 标识 */
  readonly embeddingModelId: string;
}

export interface EvidenceToolContext {
  runId: string;
  workspaceId: string;
  noteVersionId: string;
  agentUnitId: string;
  turnNo: number;
  /** 可选：向量模型，用于生成查询向量进行语义搜索 */
  embeddingProvider?: EvidenceEmbeddingProvider;
  /** 可选：重排序模型（BAAI/bge-reranker-v2-m3），用于精排候选 */
  rerankProvider?: RerankProvider;
}

/** ensure_semantic_index: 标记需要补齐 embedding 的 evidence */
async function handleEnsureSemanticIndex(
  call: ToolCallRequest,
  ctx: EvidenceToolContext,
): Promise<ToolCallResult> {
  const args = call.arguments as { sourceIds: string[] };

  if (!args.sourceIds || args.sourceIds.length === 0) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: "sourceIds 不能为空",
    };
  }

  // 标记 embedding 为 pending（异步处理，不阻塞）
  // BUG-17/PERF-18: 原代码对每个 sourceId 执行独立的 DB 查询（N+1 模式），
  // 且循环变量 _sourceId 未被使用，查询条件不包含 sourceId 过滤，
  // 导致每次查询返回相同结果。改为单次批量查询，用 evidenceSpanId 过滤。
  const existingRows = await db
    .select({
      id: schema.noteEvidenceEmbeddings.id,
      status: schema.noteEvidenceEmbeddings.status,
      evidenceSpanId: schema.noteEvidenceEmbeddings.evidenceSpanId,
    })
    .from(schema.noteEvidenceEmbeddings)
    .where(and(
      eq(schema.noteEvidenceEmbeddings.workspaceId, ctx.workspaceId),
      eq(schema.noteEvidenceEmbeddings.noteVersionId, ctx.noteVersionId),
      inArray(schema.noteEvidenceEmbeddings.evidenceSpanId, args.sourceIds),
    ));

  // BUG-61/88 修复：原代码只计数不写入 DB，导致 ensure_semantic_index 完全无效。
  // 修复：对 stale/failed 的记录更新 status 为 pending，使独立 embedding worker
  // 可以通过查询 status='pending' 的行来重新生成 embedding。
  // 注意：对于不存在的 evidenceSpanId，无法在此处插入新行（缺少 sourceHash 等
  // 必填字段），这些应在 evidence span 创建时由 pipeline 自动创建 embedding 记录。
  const existingMap = new Map(existingRows.map((r) => [r.evidenceSpanId, r]));
  const toUpdate: string[] = [];
  let missing = 0;
  for (const sourceId of args.sourceIds) {
    const existing = existingMap.get(sourceId);
    if (!existing) {
      missing++;
    } else if (existing.status === "stale" || existing.status === "failed") {
      toUpdate.push(existing.id);
    }
  }

  // 批量更新 stale/failed 的记录为 pending
  if (toUpdate.length > 0) {
    await db
      .update(schema.noteEvidenceEmbeddings)
      .set({ status: "pending", updatedAt: new Date() })
      .where(and(
        eq(schema.noteEvidenceEmbeddings.workspaceId, ctx.workspaceId),
        inArray(schema.noteEvidenceEmbeddings.id, toUpdate),
      ));
  }

  const updated = toUpdate.length;

  logger.info(
    { runId: ctx.runId, sourceCount: args.sourceIds.length, updatedCount: updated, missingCount: missing },
    "ensure_semantic_index: 标记完成",
  );

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      requestedCount: args.sourceIds.length,
      updatedCount: updated,
      missingCount: missing,
      mode: "async",
      message: "embedding generation will be processed asynchronously",
    },
  };
}

/** search_related_evidence: 向量 + 词法关联召回（计划 §7.4, G8）
 *
 * 检索策略：
 * 1. 当有 ready 状态的 embedding 时，使用 pgvector cosine 距离搜索
 * 2. 当无 embedding 或向量搜索失败时，回退到顺序 manifest + lexical search
 * 3. 向量失败不能导致任何 required bundle 被跳过（G8）
 *
 * E1（计划 §2.8）：当 HYBRID_SEARCH_ENABLED=true 时，
 * 委托给 HybridSearchEngine 进行 RRF 合并检索。
 * flag 关闭时走原有 simple merge 路径（向后兼容）。
 *
 * 返回 retrieval mode、index coverage 和 exact evidence IDs。
 */
async function handleSearchRelatedEvidence(
  call: ToolCallRequest,
  ctx: EvidenceToolContext,
): Promise<ToolCallResult> {
  // E1: feature flag 开启时委托给 HybridSearchEngine
  if (isHybridSearchEnabled()) {
    return await handleSearchWithHybridEngine(call, ctx);
  }
  return await handleSearchWithSimpleMerge(call, ctx);
}

/**
 * E1（计划 §2.8）：HybridSearchEngine 路径。
 *
 * 创建适配器 executors（复用现有 DB 查询逻辑），
 * 委托给 HybridSearchEngine 进行 RRF 合并。
 * 失败时降级到 simple merge 路径。
 */
async function handleSearchWithHybridEngine(
  call: ToolCallRequest,
  ctx: EvidenceToolContext,
): Promise<ToolCallResult> {
  const args = call.arguments as {
    query: string;
    topK?: number;
    filters?: Record<string, unknown>;
  };
  const topK = Math.min(args.topK ?? 10, 50);
  const piiResult = detectAndSanitizePII(args.query.slice(0, 500));
  const query = piiResult.sanitizedText;

  try {
    // 创建适配器 executors
    const sequentialExecutor: SequentialSearchExecutor = {
      search: async (wsId, nvId, _q, limit) => {
        const rows = await db
          .select({
            id: schema.noteEvidenceSpans.id,
            unitKey: schema.noteEvidenceSpans.unitKey,
            blockId: schema.noteEvidenceSpans.blockId,
            textHash: schema.noteEvidenceSpans.textHash,
            sectionPath: schema.noteEvidenceSpans.sectionPath,
            sourceKind: schema.noteEvidenceSpans.sourceKind,
          })
          .from(schema.noteEvidenceSpans)
          .where(and(
            eq(schema.noteEvidenceSpans.workspaceId, wsId),
            eq(schema.noteEvidenceSpans.noteVersionId, nvId),
          ))
          .limit(limit);
        return {
          results: rows.map((r) => ({
            evidenceRefId: r.id,
            score: 0.5,
            sectionPath: (r.sectionPath as string[]) ?? [],
          })),
        };
      },
    };

    const lexicalExecutor: LexicalSearchExecutor = {
      search: async (wsId, nvId, q, limit) => {
        const rows = await db
          .select({
            id: schema.noteEvidenceSpans.id,
            unitKey: schema.noteEvidenceSpans.unitKey,
            blockId: schema.noteEvidenceSpans.blockId,
            textHash: schema.noteEvidenceSpans.textHash,
            sectionPath: schema.noteEvidenceSpans.sectionPath,
            sourceKind: schema.noteEvidenceSpans.sourceKind,
          })
          .from(schema.noteEvidenceSpans)
          .where(and(
            eq(schema.noteEvidenceSpans.workspaceId, wsId),
            eq(schema.noteEvidenceSpans.noteVersionId, nvId),
            sql`${schema.noteEvidenceSpans.unitKey} ILIKE ${`%${q}%`}`,
          ))
          .limit(limit);
        return {
          results: rows.map((r) => ({
            evidenceRefId: r.id,
            score: 0.7,
            sectionPath: (r.sectionPath as string[]) ?? [],
          })),
        };
      },
    };

    const vectorExecutor: VectorSearchExecutor | null = ctx.embeddingProvider
      ? {
          search: async (wsId, nvId, queryEmbedding, limit) => {
            if (!queryEmbedding || queryEmbedding.length === 0) return null;
            try {
              const queryVec = JSON.stringify(queryEmbedding);
              const vectorRows = await db.execute(sql`
                SELECT
                  e.evidence_span_id,
                  e.image_evidence_unit_id,
                  e.evidence_ref_type,
                  1 - (e.embedding <=> ${queryVec}::vector) AS score
                FROM note_evidence_embeddings e
                WHERE e.workspace_id = ${wsId}
                  AND e.note_version_id = ${nvId}
                  AND e.status = 'ready'
                ORDER BY e.embedding <=> ${queryVec}::vector
                LIMIT ${limit}
              `);
              const rowList = Array.isArray(vectorRows) ? vectorRows : (vectorRows as unknown as { rows?: unknown[] }).rows ?? [];
              const embeddingCount = rowList.length;
              return {
                results: (rowList as Array<Record<string, unknown>>).map((r) => ({
                  evidenceRefId: String(r.evidence_span_id ?? r.image_evidence_unit_id ?? ""),
                  score: Number(r.score ?? 0),
                  sectionPath: [],
                })),
                indexCoverage: embeddingCount > 0 ? 1.0 : 0,
              };
            } catch {
              return null;
            }
          },
        }
      : null;

    const hybridEmbeddingProvider: HybridEmbeddingProvider | null =
      ctx.embeddingProvider
        ? {
            id: ctx.embeddingProvider.id,
            modelId: ctx.embeddingProvider.embeddingModelId,
            modelRevision: "v1",
            embed: async (text: string) => ctx.embeddingProvider!.embed(text),
          }
        : null;

    const engine = new HybridSearchEngine({
      vectorExecutor,
      lexicalExecutor,
      sequentialExecutor,
      embeddingProvider: hybridEmbeddingProvider,
      preferredMode: getHybridSearchMode() as RetrievalMode,
    });

    const result = await engine.search({
      workspaceId: ctx.workspaceId,
      noteVersionId: ctx.noteVersionId,
      query,
      topK,
    });

    logger.info(
      { runId: ctx.runId, query: query.slice(0, 100), retrievalMode: result.retrievalMode, resultCount: result.results.length, degraded: result.degraded },
      "search_related_evidence: HybridSearchEngine 检索完成",
    );

    return {
      toolCallId: call.id,
      toolName: call.name,
      success: true,
      result: {
        retrievalMode: result.retrievalMode,
        reranked: false,
        indexCoverage: result.indexCoverage,
        results: result.results.map((r) => ({
          evidenceRefId: r.evidenceRefId,
          refType: "text_span",
          unitKey: null,
          blockId: null,
          textHash: null,
          sectionPath: r.sectionPath,
          sourceKind: null,
          score: r.score,
        })),
      },
    };
  } catch (err) {
    logger.warn(
      { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
      "search_related_evidence: HybridSearchEngine 失败，降级到 simple merge",
    );
    // 降级到 simple merge 路径
    return await handleSearchWithSimpleMerge(call, ctx);
  }
}

/**
 * 原有 simple merge 路径（feature flag 关闭时使用）。
 * 向量结果优先，词法结果补充，无 RRF 合并。
 */
async function handleSearchWithSimpleMerge(
  call: ToolCallRequest,
  ctx: EvidenceToolContext,
): Promise<ToolCallResult> {
  const args = call.arguments as {
    query: string;
    topK?: number;
    filters?: Record<string, unknown>;
  };

const topK = Math.min(args.topK ?? 10, 50);
// SEC-25 修复：在发送给 embedding provider 之前检测并脱敏 PII，
// 防止笔记中的 PII（邮箱、手机号等）通过 embedding API 请求泄露给外部服务
const piiResult = detectAndSanitizePII(args.query.slice(0, 500));
const query = piiResult.sanitizedText;

  // 检查是否有可用的 embedding 索引
  const embeddingCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.noteEvidenceEmbeddings)
    .where(and(
      eq(schema.noteEvidenceEmbeddings.workspaceId, ctx.workspaceId),
      eq(schema.noteEvidenceEmbeddings.noteVersionId, ctx.noteVersionId),
      eq(schema.noteEvidenceEmbeddings.status, "ready"),
    ));

  const hasVectorIndex = (embeddingCount[0]?.count ?? 0) > 0;

  // 尝试向量 cosine 搜索（如果 embedding 可用且查询向量已生成）
  // W3 实现：当 embeddingProvider 可用时，自动生成查询向量进行语义搜索。
  // 如果 embeddingProvider 不可用或生成失败，回退到 lexical/sequential search。
  // 这符合 G8 的回退策略：向量失败不影响 correctness。
  let vectorResults: Array<{
    evidenceRefId: string;
    refType: string;
    score: number;
    unitKey: string | null;
    blockId: string | null;
    textHash: string | null;
    sectionPath: unknown;
    sourceKind: string | null;
  }> = [];

  if (hasVectorIndex && ctx.embeddingProvider) {
    try {
      // 使用 embedding provider 生成查询向量
      const queryEmbedding = await ctx.embeddingProvider.embed(query);
      if (queryEmbedding && queryEmbedding.length > 0) {
        // pgvector cosine 距离：embedding <=> query_embedding
        // 相似度 = 1 - 距离
        const queryVec = JSON.stringify(queryEmbedding);
        const vectorRows = await db.execute(sql`
          SELECT
            e.evidence_span_id,
            e.image_evidence_unit_id,
            e.evidence_ref_type,
            e.source_hash,
            s.unit_key,
            s.block_id,
            s.text_hash,
            s.section_path,
            s.source_kind,
            1 - (e.embedding <=> ${queryVec}::vector) AS score
          FROM note_evidence_embeddings e
          LEFT JOIN note_evidence_spans s
            ON s.id = e.evidence_span_id
            AND s.workspace_id = e.workspace_id
          WHERE e.workspace_id = ${ctx.workspaceId}
            AND e.note_version_id = ${ctx.noteVersionId}
            AND e.status = 'ready'
          ORDER BY e.embedding <=> ${queryVec}::vector
          LIMIT ${topK}
        `);
        const vectorRowList = Array.isArray(vectorRows) ? vectorRows : (vectorRows as unknown as { rows?: unknown[] }).rows ?? [];
        vectorResults = (vectorRowList as Array<Record<string, unknown>>).map((r) => ({
          evidenceRefId: String(r.evidence_span_id ?? r.image_evidence_unit_id ?? ""),
          refType: String(r.evidence_ref_type ?? "text_span"),
          score: Number(r.score ?? 0),
          unitKey: r.unit_key as string | null,
          blockId: r.block_id as string | null,
          textHash: r.text_hash as string | null,
          sectionPath: r.section_path,
          sourceKind: r.source_kind as string | null,
        }));
      }
    } catch (err) {
      logger.warn(
        { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
        "search_related_evidence: 向量搜索失败，回退到 lexical/sequential",
      );
    }
  }

  // BUG-87 修复：当向量搜索结果已满 topK 时，跳过词法查询，避免不必要的 DB 往返
  let lexicalResults: Array<{
    id: string;
    unitKey: string | null;
    blockId: string | null;
    textHash: string | null;
    sectionPath: unknown;
    sourceKind: string | null;
  }> = [];

  if (vectorResults.length < topK) {
    // 词法回退：从 note_evidence_spans 中按顺序 + ILIKE 搜索
    // 只在向量结果不足时执行，减少不必要的 DB 查询
    const deficit = topK - vectorResults.length;
    lexicalResults = await db
      .select({
        id: schema.noteEvidenceSpans.id,
        unitKey: schema.noteEvidenceSpans.unitKey,
        blockId: schema.noteEvidenceSpans.blockId,
        textHash: schema.noteEvidenceSpans.textHash,
        sectionPath: schema.noteEvidenceSpans.sectionPath,
        sourceKind: schema.noteEvidenceSpans.sourceKind,
      })
      .from(schema.noteEvidenceSpans)
      .where(and(
        eq(schema.noteEvidenceSpans.workspaceId, ctx.workspaceId),
        eq(schema.noteEvidenceSpans.noteVersionId, ctx.noteVersionId),
      ))
      .limit(deficit);
  }

  // 合并结果：优先向量结果，lexical 结果补充
  const seenIds = new Set<string>();
  const allResults: Array<{
    evidenceRefId: string;
    refType: string;
    unitKey: string | null;
    blockId: string | null;
    textHash: string | null;
    sectionPath: unknown;
    sourceKind: string | null;
    score: number;
  }> = [];

  // 添加向量搜索结果
  for (const r of vectorResults) {
    if (!seenIds.has(r.evidenceRefId)) {
      seenIds.add(r.evidenceRefId);
      allResults.push(r);
    }
  }

  // 添加词法搜索结果（补充向量未覆盖的）
  for (const r of lexicalResults) {
    if (!seenIds.has(r.id)) {
      seenIds.add(r.id);
      allResults.push({
        evidenceRefId: r.id,
        refType: "text_span",
        unitKey: r.unitKey,
        blockId: r.blockId,
        textHash: r.textHash,
        sectionPath: r.sectionPath,
        sourceKind: r.sourceKind,
        score: 0, // 词法搜索不产生 score
      });
    }
  }

  // 确定检索模式（计划 §7.4）
  const baseRetrievalMode =
    vectorResults.length > 0
      ? "hybrid"
      : hasVectorIndex
        ? "sequential"
        : "sequential";

  // ─── Rerank 精排（G8：失败降级到原序，不影响 correctness） ───
  // 在向量+词法合并出的候选之上，用 SiliconFlow BAAI/bge-reranker-v2-m3 精排。
  // 需要候选文本：从 note_evidence_spans join note_blocks 恢复（charStart/charEnd）。
  let reranked = false;
  let finalResults = allResults;

  if (ctx.rerankProvider && allResults.length > 1) {
    try {
      const spanIds = allResults
        .filter((r) => r.refType === "text_span" && r.blockId)
        .map((r) => r.evidenceRefId);

      const spanTextRows = spanIds.length > 0
        ? await db
            .select({
              spanId: schema.noteEvidenceSpans.id,
              blockContent: schema.noteBlocks.content,
              charStart: schema.noteEvidenceSpans.charStart,
              charEnd: schema.noteEvidenceSpans.charEnd,
            })
            .from(schema.noteEvidenceSpans)
            .innerJoin(
              schema.noteBlocks,
              eq(schema.noteEvidenceSpans.blockId, schema.noteBlocks.id),
            )
            .where(and(
              eq(schema.noteEvidenceSpans.workspaceId, ctx.workspaceId),
              inArray(schema.noteEvidenceSpans.id, spanIds),
            ))
        : [];

      const textBySpanId = new Map<string, string>();
      for (const row of spanTextRows) {
        const content = row.blockContent ?? "";
        textBySpanId.set(
          row.spanId,
          content.slice(row.charStart ?? 0, row.charEnd ?? content.length),
        );
      }

      const candidates = allResults.map((r) => ({
        evidenceRefId: r.evidenceRefId,
        text: textBySpanId.get(r.evidenceRefId) ?? "",
      }));

      const rerankOutput = await rerankEvidenceCandidates({
        query,
        candidates,
        topN: topK,
        provider: ctx.rerankProvider,
      });

      if (!rerankOutput.degraded) {
        // 按 rerank 顺序重排；未获得文本的候选保留在尾部
        const orderMap = new Map(
          rerankOutput.reranked.map((id, i) => [id, i]),
        );
        const byRef = new Map(allResults.map((r) => [r.evidenceRefId, r]));
        finalResults = allResults
          .map((r) => byRef.get(r.evidenceRefId)!)
          .sort((a, b) => {
            const ia = orderMap.get(a.evidenceRefId) ?? Number.MAX_SAFE_INTEGER;
            const ib = orderMap.get(b.evidenceRefId) ?? Number.MAX_SAFE_INTEGER;
            return ia - ib;
          });
        reranked = true;
      }
    } catch (err) {
      logger.warn(
        { runId: ctx.runId, error: err instanceof Error ? err.message : String(err) },
        "search_related_evidence: rerank 失败，降级到合并序",
      );
    }
  }

  const retrievalMode = reranked ? "hybrid+rerank" : baseRetrievalMode;

  logger.info(
    { runId: ctx.runId, query: query.slice(0, 100), retrievalMode, resultCount: finalResults.length, vectorCount: vectorResults.length, reranked },
    "search_related_evidence: 检索完成",
  );

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      retrievalMode,
      reranked,
      indexCoverage: embeddingCount[0]?.count ?? 0,
      results: finalResults.slice(0, topK).map((r) => ({
        evidenceRefId: r.evidenceRefId,
        refType: r.refType,
        unitKey: r.unitKey,
        blockId: r.blockId,
        textHash: r.textHash,
        sectionPath: r.sectionPath,
        sourceKind: r.sourceKind,
        score: r.score,
      })),
    },
  };
}
