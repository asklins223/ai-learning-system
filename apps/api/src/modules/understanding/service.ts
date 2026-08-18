import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withWorkspaceTransaction, SYSTEM_USER_ID, type ApiTransaction } from "../../db/client.ts";
import {
  learningCardsV2,
  learningObjectivesV2,
  learningObjectiveEvidenceBindingsV2,
} from "../../db/schema/card-generation-v2.ts";
import { reviewSchedules, understandingEvents } from "../../db/schema/evidence.ts";

/** 聚合状态/星图列表上限（沿用旧 reader 的 200 卡截断；states 列表消费）。 */
const UNDERSTANDING_GRAPH_CARD_LIMIT = 200;

/**
 * PERF-10 风格分块查询辅助：把大 IN 数组拆成 500/批，避免 postgres-js
 * 绑定参数超限与大 IN 子句性能退化，并合并各批结果。
 */
async function chunkedInArraySelect<T>(
  queryFn: (chunk: string[]) => Promise<T[]>,
  ids: string[],
  chunkSize = 500,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    results.push(...(await queryFn(chunk)));
  }
  return results;
}

export interface UnderstandingState {
  subjectType: "card";
  subjectId: string;
  title: string;
  state: string;
  evidenceCoverage: number;
  hardEvidenceCount: number;
  softEvidenceCount: number;
  lastValidatedAt: string | null;
  nextReviewAt: string | null;
  reviewStatus: string | null;
  misunderstandingCount: number;
}

/**
 * 聚合理解状态列表。
 *
 * 聚合逻辑：
 * 1. 查所有 active learning_cards_v2（workspace 内）
 * 2. 对每张 card（稳定公共标识为 cardId），关联到其 objectiveId（旧的 keyPointId 角色）
 * 3. 按 objective 聚合 understanding_events → 理解状态（seen/validated/misunderstood/reviewed）
 * 4. 关联 card 信息（标题、证据覆盖率、上次验证时间）与 objective 维度复习计划
 *
 * V2 迁移说明：V1 的 learningCards/cardKeyPoints 与 validationEvents.cardId 连接已退役。
 * - 枚举 active V2 卡，external subjectId = learningCardsV2.cardId
 * - 事件/状态按 objectiveId（= 旧 keyPointId 别名）从 understandingEvents 直接聚合
 * - 复习计划按 subjectType='card' + subjectId=objectiveId（objective 维度）
 * - 证据覆盖率由 learningObjectiveEvidenceBindingsV2（经 currentObjectiveRevisionId）计数
 *
 * QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 确保 RLS 上下文可用。
 */
