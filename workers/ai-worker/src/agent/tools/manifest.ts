/**
 * Manifest 工具（计划 §6.1）
 *
 * Supervisor 工具：
 * - get_run_manifest: 读取 outline、预算、coverage/task 摘要
 * - get_next_unassigned_bundles: 顺序领取未处理 required bundles
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db.ts";
import * as schema from "../../schema/index.ts";
import { logger } from "../../lib/logger.ts";
import type { ToolCallRequest, ToolCallResult } from "./executor.ts";
import { AgentRole, isSuccessUnitStatus } from "@ailearn/shared";

/** Manifest 工具执行器 */
export async function executeManifestTool(
  call: ToolCallRequest,
  ctx: ManifestToolContext,
): Promise<ToolCallResult> {
  switch (call.name) {
    case "get_run_manifest":
      return await handleGetRunManifest(call, ctx);
    case "get_next_unassigned_bundles":
      return await handleGetNextUnassignedBundles(call, ctx);
    default:
      return {
        toolCallId: call.id,
        toolName: call.name,
        success: false,
        result: null,
        error: `unknown manifest tool: ${call.name}`,
      };
  }
}

export interface ManifestToolContext {
  runId: string;
  workspaceId: string;
  noteVersionId: string;
  agentUnitId: string;
  turnNo: number;
  coverageLedger: import("../coverage-ledger.ts").CoverageLedger;
  budgetTracker: import("../budget.ts").BudgetTracker;
}

/** get_run_manifest: 读取运行 manifest 摘要 */
async function handleGetRunManifest(
  call: ToolCallRequest,
  ctx: ManifestToolContext,
): Promise<ToolCallResult> {
  const [run] = await db
    .select({
      id: schema.cardGenerationRuns.id,
      titleSnapshot: schema.cardGenerationRuns.titleSnapshot,
      status: schema.cardGenerationRuns.status,
      coverageReport: schema.cardGenerationRuns.coverageReport,
      engineMode: schema.cardGenerationRuns.engineMode,
      budgetSnapshot: schema.cardGenerationRuns.budgetSnapshot,
    })
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, ctx.runId),
      eq(schema.cardGenerationRuns.workspaceId, ctx.workspaceId),
    ))
    .limit(1);

  if (!run) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      success: false,
      result: null,
      error: "run not found",
    };
  }

  const coverageSnapshot = ctx.coverageLedger.getSnapshot();

  // 查询子任务状态计数（原代码硬编码为全零，导致 Supervisor 无法看到任务进度）
  const childUnits = await db
    .select({
      status: schema.cardGenerationUnits.status,
    })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationUnits.runId, ctx.runId),
      eq(schema.cardGenerationUnits.kind, "agent_run"),
    ));

  let pendingTasks = 0;
  let runningTasks = 0;
  let completedTasks = 0;
  for (const u of childUnits) {
    if (u.status === "pending" || u.status === "waiting_child") pendingTasks++;
    else if (u.status === "running" || u.status === "agent_running") runningTasks++;
    else if (isSuccessUnitStatus(u.status)) completedTasks++;
  }

  const manifest = {
    runId: run.id,
    noteTitle: run.titleSnapshot,
    engineMode: run.engineMode,
    budget: run.budgetSnapshot,
    coverageReport: run.coverageReport,
    coverage: {
      bundlesTotal: coverageSnapshot.totalBundles,
      bundlesRequired: coverageSnapshot.requiredBundles,
      bundlesAssigned: coverageSnapshot.assignedBundles,
      bundlesDecided: coverageSnapshot.decidedBundles,
      candidatesTotal: coverageSnapshot.totalCandidates,
      candidatesCanonical: coverageSnapshot.canonicalCandidates,
    },
    taskSummary: {
      pendingTasks,
      runningTasks,
      completedTasks,
    },
  };

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: manifest,
  };
}

