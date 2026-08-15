/**
 * 证据 span 与 source bundle 持久化（计划 §G2, §9.4）
 *
 * QUAL-17 修复：将 card-supervisor-agent.ts 中 190+ 行的 evidence span
 * 持久化逻辑提取为独立模块，降低主 handler 的复杂度，使逻辑可独立测试。
 *
 * 职责：
 * 1. 将 PREPARE 阶段产出的 text_span evidence 插入 note_evidence_spans（幂等）
 * 2. 收集 image_evidence 的 refId → imageEvidenceUnitId 映射
 * 3. 将 bundle plan 插入 card_generation_source_bundles（幂等）
 * 4. 为每个 bundle 插入 primary 和 context_only members（幂等）
 *
 * 不变量：
 * - text_span 插入使用 onConflictDoNothing，重复执行不会报错
 * - bundle 插入使用 onConflictDoNothing，已存在的 bundle 跳过 member 插入
 * - image_evidence 的 refId 格式为 "image:${unitId}"，直接映射到已存在的 unit
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, type WorkerTransaction } from "../db.ts";
import * as schema from "../schema/index.ts";
import { PLANNER_VERSION, EMBEDDING_DIMENSIONS, EMBEDDING_PROFILE_VERSION } from "@ailearn/shared";
import type { PlannableEvidence, BundlePlanResult } from "./bundle-planner.ts";
import { logger } from "../lib/logger.ts";

/**
 * RLS 执行器：worker 侧所有带 workspace 写路径必须在 workspace 事务上下文
 * （withWorkerWorkspaceTransaction 的同一连接）内执行——全局 db 连接池上的
 * 其它连接没有 app.workspace_id，插入会被 RLS 拒绝。
 */
type EvidenceClient = typeof db | WorkerTransaction;

/** refId 到 spanId/imageEvidenceUnitId 的映射 */
export interface EvidenceRefMap {
  /** text_span 的 refId → note_evidence_spans.id */
  refIdToSpanId: Map<string, string>;
  /** image_evidence 的 refId → note_image_evidence_units.id */
  refIdToImageEvidenceId: Map<string, string>;
}

/**
 * 持久化 evidence spans 和 source bundles 到数据库。
 *
 * 此函数封装了原先散布在 card-supervisor-agent.ts 中的 190+ 行持久化逻辑，
 * 包括 text_span 插入（含幂等回查）、image_evidence 映射、source bundle 插入
 * 和 bundle member 插入（primary + context_only）。
 *
 * @param params - 持久化参数
 * @returns refId 映射，供后续 Extractor/Critic 加载证据时使用
 */
