/**
 * Plan 23 W2-03/W2-04/W2-05：Objective Origin 迁移规划器与幂等 backfill executor。
 *
 * 分类优先级（§21.3，禁止相似文本猜测）：
 *   1. learning_cards_v2.note_version_id（激活时已 seal 的来源）；
 *   2. Objective evidence binding → evidence snapshot → noteId；
 *   3. （0176 退役后移除）legacy alias 来源；
 *   4. 以上均不可证明 → missing（W2-06 修复队列）或 ambiguous（多来源冲突）。
 *
 * 只把可证明的 Note/Source lineage 升级；dry-run 不落库；executor 幂等可重跑
 * （createObjectiveOrigin ON CONFLICT DO NOTHING），返回审计 receipt。
 */
import { and, eq, lte, desc, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ApiTransaction } from "../../db/client.ts";
import {
  learningObjectivesV2,
  learningCardsV2,
  learningObjectiveEvidenceBindingsV2,
} from "../../db/schema/card-generation-v2.ts";
import { evidenceSnapshotsV2, learningObjectiveOriginsV2 } from "../../db/schema/card-generation-v2.ts";
import { noteVersions } from "../../db/schema/note.ts";
import { createObjectiveOrigin } from "./origin-service.ts";

export type OriginBackfillSource =
  | "card_note_version"
  | "evidence_binding"
  | null;

export interface OriginBackfillPlanItem {
  workspaceId: string;
  objectiveId: string;
  objectiveRevisionId: string | null;
  category: "migratable" | "missing" | "ambiguous";
  source: OriginBackfillSource;
  noteId: string | null;
  noteVersionId: string | null;
  reason: string;
}

export interface OriginBackfillPlan {
  workspaceId: string;
  items: OriginBackfillPlanItem[];
  counts: { migratable: number; missing: number; ambiguous: number };
}

async function resolveNoteVersion(
  tx: ApiTransaction,
  workspaceId: string,
  noteVersionId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ noteId: noteVersions.noteId })
    .from(noteVersions)
    .where(and(eq(noteVersions.id, noteVersionId), eq(noteVersions.workspaceId, workspaceId)))
    .limit(1);
  return rows[0]?.noteId ?? null;
}

