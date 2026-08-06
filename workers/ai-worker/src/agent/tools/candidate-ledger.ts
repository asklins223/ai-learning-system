/**
 * Candidate Ledger 工具（计划 §6.1, §9.5）
 *
 * Supervisor 工具：
 * - read_candidate_ledger: 读取候选和 ledger hash
 * - apply_candidate_operations: merge/exclude/calibrate/group
 *
 * 不变量（G4, §9.5）：
 * - 所有 Agent 只返回 opaque evidence ID
 * - typed ops、evidence union、矛盾保护
 * - CAS（Compare-And-Swap）：操作必须基于最新 ledger hash
 */

import { and, eq, desc, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../../db.ts";
import * as schema from "../../schema/index.ts";
import { CandidateLedger } from "../candidate-ledger.ts";
import { logger } from "../../lib/logger.ts";
import type { ToolCallRequest, ToolCallResult } from "./executor.ts";

/** Candidate Ledger 工具执行器 */
export async function executeCandidateLedgerTool(
  call: ToolCallRequest,
  ctx: CandidateLedgerToolContext,
): Promise<ToolCallResult> {
  switch (call.name) {
    case "read_candidate_ledger":
      return await handleReadCandidateLedger(call, ctx);
    case "apply_candidate_operations":
      return await handleApplyCandidateOperations(call, ctx);
    default:
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        result: null,
        error: `unknown candidate ledger tool: ${call.name}`,
      };
  }
}

export interface CandidateLedgerToolContext {
  runId: string;
  workspaceId: string;
  agentUnitId: string;
  turnNo: number;
  candidateLedger: CandidateLedger;
}

/** read_candidate_ledger: 读取候选列表 */
async function handleReadCandidateLedger(
  call: ToolCallRequest,
  ctx: CandidateLedgerToolContext,
): Promise<ToolCallResult> {
  const args = call.arguments as { cursor?: string; limit?: number };
  const limit = Math.min(args.limit ?? 50, 100);

  // 从 DB 读取候选
  const candidates = await db
    .select({
      id: schema.cardGenerationCandidates.id,
      claim: schema.cardGenerationCandidates.claim,
      topic: schema.cardGenerationCandidates.topic,
      cognitiveType: schema.cardGenerationCandidates.cognitiveType,
      importance: schema.cardGenerationCandidates.importance,
      sectionKey: schema.cardGenerationCandidates.sectionKey,
      candidateKind: schema.cardGenerationCandidates.candidateKind,
      validationStatus: schema.cardGenerationCandidates.validationStatus,
      groupKey: schema.cardGenerationCandidates.groupKey,
      importanceScore: schema.cardGenerationCandidates.importanceScore,
      bundleId: (schema.cardGenerationCandidates as any).bundleId,
    })
    .from(schema.cardGenerationCandidates)
    .where(and(
      eq(schema.cardGenerationCandidates.runId, ctx.runId),
      eq(schema.cardGenerationCandidates.workspaceId, ctx.workspaceId),
    ))
    .orderBy(desc(schema.cardGenerationCandidates.createdAt))
    .limit(limit);

  const ledgerHash = ctx.candidateLedger.getHash();

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      ledgerHash,
      count: candidates.length,
      candidates: candidates.map((c) => ({
        candidateId: c.id,
        claim: c.claim,
        topic: c.topic,
        cognitiveType: c.cognitiveType,
        importance: c.importance,
        sectionKey: c.sectionKey,
        candidateKind: c.candidateKind,
        validationStatus: c.validationStatus,
        groupKey: c.groupKey,
        importanceScore: c.importanceScore,
        bundleId: c.bundleId ?? null,
      })),
    },
  };
}

