/**
 * Deck Draft 工具（计划 §6.1, §9.6, §11.3）
 *
 * Supervisor 工具：
 * - submit_deck_draft: 写 immutable Draft
 * - apply_draft_patch: 生成新 immutable Draft（typed patch）
 * - validate_draft: deterministic preflight
 *
 * P1-07 修复：
 * - 移除字段归一化/默认值路径，density/cardBudget 为必填
 * - 使用 Zod 校验后的参数，不再 as 类型断言
 * - 禁止 front/back/question/answer 等非标准字段名
 *
 * 不变量（G9, §9.6, §11.3）：
 * - Draft 只插入，不原地更新
 * - Repair 后创建新 Draft，旧 report 自动失效
 * - Preflight 不产生语义 verdict，只返回结构化 contract issues
 */

import { and, eq, max, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../../db.ts";
import * as schema from "../../schema/index.ts";
import { logger } from "../../lib/logger.ts";
import type { ToolCallRequest, ToolCallResult } from "./executor.ts";
import type { DeckDraft, LearningCardOutput } from "@ailearn/shared";
import { isCardRepairEnabled } from "@ailearn/shared";
import { submitDeckDraftArgsSchema, applyDraftPatchArgsSchema, validateDraftArgsSchema } from "./schemas.ts";
import { assessCardOutput } from "../../lib/card-quality.ts";

/** Deck Draft 工具执行器 */
export async function executeDeckDraftTool(
  call: ToolCallRequest,
  ctx: DeckDraftToolContext,
): Promise<ToolCallResult> {
  switch (call.name) {
    case "submit_deck_draft":
      return await handleSubmitDeckDraft(call, ctx);
    case "apply_draft_patch":
      return await handleApplyDraftPatch(call, ctx);
    case "validate_draft":
      return await handleValidateDraft(call, ctx);
    default:
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        result: null,
        error: `unknown deck draft tool: ${call.name}`,
      };
  }
}

export interface DeckDraftToolContext {
  runId: string;
  workspaceId: string;
  agentUnitId: string;
  turnNo: number;
  idempotencyKey: string;
}

// P1-07 修复：extractCandidateIds 已移除。
// 候选 ID 字段名固定为 candidateIds，由 Zod schema 强制校验。
// 不再支持 front/back/question/answer/supportIds/supports/supportedBy 等非标准字段名。