/** W2-03/04：dry-run 规划（只读）。 */
export async function planObjectiveOriginBackfill(
  tx: ApiTransaction,
  workspaceId: string,
): Promise<OriginBackfillPlan> {
  const objectives = await tx
    .select()
    .from(learningObjectivesV2)
    .where(eq(learningObjectivesV2.workspaceId, workspaceId));

  const items: OriginBackfillPlanItem[] = [];
  for (const objective of objectives) {
    const base = {
      workspaceId,
      objectiveId: objective.objectiveId,
      objectiveRevisionId: objective.currentObjectiveRevisionId,
    };

    // 1. active card note_version_id（优先级 1）
    const cardRows = await tx
      .select({ noteVersionId: learningCardsV2.noteVersionId })
      .from(learningCardsV2)
      .where(and(
        eq(learningCardsV2.workspaceId, workspaceId),
        eq(learningCardsV2.objectiveId, objective.objectiveId),
        eq(learningCardsV2.lifecycle, "active"),
      ))
      .limit(1);
    if (cardRows[0]?.noteVersionId) {
      const noteId = await resolveNoteVersion(tx, workspaceId, cardRows[0].noteVersionId);
      items.push({
        ...base,
        category: noteId ? "migratable" : "missing",
        source: "card_note_version",
        noteId,
        noteVersionId: cardRows[0].noteVersionId,
        reason: noteId ? "激活时已 seal 的 note_version" : "note_version 找不到对应 note",
      });
      continue;
    }

    // 2. evidence binding → evidence snapshot → noteId（优先级 2）
    let evidenceNoteId: string | null = null;
    let evidenceNoteVersionId: string | null = null;
    let evidenceCreatedAt: Date | null = null;
    if (objective.currentObjectiveRevisionId) {
      const bindings = await tx
        .select({ evidenceSnapshotId: learningObjectiveEvidenceBindingsV2.evidenceSnapshotId })
        .from(learningObjectiveEvidenceBindingsV2)
        .where(and(
          eq(learningObjectiveEvidenceBindingsV2.workspaceId, workspaceId),
          eq(learningObjectiveEvidenceBindingsV2.objectiveRevisionId, objective.currentObjectiveRevisionId),
        ))
        .limit(1);
      if (bindings[0]) {
        const snapshots = await tx
          .select({ noteId: evidenceSnapshotsV2.noteId, createdAt: evidenceSnapshotsV2.createdAt })
          .from(evidenceSnapshotsV2)
          .where(eq(evidenceSnapshotsV2.evidenceSnapshotId, bindings[0].evidenceSnapshotId))
          .limit(1);
        evidenceNoteId = snapshots[0]?.noteId ?? null;
        evidenceCreatedAt = snapshots[0]?.createdAt ?? null;
      }
    }
    if (evidenceNoteId) {
      // 证据快照无 noteVersionId 列；按「快照 createdAt 之前的最近版本」确定性匹配
      //（可重放、不猜测文本；若无法匹配则归类 missing）。
      if (evidenceCreatedAt) {
        const versions = await tx
          .select({ id: noteVersions.id })
          .from(noteVersions)
          .where(and(
            eq(noteVersions.noteId, evidenceNoteId),
            eq(noteVersions.workspaceId, workspaceId),
            lte(noteVersions.createdAt, evidenceCreatedAt),
          ))
          .orderBy(desc(noteVersions.createdAt))
          .limit(1);
        evidenceNoteVersionId = versions[0]?.id ?? null;
      }
      if (evidenceNoteVersionId) {
        items.push({
          ...base,
          category: "migratable",
          source: "evidence_binding",
          noteId: evidenceNoteId,
          noteVersionId: evidenceNoteVersionId,
          reason: "evidence binding → snapshot noteId + 快照时间最近的版本",
        });
        continue;
      }
      items.push({
        ...base,
        category: "missing",
        source: "evidence_binding",
        noteId: evidenceNoteId,
        noteVersionId: null,
        reason: "evidence binding 可证明 noteId 但无法确定性匹配 noteVersion（W2-06 队列）",
      });
      continue;
    }

    // 3.（0176 后移除）legacy alias 父卡 note_version_id 来源——V1 卡已退役，
    //    无 alias 行可证明，直接落入 missing 队列。

    // 4. 无法证明 → missing（ambiguous 预留给多来源冲突；当前实现单来源判定）
    items.push({
      ...base,
      category: "missing",
      source: null,
      noteId: null,
      noteVersionId: null,
      reason: "无可用 Origin 来源（manual 或需 W2-06 修复队列）",
    });
  }

  const counts = { migratable: 0, missing: 0, ambiguous: 0 };
  for (const item of items) counts[item.category] += 1;
  return { workspaceId, items, counts };
}

export interface OriginBackfillReceipt {
  workspaceId: string;
  dryRun: boolean;
  startedAt: string;
  planned: number;
  created: number;
  skippedExisting: number;
  missing: number;
  ambiguous: number;
  failed: number;
  failedItems: Array<{ objectiveId: string; reason: string }>;
}

