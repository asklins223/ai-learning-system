/**
 * Plan 23 TP-01..TP-07：Understanding Topology V3 repository。
 *
 * 直接读取 Objective / Origin / Evidence Binding / Relations / personal
 * projection，不先查 active Card 再反推（§15.3）。节点只允许 source/note/
 * objective/evidence（无 card/key_point）。
 *
 * Bug 修复：
 * - practiceTrailCount / lastCanonicalEventId 从 outbox 读取（不再硬编码）。
 * - primaryAction 使用 resolvePrimaryActionV3（不再 inline 构建 + as never）。
 * - activeCardId 从 learningCardsV2 读取（不再硬编码 null）。
 * - successorObjectiveId / successorCardId 从 lineage 表读取（superseded 场景）。
 * - initialValidation 从 initialValidationRemindersV2 读取（用于 action 解析）。
 */
import { and, eq, inArray, isNull, sql, desc } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { notes, sources } from "../../db/schema/note.ts";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningObjectiveLineageV2,
  learningObjectiveOriginsV2,
  evidenceSnapshotsV2,
  learningCardsV2,
  initialValidationRemindersV2,
  learningExposuresV2,
} from "../../db/schema/card-generation-v2.ts";
import { learningRuns, canonicalLearningEventOutbox, practiceTrailEventOutbox } from "../../db/schema/learning-runs.ts";
import { reviewSchedules } from "../../db/schema/evidence.ts";
import { resolvePrimaryActionV3, type ActionResolverInputV3 } from "../learning-objectives/action-resolver.ts";
import type {
  UnderstandingNodeProjectionV3,
  UnderstandingEdgeProjectionV3,
  UnderstandingTopologySnapshotV3,
} from "@ailearn/shared";

export interface TopologyContext {
  workspaceId: string;
  userId: string;
}

const ACTIVE_RUN_PHASES = [
  "preparing",
  "active",
  "assessing",
  "checkpoint",
  "committing",
  "paused",
] as const;

