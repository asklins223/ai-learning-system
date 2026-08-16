import { and, asc, eq, desc, sql, inArray, count, or, isNull } from "drizzle-orm";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import { notes, noteVersions } from "../../db/schema/note.ts";
import { reviewSchedules, validationEvents, evidences } from "../../db/schema/evidence.ts";
import { aiArtifacts } from "../../db/schema/ai.ts";
import { searchDocuments } from "../../db/schema/search.ts";
import { ArtifactStatus, CardStatus, ReviewStatus } from "@ailearn/shared";
import { clampLimit } from "../../lib/pagination.ts";
import { encodeCursor, decodeCursor } from "../../lib/pagination.ts";
import { effectiveAlignment, effectiveAlignmentForUser, getUserOverrideMap } from "../../lib/evidence.ts";
import {
  createCardGenerationRun,
  getGenerationRunStatus,
} from "../card-generation/service.ts";

/**
 * BUG-72 修复：使用 withWorkspaceTransaction 设置 DB 级工作区上下文（防御纵深/RLS）。
 */
export async function getCardWithDetail(cardId: string, workspaceId: string, userId: string) {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const card = await tx.query.learningCards.findFirst({
        where: and(eq(learningCards.id, cardId), eq(learningCards.workspaceId, workspaceId)),
      });
      if (!card) return null;

      const keyPoints = await tx.query.cardKeyPoints.findMany({
        where: eq(cardKeyPoints.cardId, cardId),
        orderBy: (k, { asc }) => [asc(k.ordinal)],
      });

      return {
        card,
        keyPoints,
      };
    },
  );
}

/**
 * 单次请求返回某张活跃卡片在完整（活跃）列表中的分页位置（index/prev/next）
 * 及其下次复习时间，避免前端串行翻页瀑布。与 listCards 的排序/过滤语义一致：
 * 按 (createdAt, id) DESC，过滤 status NOT IN ('archived', 'superseded')；
 * nextReviewAt 与 listCards 相同的用户级 review 聚合逻辑。
 * PERF: 卡片详情页首访定位 prev/next 由 O(pages) 网络往返降为 1 次查询。
 */
export async function getCardPosition(cardId: string, workspaceId: string, userId?: string) {
  return withWorkspaceTransaction(
    { workspaceId, userId: userId ?? "00000000-0000-4000-8000-000000000000" },
    async (tx) => {
      const card = await tx.query.learningCards.findFirst({
        where: and(eq(learningCards.id, cardId), eq(learningCards.workspaceId, workspaceId)),
      });
      if (!card) return null;
      if (card.status === "archived" || card.status === "superseded") {
        // 与 listCards 一致：非活跃卡片不参与列表排序定位。
        return null;
      }

      const activePredicate = and(
        eq(learningCards.workspaceId, workspaceId),
        sql`${learningCards.status} NOT IN ('archived', 'superseded')`,
      );

      const [olderRow, newerRow, rankRows, totalRows, reviewRows] = await Promise.all([
        // next（更旧）：(createdAt,id) < 当前，DESC 取最近一条
        tx.query.learningCards.findFirst({
          where: and(
            activePredicate,
            sql`(${learningCards.createdAt}, ${learningCards.id}) < (${card.createdAt}::timestamptz, ${card.id}::uuid)`,
          ),
          orderBy: [desc(learningCards.createdAt), desc(learningCards.id)],
          columns: { id: true },
        }),
        // previous（更新）：(createdAt,id) > 当前，ASC 取最近一条
        tx.query.learningCards.findFirst({
          where: and(
            activePredicate,
            sql`(${learningCards.createdAt}, ${learningCards.id}) > (${card.createdAt}::timestamptz, ${card.id}::uuid)`,
          ),
          orderBy: [asc(learningCards.createdAt), asc(learningCards.id)],
          columns: { id: true },
        }),
        // index（1-based，最新在前）：统计 (createdAt,id) >= 当前 的活跃卡片数
        tx
          .select({ count: count() })
          .from(learningCards)
          .where(and(
            activePredicate,
            sql`(${learningCards.createdAt}, ${learningCards.id}) >= (${card.createdAt}::timestamptz, ${card.id}::uuid)`,
          )),
        // total：活跃卡片总数
        tx
          .select({ count: count() })
          .from(learningCards)
          .where(activePredicate),
        // nextReviewAt：与 listCards 的 review 聚合语义一致（用户级、pending 最近一条）
        tx
          .select({ nextReviewAt: reviewSchedules.nextReviewAt })
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
              eq(reviewSchedules.status, ReviewStatus.PENDING),
              eq(validationEvents.cardId, cardId),
              ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
            ),
          )
          .orderBy(asc(reviewSchedules.nextReviewAt))
          .limit(1),
      ]);

      return {
        index: Number(rankRows[0]?.count ?? 0),
        total: Number(totalRows[0]?.count ?? 0),
        previousId: newerRow?.id ?? null,
        nextId: olderRow?.id ?? null,
        nextReviewAt: reviewRows[0]?.nextReviewAt ?? null,
      };
    },
  );
}