export async function getUnderstandingStates(
  workspaceId: string,
  opts?: { state?: string },
  userId?: string,
  tx?: ApiTransaction,
): Promise<UnderstandingState[]> {
  // 2026-08-11（性能专项）：非事务调用（HTTP 路由）走短 TTL 缓存。
  const cache = !tx ? understandingStatesCache : null;
  if (cache) sweepUnderstandingCache();
  const cacheK = cacheKey(workspaceId, userId ?? SYSTEM_USER_ID, opts?.state ?? "");
  const cachedHit = cache?.get(cacheK);
  if (cachedHit && Date.now() - cachedHit.at < UNDERSTANDING_CACHE_TTL_MS) {
    return cachedHit.data;
  }
  // QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 确保 RLS 上下文可用。
  // 提供 tx（测试/内部调用）时直接运行，跳过事务上下文设置。
  const run = async (tx: ApiTransaction): Promise<UnderstandingState[]> => {
  // 1. 查所有 active V2 cards
  const cards = await tx.query.learningCardsV2.findMany({
    where: and(
      eq(learningCardsV2.workspaceId, workspaceId),
      eq(learningCardsV2.lifecycle, "active"),
    ),
    orderBy: [desc(learningCardsV2.createdAt)],
    limit: UNDERSTANDING_GRAPH_CARD_LIMIT,
  });

  if (cards.length === 0) return [];

  // V2：cardId 是稳定公共卡标识（外部 subjectId）；objectiveId 链接到 objective
  // （objective 承担旧 keyPointId 的角色）。非 active objective 一并忽略，
  // 但保留 card 主导枚举，以维持 subjectType:'card' + subjectId=cardId 语义。
  const objectiveIds = Array.from(new Set(cards.map((c) => c.objectiveId)));

  // 2. 为每个 objective 解析 currentObjectiveRevisionId（用于证据绑定计数）
  const objRows = await tx.query.learningObjectivesV2.findMany({
    where: and(
      eq(learningObjectivesV2.workspaceId, workspaceId),
      inArray(learningObjectivesV2.objectiveId, objectiveIds),
      eq(learningObjectivesV2.lifecycle, "active"),
    ),
  });
  // objectiveRevisionId → objectiveId 反向映射：bindings 行按 objectiveRevisionId
  // 关联（revision 是真实 revision id，不等于 objectiveId）。
  const objectiveIdByRevision = new Map<string, string>();
  for (const o of objRows) {
    if (o.currentObjectiveRevisionId) objectiveIdByRevision.set(o.currentObjectiveRevisionId, o.objectiveId);
  }
  const objectiveRevisionIds = Array.from(
    new Set(objRows.map((o) => o.currentObjectiveRevisionId).filter((id): id is string => Boolean(id))),
  );

  // 3. 按 objective 聚合 understanding_events。
  // PERF-23 修复：使用 SQL GROUP BY 聚合替代应用层聚合，直接用 array_agg + FILTER 计算：
  //   - latest_event_type: 按时间倒序的第一条事件类型
  //   - latest_validation_event_type: 按 validated/misunderstood 过滤后的最新事件类型
  //   - last_validated_at: validated/misunderstood 事件的最新时间戳
  //   - misunderstanding_count: misunderstood 事件计数
  // V2：validationEvents 已无 cardId 列，无法重建 card join；改为按 objectiveId（=旧 keyPointId
  // 别名）直接聚合 understandingEvents.subjectId，保持相同状态映射语义。
  const eventAggRows = await tx
    .select({
      subjectId: understandingEvents.subjectId,
      latestEventType: sql<string | null>`(array_agg(${understandingEvents.eventType} ORDER BY ${understandingEvents.createdAt} DESC))[1]`,
      latestValidationEventType: sql<string | null>`(array_agg(${understandingEvents.eventType} ORDER BY ${understandingEvents.createdAt} DESC) FILTER (WHERE ${understandingEvents.eventType} IN ('validated', 'misunderstood')))[1]`,
      lastValidatedAt: sql<Date | null>`MAX(${understandingEvents.createdAt}) FILTER (WHERE ${understandingEvents.eventType} IN ('validated', 'misunderstood'))`,
      misunderstandingCount: sql<number>`COUNT(*) FILTER (WHERE ${understandingEvents.eventType} = 'misunderstood')`,
    })
    .from(understandingEvents)
    .where(and(
      eq(understandingEvents.workspaceId, workspaceId),
      inArray(understandingEvents.subjectId, objectiveIds),
      // R-006: 按 userId 过滤，普通成员只能看到自己的理解事件
      ...(userId ? [eq(understandingEvents.userId, userId)] : []),
    ))
    .groupBy(understandingEvents.subjectId);

  // PERF-23 修复：直接使用 SQL 聚合结果构建 eventMap，无需 JS 遍历。
  // eventMap 以 objectiveId 为键（V2：objective 承担旧 keyPointId 角色）。
  const eventMap = new Map<string, {
    latestEventType: string | null;
    misunderstandingCount: number;
    latestValidationEventType: string | null;
    lastValidatedAt: string | null;
  }>();

  for (const row of eventAggRows) {
    eventMap.set(row.subjectId, {
      latestEventType: row.latestEventType,
      misunderstandingCount: Number(row.misunderstandingCount),
      latestValidationEventType: row.latestValidationEventType,
      lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null,
    });
  }

  // 4. 证据覆盖率：按 objective 当前 revision 的 evidence binding 计数
  //（learningObjectiveEvidenceBindingsV2 经 objectiveRevisionId 关联）。
  // V1 的 evidences.keyPointId 已退役；无当前 revision /无 binding 时计数为 0。
  const evidenceStats = new Map<string, { hard: number; soft: number }>();
  if (objectiveRevisionIds.length > 0) {
    // N#7-13: objectiveRevisionIds 可能很大，分块 inArray 避免大数组 IN 参数越界。
    const evRows = await chunkedInArraySelect(
      (chunk) => tx
        .select({
          objectiveRevisionId: learningObjectiveEvidenceBindingsV2.objectiveRevisionId,
          supportStrength: learningObjectiveEvidenceBindingsV2.supportStrength,
        })
        .from(learningObjectiveEvidenceBindingsV2)
        .where(and(
          eq(learningObjectiveEvidenceBindingsV2.workspaceId, workspaceId),
          inArray(learningObjectiveEvidenceBindingsV2.objectiveRevisionId, chunk),
        )),
      objectiveRevisionIds,
    );

    // 按 objective 聚合（通过 objectiveRevisionId → objectiveId 反向映射）
    for (const row of evRows) {
      const objectiveId = objectiveIdByRevision.get(row.objectiveRevisionId);
      if (!objectiveId) continue;
      const stats = evidenceStats.get(objectiveId) ?? { hard: 0, soft: 0 };
      // V2 supportStrength：treat hard as strong (hard) evidence, otherwise soft.
      if (row.supportStrength === "hard") {
        stats.hard++;
      } else {
        stats.soft++;
      }
      evidenceStats.set(objectiveId, stats);
    }
  }

  // 5. 合并查询 objective 维度复习计划（subjectType='card' + subjectId=objectiveId）。
  const reviewMap = new Map<string, { nextReviewAt: string | null; reviewStatus: string | null }>();
  const rememberEarlierReview = (objectiveId: string, nextReviewAt: Date, status: string) => {
    const current = reviewMap.get(objectiveId);
    if (!current?.nextReviewAt || nextReviewAt.getTime() < new Date(current.nextReviewAt).getTime()) {
      reviewMap.set(objectiveId, {
        nextReviewAt: nextReviewAt.toISOString(),
        reviewStatus: status,
      });
    }
  };
  // V2：reviewSchedules 无 keyPointId 列，objective 维度用 subjectType='card' + subjectId=objectiveId。
  const allReviewRows = await tx
    .select({
      objectiveId: reviewSchedules.subjectId,
      nextReviewAt: reviewSchedules.nextReviewAt,
      status: reviewSchedules.status,
    })
    .from(reviewSchedules)
    .where(
      and(
        eq(reviewSchedules.workspaceId, workspaceId),
        eq(reviewSchedules.subjectType, "card"),
        inArray(reviewSchedules.subjectId, objectiveIds),
        eq(reviewSchedules.status, "pending"),
        // R-006: 按 userId 过滤复习计划
        ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
      ),
    )
    .orderBy(asc(reviewSchedules.nextReviewAt));
  for (const row of allReviewRows) {
    rememberEarlierReview(row.objectiveId, row.nextReviewAt, row.status);
  }

  // 6. 组装结果
  // QUAL-26 修复：当指定了 state 过滤时，在组装阶段直接跳过不匹配的卡片，
  // 避免为不匹配的卡片构建完整的结果对象（虽然仍需计算状态，但跳过了不必要的字段组装）。
  const stateFilter = opts?.state;
  const results: UnderstandingState[] = [];
  for (const card of cards) {
    const objectiveId = card.objectiveId;
    const eventInfo = eventMap.get(objectiveId);
    const evStats = evidenceStats.get(objectiveId) ?? { hard: 0, soft: 0 };
    const reviewInfo = reviewMap.get(objectiveId);

    const isDueReview =
      reviewInfo?.reviewStatus === "pending" &&
      reviewInfo.nextReviewAt !== null &&
      new Date(reviewInfo.nextReviewAt).getTime() <= Date.now();

    // 映射理解状态
    // G-009: 使用最新的验证事件类型决定误解状态
    // reviewed 事件不应清除误解 — 只有新的非误解验证才能关闭
    const latestValidationType = eventInfo?.latestValidationEventType;
    let state: string;
    if (latestValidationType === "misunderstood") {
      state = "misunderstood";
    } else if (isDueReview) {
      state = "due_review";
    } else if (!eventInfo || !eventInfo.latestEventType) {
      state = "unseen";
    } else {
      switch (eventInfo.latestEventType) {
        case "validated":
          state = "preliminary_understood";
          break;
        case "reviewed":
          state = "reviewed";
          break;
        case "seen":
          state = "seen";
          break;
        default:
          state = "unseen";
      }
    }

    // QUAL-26 优化：如果指定了 state 过滤且不匹配，跳过此卡片
    if (stateFilter && state !== stateFilter) continue;

    // 证据覆盖率：根据该 objective 的 evidence binding 计数。
    // 有硬证据 binding 的 objective 视为 fully covered；否则按比例/0。
    const totalBindings = evStats.hard + evStats.soft;
    const evidenceCoverage = totalBindings > 0
      ? Math.round((evStats.hard + evStats.soft) / Math.max(1, objectiveRevisionIds.length) * 100) / 100
      : 0;

    // V2 标题：publicSummary（回退 front.cue，再回退占位符）
    const title = card.publicSummary?.trim()
      || (card.front as { cue?: string } | null)?.cue?.trim()
      || "（未命名学习卡）";

    results.push({
      subjectType: "card" as const,
      // V2：外部 subjectId 用稳定公共 cardId
      subjectId: card.cardId,
      title,
      state,
      evidenceCoverage,
      hardEvidenceCount: evStats.hard,
      softEvidenceCount: evStats.soft,
      lastValidatedAt: eventInfo?.lastValidatedAt ?? null,
      nextReviewAt: reviewInfo?.nextReviewAt ?? null,
      reviewStatus: reviewInfo?.reviewStatus ?? null,
      misunderstandingCount: eventInfo?.misunderstandingCount ?? 0,
    });
  }

  return results;
  };
  if (tx) return run(tx);
  const results = await withWorkspaceTransaction(
    { workspaceId, userId: userId ?? SYSTEM_USER_ID },
    run,
  );
  // 2026-08-11（性能专项）：非事务路径计算完成后写入缓存
  if (cache) {
    // 2026-08-16（性能专项）：写入时施加硬上限，超出逐出最旧插入条目，
    // 防止突发不同 key 时进程内 Map 无界增长。
    setUnderstandingCacheEntry(cache, cacheK, { at: Date.now(), data: results });
  }
  return results;
}