/** get_next_unassigned_bundles: 领取未分配的 required bundles */
async function handleGetNextUnassignedBundles(
  call: ToolCallRequest,
  ctx: ManifestToolContext,
): Promise<ToolCallResult> {
  const args = call.arguments as { cursor?: string; limit?: number };
  const limit = Math.min(args.limit ?? 5, 20);

  // 查询未分配的 required bundles
  const unassigned = await db
    .select({
      id: schema.cardGenerationSourceBundles.id,
      bundleKey: schema.cardGenerationSourceBundles.bundleKey,
      bundleOrdinal: schema.cardGenerationSourceBundles.bundleOrdinal,
      sectionPath: schema.cardGenerationSourceBundles.sectionPath,
      sourceStartOrdinal: schema.cardGenerationSourceBundles.sourceStartOrdinal,
      tokenEstimate: schema.cardGenerationSourceBundles.tokenEstimate,
      inputHash: schema.cardGenerationSourceBundles.inputHash,
    })
    .from(schema.cardGenerationSourceBundles)
    .where(and(
      eq(schema.cardGenerationSourceBundles.runId, ctx.runId),
      eq(schema.cardGenerationSourceBundles.workspaceId, ctx.workspaceId),
      eq(schema.cardGenerationSourceBundles.assignmentStatus, "pending"),
      eq(schema.cardGenerationSourceBundles.required, true),
    ))
    .orderBy(schema.cardGenerationSourceBundles.bundleOrdinal)
    .limit(limit);

  // P1-10 修复：查询 bundle members 的 evidence kind，用于 specialist 路由建议。
  // 批量查询所有 unassigned bundles 的 members，避免 N+1 查询。
  const bundleDbIds = unassigned.map((b) => b.id);
  const bundleKindMap = await loadBundleEvidenceKinds(ctx.workspaceId, ctx.runId, bundleDbIds);

  // 标记为 assigned（在事务中执行，确保原子性）
  const now = new Date();
  if (unassigned.length > 0) {
    const unassignedIds = unassigned.map((b) => b.id);
    await db.transaction(async (tx) => {
      // 单条批量 UPDATE，避免每个 bundle 一次 round-trip
      await tx.update(schema.cardGenerationSourceBundles).set({
        assignmentStatus: "assigned",
        assignedAgentUnitId: ctx.agentUnitId,
        updatedAt: now,
      }).where(and(
        inArray(schema.cardGenerationSourceBundles.id, unassignedIds),
        eq(schema.cardGenerationSourceBundles.workspaceId, ctx.workspaceId),
        eq(schema.cardGenerationSourceBundles.assignmentStatus, "pending"),
      ));

      // 更新 CoverageLedger 内存状态
      for (const bundle of unassigned) {
        ctx.coverageLedger.updateAssignment(bundle.bundleKey, "assigned", ctx.agentUnitId);
      }
    });
  }

  logger.info(
    { runId: ctx.runId, bundleCount: unassigned.length },
    "get_next_unassigned_bundles: bundles assigned atomically",
  );

  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    result: {
      bundles: unassigned.map((b) => {
        const kinds = bundleKindMap.get(b.id) ?? [];
        return {
          bundleId: b.bundleKey,
          ordinal: b.bundleOrdinal,
          sectionPath: b.sectionPath,
          sourceStartOrdinal: b.sourceStartOrdinal,
          tokenEstimate: b.tokenEstimate,
          inputHash: b.inputHash,
          // P1-10: 暴露 evidence kinds 给 Supervisor，支持确定性路由
          evidenceKinds: kinds,
          suggestedSpecialist: suggestSpecialistByEvidenceKinds(kinds),
        };
      }),
      hasMore: unassigned.length === limit,
    },
  };
}

/**
 * 批量查询 bundle 的 evidence kinds（P1-10）。
 *
 * 从 bundle members 和 note_blocks 推导每个 bundle 包含的内容类型。
 * 返回值是 bundle DB id → evidence kind 列表的映射。
 */
async function loadBundleEvidenceKinds(
  workspaceId: string,
  runId: string,
  bundleDbIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (bundleDbIds.length === 0) return result;

  // 查询 bundle members
  const members = await db
    .select({
      bundleId: schema.cardGenerationSourceBundleMembers.bundleId,
      evidenceRefType: schema.cardGenerationSourceBundleMembers.evidenceRefType,
      evidenceSpanId: schema.cardGenerationSourceBundleMembers.evidenceSpanId,
      imageEvidenceUnitId: schema.cardGenerationSourceBundleMembers.imageEvidenceUnitId,
    })
    .from(schema.cardGenerationSourceBundleMembers)
    .where(and(
      eq(schema.cardGenerationSourceBundleMembers.workspaceId, workspaceId),
      eq(schema.cardGenerationSourceBundleMembers.runId, runId),
      inArray(schema.cardGenerationSourceBundleMembers.bundleId, bundleDbIds),
    ));

  // 收集 text span IDs 以查询 block types
  const spanIds = members
    .map((m) => m.evidenceSpanId)
    .filter((id): id is string => id !== null);

  // 查询 note blocks 的 type 字段（paragraph | heading | code | list | quote | image）
  const spanBlockTypes = new Map<string, string>();
  if (spanIds.length > 0) {
    const spans = await db
      .select({
        spanId: schema.noteEvidenceSpans.id,
        blockType: schema.noteBlocks.type,
      })
      .from(schema.noteEvidenceSpans)
      .innerJoin(
        schema.noteBlocks,
        eq(schema.noteEvidenceSpans.blockId, schema.noteBlocks.id),
      )
      .where(and(
        eq(schema.noteEvidenceSpans.workspaceId, workspaceId),
        inArray(schema.noteEvidenceSpans.id, spanIds),
      ));

    for (const row of spans) {
      spanBlockTypes.set(row.spanId, row.blockType);
    }
  }

  // 按 bundle 聚合 evidence kinds
  for (const member of members) {
    const bundleId = member.bundleId;
    if (!result.has(bundleId)) result.set(bundleId, []);
    const kinds = result.get(bundleId)!;

    if (member.evidenceRefType === "image_evidence" || member.imageEvidenceUnitId) {
      if (!kinds.includes("image")) kinds.push("image");
    } else if (member.evidenceSpanId) {
      const blockType = spanBlockTypes.get(member.evidenceSpanId) ?? "text";
      // 映射 block type 到 evidence kind
      // code → code, list → list (treated as text), 其他 → text
      if (blockType === "code") {
        if (!kinds.includes("code")) kinds.push("code");
      } else {
        if (!kinds.includes("text")) kinds.push("text");
      }
    }
  }

  return result;
}

/**
 * 根据 evidence kinds 建议合适的 specialist role（P1-10）。
 *
 * 路由规则：
 * - 包含 image → vision_specialist
 * - 包含 code（无 image）→ code_extractor
 * - 只有 text → text_extractor
 * - 混合 text + code（无 image）→ code_extractor（code extractor 也能处理文本）
 */
function suggestSpecialistByEvidenceKinds(kinds: string[]): AgentRole {
  if (kinds.includes("image")) {
    return "vision_specialist" as AgentRole;
  }
  if (kinds.includes("code")) {
    return "code_extractor" as AgentRole;
  }
  return "text_extractor" as AgentRole;
}
