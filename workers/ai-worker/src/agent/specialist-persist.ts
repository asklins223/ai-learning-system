/**
 * Specialist Agent 持久化辅助模块（QUAL-02 部分修复）
 *
 * 从 card-supervisor-agent.ts 中提取的 Specialist Agent 相关持久化函数：
 * - appendAgentEvent: Agent 事件日志写入
 * - loadAssignedBundles: 加载已分配的证据 bundles
 * - persistQualityReport: 持久化 Critic 质量报告
 * - persistExtractionResults: 持久化 Extractor 提取结果
 * - persistRepairPatches: 持久化 Repairer 的 patch 结果
 * - resumeParentSupervisorIfNeeded: 子任务完成后恢复父 Supervisor
 *
 * 这些函数都是自包含的 DB 操作，不依赖 card-supervisor-agent.ts 中的局部类型。
 */

import { and, eq, inArray, max, notInArray, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  sanitizeOperationalError,
  isTerminalUnitStatus,
  NON_TERMINAL_UNIT_STATUSES,
  TERMINAL_RUN_STATUSES,
  SupervisorRunStatus,
  type DeckDraft,
  type DraftPatch,
  type QualityReport,
} from "@ailearn/shared";
import { logger } from "../lib/logger.ts";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

/** 追加 Agent event 到数据库（计划 §9.3） */
export async function appendAgentEvent(input: {
  workspaceId: string;
  runId: string;
  unitId: string | null;
  eventKey: string;
  eventType: string;
  agentRole: string | null;
  turnNo: number | null;
  toolName?: string | null;
  safePayload: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(schema.cardGenerationAgentEvents).values({
      workspaceId: input.workspaceId,
      runId: input.runId,
      unitId: input.unitId,
      eventKey: input.eventKey,
      eventType: input.eventType,
      agentRole: input.agentRole,
      turnNo: input.turnNo,
      toolName: input.toolName ?? null,
      safePayload: input.safePayload,
    }).onConflictDoNothing();
  } catch (err) {
    // Agent event 写入失败不应阻断主流程
    logger.warn(
      { runId: input.runId, eventKey: input.eventKey, error: sanitizeOperationalError(err) },
      "Agent event 写入失败（非致命）",
    );
  }
}

// ─── Specialist 辅助函数 ──────────────────────────────────────────────────

/**
 * 加载已分配的 bundles 的 evidence（计划 §6.2）。
 *
 * 从 card_generation_source_bundles 和其成员加载 assigned bundles 的 evidence units。
 */
export async function loadAssignedBundles(
  runId: string,
  workspaceId: string,
  bundleIds: string[],
): Promise<Array<{
  bundleId: string;
  sectionPath: string[];
  evidenceUnits: Array<{
    refId: string;
    kind: string;
    text: string;
    contextOnly: boolean;
  }>;
}>> {
  if (bundleIds.length === 0) {
    return [];
  }

  // 从 DB 加载 source bundles
  const bundles = await db
    .select()
    .from(schema.cardGenerationSourceBundles)
    .where(and(
      eq(schema.cardGenerationSourceBundles.runId, runId),
      eq(schema.cardGenerationSourceBundles.workspaceId, workspaceId),
      inArray(schema.cardGenerationSourceBundles.bundleKey, bundleIds),
    ));

  // 从 DB 加载 bundle members
  const bundleIds_db = bundles.map((b) => b.id);
  const members = bundleIds_db.length > 0
    ? await db
        .select()
        .from(schema.cardGenerationSourceBundleMembers)
        .where(and(
          eq(schema.cardGenerationSourceBundleMembers.workspaceId, workspaceId),
          inArray(schema.cardGenerationSourceBundleMembers.bundleId, bundleIds_db),
        ))
    : [];

  // 从 evidence spans 加载文本
  // 修复 R12（第10轮）：note_evidence_spans 表设计上不存储 exactText
  // （schema 注释："callers recover it from block.content and verify textHash"）。
  // 旧代码直接读 span.exactText，该字段不存在，回退到 unitKey（如 "span:blockId:0"），
  // 导致 Extractor 收到键名而非文本内容，无法提取候选。
  // 修复后：join note_blocks 表，用 charStart/charEnd 从 block.content 中恢复文本，并验证 textHash。
  const textSpanIds = members
    .map((m) => m.evidenceSpanId)
    .filter((id): id is string => id !== null);

  const spans = textSpanIds.length > 0
    ? await db
        .select({
          span: schema.noteEvidenceSpans,
          block: schema.noteBlocks,
        })
        .from(schema.noteEvidenceSpans)
        .innerJoin(
          schema.noteBlocks,
          eq(schema.noteEvidenceSpans.blockId, schema.noteBlocks.id),
        )
        .where(and(
          eq(schema.noteEvidenceSpans.workspaceId, workspaceId),
          inArray(schema.noteEvidenceSpans.id, textSpanIds),
        ))
    : [];

  const spanMap = new Map(spans.map((row) => [row.span.id, row]));

  // R16 修复：加载 image evidence members
  // 原代码只处理 text_span 类型的 members，image_evidence 类型的 members 被忽略。
  // 修复后：同时查询 note_image_evidence_units 加载图片证据文本。
  const imageEvidenceIds = members
    .map((m) => m.imageEvidenceUnitId)
    .filter((id): id is string => id !== null);

  const imageEvidences = imageEvidenceIds.length > 0
    ? await db
        .select({
          id: schema.noteImageEvidenceUnits.id,
          text: schema.noteImageEvidenceUnits.text,
        })
        .from(schema.noteImageEvidenceUnits)
        .where(and(
          eq(schema.noteImageEvidenceUnits.workspaceId, workspaceId),
          inArray(schema.noteImageEvidenceUnits.id, imageEvidenceIds),
        ))
    : [];

  const imageMap = new Map(imageEvidences.map((row) => [row.id, row]));

  return bundles.map((bundle) => {
    const bundleMembers = members.filter((m) => m.bundleId === bundle.id);
    const evidenceUnits = bundleMembers
      .map((m) => {
        // 处理 text_span 类型
        if (m.evidenceSpanId) {
          const row = spanMap.get(m.evidenceSpanId);
          if (!row) return null;
          const span = row.span;
          const block = row.block;
          // 从 block.content 中按 charStart/charEnd 恢复文本
          const blockContent = block.content ?? "";
          const recoveredText = blockContent.slice(span.charStart, span.charEnd);
          // R21 修复：验证 textHash（计划 §G2）
          // schema 注释要求："callers recover it from block.content and verify textHash
          // before using it as evidence." 原代码不验证 hash，如果 block 内容被意外修改，
          // 会导致证据文本与封存时不一致且不可检测。
          const recoveredHash = createHash("sha256")
            .update(recoveredText, "utf8")
            .digest("hex");
          if (recoveredText && span.textHash && recoveredHash !== span.textHash) {
            logger.warn(
              { spanId: span.id, unitKey: span.unitKey, expected: span.textHash, actual: recoveredHash },
              "textHash 验证失败：恢复的文本 hash 与封存时不一致",
            );
            return {
              refId: span.id,
              kind: "text_span",
              text: span.unitKey ?? "[hash_mismatch]",
              contextOnly: m.membership === "context_only",
            };
          }
          return {
            refId: span.id,
            kind: "text_span",
            text: recoveredText || span.unitKey,
            contextOnly: m.membership === "context_only",
          };
        }
        // R16 修复：处理 image_evidence 类型
        if (m.imageEvidenceUnitId) {
          const imgRow = imageMap.get(m.imageEvidenceUnitId);
          if (!imgRow) return null;
          return {
            refId: imgRow.id,
            kind: "image_evidence",
            text: imgRow.text ?? "",
            contextOnly: m.membership === "context_only",
          };
        }
        return null;
      })
      .filter((eu): eu is NonNullable<typeof eu> => eu !== null);

    return {
      bundleId: bundle.bundleKey,
      sectionPath: (bundle.sectionPath as string[]) ?? [],
      evidenceUnits,
    };
  });
}

