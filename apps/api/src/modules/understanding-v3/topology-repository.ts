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
 * - topologyRevision / checkpointToken 改为拓扑内容的确定性 sha256 指纹
 *   （排序后的节点标识 + 边标识；TP-07 缓存语义修复）。旧实现
 *   "v3-{nodes.length}-{edges.length}" 在数量不变、内容变化时不失效，
 *   checkpointToken "v3-{Date.now()}" 每次请求必变、无法比较。消费方只有
 *   routes.ts 的 ETag/If-None-Match 协商，依赖"内容变 → revision 变"。
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql, desc } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { logger } from "../../lib/logger.ts";
import { notes, sources } from "@ailearn/shared/db-schema/note";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningObjectiveLineageV2,
  learningObjectiveOriginsV2,
  evidenceSnapshotsV2,
  learningCardsV2,
  initialValidationRemindersV2,
  learningExposuresV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { learningRuns, canonicalLearningEventOutbox, practiceTrailEventOutbox } from "@ailearn/shared/db-schema/learning-runs";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import { resolvePrimaryActionV3, type ActionResolverInputV3 } from "../learning-objectives/action-resolver.ts";
import type {
  UnderstandingNodeProjectionV3,
  UnderstandingEdgeProjectionV3,
  UnderstandingTopologySnapshotV3,
  ObjectiveSurfaceLifecycleV3,
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

/**
 * ── 拓扑快照单集合上限护栏（稳定 P0-2，2026-09-15 审计）───────────────────
 *
 * 审计事实：本文件此前**每一条**读都是 `WHERE workspace_id = $1` 全量读，没有任何
 * LIMIT。一个笔记/目标数量很大的 workspace 会让 GET /v3/understanding/topology
 * 把整个知识图谱搬进内存（notes + sources + objectives + revisions + lineage +
 * runs + evidence + cards + …），再对全部节点/边做 sha256 指纹。单次请求的内存与
 * 延迟随 workspace 规模**无上界**增长，且这条路径与请求共用同一个 25 连接的池。
 *
 * 上限策略（有意为之，逐条说明）：
 *   1. **单一旋钮**：每个集合共用一个上限 `TOPOLOGY_SNAPSHOT_COLLECTION_LIMIT`
 *      （默认 5000，硬上限 50000）。不给 16 条查询各配一个 env——那只会制造
 *      漂移和「调了 A 忘了 B」的空洞。
 *   2. **不许静默截断**：每条受限查询多取 1 行用于**探测**截断（`limit + 1`），
 *      一旦超限就把 `integrity.truncated` 置 true 并在响应里如实回报。此前
 *      `truncated` 是硬编码 `false`、`continuationToken` 是硬编码 `null`，即
 *      使将来加了 LIMIT 也会对外撒谎——所以二者必须同时改造。
 *   3. **确定性**：带 LIMIT 的查询一律加稳定的 ORDER BY（唯一键或「业务列 +
 *      唯一键」），否则截断点上的行集合会在请求间抖动，而 topologyRevision 是
 *      内容哈希、被 ETag/If-None-Match 消费——行集合抖动会让 304 永远不命中。
 *   4. **这不是分页**：`continuationToken` 仍为 null。真正的分页需要客户端协议
 *      （游标语义、合并顺序、UI 增量渲染），当前没有 V3 拓扑的客户端消费方
 *      （只有 routes.ts 的 ETag 协商）。本护栏是「宁可少画一部分并如实标注」
 *      的兜底，而不是「把全量拆成多页」的实现。
 *   5. 派生集合（`inArray` 于已受限 id 列表之上的查询）天然被主集合约束；唯一
 *      例外是 `evidenceSnapshotIds`——它是对 origins 的**扁平并集**，条数与
 *      objective 数无上界关系，且 PostgreSQL 绑定参数上限是 65535，超限会让
 *      查询直接报错。故该列表自身也要设上限。
 *
 * 最坏情况界：nodes/edges 各自 ≤ 4 × 上限（note/source/objective/evidence 四类
 * 节点来源），默认 5000 时约 2 万条，指纹计算与响应体都是有界的。
 */
export const TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT = 5000;
export const TOPOLOGY_SNAPSHOT_MAX_COLLECTION_LIMIT = 50_000;

export function resolveTopologySnapshotCollectionLimit(
  raw: string | undefined = process.env.TOPOLOGY_SNAPSHOT_COLLECTION_LIMIT,
): number {
  const parsed = Number(raw ?? TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return TOPOLOGY_SNAPSHOT_DEFAULT_COLLECTION_LIMIT;
  }
  return Math.min(parsed, TOPOLOGY_SNAPSHOT_MAX_COLLECTION_LIMIT);
}

interface TopologyTruncationReport {
  truncated: boolean;
  /** 触发截断的集合名（去重、稳定顺序），仅用于日志与自检。 */
  collections: string[];
}

function createTopologyTruncationReport(): TopologyTruncationReport {
  return { truncated: false, collections: [] };
}

function recordTruncation(report: TopologyTruncationReport, collection: string): void {
  report.truncated = true;
  if (!report.collections.includes(collection)) report.collections.push(collection);
}

/**
 * 收下 `limit + 1` 行的探测结果：未超限时原样返回，超限时丢弃探测行并记账。
 */
function boundedCollection<TRow>(
  rows: TRow[],
  collection: string,
  limit: number,
  report: TopologyTruncationReport,
): TRow[] {
  if (rows.length <= limit) return rows;
  recordTruncation(report, collection);
  return rows.slice(0, limit);
}

/**
 * IN 列表自身的上限。排序后再截断，保证「丢掉哪些 id」在请求间确定（否则
 * topologyRevision 会抖动），同时避免超出 PostgreSQL 的绑定参数上限。
 */
function boundedIdList(
  ids: string[],
  collection: string,
  limit: number,
  report: TopologyTruncationReport,
): string[] {
  if (ids.length <= limit) return ids;
  recordTruncation(report, collection);
  return [...ids].sort().slice(0, limit);
}

export async function buildTopologySnapshotV3(
  tx: ApiTransaction,
  ctx: TopologyContext,
): Promise<UnderstandingTopologySnapshotV3> {
  const nodes: UnderstandingNodeProjectionV3[] = [];
  const edges: UnderstandingEdgeProjectionV3[] = [];
  const collectionLimit = resolveTopologySnapshotCollectionLimit();
  const probeLimit = collectionLimit + 1;
  const truncation = createTopologyTruncationReport();

  // ── TP-01：Source / Note 节点（0-card Note 仍存在）────────────────────
  const noteRows = boundedCollection(
    await tx
      .select({ id: notes.id, title: notes.title, currentVersionId: notes.currentVersionId, sourceId: notes.sourceId })
      .from(notes)
      .where(and(eq(notes.workspaceId, ctx.workspaceId), isNull(notes.deletedAt)))
      .orderBy(notes.id)
      .limit(probeLimit),
    "notes",
    collectionLimit,
    truncation,
  );
  const noteById = new Map(noteRows.map((n) => [n.id, n]));
  for (const note of noteRows) {
    nodes.push({
      nodeRef: { kind: "note", noteId: note.id },
      label: note.title,
      currentVersionId: note.currentVersionId ?? note.id,
      // 这里曾是硬编码的 `freshness: "current"`（见 shared 合同注释）。
      // 服务端只有「这篇笔记背后有没有来源」是真实的，就只报这一项。
      hasSource: note.sourceId !== null,
    });
  }
  const sourceRows = boundedCollection(
    await tx
      .select({ id: sources.id, title: sources.title, type: sources.type, createdAt: sources.createdAt })
      .from(sources)
      .where(eq(sources.workspaceId, ctx.workspaceId))
      .orderBy(sources.id)
      .limit(probeLimit),
    "sources",
    collectionLimit,
    truncation,
  );
  for (const source of sourceRows) {
    nodes.push({
      nodeRef: { kind: "source", sourceId: source.id },
      label: source.title,
      modality: source.type,
      createdAt: source.createdAt.toISOString(),
    });
  }

  // ── TP-02：Objective 节点（conceptLabel；不生成 Card Presentation 节点）──
  const objectiveRows = boundedCollection(
    await tx
      .select()
      .from(learningObjectivesV2)
      .where(eq(learningObjectivesV2.workspaceId, ctx.workspaceId))
      .orderBy(learningObjectivesV2.objectiveId)
      .limit(probeLimit),
    "objectives",
    collectionLimit,
    truncation,
  );
  const objectiveIds = objectiveRows.map((o) => o.objectiveId);
  const revisionRows = objectiveRows.length > 0
    ? await tx
        // AI-perf #4（2026-09-15 审计）：此前是 `.select()`（全列）——把
        // canonical_answer / learning_support / scoring_rubric / evidence_bindings
        // 四个大 jsonb 及其余十余列全部搬回应用层，而本文件只用到 5 个字段
        // （objectiveRevisionId / objectiveId / conceptLabel / publicSummary /
        // relations，见 :452/:453/:534/:552/:558）。改为精确投影，payload 大幅缩小，
        // 行为与输出完全不变（不是截断）。
        .select({
          objectiveRevisionId: learningObjectiveRevisionsV2.objectiveRevisionId,
          objectiveId: learningObjectiveRevisionsV2.objectiveId,
          conceptLabel: learningObjectiveRevisionsV2.conceptLabel,
          publicSummary: learningObjectiveRevisionsV2.publicSummary,
          relations: learningObjectiveRevisionsV2.relations,
        })
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
  // learningRuns 没有 keyPointId 列；严格 V2 origin 直接携带 objectiveId。
  // 性能修复：原先查该用户全量 runs 再在内存中过滤，当用户有大量历史
  // runs 时会严重退化。改为在 SQL 层限定到目标 objectiveIds，只查相关 runs。
  // 安全：objectiveIds 作为 Drizzle sql 参数绑定，无注入风险。
  const objectiveIdSet = new Set(objectiveIds);
  // 上限护栏：按 createdAt DESC 取最近 limit+1 条——截断方向与语义一致，每个
  // objective 的 active run 都是该 objective 最新的 run，「最近的 N 条」足以保住
  // active 判定，被丢掉的是更老的历史。次级排序键 id 保证边界行集合确定。
  const allRunRows = objectiveIds.length > 0
    ? boundedCollection(
        await tx
          .select({ runId: learningRuns.id, phase: learningRuns.phase, origin: learningRuns.origin, createdAt: learningRuns.createdAt })
          .from(learningRuns)
          .where(and(
            eq(learningRuns.workspaceId, ctx.workspaceId),
            eq(learningRuns.userId, ctx.userId),
            // Build a bound scalar list rather than interpolating a JS array into
            // a PostgreSQL cast; postgres-js serializes the latter as a malformed
            // array literal for the single-objective case.
            sql`${learningRuns.origin}->>'objectiveId' IN (${sql.join(objectiveIds.map((id) => sql`${id}`), sql`, `)})`,
          ))
          .orderBy(desc(learningRuns.createdAt), desc(learningRuns.id))
          .limit(probeLimit),
        "learning_runs",
        collectionLimit,
        truncation,
      )
    : [];
  const runByObjective = new Map<string, { runId: string; phase: string }>();
  const allRunIds: string[] = [];
  const runIdToObjective = new Map<string, string>();
  for (const run of allRunRows) {
    const objectiveId = (run.origin as Record<string, unknown> | null)?.objectiveId as string | undefined;
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
  // 上限护栏：这是对 origins 的**扁平并集**，条数与 objective 数无上界关系，
  // 且它会被内联成 IN 列表（PostgreSQL 绑定参数上限 65535，超限直接报错）。
  // boundedIdList 会先排序再截断，保证丢弃集合确定（否则 revision 抖动）。
  const evidenceSnapshotIds = boundedIdList(
    [...new Set(originRows.flatMap((o) => (o.evidenceSnapshotIds ?? []) as string[]))],
    "evidence_snapshots",
    collectionLimit,
    truncation,
  );
  // 安全修复：evidenceSnapshotsV2 查询必须加 workspaceId 条件（§20.3 RLS）。
  // 原先只按 evidenceSnapshotId IN(...) 查询，缺少 workspace 隔离。
  const evidenceRows = evidenceSnapshotIds.length > 0
    ? await tx
        .select({ evidenceSnapshotId: evidenceSnapshotsV2.evidenceSnapshotId, supportDescription: evidenceSnapshotsV2.supportDescription, sourceContentHash: evidenceSnapshotsV2.sourceContentHash })
        .from(evidenceSnapshotsV2)
        .where(and(
          eq(evidenceSnapshotsV2.workspaceId, ctx.workspaceId),
          inArray(evidenceSnapshotsV2.evidenceSnapshotId, evidenceSnapshotIds),
        ))
        // 与 boundedIdList 的截断顺序一致：即使并集未超限也保持行序确定。
        .orderBy(evidenceSnapshotsV2.evidenceSnapshotId)
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
  // AI-perf #4（2026-09-15 审计）：lineage 表此前被查**两次**——此处一次
  // 「predecessor ∈ 当前 revisions 且 relation=supersedes」的过滤查询，原 :526
  // 又一次「整 workspace 全量」查询用于建 supersedes 边。后者是前者的超集，且本
  // 快照函数全程只读，因此合并成**一次**全量读，这里在内存里筛出所需子集：
  // 少一次 DB 往返、少一次表扫描（也少一次 jsonb/全列搬运）。
  const lineageRows = boundedCollection(
    await tx
      .select()
      .from(learningObjectiveLineageV2)
      .where(eq(learningObjectiveLineageV2.workspaceId, ctx.workspaceId))
      .orderBy(learningObjectiveLineageV2.id)
      .limit(probeLimit),
    "lineage",
    collectionLimit,
    truncation,
  );
  const allRevisionIdSet = new Set(allRevisionIds);
  const topologyLineageRows = allRevisionIds.length > 0
    ? lineageRows.filter(
        (lin) => lin.relation === "supersedes" && allRevisionIdSet.has(lin.predecessorRevisionId),
      )
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
      // 与 surface-service computeFreshness 对齐：只检查 note origin。
      const noteOrigins = origins.filter((o) => o.originKind === "note" && o.noteId);
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
    };
    const primaryAction = resolvePrimaryActionV3(actionInput);

    nodes.push({
      nodeRef: { kind: "objective", objectiveId: objective.objectiveId },
      label: revision?.conceptLabel ?? revision?.publicSummary.slice(0, 40) ?? "未命名目标",
      publicSummary: revision?.publicSummary ?? "",
      activeCardId: cardId,
      lifecycle: objective.lifecycle as ObjectiveSurfaceLifecycleV3,
      freshness,
      personal: {
        // 与 surface-service toObjectiveListItemV3 的 state 映射保持一致。
        // 优先级：archived > superseded > activeRun > review due > scheduled
        // > source_outdated > stable/unvalidated（有 canonical → stable）。
        state: objective.lifecycle === "archived"
          ? "archived"
          : objective.lifecycle === "superseded"
            ? "superseded"
            : activeRun
              ? "learning"
              : reviewDue
                ? "due_review"
                : schedule
                  ? "scheduled"
                  : freshness === "source_outdated"
                    ? "outdated"
                    : lastCanonicalEventId
                      ? "stable"
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
          reasonCodes: ["origin_note"],
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
  // AI-perf #4（2026-09-15 审计）：lineage 行已在上面一次性读入（lineageRows），
  // 此处不再重复查询同一张表。
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

  // ── TP-07：integrity + pagination（单页；continuationToken 预留）────────
  // revision/token 由拓扑内容确定性派生（见 computeTopologyRevisionV3）：
  // 同一拓扑内容 → 同一 revision/token；节点增删或 lifecycle/freshness 迁移、
  // 边增删都会改变哈希。checkpointToken 是同一哈希的确定性派生，不再使用
  // Date.now()（每次请求必变，令 token 不可比较）。
  //
  // truncated 不再硬编码 false：它是本次构建所有集合护栏的并集（见文件顶部的
  // 「拓扑快照单集合上限护栏」）。这与「不静默截断」是同一条规则——客户端必须
  // 能区分「图谱就这么大」和「图谱被护栏截断」。
  const revisionHash = computeTopologyRevisionV3(nodes, edges);
  if (truncation.truncated) {
    // 护栏触发是运维信号（容量规划），不是请求错误：照常返回可用的部分图谱。
    logger.warn(
      {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        collectionLimit,
        truncatedCollections: truncation.collections,
        nodeCount: nodes.length,
        edgeCount: edges.length,
      },
      "topology snapshot truncated by collection cap",
    );
  }
  return {
    version: 3,
    workspaceId: ctx.workspaceId,
    topologyRevision: "v3-" + revisionHash,
    checkpointToken: "ckpt-v3-" + revisionHash,
    nodes,
    edges,
    continuationToken: null,
    integrity: {
      truncated: truncation.truncated,
      missingOriginObjectiveIds,
    },
  };
}

/**
 * 拓扑内容指纹：对排序后的节点标识（nodeRef kind+id+lifecycle/freshness）
 * 与边标识（两端点+kind）序列化做 sha256，取前 24 位十六进制。
 *
 * 排序是必需的：节点/边来自多条无 ORDER BY 的查询，行返回顺序不稳定，
 * 排序后同一拓扑内容在任何请求下都产生同一哈希（ETag 304 可达的前提）。
 * 刻意不纳入 label/summary 等展示文本与 edgeId/reasonCodes：指纹只反映
 * 拓扑结构（节点集合 + 状态 + 边集合）。
 */
function computeTopologyRevisionV3(
  nodes: readonly UnderstandingNodeProjectionV3[],
  edges: readonly UnderstandingEdgeProjectionV3[],
): string {
  const lines = [
    ...nodes.map(topologyNodeIdentity),
    ...edges.map(topologyEdgeIdentity),
  ].sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 24);
}

/** 节点标识：nodeRef kind+id + objective 的 lifecycle/freshness、note 的
 *  hasSource 连接状态。 */
function topologyNodeIdentity(node: UnderstandingNodeProjectionV3): string {
  // 合同为 z.union（普通联合、非 discriminated union）：嵌套属性 switch 只能
  // 收窄 nodeRef，收窄不了外层 node；状态字段用 in 守卫提取（每个键只属于一种
  // 节点，见 shared 合同与 graph-sky 的守卫说明）。
  const ref = node.nodeRef;
  const lifecycle = "lifecycle" in node ? node.lifecycle : "";
  const freshness = "freshness" in node ? node.freshness : "";
  // 笔记不再有 freshness；它与来源的连接关系是这份指纹里会变化的部分。
  const sourceLink = "hasSource" in node ? String(node.hasSource) : "";
  const id =
    ref.kind === "source" ? ref.sourceId
      : ref.kind === "note" ? ref.noteId
        : ref.kind === "objective" ? ref.objectiveId
          : ref.evidenceSnapshotId;
  return `${ref.kind}|${id}|${lifecycle}|${freshness}|${sourceLink}`;
}

/** 边标识：from 端点 + kind + to 端点。 */
function topologyEdgeIdentity(edge: UnderstandingEdgeProjectionV3): string {
  return `${edge.from.kind}:${edge.from.id}|${edge.kind}|${edge.to.kind}:${edge.to.id}`;
}

// ─── 快照 TTL 缓存（AI-perf #4，2026-09-15 审计）────────────────────────────

/**
 * 拓扑快照的**进程内 TTL 缓存**。
 *
 * 问题：`GET /v3/understanding/topology` 每次都重建整份快照（15 个串行 await、
 * 16 条语句、多个无 LIMIT 的全量读 + jsonb 全列搬运），**然后**才比较
 * If-None-Match —— 也就是说客户端拿到 304（内容没变）同样要付全额代价，
 * ETag 协商省下的只是带宽，省不下 DB。
 *
 * 这里加一层有界 TTL 缓存：命中时 revision 与上次一致 → 路由照常回 304，零 DB 往返。
 *
 * 为什么用 TTL 而不是"按表水位失效"：水位方案要求每张相关表都有可靠的
 * `updated_at`，漏一张就会**无限期**返回陈旧数据（比慢更糟）；TTL 的陈旧上界
 * 是可证明的，等于 TTL 本身。
 *
 * 正确性边界：
 * - 缓存键同时包含 workspaceId 与 userId，不会跨租户/跨用户命中（RLS 语义不受影响）。
 * - 返回的是同一对象引用；调用方（Fastify 序列化）只读，不得就地修改。
 * - 内容变化到可见之间有 ≤ TTL 的延迟；路由发的是 `private, no-cache`（客户端每次
 *   都来协商），10s 量级的陈旧与客户端缓存语义一致。拓扑是阅读视图，可接受。
 * - 可用 `TOPOLOGY_SNAPSHOT_CACHE_MS` 调整；设 0 关闭缓存（回到原行为）。
 */
const TOPOLOGY_SNAPSHOT_CACHE_MAX_ENTRIES = 64;

type CachedTopologySnapshot = {
  snapshot: UnderstandingTopologySnapshotV3;
  expiresAt: number;
};

const topologySnapshotCache = new Map<string, CachedTopologySnapshot>();

/** 缓存 TTL（毫秒）。空/非法 → 10s；0 → 关闭缓存。 */
export function resolveTopologySnapshotCacheTtlMs(
  raw: string | undefined = process.env.TOPOLOGY_SNAPSHOT_CACHE_MS,
): number {
  if (raw === undefined || raw.trim() === "") return 10_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 10_000;
}

/** 测试钩子：清空缓存，避免用例之间互相影响。 */
export function resetTopologySnapshotCacheForTests(): void {
  topologySnapshotCache.clear();
}

/**
 * 带 TTL 缓存的快照构建。语义与 {@link buildTopologySnapshotV3} 一致，
 * 仅在 TTL 窗口内复用上一次的结果（同一 revision → ETag 304 可达）。
 */
/**
 * 读缓存：命中且未过期时返回快照，否则返回 null。
 *
 * 路由在**开启事务之前**调用它——命中时连 withWorkspaceTransaction 的连接与
 * SET config 往返都省掉（AI-perf #4 的关键：304 路径完全无 DB 成本）。
 */
export function readTopologySnapshotCache(
  ctx: TopologyContext,
): UnderstandingTopologySnapshotV3 | null {
  if (resolveTopologySnapshotCacheTtlMs() <= 0) return null;
  const cacheKey = `${ctx.workspaceId}:${ctx.userId}`;
  const hit = topologySnapshotCache.get(cacheKey);
  if (!hit) return null;
  if (hit.expiresAt > Date.now()) return hit.snapshot;
  topologySnapshotCache.delete(cacheKey);
  return null;
}

/** 写缓存（供构建路径使用）。 */
export function writeTopologySnapshotCache(
  ctx: TopologyContext,
  snapshot: UnderstandingTopologySnapshotV3,
): void {
  const ttlMs = resolveTopologySnapshotCacheTtlMs();
  if (ttlMs <= 0) return;
  const cacheKey = `${ctx.workspaceId}:${ctx.userId}`;
  // 有界：Map 保持插入顺序，超限时淘汰最早插入的一条（近似 FIFO）。
  if (topologySnapshotCache.size >= TOPOLOGY_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldestKey = topologySnapshotCache.keys().next().value;
    if (oldestKey !== undefined) topologySnapshotCache.delete(oldestKey);
  }
  topologySnapshotCache.set(cacheKey, { snapshot, expiresAt: Date.now() + ttlMs });
}

/**
 * 带 TTL 缓存的快照构建。语义与 {@link buildTopologySnapshotV3} 一致，
 * 仅在 TTL 窗口内复用上一次的结果（同一 revision → ETag 304 可达）。
 */
export async function buildTopologySnapshotV3Cached(
  tx: ApiTransaction,
  ctx: TopologyContext,
): Promise<UnderstandingTopologySnapshotV3> {
  const cached = readTopologySnapshotCache(ctx);
  if (cached) return cached;
  const snapshot = await buildTopologySnapshotV3(tx, ctx);
  writeTopologySnapshotCache(ctx, snapshot);
  return snapshot;
}