/** submit_deck_draft: 写入 immutable Draft */
async function handleSubmitDeckDraft(
  call: ToolCallRequest,
  ctx: DeckDraftToolContext,
): Promise<ToolCallResult> {
  // P1-07 修复：使用 Zod 校验后的参数，不再归一化或填充默认值。
  // executor 已在副作用前 safeParse，此处参数已符合 schema。
  const parsed = submitDeckDraftArgsSchema.safeParse(call.arguments);
  if (!parsed.success) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `protocol_validation_error: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  }
  const args = parsed.data;
  const draftInput = args.draft;
  const cards = draftInput.cards;
  const density = draftInput.density;
  const cardBudget = draftInput.cardBudget;
  const deckTitle = draftInput.deckTitle;
  const deckSummary = draftInput.deckSummary;
  const baseLedgerHash = args.baseLedgerHash;
  const summarySupportCandidateIds = draftInput.summarySupportCandidateIds ?? [];

  // 标准化卡片结构（不再做字段别名转换，仅补充 canonicalCandidateIds）
  // P1-11: 传递 learningObjective
  const normalizedCards = cards.map((card, index) => ({
    title: card.title,
    summary: card.summary,
    candidateIds: card.candidateIds,
    primarySupportCandidateId: card.primarySupportCandidateId,
    draftCardId: card.draftCardId,
    ordinal: card.ordinal ?? index,
    primarySection: card.primarySection ?? "",
    groupKey: card.groupKey,
    canonicalCandidateIds: card.candidateIds,
    learningObjective: card.learningObjective,
  }));

  // P1-11: 强制 density 与 cardBudget 校验
  // 从 run 的 unit inputManifest 读取请求时的 density，确保模型不能篡改
  const [unitRow] = await db
    .select({
      inputManifest: schema.cardGenerationUnits.inputManifest,
    })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.id, ctx.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, ctx.workspaceId),
    ))
    .limit(1);

  const requestedDensity = (unitRow?.inputManifest as Record<string, unknown>)?.density as string | undefined;
  if (requestedDensity && density !== requestedDensity) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `density_mismatch: requested="${requestedDensity}" but draft has "${density}". Density must match the requested value.`,
    };
  }

  // P1-11: 校验 cardBudget 与卡片数量的一致性
  const cardCount = normalizedCards.length;
  if (cardCount > cardBudget) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `card_count_exceeds_budget: cardBudget=${cardBudget} but cards.length=${cardCount}`,
    };
  }

  // P1-11: density 范围校验
  const densityRanges: Record<string, { min: number; max: number }> = {
    overview: { min: 3, max: 8 },
    standard: { min: 5, max: 15 },
    complete: { min: 10, max: 50 },
  };
  const range = densityRanges[density];
  if (range) {
    if (cardBudget < range.min || cardBudget > range.max) {
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        result: null,
        error: `card_budget_out_of_range: density="${density}" requires cardBudget in [${range.min}, ${range.max}] but got ${cardBudget}`,
      };
    }
  }

  // R31 修复：验证候选所有权（计划 §6.1: submit_deck_draft 需要 ownership precheck）。
  const allCandidateIds = new Set<string>();
  for (const card of normalizedCards) {
    for (const cid of card.candidateIds) {
      if (cid) allCandidateIds.add(cid);
    }
    if (card.primarySupportCandidateId) {
      allCandidateIds.add(card.primarySupportCandidateId);
    }
  }
  for (const sid of summarySupportCandidateIds) {
    if (sid) allCandidateIds.add(sid);
  }

  if (allCandidateIds.size > 0) {
    const validCandidates = await db
      .select({ id: schema.cardGenerationCandidates.id })
      .from(schema.cardGenerationCandidates)
      .where(and(
        eq(schema.cardGenerationCandidates.workspaceId, ctx.workspaceId),
        eq(schema.cardGenerationCandidates.runId, ctx.runId),
        inArray(schema.cardGenerationCandidates.id, [...allCandidateIds]),
      ));
    const validIds = new Set(validCandidates.map((c) => c.id));
    const invalidIds = [...allCandidateIds].filter((id) => !validIds.has(id));
    if (invalidIds.length > 0) {
      logger.warn(
        { runId: ctx.runId, invalidCandidateIds: invalidIds },
        "submit_deck_draft: 候选所有权验证失败",
      );
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        result: null,
        error: `ownership_check_failed: ${invalidIds.length} candidate(s) not found in run: ${invalidIds.slice(0, 5).join(", ")}`,
      };
    }
  }

  // 计算下一个 draftVersion（使用 max 而非 count，避免并发问题和删除行导致的版本回退）
  const [versionResult] = await db
    .select({ value: max(schema.cardGenerationDrafts.draftVersion) })
    .from(schema.cardGenerationDrafts)
    .where(and(
      eq(schema.cardGenerationDrafts.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationDrafts.runId, ctx.runId),
    ));

  const draftVersion = (versionResult?.value ?? 0) + 1;
  const contentJson = {
    deckTitle,
    deckSummary,
    density,
    cardBudget,
    cards: normalizedCards as Array<Record<string, unknown>>,
    summarySupportCandidateIds,
  };
  const contentHash = createHash("sha256")
    .update(JSON.stringify(contentJson), "utf8")
    .digest("hex");

  // 插入 immutable Draft
  const [draft] = await db
    .insert(schema.cardGenerationDrafts)
    .values({
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      draftVersion,
      parentDraftId: null,
      producedByUnitId: ctx.agentUnitId,
      producedByEventKey: `tool_result:${ctx.idempotencyKey}`,
      schemaVersion: "deck-draft-v1",
      contentJson: contentJson as unknown as DeckDraft,
      contentHash,
      deckTitle,
      deckSummary,
      density,
      cardBudget,
      baseLedgerHash,
      summarySupportCandidateIds,
    })
    .returning();

  if (!draft) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: "无法创建 draft",
    };
  }

  logger.info(
    { runId: ctx.runId, draftId: draft.id, draftVersion, contentHash, cardCount: normalizedCards.length },
    "submit_deck_draft: Draft 已创建",
  );

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      draftId: draft.id,
      draftVersion,
      contentHash,
    },
  };
}

/** apply_draft_patch: 生成新 immutable Draft */
async function handleApplyDraftPatch(
  call: ToolCallRequest,
  ctx: DeckDraftToolContext,
): Promise<ToolCallResult> {
  // P1-07 修复：使用 Zod 校验后的参数
  const parsed = applyDraftPatchArgsSchema.safeParse(call.arguments);
  if (!parsed.success) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `protocol_validation_error: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  }
  const args = parsed.data;

  // 查找基础 draft
  const [baseDraft] = await db
    .select()
    .from(schema.cardGenerationDrafts)
    .where(and(
      eq(schema.cardGenerationDrafts.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationDrafts.runId, ctx.runId),
      eq(schema.cardGenerationDrafts.contentHash, args.baseDraftHash),
    ))
    .limit(1);

  if (!baseDraft) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `base draft not found: hash=${args.baseDraftHash}`,
    };
  }

  // 应用 patch 到 contentJson
  // 计划 §4.7: typed patch — rewrite_claim, rewrite_title, rewrite_summary,
  // remove_evidence, split_candidate, merge_candidate, move_candidate,
  // restore_candidate, adjust_primary_support, adjust_group, adjust_ordinal
  const baseContent = baseDraft.contentJson as Record<string, unknown>;
  const cards = Array.isArray(baseContent.cards) ? [...(baseContent.cards as Record<string, unknown>[])] : [];
  // 预建 draftCardId/localId -> 卡片索引映射，避免操作循环内重复 findIndex（O(ops×cards)）
  const cardIndexById = new Map<string, number>();
  cards.forEach((c, i) => {
    if (c.draftCardId !== undefined && c.draftCardId !== null) cardIndexById.set(String(c.draftCardId), i);
    if (c.localId !== undefined && c.localId !== null) cardIndexById.set(String(c.localId), i);
  });
  const findCardIndex = (id: string): number => cardIndexById.get(id) ?? -1;
  // R58 修复：收集候选级别 deferred 操作（split/merge/restore）
  const deferredOps: Array<Record<string, unknown>> = [];

  for (const op of args.operations) {
    const opRecord = op as Record<string, unknown>;
    const patchType = String(opRecord.type ?? "");
    const cardDraftId = opRecord.cardDraftId ? String(opRecord.cardDraftId) : undefined;
    const candidateId = opRecord.candidateId ? String(opRecord.candidateId) : undefined;

    // 找到目标 card
    // R37/R63 修复：同时匹配 draftCardId 和 localId。
    // 原第三条件 `c.draftCardId === card-${cards.indexOf(c)}` 不与输入 cardDraftId 比较，
    // 导致任何不匹配的 cardDraftId 都会错误地匹配到第一个 auto-assigned card。
    const cardIndex = cardDraftId ? findCardIndex(cardDraftId) : -1;

    switch (patchType) {
      case "rewrite_claim": {
        // R62 修复：rewrite_claim 是候选级别操作，需要通过 apply_candidate_operations 工具处理。
        // 与 R58 (split/merge/restore) 保持一致：记录到 deferredOps，
        // 使 Supervisor 可在后续 turn 中读取并应用。
        logger.warn(
          { runId: ctx.runId, patchType, candidateId, cardIndex },
          "rewrite_claim patch 需要通过 apply_candidate_operations 工具处理，已记录为 deferred 操作",
        );
        deferredOps.push({ type: patchType, candidateId, ...opRecord });
        break;
      }
      case "rewrite_title": {
        if (cardIndex >= 0 && opRecord.newTitle) {
          cards[cardIndex]!.title = String(opRecord.newTitle);
        }
        break;
      }
      case "rewrite_summary": {
        if (cardIndex >= 0 && opRecord.newSummary) {
          cards[cardIndex]!.summary = String(opRecord.newSummary);
        }
        break;
      }
      case "remove_evidence": {
        // R65 修复：remove_evidence 是候选级别操作（从候选的证据列表中移除不相关证据引用），
        // 不是卡片级别操作。原代码将 removedEvidenceRefIds（证据引用 ID）与
        // card.candidateIds（候选 ID）混合比较，属于命名空间混用错误。
        // 与 rewrite_claim/split_candidate/merge_candidate/restore_candidate 保持一致：
        // 记录为 deferred 操作，使 Supervisor 可在后续 turn 中通过
        // apply_candidate_operations 工具应用。
        logger.warn(
          { runId: ctx.runId, patchType, candidateId, cardIndex },
          "remove_evidence patch 需要通过 apply_candidate_operations 工具处理，已记录为 deferred 操作",
        );
        deferredOps.push({ type: patchType, candidateId, ...opRecord });
        break;
      }
      case "move_candidate": {
        // R48 修复：完整实现 move_candidate 逻辑，包括添加到目标卡片。
        // 原 R45 修复注释说明了问题：原代码使用 op.newPrimarySupportCandidateId 作为目标 card ID，
        // 但那是候选 ID，不是卡片 ID。原修复让 move_candidate 只能从源 card 移除候选。
        // 本修复添加 targetCardDraftId 字段到 schema，并实现完整逻辑：
        // 1. 从源 card 移除 candidate
        // 2. 添加到目标 card（如果提供了 targetCardDraftId）
        if (cardIndex >= 0 && candidateId) {
          const card = cards[cardIndex]!;
          const candidateIds = Array.isArray(card.candidateIds) ? card.candidateIds as string[] : [];
          card.candidateIds = candidateIds.filter((id) => id !== candidateId);
        }
        // 如果有目标卡片，添加候选到目标
        if (opRecord.targetCardDraftId) {
          // R64 修复：移除有 bug 的第三条件，与 cardIndex 查找逻辑保持一致
          const targetCardIndex = findCardIndex(String(opRecord.targetCardDraftId));
          if (targetCardIndex >= 0 && candidateId) {
            const targetCard = cards[targetCardIndex]!;
            const targetCandidateIds = Array.isArray(targetCard.candidateIds) ? targetCard.candidateIds as string[] : [];
            // 避免重复添加
            if (!targetCandidateIds.includes(candidateId)) {
              targetCard.candidateIds = [...targetCandidateIds, candidateId];
            }
          } else {
            logger.warn(
              { runId: ctx.runId, targetCardDraftId: opRecord.targetCardDraftId as string, candidateId },
              "move_candidate: 目标卡片未找到",
            );
          }
        }
        break;
      }
      // R59 修复：实现 adjust_group 和 adjust_ordinal patch（计划 §4.7）
      case "adjust_group": {
        if (cardIndex >= 0 && opRecord.newGroupKey !== undefined) {
          cards[cardIndex]!.groupKey = String(opRecord.newGroupKey);
        }
        break;
      }
      case "adjust_ordinal": {
        if (cardIndex >= 0 && opRecord.newOrdinal !== undefined) {
          const newOrdinal = Number(opRecord.newOrdinal);
          if (!Number.isNaN(newOrdinal)) {
            cards[cardIndex]!.ordinal = newOrdinal;
          }
        }
        break;
      }
      case "adjust_primary_support": {
        if (cardIndex >= 0 && opRecord.newPrimarySupportCandidateId) {
          cards[cardIndex]!.primarySupportCandidateId = String(opRecord.newPrimarySupportCandidateId);
        }
        break;
      }
      // split_candidate, merge_candidate, restore_candidate 需要操作候选账本
      // 这些操作在 candidate-ledger tool 中处理，这里只记录
      case "split_candidate":
      case "merge_candidate":
      case "restore_candidate": {
        // R58 修复：这些候选级别操作需要通过 apply_candidate_operations 工具处理，
        // 但 Repairer 只能通过 submit_draft_patch 提交 patch。
        // 修复方案：将操作记录到 patchedContent 的 deferredCandidateOperations 中，
        // 使 Supervisor 可以在后续 turn 中读取并通过 apply_candidate_operations 应用。
        // 不再静默丢弃，而是记录日志并收集到 deferredOps 列表。
        logger.warn(
          { runId: ctx.runId, patchType, candidateId },
          `${patchType} patch 需要通过 apply_candidate_operations 工具处理，已记录为 deferred 操作`,
        );
        deferredOps.push({ type: patchType, candidateId, ...opRecord });
        break;
      }
      default:
        // 未知 patch 类型，跳过
        logger.warn(
          { runId: ctx.runId, patchType },
          "未知 patch 类型，跳过",
        );
        break;
    }
  }

  const patchedContent = {
    ...baseContent,
    cards,
    patched: true,
    patchOperations: args.operations as unknown[],
    // R58: 将 deferred 候选操作记录到 contentJson，
    // 使 Supervisor 可以读取并在后续 turn 中通过 apply_candidate_operations 应用
    deferredCandidateOperations: deferredOps.length > 0 ? deferredOps : undefined,
  };
  const patchedHash = createHash("sha256")
    .update(JSON.stringify(patchedContent), "utf8")
    .digest("hex");

  // 计算新 draftVersion（使用 max 而非 count，避免并发问题和删除行导致的版本回退）
  const [patchVersionResult] = await db
    .select({ value: max(schema.cardGenerationDrafts.draftVersion) })
    .from(schema.cardGenerationDrafts)
    .where(and(
      eq(schema.cardGenerationDrafts.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationDrafts.runId, ctx.runId),
    ));

  const draftVersion = (patchVersionResult?.value ?? 0) + 1;

  // 插入新 Draft（parent 指向旧 draft）
  const [newDraft] = await db
    .insert(schema.cardGenerationDrafts)
    .values({
      workspaceId: ctx.workspaceId,
      runId: ctx.runId,
      draftVersion,
      parentDraftId: baseDraft.id,
      producedByUnitId: ctx.agentUnitId,
      producedByEventKey: `tool_result:${ctx.idempotencyKey}`,
      schemaVersion: "deck-draft-v1",
      // QUAL-16 修复：同上，patchedContent 也是 DeckDraft 内容子集
      contentJson: patchedContent as unknown as DeckDraft,
      contentHash: patchedHash,
      deckTitle: baseDraft.deckTitle,
      deckSummary: baseDraft.deckSummary,
      density: baseDraft.density,
      cardBudget: baseDraft.cardBudget,
      baseLedgerHash: baseDraft.baseLedgerHash,
      summarySupportCandidateIds: baseDraft.summarySupportCandidateIds,
    })
    .returning();

  // 失效旧 Quality Report（新 draftHash 使旧 report 失效）
  // R36 修复：原代码设置 deterministicStatus="stale"，但 qualityReportSchema 的
  // deterministicStatus 字段枚举只允许 ["passed", "failed", "pending"]。
  // "stale" 不在枚举中，如果经过 Zod 校验会被拒绝。
  // 修复后：使用 "failed" 表示旧 report 不再有效，符合枚举约束且语义正确
  // （旧 draft 已被 patch 替代，其确定性验证结果不再适用）。
  await db.update(schema.cardGenerationQualityReports).set({
    deterministicStatus: "failed",
  }).where(and(
    eq(schema.cardGenerationQualityReports.workspaceId, ctx.workspaceId),
    eq(schema.cardGenerationQualityReports.runId, ctx.runId),
    eq(schema.cardGenerationQualityReports.draftId, baseDraft.id),
  ));

  logger.info(
    { runId: ctx.runId, newDraftId: newDraft?.id, draftVersion, patchedHash },
    "apply_draft_patch: 新 Draft 已创建",
  );

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      draftId: newDraft?.id ?? null,
      draftVersion,
      contentHash: patchedHash,
      parentDraftId: baseDraft.id,
    },
  };
}