/**
 * 持久化 Quality Report 到数据库（计划 §9.6）。
 *
 * Critic 提交 Quality Report 后，将其写入 card_generation_quality_reports 表。
 */
export async function persistQualityReport(
  workspaceId: string,
  runId: string,
  draftId: string,
  report: QualityReport,
): Promise<void> {
  await db.insert(schema.cardGenerationQualityReports).values({
    workspaceId,
    runId,
    draftId,
    draftHash: report.draftHash,
    candidatePoolHash: report.candidatePoolHash,
    sourceLedgerHash: report.sourceLedgerHash,
    criticVersion: report.criticVersion,
    verifierVersion: report.verifierVersion,
    hardIssues: report.hardIssues,
    softIssues: report.softIssues,
    perClaimVerdicts: report.perClaimVerdicts,
    metrics: report.metrics,
    criticStatus: report.criticStatus,
    deterministicStatus: report.deterministicStatus,
  }).onConflictDoNothing();
}

/**
 * 持久化 Extractor 的提取结果到数据库（修复 E5）。
 *
 * 将 Extractor 从 record_extraction_decisions 工具调用中解析的候选和 no-candidate 决策
 * 写入 card_generation_candidates 表和 source_bundles 的 decision_status。
 */
export async function persistExtractionResults(
  workspaceId: string,
  runId: string,
  agentUnitId: string,
  noteVersionId: string,
  candidates: Array<{
    localId: string;
    bundleId: string;
    claim: string;
    topic: string;
    cognitiveType: string;
    importance: string;
    difficulty?: string;
    evidenceRefIds: string[];
    relationHints?: Array<{ type: string; localTargetId: string }>;
  }>,
  noCandidates: Array<{
    bundleId: string;
    reason: string;
  }>,
  assignedBundleIds: string[],
): Promise<void> {
  const now = new Date();

  // P1-09 修复：验证每个 candidate 的 bundleId 非空且属于 assigned bundles。
  // 原代码不验证 bundleId，模型可能返回空字符串或不属于当前 unit 的 bundleId，
  // 导致 sectionKey 和 coverage 计算错误。
  const assignedBundleIdSet = new Set(assignedBundleIds);
  const validCandidates: typeof candidates = [];
  const rejectedCandidates: Array<{ localId: string; bundleId: string; reason: string }> = [];
  for (const c of candidates) {
    if (!c.bundleId || c.bundleId.trim().length === 0) {
      rejectedCandidates.push({ localId: c.localId, bundleId: c.bundleId, reason: "empty_bundle_id" });
      continue;
    }
    if (!assignedBundleIdSet.has(c.bundleId)) {
      rejectedCandidates.push({ localId: c.localId, bundleId: c.bundleId, reason: "bundle_not_assigned" });
      continue;
    }
    // P1-09: 每个候选必须至少有一个 evidence refId
    if (!c.evidenceRefIds || c.evidenceRefIds.length === 0) {
      rejectedCandidates.push({ localId: c.localId, bundleId: c.bundleId, reason: "no_evidence_refs" });
      continue;
    }
    validCandidates.push(c);
  }
  if (rejectedCandidates.length > 0) {
    logger.warn(
      { runId, agentUnitId, rejectedCount: rejectedCandidates.length, totalCount: candidates.length, rejected: rejectedCandidates.slice(0, 10) },
      "P1-09: 拒绝了无效候选（bundleId 为空/不属于 assigned bundles/无证据引用）",
    );
    // 记录安全事件
    await appendAgentEvent({
      workspaceId,
      runId,
      unitId: agentUnitId,
      eventKey: `validation:rejected_candidates:${agentUnitId}`,
      eventType: "validation_event",
      agentRole: "text_extractor",
      turnNo: null,
      safePayload: {
        reason: "invalid_candidate_provenance",
        rejectedCount: rejectedCandidates.length,
        totalCount: candidates.length,
        details: rejectedCandidates.slice(0, 20),
      },
    });
  }
  candidates = validCandidates;

  // P1-09 修复：按 bundleId 分组候选，实现精确的 per-bundle 覆盖率计算。
  // 原代码选取第一个非空 section path 作为所有候选的 sectionKey，
  // 并把全部已分配 bundle 都记成 candidate_emitted + 总候选数。
  // 修复后：每个候选使用自己的 bundleId 查询对应 bundle 的 sectionPath，
  // 每个 bundle 的 decisionStatus 和 candidateCount 只反映该 bundle 的候选。
  const bundleSectionMap = new Map<string, string>();
  const bundleCandidateCounts = new Map<string, number>();
  // P1-09: per-bundle evidence 集合，在 if 块外声明以便候选循环使用
  const bundlePrimarySpanIds = new Map<string, Set<string>>();
  const bundlePrimaryImageIds = new Map<string, Set<string>>();
  const bundleContextSpanIds = new Map<string, Set<string>>();
  const bundleContextImageIds = new Map<string, Set<string>>();
  if (assignedBundleIds.length > 0) {
    const assignedBundleRows = await db
      .select({
        id: schema.cardGenerationSourceBundles.id,
        bundleKey: schema.cardGenerationSourceBundles.bundleKey,
        sectionPath: schema.cardGenerationSourceBundles.sectionPath,
      })
      .from(schema.cardGenerationSourceBundles)
      .where(and(
        eq(schema.cardGenerationSourceBundles.workspaceId, workspaceId),
        eq(schema.cardGenerationSourceBundles.runId, runId),
        inArray(schema.cardGenerationSourceBundles.bundleKey, assignedBundleIds),
      ));
    for (const b of assignedBundleRows) {
      const sectionKey = Array.isArray(b.sectionPath) ? b.sectionPath.join("/") : "";
      bundleSectionMap.set(b.bundleKey, sectionKey);
      bundleCandidateCounts.set(b.bundleKey, 0);
    }

    // P1-09: 预加载 per-bundle evidence 集合，用于验证每个候选至少有一个
    // 来自其所属 bundle 的有效 evidence（primary 或 context_only）。
    // 原代码在循环内为每个候选重复查询，且不验证 evidence 是否属于候选自己的 bundle。
    const bundleKeyToDbId = new Map<string, string>();
    for (const b of assignedBundleRows) {
      bundleKeyToDbId.set(b.bundleKey, b.id);
    }
    // O(1) 反向映射：member 行按 bundleId 反查 bundleKey，替代每行遍历全 map
    const dbIdToBundleKey = new Map<string, string>();
    for (const [key, dbId] of bundleKeyToDbId) {
      dbIdToBundleKey.set(dbId, key);
    }
    const assignedBundleDbIds = assignedBundleRows.map((b) => b.id);
    const allMemberRows = assignedBundleDbIds.length > 0
      ? await db
          .select({
            bundleId: schema.cardGenerationSourceBundleMembers.bundleId,
            evidenceSpanId: schema.cardGenerationSourceBundleMembers.evidenceSpanId,
            imageEvidenceUnitId: schema.cardGenerationSourceBundleMembers.imageEvidenceUnitId,
            membership: schema.cardGenerationSourceBundleMembers.membership,
          })
          .from(schema.cardGenerationSourceBundleMembers)
          .where(and(
            eq(schema.cardGenerationSourceBundleMembers.workspaceId, workspaceId),
            inArray(schema.cardGenerationSourceBundleMembers.bundleId, assignedBundleDbIds),
          ))
      : [];

    // 构建 per-bundle evidence 集合：bundleKey → Set<evidenceId>
    // 同时区分 text_span 和 image_evidence
    // 变量已在 if 块外声明，此处直接填充

    for (const m of allMemberRows) {
      // 将 member 的 bundleId (DB UUID) 转换为 bundleKey（O(1) 反查）
      const bundleKey = dbIdToBundleKey.get(m.bundleId) ?? null;
      if (!bundleKey) continue;

      const isPrimary = m.membership === "primary";
      if (m.evidenceSpanId) {
        const targetMap = isPrimary ? bundlePrimarySpanIds : bundleContextSpanIds;
        const set = targetMap.get(bundleKey) ?? new Set<string>();
        set.add(m.evidenceSpanId);
        targetMap.set(bundleKey, set);
      }
      if (m.imageEvidenceUnitId) {
        const targetMap = isPrimary ? bundlePrimaryImageIds : bundleContextImageIds;
        const set = targetMap.get(bundleKey) ?? new Set<string>();
        set.add(m.imageEvidenceUnitId);
        targetMap.set(bundleKey, set);
      }
    }
  }

  // 按 bundleId 分组候选
  const candidatesByBundle = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const group = candidatesByBundle.get(c.bundleId) ?? [];
    group.push(c);
    candidatesByBundle.set(c.bundleId, group);
  }

  // 写入候选 + 证据引用（批量，避免 N+1 顺序 DB round-trips）
  // 先在内存中完成候选验证、构造待插入候选行与每候选的证据引用，
  // 再用多行 VALUES 一次批量 INSERT 候选与证据。
  interface InsertCandidateRow {
    originalIndex: number;
    localId: string;
    row: Record<string, unknown>;
    validEvidenceRefs: Array<{ refId: string; isTextSpan: boolean; isPrimary: boolean }>;
  }
  const insertCandidates: InsertCandidateRow[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const localOrdinal = i + 1;
    const localId = c.localId || `cand-${agentUnitId}-${localOrdinal}`;

    // P1-09: 使用候选的 bundleId 查询对应 bundle 的 sectionPath
    // bundleId 已在上面的验证中确认非空且属于 assigned bundles
    const resolvedSectionKey = bundleSectionMap.get(c.bundleId) ?? "";

    // P1-09: 验证候选至少有一个来自其所属 bundle 的有效 evidence。
    // 使用预加载的 per-bundle evidence 集合进行验证。
    const candidatePrimarySpans = bundlePrimarySpanIds.get(c.bundleId) ?? new Set<string>();
    const candidatePrimaryImages = bundlePrimaryImageIds.get(c.bundleId) ?? new Set<string>();
    const candidateContextSpans = bundleContextSpanIds.get(c.bundleId) ?? new Set<string>();
    const candidateContextImages = bundleContextImageIds.get(c.bundleId) ?? new Set<string>();

    // 构建候选所属 bundle 的全部合法 evidence ID 集合
    const candidateAllSpanIds = new Set([...candidatePrimarySpans, ...candidateContextSpans]);
    const candidateAllImageIds = new Set([...candidatePrimaryImages, ...candidateContextImages]);

    // 验证每个 evidenceRefId 是否属于候选的所属 bundle
    let hasValidEvidence = false;
    const validEvidenceRefs: Array<{ refId: string; isTextSpan: boolean; isPrimary: boolean }> = [];
    for (const refId of c.evidenceRefIds) {
      const isTextSpan = candidateAllSpanIds.has(refId);
      const isImageEvidence = candidateAllImageIds.has(refId);
      if (!isTextSpan && !isImageEvidence) {
        logger.warn(
          { runId, agentUnitId, evidenceRefId: refId, bundleId: c.bundleId },
          "P1-09: evidenceRefId 不属于候选的所属 bundle，跳过",
        );
        continue;
      }
      const isPrimary = isTextSpan
        ? candidatePrimarySpans.has(refId)
        : candidatePrimaryImages.has(refId);
      validEvidenceRefs.push({ refId, isTextSpan, isPrimary });
      hasValidEvidence = true;
    }

    // P1-09: 如果候选没有任何来自其所属 bundle 的有效 evidence，拒绝该候选
    if (!hasValidEvidence) {
      logger.warn(
        { runId, agentUnitId, localId: c.localId, bundleId: c.bundleId, evidenceRefIds: c.evidenceRefIds },
        "P1-09: 候选没有任何来自其所属 bundle 的有效 evidence，拒绝该候选",
      );
      await appendAgentEvent({
        workspaceId,
        runId,
        unitId: agentUnitId,
        eventKey: `validation:no_valid_evidence:${agentUnitId}:${c.localId}`,
        eventType: "validation_event",
        agentRole: "text_extractor",
        turnNo: null,
        safePayload: {
          reason: "no_valid_evidence_for_bundle",
          localId: c.localId,
          bundleId: c.bundleId,
          evidenceRefIds: c.evidenceRefIds,
        },
      });
      continue; // 跳过此候选，不插入 DB
    }

    insertCandidates.push({
      originalIndex: i,
      localId,
      row: {
        workspaceId,
        runId,
        unitId: agentUnitId,
        localOrdinal,
        localId,
        claim: c.claim,
        normalizedClaimHash: createHash("sha256").update(c.claim, "utf8").digest("hex"),
        topic: c.topic,
        sectionKey: resolvedSectionKey,
        cognitiveType: c.cognitiveType,
        importance: c.importance,
        // P1-11: 持久化候选难度
        difficulty: c.difficulty ?? null,
        validationStatus: "pending",
        relationHints: (c.relationHints as Record<string, unknown>[]) ?? [],
        createdAt: now,
        // P1-09: 强制写入 bundleId
        bundleId: c.bundleId,
      },
      validEvidenceRefs,
    });
  }

  // 批量 INSERT 候选（多行 VALUES + onConflictDoNothing），一次 round-trip
  const candidateDbIds = new Map<string, string>(); // localId -> candidate DB id
  if (insertCandidates.length > 0) {
    const insertedRows = await db
      .insert(schema.cardGenerationCandidates)
      .values(insertCandidates.map((ic) => ic.row) as any[])
      .onConflictDoNothing()
      .returning({ localId: schema.cardGenerationCandidates.localId, id: schema.cardGenerationCandidates.id });

    for (const r of insertedRows) {
      candidateDbIds.set(r.localId, r.id);
    }

    // 幂等命中（onConflictDoNothing 不返回冲突行）的 localId 一次性批量查询已有 ID
    const missingLocalIds = insertCandidates
      .filter((ic) => !candidateDbIds.has(ic.localId))
      .map((ic) => ic.localId);
    if (missingLocalIds.length > 0) {
      const existingRows = await db
        .select({
          id: schema.cardGenerationCandidates.id,
          localId: schema.cardGenerationCandidates.localId,
        })
        .from(schema.cardGenerationCandidates)
        .where(and(
          eq(schema.cardGenerationCandidates.workspaceId, workspaceId),
          eq(schema.cardGenerationCandidates.runId, runId),
          eq(schema.cardGenerationCandidates.unitId, agentUnitId),
          inArray(schema.cardGenerationCandidates.localId, missingLocalIds),
        ));
      for (const r of existingRows) {
        candidateDbIds.set(r.localId, r.id);
      }
    }
  }

  // 批量 INSERT 全部证据引用（多行 VALUES + onConflictDoNothing），一次 round-trip
  const evidenceRows: Array<Record<string, unknown>> = [];
  for (const ic of insertCandidates) {
    const candidateDbId = candidateDbIds.get(ic.localId) ?? null;
    if (!candidateDbId || ic.validEvidenceRefs.length === 0) continue;
    for (let ei = 0; ei < ic.validEvidenceRefs.length; ei++) {
      const evRef = ic.validEvidenceRefs[ei]!;
      if (evRef.isTextSpan) {
        evidenceRows.push({
          workspaceId,
          runId,
          noteVersionId,
          candidateId: candidateDbId,
          sourceKind: "text_span",
          evidenceSpanId: evRef.refId,
          ordinal: ei,
          sourceVerificationStatus: "verified",
          sourceVerificationMethod: "exact_span_hash",
          createdAt: now,
        });
      } else {
        evidenceRows.push({
          workspaceId,
          runId,
          noteVersionId,
          candidateId: candidateDbId,
          sourceKind: "image_evidence",
          imageEvidenceUnitId: evRef.refId,
          ordinal: ei,
          sourceVerificationStatus: "verified",
          sourceVerificationMethod: "image_region_hash",
          createdAt: now,
        });
      }
    }
  }
  if (evidenceRows.length > 0) {
    await db.insert(schema.cardGenerationCandidateEvidence).values(evidenceRows as any[]).onConflictDoNothing();
  }

  // P1-09 修复：按 bundleId 逐个更新 bundle 的 decision status 和 candidate count。
  // 原代码把全部已分配 bundle 都记成 candidate_emitted + 总候选数，
  // 导致一个 bundle 的候选数被错误地应用于所有 bundle。
  // 修复后：每个 bundle 只根据自己产生的候选数更新。
  // 先统计每个 bundle 的实际候选数
  for (const c of candidates) {
    bundleCandidateCounts.set(c.bundleId, (bundleCandidateCounts.get(c.bundleId) ?? 0) + 1);
  }

  // 更新 no-candidate bundles 的 decision status（批量 UPDATE，避免每 bundle 一次 round-trip）
  // QUAL-33 修复：同时持久化 candidateCount=0
  // 矛盾保护：如果某个 bundle 已产生候选，则其 noCandidate 决策与之矛盾，
  // 以候选为准（模型可能在同一 bundle 内把个别证据判为 decorative，但仍提取了候选）。
  // 原实现在候选循环之前无条件应用 noCandidate，导致「既有候选又有 noCandidate」的
  // bundle 被覆盖为 no_learnable_fact + candidateCount=0，与已持久化的候选矛盾，
  // 进而 candidateSurvivalCoverage 计算为 0、发布门禁 coverage_insufficient 失败。
  const noCandidateZero = noCandidates.filter((nc) => (bundleCandidateCounts.get(nc.bundleId) ?? 0) === 0);
  if (noCandidateZero.length > 0) {
    await db.execute(sql`
      UPDATE card_generation_source_bundles AS b
      SET decision_status = 'no_learnable_fact',
          decision_reason = v.reason,
          candidate_count = 0,
          decided_at = ${now},
          updated_at = ${now}
      FROM (VALUES
        ${sql.join(noCandidateZero.map((nc) => sql`(${nc.bundleId}, ${nc.reason})`), sql`, `)}
      ) AS v(bundle_key, reason)
      WHERE b.bundle_key = v.bundle_key
        AND b.workspace_id = ${workspaceId}
        AND b.run_id = ${runId}
    `);
  }

  // 只要有候选，就标记为 candidate_emitted（批量 UPDATE）——即使该 bundle 也出现在 noCandidate 中
  // （模型矛盾输出：既提取候选又判 noCandidate）。候选优先；无候选的 bundle 已由
  // 上面的 noCandidate 循环标记为 no_learnable_fact。若在此处仍跳过 noCandidate 里的
  // bundle，会导致「既有候选又有 noCandidate」的 bundle 停留在 pending、
  // candidate_count=0，validate_draft 报 coverage_decision_incomplete。
  const candidateEmitted = assignedBundleIds
    .map((bundleId) => ({ bundleId, count: bundleCandidateCounts.get(bundleId) ?? 0 }))
    .filter((e) => e.count > 0);
  if (candidateEmitted.length > 0) {
    await db.execute(sql`
      UPDATE card_generation_source_bundles AS b
      SET decision_status = 'candidate_emitted',
          decision_reason = 'extracted ' || v.count || ' candidates',
          candidate_count = v.count,
          decided_at = ${now},
          updated_at = ${now}
      FROM (VALUES
        ${sql.join(candidateEmitted.map((e) => sql`(${e.bundleId}, ${e.count})`), sql`, `)}
      ) AS v(bundle_key, count)
      WHERE b.bundle_key = v.bundle_key
        AND b.workspace_id = ${workspaceId}
        AND b.run_id = ${runId}
    `);
  }

  // P1-09 修复：覆盖率只从 DB 关系重算，禁止信任模型声明或内存累计值。
  // 原代码通过 join card_generation_candidates 和 source_bundles 计算 survival coverage，
  // 但 join 条件是 unitId = assignedAgentUnitId，一个 unit 可能处理多个 bundle，
  // 导致计数不准确。
  // 修复后：直接从 source_bundles.candidate_count 列读取，该列已在上面的循环中精确更新。
  const [runUpdate] = await db
    .select({ coverageReport: schema.cardGenerationRuns.coverageReport })
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, runId),
      eq(schema.cardGenerationRuns.workspaceId, workspaceId),
    ))
    .limit(1);

  if (runUpdate?.coverageReport) {
    const coverage = runUpdate.coverageReport as Record<string, unknown>;
    // P1-09: 直接从 DB 的 candidate_count 列重算 candidateSurvivalCoverage。
    // 与 CoverageLedger.computeCoverageReport 的语义一致：有存活候选（candidate_emitted
    // 且 candidateCount>0）或明确 no_learnable_fact 决策的 bundle 都算「存活」。
    // 原 SQL 只统计 candidate_emitted，漏掉 no_learnable_fact bundle，
    // 导致全量 no_learnable_fact 的 run 在 VERIFY 通过后、PUBLISH 阶段
    // coverage_insufficient 失败。
    const [survivalResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.cardGenerationSourceBundles)
      .where(and(
        eq(schema.cardGenerationSourceBundles.workspaceId, workspaceId),
        eq(schema.cardGenerationSourceBundles.runId, runId),
        eq(schema.cardGenerationSourceBundles.required, true),
        or(
          and(
            eq(schema.cardGenerationSourceBundles.decisionStatus, "candidate_emitted"),
            sql`${schema.cardGenerationSourceBundles.candidateCount} > 0`,
          ),
          eq(schema.cardGenerationSourceBundles.decisionStatus, "no_learnable_fact"),
        ),
      ));

    const [requiredBundlesResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.cardGenerationSourceBundles)
      .where(and(
        eq(schema.cardGenerationSourceBundles.workspaceId, workspaceId),
        eq(schema.cardGenerationSourceBundles.runId, runId),
        eq(schema.cardGenerationSourceBundles.required, true),
      ));

    const requiredCount = requiredBundlesResult?.count ?? 0;
    const survivalCount = survivalResult?.count ?? 0;
    const candidateSurvivalCoverage = requiredCount > 0 ? survivalCount / requiredCount : 0;

    await db.update(schema.cardGenerationRuns).set({
      coverageReport: {
        ...coverage,
        candidateSurvivalCoverage,
      } as Record<string, unknown>,
      updatedAt: now,
    }).where(and(
      eq(schema.cardGenerationRuns.id, runId),
      eq(schema.cardGenerationRuns.workspaceId, workspaceId),
    ));
  }

  logger.info(
    { runId, agentUnitId, candidateCount: candidates.length, noCandidateCount: noCandidates.length },
    "Extractor 结果已持久化（含证据引用 + coverage 更新）",
  );
}

