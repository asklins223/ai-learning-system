import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client.ts";
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
 */
export async function getUnderstandingStates(
  workspaceId: string,
  opts?: { state?: string },
  userId?: string,
): Promise<UnderstandingState[]> {
  // 1. 查所有 active cards
  const cards = await db.query.learningCards.findMany({
    where: and(
      eq(learningCards.workspaceId, workspaceId),
      activeLearningCardConsumerPredicate(),
    ),
    orderBy: [desc(learningCards.createdAt)],
    limit: UNDERSTANDING_GRAPH_CARD_LIMIT,
  });

  if (cards.length === 0) return [];

  const cardIds = cards.map((c) => c.id);

  // 2. 批量查 understanding_events（通过 join validation_events 找到 card_id）
  // 聚合每个 card 的最新事件
  const eventRows = await db
    .select({
      cardId: validationEvents.cardId,
      eventType: understandingEvents.eventType,
      createdAt: understandingEvents.createdAt,
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
    .orderBy(desc(understandingEvents.createdAt));

  const eventMap = new Map<string, {
    latestEventType: string | null;
    misunderstandingCount: number;
    // G-009: 跟踪最新的验证事件类型（validated/misunderstood），忽略 reviewed 事件
    // 确保完成复习不会清除误解状态 — 只有新的验证事件才能关闭误解
    latestValidationEventType: string | null;
    lastValidatedAt: string | null;
  }>();

  for (const row of eventRows) {
    const current = eventMap.get(row.cardId) ?? {
      latestEventType: null,
      misunderstandingCount: 0,
      latestValidationEventType: null,
      lastValidatedAt: null,
    };
    if (!current.latestEventType) {
      current.latestEventType = row.eventType;
    }
    // G-009: 只记录最新的验证事件（validated 或 misunderstood），忽略 reviewed/seen
    if (!current.latestValidationEventType && (row.eventType === "validated" || row.eventType === "misunderstood")) {
      current.latestValidationEventType = row.eventType;
      current.lastValidatedAt = row.createdAt.toISOString();
    }
    if (row.eventType === "misunderstood") {
      current.misunderstandingCount++;
    }
    eventMap.set(row.cardId, current);
  }

  // 3. 批量查 keyPoints（B14: 替代 for 循环逐个查询）
  const allKps = await db.query.cardKeyPoints.findMany({
    where: and(
      eq(cardKeyPoints.workspaceId, workspaceId),
      inArray(cardKeyPoints.cardId, cardIds),
    ),
  });
  const allKeyPointIds = new Set<string>();
  const cardKeyPointMap = new Map<string, string[]>();
  for (const kp of allKps) {
    const arr = cardKeyPointMap.get(kp.cardId) ?? [];
    arr.push(kp.id);
    cardKeyPointMap.set(kp.cardId, arr);
    allKeyPointIds.add(kp.id);
  }

  const evidenceStats = new Map<string, { hard: number; soft: number; total: number; keyPointsWithHard: Set<string> }>();
  if (allKeyPointIds.size > 0) {
    const evRows = await db
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
      ? await getUserOverrideMap(userId, evIds)
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

  // 4. 批量查 review_schedules（B14: 替代 for 循环逐个查询）
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
  const reviewRows = await db
    .select({
      cardId: validationEvents.cardId,
      nextReviewAt: reviewSchedules.nextReviewAt,
      status: reviewSchedules.status,
    })
    .from(reviewSchedules)
    .innerJoin(
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
        inArray(validationEvents.cardId, cardIds),
        // R-006: 按 userId 过滤复习计划
        ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
      ),
    )
    .orderBy(asc(reviewSchedules.nextReviewAt));
  for (const row of reviewRows) {
    rememberEarlierReview(row.cardId, row.nextReviewAt, row.status);
  }
  // subjectType=card 的 review
  const cardReviewRows = await db
    .select({
      subjectId: reviewSchedules.subjectId,
      nextReviewAt: reviewSchedules.nextReviewAt,
      status: reviewSchedules.status,
    })
    .from(reviewSchedules)
    .where(
      and(
        eq(reviewSchedules.workspaceId, workspaceId),
        eq(reviewSchedules.subjectType, "card"),
        eq(reviewSchedules.status, "pending"),
        inArray(reviewSchedules.subjectId, cardIds),
        // R-006: 按 userId 过滤复习计划
        ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
      ),
    )
    .orderBy(asc(reviewSchedules.nextReviewAt));
  for (const row of cardReviewRows) {
    rememberEarlierReview(row.subjectId, row.nextReviewAt, row.status);
  }

  // 5. 组装结果
  const results: UnderstandingState[] = cards.map((card) => {
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

    // N-004: 证据覆盖率改为 keyPoint 级别 — 有硬证据的 keyPoint 数 / 总 keyPoint 数
    const totalKps = cardKeyPointMap.get(card.id)?.length ?? 0;
    const kpsWithHard = evStats.keyPointsWithHard?.size ?? 0;
    const evidenceCoverage = totalKps > 0
      ? Math.round((kpsWithHard / totalKps) * 100) / 100
      : 0;

    return {
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
    };
  });

  // 按状态筛选
  if (opts?.state) {
    return results.filter((r) => r.state === opts.state);
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
 */
export async function getUnderstandingGraph(
  workspaceId: string,
  userId: string,
): Promise<UnderstandingGraph> {
  const [states, totalRows] = await Promise.all([
    getUnderstandingStates(workspaceId, undefined, userId),
    db
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
  const cardRows = await db.query.learningCards.findMany({
    where: and(
      eq(learningCards.workspaceId, workspaceId),
      activeLearningCardConsumerPredicate(),
      inArray(learningCards.id, cardIds),
    ),
  });
  const cardById = new Map(cardRows.map((card) => [card.id, card]));

  const noteVersionIds = Array.from(new Set(cardRows.map((card) => card.noteVersionId)));
  const noteVersionRows = noteVersionIds.length > 0
    ? await db.query.noteVersions.findMany({
        where: and(
          eq(noteVersions.workspaceId, workspaceId),
          inArray(noteVersions.id, noteVersionIds),
        ),
      })
    : [];

  const noteIds = Array.from(new Set(noteVersionRows.map((version) => version.noteId)));
  const noteRows = noteIds.length > 0
    ? await db.query.notes.findMany({
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
    ? await db.query.sources.findMany({
        where: and(
          eq(sources.workspaceId, workspaceId),
          inArray(sources.id, sourceIds),
        ),
      })
    : [];

  const keyPointRows = await db.query.cardKeyPoints.findMany({
    where: and(
      eq(cardKeyPoints.workspaceId, workspaceId),
      inArray(cardKeyPoints.cardId, cardIds),
    ),
    orderBy: [asc(cardKeyPoints.ordinal)],
  });
  const keyPointIds = keyPointRows.map((keyPoint) => keyPoint.id);

  const evidenceStats = new Map<string, { hard: number; soft: number }>();
  if (keyPointIds.length > 0) {
    const evidenceRows = await db
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
      ));
    const overrideMap = await getUserOverrideMap(userId, evidenceRows.map((row) => row.id));

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
  }

  const validationStats = new Map<string, { misunderstandingCount: number; lastValidatedAt: string | null }>();
  const cardLastValidatedAt = new Map<string, string>();
  const validationRows = await db
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
    .orderBy(desc(validationEvents.createdAt));

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
}
