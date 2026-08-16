import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { ReviewStatus } from "@ailearn/shared";
import { withWorkspaceTransaction } from "../../db/client.ts";
import {
  cardKeyPoints,
  learningCards,
  learningCardSets,
} from "../../db/schema/card.ts";
import {
  reviewSchedules,
  validationEvents,
  validationQuestions,
} from "../../db/schema/evidence.ts";
import { notes } from "../../db/schema/note.ts";
import { searchDocuments } from "../../db/schema/search.ts";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
} from "../../lib/pagination.ts";
import {
  createCardGenerationRun,
  getGenerationRunStatus,
} from "../card-generation/service.ts";

export class CardSetServiceError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CardSetServiceError";
  }
}

export async function getCardSetWithDetail(
  cardSetId: string,
  workspaceId: string,
  userId: string,
) {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const cardSet = await tx.query.learningCardSets.findFirst({
      where: and(
        eq(learningCardSets.id, cardSetId),
        eq(learningCardSets.workspaceId, workspaceId),
      ),
    });
    if (!cardSet) return null;
    const firstPage = await listCardSetCards(
      cardSet.id,
      workspaceId,
      userId,
      // 详情路径必须含 schemaJson（card-sets/[id] 页消费 schemaJson.title）——
      // 列表瘦列（PERF-B11）不得复用到详情，否则第三轮 R2 回归（TypeError）。
      { limit: 30, includeSchemaJson: true },
    );
    if (!firstPage) return null;

    return {
      cardSet,
      cards: firstPage.items,
      nextCursor: firstPage.nextCursor,
    };
  });
}

type CardSetCardCursor = {
  ordinal: number;
  id: string;
};

function decodeCardSetCardCursor(
  value: string | undefined,
): CardSetCardCursor | null {
  if (!value) return null;
  try {
    if (
      value.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    ) return null;
    const decoded = Buffer.from(value, "base64").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64") !== value) return null;
    const separator = decoded.indexOf(":");
    if (separator <= 0) return null;
    const ordinal = Number(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (
      !Number.isSafeInteger(ordinal)
      || ordinal < 0
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ) return null;
    return { ordinal, id };
  } catch {
    return null;
  }
}

function encodeCardSetCardCursor(ordinal: number, id: string): string {
  return Buffer.from(`${ordinal}:${id}`, "utf8").toString("base64");
}

export async function listCardSetCards(
  cardSetId: string,
  workspaceId: string,
  userId: string,
  options?: { cursor?: string; limit?: number; includeSchemaJson?: boolean },
) {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const cardSet = await tx.query.learningCardSets.findFirst({
      columns: { id: true },
      where: and(
        eq(learningCardSets.id, cardSetId),
        eq(learningCardSets.workspaceId, workspaceId),
      ),
    });
    if (!cardSet) return null;
    const limit = clampLimit(options?.limit, 30);
    const cursor = decodeCardSetCardCursor(options?.cursor);
    if (options?.cursor && !cursor) {
      throw new CardSetServiceError(
        "invalid_cursor",
        400,
        "卡片分页游标无效",
      );
    }
    const conditions = [
      eq(learningCards.workspaceId, workspaceId),
      eq(learningCards.cardSetId, cardSet.id),
    ];
    if (cursor) {
      conditions.push(or(
        gt(learningCards.ordinal, cursor.ordinal),
        and(
          eq(learningCards.ordinal, cursor.ordinal),
          gt(learningCards.id, cursor.id),
        ),
      )!);
    }
    const rows = await tx.query.learningCards.findMany({
      where: and(...conditions),
      orderBy: [asc(learningCards.ordinal), asc(learningCards.id)],
      limit: limit + 1,
      // PERF-B11 修复：列表排除大 jsonb schemaJson，仅详情返回
      // （includeSchemaJson=true 的详情路径必须保留，否则 card-set 详情页
      // 消费 schemaJson.title 会因 undefined 抛 TypeError——第三轮 R2 回归）。
      columns: options?.includeSchemaJson ? undefined : { schemaJson: false },
    });
    const hasMore = rows.length > limit;
    const cards = rows.slice(0, limit);
    const cardIds = cards.map((card) => card.id);
    const keyPoints = cardIds.length > 0
      ? await tx.query.cardKeyPoints.findMany({
          where: and(
            eq(cardKeyPoints.workspaceId, workspaceId),
            inArray(cardKeyPoints.cardId, cardIds),
          ),
          orderBy: [asc(cardKeyPoints.cardId), asc(cardKeyPoints.ordinal)],
        })
      : [];
    const keyPointsByCardId = new Map<string, typeof keyPoints>();
    for (const keyPoint of keyPoints) {
      const values = keyPointsByCardId.get(keyPoint.cardId) ?? [];
      values.push(keyPoint);
      keyPointsByCardId.set(keyPoint.cardId, values);
    }
    const last = cards[cards.length - 1];
    return {
      cardSetId: cardSet.id,
      items: cards.map((card) => ({
        card,
        keyPoints: keyPointsByCardId.get(card.id) ?? [],
      })),
      nextCursor: hasMore && last && last.ordinal !== null
        ? encodeCardSetCardCursor(last.ordinal, last.id)
        : null,
    };
  });
}