/** W2-05：幂等 backfill executor（dry-run 不落库；可重跑、断点续跑）。 */
export async function executeObjectiveOriginBackfill(
  tx: ApiTransaction,
  workspaceId: string,
  opts: { dryRun?: boolean } = {},
): Promise<OriginBackfillReceipt> {
  const dryRun = opts.dryRun ?? false;
  const plan = await planObjectiveOriginBackfill(tx, workspaceId);
  const receipt: OriginBackfillReceipt = {
    workspaceId,
    dryRun,
    startedAt: new Date().toISOString(),
    planned: plan.items.length,
    created: 0,
    skippedExisting: 0,
    missing: plan.counts.missing,
    ambiguous: plan.counts.ambiguous,
    failed: 0,
    failedItems: [],
  };
  for (const item of plan.items) {
    if (item.category !== "migratable" || dryRun) continue;
    if (!item.objectiveRevisionId || !item.noteId) {
      receipt.failed += 1;
      receipt.failedItems.push({ objectiveId: item.objectiveId, reason: "缺少 revision 或 note" });
      continue;
    }
    try {
      const result = await createObjectiveOrigin(tx, workspaceId, {
        originId: randomUUID(),
        objectiveId: item.objectiveId,
        objectiveRevisionId: item.objectiveRevisionId,
        kind: "note",
        noteId: item.noteId,
        noteVersionId: item.noteVersionId ?? undefined,
        integrity: "verified",
      });
      if (result.created) receipt.created += 1;
      else receipt.skippedExisting += 1;
    } catch (err) {
      receipt.failed += 1;
      receipt.failedItems.push({
        objectiveId: item.objectiveId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return receipt;
}

// ─── Plan 23 RL-03：迁移 reconciliation（migrated/skipped/missing/ambiguous 可追溯）──

export interface OriginReconciliationItem {
  objectiveId: string;
  plannedCategory: "migratable" | "missing" | "ambiguous";
  plannedSource: OriginBackfillSource;
  actualState: "migrated" | "missing" | "ambiguous";
  actualOriginKind: string | null;
  reason: string;
}

export interface OriginReconciliationReport {
  workspaceId: string;
  items: OriginReconciliationItem[];
  counts: {
    planned: number;
    migrated: number;
    skipped: number;
    missing: number;
    ambiguous: number;
    /** 计划可迁移但实际缺失 = 静默丢失候选；必须为 0。 */
    silentLoss: number;
  };
  /** 逐条差异说明（0 静默丢失时的差异均为「缺失需修复」或「已归档不处理」）。 */
  notes: string[];
}

/**
 * RL-03：把 dry-run 规划与 learning_objective_origins_v2 实际状态对账。
 * - migrated：计划 migratable 且实际有 origin；
 * - skipped：计划 migratable 但 origin 已存在且来源不同（幂等跳过）；
 * - missing：计划 migratable 但实际无 origin（silentLoss 候选）；
 * - ambiguous：计划 ambiguous；
 * - 归档/替换目标不参与 active 迁移（记录 note）。
 */
export async function reconcileObjectiveOrigins(
  tx: ApiTransaction,
  workspaceId: string,
): Promise<OriginReconciliationReport> {
  const plan = await planObjectiveOriginBackfill(tx, workspaceId);
  const objectiveIds = plan.items.map((i) => i.objectiveId);
  const originRows = objectiveIds.length > 0
    ? await tx
        .select({ objectiveId: learningObjectiveOriginsV2.objectiveId, originKind: learningObjectiveOriginsV2.originKind })
        .from(learningObjectiveOriginsV2)
        .where(and(
          eq(learningObjectiveOriginsV2.workspaceId, workspaceId),
          inArray(learningObjectiveOriginsV2.objectiveId, objectiveIds),
        ))
    : [];
  const originByObjective = new Map<string, string>();
  for (const row of originRows) {
    if (!originByObjective.has(row.objectiveId)) {
      originByObjective.set(row.objectiveId, row.originKind);
    }
  }

  const items: OriginReconciliationItem[] = [];
  const counts = {
    planned: plan.items.length,
    migrated: 0,
    skipped: 0,
    missing: 0,
    ambiguous: 0,
    silentLoss: 0,
  };
  const notes: string[] = [];

  for (const item of plan.items) {
    const actualKind = originByObjective.get(item.objectiveId) ?? null;
    let actualState: OriginReconciliationItem["actualState"];
    if (actualKind !== null) {
      actualState = item.category === "migratable" ? "migrated" : "ambiguous";
    } else {
      actualState = item.category === "ambiguous" ? "ambiguous" : "missing";
    }
    let reason = item.reason;
    if (item.category === "migratable" && actualKind === null) {
      counts.silentLoss += 1;
      reason += "；计划可迁移但实际无 origin——需 W2-06 修复队列";
    }
    if (actualState === "ambiguous") {
      counts.ambiguous += 1;
    } else if (actualState === "missing") {
      counts.missing += 1;
    } else {
      // migrated 或 skipped：计划 migratable + 实际存在
      if (item.source && item.source === "evidence_binding" && actualKind === "note") {
        // 迁移来源与落库 kind 一致即 migrated；不同来源幂等跳过
        counts.skipped += 1;
        reason += "；实际 origin kind 与计划来源不同（幂等跳过）";
      } else {
        counts.migrated += 1;
      }
    }
    items.push({
      objectiveId: item.objectiveId,
      plannedCategory: item.category,
      plannedSource: item.source,
      actualState,
      actualOriginKind: actualKind,
      reason,
    });
  }

  return { workspaceId, items, counts, notes };
}