/**
 * 构建理解星图。
 *
 * 图中的每条边都对应数据库中的真实外键或血缘：
* source -> note (notes.source_id)
* note -> card (learning_cards_v2.note_version_id -> note_versions.note_id)
* card -> objective (learning_cards_v2.objective_id -> learning_objectives_v2.objective_id)
 *
 * active card 最多投影 200 张；totalCards/truncated 会说明是否截断。
 *
 * QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 确保 RLS 上下文可用。
 */

// 2026-08-11（性能专项）：/understanding/states 每请求重建聚合 SQL（前端
// 导航即触发）。加进程内短 TTL 缓存（30s）：统计视图对实时性不敏感，缓存
// 显著降低 DB 负载；写操作后至多 30s 延迟展示，可接受。
// tx 参数传入（事务内一致性）或 opts 变化时不走缓存。
// 2026-08-14（星图切流收口）：旧 /graph reader（getUnderstandingGraph +
// understandingGraphCache）已随 star_map_action_v1 切流删除（§11.4）。
const UNDERSTANDING_CACHE_TTL_MS = 30_000;
// 最大缓存条目数（硬上限）。即便 TTL 清扫被节流，突发不同 key 也不会超过此规模。
const UNDERSTANDING_CACHE_MAX_ENTRIES = 500;
const understandingStatesCache = new Map<string, { at: number; data: UnderstandingState[] }>();
const cacheKey = (workspaceId: string, userId: string, extra = ""): string => `${workspaceId}:${userId}:${extra}`;

function setUnderstandingCacheEntry(
  cache: Map<string, { at: number; data: UnderstandingState[] }>,
  key: string,
  entry: { at: number; data: UnderstandingState[] },
): void {
  cache.set(key, entry);
  // 硬上限：超限时逐出最旧插入的条目（Map 保持插入序）。TTL 清扫只负责过期条目，
  // 这里保证突发不同 key 时也有确定的内存上界。
  if (cache.size > UNDERSTANDING_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
}

// 2026-08-11（review 修复）：命中检查时顺带清理过期条目，避免 Map 随
// (workspace,user,state) 组合缓慢无界增长。
// PERF: throttle the full-map sweep to at most once per TTL interval instead of
// running an O(cache-size) scan on every request. Individual expired entries are
// ignored on lookup and overwritten on the next write, so correctness is kept.
let lastUnderstandingSweepAt = 0;
function sweepUnderstandingCache(): void {
  const now = Date.now();
  if (now - lastUnderstandingSweepAt < UNDERSTANDING_CACHE_TTL_MS) return;
  lastUnderstandingSweepAt = now;
  for (const [key, entry] of understandingStatesCache) {
    if (now - entry.at >= UNDERSTANDING_CACHE_TTL_MS) understandingStatesCache.delete(key);
  }
}