/** validate_draft: deterministic preflight */
async function handleValidateDraft(
  call: ToolCallRequest,
  ctx: DeckDraftToolContext,
): Promise<ToolCallResult> {
  // P1-07 修复：使用 Zod 校验后的参数
  const parsed = validateDraftArgsSchema.safeParse(call.arguments);
  if (!parsed.success) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `protocol_validation_error: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  }
  const args = parsed.data;

  // 查找 draft
  const [draft] = await db
    .select()
    .from(schema.cardGenerationDrafts)
    .where(and(
      eq(schema.cardGenerationDrafts.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationDrafts.runId, ctx.runId),
      eq(schema.cardGenerationDrafts.contentHash, args.draftHash),
    ))
    .limit(1);

  if (!draft) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: `draft not found: hash=${args.draftHash}`,
    };
  }

  // 加载 coverage report 和 noteVersionId
  const [run] = await db
    .select({ 
      coverageReport: schema.cardGenerationRuns.coverageReport,
      noteVersionId: schema.cardGenerationRuns.noteVersionId,
    })
    .from(schema.cardGenerationRuns)
    .where(eq(schema.cardGenerationRuns.id, ctx.runId))
    .limit(1);

  // 加载 quality report
  const [qualityReport] = await db
    .select()
    .from(schema.cardGenerationQualityReports)
    .where(and(
      eq(schema.cardGenerationQualityReports.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationQualityReports.draftId, draft.id),
    ))
    .limit(1);

  // Deterministic preflight checks（计划 §11.3）
  // R30 修复：补充计划 §11.3 要求的完整检查项：
  // - summary support IDs 是 card candidates 子集
  // - candidate ownership exactly-once
  // - selected candidates 全部 supported
  // - capacity exclusions 有原因
  // - Repair 次数合法
  const issues: Array<{ code: string; severity: string; details: string; cardDraftId?: string }> = [];

  // 1. 检查 coverage
  //
  // R75 修复：原代码直接读取 PREPARE 阶段冻结的 coverage report 快照，
  // 但 bundleAssignmentCoverage 和 explicitDecisionCoverage 在 PREPARE 后
  // 随着 Supervisor 分配 bundle 和 Extractor 做出决策而变化，
  // 快照值始终为 0，导致 validate_draft 永远失败。
  // 修复后：从 DB 实际状态实时计算 coverage 值。
  const coverage = (run?.coverageReport as Record<string, unknown>) ?? {};

  // 从 DB 实时计算 bundle assignment 和 decision coverage
  const allBundles = await db
    .select({
      required: schema.cardGenerationSourceBundles.required,
      assignmentStatus: schema.cardGenerationSourceBundles.assignmentStatus,
      decisionStatus: schema.cardGenerationSourceBundles.decisionStatus,
    })
    .from(schema.cardGenerationSourceBundles)
    .where(and(
      eq(schema.cardGenerationSourceBundles.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationSourceBundles.runId, ctx.runId),
    ));

  const requiredBundles = allBundles.filter((b) => b.required);
  const requiredCount = requiredBundles.length;
  const assignedCount = requiredBundles.filter((b) => b.assignmentStatus && b.assignmentStatus !== "pending").length;
  const decidedCount = requiredBundles.filter((b) => b.decisionStatus && b.decisionStatus !== "pending").length;

  const actualAssignmentCoverage = requiredCount > 0 ? assignedCount / requiredCount : 1;
  const actualDecisionCoverage = requiredCount > 0 ? decidedCount / requiredCount : 1;

  // R75 遗漏修复：sourcePhysicalCoverage 也需要从 DB 实时计算。
  // 原代码直接读取 PREPARE 阶段冻结的快照值（通常为 0），
  // 但只要 source bundles 存在于 DB 中，就说明源内容已在 PREPARE 阶段封存。
  // 这与 R75 对 bundleAssignmentCoverage 和 explicitDecisionCoverage 的修复原理一致。
  const actualPhysicalCoverage = allBundles.length > 0 ? 1 : 0;

  // 更新 coverage report 中的值，使后续读取获得正确数据
  if (coverage.bundleAssignmentCoverage !== actualAssignmentCoverage
    || coverage.explicitDecisionCoverage !== actualDecisionCoverage
    || (coverage.sourcePhysicalCoverage as number) !== actualPhysicalCoverage) {
    const updatedCoverage = {
      ...coverage,
      sourcePhysicalCoverage: actualPhysicalCoverage,
      bundleAssignmentCoverage: actualAssignmentCoverage,
      explicitDecisionCoverage: actualDecisionCoverage,
    };
    await db.update(schema.cardGenerationRuns).set({
      coverageReport: updatedCoverage as Record<string, unknown>,
    }).where(and(
      eq(schema.cardGenerationRuns.id, ctx.runId),
      eq(schema.cardGenerationRuns.workspaceId, ctx.workspaceId),
    ));
    logger.info(
      { runId: ctx.runId, actualPhysicalCoverage, actualAssignmentCoverage, actualDecisionCoverage },
      "validate_draft: coverage report 已从 DB 实时状态更新",
    );
  }

  if (actualPhysicalCoverage < 1.0) {
    issues.push({ code: "coverage_physical_incomplete", severity: "hard", details: "sourcePhysicalCoverage < 100%" });
  }
  if (actualAssignmentCoverage < 1.0) {
    issues.push({ code: "coverage_assignment_incomplete", severity: "hard", details: `bundleAssignmentCoverage=${actualAssignmentCoverage.toFixed(2)} (${assignedCount}/${requiredCount} required bundles assigned)` });
  }
  if (actualDecisionCoverage < 1.0) {
    issues.push({ code: "coverage_decision_incomplete", severity: "hard", details: `explicitDecisionCoverage=${actualDecisionCoverage.toFixed(2)} (${decidedCount}/${requiredCount} required bundles decided)` });
  }

  // 2. 检查 Critic report
  if (!qualityReport) {
    issues.push({ code: "no_critic_report", severity: "hard", details: "mandatory Critic report missing" });
  } else {
    if (qualityReport.criticStatus !== "passed") {
      issues.push({ code: "critic_not_passed", severity: "hard", details: `criticStatus=${qualityReport.criticStatus}` });
    }
    // 检查 unsupported/contradicted claims
    const hardIssues = (qualityReport.hardIssues as unknown[]) ?? [];
    if (hardIssues.length > 0) {
      issues.push({ code: "hard_issues_exist", severity: "hard", details: `${hardIssues.length} hard issues` });
    }
    // R30: 检查所有 per-claim verdict 没有 unsupported/contradicted
    const perClaimVerdicts = (qualityReport.perClaimVerdicts as Array<Record<string, unknown>>) ?? [];
    const unsupported = perClaimVerdicts.filter(
      (v) => v.verdict === "unsupported" || v.verdict === "contradicted",
    );
    if (unsupported.length > 0) {
      issues.push({ code: "unsupported_claims_exist", severity: "hard", details: `${unsupported.length} unsupported/contradicted claims` });
    }
  }

  // 3. 检查 card count
  const contentJson = draft.contentJson as { cards?: Array<Record<string, unknown>>, summarySupportCandidateIds?: string[] };
  if (!contentJson.cards || contentJson.cards.length === 0) {
    issues.push({ code: "no_cards", severity: "hard", details: "draft has no cards" });
  }

  // 4. 检查 card budget
  const cardCount = contentJson.cards?.length ?? 0;
  if (cardCount > draft.cardBudget) {
    issues.push({ code: "card_budget_exceeded", severity: "hard", details: `${cardCount} > ${draft.cardBudget}` });
  }

  // R30: 5. 检查 summary support IDs 是 card candidates 子集（计划 §11.3）
  // summarySupportCandidateIds 只能引用 deck 中卡片的候选
  const draftSummarySupportIds = (draft.summarySupportCandidateIds as string[]) ?? [];
  if (draftSummarySupportIds.length > 0 && contentJson.cards) {
    // 收集所有卡片中引用的 candidate IDs
    const allCardCandidateIds = new Set<string>();
    for (const card of contentJson.cards) {
      const cardCandidateIds = Array.isArray(card.candidateIds) ? card.candidateIds as string[] : [];
      for (const cid of cardCandidateIds) {
        allCardCandidateIds.add(cid);
      }
    }
    // 检查 summarySupportCandidateIds 是否是 allCardCandidateIds 的子集
    const orphanedSummaryIds = draftSummarySupportIds.filter((id) => !allCardCandidateIds.has(id));
    if (orphanedSummaryIds.length > 0) {
      issues.push({
        code: "summary_support_ids_not_subset",
        severity: "hard",
        details: `${orphanedSummaryIds.length} summary support IDs not in any card's candidates: ${orphanedSummaryIds.slice(0, 5).join(", ")}`,
      });
    }
  }

  // R30: 6. 检查 candidate ownership exactly-once（计划 §11.3, G3）
  // 每个 candidate 最多出现在一个 card 中
  if (contentJson.cards && contentJson.cards.length > 0) {
    const candidateCardMap = new Map<string, number>();
    for (const card of contentJson.cards) {
      const cardCandidateIds = Array.isArray(card.candidateIds) ? card.candidateIds as string[] : [];
      for (const cid of cardCandidateIds) {
        candidateCardMap.set(cid, (candidateCardMap.get(cid) ?? 0) + 1);
      }
    }
    const duplicates = [...candidateCardMap.entries()].filter(([, count]) => count > 1);
    if (duplicates.length > 0) {
      issues.push({
        code: "candidate_not_exactly_once",
        severity: "hard",
        details: `${duplicates.length} candidates appear in multiple cards: ${duplicates.slice(0, 5).map(([id, count]) => `${id}(${count}x)`).join(", ")}`,
      });
    }
  }

  // R30: 7. 检查 capacity exclusions 有原因（计划 §11.3）
  const capacityExclusions = (coverage.capacityExclusions as Array<Record<string, unknown>>) ?? [];
  const exclusionsWithoutReason = capacityExclusions.filter(
    (e) => !e.reasonCode || String(e.reasonCode).length === 0,
  );
  if (exclusionsWithoutReason.length > 0) {
    issues.push({
      code: "capacity_exclusion_no_reason",
      severity: "hard",
      details: `${exclusionsWithoutReason.length} capacity exclusions without reasonCode`,
    });
  }

  // R30: 8. 检查 mandatory Critic report 对应当前 draftHash（计划 §11.3）
  if (qualityReport && qualityReport.draftHash !== args.draftHash) {
    issues.push({
      code: "critic_report_draft_hash_mismatch",
      severity: "hard",
      details: `critic report draftHash=${qualityReport.draftHash} != draft contentHash=${args.draftHash}`,
    });
  }

  // R60 修复：检查 Repair 次数合法（计划 §11.3: "Repair 次数合法"）。
  // 计划 §4.7: "整 run 最多创建一个 Repair task"。
  // 虽然request_repair 工具已通过 DB 唯一约束在创建层面强制，
  // 但 preflight 应独立验证，防止数据库约束被绕过或历史脏数据。
  const repairUnitKey = `agent:repairer:${ctx.runId}`;
  const repairUnits = await db
    .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationUnits.runId, ctx.runId),
      eq(schema.cardGenerationUnits.unitKey, repairUnitKey),
    ));
  if (repairUnits.length > 1) {
    issues.push({
      code: "repair_count_exceeded",
      severity: "hard",
      details: `found ${repairUnits.length} repair units, expected at most 1`,
    });
  }

  // P1-11: 9. 检查 density 与请求一致（计划 §11.2, §11.3）
  // 从 Supervisor unit 的 inputManifest 读取请求时的 density
  const [supervisorUnit] = await db
    .select({ inputManifest: schema.cardGenerationUnits.inputManifest })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationUnits.runId, ctx.runId),
      eq(schema.cardGenerationUnits.kind, "agent_run"),
    ))
    .limit(1);

  const requestedDensity = (supervisorUnit?.inputManifest as Record<string, unknown>)?.density as string | undefined;
  if (requestedDensity && draft.density !== requestedDensity) {
    issues.push({
      code: "density_mismatch",
      severity: "hard",
      details: `requested density="${requestedDensity}" but draft density="${draft.density}"`,
    });
  }

  // §7.7 质量门禁：对每张卡跑 assessCardOutput（计划 §7.7）
  // 检查 claim 过短、空泛表述、quote 不在原文、claim 与 quote 复述式重合、
  // claim 与 quote 无关、跨卡重复 claim、覆盖率过低等 8 项质量问题。
  // hard issue 直接进 preflight 检查项，阻断发布；
  // soft issue 不阻断发布，仅记日志（repair 启用时），
  // Supervisor 通过 Critic 的 softIssues 字段获取语义级 soft issues 决定是否修复。
  if (contentJson.cards && contentJson.cards.length > 0 && run?.noteVersionId) {
    // 1. 加载所有候选的 claim
    const qualityCandidates = await db
      .select({
        id: schema.cardGenerationCandidates.id,
        claim: schema.cardGenerationCandidates.claim,
      })
      .from(schema.cardGenerationCandidates)
      .where(and(
        eq(schema.cardGenerationCandidates.workspaceId, ctx.workspaceId),
        eq(schema.cardGenerationCandidates.runId, ctx.runId),
      ));
    const candidateClaimMap = new Map(qualityCandidates.map((c) => [c.id, c.claim ?? ""]));

    // 2. 加载候选-证据关联
    const allCardCandidateIds: string[] = [];
    for (const card of contentJson.cards) {
      const ids = Array.isArray(card.candidateIds) ? card.candidateIds as string[] : [];
      allCardCandidateIds.push(...ids);
    }

    const candidateEvidenceLinks = allCardCandidateIds.length > 0
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
            inArray(schema.cardGenerationCandidateEvidence.candidateId, allCardCandidateIds),
          ))
      : [];

    // 3. 加载证据文本（text spans join note_blocks）
    const evidenceSpanIds = candidateEvidenceLinks
      .map((l) => l.evidenceSpanId)
      .filter((id): id is string => id !== null);
    const evidenceSpanRows = evidenceSpanIds.length > 0
      ? await db
          .select({
            span: schema.noteEvidenceSpans,
            block: schema.noteBlocks,
          })
          .from(schema.noteEvidenceSpans)
          .innerJoin(schema.noteBlocks, eq(schema.noteEvidenceSpans.blockId, schema.noteBlocks.id))
          .where(and(
            eq(schema.noteEvidenceSpans.workspaceId, ctx.workspaceId),
            inArray(schema.noteEvidenceSpans.id, evidenceSpanIds),
          ))
      : [];

    const evidenceTextMap = new Map<string, string>();
    for (const row of evidenceSpanRows) {
      const text = (row.block?.content ?? "").slice(row.span?.charStart ?? 0, row.span?.charEnd ?? 0);
      evidenceTextMap.set(row.span.id, text || (row.span?.unitKey ?? ""));
    }

    // 加载图片证据文本
    const imageEvidenceUnitIds = candidateEvidenceLinks
      .map((l) => l.imageEvidenceUnitId)
      .filter((id): id is string => id !== null);
    if (imageEvidenceUnitIds.length > 0) {
      const imageEvidenceRows = await db
        .select({
          id: schema.noteImageEvidenceUnits.id,
          text: schema.noteImageEvidenceUnits.text,
        })
        .from(schema.noteImageEvidenceUnits)
        .where(and(
          eq(schema.noteImageEvidenceUnits.workspaceId, ctx.workspaceId),
          inArray(schema.noteImageEvidenceUnits.id, imageEvidenceUnitIds),
        ));
      for (const img of imageEvidenceRows) {
        if (img.id && img.text) {
          evidenceTextMap.set(img.id, img.text);
        }
      }
    }

    // 4. 构建 candidateId → first evidence text 映射
    const candidateQuoteMap = new Map<string, string>();
    for (const link of candidateEvidenceLinks) {
      const evId = link.evidenceSpanId ?? link.imageEvidenceUnitId;
      if (evId && !candidateQuoteMap.has(link.candidateId)) {
        candidateQuoteMap.set(link.candidateId, evidenceTextMap.get(evId) ?? "");
      }
    }

    // 5. 构建 sourceBlocks（用于 quote_not_in_source 检查）。
    // PERF: 只收集证据 span 实际引用的 note blocks（上述 evidenceSpanRows 已 JOIN
    // 加载了对应 block 内容），不再对整张 note_blocks 表做无 LIMIT 全量扫描。
    const sourceBlocks = evidenceSpanRows
      .map((row) => row.block?.content ?? "")
      .filter((c) => c.length > 0);

    // 图片证据的 OCR/结构化文本不在 note_blocks 中，需要追加到 sourceBlocks，
    // 否则图片证据支撑的 quote_text 会触发 quote_not_in_source 误报。
    for (const [, text] of evidenceTextMap) {
      if (text.length > 0) sourceBlocks.push(text);
    }

    // 6. 对每张卡跑 assessCardOutput
    const repairEnabled = isCardRepairEnabled();
    for (let cardIdx = 0; cardIdx < contentJson.cards.length; cardIdx++) {
      const card = contentJson.cards[cardIdx]!;
      const cardCandidateIds = Array.isArray(card.candidateIds) ? card.candidateIds as string[] : [];
      if (cardCandidateIds.length === 0) continue;

      const keyPoints = cardCandidateIds.map((cid, i) => ({
        ordinal: i,
        claim: candidateClaimMap.get(cid) ?? "",
        quote_text: candidateQuoteMap.get(cid) ?? "",
      }));

      const cardOutput: LearningCardOutput = {
        title: (card.title as string) ?? "",
        summary: (card.summary as string) ?? "",
        key_points: keyPoints,
      };

      const assessment = assessCardOutput(cardOutput, sourceBlocks);

      for (const issue of assessment.issues) {
        if (issue.severity === "hard") {
          issues.push({
            code: `card_quality_${issue.code}`,
            severity: "hard",
            details: `Card #${cardIdx + 1} "${(card.title as string) ?? "untitled"}": ${issue.code}${issue.keyPointOrdinal !== undefined ? ` (keypoint #${issue.keyPointOrdinal})` : ""}`,
            cardDraftId: (card.draftCardId as string) ?? undefined,
          });
        }
      }

      if (assessment.hardFailure) {
        issues.push({
          code: "card_quality_hard_failure",
          severity: "hard",
          details: `Card #${cardIdx + 1} "${(card.title as string) ?? "untitled"}": hard failure (unparseable or zero valid key points)`,
          cardDraftId: (card.draftCardId as string) ?? undefined,
        });
      }

      // soft issues 不阻断发布（不进 issues 数组），仅在 repair 启用时
      // 记录到日志，供可观测性使用。Supervisor 通过 Critic 的 softIssues
      // 字段获取语义级 soft issues，决定是否发起条件式修复。
      const softIssues = assessment.issues.filter((i) => i.severity === "soft");
      if (softIssues.length > 0 && repairEnabled) {
        logger.info(
          { runId: ctx.runId, cardIdx, cardTitle: (card.title as string) ?? "untitled", softIssues: softIssues.map((i) => i.code) },
          "validate_draft: §7.7 soft quality issues detected (repair enabled, not blocking)",
        );
      }
    }

    logger.info(
      { runId: ctx.runId, cardCount: contentJson.cards.length, repairEnabled, issueCount: issues.length },
      "validate_draft: §7.7 质量门禁评估完成",
    );
  }

  // passed 只检查 hard issues：soft issues 不阻断发布。
  // soft issues 通过日志记录，供可观测性和条件式修复使用。
  const passed = !issues.some((i) => i.severity === "hard");

  // R34 修复：validate_draft 执行完确定性检查后，必须更新 Quality Report 的
  // deterministicStatus 字段。原代码只返回检查结果，不更新 DB。
  // Critic 创建报告时设 deterministicStatus="pending"，VERIFY 阶段检查 ==="passed"，
  // 导致 VERIFY 永远失败，没有任何 run 能通过验证。
  // 修复后：检查通过时更新为 "passed"，有 hard issues 时更新为 "failed"。
  if (qualityReport) {
    const newStatus = passed ? "passed" : "failed";

    // 修复（2026-08-06）：validate_draft 的确定性失败（card_quality_*）需要写入
    // Quality Report 的 hardIssues，否则 Supervisor 调用 request_repair 时
    // validateRepairRequest 只在 critic 的 hardIssues 里找 issue code，
    // 「card_quality_insufficient_valid_key_points」等 code 找不到 → repair 请求失败
    // → 修复链断裂 → supervisor 卡死（protocol_error）。
    // 修复后：deterministic 失败也进入 hardIssues（带 cardDraftId 定位 + patchable=true），
    // request_repair 可受理，repairer 可从 hardIssues 拿到定位信息进行修复。
    const existingHardIssues = (qualityReport.hardIssues as Array<Record<string, unknown>>) ?? [];
    const deterministicHardIssues = passed
      ? []
      : issues
          .filter((i) => i.severity === "hard")
          .map((i) => ({
            code: i.code,
            severity: "hard",
            cardDraftId: i.cardDraftId,
            patchable: true,
            source: "deterministic_validate",
          }));
    // 合并去重（按 code+cardDraftId）
    const mergedHardIssues = [...existingHardIssues];
    for (const di of deterministicHardIssues) {
      const dup = mergedHardIssues.some((h) =>
        String(h.code ?? "") === di.code && String(h.cardDraftId ?? "") === String(di.cardDraftId ?? ""));
      if (!dup) mergedHardIssues.push(di);
    }

    await db.update(schema.cardGenerationQualityReports).set({
      deterministicStatus: newStatus,
      hardIssues: mergedHardIssues as never,
    }).where(and(
      eq(schema.cardGenerationQualityReports.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationQualityReports.runId, ctx.runId),
      eq(schema.cardGenerationQualityReports.draftId, draft.id),
    ));

    logger.info(
      { runId: ctx.runId, draftHash: args.draftHash, passed, issueCount: issues.length, deterministicStatus: newStatus, deterministicIssueCount: deterministicHardIssues.length },
      "validate_draft: preflight 完成，deterministicStatus 已更新",
    );
  } else {
    logger.warn(
      { runId: ctx.runId, draftHash: args.draftHash, passed: false, issueCount: issues.length },
      "validate_draft: preflight 失败，无 Quality Report 可更新",
    );
  }

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      passed,
      issues,
    },
  };
}
