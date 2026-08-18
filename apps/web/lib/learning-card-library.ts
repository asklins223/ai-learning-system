import type { CardListItem } from "@/lib/api";
import type { PublicLearningCardV2 } from "@ailearn/shared";

/**
 * V2 学习卡 → 旧 CardListItem 兼容视图。
 *
 * 新版本学习卡已经是正式学习卡（不再只是"练习"），首页/Today/卡片库等
 * 旧消费者继续使用 CardListItem 形状；这里只映射公开字段，不伪造证据或
 * 验证统计。V2 卡统一经 `isV2` 标记路由到 `/learning-cards/:id`。
 */
export function toV2CardListItem(card: PublicLearningCardV2): CardListItem {
  return {
    id: card.cardId,
    noteVersionId: card.noteVersionId ?? "",
    workspaceId: "",
    status: "active",
    schemaJson: {
      title: card.publicSummary,
      summary: card.publicSummary,
    },
    artifactId: null,
    createdAt: card.createdAt,
    isV2: true,
    objectiveId: card.objectiveId,
    ...(card.reviewStatus ? { reviewStatus: card.reviewStatus } : {}),
    ...(card.nextReviewAt ? { nextReviewAt: card.nextReviewAt } : {}),
  };
}

/** 学习卡详情链接：V2 走 /learning-cards，旧卡走 /cards。 */
export function learningCardHref(card: Pick<CardListItem, "id" | "isV2">): string {
  return card.isV2 ? `/learning-cards/${card.id}` : `/cards/${card.id}`;
}

/** 合并旧卡与 V2 卡为按创建时间倒序的首页/今日兼容列表。 */
export function mergeLearningCardsV2(
  legacy: readonly CardListItem[],
  v2: readonly PublicLearningCardV2[],
): CardListItem[] {
  const knownIds = new Set(legacy.map((card) => card.id));
  return [
    ...legacy,
    ...v2.map(toV2CardListItem).filter((card) => !knownIds.has(card.id)),
  ].sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime();
    const rightTime = new Date(right.createdAt).getTime();
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });
}
