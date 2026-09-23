/**
 * Page 15 「复习队列」 is the mockup's card deck: one card in front of the reader
 * and a reason slip beside it. The mockup could write that slip by hand; the
 * real page has to derive it from the only review facts the server publishes —
 * `dueAt`, `scheduleGeneration` and `startability`. Everything in this module
 * is pure so the deck geometry and the reason copy can be tested directly.
 */

import type { ReviewQueueV2 } from "@ailearn/shared/review-queue-v2-contracts";

export type ReviewItem = ReviewQueueV2["items"][number];

/** 卡叠一次读多少张牌：牌堆要看得到下面的厚度，所以窗口是围绕当前这张的。 */
export const REVIEW_WINDOW_SIZE = 6;

/**
 * 牌堆窗口：当前这张前面只留一张，后面留满 —— 堆在下面的牌才是"接下来要抽的"，
 * 厚度是给读者看的；前面那一张留在窗口里，是为了往回抽时它已经在场（从它离开的
 * 方向滑回来），而不是凭空出现。窗口只决定哪些卡会被渲染、哪些标签会被读取。
 */
export const REVIEW_WINDOW_BEHIND = 1;

export function reviewWindowStart(selectedIndex: number, itemCount: number): number {
  if (selectedIndex < 0 || itemCount <= REVIEW_WINDOW_SIZE) return 0;
  return Math.min(Math.max(0, selectedIndex - REVIEW_WINDOW_BEHIND), itemCount - REVIEW_WINDOW_SIZE);
}

/** A queue can repeat a review when pages overlap; the deck shows each once. */
export function uniqueReviewItems(items: readonly ReviewItem[]): ReviewItem[] {
  return [...new Map(items.map((item) => [item.reviewId, item])).values()];
}

/**
 * 队列的 startability 只剩两种：可以开始，或落在方案 16 的无辅助冷却期里。
 * 服务端的到期队列只筛选 `nextReviewAt <= now()`，所以「尚未到期」这类状态
 * 不可能出现在这里 —— 它们已从 ReviewQueueV2 合同里删除。
 */
function reviewBlockedReason(reason: Exclude<ReviewItem["startability"], { kind: "ready" }>["reason"]): string {
  const labels = { cooldown: "仍在无辅助冷却期" } as const;
  return labels[reason];
}

/** Short form of the same state, for the deck's status chip. */
export function reviewStartabilityLabel(item: ReviewItem): string {
  if (item.startability.kind === "ready") return "可以开始";
  const labels = { cooldown: "冷却中" } as const;
  return labels[item.startability.reason];
}

/**
 * 审计 F28：这张卡到期了，但它的正式验证**现在判不出结论**——评分点还缺冻结
 * 原文证据，结算闸会 fail closed。它与「冷却中」不是同一件事：冷却等一会儿就
 * 变了，这个缺口靠等和靠用户补充都不会变。所以这句话必须说清"不是你答得不好"，
 * 并给出真正能推进的那一步（回到目标补证据），而不是再劝用户做一次。
 */
export function reviewFormalValidationBlockedLabel(item: ReviewItem): string | null {
  if (!item.formalValidationBlocked) return null;
  const count = item.formalValidationBlocked.missingRubricUnitIds.length;
  return count > 0
    ? `这次判不出结论：这条目标还有 ${count} 个评分点缺原文证据，补答补不上`
    : "这次判不出结论：这条目标的评分点读不出可比对的原文证据";
}

/** "第 3 张 / 共 128 张" — the deck's own position line, against the server total. */
export function reviewDeckPosition(index: number, total: number): string {
  return `第 ${index + 1} 张 / 共 ${total} 张`;
}

/** The mockup invented "预计 2 分钟"; the schedule's own round is real. */
export function reviewDeckRound(scheduleGeneration: number): string {
  return `排期第 ${scheduleGeneration} 轮`;
}