/** apply_candidate_operations: 应用 typed 候选操作 */
async function handleApplyCandidateOperations(
  call: ToolCallRequest,
  ctx: CandidateLedgerToolContext,
): Promise<ToolCallResult> {
  const args = call.arguments as {
    baseHash: string;
    operations: Array<Record<string, unknown>>;
  };

  if (!args.operations || args.operations.length === 0) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: "operations 不能为空",
    };
  }

  // noteVersionId：持久化 candidate_evidence 行时必填
  const [runRow] = await db
    .select({ noteVersionId: schema.cardGenerationRuns.noteVersionId })
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationRuns.id, ctx.runId),
    ))
    .limit(1);
  const noteVersionId = runRow?.noteVersionId ?? null;

  /**
   * 为候选写入证据绑定行（merge/split 产生的候选必须继承证据）。
   * ledger 中的 evidenceRefId 就是 note_evidence_spans.id 或 note_image_evidence_units.id，
   * 按 refIds 精确查询以区分 text_span 与 image_evidence。
   */
  async function persistEvidenceRefs(candidateDbId: string, refIds: string[]): Promise<void> {
    if (!noteVersionId || refIds.length === 0) return;
    const spanRows = await db
      .select({ id: schema.noteEvidenceSpans.id })
      .from(schema.noteEvidenceSpans)
      .where(inArray(schema.noteEvidenceSpans.id, refIds));
    const spanIdSet = new Set(spanRows.map((r) => r.id));
    const seen = new Set<string>();
    let ordinal = 0;
    for (const refId of refIds) {
      if (seen.has(refId)) continue;
      seen.add(refId);
      const isTextSpan = spanIdSet.has(refId);
      await db.insert(schema.cardGenerationCandidateEvidence).values({
        workspaceId: ctx.workspaceId,
        runId: ctx.runId,
        noteVersionId,
        candidateId: candidateDbId,
        sourceKind: isTextSpan ? "text_span" : "image_evidence",
        evidenceSpanId: isTextSpan ? refId : null,
        imageEvidenceUnitId: isTextSpan ? null : refId,
        ordinal,
        sourceVerificationStatus: "verified",
        sourceVerificationMethod: "ledger_op",
        createdAt: new Date(),
      } as any).onConflictDoNothing();
      ordinal++;
    }
  }

  /** 插入 merge/split 产生的合成候选（id 与内存 ledger 一致）。 */
  async function insertSyntheticCandidate(entry: {
    candidateId: string;
    claim: string;
    topic: string;
    sectionKey: string;
    cognitiveType: string;
    importance: string;
    candidateKind: string;
    derivedCandidateIds: string[];
    bundleId: string | null;
    validationStatus: string;
    exclusionReason: string | null;
  }): Promise<string | null> {
    const [inserted] = await db.insert(schema.cardGenerationCandidates).values({
      id: entry.candidateId,
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      unitId: ctx.agentUnitId,
      localOrdinal: 0,
      localId: entry.candidateId,
      claim: entry.claim,
      normalizedClaimHash: createHash("sha256").update(entry.claim, "utf8").digest("hex"),
      topic: entry.topic,
      sectionKey: entry.sectionKey,
      cognitiveType: entry.cognitiveType,
      importance: entry.importance,
      validationStatus: entry.validationStatus,
      exclusionReason: entry.exclusionReason,
      candidateKind: entry.candidateKind,
      derivedCandidateIds: entry.derivedCandidateIds,
      bundleId: entry.bundleId,
    } as any).onConflictDoNothing().returning({ id: schema.cardGenerationCandidates.id });
    if (inserted) return inserted.id;
    // 幂等命中（崩溃重放）：按 id 查询已有行
    const [existing] = await db
      .select({ id: schema.cardGenerationCandidates.id })
      .from(schema.cardGenerationCandidates)
      .where(and(
        eq(schema.cardGenerationCandidates.workspaceId, ctx.workspaceId),
        eq(schema.cardGenerationCandidates.runId, ctx.runId),
        eq(schema.cardGenerationCandidates.id, entry.candidateId),
      ))
      .limit(1);
    return existing?.id ?? null;
  }

  // P1-09 修复：一个 batch 在单次 CAS 内执行，内部顺序更新 ledger hash。
  // 原代码对每个操作都传入 args.baseHash，第一项后 CAS 必然失败。
  // 修复后：只在开始时做一次 CAS，后续操作使用前一个操作更新后的 hash。
  //
  // P1-15 修复（CAS advisory）：模型提供的 baseHash 不再硬性阻断。
  // 观测：模型经常编造 baseHash（如 "ledger:hash:123456"），与 read_candidate_ledger
  // 返回的真实 hash 不符，导致 CAS 100% 失败，Supervisor 陷入无限
  // read_candidate_ledger 自旋。由于同一 run 的 turn 由 job lease 串行执行，
  // 无并发写入风险。修复后：baseHash 不匹配仅记录警告并继续执行，
  // 使用服务端权威当前 hash。DB 层 hash 校验仍然存在（下述），
  // 用于检测持久化失败或异常并发。
  let currentHash = ctx.candidateLedger.getHash();
  if (args.baseHash && args.baseHash !== currentHash) {
    logger.warn(
      {
        runId: ctx.runId,
        turnNo: ctx.turnNo,
        expectedBaseHash: currentHash,
        providedBaseHash: args.baseHash,
      },
      "P1-15: baseHash 不匹配（advisory），使用服务端权威 hash 继续执行",
    );
  }

  const results: Array<Record<string, unknown>> = [];

  for (const op of args.operations) {
    try {
      const candidateOp = {
        type: op.type as "merge" | "exclude" | "calibrate" | "group" | "split" | "restore" | "adjust_support",
        candidateIds: (op.candidateIds as string[]) ?? [],
        reasonCode: String(op.reasonCode ?? "unspecified"),
        mergedClaim: op.mergedClaim as string | undefined,
        unionEvidenceRefIds: op.unionEvidenceRefIds as string[] | undefined,
        excludeReason: op.excludeReason as string | undefined,
        adjustedImportance: op.adjustedImportance as "detail" | "supporting" | "core" | undefined,
        groupKey: op.groupKey as string | undefined,
        splitClaims: op.splitClaims as string[] | undefined,
      };

      // P1-09: 使用当前 hash 作为 CAS 基础，而非原始 args.baseHash
      const result = ctx.candidateLedger.applyOperation(candidateOp, currentHash);
      // 更新 hash 供下一项操作使用
      currentHash = ctx.candidateLedger.getHash();

      // 持久化到 DB（与内存 ledger 状态一致，确保 P1-09 重载 hash 校验通过）
      if (result.operationType === "merge" && result.createdNew) {
        // 创建新的 canonical 候选（id 与内存 ledger 一致）
        const merged = ctx.candidateLedger.getCandidate(result.resultCandidateId);
        if (merged) {
          const dbId = await insertSyntheticCandidate({
            candidateId: result.resultCandidateId,
            claim: merged.claim,
            topic: merged.topic,
            sectionKey: merged.sectionKey,
            cognitiveType: merged.cognitiveType,
            importance: merged.importance,
            candidateKind: "canonical",
            derivedCandidateIds: merged.derivedCandidateIds,
            bundleId: merged.bundleId,
            validationStatus: "accepted",
            exclusionReason: null,
          });
          if (dbId) await persistEvidenceRefs(dbId, merged.evidenceRefIds);
        }

        // 标记原候选为 merged
        for (const removedId of result.removedCandidateIds) {
          await db.update(schema.cardGenerationCandidates).set({
            validationStatus: "merged",
            exclusionReason: `merged into ${result.resultCandidateId}`,
          }).where(and(
            eq(schema.cardGenerationCandidates.workspaceId, ctx.workspaceId),
            eq(schema.cardGenerationCandidates.runId, ctx.runId),
            eq(schema.cardGenerationCandidates.id, removedId),
          ));
        }
      } else if (result.operationType === "split" && result.createdNew) {
        // 拆分出的 derived 候选（每个 splitClaims 一个，id 与内存 ledger 一致）
        for (const createdId of result.createdCandidateIds ?? []) {
          const created = ctx.candidateLedger.getCandidate(createdId);
          if (!created) continue;
          const dbId = await insertSyntheticCandidate({
            candidateId: created.candidateId,
            claim: created.claim,
            topic: created.topic,
            sectionKey: created.sectionKey,
            cognitiveType: created.cognitiveType,
            importance: created.importance,
            candidateKind: created.candidateKind,
            derivedCandidateIds: created.derivedCandidateIds,
            bundleId: created.bundleId,
            validationStatus: "accepted",
            exclusionReason: null,
          });
          if (dbId) await persistEvidenceRefs(dbId, created.evidenceRefIds);
        }

        // 标记原候选为 split，并持久化 derivedCandidateIds（hash 包含该字段）
        const createdIds = result.createdCandidateIds ?? [];
        for (const candidateId of candidateOp.candidateIds) {
          const [existing] = await db
            .select({ derivedCandidateIds: schema.cardGenerationCandidates.derivedCandidateIds })
            .from(schema.cardGenerationCandidates)
            .where(and(
              eq(schema.cardGenerationCandidates.workspaceId, ctx.workspaceId),
              eq(schema.cardGenerationCandidates.runId, ctx.runId),
              eq(schema.cardGenerationCandidates.id, candidateId),
            ))
            .limit(1);
          // 只记录属于该原候选的拆分结果（derived 候选的 derivedCandidateIds 指向其来源）
          const ownDerivedIds = createdIds.filter((cid) =>
            ctx.candidateLedger.getCandidate(cid)?.derivedCandidateIds.includes(candidateId),
          );
          await db.update(schema.cardGenerationCandidates).set({
            validationStatus: "split",
            exclusionReason: `split: ${candidateOp.reasonCode}`,
            derivedCandidateIds: [...((existing?.derivedCandidateIds as string[]) ?? []), ...ownDerivedIds],
          }).where(and(
            eq(schema.cardGenerationCandidates.workspaceId, ctx.workspaceId),
            eq(schema.cardGenerationCandidates.runId, ctx.runId),
            eq(schema.cardGenerationCandidates.id, candidateId),
          ));
        }
      } else if (result.operationType === "restore") {
        // 恢复被排除的候选
        for (const candidateId of candidateOp.candidateIds) {
          await db.update(schema.cardGenerationCandidates).set({
            validationStatus: "accepted",
            exclusionReason: null,
          }).where(and(
            eq(schema.cardGenerationCandidates.workspaceId, ctx.workspaceId),
            eq(schema.cardGenerationCandidates.runId, ctx.runId),
            eq(schema.cardGenerationCandidates.id, candidateId),
          ));
        }
      } else if (result.operationType === "adjust_support") {
        // 调整候选的证据绑定
        for (const candidateId of candidateOp.candidateIds) {
          await db.delete(schema.cardGenerationCandidateEvidence).where(and(
            eq(schema.cardGenerationCandidateEvidence.workspaceId, ctx.workspaceId),
            eq(schema.cardGenerationCandidateEvidence.runId, ctx.runId),
            eq(schema.cardGenerationCandidateEvidence.candidateId, candidateId),
          ));
          if (candidateOp.unionEvidenceRefIds && candidateOp.unionEvidenceRefIds.length > 0) {
            await persistEvidenceRefs(candidateId, candidateOp.unionEvidenceRefIds);
          }
        }
      } else if (result.operationType === "exclude") {
        // 标记候选为 excluded
        for (const candidateId of candidateOp.candidateIds) {
          await db.update(schema.cardGenerationCandidates).set({
            validationStatus: "excluded",
            exclusionReason: candidateOp.excludeReason ?? candidateOp.reasonCode,
          }).where(and(
            eq(schema.cardGenerationCandidates.workspaceId, ctx.workspaceId),
            eq(schema.cardGenerationCandidates.runId, ctx.runId),
            eq(schema.cardGenerationCandidates.id, candidateId),
          ));
        }
      } else if (result.operationType === "calibrate" || result.operationType === "group") {
        // 更新候选的 group 或 importance
        const updateData: Record<string, unknown> = {};
        if (candidateOp.adjustedImportance) updateData.importance = candidateOp.adjustedImportance;
        if (candidateOp.groupKey !== undefined) updateData.groupKey = candidateOp.groupKey;

        if (Object.keys(updateData).length > 0) {
          for (const candidateId of candidateOp.candidateIds) {
            await db.update(schema.cardGenerationCandidates).set(updateData).where(and(
              eq(schema.cardGenerationCandidates.workspaceId, ctx.workspaceId),
              eq(schema.cardGenerationCandidates.runId, ctx.runId),
              eq(schema.cardGenerationCandidates.id, candidateId),
            ));
          }
        }
      }

      results.push({
        operationType: result.operationType,
        resultCandidateId: result.resultCandidateId,
        createdNew: result.createdNew,
        removedCandidateIds: result.removedCandidateIds,
        createdCandidateIds: result.createdCandidateIds ?? [],
      });
    } catch (err) {
      results.push({
        error: err instanceof Error ? err.message : String(err),
        operation: op,
      });
    }
  }

  const newLedgerHash = ctx.candidateLedger.getHash();

  // P1-09: 操作完成后从 DB 重载候选，校验 ledger hash 一致性。
  // 确保内存中的 ledger 状态与 DB 持久化状态一致，防止并发修改或持久化失败导致的不一致。
  try {
    const dbCandidates = await db
      .select({
        id: schema.cardGenerationCandidates.id,
        candidateKind: schema.cardGenerationCandidates.candidateKind,
        claim: schema.cardGenerationCandidates.claim,
        topic: schema.cardGenerationCandidates.topic,
        cognitiveType: schema.cardGenerationCandidates.cognitiveType,
        importance: schema.cardGenerationCandidates.importance,
        sectionKey: schema.cardGenerationCandidates.sectionKey,
        validationStatus: schema.cardGenerationCandidates.validationStatus,
        groupKey: schema.cardGenerationCandidates.groupKey,
        exclusionReason: schema.cardGenerationCandidates.exclusionReason,
        derivedCandidateIds: schema.cardGenerationCandidates.derivedCandidateIds,
        bundleId: (schema.cardGenerationCandidates as any).bundleId,
      })
      .from(schema.cardGenerationCandidates)
      .where(and(
        eq(schema.cardGenerationCandidates.workspaceId, ctx.workspaceId),
        eq(schema.cardGenerationCandidates.runId, ctx.runId),
      ));

    // 加载候选的证据引用
    const dbCandidateIds = dbCandidates.map((c) => c.id);
    const dbEvidenceRows = dbCandidateIds.length > 0
      ? await db
          .select({
            candidateId: schema.cardGenerationCandidateEvidence.candidateId,
            evidenceSpanId: schema.cardGenerationCandidateEvidence.evidenceSpanId,
            imageEvidenceUnitId: schema.cardGenerationCandidateEvidence.imageEvidenceUnitId,
          })
          .from(schema.cardGenerationCandidateEvidence)
          .where(and(
            eq(schema.cardGenerationCandidateEvidence.workspaceId, ctx.workspaceId),
            eq(schema.cardGenerationCandidateEvidence.runId, ctx.runId),
            inArray(schema.cardGenerationCandidateEvidence.candidateId, dbCandidateIds),
          ))
          .orderBy(schema.cardGenerationCandidateEvidence.ordinal)
      : [];

    const dbEvidenceMap = new Map<string, string[]>();
    for (const ce of dbEvidenceRows) {
      const refId = ce.evidenceSpanId ?? ce.imageEvidenceUnitId;
      if (refId) {
        const existing = dbEvidenceMap.get(ce.candidateId) ?? [];
        existing.push(refId);
        dbEvidenceMap.set(ce.candidateId, existing);
      }
    }

    // 使用与 CandidateLedger._recomputeHashInternal() 相同的格式计算 hash
    const dbLedgerHash = createHash("sha256")
      .update(JSON.stringify({
        candidates: dbCandidates
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((c) => ({
            id: c.id,
            kind: c.candidateKind,
            bundleId: c.bundleId,
            claim: c.claim,
            topic: c.topic,
            cognitiveType: c.cognitiveType,
            importance: c.importance,
            sectionKey: c.sectionKey,
            status: c.validationStatus,
            evidence: dbEvidenceMap.get(c.id) ?? [],
            groupKey: c.groupKey,
            exclusionReason: c.exclusionReason,
            derivedCandidateIds: c.derivedCandidateIds ?? [],
          })),
      }), "utf8")
      .digest("hex");

    if (dbLedgerHash !== newLedgerHash) {
      logger.error(
        {
          runId: ctx.runId,
          inMemoryHash: newLedgerHash,
          dbHash: dbLedgerHash,
          dbCandidateCount: dbCandidates.length,
          inMemoryCount: ctx.candidateLedger.getAllCandidates().length,
        },
        "P1-09: ledger hash 不一致（内存 vs DB），可能存在并发修改或持久化失败",
      );
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        result: null,
        error: `ledger hash 不一致：内存与 DB 状态不同步，请重新读取最新 ledger`,
      };
    }

    logger.info(
      { runId: ctx.runId, operationCount: results.length, newLedgerHash, dbCandidateCount: dbCandidates.length },
      "apply_candidate_operations: 操作完成，ledger hash 已验证一致",
    );
  } catch (verifyErr) {
    // 校验过程出错不应阻断操作（操作已持久化），但需记录警告
    logger.warn(
      { runId: ctx.runId, error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr) },
      "P1-09: ledger hash 校验过程出错（非致命，操作已持久化）",
    );
  }

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      newLedgerHash,
      results,
    },
  };
}