export async function buildTopologySnapshotV3(
  tx: ApiTransaction,
  ctx: TopologyContext,
): Promise<UnderstandingTopologySnapshotV3> {
  const nodes: UnderstandingNodeProjectionV3[] = [];
  const edges: UnderstandingEdgeProjectionV3[] = [];

  // ── TP-01：Source / Note 节点（0-card Note 仍存在）────────────────────
  const noteRows = await tx
    .select({ id: notes.id, title: notes.title, currentVersionId: notes.currentVersionId, sourceId: notes.sourceId })
    .from(notes)
    .where(and(eq(notes.workspaceId, ctx.workspaceId), isNull(notes.deletedAt)));
  const noteById = new Map(noteRows.map((n) => [n.id, n]));
  for (const note of noteRows) {
    nodes.push({
      nodeRef: { kind: "note", noteId: note.id },
      label: note.title,
      currentVersionId: note.currentVersionId ?? note.id,
      freshness: "current",
    });
  }
  const sourceRows = await tx
    .select({ id: sources.id, title: sources.title, type: sources.type, createdAt: sources.createdAt })
    .from(sources)
    .where(eq(sources.workspaceId, ctx.workspaceId));
  for (const source of sourceRows) {
    nodes.push({
      nodeRef: { kind: "source", sourceId: source.id },
      label: source.title,
      modality: source.type,
      createdAt: source.createdAt.toISOString(),
    });
  }

  // ── TP-02：Objective 节点（conceptLabel；不生成 Card Presentation 节点）──
  const objectiveRows = await tx
    .select()
    .from(learningObjectivesV2)
    .where(eq(learningObjectivesV2.workspaceId, ctx.workspaceId));
  const objectiveIds = objectiveRows.map((o) => o.objectiveId);
  const revisionRows = objectiveRows.length > 0
    ? await tx
        .select()
        .from(learningObjectiveRevisionsV2)
        .where(and(
          eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
          inArray(learningObjectiveRevisionsV2.objectiveRevisionId, objectiveRows.map((o) => o.currentObjectiveRevisionId).filter(Boolean) as string[]),
        ))
    : [];
  const revisionByObjective = new Map(
    revisionRows.map((r) => [r.objectiveId, r]),
  );

  // personal overlay（TP-06）：active run + review per objective
  // V2：learningRuns 没有 keyPointId 列，run.origin JSONB 中的
  // keyPointId = objectiveId（方案 20 §29.4 alias 规则）；经 origin JSON 路径取。
  // 安全修复：不在 SQL 中用 sql.raw 拼接 objectiveIds（SQL 注入风险）。
  // Bug 修复：原先只查 active-phase runs，导致 practiceTrailCount/lastCanonicalEventId
  // 对已完成 run 的 objective 始终为 0/null。改为查 all runs，在内存中同时提取
  // activeRun 映射和 allRunIds/runIdToObjective（与 surface-service 对齐）。
  const objectiveIdSet = new Set(objectiveIds);
  const allRunRows = objectiveIds.length > 0
    ? await tx
        .select({ runId: learningRuns.id, phase: learningRuns.phase, origin: learningRuns.origin, createdAt: learningRuns.createdAt })
        .from(learningRuns)
        .where(and(
          eq(learningRuns.workspaceId, ctx.workspaceId),
          eq(learningRuns.userId, ctx.userId),
        ))
    : [];
  const runByObjective = new Map<string, { runId: string; phase: string }>();
  const allRunIds: string[] = [];
  const runIdToObjective = new Map<string, string>();
  for (const run of allRunRows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    const objectiveId = ((run.origin as Record<string, unknown> | null)?.keyPointId) as string | undefined;
    if (objectiveId && objectiveIdSet.has(objectiveId)) {
      allRunIds.push(run.runId);
      runIdToObjective.set(run.runId, objectiveId);
      if ((ACTIVE_RUN_PHASES as readonly string[]).includes(run.phase) && !runByObjective.has(objectiveId)) {
        runByObjective.set(objectiveId, { runId: run.runId, phase: run.phase });
      }
    }
  }
  const scheduleRows = objectiveIds.length > 0
    ? await tx
        .select({ id: reviewSchedules.id, subjectId: reviewSchedules.subjectId, nextReviewAt: reviewSchedules.nextReviewAt, generation: reviewSchedules.generation })
        .from(reviewSchedules)
        .where(and(
          eq(reviewSchedules.workspaceId, ctx.workspaceId),
          eq(reviewSchedules.userId, ctx.userId),
          eq(reviewSchedules.subjectType, "card"),
          eq(reviewSchedules.status, "pending"),
          inArray(reviewSchedules.subjectId, objectiveIds),
        ))
    : [];
  const scheduleByObjective = new Map<string, { scheduleId: string; nextReviewAt: Date; generation: number }>();
  for (const s of scheduleRows) {
    if (s.subjectId) {
      scheduleByObjective.set(s.subjectId, { scheduleId: s.id, nextReviewAt: s.nextReviewAt, generation: s.generation });
    }
  }

  const originRows = objectiveIds.length > 0
    ? await tx
        .select()
        .from(learningObjectiveOriginsV2)
        .where(and(
          eq(learningObjectiveOriginsV2.workspaceId, ctx.workspaceId),
          inArray(learningObjectiveOriginsV2.objectiveId, objectiveIds),
        ))
    : [];
  const originsByObjective = new Map<string, typeof originRows>();
  for (const row of originRows) {
    const list = originsByObjective.get(row.objectiveId) ?? [];
    list.push(row);
    originsByObjective.set(row.objectiveId, list);
  }

  // evidence nodes（TP-04）：来自 origin 的 evidenceSnapshotIds
  const evidenceSnapshotIds = [
    ...new Set(originRows.flatMap((o) => (o.evidenceSnapshotIds ?? []) as string[])),
  ];
  const evidenceRows = evidenceSnapshotIds.length > 0
    ? await tx
        .select({ evidenceSnapshotId: evidenceSnapshotsV2.evidenceSnapshotId, supportDescription: evidenceSnapshotsV2.supportDescription, sourceContentHash: evidenceSnapshotsV2.sourceContentHash })
        .from(evidenceSnapshotsV2)
        .where(inArray(evidenceSnapshotsV2.evidenceSnapshotId, evidenceSnapshotIds))
    : [];
  const evidenceById = new Map(evidenceRows.map((e) => [e.evidenceSnapshotId, e]));
  for (const evidence of evidenceRows) {
    nodes.push({
      nodeRef: { kind: "evidence", evidenceSnapshotId: evidence.evidenceSnapshotId },
      supportSummary: evidence.supportDescription ?? "证据片段",
      sourceLabel: null,
      restricted: false,
    });
  }

  // ── objective nodes + edges ────────────────────────────────────────────
  const missingOriginObjectiveIds: string[] = [];
  // 预建 note → currentVersionId 映射，用于 source_outdated 判断（§18.4）。
  const noteCurrentVersionById = new Map(noteRows.map((n) => [n.id, n.currentVersionId]));

  // Bug 修复：批量加载 active cards / initialValidation / canonical events /
  // practice trail counts / lineage（用于 primaryAction 解析和 personal overlay）。
  const now = new Date();

  // 批量查 active cards
  const cardRows = objectiveIds.length > 0
    ? await tx
        .select({ objectiveId: learningCardsV2.objectiveId, cardId: learningCardsV2.cardId })
        .from(learningCardsV2)
        .where(and(
          eq(learningCardsV2.workspaceId, ctx.workspaceId),
          inArray(learningCardsV2.objectiveId, objectiveIds),
          eq(learningCardsV2.lifecycle, "active"),
        ))
    : [];
  const cardByObjective = new Map(cardRows.map((c) => [c.objectiveId, c.cardId]));

  // 批量查 initial validation reminders
  const ivRows = objectiveIds.length > 0
    ? await tx
        .select({
          objectiveId: initialValidationRemindersV2.objectiveId,
          reminderId: initialValidationRemindersV2.reminderId,
          status: initialValidationRemindersV2.status,
          qualificationNotBefore: initialValidationRemindersV2.qualificationNotBefore,
        })
        .from(initialValidationRemindersV2)
        .where(and(
          eq(initialValidationRemindersV2.workspaceId, ctx.workspaceId),
          eq(initialValidationRemindersV2.userId, ctx.userId),
          inArray(initialValidationRemindersV2.objectiveId, objectiveIds),
          inArray(initialValidationRemindersV2.status, ["pending", "ready"]),
        ))
        .orderBy(desc(initialValidationRemindersV2.updatedAt))
    : [];
  const ivByObjective = new Map<string, typeof ivRows[0]>();
  for (const row of ivRows) {
    if (!ivByObjective.has(row.objectiveId)) {
      ivByObjective.set(row.objectiveId, row);
    }
  }

  // 批量查 canonical events + practice trail counts（通过 runId 间接关联）
  // allRunIds 和 runIdToObjective 已在 step 7 中构建。
  const lastCanonicalByObjective = new Map<string, string>();
  const practiceCountByObjective = new Map<string, number>();

  if (allRunIds.length > 0) {
    const [canonicalRows, practiceRows] = await Promise.all([
      tx
        .select({
          runId: canonicalLearningEventOutbox.runId,
          canonicalEventId: canonicalLearningEventOutbox.canonicalEventId,
          createdAt: canonicalLearningEventOutbox.createdAt,
        })
        .from(canonicalLearningEventOutbox)
        .where(and(
          eq(canonicalLearningEventOutbox.workspaceId, ctx.workspaceId),
          eq(canonicalLearningEventOutbox.userId, ctx.userId),
          inArray(canonicalLearningEventOutbox.runId, allRunIds),
          eq(canonicalLearningEventOutbox.status, "published"),
        ))
        .orderBy(desc(canonicalLearningEventOutbox.createdAt)),
      tx
        .select({
          runId: practiceTrailEventOutbox.runId,
          n: sql<number>`count(*)::int`,
        })
        .from(practiceTrailEventOutbox)
        .where(and(
          eq(practiceTrailEventOutbox.workspaceId, ctx.workspaceId),
          eq(practiceTrailEventOutbox.userId, ctx.userId),
          inArray(practiceTrailEventOutbox.runId, allRunIds),
          eq(practiceTrailEventOutbox.status, "published"),
        ))
        .groupBy(practiceTrailEventOutbox.runId),
    ]);

    for (const row of canonicalRows) {
      const objId = runIdToObjective.get(row.runId);
      if (objId && !lastCanonicalByObjective.has(objId)) {
        lastCanonicalByObjective.set(objId, row.canonicalEventId);
      }
    }
    for (const row of practiceRows) {
      const objId = runIdToObjective.get(row.runId);
      if (objId) {
        practiceCountByObjective.set(objId, (practiceCountByObjective.get(objId) ?? 0) + Number(row.n));
      }
    }
  }

  // 批量查 exposure（practiceOnly 判定；§7.4 Reveal 语义）
  const REVEAL_EXPOSURE_KINDS = ["answer_reveal", "evidence_reveal", "answer_editor_view"] as const;
  const exposureRows = objectiveIds.length > 0
    ? await tx
        .select({ objectiveId: learningExposuresV2.objectiveId })
        .from(learningExposuresV2)
        .where(and(
          eq(learningExposuresV2.workspaceId, ctx.workspaceId),
          eq(learningExposuresV2.userId, ctx.userId),
          inArray(learningExposuresV2.objectiveId, objectiveIds),
          inArray(learningExposuresV2.exposureKind, [...REVEAL_EXPOSURE_KINDS]),
        ))
        .groupBy(learningExposuresV2.objectiveId)
    : [];
  const exposedObjectives = new Set(exposureRows.map((r) => r.objectiveId));

  // 批量查 lineage（superseded → successor）
  const successorRevisionIds: string[] = [];
  const allRevisionIds = objectiveRows
    .map((o) => o.currentObjectiveRevisionId)
    .filter(Boolean) as string[];
  const topologyLineageRows = allRevisionIds.length > 0
    ? await tx
        .select()
        .from(learningObjectiveLineageV2)
        .where(and(
          eq(learningObjectiveLineageV2.workspaceId, ctx.workspaceId),
          inArray(learningObjectiveLineageV2.predecessorRevisionId, allRevisionIds),
          eq(learningObjectiveLineageV2.relation, "supersedes"),
        ))
    : [];
  const successorByRevision = new Map<string, string>();
  for (const lin of topologyLineageRows) {
    successorByRevision.set(lin.predecessorRevisionId, lin.successorRevisionId);
    successorRevisionIds.push(lin.successorRevisionId);
  }
  const successorRevisionRows = successorRevisionIds.length > 0
    ? await tx
        .select({
          objectiveRevisionId: learningObjectiveRevisionsV2.objectiveRevisionId,
          objectiveId: learningObjectiveRevisionsV2.objectiveId,
        })
        .from(learningObjectiveRevisionsV2)
        .where(and(
          eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
          inArray(learningObjectiveRevisionsV2.objectiveRevisionId, successorRevisionIds),
        ))
    : [];
  const successorObjByRevision = new Map(successorRevisionRows.map((r) => [r.objectiveRevisionId, r.objectiveId]));
  const successorObjIds = [...new Set(successorRevisionRows.map((r) => r.objectiveId))];
  const successorCardRows = successorObjIds.length > 0
    ? await tx
        .select({ objectiveId: learningCardsV2.objectiveId, cardId: learningCardsV2.cardId })
        .from(learningCardsV2)
        .where(and(
          eq(learningCardsV2.workspaceId, ctx.workspaceId),
          inArray(learningCardsV2.objectiveId, successorObjIds),
          eq(learningCardsV2.lifecycle, "active"),
        ))
    : [];
  const successorCardByObjective = new Map(successorCardRows.map((c) => [c.objectiveId, c.cardId]));

  for (const objective of objectiveRows) {
    const revision = revisionByObjective.get(objective.objectiveId);
    const origins = originsByObjective.get(objective.objectiveId) ?? [];
    if (objective.lifecycle === "active" && origins.length === 0) {
      missingOriginObjectiveIds.push(objective.objectiveId);
    }
    // §18.4 freshness：origins 为空 → legacy_unreviewed；Note 新版本 →
    // source_outdated；其余 → fresh。与 surface-service computeFreshness 对齐。
    let freshness: "fresh" | "source_outdated" | "legacy_unreviewed" = "fresh";
    if (origins.length === 0) {
      freshness = "legacy_unreviewed";
    } else {
      const noteOrigins = origins.filter((o) => o.noteId);
      const outdated = noteOrigins.some((o) => {
        const currentVersion = o.noteId ? noteCurrentVersionById.get(o.noteId) : undefined;
        return currentVersion !== null
          && currentVersion !== undefined
          && o.noteVersionId !== null
          && currentVersion !== o.noteVersionId;
      });
      if (outdated) freshness = "source_outdated";
    }
    const activeRun = runByObjective.get(objective.objectiveId);
    const schedule = scheduleByObjective.get(objective.objectiveId);
    const reviewDue = schedule && schedule.nextReviewAt.getTime() <= Date.now();
    const cardId = cardByObjective.get(objective.objectiveId) ?? null;

    // successor
    let successorObjectiveId: string | null = null;
    let successorCardId: string | null = null;
    if (objective.currentObjectiveRevisionId) {
      const successorRevisionId = successorByRevision.get(objective.currentObjectiveRevisionId);
      if (successorRevisionId) {
        successorObjectiveId = successorObjByRevision.get(successorRevisionId) ?? null;
        if (successorObjectiveId) {
          successorCardId = successorCardByObjective.get(successorObjectiveId) ?? null;
        }
      }
    }

    // initial validation
    const ivRow = ivByObjective.get(objective.objectiveId);
    let initialReady: { reminderId: string; qualificationNotBefore: string } | null = null;
    let initialDeferred: { reminderId: string; qualificationNotBefore: string } | null = null;
    if (ivRow) {
      const notBefore = ivRow.qualificationNotBefore;
      const ready = ivRow.status === "ready" || (ivRow.status === "pending" && notBefore.getTime() <= now.getTime());
      if (ready) {
        initialReady = {
          reminderId: ivRow.reminderId,
          qualificationNotBefore: notBefore.toISOString(),
        };
      } else {
        initialDeferred = {
          reminderId: ivRow.reminderId,
          qualificationNotBefore: notBefore.toISOString(),
        };
      }
    }

    const practiceTrailCount = practiceCountByObjective.get(objective.objectiveId) ?? 0;
    const lastCanonicalEventId = lastCanonicalByObjective.get(objective.objectiveId) ?? null;

    const actionInput: ActionResolverInputV3 = {
      objectiveId: objective.objectiveId,
      lifecycle: objective.lifecycle as ActionResolverInputV3["lifecycle"],
      successorObjectiveId,
      successorCardId,
      hasActiveCard: cardId !== null,
      cardId,
      activeRun: activeRun ? { runId: activeRun.runId } : null,
      reviewDue: reviewDue ? { scheduleId: schedule!.scheduleId, generation: schedule!.generation } : null,
      initialReady,
      initialDeferred,
      practiceOnly: exposedObjectives.has(objective.objectiveId),
      practiceReasonCodes: exposedObjectives.has(objective.objectiveId) ? ["exposed"] : [],
      origin: "graph",
      goal: "继续学习",
    };
    const primaryAction = resolvePrimaryActionV3(actionInput);

    nodes.push({
      nodeRef: { kind: "objective", objectiveId: objective.objectiveId },
      label: revision?.conceptLabel ?? revision?.publicSummary.slice(0, 40) ?? "未命名目标",
      publicSummary: revision?.publicSummary ?? "",
      activeCardId: cardId,
      lifecycle: objective.lifecycle as "active" | "archived" | "superseded",
      freshness,
      personal: {
        state: activeRun
          ? "learning"
          : reviewDue
            ? "due_review"
            : schedule
              ? "scheduled"
              : objective.lifecycle === "archived"
                ? "archived"
                : "unvalidated",
        activeRunId: activeRun?.runId ?? null,
        activeScheduleId: schedule?.scheduleId ?? null,
        nextReviewAt: schedule?.nextReviewAt.toISOString() ?? null,
        practiceTrailCount,
        lastCanonicalEventId,
        primaryAction,
      },
    });

    // TP-03：Note → Objective sourced_from 边（multi-origin）
    for (const origin of origins) {
      if (origin.noteId && noteById.has(origin.noteId)) {
        edges.push({
          edgeId: "src-" + origin.originId,
          kind: "sourced_from",
          from: { kind: "note", id: origin.noteId },
          to: { kind: "objective", id: objective.objectiveId },
          reasonCodes: [origin.originKind === "legacy_migrated" ? "legacy_migrated" : "origin_note"],
        });
      } else if (origin.sourceSnapshotId) {
        // source 边：evidence snapshot 归属的 source（保守：仅当可定位时）
      }
    }
    // TP-04：Objective → Evidence supported_by 边
    for (const origin of origins) {
      for (const evidenceId of (origin.evidenceSnapshotIds ?? []) as string[]) {
        if (evidenceById.has(evidenceId)) {
          edges.push({
            edgeId: "sup-" + origin.originId + "-" + evidenceId.slice(0, 8),
            kind: "supported_by",
            from: { kind: "objective", id: objective.objectiveId },
            to: { kind: "evidence", id: evidenceId },
            reasonCodes: [],
          });
        }
      }
    }
  }

  // ── Bug 4 修复：Source → Note contains_note 边 ────────────────────────
  // 注意：此循环必须在 objective 循环外部执行，否则 contains_note 边会被
  // 重复添加 N 次（N = objective 数量）。
  for (const note of noteRows) {
    if (note.sourceId) {
      edges.push({
        edgeId: "contains_note-" + note.sourceId + "-" + note.id.slice(0, 8),
        kind: "contains_note",
        from: { kind: "source", id: note.sourceId },
        to: { kind: "note", id: note.id },
        reasonCodes: ["source_note"],
      });
    }
  }

  // ── TP-05：supersedes 边（lineage）＋ relations jsonb ──────────────────
  const lineageRows = await tx
    .select()
    .from(learningObjectiveLineageV2)
    .where(eq(learningObjectiveLineageV2.workspaceId, ctx.workspaceId));
  const revisionIdToObjective = new Map(
    revisionRows.map((r) => [r.objectiveRevisionId, r.objectiveId]),
  );
  for (const lineage of lineageRows) {
    if (lineage.relation !== "supersedes") continue;
    const fromObjective = revisionIdToObjective.get(lineage.predecessorRevisionId);
    const toObjective = revisionIdToObjective.get(lineage.successorRevisionId);
    if (fromObjective && toObjective) {
      edges.push({
        edgeId: "supersede-" + lineage.id,
        kind: "supersedes",
        from: { kind: "objective", id: fromObjective },
        to: { kind: "objective", id: toObjective },
        reasonCodes: ["semantic_change"],
      });
    }
  }
  // relations jsonb（relates_to；展示语义关系，不自动推断）
  for (const revision of revisionRows) {
    const relations = (revision.relations ?? []) as Array<{ objectiveId?: string; relation?: string }>;
    for (const rel of relations) {
      if (rel.objectiveId && objectiveIds.includes(rel.objectiveId)) {
        edges.push({
          edgeId: "rel-" + revision.objectiveRevisionId + "-" + rel.objectiveId.slice(0, 8),
          kind: "relates_to",
          from: { kind: "objective", id: revision.objectiveId },
          to: { kind: "objective", id: rel.objectiveId },
          reasonCodes: [String(rel.relation ?? "semantic")],
        });
      }
    }
  }

  // ── TP-07：integrity + pagination（单页全量；continuationToken 预留）────
  return {
    version: 3,
    workspaceId: ctx.workspaceId,
    topologyRevision: "v3-" + nodes.length + "-" + edges.length,
    checkpointToken: "v3-" + Date.now(),
    nodes,
    edges,
    continuationToken: null,
    integrity: {
      truncated: false,
      missingOriginObjectiveIds,
    },
  };
}