/**
 * BUG-72 修复：使用 withWorkspaceTransaction 设置 DB 级工作区上下文（防御纵深/RLS）。
 */
export async function listCards(workspaceId: string, opts?: { cursor?: string; limit?: number }, userId?: string) {
  // §2.6: 支持 cursor/limit 分页（F-024: 统一 clamp）
  const limit = clampLimit(opts?.limit, 50);
  // R-019: 使用 cursor 分页，基于 (createdAt, id) 复合排序
  // BUG-68/90 修复：排除已归档和已替代的卡片，只返回活跃卡片
  const conditions = [
    eq(learningCards.workspaceId, workspaceId),
    and(
      sql`${learningCards.status} NOT IN ('archived', 'superseded')`,
    ),
  ];
  if (opts?.cursor) {
    const decoded = decodeCursor(opts.cursor);
    if (decoded) {
      const cursorTs = decoded.timestamp;
      const cursorId = decoded.id;
      conditions.push(
        sql`(${learningCards.createdAt}, ${learningCards.id}) < (${cursorTs}::timestamptz, ${cursorId}::uuid)`,
      );
    }
  }

  // BUG-72 修复：所有查询在 withWorkspaceTransaction 内执行
  return withWorkspaceTransaction(
    { workspaceId, userId: userId ?? "00000000-0000-4000-8000-000000000000" },
    async (tx) => {
      // PERF-56 修复：cardRows 和 countRows 之间无数据依赖，可以并行查询。
      const [cardRows, countRows] = await Promise.all([
        tx.query.learningCards.findMany({
          where: and(...conditions),
          orderBy: [desc(learningCards.createdAt), desc(learningCards.id)],
          limit: limit + 1,
          // PERF-B11 修复：列表查询排除大 jsonb schemaJson，仅详情接口返回，
          // 避免每页 50 张整行读大 JSON。
          columns: { schemaJson: false },
          extras: {
            cursorTimestamp: sql<string>`to_char(${learningCards.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as("cursor_timestamp"),
          },
        }),
        // R-019: 服务端返回实际总数
        // PERF-B19 修复：count 未滤 archived/superseded 会导致 total 虚高，
        // 与列表实际返回的卡片（NOT IN ('archived','superseded')）不一致。
        // 统一用与列表一致的过滤条件。
        tx
          .select({ count: count() })
          .from(learningCards)
          .where(and(
            eq(learningCards.workspaceId, workspaceId),
            sql`${learningCards.status} NOT IN ('archived', 'superseded')`,
          )),
      ]);
      const hasMore = cardRows.length > limit;
      const cardsWithCursor = cardRows.slice(0, limit);
      const cards = cardsWithCursor.map(({ cursorTimestamp, ...card }) => {
        if (!cursorTimestamp) throw new Error("card cursor timestamp is missing");
        return card;
      });
      const total = Number(countRows[0]?.count ?? 0);

      if (cards.length === 0) return { items: [], nextCursor: null, total };

      const cardIds = cards.map((c) => c.id);

      // R-009: 一次 JOIN 查询：evidence → keyPoint → card，同时取 userOverride 以计算 effectiveAlignment
      // N-005: 同时取 evidence id 用于用户级 override 查询
      const evidenceRows = await tx
        .select({
          id: evidences.id,
          cardId: cardKeyPoints.cardId,
          alignment: evidences.alignment,
          userOverride: evidences.userOverride,
        })
        .from(evidences)
        .innerJoin(cardKeyPoints, eq(evidences.keyPointId, cardKeyPoints.id))
        .where(and(eq(evidences.workspaceId, workspaceId), inArray(cardKeyPoints.cardId, cardIds)));

      // N-005: 查询用户级 override
      const evIds = evidenceRows.map((r) => r.id);
      // BUG-72 修复：传入 tx 作为 executor，复用同一事务连接
      const userOverrideMap = userId
        ? await getUserOverrideMap(userId, evIds, tx)
        : new Map<string, "confirmed" | "downgraded" | "rejected">();

      // 聚合 evidence 统计按 cardId（使用 effectiveAlignment 统一 override 语义）
      const evidenceStats = new Map<string, { hard: number; soft: number; total: number }>();
      for (const row of evidenceRows) {
        // N-005: 使用用户级 override（如果有），否则回退到 legacy userOverride
        const userOv = userOverrideMap.get(row.id) ?? null;
        const ea = userId
          ? effectiveAlignmentForUser(row.alignment, row.userOverride, userOv)
          : effectiveAlignment(row.alignment, row.userOverride);
        if (ea === null) continue; // rejected 证据不计入统计
        const stats = evidenceStats.get(row.cardId) ?? { hard: 0, soft: 0, total: 0 };
        stats.total++;
        if (ea === "aligned") stats.hard++;
        else if (ea === "soft") stats.soft++;
        evidenceStats.set(row.cardId, stats);
      }

      // 批量查询 validation 统计
      // R-006: 按 userId 过滤，成员只能看到自己的验证记录
      const validationRows = await tx
        .select({ cardId: validationEvents.cardId, count: count() })
        .from(validationEvents)
        .where(and(
          eq(validationEvents.workspaceId, workspaceId),
          inArray(validationEvents.cardId, cardIds),
          ...(userId ? [eq(validationEvents.userId, userId)] : []),
        ))
        .groupBy(validationEvents.cardId);
      const validationMap = new Map(validationRows.map(r => [r.cardId, Number(r.count)]));

      // 批量查询 review 状态
      const reviewRows = await tx
        .select({
          cardId: validationEvents.cardId,
          reviewStatus: reviewSchedules.status,
          nextReviewAt: reviewSchedules.nextReviewAt,
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
            eq(reviewSchedules.status, ReviewStatus.PENDING),
            inArray(validationEvents.cardId, cardIds),
            // R-006: 按 userId 过滤复习计划
            ...(userId ? [eq(reviewSchedules.userId, userId)] : []),
          ),
        )
        .orderBy(asc(reviewSchedules.nextReviewAt));
      const reviewMap = new Map<string, { reviewStatus: string; nextReviewAt: Date }>();
      for (const row of reviewRows) {
        if (!reviewMap.has(row.cardId)) {
          reviewMap.set(row.cardId, { reviewStatus: row.reviewStatus, nextReviewAt: row.nextReviewAt });
        }
      }

      // R-019: 使用最后一条记录的 (createdAt, id) 作为下一页 cursor
      const lastCard = cardsWithCursor[cardsWithCursor.length - 1];
      const nextCursor = hasMore && lastCard
        ? encodeCursor(lastCard.cursorTimestamp, lastCard.id)
        : null;

      return {
        items: cards.map((card) => ({
          ...card,
          evidenceHardCount: evidenceStats.get(card.id)?.hard ?? 0,
          evidenceSoftCount: evidenceStats.get(card.id)?.soft ?? 0,
          evidenceTotalCount: evidenceStats.get(card.id)?.total ?? 0,
          validationCount: validationMap.get(card.id) ?? 0,
          reviewStatus: reviewMap.get(card.id)?.reviewStatus ?? null,
          nextReviewAt: reviewMap.get(card.id)?.nextReviewAt ?? null,
        })),
        nextCursor,
        total,
      };
    },
  );
}

/**
 * 重新生成学习卡。
 * 1. 读取当前 note，获取 note.currentVersionId
 * 2. 版本判断：比较 currentVersionId 与旧卡关联的 noteVersionId
 *    - 相同：复用当前 version，不创建新 note_version
 *    - 不同：直接使用 note.currentVersionId
 * 3. 旧卡标记 status=superseded
 * 4. 旧卡关联的 pending review_schedules 标记为 superseded
 * 5. 创建新 generation run
 * 6. 返回 jobId
 *
 * BUG-72 修复：使用 withWorkspaceTransaction 设置 DB 级工作区上下文（防御纵深/RLS）。
 */
type RegenerationDependencies = {
  createRun?: typeof createCardGenerationRun;
  getCompatibility?: typeof getGenerationRunStatus;
};

export async function regenerateCard(
  cardId: string,
  workspaceId: string,
  userId: string,
  dependencies: RegenerationDependencies = {},
) {
  // BUG-72 修复：初始读取在 withWorkspaceTransaction 内执行
  const { card, version, note } = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const card = await tx.query.learningCards.findFirst({
        where: and(eq(learningCards.id, cardId), eq(learningCards.workspaceId, workspaceId)),
      });
      if (!card) return { card: null, version: null, note: null };

      const version = await tx.query.noteVersions.findFirst({
        where: eq(noteVersions.id, card.noteVersionId),
      });
      if (!version) return { card, version: null, note: null };

      const note = await tx.query.notes.findFirst({
        where: and(eq(notes.id, version.noteId), eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)),
      });
      return { card, version, note };
    },
  );

  if (!card) return null;
  if (!version) return null;
  if (!note) return null;

  // 版本判断
  const currentVersionId = note.currentVersionId;
  const useVersionId = currentVersionId ?? card.noteVersionId;

  // 版本相同提示
  const sameVersion = useVersionId === card.noteVersionId;

  // N-010: 不再在请求阶段立即标记旧卡为 superseded、取消复习或删除搜索索引
  // 旧卡的 superseded、review 取消和搜索索引清理将在 Worker 成功创建新卡后，
  // 在同一事务中原子执行。这确保了即使 Worker 失败/超时/dead，
  // 旧卡仍可读、可搜、可复习。
  const createRun = dependencies.createRun ?? createCardGenerationRun;
  const getCompatibility = dependencies.getCompatibility ?? getGenerationRunStatus;
  const run = await createRun(
    { workspaceId, userId },
    {
      noteVersionId: useVersionId,
      // N#7-4: 幂等键改为确定性派生 (cardId + noteVersionId)，使同一 (card, noteVersion)
      // 的重复 regenerate 命中 createCardGenerationRun 去重，避免重复 AI 派发。
      // 参照 card-set/service.ts 的确定性键模式。
      idempotencyKey: `card-regenerate:${cardId}:${useVersionId}`,
      oldCardId: cardId,
    },
  );
  const compatibility = await getCompatibility(
    { workspaceId, userId },
    run.runId,
  );

  return { jobId: compatibility?.jobId ?? null, runId: run.runId, sameVersion };
}

/**
 * 忽略学习卡（artifact status → dismissed，card status → archived）。
 *
 * BUG-72 修复：使用 withWorkspaceTransaction 设置 DB 级工作区上下文（防御纵深/RLS）。
 */
export async function dismissCard(cardId: string, workspaceId: string, userId: string) {
  // BUG-72 修复：所有操作在 withWorkspaceTransaction 内执行
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      const card = await tx.query.learningCards.findFirst({
        where: and(eq(learningCards.id, cardId), eq(learningCards.workspaceId, workspaceId)),
      });
      if (!card) return null;

      // 更新 artifact status
      if (card.artifactId) {
        await tx
          .update(aiArtifacts)
          .set({ status: ArtifactStatus.DISMISSED })
          .where(eq(aiArtifacts.id, card.artifactId));
      }
      // 更新 card status → archived
      await tx
        .update(learningCards)
        .set({ status: CardStatus.ARCHIVED, updatedAt: new Date() })
        .where(eq(learningCards.id, cardId));

      // 关联的 pending review 标记 cancelled
      await tx
        .update(reviewSchedules)
        .set({ status: ReviewStatus.CANCELLED, updatedAt: new Date() })
        .where(
          and(
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.status, ReviewStatus.PENDING),
            or(
              and(
                eq(reviewSchedules.subjectType, "card"),
                eq(reviewSchedules.subjectId, cardId),
              ),
              and(
                eq(reviewSchedules.subjectType, "validation"),
                inArray(
                  reviewSchedules.subjectId,
                  tx
                    .select({ id: validationEvents.id })
                    .from(validationEvents)
                    .where(and(
                      eq(validationEvents.workspaceId, workspaceId),
                      eq(validationEvents.cardId, cardId),
                    )),
                ),
              ),
            ),
          ),
        );

      // Card and evidence projections form one searchable aggregate. Removing
      // only the card row leaves evidence hits pointing at an archived card.
      // PERF-59: JSONB metadata extraction cannot use B-tree index. GIN index would help but needs DB schema change.
      // Current single DELETE+OR is already optimal SQL structure.
      await tx
        .delete(searchDocuments)
        .where(and(
          eq(searchDocuments.workspaceId, workspaceId),
          or(
            and(
              eq(searchDocuments.objectType, "card"),
              eq(searchDocuments.objectId, cardId),
            ),
            and(
              eq(searchDocuments.objectType, "evidence"),
              eq(sql<string>`${searchDocuments.metadata}->>'cardId'`, cardId),
            ),
          ),
        ));

      return { ok: true };
    },
  );
}