/**
 * 持久化 Repairer 的 patch 结果到数据库（修复 E5）。
 *
 * 将 Repairer 从 submit_draft_patch 工具调用中解析的 patches 应用到 Draft，
 * 创建新的 immutable Draft 版本，并失效旧 Quality Report。
 */
export async function persistRepairPatches(
  workspaceId: string,
  runId: string,
  agentUnitId: string,
  patches: DraftPatch[],
  baseDraftId: string,
): Promise<void> {
  // 查找基础 draft
  const [baseDraft] = await db
    .select()
    .from(schema.cardGenerationDrafts)
    .where(and(
      eq(schema.cardGenerationDrafts.id, baseDraftId),
      eq(schema.cardGenerationDrafts.workspaceId, workspaceId),
    ))
    .limit(1);

  if (!baseDraft) {
    logger.warn({ runId, baseDraftId }, "persistRepairPatches: 基础 draft 不存在");
    return;
  }

  // 应用 patches 到 contentJson（复用 deck-draft.ts 的 patch 逻辑）
  const baseContent = baseDraft.contentJson as Record<string, unknown>;
  const cards = Array.isArray(baseContent.cards)
    ? [...(baseContent.cards as Record<string, unknown>[])]
    : [];
  // 预建 draftCardId/localId -> 卡片索引映射，避免每个 patch 内 findIndex（O(patches×cards)）
  const cardIndexById = new Map<string, number>();
  cards.forEach((c, i) => {
    if (c.draftCardId !== undefined && c.draftCardId !== null) cardIndexById.set(String(c.draftCardId), i);
    if (c.localId !== undefined && c.localId !== null) cardIndexById.set(String(c.localId), i);
  });
  const findCardIndex = (id: string): number => cardIndexById.get(id) ?? -1;
  // 收集 rewrite_claim 的候选 claim 更新，循环后批量 UPDATE（避免每 patch 一次 round-trip）
  interface RewriteClaimUpdate { candidateId: string; newClaim: string; normalizedClaimHash: string }
  const rewriteClaimUpdates: RewriteClaimUpdate[] = [];

  for (const patch of patches) {
    // 2026-08-11：版本校验落地——patch.baseDraftHash 与当前 base draft 的
    // contentHash 不一致时跳过（防止把基于旧 draft 的修改应用到新内容上，
    // 覆盖并发产生的新修复）。
    if (
      patch.baseDraftHash &&
      baseDraft.contentHash !== patch.baseDraftHash
    ) {
      logger.warn(
        { runId, patchType: patch.type, expected: baseDraft.contentHash, got: patch.baseDraftHash },
        "persistRepairPatches: patch 基于的 draft 版本与当前 base draft 不一致，跳过",
      );
      continue;
    }
    const cardDraftId = patch.cardDraftId;
    const candidateId = patch.candidateId;
    // R70 修复：与 deck-draft.ts 的 handleApplyDraftPatch (R63 修复) 保持一致，
    // 移除有 bug 的第三条件 `c.draftCardId === card-${cards.indexOf(c)}`。
    // 该条件不与输入 cardDraftId 比较，而是检查 card 自身的 draftCardId 是否等于
    // 其自身索引的字符串形式。对于 auto-assigned cards（draftCardId = "card-N"），
    // 该条件始终为 true，导致任何不匹配的 cardDraftId 都会错误匹配到第一个 card。
    // 修复后：只匹配 draftCardId 和 localId，与 handleApplyDraftPatch 一致。
    const cardIndex = cardDraftId ? findCardIndex(cardDraftId) : -1;

    switch (patch.type) {
      case "rewrite_claim":
        // R47 修复：rewrite_claim 应更新 candidate 的 claim 文本，而非 card.summary。
        // 修复（2026-08-06）：直接更新 card_generation_candidates 的 claim。
        // 原实现只记录日志并 defer，但 deferredCandidateOperations 没有任何消费方，
        // 导致 atomicity_violation / dangling_reference 等需要改 claim 的修复永远不生效，
        // 重新审查时同一 hard issue 再次出现 → 修复失败。
        // 现在直接更新候选 claim（含 normalizedClaimHash），发布时卡片 key point 使用新 claim。
        if (patch.candidateId && patch.newClaim) {
          rewriteClaimUpdates.push({
            candidateId: patch.candidateId,
            newClaim: patch.newClaim,
            normalizedClaimHash: createHash("sha256").update(patch.newClaim, "utf8").digest("hex"),
          });
          logger.info(
            { runId, candidateId: patch.candidateId },
            "rewrite_claim patch 已应用到候选 claim",
          );
        } else {
          logger.warn(
            { runId, patchType: "rewrite_claim", candidateId, cardIndex },
            "rewrite_claim patch 缺少 candidateId 或 newClaim，跳过",
          );
        }
        break;
      case "rewrite_title":
        if (cardIndex >= 0 && patch.newTitle) {
          cards[cardIndex]!.title = patch.newTitle;
        }
        break;
      case "rewrite_summary":
        if (cardIndex >= 0 && patch.newSummary) {
          cards[cardIndex]!.summary = patch.newSummary;
        }
        break;
      // R68 修复：与 deck-draft.ts 的 handleApplyDraftPatch (R65 修复) 保持一致。
      // remove_evidence 是候选级别操作（从候选的证据列表中移除不相关证据引用），
      // 不是卡片级别操作。原代码将 removedEvidenceRefIds（证据引用 ID）与
      // card.candidateIds（候选 ID）混合比较，属于命名空间混用错误。
      // 修复后：记录为 deferred 操作，使 Supervisor 可在后续 turn 中通过
      // apply_candidate_operations 工具应用。
      case "remove_evidence":
        logger.warn(
          { runId, patchType: "remove_evidence", candidateId, cardIndex },
          "remove_evidence patch 在 persistRepairPatches 中需要通过 apply_candidate_operations 工具处理，已跳过",
        );
        break;
      case "move_candidate": {
        // R48 修复：完整实现 move_candidate 逻辑，与 deck-draft.ts 保持一致。
        // 1. 从源 card 移除 candidate
        // 2. 添加到目标 card（如果提供了 targetCardDraftId）
        if (cardIndex >= 0 && candidateId) {
          const card = cards[cardIndex]!;
          const candidateIds = Array.isArray(card.candidateIds) ? card.candidateIds as string[] : [];
          card.candidateIds = candidateIds.filter((id) => id !== candidateId);
        }
        // R71 修复：与 deck-draft.ts 的 handleApplyDraftPatch (R64 修复) 保持一致，
        // 移除有 bug 的第三条件，原因同 R70。
        if (patch.targetCardDraftId) {
          const targetCardIndex = findCardIndex(patch.targetCardDraftId);
          if (targetCardIndex >= 0 && candidateId) {
            const targetCard = cards[targetCardIndex]!;
            const targetCandidateIds = Array.isArray(targetCard.candidateIds) ? targetCard.candidateIds as string[] : [];
            if (!targetCandidateIds.includes(candidateId)) {
              targetCard.candidateIds = [...targetCandidateIds, candidateId];
            }
          } else {
            logger.warn(
              { runId, targetCardDraftId: patch.targetCardDraftId, candidateId },
              "move_candidate: 目标卡片未找到",
            );
          }
        }
        break;
      }
      case "adjust_group":
        if (cardIndex >= 0 && patch.newGroupKey !== undefined) {
          cards[cardIndex]!.groupKey = patch.newGroupKey;
        }
        break;
      case "adjust_ordinal":
        if (cardIndex >= 0 && patch.newOrdinal !== undefined) {
          cards[cardIndex]!.ordinal = patch.newOrdinal;
        }
        break;
      case "adjust_primary_support":
        if (cardIndex >= 0 && patch.newPrimarySupportCandidateId) {
          cards[cardIndex]!.primarySupportCandidateId = patch.newPrimarySupportCandidateId;
        }
        break;
      // R69 修复：与 deck-draft.ts 的 handleApplyDraftPatch (R58 修复) 保持一致。
      // split_candidate, merge_candidate, restore_candidate 是候选级别操作，
      // 需要通过 apply_candidate_operations 工具处理。
      // 原代码让这些 case fall through 到 default 被静默跳过，不记录任何日志。
      // 修复后：显式记录警告，使运维和调试能看到这些操作被跳过。
      case "split_candidate":
      case "merge_candidate":
      case "restore_candidate":
        logger.warn(
          { runId, patchType: patch.type, candidateId },
          `${patch.type} patch 在 persistRepairPatches 中需要通过 apply_candidate_operations 工具处理，已跳过`,
        );
        break;
      default:
        logger.warn(
          { runId, patchType: patch.type },
          `persistRepairPatches: 未知 patch 类型，跳过`,
        );
        break;
    }
  }

  // R41 修复：与 deck-draft.ts 的 handleApplyDraftPatch 保持一致，
  // 在 patchedContent 中添加 patched: true 和 patchOperations 元数据。
  // 原代码缺少这些字段，导致通过 persistRepairPatches 创建的 Draft
  // 缺少 patch 溯源信息，与通过 apply_draft_patch 工具创建的 Draft 不一致。
  // R69 修复：与 deck-draft.ts 的 handleApplyDraftPatch (R58 修复) 保持一致，
  // 收集 deferred 候选操作到 patchedContent.deferredCandidateOperations。
  // 批量应用 rewrite_claim 的候选 claim 更新（单次 round-trip，替代每 patch 一次 UPDATE）
  if (rewriteClaimUpdates.length > 0) {
    await db.execute(sql`
      UPDATE card_generation_candidates AS c
      SET claim = v.new_claim,
          normalized_claim_hash = v.normalized_claim_hash
      FROM (VALUES
        ${sql.join(rewriteClaimUpdates.map((u) => sql`(${u.candidateId}, ${u.newClaim}, ${u.normalizedClaimHash})`), sql`, `)}
      ) AS v(candidate_id, new_claim, normalized_claim_hash)
      WHERE c.id = v.candidate_id
        AND c.workspace_id = ${workspaceId}
        AND c.run_id = ${runId}
    `);
  }

  // rewrite_claim 已在上方直接应用到候选，不再 defer，避免重复处理。
  const deferredOps = patches.filter((p) =>
    p.type === "remove_evidence"
    || p.type === "split_candidate"
    || p.type === "merge_candidate"
    || p.type === "restore_candidate",
  );
  const patchedContent = {
    ...baseContent,
    cards,
    patched: true,
    patchOperations: patches,
    ...(deferredOps.length > 0 ? { deferredCandidateOperations: deferredOps } : {}),
  };
  const patchedHash = createHash("sha256")
    .update(JSON.stringify(patchedContent), "utf8")
    .digest("hex");

  // F2+F7 修复：使用 max(draftVersion) 替代 count()，避免并发问题和删除行导致的版本回退。
  // 同时移除动态 import("drizzle-orm")，使用已导入的 max 函数。
  const [repairVersionResult] = await db
    .select({ value: max(schema.cardGenerationDrafts.draftVersion) })
    .from(schema.cardGenerationDrafts)
    .where(and(
      eq(schema.cardGenerationDrafts.workspaceId, workspaceId),
      eq(schema.cardGenerationDrafts.runId, runId),
    ));

  const draftVersion = (repairVersionResult?.value ?? 0) + 1;

  // 插入新 Draft
  // security MEDIUM(0072)+ review should-fix:producedByEventKey=repair:${agentUnitId}
  // 同一 repair unit 重跑时复用;onConflictDoNothing 限定 0072 唯一键 target,
  // 避免吞掉 (workspace,run,draft_version) 并发冲突(后者应抛错→回滚→重试自愈)
  const [repairDraft] = await db.insert(schema.cardGenerationDrafts).values({
    workspaceId,
    runId,
    draftVersion,
    parentDraftId: baseDraftId,
    producedByUnitId: agentUnitId,
    producedByEventKey: `repair:${agentUnitId}`,
    schemaVersion: "deck-draft-v1",
    contentJson: patchedContent as unknown as DeckDraft,
    contentHash: patchedHash,
    deckTitle: baseDraft.deckTitle,
    deckSummary: baseDraft.deckSummary,
    density: baseDraft.density,
    cardBudget: baseDraft.cardBudget,
    baseLedgerHash: baseDraft.baseLedgerHash,
    summarySupportCandidateIds: baseDraft.summarySupportCandidateIds,
  }).onConflictDoNothing({
    target: [schema.cardGenerationDrafts.workspaceId, schema.cardGenerationDrafts.runId, schema.cardGenerationDrafts.producedByEventKey],
  }).returning();

  // 失效旧 Quality Report（新 draftHash 使旧 report 失效）
  // R40 修复：与 deck-draft.ts 的 handleApplyDraftPatch (R36 修复) 保持一致。
  // 原代码设置 deterministicStatus="stale"，但 qualityReportSchema 的
  // deterministicStatus 字段枚举只允许 ["passed", "failed", "pending"]。
  // "stale" 不在枚举中，如果经过 Zod 校验会被拒绝。
  // 修复后：使用 "failed" 表示旧 report 不再有效，符合枚举约束且语义正确
  // （旧 draft 已被 patch 替代，其确定性验证结果不再适用）。
  await db.update(schema.cardGenerationQualityReports).set({
    deterministicStatus: "failed",
  }).where(and(
    eq(schema.cardGenerationQualityReports.workspaceId, workspaceId),
    eq(schema.cardGenerationQualityReports.runId, runId),
    eq(schema.cardGenerationQualityReports.draftId, baseDraftId),
  ));

  logger.info(
    { runId, agentUnitId, patchCount: patches.length, newDraftVersion: draftVersion, newDraftHash: patchedHash, draftReused: !repairDraft },
    repairDraft
      ? "Repair patches 已持久化，新 Draft 已创建"
      : "Repair patches 已持久化,Draft 已存在(0072 幂等命中,跳过重建)",
  );
}