export async function persistEvidenceAndBundles(params: {
  /** 工作区 ID */
  workspaceId: string;
  /** 运行 ID */
  runId: string;
  /** noteVersion ID */
  noteVersionId: string;
  /** PREPARE 阶段产出的 evidence 列表 */
  evidence: PlannableEvidence[];
  /** PREPARE 阶段产出的 bundle plan */
  bundlePlan: BundlePlanResult;
  /** 创建时间戳 */
  now: Date;
  /** RLS 执行器：workspace 事务上下文内传入 tx；否则用全局 db。 */
  client?: EvidenceClient;
}): Promise<EvidenceRefMap> {
  const { workspaceId, runId, noteVersionId, evidence, bundlePlan, now } = params;
  const client = params.client ?? db;
  const refIdToSpanId = new Map<string, string>();
  const refIdToImageEvidenceId = new Map<string, string>();

  // ── 1. 持久化 text_span evidence（幂等）──
  let spanOrdinal = 0;
  for (const ev of evidence) {
    if (ev.kind === "text_span") {
      const unitKey = ev.refId;
      const [inserted] = await client
        .insert(schema.noteEvidenceSpans)
        .values({
          workspaceId,
          noteVersionId,
          blockId: ev.blockId,
          unitKey,
          plannerVersion: PLANNER_VERSION,
          ordinal: spanOrdinal++,
          charStart: ev.charStart,
          charEnd: ev.charEnd,
          textHash: ev.sourceHash,
          sectionPath: ev.sectionPath ?? [],
          sourceKind: "text_span",
          tokenEstimate: ev.tokenEstimate,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted) {
        refIdToSpanId.set(ev.refId, inserted.id);
      } else {
        // 幂等命中：查询已有 span
        const [existing] = await client
          .select({ id: schema.noteEvidenceSpans.id })
          .from(schema.noteEvidenceSpans)
          .where(and(
            eq(schema.noteEvidenceSpans.workspaceId, workspaceId),
            eq(schema.noteEvidenceSpans.noteVersionId, noteVersionId),
            eq(schema.noteEvidenceSpans.unitKey, unitKey),
          ))
          .limit(1);
        if (existing) {
          refIdToSpanId.set(ev.refId, existing.id);
        }
      }
    } else if (ev.kind === "image_evidence") {
      // image evidence 的 refId 格式为 "image:${img.id}"
      const imageId = ev.refId.replace(/^image:/, "");
      if (imageId) {
        refIdToImageEvidenceId.set(ev.refId, imageId);
      }
    }
  }

  // ── 2. 持久化 source bundles 和 bundle members（幂等）──
  for (const bundle of bundlePlan.bundles) {
    const [bundleRow] = await client.insert(schema.cardGenerationSourceBundles).values({
      workspaceId,
      runId,
      noteVersionId,
      bundleKey: bundle.bundleId,
      bundleOrdinal: bundle.ordinal,
      sectionPath: bundle.sectionPath ?? [],
      sourceStartOrdinal: bundle.sourceStartOrdinal ?? 0,
      tokenEstimate: bundle.tokenEstimate ?? 0,
      inputHash: bundle.inputHash ?? "",
      required: bundle.required ?? true,
      assignmentStatus: "pending",
      decisionStatus: "pending",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning();

    if (!bundleRow) {
      // 幂等命中：跳过 member 插入（已存在）
      continue;
    }

    // 插入 primary members
    for (let mi = 0; mi < bundle.memberEvidenceIds.length; mi++) {
      const refId = bundle.memberEvidenceIds[mi]!;
      await insertBundleMember({
        workspaceId,
        runId,
        bundleId: bundleRow.id,
        memberOrdinal: mi,
        refId,
        membership: "primary",
        refIdToSpanId,
        refIdToImageEvidenceId,
        now,
        client,
      });
    }

    // 插入 context_only members
    const primaryCount = bundle.memberEvidenceIds.length;
    for (let ci = 0; ci < bundle.contextEvidenceIds.length; ci++) {
      const refId = bundle.contextEvidenceIds[ci]!;
      await insertBundleMember({
        workspaceId,
        runId,
        bundleId: bundleRow.id,
        memberOrdinal: primaryCount + ci,
        refId,
        membership: "context_only",
        refIdToSpanId,
        refIdToImageEvidenceId,
        now,
        client,
      });
    }
  }

  return { refIdToSpanId, refIdToImageEvidenceId };
}

/**
 * 插入单个 bundle member（text_span 或 image_evidence），幂等。
 * 根据 refId 在映射中查找对应的 spanId 或 imageEvidenceId。
 */
async function insertBundleMember(params: {
  workspaceId: string;
  runId: string;
  bundleId: string;
  memberOrdinal: number;
  refId: string;
  membership: "primary" | "context_only";
  refIdToSpanId: Map<string, string>;
  refIdToImageEvidenceId: Map<string, string>;
  now: Date;
  client: EvidenceClient;
}): Promise<void> {
  const { workspaceId, runId, bundleId, memberOrdinal, refId, membership,
    refIdToSpanId, refIdToImageEvidenceId, now, client } = params;

  const spanId = refIdToSpanId.get(refId);
  const imageEvidenceId = refIdToImageEvidenceId.get(refId);

  if (spanId) {
    await client.insert(schema.cardGenerationSourceBundleMembers).values({
      workspaceId,
      runId,
      bundleId,
      memberOrdinal,
      evidenceRefType: "text_span",
      evidenceSpanId: spanId,
      membership,
      createdAt: now,
    }).onConflictDoNothing();
  } else if (imageEvidenceId) {
    await client.insert(schema.cardGenerationSourceBundleMembers).values({
      workspaceId,
      runId,
      bundleId,
      memberOrdinal,
      evidenceRefType: "image_evidence",
      imageEvidenceUnitId: imageEvidenceId,
      membership,
      createdAt: now,
    }).onConflictDoNothing();
  }
}

/** Embedding provider 接口（与 EvidenceEmbeddingProvider 对齐） */
export interface EvidenceEmbeddingGenerator {
  /** 生成文本的 embedding 向量。返回 null 表示不可用或失败。 */
  embed(text: string, signal?: AbortSignal): Promise<number[] | null>;
  /** provider 标识 */
  readonly id: string;
  /** model 标识 */
  readonly embeddingModelId: string;
}

/**
 * 为 PREPARE 阶段产出的 text_span evidence 生成 embedding 并写入派生索引。
 *
 * G8 不变量：embedding 是派生索引，失败/缺失不影响 coverage 和发布资格。
 * 此函数任何异常都会被捕获并记为 warn，不向上抛。
 *
 * 幂等：note_evidence_embeddings 已存在（evidenceSpanId + modelRevision）时跳过。
 * 图片证据（image_evidence）不生成向量——bge-m3 是文本模型，图片走 image insight OCR 文本。
 */
export async function persistEvidenceEmbeddings(params: {
  workspaceId: string;
  runId: string;
  noteVersionId: string;
  evidence: PlannableEvidence[];
  /** refId → spanId 映射（persistEvidenceAndBundles 的返回值） */
  refIdToSpanId: Map<string, string>;
  provider: EvidenceEmbeddingGenerator | null;
  now: Date;
  /** RLS 执行器：workspace 事务上下文内传入 tx；否则用全局 db。 */
  client?: EvidenceClient;
}): Promise<void> {
  const { workspaceId, runId, noteVersionId, evidence, refIdToSpanId, provider, now } = params;
  const client = params.client ?? db;

  // 无 provider（未配置 AI_PROVIDER_EMBEDDING 或创建失败）→ 跳过，不阻断 run
  if (!provider) {
    logger.debug(
      { runId, noteVersionId },
      "persistEvidenceEmbeddings: 未配置 embedding provider，跳过派生索引生成",
    );
    return;
  }

  // 只处理 text_span（图片证据不生成向量）
  const spanEvidence = evidence.filter((ev) => ev.kind === "text_span");
  if (spanEvidence.length === 0) {
    logger.debug({ runId }, "persistEvidenceEmbeddings: 无 text_span evidence，跳过");
    return;
  }

  // 过滤出已持久化且能拿到 spanId 的 evidence
  const toEmbed = spanEvidence
    .map((ev) => ({ ev, spanId: refIdToSpanId.get(ev.refId) }))
    .filter((item): item is { ev: PlannableEvidence; spanId: string } => !!item.spanId);

  if (toEmbed.length === 0) {
    logger.warn(
      { runId, evidenceCount: spanEvidence.length },
      "persistEvidenceEmbeddings: evidence span 未持久化，跳过 embedding",
    );
    return;
  }

  const modelRevision = provider.embeddingModelId;
  const inputHash = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");

  // 批量生成（每批 20），避免并发打爆 embedding API 速率限制
  const BATCH_SIZE = 20;
  let generatedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);

    // 检查哪些 span 已有 ready 的 embedding（幂等跳过）
    const spanIds = batch.map((item) => item.spanId);
    const existing = await db
      .select({ evidenceSpanId: schema.noteEvidenceEmbeddings.evidenceSpanId })
      .from(schema.noteEvidenceEmbeddings)
      .where(and(
        eq(schema.noteEvidenceEmbeddings.workspaceId, workspaceId),
        eq(schema.noteEvidenceEmbeddings.noteVersionId, noteVersionId),
        eq(schema.noteEvidenceEmbeddings.status, "ready"),
        inArray(schema.noteEvidenceEmbeddings.evidenceSpanId, spanIds),
      ));

    const existingSpanIds = new Set(
      existing.map((r) => r.evidenceSpanId).filter((id): id is string => id !== null),
    );

    const values: Array<{
      workspaceId: string;
      noteVersionId: string;
      evidenceRefType: string;
      evidenceSpanId: string;
      sourceHash: string;
      inputHash: string;
      modelRevision: string;
      dimensions: number;
      embedding: unknown;
      profileVersion: string;
      status: string;
    }> = [];

    for (const item of batch) {
      if (existingSpanIds.has(item.spanId)) {
        skippedCount++;
        continue;
      }
      const vec = await provider.embed(item.ev.text);
      if (!vec || vec.length === 0) {
        failedCount++;
        continue;
      }
      values.push({
        workspaceId,
        noteVersionId,
        evidenceRefType: "text_span",
        evidenceSpanId: item.spanId,
        sourceHash: item.ev.sourceHash,
        inputHash: inputHash(item.ev.text),
        modelRevision,
        dimensions: EMBEDDING_DIMENSIONS,
        embedding: vec,
        profileVersion: EMBEDDING_PROFILE_VERSION,
        status: "ready",
      });
    }

    if (values.length > 0) {
      // embedding 列是 vector(1024)，Drizzle schema 中为 jsonb 占位。
      // 用 sql cast 写入 pgvector 类型。
      // BUG-104 修复：createdAt/updatedAt 必须传 ISO 字符串而非 Date 对象。
      // drizzle 的 sql 模板把 Date 参数原样交给 postgres.js，触发
      // "string argument must be type string... Received Date"。用
      // toISOString() 序列化后参数化插入成功。
      const ts = now.toISOString();
      for (const v of values) {
        await client.execute(sql`
          INSERT INTO note_evidence_embeddings (
            id, workspace_id, note_version_id, evidence_ref_type, evidence_span_id,
            source_hash, input_hash, model_revision, dimensions, embedding,
            profile_version, status, created_at, updated_at
          )
          VALUES (
            gen_random_uuid(), ${v.workspaceId}, ${v.noteVersionId}, ${v.evidenceRefType},
            ${v.evidenceSpanId}, ${v.sourceHash}, ${v.inputHash}, ${v.modelRevision},
            ${v.dimensions}, ${JSON.stringify(v.embedding)}::vector,
            ${v.profileVersion}, ${v.status}, ${ts}, ${ts}
          )
          ON CONFLICT DO NOTHING
        `);
      }
      generatedCount += values.length;
    }
  }

  logger.info(
    {
      runId,
      noteVersionId,
      total: toEmbed.length,
      generated: generatedCount,
      skipped: skippedCount,
      failed: failedCount,
      model: modelRevision,
    },
    "persistEvidenceEmbeddings: 派生索引生成完成",
  );
}

