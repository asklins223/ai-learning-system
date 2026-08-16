import type { CardListItem, CardSetListItem } from "@/lib/api";
import type { PublicLearningCardV2 } from "@ailearn/shared";
import { readPartialCardCoverageWarning } from "@/lib/card-coverage-warning";

export type LearningCardLibraryFilter =
  | "all"
  | "action"
  | "review"
  | "practiced";

export type LearningCardLibrarySort =
  | "recommended"
  | "newest"
  | "oldest"
  | "review";

export type LearningObjectiveState =
  | "partial"
  | "due"
  | "validate"
  | "scheduled"
  | "practiced"
  | "collecting";

export interface CardSetSourcePresentation {
  id: string;
  noteId: string;
  title: string;
}

export interface LearningCardSourcePresentation {
  title: string;
  scopeLabel: string;
}

export interface LearningObjectivePresentation {
  state: LearningObjectiveState;
  label: string;
  actionLabel: string;
  description: string;
}

export interface ReviewDatePresentation {
  date: string;
  label: string;
  isDue: boolean;
}

const STATE_PRIORITY: Record<LearningObjectiveState, number> = {
  partial: 0,
  due: 1,
  validate: 2,
  collecting: 3,
  scheduled: 4,
  practiced: 5,
};

/**
 * V2 学习卡 → 旧 CardListItem 兼容视图。
 *
 * 新版本学习卡已经是正式学习卡（不再只是“练习”），首页/Today/卡片库等
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

/**
 * Card-set 仅作为来源名称的兼容适配层，不再承担 /cards 的主信息架构。
 */
export function buildCardSetSourceIndex(
  sets: readonly CardSetListItem[],
): ReadonlyMap<string, CardSetSourcePresentation> {
  return new Map(
    sets.map((set) => [
      set.id,
      {
        id: set.id,
        noteId: set.noteId,
        title: set.title.trim() || "未命名笔记",
      },
    ]),
  );
}

export function learningCardSource(
  card: CardListItem,
  sourceIndex: ReadonlyMap<string, CardSetSourcePresentation>,
): LearningCardSourcePresentation {
  const source = card.cardSetId ? sourceIndex.get(card.cardSetId) : undefined;
  const scopeLabel =
    card.scope === "overview"
      ? "整篇笔记目标"
      : card.scope === "section"
        ? "笔记片段目标"
        : "笔记学习目标";

  return {
    title: source?.title ?? "来源笔记",
    scopeLabel,
  };
}

export function learningObjectiveState(
  card: CardListItem,
  now: Date = new Date(),
): LearningObjectiveState {
  if (readPartialCardCoverageWarning(card.schemaJson)) return "partial";

  const reviewAt = card.nextReviewAt ? new Date(card.nextReviewAt) : null;
  const hasValidReviewAt = Boolean(reviewAt && !Number.isNaN(reviewAt.getTime()));
  if (
    card.reviewStatus === "pending" &&
    hasValidReviewAt &&
    reviewAt!.getTime() <= now.getTime()
  ) {
    return "due";
  }

  if ((card.evidenceHardCount ?? 0) > 0 && (card.validationCount ?? 0) === 0) {
    return "validate";
  }
  if (card.reviewStatus === "pending") return "scheduled";
  if ((card.validationCount ?? 0) > 0) return "practiced";
  return "collecting";
}

export function learningObjectivePresentation(
  card: CardListItem,
  now: Date = new Date(),
): LearningObjectivePresentation {
  const state = learningObjectiveState(card, now);
  switch (state) {
    case "partial":
      return {
        state,
        label: "部分结果",
        actionLabel: "查看部分结果",
        description: "不会替换完整学习卡，不能用于验证或复习。",
      };
    case "due":
      return {
        state,
        label: "复习到期",
        actionLabel: "进入复习",
        description: "复习时间已经到达，可以从回忆开始。",
      };
    case "validate":
      return {
        state,
        label: "待验证",
        actionLabel: "开始验证",
        description: "原文依据已经就绪，下一步用自己的话作答。",
      };
    case "scheduled":
      return {
        state,
        label: "已安排",
        actionLabel: "查看复习计划",
        description: "已经安排下一次复习，仍可随时继续练习。",
      };
    case "practiced":
      return {
        state,
        label: "练习中",
        actionLabel: "继续巩固",
        description: "已有验证记录，可以继续巩固或查看反馈。",
      };
    case "collecting":
      return {
        state,
        label: "待开始",
        actionLabel: "打开学习目标",
        description: "先查看目标与原文依据，再决定如何练习。",
      };
  }
}

export function formatLearningCardReviewDate(
  value: string | null | undefined,
  now: Date = new Date(),
): ReviewDatePresentation | null {
  if (!value) return null;
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return null;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate(),
  );
  const days = Math.round((targetDay.getTime() - today.getTime()) / 86_400_000);
  const label =
    days < 0
      ? "已到期"
      : days === 0
        ? "今天"
        : days === 1
          ? "明天"
          : `${days} 天后`;

  return {
    label,
    date: new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
    }).format(target),
    isDue: target.getTime() <= now.getTime(),
  };
}

export function learningCardMatchesQuery(
  card: CardListItem,
  query: string,
  sourceIndex: ReadonlyMap<string, CardSetSourcePresentation>,
): boolean {
  const term = query.trim().toLocaleLowerCase("zh-CN");
  if (!term) return true;
  const source = learningCardSource(card, sourceIndex);
  // 摘要可能包含答案或关键结论：列表检索与展示都不消费 summary。
  const searchable = [card.schemaJson?.title ?? "", source.title, source.scopeLabel]
    .join(" ")
    .toLocaleLowerCase("zh-CN");
  return searchable.includes(term);
}

export function learningCardMatchesFilter(
  card: CardListItem,
  filter: LearningCardLibraryFilter,
  now: Date = new Date(),
): boolean {
  if (filter === "all") return true;
  const state = learningObjectiveState(card, now);
  if (filter === "action") {
    return ["partial", "due", "validate", "collecting"].includes(state);
  }
  if (filter === "review") return state === "due" || state === "scheduled";
  return state === "practiced" || state === "scheduled" || state === "due";
}

export function sortLearningCards(
  cards: readonly CardListItem[],
  sort: LearningCardLibrarySort,
  now: Date = new Date(),
): CardListItem[] {
  // F17（round4）：预计算每个卡的 sort key（日期毫秒 + 学习状态优先级）一次，
  // 再比较——此前 comparator 在 O(n log n) 内对每对比较重复 new Date 解析与
  // 重跑 learningObjectiveState（重解析 schemaJson），大量浪费与重复分配。
  const keyed = cards.map((card) => {
    const createdAt = new Date(card.createdAt).getTime();
    const rawReview = card.nextReviewAt ? new Date(card.nextReviewAt).getTime() : Number.POSITIVE_INFINITY;
    return {
      card,
      createdAt,
      reviewKey: Number.isNaN(rawReview) ? Number.POSITIVE_INFINITY : rawReview,
      statePriority: STATE_PRIORITY[learningObjectiveState(card, now)],
    };
  });
  keyed.sort((left, right) => {
    if (sort === "newest") return right.createdAt - left.createdAt;
    if (sort === "oldest") return left.createdAt - right.createdAt;
    if (sort === "review") {
      return left.reviewKey - right.reviewKey || right.createdAt - left.createdAt;
    }
    const priority = left.statePriority - right.statePriority;
    return priority || right.createdAt - left.createdAt;
  });
  return keyed.map((entry) => entry.card);
}
