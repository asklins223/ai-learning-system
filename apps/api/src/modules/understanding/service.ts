import { and, asc, count, desc, eq, inArray, isNull, sql, or } from "drizzle-orm";
import { withWorkspaceTransaction, SYSTEM_USER_ID, type ApiTransaction } from "../../db/client.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { evidences, validationEvents, reviewSchedules, understandingEvents } from "../../db/schema/evidence.ts";
import { notes, noteVersions, sources } from "../../db/schema/note.ts";
import { effectiveAlignment, effectiveAlignmentForUser, getUserOverrideMap } from "../../lib/evidence.ts";
import {
  buildUnderstandingGraphDto,
  type GraphKeyPointRecord,
  type UnderstandingGraph,
  UNDERSTANDING_GRAPH_CARD_LIMIT,
} from "./graph.ts";
import { activeLearningCardConsumerPredicate } from "../card/consumer-eligibility.ts";

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
 * 1. 查所有 active learning_cards（workspace 内）
 * 2. 对每张 card，join understanding_events → validation_events 找到最新事件
 * 3. 映射为理解状态
 * 4. 关联 card/note 信息（标题、证据覆盖率、上次验证时间、下次复习时间）
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
  // 1. 查所有 active cards
  const cards = await tx.query.learningCards.findMany({
    where: and(
      eq(learningCards.workspaceId, workspaceId),
      activeLearningCardConsumerPredicate(),
    ),
    orderBy: [desc(learningCards.createdAt)],
    limit: UNDERSTANDING_GRAPH_CARD_LIMIT,
  });

  if (cards.length === 0) return [];

  const cardIds = cards.map((c) => c.id);

  // PERF-23 修复：使用 SQL GROUP BY 聚合替代应用层聚合。
  // 原代码加载所有 understanding_events 到内存后在 JS 中遍历聚合，
  // 现改为在数据库层面使用 PostgreSQL 的 array_agg + FILTER 子句直接计算：
  //   - latest_event_type: 按时间倒序的第一条事件类型
  //   - latest_validation_event_type: 按 validated/misunderstood 过滤后的最新事件类型
  //   - last_validated_at: validated/misunderstood 事件的最新时间戳
  //   - misunderstanding_count: misunderstood 事件计数
  // 这将每张卡 50 行事件数据降为 1 行聚合结果，大幅减少内存使用和数据传输量。
  const [eventAggRows, allKps] = await Promise.all([
    tx
      .select({
        cardId: validationEvents.cardId,
        latestEventType: sql<string | null>`(array_agg(${understandingEvents.eventType} ORDER BY ${understandingEvents.createdAt} DESC))[1]`,
        latestValidationEventType: sql<string | null>`(array_agg(${understandingEvents.eventType} ORDER BY ${understandingEvents.createdAt} DESC) FILTER (WHERE ${understandingEvents.eventType} IN ('validated', 'misunderstood')))[1]`,
        lastValidatedAt: sql<Date | null>`MAX(${understandingEvents.createdAt}) FILTER (WHERE ${understandingEvents.eventType} IN ('validated', 'misunderstood'))`,
        misunderstandingCount: sql<number>`COUNT(*) FILTER (WHERE ${understandingEvents.eventType} = 'misunderstood')`,
      })
      .from(understandingEvents)
      .innerJoin(
        validationEvents,
        and(
          eq(understandingEvents.subjectId, validationEvents.id),
          eq(understandingEvents.subjectType, "validation"),
        ),
      )
      .where(and(
        eq(understandingEvents.workspaceId, workspaceId),
        inArray(validationEvents.cardId, cardIds),
        // R-006: 按 userId 过滤，普通成员只能看到自己的理解事件
        ...(userId ? [eq(validationEvents.userId, userId)] : []),
      ))
      .groupBy(validationEvents.cardId),
    // 3. 批量查 keyPoints（B14: 替代 for 循环逐个查询）
    tx.query.cardKeyPoints.findMany({
      where: and(
        eq(cardKeyPoints.workspaceId, workspaceId),
        inArray(cardKeyPoints.cardId, cardIds),
      ),
    }),
  ]);
  const allKeyPointIds = new Set<string>();
  const cardKeyPointMap = new Map<string, string[]>();

  // PERF-23 修复：直接使用 SQL 聚合结果构建 eventMap，无需 JS 遍历
  const eventMap = new Map<string, {
    latestEventType: string | null;
    misunderstandingCount: number;
    latestValidationEventType: string | null;
    lastValidatedAt: string | null;
  }>();

  for (const row of eventAggRows) {
    eventMap.set(row.cardId, {
      latestEventType: row.latestEventType,
      misunderstandingCount: Number(row.misunderstandingCount),
      latestValidationEventType: row.latestValidationEventType,
      lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null,
    });
  }

  for (const kp of allKps) {
    const arr = cardKeyPointMap.get(kp.cardId) ?? [];
    arr.push(kp.id);
    cardKeyPointMap.set(kp.cardId, arr);
    allKeyPointIds.add(kp.id);
  }

  const evidenceStats = new Map<string, { hard: number; soft: number; total: number; keyPointsWithHard: Set<string> }>();
  if (allKeyPointIds.size > 0) {
    const evRows = await tx
      .select({
        id: evidences.id,
        keyPointId: evidences.keyPointId,
        alignment: evidences.alignment,
        userOverride: evidences.userOverride,
      })
      .from(evidences)
      .where(and(eq(evidences.workspaceId, workspaceId), inArray(evidences.keyPointId, Array.from(allKeyPointIds))));

    // N-005: 查询用户级 override
    const evIds = evRows.map((r) => r.id);
    const userOverrideMap = userId
      ? await getUserOverrideMap(userId, evIds, tx)
      : new Map<string, "confirmed" | "downgraded" | "rejected">();

    // 按 card 聚合（通过 keyPoint → card 映射）
    const kpToCard = new Map<string, string>();
    for (const [cardId, kpIds] of cardKeyPointMap) {
      for (const kpId of kpIds) {
        kpToCard.set(kpId, cardId);
      }
    }

    for (const row of evRows) {
      const cardId = kpToCard.get(row.keyPointId);
      if (!cardId) continue;

      // N-005: 使用用户级 override（如果有），否则回退到 legacy userOverride
      const userOv = userOverrideMap.get(row.id) ?? null;
      const ea = userId
        ? effectiveAlignmentForUser(row.alignment, row.userOverride, userOv)
        : effectiveAlignment(row.alignment, row.userOverride);
      if (ea === null) continue;

      const stats = evidenceStats.get(cardId) ?? { hard: 0, soft: 0, total: 0, keyPointsWithHard: new Set<string>() };
      stats.total++;
      if (ea === "aligned") {
        stats.hard++;
        // N-004: 记录有硬证据的 keyPoint
        stats.keyPointsWithHard.add(row.keyPointId);
      } else if (ea === "soft") {
        stats.soft++;
      }
      evidenceStats.set(cardId, stats);
    }
  }

  // PERF-23 修复：合并两个串行的 review_schedules 查询为单个查询。
  // 原代码分别查询 subjectType='validation'（join validation_events）
  // 和 subjectType='card'（直接按 subjectId 查询），现合并为单次 OR 条件查询。
  const reviewMap = new Map<string, { nextReviewAt: string | null; reviewStatus: string | null }>();
  const rememberEarlierReview = (cardId: string, nextReviewAt: Date, status: string) => {
    const current = reviewMap.get(cardId);
    if (!current?.nextReviewAt || nextReviewAt.getTime() < new Date(current.nextReviewAt).getTime()) {
      reviewMap.set(cardId, {
        nextReviewAt: nextReviewAt.toISOString(),
        reviewStatus: status,
      });
    }
  };
  // 合并查询：validation 类型（通过 join 获取 cardId）+ card 类型（直接 subjectId 即 cardId）
  const allReviewRows = await tx
    .select({
      cardId: sql<string>`COALESCE(${validationEvents.cardId}, ${reviewSchedules.subjectId})`,
      nextReviewAt: reviewSchedules.nextReviewAt,
      status: reviewSchedules.status,
    })
    .from(reviewSchedules)
    .leftJoin(
      validationEvents,
      and(
        eq(reviewSchedules.subjectId, validationEvents.id),
        eq(reviewSchedules.subjectType, "validation"),
      ),
    )
    .where(
      and(
        eq(reviewSchedules.workspaceId, workspaceId),
        eq(reviewSchedules.status, "pending"),
        or(
          // validation 类型：通过 join 的 card_id 匹配
          inArray(validationEvents.cardId, cardIds),
          // card 类型：subject_id 直接是 cardId
          and(
            eq(reviewSchedules.subjectType, "card"),
            inArray(reviewSchedules.subjectId, cardIds),
          ),
        ),
        // R-006: 按 userId 过滤复习计划
        ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
      ),
    )
    .orderBy(asc(reviewSchedules.nextReviewAt));
  for (const row of allReviewRows) {
    rememberEarlierReview(row.cardId, row.nextReviewAt, row.status);
  }

  // 5. 组装结果
  // QUAL-26 修复：当指定了 state 过滤时，在组装阶段直接跳过不匹配的卡片，
  // 避免为不匹配的卡片构建完整的结果对象（虽然仍需计算状态，但跳过了不必要的字段组装）。
  const stateFilter = opts?.state;
  const results: UnderstandingState[] = [];
  for (const card of cards) {
    const eventInfo = eventMap.get(card.id);
    const evStats = evidenceStats.get(card.id) ?? { hard: 0, soft: 0, total: 0, keyPointsWithHard: new Set<string>() };
    const reviewInfo = reviewMap.get(card.id);

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

    // N-004: 证据覆盖率改为 keyPoint 级别 — 有硬证据的 keyPoint 数 / 总 keyPoint 数
    const totalKps = cardKeyPointMap.get(card.id)?.length ?? 0;
    const kpsWithHard = evStats.keyPointsWithHard?.size ?? 0;
    const evidenceCoverage = totalKps > 0
      ? Math.round((kpsWithHard / totalKps) * 100) / 100
      : 0;

    results.push({
      subjectType: "card" as const,
      subjectId: card.id,
      title: card.schemaJson?.title ?? "（未命名学习卡）",
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
    cache.set(cacheK, { at: Date.now(), data: results });
  }
  return results;
}

/**
 * 构建理解星图。
 *
 * 图中的每条边都对应数据库中的真实外键或血缘：
 * source -> note (notes.source_id)
 * note -> card (learning_cards.note_version_id -> note_versions.note_id)
 * card -> keyPoint (card_key_points.card_id)
 *
 * active card 最多投影 200 张；totalCards/truncated 会说明是否截断。
 *
 * QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 确保 RLS 上下文可用。
 */

// 2026-08-11（性能专项）：/understanding/states 与 /graph 每请求重建 6-8 条聚合
// SQL（前端导航即触发）。加进程内短 TTL 缓存（30s）：统计/星图视图对实时性
// 不敏感，缓存显著降低 DB 负载；写操作后至多 30s 延迟展示，可接受。
// tx 参数传入（事务内一致性）或 opts 变化时不走缓存。
const UNDERSTANDING_CACHE_TTL_MS = 30_000;
const understandingStatesCache = new Map<string, { at: number; data: UnderstandingState[] }>();
const understandingGraphCache = new Map<string, { at: number; data: UnderstandingGraph }>();
const cacheKey = (workspaceId: string, userId: string, extra = ""): string => `${workspaceId}:${userId}:${extra}`;

// 2026-08-11（review 修复）：命中检查时顺带清理过期条目，避免 Map 随
// (workspace,user,state) 组合缓慢无界增长。
function sweepUnderstandingCache(): void {
  const now = Date.now();
  for (const [key, entry] of understandingStatesCache) {
    if (now - entry.at >= UNDERSTANDING_CACHE_TTL_MS) understandingStatesCache.delete(key);
  }
  for (const [key, entry] of understandingGraphCache) {
    if (now - entry.at >= UNDERSTANDING_CACHE_TTL_MS) understandingGraphCache.delete(key);
  }
}
export async function getUnderstandingGraph(
  workspaceId: string,
  userId: string,
  tx?: ApiTransaction,
): Promise<UnderstandingGraph> {
  // 2026-08-11（性能专项）：非事务调用（HTTP 路由）走短 TTL 缓存。
  const cache = !tx ? understandingGraphCache : null;
  if (cache) sweepUnderstandingCache();
  const cacheK = cacheKey(workspaceId, userId);
  const cachedHit = cache?.get(cacheK);
  if (cachedHit && Date.now() - cachedHit.at < UNDERSTANDING_CACHE_TTL_MS) {
    return cachedHit.data;
  }
  // QUAL-58/SEC-26 修复：使用 withWorkspaceTransaction 确保 RLS 上下文可用。
  // 提供 tx（测试/内部调用）时直接运行，跳过事务上下文设置。
  const run = async (tx: ApiTransaction): Promise<UnderstandingGraph> => {
  const [states, totalRows] = await Promise.all([
    getUnderstandingStates(workspaceId, undefined, userId, tx),
    tx
      .select({ count: count() })
      .from(learningCards)
      .where(and(
        eq(learningCards.workspaceId, workspaceId),
        activeLearningCardConsumerPredicate(),
      )),
  ]);

  const totalCards = Number(totalRows[0]?.count ?? 0);
  if (states.length === 0) {
    return buildUnderstandingGraphDto({
      generatedAt: new Date().toISOString(),
      totalCards,
      sources: [],
      notes: [],
      noteVersions: [],
      cards: [],
      keyPoints: [],
    });
  }

  const cardIds = states.map((state) => state.subjectId);
  // PERF-22 修复：cardRows、keyPointRows、validationRows 均只依赖 cardIds（来自 states），
  // 三者之间无依赖关系，可以并行查询。原代码串行执行 3 次 DB 往返。
  const [cardRows, keyPointRows, validationRows] = await Promise.all([
    tx.query.learningCards.findMany({
      where: and(
        eq(learningCards.workspaceId, workspaceId),
        activeLearningCardConsumerPredicate(),
        inArray(learningCards.id, cardIds),
      ),
    }),
    tx.query.cardKeyPoints.findMany({
      where: and(
        eq(cardKeyPoints.workspaceId, workspaceId),
        inArray(cardKeyPoints.cardId, cardIds),
      ),
      orderBy: [asc(cardKeyPoints.ordinal)],
    }),
    tx
      .select({
        cardId: validationEvents.cardId,
        keyPointId: validationEvents.keyPointId,
        outcome: validationEvents.outcome,
        createdAt: validationEvents.createdAt,
      })
      .from(validationEvents)
      .where(and(
        eq(validationEvents.workspaceId, workspaceId),
        eq(validationEvents.userId, userId),
        inArray(validationEvents.cardId, cardIds),
      ))
      .orderBy(desc(validationEvents.createdAt)),
  ]);
  const cardById = new Map(cardRows.map((card) => [card.id, card]));

  const noteVersionIds = Array.from(new Set(cardRows.map((card) => card.noteVersionId)));
  // PERF-22 优化：noteVersionRows 和 evidenceRows 无依赖关系，可以并行。
  // evidenceRows 依赖 keyPointIds（来自 keyPointRows），noteVersionRows 依赖 cardRows。
  const keyPointIds = keyPointRows.map((keyPoint) => keyPoint.id);
  const [noteVersionRows, evidenceRows] = await Promise.all([
    noteVersionIds.length > 0
      ? tx.query.noteVersions.findMany({
          where: and(
            eq(noteVersions.workspaceId, workspaceId),
            inArray(noteVersions.id, noteVersionIds),
          ),
        })
      : Promise.resolve([] as typeof noteVersions.$inferSelect[]),
    keyPointIds.length > 0
      ? tx
          .select({
            id: evidences.id,
            keyPointId: evidences.keyPointId,
            alignment: evidences.alignment,
            legacyOverride: evidences.userOverride,
          })
          .from(evidences)
          .where(and(
            eq(evidences.workspaceId, workspaceId),
            inArray(evidences.keyPointId, keyPointIds),
          ))
      : Promise.resolve([] as Array<{ id: string; keyPointId: string; alignment: string; legacyOverride: string | null }>),
  ]);

  const noteIds = Array.from(new Set(noteVersionRows.map((version) => version.noteId)));
  const noteRows = noteIds.length > 0
    ? await tx.query.notes.findMany({
        where: and(
          eq(notes.workspaceId, workspaceId),
          inArray(notes.id, noteIds),
          isNull(notes.deletedAt),
        ),
      })
    : [];

  const sourceIds = Array.from(new Set(
    noteRows.flatMap((note) => note.sourceId ? [note.sourceId] : []),
  ));
  const sourceRows = sourceIds.length > 0
    ? await tx.query.sources.findMany({
        where: and(
          eq(sources.workspaceId, workspaceId),
          inArray(sources.id, sourceIds),
        ),
      })
    : [];

  const overrideMap = await getUserOverrideMap(userId, evidenceRows.map((row) => row.id), tx);

  const evidenceStats = new Map<string, { hard: number; soft: number }>();
  for (const row of evidenceRows) {
    const effective = effectiveAlignmentForUser(
      row.alignment,
      row.legacyOverride,
      overrideMap.get(row.id) ?? null,
    );
    if (effective === null) continue;
    const current = evidenceStats.get(row.keyPointId) ?? { hard: 0, soft: 0 };
    if (effective === "aligned") current.hard++;
    if (effective === "soft") current.soft++;
    evidenceStats.set(row.keyPointId, current);
  }

  const validationStats = new Map<string, { misunderstandingCount: number; lastValidatedAt: string | null }>();
  const cardLastValidatedAt = new Map<string, string>();

  for (const row of validationRows) {
    // 这里必须来自真实 validation_events，而不是任意 understanding event。
    if (!cardLastValidatedAt.has(row.cardId)) {
      cardLastValidatedAt.set(row.cardId, row.createdAt.toISOString());
    }
    if (!row.keyPointId) continue;
    const current = validationStats.get(row.keyPointId) ?? {
      misunderstandingCount: 0,
      lastValidatedAt: null,
    };
    if (!current.lastValidatedAt) current.lastValidatedAt = row.createdAt.toISOString();
    if (row.outcome === "misunderstanding") current.misunderstandingCount++;
    validationStats.set(row.keyPointId, current);
  }

  const graphKeyPoints: GraphKeyPointRecord[] = keyPointRows.map((keyPoint) => ({
    id: keyPoint.id,
    cardId: keyPoint.cardId,
    ordinal: keyPoint.ordinal,
    claim: keyPoint.claim,
    quoteText: keyPoint.quoteText,
    segmentRef: keyPoint.segmentRef,
    hardEvidenceCount: evidenceStats.get(keyPoint.id)?.hard ?? 0,
    softEvidenceCount: evidenceStats.get(keyPoint.id)?.soft ?? 0,
    misunderstandingCount: validationStats.get(keyPoint.id)?.misunderstandingCount ?? 0,
    lastValidatedAt: validationStats.get(keyPoint.id)?.lastValidatedAt ?? null,
  }));
  const stateByCardId = new Map(states.map((state) => [state.subjectId, state]));

  return buildUnderstandingGraphDto({
    generatedAt: new Date().toISOString(),
    totalCards,
    sources: sourceRows.map((source) => ({
      id: source.id,
      type: source.type,
      title: source.title,
      origin: source.origin,
      status: source.status,
      metadata: source.metadata,
      createdAt: source.createdAt.toISOString(),
      updatedAt: source.updatedAt.toISOString(),
    })),
    notes: noteRows.map((note) => ({
      id: note.id,
      title: note.title,
      sourceId: note.sourceId,
      currentVersionId: note.currentVersionId,
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString(),
    })),
    noteVersions: noteVersionRows.map((version) => ({
      id: version.id,
      noteId: version.noteId,
      versionNo: version.versionNo,
      createdAt: version.createdAt.toISOString(),
    })),
    cards: states.flatMap((state) => {
      const card = cardById.get(state.subjectId);
      if (!card) return [];
      return [{
        id: card.id,
        noteVersionId: card.noteVersionId,
        title: card.schemaJson?.title ?? "（未命名学习卡）",
        summary: card.schemaJson?.summary ?? "",
        status: card.status,
        state: state.state,
        evidenceCoverage: state.evidenceCoverage,
        hardEvidenceCount: state.hardEvidenceCount,
        softEvidenceCount: state.softEvidenceCount,
        misunderstandingCount: state.misunderstandingCount,
        lastValidatedAt: cardLastValidatedAt.get(card.id) ?? null,
        nextReviewAt: state.nextReviewAt,
        createdAt: card.createdAt.toISOString(),
        updatedAt: card.updatedAt.toISOString(),
      }];
    }),
    keyPoints: graphKeyPoints.filter((keyPoint) => stateByCardId.has(keyPoint.cardId)),
  });
  };
  if (tx) return run(tx);
  const graphResult = await withWorkspaceTransaction(
    { workspaceId, userId },
    run,
  );
  // 2026-08-11（性能专项）：非事务路径计算完成后写入缓存
  if (cache) {
    cache.set(cacheK, { at: Date.now(), data: graphResult });
  }
  return graphResult;
}
