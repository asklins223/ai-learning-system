/**
 * Plan 23 TP-01..TP-07：Understanding Topology V3 repository。
 *
 * 直接读取 Objective / Origin / Evidence Binding / Relations / personal
 * projection，不先查 active Card 再反推（§15.3）。节点只允许 source/note/
 * objective/evidence（无 card/key_point）。
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { notes, sources } from "../../db/schema/note.ts";
import { learningObjectivesV2, learningObjectiveRevisionsV2, learningObjectiveLineageV2, learningObjectiveOriginsV2, evidenceSnapshotsV2 } from "../../db/schema/card-generation-v2.ts";
import { learningRuns } from "../../db/schema/learning-runs.ts";
import { reviewSchedules } from "../../db/schema/evidence.ts";
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
  // V2：learningRuns 没有 keyPointId 列（V1 退役），run.origin JSONB 中的
  // keyPointId = objectiveId（方案 20 §29.4 alias 规则）；经 origin JSON 路径取。
  const runRows = objectiveIds.length > 0
    ? await tx
        .select({ runId: learningRuns.id, phase: learningRuns.phase, origin: learningRuns.origin, createdAt: learningRuns.createdAt })
        .from(learningRuns)
        .where(and(
          eq(learningRuns.workspaceId, ctx.workspaceId),
          eq(learningRuns.userId, ctx.userId),
          sql`${learningRuns.origin}->>'keyPointId' = ANY(${sql.raw(`ARRAY[${objectiveIds.map((id) => `'${id}'`).join(",")}]::text[]`)})`,
          inArray(learningRuns.phase, [...ACTIVE_RUN_PHASES]),
        ))
    : [];
  const runByObjective = new Map<string, { runId: string; phase: string }>();
  for (const run of runRows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const objectiveId = ((run.origin as Record<string, unknown> | null)?.keyPointId) as string | undefined;
    if (objectiveId) runByObjective.set(objectiveId, { runId: run.runId, phase: run.phase });
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
  for (const objective of objectiveRows) {
    const revision = revisionByObjective.get(objective.objectiveId);
    const origins = originsByObjective.get(objective.objectiveId) ?? [];
    if (objective.lifecycle === "active" && origins.length === 0) {
      missingOriginObjectiveIds.push(objective.objectiveId);
    }
    const activeRun = runByObjective.get(objective.objectiveId);
    const schedule = scheduleByObjective.get(objective.objectiveId);
    const reviewDue = schedule && schedule.nextReviewAt.getTime() <= Date.now();
    nodes.push({
      nodeRef: { kind: "objective", objectiveId: objective.objectiveId },
      label: revision?.conceptLabel ?? revision?.publicSummary.slice(0, 40) ?? "未命名目标",
      publicSummary: revision?.publicSummary ?? "",
      activeCardId: null,
      lifecycle: objective.lifecycle as "active" | "archived" | "superseded",
      freshness: origins.length === 0 ? "legacy_unreviewed" : "fresh",
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
        practiceTrailCount: 0,
        lastCanonicalEventId: null,
        primaryAction: { kind: activeRun ? "resume_run" : "none", ...(activeRun ? { runId: activeRun.runId, objectiveId: objective.objectiveId } : {}) } as never,
      },
    });

  // ── Bug 4 修复：Source → Note contains_note 边 ────────────────────────
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
