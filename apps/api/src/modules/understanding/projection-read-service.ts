/**
 * Understanding Projection 读取服务（文档 16 §15.2/§15.6）。
 *
 * GET /understanding/projection 的事务体：published outbox → shared 平面
 * （V2 cards → objectives → note/source 血缘）+ personal 事实 → 节点/边投影
 * （§15.2 UnderstandingNodeProjectionV2 / UnderstandingEdgeProjectionV2）→
 * checkpoint 签发 + ETag/304 判定。route 侧只保留 HTTP 关注点（query 校验、
 * minimumCheckpoint 202、outcome→HTTP 映射），响应合同不变。
 *
 * 本服务只接受调用方的事务（不自行开启），与 route-plan-service.ts 一致；
 * 例外是 latestProjectionWatermark——minimumCheckpoint 新鲜度检查发生在投影
 * 事务之前，由 route 调用（自开只读事务），保持迁移前的事务边界不变。
 */

import { count, and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import {
  learningCardsV2,
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { notes, noteVersions, sources } from "@ailearn/shared/db-schema/note";
import { visibleCardsCondition, visibleNotesCondition, visibleObjectivesCondition } from "../note/visibility.ts";
import {
  understandingProjectionCheckpoints,
  understandingRoutePlans,
} from "@ailearn/shared/db-schema/understanding-projection";
import {
  canonicalLearningEventOutbox,
  practiceTrailEventOutbox,
  learningRuns,
} from "@ailearn/shared/db-schema/learning-runs";
import { issueCheckpointToken, type CheckpointWatermark } from "./projection-checkpoint.ts";
import { sha256Hex } from "@ailearn/shared/content-hash";
import { logger } from "../../lib/logger.ts";

export interface ProjectionReadScope {
  workspaceId: string;
  userId: string;
}

/** 投影 lens（§15.2；缺省 current_target）。 */
export type ProjectionReadLens = "current_target" | "evidence" | "provenance" | "issues";

/** GET /understanding/projection 的输入：已校验 query（projectionQuerySchema 输出，
 * 形状与 route 保持同步）+ 请求头，以及 route 已解析的 minimumCheckpoint token。 */
export interface ProjectionReadParams {
  lens?: ProjectionReadLens;
  targetKeyPointId?: string;
  routePlanId?: string;
  sourceId?: string;
  cardId?: string;
  showArchived?: boolean;
  continuation?: string;
  /** 原始 minimumCheckpoint token：携带时禁止 304 缓存命中（§15.6）。 */
  minimumCheckpoint: string | null;
  ifNoneMatch: string | undefined;
}

/** §15.2 投影响应体（route 原样 send；字段与迁移前逐字一致）。 */
export interface UnderstandingProjectionReadBody {
  version: 2;
  generatedAt: string;
  checkpoint: {
    version: 1;
    workspaceId: string;
    userId: string;
    token: string;
    capturedAt: string;
  } | null;
  planes: { shared: "workspace_owned"; personal: "user_private" };
  request: {
    lens: ProjectionReadLens;
    filter: {
      showArchived: boolean;
      sourceId: string | undefined;
      cardId: string | undefined;
    };
    targetKeyPointId: string | null;
    routePlanId: string | null;
  };
  slice: {
    kind: "route" | "target_centered" | "workspace_map";
    continuationToken: string | null;
  };
  evidenceTruncated: false;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  currentTarget: { keyPointId: string; reasonCodes: string[] } | null;
}

/** GET /understanding/projection 的终态结果，route 逐字映射为 HTTP。
 * pending 由 route 的 minimumCheckpoint 前置检查产生（投影事务本身不会返回它），
 * 与其余分支同属一个 union 以保证映射完备。 */
export type ProjectionReadOutcome =
  | { status: "ok"; etag: string; body: UnderstandingProjectionReadBody }
  | { status: "not_modified"; etag: string }
  | { status: "bad_request"; message: string }
  | { status: "route_plan_stale"; message: string }
  | { status: "pending" };

/** 确定性血缘边 id（§15.2 UnderstandingEdgeProjectionV2.edgeId）。 */
export function projectionEdgeId(kind: string, from: string, to: string): string {
  return sha256Hex(`edge:${kind}:${from}:${to}`).slice(0, 24);
}

/** kp 分页页大小：env PROJECTION_KP_PAGE_SIZE 可调（默认 400，上限 2000）。
 * 每次请求读取（非模块级常量），便于运维/测试在进程内调整。 */
export function projectionKpPageSize(): number {
  const raw = Number(process.env.PROJECTION_KP_PAGE_SIZE);
  return Number.isFinite(raw) && raw >= 1 && raw <= 2000 ? Math.floor(raw) : 400;
}

// N#7-5: 投影全图模式（无 cardId/targetKeyPointId/routeCardIds 过滤）下 card 装载上限，防止
// 大工作区全量活跃消费卡无界装载。与 kp 分片思想对齐：超限记告警并截断（超限部分的卡及其 kp
// 不进入投影快照）。
const PROJECTION_MAX_CARDS = 5000;

const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

/** kp 游标时间戳：to_char 微秒文本（UTC 固定格式）——字典序即时间序，
 * 且不受 JS Date 毫秒截断影响（timestamptz 微秒精度全保真）。
 * V2：kp 单元 = learningObjectivesV2 行，时间轴取 objective 的 createdAt。 */
function projectionKpCreatedAtText() {
  return sql<string>`to_char(${learningObjectivesV2.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;
}

/** 分页游标编码（opaque base64url JSON；客户端不得解析或自行构造）。 */
export function encodeProjectionCursor(kpId: string, createdAtText: string): string {
  return Buffer.from(JSON.stringify({ k: "kp", i: kpId, c: createdAtText }), "utf8").toString("base64url");
}

/** 分页游标解码；任何格式/内容不符 → null（调用方 400）。 */
export function decodeProjectionCursor(token: string): { kpId: string; createdAtText: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { k?: unknown; i?: unknown; c?: unknown };
    if (parsed.k !== "kp" || typeof parsed.i !== "string" || typeof parsed.c !== "string") return null;
    if (!CURSOR_TIME_PATTERN.test(parsed.c)) return null;
    return { kpId: parsed.i, createdAtText: parsed.c };
  } catch {
    return null;
  }
}

/** §15.2 UnderstandingPersonalStateV1 的 key_point → card 聚合。 */
export function aggregateCardPersonal(
  kps: Array<{
    state: "unknown" | "forming" | "stable" | "fragile" | "needs_repair";
    nextReviewAt: string | null;
    activeScheduleId: string | null;
    lastCanonicalEventId: string | null;
    lastCanonicalOccurredAt: string | null;
    practiceTrailCount: number;
  }>,
): {
  state: "unknown" | "forming" | "stable" | "fragile" | "needs_repair";
  nextReviewAt: string | null;
  activeScheduleId: string | null;
  lastCanonicalEventId: string | null;
  practiceTrailCount: number;
} {
  if (kps.length === 0) {
    return {
      state: "unknown",
      nextReviewAt: null,
      activeScheduleId: null,
      lastCanonicalEventId: null,
      practiceTrailCount: 0,
    };
  }
  // state 取"最需要关注"的优先级：needs_repair > fragile > stable > forming > unknown。
  const priority: Record<string, number> = {
    needs_repair: 4,
    fragile: 3,
    stable: 2,
    forming: 1,
    unknown: 0,
  };
  let state: "unknown" | "forming" | "stable" | "fragile" | "needs_repair" = "unknown";
  let best = -1;
  let earliestReview: string | null = null;
  let activeScheduleId: string | null = null;
  let lastCanonicalEventId: string | null = null;
  let latestCanonicalAt: string | null = null;
  let practiceTrailCount = 0;
  for (const kp of kps) {
    const p = priority[kp.state] ?? 0;
    if (p > best) {
      best = p;
      state = kp.state;
    }
    if (kp.nextReviewAt && (earliestReview === null || kp.nextReviewAt < earliestReview)) {
      earliestReview = kp.nextReviewAt;
    }
    if (kp.activeScheduleId) activeScheduleId = kp.activeScheduleId;
    // canonical id 无时间语义（canonical:<hash>）：按事实发生时间取最新。
    if (
      kp.lastCanonicalEventId
      && kp.lastCanonicalOccurredAt
      && (latestCanonicalAt === null || kp.lastCanonicalOccurredAt > latestCanonicalAt)
    ) {
      latestCanonicalAt = kp.lastCanonicalOccurredAt;
      lastCanonicalEventId = kp.lastCanonicalEventId;
    }
    practiceTrailCount += kp.practiceTrailCount;
  }
  return {
    state,
    nextReviewAt: earliestReview,
    activeScheduleId,
    lastCanonicalEventId,
    practiceTrailCount,
  };
}

/** 当前最新投影 watermark（canonical/practice 事件 id + capturedAt）。 */
export async function latestProjectionWatermark(
  scope: ProjectionReadScope,
): Promise<CheckpointWatermark | null> {
  return withWorkspaceTransaction(scope, async (tx) => {
    const rows = await tx
      .select({
        token: understandingProjectionCheckpoints.token,
        canonical: understandingProjectionCheckpoints.lastCanonicalEventId,
        practice: understandingProjectionCheckpoints.lastPracticeEventId,
        capturedAt: understandingProjectionCheckpoints.capturedAt,
      })
      .from(understandingProjectionCheckpoints)
      .where(and(
        eq(understandingProjectionCheckpoints.workspaceId, scope.workspaceId),
        eq(understandingProjectionCheckpoints.userId, scope.userId),
      ))
      .orderBy(desc(understandingProjectionCheckpoints.capturedAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      lastCanonicalEventId: row.canonical,
      lastPracticeEventId: row.practice,
      capturedAt: row.capturedAt.toISOString(),
    };
  });
}

/**
 * §15.2/§15.6 投影读取：canonical/practice 事实 + shared 平面血缘 → 节点/边投影。
 * 所有校验在投影事务内按原顺序执行；任何终态都以 ProjectionReadOutcome 返回
 * （route 逐字映射 HTTP），本函数不接触 reply。
 */
export async function loadUnderstandingProjection(
  tx: ApiTransaction,
  scope: ProjectionReadScope,
  params: ProjectionReadParams,
): Promise<ProjectionReadOutcome> {
  const lens = params.lens ?? "current_target";
  // 该 user 的 canonical envelope（published）→ personal 事实。
  const envelopeRows = await tx
    .select()
    .from(canonicalLearningEventOutbox)
    .where(and(
      eq(canonicalLearningEventOutbox.workspaceId, scope.workspaceId),
      eq(canonicalLearningEventOutbox.userId, scope.userId),
      eq(canonicalLearningEventOutbox.status, "published"),
    ))
    .orderBy(desc(canonicalLearningEventOutbox.createdAt))
    .limit(100);
  const practiceRows = await tx
    .select()
    .from(practiceTrailEventOutbox)
    .where(and(
      eq(practiceTrailEventOutbox.workspaceId, scope.workspaceId),
      eq(practiceTrailEventOutbox.userId, scope.userId),
      eq(practiceTrailEventOutbox.status, "published"),
      // §16.4：官方 personal plane 只投影 official_user trail；
      // sandbox trail 绝不混入正式投影。
      eq(practiceTrailEventOutbox.scope, "official_user"),
    ))
    .orderBy(desc(practiceTrailEventOutbox.createdAt))
    .limit(100);

  const targetKeyPointId = params.targetKeyPointId ?? null;
  const routePlanId = params.routePlanId ?? null;
  if (routePlanId && targetKeyPointId) {
    return { status: "bad_request", message: "routePlanId 与 targetKeyPointId 互斥" };
  }
  // §15.2/§15.3 route slice：加载 RoutePlan 全部 step 节点（完整、不分页）。
  let routeKpIds: string[] | null = null;
  let routeCardIds: string[] = [];
  if (routePlanId) {
    const planRows = await tx
      .select({
        steps: understandingRoutePlans.steps,
        expiresAt: understandingRoutePlans.expiresAt,
      })
      .from(understandingRoutePlans)
      .where(and(
        eq(understandingRoutePlans.id, routePlanId),
        eq(understandingRoutePlans.workspaceId, scope.workspaceId),
        eq(understandingRoutePlans.userId, scope.userId),
      ))
      .limit(1);
    const plan = planRows[0];
    if (!plan || plan.expiresAt.getTime() < Date.now()) {
      return { status: "route_plan_stale", message: "路线已失效，请重新规划" };
    }
    const steps = plan.steps as Array<{ nodeRef?: { keyPointId?: string } }>;
    routeKpIds = steps
      .map((step) => step.nodeRef?.keyPointId)
      .filter((id): id is string => Boolean(id));
    if (routeKpIds.length > 0) {
      // V2：route step 的 keyPointId 是 objectiveId；由 V2 卡反查 cardId。
      const kpCardRows = await tx
        .select({ cardId: learningCardsV2.cardId })
        .from(learningCardsV2)
        .where(and(
          eq(learningCardsV2.workspaceId, scope.workspaceId),
          eq(learningCardsV2.lifecycle, "active"),
          inArray(learningCardsV2.objectiveId, routeKpIds),
        ));
      routeCardIds = Array.from(new Set(kpCardRows.map((row) => row.cardId).filter((id): id is string => Boolean(id))));
    }
  }
  const showArchived = params.showArchived ?? false;

  // ── shared 平面：V2 cards（active）→ keyPoints(objectives) →
  //    noteVersions → notes → sources（§15.2 shared plane）。
  // target 聚焦时先解析 target objective 的 card 作为血缘根。
  let targetCardId: string | null = null;
  if (targetKeyPointId) {
    const targetRows = await tx
      .select({ cardId: learningCardsV2.cardId })
      .from(learningCardsV2)
      .where(and(
        eq(learningCardsV2.objectiveId, targetKeyPointId),
        eq(learningCardsV2.workspaceId, scope.workspaceId),
        eq(learningCardsV2.lifecycle, "active"),
      ))
      .limit(1);
    targetCardId = targetRows[0]?.cardId ?? null;
  }
  const cardFilterCondition = params.cardId
    ? eq(learningCardsV2.cardId, params.cardId)
    : targetCardId
      ? eq(learningCardsV2.cardId, targetCardId)
      : routeCardIds.length > 0
        ? inArray(learningCardsV2.cardId, routeCardIds)
        : undefined;
  // N#7-5: 全图模式（card 无过滤，cardFilterCondition===undefined）会对整工作区活跃消费卡无界装载，
  // 加 limit 对齐 kp 分片；单卡/路由模式集合已受过滤约束，无需 limit。
  const isUnboundedCardLoad = cardFilterCondition === undefined;
  // V2：卡标题用 publicSummary（font jsonb 的 cue 不再参与标题）；cardId 是稳定公共卡 id。
  let cardQuery = tx
    .select({
      id: learningCardsV2.cardId,
      objectiveId: learningCardsV2.objectiveId,
      noteVersionId: learningCardsV2.noteVersionId,
      title: learningCardsV2.publicSummary,
      sourceFingerprint: learningCardsV2.presentationHash,
    })
    .from(learningCardsV2)
    .where(and(
      eq(learningCardsV2.workspaceId, scope.workspaceId),
      eq(learningCardsV2.lifecycle, "active"),
      // 节点标题就是卡的 `public_summary`（从笔记正文抽出来的一句），所以这里必须
      // 跟着来源笔记判——星图上多出一个别人私有笔记的摘要，等于边界白画。
      cardFilterCondition,
      visibleCardsCondition(scope.userId, learningCardsV2.noteVersionId),
    ))
    .$dynamic();
  // 一律加确定排序使输出稳定；全图模式再加 limit。
  cardQuery = cardQuery.orderBy(desc(learningCardsV2.updatedAt), asc(learningCardsV2.cardId));
  if (isUnboundedCardLoad) {
    cardQuery = cardQuery.limit(PROJECTION_MAX_CARDS);
  }
  const cardRows = await cardQuery;
  if (isUnboundedCardLoad && cardRows.length >= PROJECTION_MAX_CARDS) {
    // N#8-4: 附带被截断总数——统计全量匹配活跃消费卡数，记告警明确快照被截断的规模，便于排障。
    let totalActiveCards: number | null = null;
    try {
      const total = await tx
        .select({ count: count() })
        .from(learningCardsV2)
        .where(and(
          eq(learningCardsV2.workspaceId, scope.workspaceId),
          eq(learningCardsV2.lifecycle, "active"),
        ));
      totalActiveCards = Number(total[0]?.count ?? 0);
    } catch {
      totalActiveCards = null;
    }
    logger.warn(
      {
        workspaceId: scope.workspaceId,
        limit: PROJECTION_MAX_CARDS,
        loaded: cardRows.length,
        totalActiveCards,
        truncated: totalActiveCards !== null
          ? Math.max(0, totalActiveCards - cardRows.length)
          : null,
      },
      "projection workspace_map 卡装载达到上限，快照可能不完整",
    );
  }
  const cardIds = Array.from(new Set(cardRows.map((card) => card.id)));
  // sourceId 过滤：只保留该 source 链上的 card（节点与 kp 同时收窄）。
  const filteredCardIds = params.sourceId
    ? (await tx
        .select({ cardId: learningCardsV2.cardId })
        .from(learningCardsV2)
        .innerJoin(noteVersions, eq(noteVersions.id, learningCardsV2.noteVersionId))
        .innerJoin(notes, and(
          eq(notes.id, noteVersions.noteId),
          visibleNotesCondition(scope.userId),
          isNull(notes.deletedAt),
        ))
        .where(and(
          eq(learningCardsV2.workspaceId, scope.workspaceId),
          eq(notes.sourceId, params.sourceId),
          cardIds.length > 0 ? inArray(learningCardsV2.cardId, cardIds) : undefined,
        )))
        .map((row) => row.cardId)
    : cardIds;
  const effectiveCardIds = params.sourceId ? filteredCardIds : cardIds;
  // O(1) membership for the sourceId-filtered card row filter (was O(n²)).
  const effectiveCardIdsSet = params.sourceId ? new Set(effectiveCardIds) : null;
  // sourceId 过滤时 card/note/source 节点同样收窄到该链。
  const sharedCardRows = params.sourceId
    ? cardRows.filter((card) => effectiveCardIdsSet!.has(card.id))
    : cardRows;

  // continuation 校验：非法 token → 400；target_centered（单 kp）不支持分页。
  const continuation = params.continuation
    ? decodeProjectionCursor(params.continuation)
    : null;
  if (params.continuation && !continuation) {
    return { status: "bad_request", message: "continuation 非法" };
  }
  if (targetKeyPointId && continuation) {
    return { status: "bad_request", message: "target_centered 不支持 continuation" };
  }
  if (routePlanId && continuation) {
    return { status: "bad_request", message: "route slice 不支持 continuation" };
  }
  // 全图模式 kp 游标分页：(createdAtText, id) 复合键保证全序——游标时间
  // 用 to_char 微秒文本（不受 JS Date 毫秒截断影响），批量插入同刻时靠
  // objectiveId 决胜；页大小按 env 可调，超页返回 continuationToken。
  // V2：kp 单元 = learningObjectivesV2（objectiveId 为稳定外部 id）。
  const kpPageSize = projectionKpPageSize();
  const isWorkspaceMap = !targetKeyPointId && !routePlanId;
  const kpObjectiveIds = Array.from(new Set([
    ...(targetKeyPointId ? [targetKeyPointId] : []),
    ...(routeKpIds ?? []),
    ...(sharedCardRows.map((card) => card.objectiveId)),
  ].filter((id): id is string => Boolean(id))));

  let kpHasMore = false;
  let objectiveRows: Array<{ objectiveId: string; sourceFingerprint: string; createdAtText: string }> = [];
  if (kpObjectiveIds.length > 0) {
    if (isWorkspaceMap) {
      const raw = await tx
        .select({
          objectiveId: learningObjectivesV2.objectiveId,
          sourceFingerprint: learningObjectivesV2.semanticTargetFingerprint,
          createdAtText: projectionKpCreatedAtText(),
        })
        .from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.workspaceId, scope.workspaceId),
          inArray(learningObjectivesV2.objectiveId, kpObjectiveIds),
          visibleObjectivesCondition(scope.userId, learningObjectivesV2.objectiveId),
          continuation
            ? or(
                sql`${projectionKpCreatedAtText()} > ${continuation.createdAtText}`,
                and(
                  sql`${projectionKpCreatedAtText()} = ${continuation.createdAtText}`,
                  gt(learningObjectivesV2.objectiveId, continuation.kpId),
                ),
              )
            : undefined,
        ))
        .orderBy(asc(learningObjectivesV2.createdAt), asc(learningObjectivesV2.objectiveId))
        .limit(kpPageSize + 1);
      if (raw.length > kpPageSize) {
        objectiveRows = raw.slice(0, kpPageSize);
        kpHasMore = true;
      } else {
        objectiveRows = raw;
      }
    } else {
      objectiveRows = await tx
        .select({
          objectiveId: learningObjectivesV2.objectiveId,
          sourceFingerprint: learningObjectivesV2.semanticTargetFingerprint,
          createdAtText: projectionKpCreatedAtText(),
        })
        .from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.workspaceId, scope.workspaceId),
          inArray(learningObjectivesV2.objectiveId, kpObjectiveIds),
          visibleObjectivesCondition(scope.userId, learningObjectivesV2.objectiveId),
        ));
    }
  }

  // objective → cardId（V2 卡，active）。
  const cardByObjective = new Map<string, string>();
  if (kpObjectiveIds.length > 0) {
    const kpCardRows = await tx
      .select({
        objectiveId: learningCardsV2.objectiveId,
        cardId: learningCardsV2.cardId,
      })
      .from(learningCardsV2)
      .where(and(
        eq(learningCardsV2.workspaceId, scope.workspaceId),
        eq(learningCardsV2.lifecycle, "active"),
        inArray(learningCardsV2.objectiveId, kpObjectiveIds),
      ));
    for (const r of kpCardRows) cardByObjective.set(r.objectiveId, r.cardId);
  }
  // objective → label（最新 revision 的 conceptLabel ?? publicSummary）。
  const labelByObjective = new Map<string, string>();
  if (kpObjectiveIds.length > 0) {
    const revRows = await tx
      .select({
        objectiveId: learningObjectiveRevisionsV2.objectiveId,
        publicSummary: learningObjectiveRevisionsV2.publicSummary,
        conceptLabel: learningObjectiveRevisionsV2.conceptLabel,
        revision: learningObjectiveRevisionsV2.revision,
      })
      .from(learningObjectiveRevisionsV2)
      .where(and(
        eq(learningObjectiveRevisionsV2.workspaceId, scope.workspaceId),
        inArray(learningObjectiveRevisionsV2.objectiveId, kpObjectiveIds),
        visibleObjectivesCondition(scope.userId, learningObjectiveRevisionsV2.objectiveId),
      ));
    const latestByObj = new Map<string, { publicSummary: string; conceptLabel: string | null; revision: number }>();
    for (const r of revRows) {
      const current = latestByObj.get(r.objectiveId);
      if (!current || r.revision > current.revision) {
        latestByObj.set(r.objectiveId, {
          publicSummary: r.publicSummary,
          conceptLabel: r.conceptLabel,
          revision: r.revision,
        });
      }
    }
    for (const [objId, rev] of latestByObj) {
      labelByObjective.set(objId, rev.conceptLabel ?? rev.publicSummary);
    }
  }

  const kpRows = objectiveRows.map((o) => ({
    id: o.objectiveId,
    claim: labelByObjective.get(o.objectiveId) ?? "理解目标",
    cardId: cardByObjective.get(o.objectiveId) ?? null,
    sourceFingerprint: o.sourceFingerprint,
    createdAtText: o.createdAtText,
    isV2: true as const,
  }));

  const kpIds = kpRows.map((row) => row.id);
  // review schedule：objective 维度（subjectType='card' + subjectId=objectiveId）。
  const schedRows = kpIds.length > 0
    ? await tx
        .select({ id: reviewSchedules.id, subjectId: reviewSchedules.subjectId, nextReviewAt: reviewSchedules.nextReviewAt, status: reviewSchedules.status })
        .from(reviewSchedules)
        .where(and(
          eq(reviewSchedules.workspaceId, scope.workspaceId),
          eq(reviewSchedules.userId, scope.userId),
          eq(reviewSchedules.subjectType, "card"),
          inArray(reviewSchedules.subjectId, kpIds),
        ))
        .orderBy(desc(reviewSchedules.createdAt))
        .limit(kpIds.length * 3)
    : [];

  // shared 平面实体（noteVersion/note/source 血缘）。
  const noteVersionIds = Array.from(new Set(
    sharedCardRows.map((card) => card.noteVersionId)
      .filter((id): id is string => Boolean(id)),
  ));
  const noteVersionRows = noteVersionIds.length > 0
    ? await tx.query.noteVersions.findMany({
        where: and(
          eq(noteVersions.workspaceId, scope.workspaceId),
          inArray(noteVersions.id, noteVersionIds),
        ),
        // PERF-B3 修复：组装血缘仅用 noteId/id（map key），
        // 排除超大 contentJson，避免星图渲染整块搬 jsonb。
        columns: { id: true, noteId: true, contentHash: true },
      })
    : [];
  const noteIds = Array.from(new Set(noteVersionRows.map((version) => version.noteId)));
  const noteRows = noteIds.length > 0
    ? await tx.query.notes.findMany({
        where: and(
          eq(notes.workspaceId, scope.workspaceId),
          visibleNotesCondition(scope.userId),
          inArray(notes.id, noteIds),
          isNull(notes.deletedAt),
        ),
        // PERF-B3 修复：组装仅用 id/title/sourceId。
        columns: { id: true, title: true, sourceId: true },
      })
    : [];
  const sourceIds = Array.from(new Set(
    noteRows.flatMap((note) => note.sourceId ? [note.sourceId] : []),
  ));
  const sourceRows = sourceIds.length > 0
    ? await tx.query.sources.findMany({
        where: and(
          eq(sources.workspaceId, scope.workspaceId),
          inArray(sources.id, sourceIds),
        ),
        // PERF-B3 修复：组装仅用 id/title，排除大 metadata jsonb。
        columns: { id: true, title: true, updatedAt: true },
      })
    : [];
  const sourceById = new Map(sourceRows.map((source) => [source.id, source]));
  const noteById = new Map(noteRows.map((note) => [note.id, note]));
  const versionById = new Map(noteVersionRows.map((version) => [version.id, version]));

  // checkpoint token（服务端签发：watermark 为最近 published 事件）。
  const latestCanonical = envelopeRows[0]?.canonicalEventId ?? null;
  const latestPractice = practiceRows[0]?.practiceEventId ?? null;
  const checkpointToken = issueCheckpointToken({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    lastCanonicalEventId: latestCanonical,
    lastPracticeEventId: latestPractice,
    capturedAt: new Date().toISOString(),
  });

  const canonicalFacts = envelopeRows.map((row) => {
    const envelope = row.envelope as {
      keyPointId?: string;
      fact?: { kind?: string; disposition?: string };
      occurredAt?: string;
    };
    return {
      canonicalEventId: row.canonicalEventId,
      // envelope.keyPointId 即 V2 objectiveId 别名。
      keyPointId: envelope.keyPointId ?? null,
      factKind: envelope.fact?.kind ?? null,
      disposition: envelope.fact?.disposition ?? null,
      occurredAt: envelope.occurredAt ?? row.createdAt.toISOString(),
    };
  });
  // 按 objectiveId 分组（全图模式）。
  const factsByKp = new Map<string, typeof canonicalFacts>();
  for (const fact of canonicalFacts) {
    if (!fact.keyPointId) continue;
    const list = factsByKp.get(fact.keyPointId) ?? [];
    list.push(fact);
    factsByKp.set(fact.keyPointId, list);
  }
  // practice → objective：practiceTrailEventOutbox 无 keyPointId；经 learningRuns
  // 的 origin JSONB objectiveId 关联。
  const practiceByKp = new Map<string, number>();
  if (practiceRows.length > 0) {
    const runIds = Array.from(new Set(practiceRows.map((row) => row.runId)));
    const runRows = runIds.length > 0
      ? await tx
          .select({
            id: learningRuns.id,
            objectiveId: sql<string>`${learningRuns.origin}->>'objectiveId'`,
          })
          .from(learningRuns)
          .where(and(
            eq(learningRuns.workspaceId, scope.workspaceId),
            inArray(learningRuns.id, runIds),
          ))
      : [];
    const objectiveByRun = new Map(runRows.map((r) => [r.id, r.objectiveId]));
    for (const row of practiceRows) {
      const objectiveId = objectiveByRun.get(row.runId);
      if (!objectiveId) continue;
      practiceByKp.set(objectiveId, (practiceByKp.get(objectiveId) ?? 0) + 1);
    }
  }
  const schedByKp = new Map<string, typeof schedRows>();
  for (const s of schedRows) {
    if (!s.subjectId) continue;
    const list = schedByKp.get(s.subjectId) ?? [];
    list.push(s);
    schedByKp.set(s.subjectId, list);
  }

  const now = new Date();
  // kp personal 事实（先算好供 card 聚合复用）。
  const kpPersonal = new Map<string, {
    state: "unknown" | "forming" | "stable" | "fragile" | "needs_repair";
    nextReviewAt: string | null;
    activeScheduleId: string | null;
    lastCanonicalEventId: string | null;
    lastCanonicalOccurredAt: string | null;
    practiceTrailCount: number;
  }>();
  for (const kp of kpRows) {
    const kpFacts = factsByKp.get(kp.id) ?? [];
    const kpScheds = schedByKp.get(kp.id) ?? [];
    const due = kpScheds.find((s) => s.status === "pending" && s.nextReviewAt.getTime() <= now.getTime());
    // §15.2 state：canonical 事实按 disposition 分级；due review → fragile。
    let state: "unknown" | "forming" | "stable" | "fragile" | "needs_repair" = "unknown";
    if (kpFacts.some((fact) => fact.disposition === "mastery_evidence")) state = "stable";
    else if (kpFacts.some((fact) => fact.disposition === "unable_evidence")) state = "fragile";
    else if (kpFacts.some((fact) => fact.disposition === "facet_evidence")) state = "forming";
    if (due) state = "fragile";
    kpPersonal.set(kp.id, {
      state,
      nextReviewAt: due ? due.nextReviewAt.toISOString() : kpScheds[0]?.nextReviewAt.toISOString() ?? null,
      activeScheduleId: kpScheds.find((s) => s.status === "pending")?.id ?? null,
      lastCanonicalEventId: kpFacts[0]?.canonicalEventId ?? null,
      lastCanonicalOccurredAt: kpFacts[0]?.occurredAt ?? null,
      practiceTrailCount: practiceByKp.get(kp.id) ?? 0,
    });
  }

  // shared 平面节点与血缘边（§15.2 UnderstandingNodeProjectionV2 /
  // UnderstandingEdgeProjectionV2；去重按 nodeRef/edgeId）。
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const addNode = (node: Record<string, unknown>, nodeId: string | null) => {
    if (!nodeId || nodeIds.has(nodeId)) return;
    nodeIds.add(nodeId);
    nodes.push(node);
  };
  const addEdge = (kind: string, from: string, to: string) => {
    const edgeId = projectionEdgeId(kind, from, to);
    if (edgeIds.has(edgeId)) return;
    edgeIds.add(edgeId);
    edges.push({
      edgeId,
      from: { kind: from.split(":")[0], [from.split(":")[0] === "key_point" ? "keyPointId" : `${from.split(":")[0]}Id`]: from.slice(from.indexOf(":") + 1) },
      to: { kind: to.split(":")[0], [to.split(":")[0] === "key_point" ? "keyPointId" : `${to.split(":")[0]}Id`]: to.slice(to.indexOf(":") + 1) },
      kind,
      provenanceHash: sha256Hex(`provenance:${kind}:${from}:${to}`),
    });
  };

  // key_point 节点（V2 objective）+ card→kp contains 边。
  const kpsByCard = new Map<string, typeof kpRows>();
  for (const kp of kpRows) {
    const kpNodeId = `key_point:${kp.id}`;
    addNode({
      nodeRef: { kind: "key_point" as const, keyPointId: kp.id },
      label: kp.claim.slice(0, 60),
      shared: {
        archived: false,
        sourceFingerprint: kp.sourceFingerprint,
      },
      personal: kpPersonal.get(kp.id) ?? {
        state: "unknown",
        nextReviewAt: null,
        activeScheduleId: null,
        lastCanonicalEventId: null,
        lastCanonicalOccurredAt: null,
        practiceTrailCount: 0,
      },
    }, kpNodeId);
    if (kp.cardId) {
      addEdge("contains", `card:${kp.cardId}`, kpNodeId);
      const group = kpsByCard.get(kp.cardId) ?? [];
      group.push(kp);
      kpsByCard.set(kp.cardId, group);
    }
  }

  // card / note / source 节点 + 血缘边（source→note / note→card derived_from）。
  for (const card of sharedCardRows) {
    const version = card.noteVersionId ? versionById.get(card.noteVersionId) : undefined;
    const note = version ? noteById.get(version.noteId) : undefined;
    const source = note?.sourceId ? sourceById.get(note.sourceId) : undefined;
    const cardNodeId = `card:${card.id}`;
    const noteNodeId = note ? `note:${note.id}` : null;
    const sourceNodeId = source ? `source:${source.id}` : null;
    if (source) {
      addNode({
        nodeRef: { kind: "source" as const, sourceId: source.id },
        label: source.title,
        shared: {
          archived: false,
          sourceFingerprint: sha256Hex(`projection:source:${source.id}:${source.updatedAt.toISOString()}`),
        },
        personal: null,
      }, sourceNodeId);
    }
    if (note) {
      addNode({
        nodeRef: { kind: "note" as const, noteId: note.id },
        label: note.title,
        shared: {
          archived: false,
          sourceFingerprint: version?.contentHash || sha256Hex(`projection:note:${note.id}`),
        },
        personal: null,
      }, noteNodeId);
      if (sourceNodeId && noteNodeId) addEdge("derived_from", sourceNodeId, noteNodeId);
    }
    const cardKps = kpsByCard.get(card.id) ?? [];
    addNode({
      nodeRef: { kind: "card" as const, cardId: card.id },
      label: card.title ?? "（未命名学习卡）",
      shared: { archived: false, sourceFingerprint: card.sourceFingerprint, cardVersion: 2 },
      // §15.2：Key Point 有独立 personal state；card 输出子 kp 的聚合视图。
      personal: aggregateCardPersonal(
        cardKps.map((kp) => kpPersonal.get(kp.id) ?? {
          state: "unknown",
          nextReviewAt: null,
          activeScheduleId: null,
          lastCanonicalEventId: null,
          lastCanonicalOccurredAt: null,
          practiceTrailCount: 0,
        }),
      ),
    }, cardNodeId);
    if (noteNodeId) addEdge("derived_from", noteNodeId, cardNodeId);
  }

  const reasonCodes: string[] = [];
  const due = targetKeyPointId
    ? (schedByKp.get(targetKeyPointId) ?? []).find((s) => s.status === "pending" && s.nextReviewAt.getTime() <= now.getTime())
    : undefined;
  if (due) reasonCodes.push("review_due");
  if ((factsByKp.get(targetKeyPointId ?? "")?.length ?? 0) === 0 && practiceByKp.get(targetKeyPointId ?? "") !== undefined) reasonCodes.push("new_card_unvalidated");
  // §15.2 reasonCodes：最近 7 天内出现 unable_evidence（误解）→ recent_misconception。
  const recentUnable = factsByKp.get(targetKeyPointId ?? "")?.some((fact) =>
    fact.disposition === "unable_evidence"
    && Date.now() - new Date(fact.occurredAt).getTime() < 7 * 24 * 60 * 60 * 1000,
  );
  if (recentUnable) reasonCodes.push("recent_misconception");
  if (reasonCodes.length === 0 && targetKeyPointId) reasonCodes.push("user_selected");

  // §15.6 checkpoint-aware ETag：带 minimumCheckpoint 时不得由陈旧缓存
  // 直接命中（304 只在无 minimumCheckpoint 且 If-None-Match 匹配时返回）。
  // ETag 基于稳定 watermark（canonical/practice 事件 id），不是每次
  // 重新签发的 checkpoint token（capturedAt 变化会使 ETag 每次不同）。
  // 批次 4.5：正文里现在含有"按人可见"的那部分（笔记标题与血缘节点），所以缓存键
  // 必须带上查看者——只按 workspace 哈希的话，同空间的另一个人会直接命中这个 304，
  // 拿到的却是别人的那份视图。
  const etag = `"${sha256Hex(`${latestCanonical ?? ""}:${latestPractice ?? ""}:${scope.workspaceId}:${scope.userId}`).slice(0, 24)}"`;
  if (params.ifNoneMatch === etag && !params.minimumCheckpoint) {
    return { status: "not_modified", etag };
  }

  const body: UnderstandingProjectionReadBody = {
    version: 2,
    generatedAt: new Date().toISOString(),
    checkpoint: checkpointToken
      ? {
          version: 1,
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          token: checkpointToken,
          capturedAt: new Date().toISOString(),
        }
      : null,
    planes: { shared: "workspace_owned", personal: "user_private" },
    request: {
      lens,
      filter: {
        showArchived,
        sourceId: params.sourceId ?? undefined,
        cardId: params.cardId ?? undefined,
      },
      targetKeyPointId,
      routePlanId,
    },
    slice: {
      kind: routePlanId ? "route" : targetKeyPointId ? "target_centered" : "workspace_map",
      continuationToken: kpHasMore && kpRows.length > 0
        ? encodeProjectionCursor(
            kpRows[kpRows.length - 1].id,
            kpRows[kpRows.length - 1].createdAtText,
          )
        : null,
    },
    // V2：无 evidence 数据源（V1 evidence.keyPointId 已删），故不截断。
    evidenceTruncated: false,
    nodes,
    edges,
    currentTarget: targetKeyPointId
      ? { keyPointId: targetKeyPointId, reasonCodes }
      : null,
  };
  return { status: "ok", etag, body };
}