/**
 * 当子 Agent unit 完成时，恢复等待中的父 Supervisor（计划 §5.3）。
 *
 * child task 完成后由 scheduler 恢复 Supervisor。
 * 检查完成的 unit 是否有 parentUnitId，如果有则创建父 Supervisor 的下一 turn job。
 *
 * R29 修复：原代码在第一个子任务完成时就创建 resume job，
 * 不顾其他子任务是否仍在运行。如果 Supervisor 等待 [A, B, C] 三个子任务，
 * A 完成后 CAS 会成功（parent 从 waiting_child → running），创建 resume job。
 * 但 B 和 C 仍在运行，Supervisor 过早恢复后需要再次等待，浪费 provider 调用预算。
 *
 * 修复后：在 CAS 之前先检查所有同 parent 的 sibling 子任务是否都已终态
 * （succeeded/failed/cancelled/superseded）。只有全部终态时才执行 CAS 和创建 resume job。
 */
export async function resumeParentSupervisorIfNeeded(
  workspaceId: string,
  childUnitId: string,
  requestedBy: string | null,
): Promise<void> {
  // 查找 child unit 以获取 parentUnitId
  const [childUnit] = await db
    .select({
      id: schema.cardGenerationUnits.id,
      parentUnitId: schema.cardGenerationUnits.parentUnitId,
      runId: schema.cardGenerationUnits.runId,
      status: schema.cardGenerationUnits.status,
    })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.id, childUnitId),
      eq(schema.cardGenerationUnits.workspaceId, workspaceId),
    ))
    .limit(1);

  if (!childUnit || !childUnit.parentUnitId) {
    return; // 没有 parent，不需要恢复
  }

  // R29 修复：检查所有同 parent 的 sibling 子任务是否都已终态。
  // 只有全部终态（succeeded/terminal_failed/cancelled/superseded）时才恢复父 Supervisor。
  // 这防止了在只有一个子任务完成时过早恢复父 Supervisor。
  // P0-06 修复：unit status 枚举不一致。原代码检查 "failed"，
  // 但 DB 中实际值是 "terminal_failed"（migration 0054）。
  // "completed" 也不是合法值，正确的是 "succeeded"。
  // 同时加入 "retryable_failed"：如果子任务的队列重试已耗尽但仍处于
  // retryable_failed，父 Supervisor 需要恢复以处理失败（否则会永久卡死）。
  const siblings = await db
    .select({
      id: schema.cardGenerationUnits.id,
      status: schema.cardGenerationUnits.status,
    })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.parentUnitId, childUnit.parentUnitId!),
      eq(schema.cardGenerationUnits.workspaceId, workspaceId),
      eq(schema.cardGenerationUnits.runId, childUnit.runId),
    ));

  // P0-06 统一：使用共享的 isTerminalUnitStatus 判断终态，但额外包含 retryable_failed。
  // retryable_failed 不是终态（队列可能重试），但当队列重试已耗尽时，
  // 子任务不会自动恢复，父 Supervisor 需要被唤醒以处理失败。
  // 因此这里的 "done or stuck" 集合比 isTerminalUnitStatus 更宽泛。
  const doneOrStuckStatuses = new Set([
    "succeeded", "terminal_failed", "cancelled", "superseded", "retryable_failed",
  ]);
  const stillRunning = siblings.filter((s) => !doneOrStuckStatuses.has(s.status));

  if (stillRunning.length > 0) {
    logger.info(
      {
        workspaceId,
        childUnitId,
        parentUnitId: childUnit.parentUnitId,
        totalSiblings: siblings.length,
        stillRunning: stillRunning.length,
        stillRunningIds: stillRunning.map((s) => ({ id: s.id, status: s.status })),
      },
      "resumeParentSupervisorIfNeeded: sibling 子任务仍在运行，跳过恢复",
    );
    return;
  }

  // 检查 parent unit 是否在等待子任务（防止竞态条件）
  // 修复 R8（第8轮）：原代码不检查 parent unit 的 status，
  // 当多个 child task 同时完成时，会创建多个重复的 resume job。
  // 正确行为：只有 parent 处于 waiting_child 状态时才恢复。
  // 使用 CAS（compare-and-swap）确保原子性：只有 status=waiting_child 时才更新为 running。
  const now = new Date();
  const [updatedParent] = await db
    .update(schema.cardGenerationUnits)
    .set({ status: "running", updatedAt: now })
    .where(and(
      eq(schema.cardGenerationUnits.id, childUnit.parentUnitId!),
      eq(schema.cardGenerationUnits.workspaceId, workspaceId),
      eq(schema.cardGenerationUnits.status, "waiting_child"),
    ))
    .returning({
      id: schema.cardGenerationUnits.id,
      cursorJson: schema.cardGenerationUnits.cursorJson,
      runId: schema.cardGenerationUnits.runId,
    });

  if (!updatedParent) {
    // P0-06 修复：父子竞态处理。
    // parent 不在 waiting_child 状态，可能是因为:
    // 1. parent 已被恢复（正常）
    // 2. parent 已终态（正常）
    // 3. parent 仍在处理当前 turn（running/agent_running），尚未切换到 waiting_child
    //
    // 对于情况 3，如果所有 sibling 都已终态，需要确保 parent 最终会被恢复。
    // 当前不立即创建 resume job（避免与正在执行的 turn 冲突），
    // 而是记录警告，由 reconciler 定期检查并补投 resume。
    const [parentStatus] = await db
      .select({ status: schema.cardGenerationUnits.status })
      .from(schema.cardGenerationUnits)
      .where(and(
        eq(schema.cardGenerationUnits.id, childUnit.parentUnitId!),
        eq(schema.cardGenerationUnits.workspaceId, workspaceId),
      ))
      .limit(1);

    if (parentStatus && !isTerminalUnitStatus(parentStatus.status)) {
      logger.warn(
        {
          workspaceId,
          childUnitId,
          parentUnitId: childUnit.parentUnitId,
          parentStatus: parentStatus.status,
          totalSiblings: siblings.length,
          allSiblingsTerminal: stillRunning.length === 0,
        },
        "resumeParentSupervisorIfNeeded: parent 非终态但不在 waiting_child（竞态），reconciler 将补投 resume",
      );
    } else {
      logger.info(
        { workspaceId, childUnitId, parentUnitId: childUnit.parentUnitId, parentStatus: parentStatus?.status },
        "resumeParentSupervisorIfNeeded: parent 已终态或已被恢复，跳过",
      );
    }
    return;
  }

  const parentUnit = updatedParent;

  // 从 parent unit 的 cursorJson 中恢复正确的 turnNo（计划 §5.3）
  const parentCursor = (parentUnit.cursorJson as Record<string, unknown> | null) ?? null;
  const parentTurnNo = parentCursor
    ? Number(parentCursor.turnNo ?? 0) + 1
    : 1;

  // 跨 workspace 对账补投（jobs RLS 重开）：经 SECURITY DEFINER 函数入队
  await db.execute(sql`
    SELECT public.ailearn_enqueue_agent_turn_job(
      ${workspaceId}, ${requestedBy}, ${childUnit.runId}, ${childUnit.parentUnitId},
      ${parentTurnNo},
      ${createHash("sha256")
        .update(JSON.stringify({
          runId: childUnit.runId,
          unitId: childUnit.parentUnitId,
          turnNo: parentTurnNo,
        }))
        .digest("hex")},
      80, 'card_foreground',
      ${`agent-turn:${childUnit.runId}:${childUnit.parentUnitId}:${parentTurnNo}`},
      ${requestedBy}
    )
  `);

  // 更新 parent unit 的 scheduledAt
  await db
    .update(schema.cardGenerationUnits)
    .set({ scheduledAt: now, updatedAt: now })
    .where(and(
      eq(schema.cardGenerationUnits.id, childUnit.parentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, workspaceId),
    ));

  logger.info(
    { runId: childUnit.runId, parentUnitId: childUnit.parentUnitId, childUnitId },
    "子任务完成，已恢复父 Supervisor",
  );
}