export async function listCardSets(
  workspaceId: string,
  userId: string,
  options?: { cursor?: string; limit?: number },
) {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const limit = clampLimit(options?.limit, 30);
    const conditions = [eq(learningCardSets.workspaceId, workspaceId)];
    if (options?.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (decoded) {
        conditions.push(sql`
          (${learningCardSets.createdAt}, ${learningCardSets.id})
            < (${decoded.timestamp}::timestamptz, ${decoded.id}::uuid)
        `);
      }
    }
    const rows = await tx.query.learningCardSets.findMany({
      where: and(...conditions),
      orderBy: [desc(learningCardSets.createdAt), desc(learningCardSets.id)],
      limit: limit + 1,
      // PERF-B11 修复：列表排除大 jsonb coverageReport，仅详情返回。
      columns: { coverageReport: false },
      extras: {
        cursorTimestamp: sql<string>`
          to_char(
            ${learningCardSets.createdAt} AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        `.as("cursor_timestamp"),
      },
    });
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const setIds = selected.map((row) => row.id);
    const cards = setIds.length > 0
      ? await tx.query.learningCards.findMany({
          columns: {
            id: true,
            cardSetId: true,
            scope: true,
            ordinal: true,
            status: true,
          },
          where: and(
            eq(learningCards.workspaceId, workspaceId),
            inArray(learningCards.cardSetId, setIds),
          ),
          orderBy: [asc(learningCards.ordinal), asc(learningCards.id)],
        })
      : [];
    const cardsBySet = new Map<string, typeof cards>();
    for (const card of cards) {
      if (!card.cardSetId) continue;
      const values = cardsBySet.get(card.cardSetId) ?? [];
      values.push(card);
      cardsBySet.set(card.cardSetId, values);
    }
    const [{ total = 0 } = { total: 0 }] = await tx
      .select({ total: count() })
      .from(learningCardSets)
      .where(eq(learningCardSets.workspaceId, workspaceId));
    const last = selected[selected.length - 1];
    return {
      items: selected.map(({ cursorTimestamp: _cursorTimestamp, ...cardSet }) => {
        const setCards = cardsBySet.get(cardSet.id) ?? [];
        // PERF: compute sectionCardCount and overviewCardId in a single pass
        // over the cards array instead of filter().length + find().
        let sectionCardCount = 0;
        let overviewCardId: string | null = null;
        for (const card of setCards) {
          if (card.scope === "section") {
            sectionCardCount++;
          } else if (card.scope === "overview" && overviewCardId === null) {
            overviewCardId = card.id;
          }
        }
        return {
          ...cardSet,
          cardCount: setCards.length,
          sectionCardCount,
          overviewCardId,
        };
      }),
      nextCursor: hasMore && last
        ? encodeCursor(last.cursorTimestamp, last.id)
        : null,
      total: Number(total),
    };
  });
}