/**
 * How far past its own `dueAt` the card is. The queue only hands out schedules
 * the server already considers due (`nextReviewAt <= now()`), so there is no
 * "not yet due" direction to describe; the negative side of the arithmetic only
 * covers client/server clock skew and clamps to "刚刚到期" instead of printing a
 * negative count.
 */
export function reviewOverdueLabel(dueAt: string, now: number): string {
  const due = new Date(dueAt);
  if (!Number.isFinite(due.valueOf())) return "到期时间未提供";
  const minutes = Math.max(0, Math.round((now - due.valueOf()) / 60_000));
  if (minutes === 0) return "刚刚到期";
  if (minutes < 60) return `已超过 ${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `已超过 ${hours} 小时`;
  return `已超过 ${Math.round(hours / 24)} 天`;
}

export type ReviewReasonFacts = {
  readonly ready: boolean;
  readonly blockedReason: string | null;
  /**
   * 审计 F28：这张卡能开始，但正式验证判不出结论（评分点缺冻结证据）。
   * 非 null 时理由条必须说明"做这张只能当练习"，否则用户会以为做完会推进排程。
   */
  readonly formalValidationBlocked: string | null;
  readonly overdue: string;
  /**
   * 已载入队列里属于同一个理解目标的到期卡数（含当前这张）。它回答的是
   * 「同一个目标还有几张卡」——不是「牵动了几个目标」。
   */
  readonly relatedCards: number;
  /** 已载入队列覆盖到的不同理解目标数。跨目标的说法只能由它承担。 */
  readonly affectedObjectives: number;
  readonly scheduleGeneration: number;
  /** Zero-based seat of the selected card in the loaded queue (head = 0). */
  readonly queuePosition: number;
};

export function reviewReasonFacts(
  item: ReviewItem,
  relatedCards: number,
  now: number,
  queuePosition = 0,
  affectedObjectives = 1,
): ReviewReasonFacts {
  return {
    ready: item.startability.kind === "ready",
    blockedReason: item.startability.kind === "ready" ? null : reviewBlockedReason(item.startability.reason),
    formalValidationBlocked: reviewFormalValidationBlockedLabel(item),
    overdue: reviewOverdueLabel(item.dueAt, now),
    relatedCards,
    affectedObjectives,
    scheduleGeneration: item.scheduleGeneration,
    queuePosition,
  };
}

/**
 * The slip's sentence. It only says what the queue can prove: how late the card
 * is, how many more cards its own objective still has due, and how the schedule
 * has already carried it. No mockup sample reason survives here, and it never
 * claims the card "moves" more objectives than the queue actually contains.
 */
export function reviewReasonSentence(facts: ReviewReasonFacts): string {
  if (!facts.ready) {
    return `${facts.blockedReason}：服务端还没有把它排到可以开始的位置，队列先把它留在这里。`;
  }
  // 审计 F28：到期、可以开始，但正式验证判不出结论。这句话必须排在"排在第几位"
  // 前面——否则用户读完理由条只知道该做哪张，不知道做完也不会推进排程。
  if (facts.formalValidationBlocked) {
    return `${facts.overdue}，${facts.formalValidationBlocked}。做这张只能当练习，不会改变复习安排。`;
  }
  const parts = [facts.overdue];
  if (facts.relatedCards > 1) parts.push(`同一理解目标还有 ${facts.relatedCards - 1} 张到期卡`);
  if (facts.scheduleGeneration > 1) parts.push(`已经排到第 ${facts.scheduleGeneration} 轮`);
  // Only the actual head card may claim 队首; a card the reader stepped to
  // names its own seat instead of borrowing the head's claim.
  const seat = facts.queuePosition === 0
    ? "所以它排在队首"
    : `所以它排在第 ${facts.queuePosition + 1} 位`;
  return `${parts.join(" · ")}，${seat}。`;
}

/** The mockup's "排在最前" / blocked chip on the reason slip. */
export function reviewReasonTag(facts: ReviewReasonFacts): { readonly label: string; readonly tone: "red" | "green" | "" } {
  if (facts.ready) {
    return { label: facts.queuePosition === 0 ? "排在最前" : `排在第 ${facts.queuePosition + 1} 位`, tone: "red" };
  }
  return { label: facts.blockedReason ?? "等待条件", tone: "" };
}

/**
 * The mockup's "后续顺序：间隔效应 → 认知负荷 → 反馈设计", read from the queue
 * itself. An objective without a published label is skipped rather than named
 * "未命名", so the line only ever shows text a reader can follow.
 *
 * Each stop carries the review it names and how many cards away it sits. The
 * carousel slides that many steps, so the stop has to know its own distance:
 * pairing the n-th label with the n-th step points at the wrong card as soon as
 * a stop is skipped.
 */
export type ReviewSequenceStop = {
  readonly reviewId: string;
  readonly label: string;
  /** 距离当前这张有几张。牌堆要按它抽过去，而不是按它在列表里的序号。 */
  readonly offset: number;
};

export function reviewSequenceAfter(
  items: readonly ReviewItem[],
  fromIndex: number,
  labelOf: (item: ReviewItem) => string | null,
  limit = 3,
): readonly ReviewSequenceStop[] {
  const stops: ReviewSequenceStop[] = [];
  for (let index = fromIndex + 1; index < items.length && stops.length < limit; index += 1) {
    const item = items[index];
    const label = labelOf(item);
    if (label) stops.push({ reviewId: item.reviewId, label, offset: index - fromIndex });
  }
  return stops;
}

/** 拖拽越过这个比例的牌宽就算抽了出去，不需要把牌拖满整张。 */
export const DECK_DRAG_RATIO = 0.4;
/** 快速轻扫的判定：px/ms。手指一甩比慢慢拖更符合直觉。 */
export const DECK_FLING_VELOCITY = 0.35;
/** 小于这个位移算点击而不是拖拽。 */
export const DECK_DRAG_SLOP = 6;
/** 队首/队尾之外再拖时的阻尼，让边界"拖得动但拖不走"。 */
export const DECK_EDGE_RESISTANCE = 0.35;

export type DeckDragOutcome = "previous" | "next" | "load-next" | "snap-back";

/**
 * 一次拖拽松手之后该发生什么。它是纯函数，因为真正的难点不在动画而在判定：
 * 距离与速度都可能决定这张牌抽不抽得出去，队首/队尾要停住（牌堆下面没有牌了），
 * 而"已载入的末尾 + 服务端还有下一页"应该顺势把下一页读进来再抽下一张。
 */
export function deckDragOutcome(input: {
  readonly dx: number;
  /** 一次完整的"抽出来"大概要走多远（一张牌的宽度）。 */
  readonly reach: number;
  readonly velocity: number;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  /** 服务端还有没读进来的到期项。 */
  readonly hasMore: boolean;
}): DeckDragOutcome {
  const { dx, reach, velocity, canPrevious, canNext, hasMore } = input;
  if (Math.abs(dx) < DECK_DRAG_SLOP) return "snap-back";
  const flicked = Math.abs(velocity) >= DECK_FLING_VELOCITY;
  const dragged = Math.abs(dx) >= Math.max(1, reach) * DECK_DRAG_RATIO;
  if (!flicked && !dragged) return "snap-back";
  const forward = dx < 0; // 向左拖 = 下一张
  if (forward) {
    if (canNext) return "next";
    return hasMore ? "load-next" : "snap-back";
  }
  return canPrevious ? "previous" : "snap-back";
}

/** 该方向没有牌时把手势按阻尼压小，边界就只是"拖不动"，而不是断掉。 */
export function deckDragShift(dx: number, canMove: boolean): number {
  return canMove ? dx : dx * DECK_EDGE_RESISTANCE;
}