// ─── P0-06: Reconciler ──────────────────────────────────────────────────────

/**
 * P0-06 修复：Reconciler — 修复卡死的 Supervisor 和终态 run 的残留 unit。
 *
 * 此函数应在以下场景被调用：
 * 1. 每个 child task 完成后（作为 resumeParentSupervisorIfNeeded 的补充）
 * 2. run 进入终态时
 * 3. 定时任务（如每 60 秒）
 *
 * 功能：
 * A. 补投 resume：找到 waiting_child 状态的 parent unit，其所有 children 已终态，
 *    但没有对应的 pending/running job。为它们创建 resume job。
 * B. 终态 run 清理：找到终态 run 下的非终态 unit，取消它们。
 *
 * 返回操作统计。
 */
export async function reconcileStuckSupervisors(
  workspaceId?: string,
): Promise<{ resumedParents: number; cancelledUnits: number }> {
  let resumedParents = 0;
  let cancelledUnits = 0;

  try {
    // ─── A. 补投 resume ──────────────────────────────────────────────
    //
    // 查找所有 waiting_child 状态的 parent unit，检查其 children 是否全部终态。
    // 如果是，且没有对应的 pending job，则创建 resume job。
    const workspaceFilter = workspaceId
      ? eq(schema.cardGenerationUnits.workspaceId, workspaceId)
      : sql`TRUE`;

    const waitingParents = await db
      .select({
        id: schema.cardGenerationUnits.id,
        runId: schema.cardGenerationUnits.runId,
        workspaceId: schema.cardGenerationUnits.workspaceId,
        cursorJson: schema.cardGenerationUnits.cursorJson,
      })
      .from(schema.cardGenerationUnits)
      // 只补投非终态 run 的 resume job：终态 run（needs_attention/succeeded 等）
      // 的 supervisor 不应被恢复——恢复必然再次失败（如 budget_exhausted），
      // 且终态 run 的残留 unit 由下方 B 段统一取消。
      .innerJoin(schema.cardGenerationRuns, and(
        eq(schema.cardGenerationRuns.id, schema.cardGenerationUnits.runId),
        eq(schema.cardGenerationRuns.workspaceId, schema.cardGenerationUnits.workspaceId),
      ))
      .where(and(
        workspaceFilter,
        eq(schema.cardGenerationUnits.status, "waiting_child"),
        notInArray(schema.cardGenerationRuns.status, [...TERMINAL_RUN_STATUSES]),
      ));

    // PERF: 一次性批量加载所有 waiting_child parent 的 children，避免逐 parent
    // 一次 SELECT（N+1）。children 以 parentUnitId 唯一归属到父 unit。
    const waitingParentIds = waitingParents.map((p) => p.id);
    const allChildren = waitingParentIds.length > 0
      ? await db
          .select({
            id: schema.cardGenerationUnits.id,
            status: schema.cardGenerationUnits.status,
            parentUnitId: schema.cardGenerationUnits.parentUnitId,
          })
          .from(schema.cardGenerationUnits)
          .where(inArray(schema.cardGenerationUnits.parentUnitId, waitingParentIds))
      : [];
    const childrenByParent = new Map<string, Array<{ id: string; status: string }>>();
    for (const c of allChildren) {
      if (!c.parentUnitId) continue; // 查询已按 parentUnitId 过滤，防御性跳过
      const arr = childrenByParent.get(c.parentUnitId);
      if (arr) arr.push({ id: c.id, status: c.status });
      else childrenByParent.set(c.parentUnitId, [{ id: c.id, status: c.status }]);
    }

    // 包含 retryable_failed 在内的“需要恢复”状态
    const needsResumeStatuses = new Set([
      "succeeded", "terminal_failed", "retryable_failed", "cancelled", "superseded",
    ]);
    // 在内存中筛选：有 children 且全部终态 的 parent 才是可恢复候选。
    const resumableParents = waitingParents.filter((parent) => {
      const children = childrenByParent.get(parent.id) ?? [];
      if (children.length === 0) return false;
      return children.every((c) => needsResumeStatuses.has(c.status));
    });

    // 批量检查是否已有 pending/running job（跨 workspace 对账读经 SECURITY
    // DEFINER 函数；用 unnest 一次查询全部候选，替代逐 parent 一次 SELECT）。
    const existingJobByUnitId = new Map<string, string>();
    if (resumableParents.length > 0) {
      // 显式 `{uuid,...}::uuid[]` 字面量（drizzle+postgres-js 数组参数序列化
      // 不可靠，id 均来自本库 uuid 列，无逗号注入风险）。
      const wsLiteral = `{${resumableParents.map((p) => p.workspaceId).join(",")}}`;
      const runLiteral = `{${resumableParents.map((p) => p.runId).join(",")}}`;
      const unitLiteral = `{${resumableParents.map((p) => p.id).join(",")}}`;
      const activeRows = await db.execute<{ unit_id: string; job_id: string | null }>(sql`
        SELECT u.unit_id, public.ailearn_find_active_turn_job(
          u.workspace_id, u.run_id, u.unit_id
        ) AS job_id
        FROM unnest(
          ${wsLiteral}::uuid[], ${runLiteral}::uuid[], ${unitLiteral}::uuid[]
        ) AS u(workspace_id, run_id, unit_id)
      `);
      for (const row of activeRows) {
        if (row.job_id) existingJobByUnitId.set(String(row.unit_id), String(row.job_id));
      }
    }
    const toResume = resumableParents.filter((p) => !existingJobByUnitId.has(p.id));

    // 批量 CAS：waiting_child → running（单次 round-trip），并把 scheduledAt
    // 一并写入（原实现先 CAS 再单独 UPDATE scheduledAt，两个 round-trip）。
    const now = new Date();
    const casUpdated = toResume.length > 0
      ? await db
          .update(schema.cardGenerationUnits)
          .set({ status: "running", scheduledAt: now, updatedAt: now })
          .where(and(
            inArray(schema.cardGenerationUnits.id, toResume.map((p) => p.id)),
            eq(schema.cardGenerationUnits.status, "waiting_child"),
          ))
          .returning({ id: schema.cardGenerationUnits.id })
      : [];
    const casUpdatedIds = new Set(casUpdated.map((u) => u.id));

    for (const parent of toResume) {
      if (!casUpdatedIds.has(parent.id)) continue; // CAS 失败，状态已变

      // 创建 resume job（jobs RLS 重开：跨 workspace 对账写经 SECURITY DEFINER 函数）
      const parentCursor = (parent.cursorJson as Record<string, unknown> | null) ?? null;
      const parentTurnNo = parentCursor
        ? Number(parentCursor.turnNo ?? 0) + 1
        : 1;
      await db.execute(sql`
        SELECT public.ailearn_enqueue_agent_turn_job(
          ${parent.workspaceId}, NULL, ${parent.runId}, ${parent.id},
          ${parentTurnNo},
          ${createHash("sha256")
            .update(JSON.stringify({
              runId: parent.runId,
              unitId: parent.id,
              turnNo: parentTurnNo,
            }))
            .digest("hex")},
          80, 'card_foreground',
          ${`agent-turn:${parent.runId}:${parent.id}:${parentTurnNo}`},
          'system-reconciler'
        )
      `);

      resumedParents++;
      logger.info(
        { runId: parent.runId, parentUnitId: parent.id, childCount: childrenByParent.get(parent.id)?.length ?? 0 },
        "reconcileStuckSupervisors: 补投 resume job",
      );
    }

    // ─── B. 终态 run 清理 ────────────────────────────────────────────
    //
    // 查找终态 run 下的非终态 unit，取消它们。
    // 与 reconciler.ts 的 DEAD_TERMINAL_RUN_STATUSES 语义一致：needs_attention
    // 是"需注意/可恢复"状态，其下非终态 unit 不得被取消（否则 /retry 检查点
    // 被静默删除，用户明确的重试意图丢失）。
    const deadTerminalRunStatusList = TERMINAL_RUN_STATUSES.filter(
      (s) => s !== SupervisorRunStatus.NEEDS_ATTENTION,
    );
    const terminalRuns = await db
      .select({
        id: schema.cardGenerationRuns.id,
        workspaceId: schema.cardGenerationRuns.workspaceId,
        status: schema.cardGenerationRuns.status,
      })
      .from(schema.cardGenerationRuns)
      .where(and(
        workspaceId
          ? eq(schema.cardGenerationRuns.workspaceId, workspaceId)
          : sql`TRUE`,
        inArray(schema.cardGenerationRuns.status, [...deadTerminalRunStatusList]),
      ));

    for (const run of terminalRuns) {
      const result = await db
        .update(schema.cardGenerationUnits)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(schema.cardGenerationUnits.runId, run.id),
          eq(schema.cardGenerationUnits.workspaceId, run.workspaceId),
          inArray(schema.cardGenerationUnits.status, [...NON_TERMINAL_UNIT_STATUSES]),
        ))
        .returning({ id: schema.cardGenerationUnits.id });

      if (result.length > 0) {
        cancelledUnits += result.length;
        logger.warn(
          { runId: run.id, runStatus: run.status, cancelledUnitCount: result.length },
          "reconcileStuckSupervisors: 终态 run 下发现并取消非终态 unit",
        );
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        workspaceId,
        error: sanitizeOperationalError(err),
        resumedParents,
        cancelledUnits,
        // 诊断可观测性：与 handler 的 catch 日志一致，development 下保留完整错误消息，
        // 否则 sanitizeOperationalError 只保留 category/name/code（隐私设计），
        // "column does not exist" 类 DB 错误会被归为 unknown 且无 code，难以定位。
        ...(process.env.NODE_ENV === "development"
          ? { detail: errorMessage }
          : {}),
      },
      "reconcileStuckSupervisors: 执行失败",
    );
  }

  if (resumedParents > 0 || cancelledUnits > 0) {
    logger.info(
      { workspaceId, resumedParents, cancelledUnits },
      "reconcileStuckSupervisors: 完成",
    );
  }

  return { resumedParents, cancelledUnits };
}