export async function dismissCardSet(
  cardSetId: string,
  workspaceId: string,
  userId: string,
) {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const [cardSet] = await tx
      .select()
      .from(learningCardSets)
      .where(and(
        eq(learningCardSets.id, cardSetId),
        eq(learningCardSets.workspaceId, workspaceId),
      ))
      .for("update");
    if (!cardSet) return null;
    if (cardSet.status === "superseded" || cardSet.status === "archived") {
      return { cardSetId: cardSet.id, status: cardSet.status };
    }
    const now = new Date();
    const cards = await tx
      .select({ id: learningCards.id })
      .from(learningCards)
      .where(and(
        eq(learningCards.workspaceId, workspaceId),
        eq(learningCards.cardSetId, cardSet.id),
      ))
      .for("update");
    const cardIds = cards.map((card) => card.id);
    await tx
      .update(learningCardSets)
      .set({ status: "archived", supersededAt: now })
      .where(and(
        eq(learningCardSets.id, cardSet.id),
        eq(learningCardSets.workspaceId, workspaceId),
      ));
    if (cardIds.length > 0) {
      const keyPoints = await tx
        .select({ id: cardKeyPoints.id })
        .from(cardKeyPoints)
        .where(and(
          eq(cardKeyPoints.workspaceId, workspaceId),
          inArray(cardKeyPoints.cardId, cardIds),
        ));
      const events = await tx
        .select({ id: validationEvents.id })
        .from(validationEvents)
        .where(and(
          eq(validationEvents.workspaceId, workspaceId),
          inArray(validationEvents.cardId, cardIds),
        ));
      const keyPointIds = keyPoints.map((keyPoint) => keyPoint.id);
      const validationEventIds = events.map((event) => event.id);
      // PERF-44 修复：以下多个 UPDATE/DELETE 互相独立（操作不同表/不同条件），
      // 可以并行执行，避免串行等待。
      const updatePromises: Promise<unknown>[] = [
        tx
          .update(learningCards)
          .set({ status: "archived", updatedAt: now })
          .where(and(
            eq(learningCards.workspaceId, workspaceId),
            inArray(learningCards.id, cardIds),
          )),
        tx
          .update(reviewSchedules)
          .set({ status: ReviewStatus.SUPERSEDED, updatedAt: now })
          .where(and(
            eq(reviewSchedules.workspaceId, workspaceId),
            eq(reviewSchedules.status, ReviewStatus.PENDING),
            eq(reviewSchedules.subjectType, "card"),
            inArray(reviewSchedules.subjectId, cardIds),
          )),
        tx
          .update(validationQuestions)
          .set({ status: "superseded", supersededAt: now })
          .where(and(
            eq(validationQuestions.workspaceId, workspaceId),
            inArray(validationQuestions.cardId, cardIds),
            eq(validationQuestions.status, "active"),
          )),
        tx
          .delete(searchDocuments)
          .where(and(
            eq(searchDocuments.workspaceId, workspaceId),
            or(
              and(
                eq(searchDocuments.objectType, "card_set"),
                eq(searchDocuments.objectId, cardSet.id),
              ),
              and(
                eq(searchDocuments.objectType, "card"),
                inArray(searchDocuments.objectId, cardIds),
              ),
              and(
                eq(searchDocuments.objectType, "evidence"),
                inArray(
                  sql<string>`${searchDocuments.metadata}->>'cardId'`,
                  cardIds,
                ),
              ),
            ),
          )),
      ];
      if (keyPointIds.length > 0) {
        updatePromises.push(
          tx
            .update(reviewSchedules)
            .set({ status: ReviewStatus.SUPERSEDED, updatedAt: now })
            .where(and(
              eq(reviewSchedules.workspaceId, workspaceId),
              eq(reviewSchedules.status, ReviewStatus.PENDING),
              inArray(reviewSchedules.keyPointId, keyPointIds),
            )),
        );
      }
      if (validationEventIds.length > 0) {
        updatePromises.push(
          tx
            .update(reviewSchedules)
            .set({ status: ReviewStatus.SUPERSEDED, updatedAt: now })
            .where(and(
              eq(reviewSchedules.workspaceId, workspaceId),
              eq(reviewSchedules.status, ReviewStatus.PENDING),
              or(
                inArray(
                  reviewSchedules.validationEventId,
                  validationEventIds,
                ),
                and(
                  eq(reviewSchedules.subjectType, "validation"),
                  inArray(reviewSchedules.subjectId, validationEventIds),
                ),
              ),
            )),
        );
      }
      await Promise.all(updatePromises);
    } else {
      await tx
        .delete(searchDocuments)
        .where(and(
          eq(searchDocuments.workspaceId, workspaceId),
          eq(searchDocuments.objectType, "card_set"),
          eq(searchDocuments.objectId, cardSet.id),
        ));
    }
    return { cardSetId: cardSet.id, status: "archived" as const };
  });
}

type RegenerateCardSetDependencies = {
  createRun?: typeof createCardGenerationRun;
  getCompatibility?: typeof getGenerationRunStatus;
};

export async function regenerateCardSet(
  cardSetId: string,
  workspaceId: string,
  userId: string,
  dependencies: RegenerateCardSetDependencies = {},
) {
  return withWorkspaceTransaction({ workspaceId, userId }, async (tx) => {
    const cardSet = await tx.query.learningCardSets.findFirst({
      where: and(
        eq(learningCardSets.id, cardSetId),
        eq(learningCardSets.workspaceId, workspaceId),
      ),
    });
    if (!cardSet) return null;
    const note = await tx.query.notes.findFirst({
      where: and(
        eq(notes.id, cardSet.noteId),
        eq(notes.workspaceId, workspaceId),
        sql`${notes.deletedAt} IS NULL`,
      ),
    });
    if (!note) return null;
    const noteVersionId = note.currentVersionId ?? cardSet.noteVersionId;
    const createRun = dependencies.createRun ?? createCardGenerationRun;
    const getCompatibility =
      dependencies.getCompatibility ?? getGenerationRunStatus;
    // 幂等键从 (cardSetId, noteVersionId) 派生：HTTP 重试/双击不再各自创建
    // 一个 run（第二个 run 立即 supersede 第一个，浪费整次生成）。用户在新
    // 版本或新 epoch 下再次触发时键会变化，仍可正常发起新的重新生成。
    const run = await createRun(
      { workspaceId, userId },
      {
        noteVersionId,
        idempotencyKey: `card-set-regenerate:${cardSet.id}:${noteVersionId}`,
      },
    );
    const compatibility = await getCompatibility(
      { workspaceId, userId },
      run.runId,
    );
    return {
      runId: run.runId,
      jobId: compatibility?.jobId ?? null,
      sameVersion: noteVersionId === cardSet.noteVersionId,
    };
  });
}
