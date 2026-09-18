import { describe, expect, it } from "vitest";
import type { ReviewQueueV2 } from "@ailearn/shared/review-queue-v2-contracts";
import {
  DECK_DRAG_RATIO,
  DECK_EDGE_RESISTANCE,
  DECK_FLING_VELOCITY,
  REVIEW_WINDOW_SIZE,
  deckDragOutcome,
  deckDragShift,
  reviewDeckPosition,
  reviewDeckRound,
  reviewOverdueLabel,
  reviewReasonFacts,
  reviewReasonSentence,
  reviewReasonTag,
  reviewSequenceAfter,
  reviewStartabilityLabel,
  reviewWindowStart,
  uniqueReviewItems,
  type ReviewItem,
} from "./review-deck";

const NOW = new Date("2026-09-16T12:00:00.000Z").valueOf();

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    version: 2,
    reviewId: "11111111-1111-4111-8111-111111111111",
    scheduleId: "22222222-2222-4222-8222-222222222222",
    objectiveId: "33333333-3333-4333-8333-333333333333",
    scheduleGeneration: 1,
    dueAt: "2026-09-16T12:00:00.000Z",
    startability: { kind: "ready" },
    ...overrides,
  };
}

describe("reviewWindowStart", () => {
  it.each([
    { itemCount: 0, selectedIndex: -1, expectedStart: 0 },
    { itemCount: 1, selectedIndex: 0, expectedStart: 0 },
    { itemCount: 6, selectedIndex: 0, expectedStart: 0 },
    { itemCount: 6, selectedIndex: 5, expectedStart: 0 },
    { itemCount: 8, selectedIndex: 0, expectedStart: 0 },
    { itemCount: 8, selectedIndex: 1, expectedStart: 0 },
    { itemCount: 8, selectedIndex: 2, expectedStart: 1 },
    { itemCount: 8, selectedIndex: 5, expectedStart: 2 },
    { itemCount: 8, selectedIndex: 7, expectedStart: 2 },
    { itemCount: 20, selectedIndex: 0, expectedStart: 0 },
    { itemCount: 20, selectedIndex: 1, expectedStart: 0 },
    { itemCount: 20, selectedIndex: 4, expectedStart: 3 },
    { itemCount: 20, selectedIndex: 10, expectedStart: 9 },
    { itemCount: 20, selectedIndex: 17, expectedStart: 14 },
    { itemCount: 20, selectedIndex: 19, expectedStart: 14 },
    { itemCount: 21, selectedIndex: 20, expectedStart: 15 },
  ])(
    "returns $expectedStart for itemCount=$itemCount and selectedIndex=$selectedIndex",
    ({ itemCount, selectedIndex, expectedStart }) => {
      expect(reviewWindowStart(selectedIndex, itemCount)).toBe(expectedStart);
    },
  );

  it.each([8, 20, 21, 27])("keeps the pile full behind the front card for %i items", (itemCount) => {
    for (let selectedIndex = 0; selectedIndex < itemCount; selectedIndex += 1) {
      const start = reviewWindowStart(selectedIndex, itemCount);
      const end = Math.min(start + REVIEW_WINDOW_SIZE, itemCount);

      expect(selectedIndex).toBeGreaterThanOrEqual(start);
      expect(selectedIndex).toBeLessThan(end);
      expect(end - start).toBeLessThanOrEqual(REVIEW_WINDOW_SIZE);
      // 往回抽的那一张要已经在场（否则它只能凭空出现）；堆在下面的牌要尽量多。
      if (selectedIndex > 0) expect(selectedIndex - start).toBeGreaterThanOrEqual(1);
      if (selectedIndex < itemCount - 1) expect(end - 1 - selectedIndex).toBeGreaterThanOrEqual(1);
      if (selectedIndex > 0 && itemCount - selectedIndex > REVIEW_WINDOW_SIZE - 2) {
        expect(end - 1 - selectedIndex).toBeGreaterThanOrEqual(REVIEW_WINDOW_SIZE - 2);
      }
    }
  });

  it("is deterministic for repeated selection calculations", () => {
    const first = reviewWindowStart(18, 20);

    expect(reviewWindowStart(18, 20)).toBe(first);
    expect(reviewWindowStart(18, 20)).toBe(first);
  });
});

describe("uniqueReviewItems", () => {
  it("keeps the last page's copy of a repeated review", () => {
    const first = item({ reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scheduleGeneration: 1 });
    const second = item({ reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scheduleGeneration: 2 });
    const other = item({ reviewId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });

    const unique = uniqueReviewItems([first, second, other]);

    expect(unique).toHaveLength(2);
    expect(unique[0].scheduleGeneration).toBe(2);
    expect(unique[1].reviewId).toBe(other.reviewId);
  });
});

describe("reviewOverdueLabel", () => {
  it.each([
    { dueAt: "2026-09-16T12:00:00.000Z", expected: "刚刚到期" },
    { dueAt: "2026-09-16T11:30:00.000Z", expected: "已超过 30 分钟" },
    { dueAt: "2026-09-16T06:00:00.000Z", expected: "已超过 6 小时" },
    { dueAt: "2026-09-14T12:00:00.000Z", expected: "已超过 2 天" },
  ])("reads $dueAt as $expected", ({ dueAt, expected }) => {
    expect(reviewOverdueLabel(dueAt, NOW)).toBe(expected);
  });

  it.each([
    { dueAt: "2026-09-16T12:00:05.000Z", expected: "刚刚到期" },
    { dueAt: "2026-09-16T12:00:40.000Z", expected: "刚刚到期" },
  ])("clamps a clock-skewed future stamp to 刚刚到期 instead of a negative count: $dueAt", ({ dueAt, expected }) => {
    expect(reviewOverdueLabel(dueAt, NOW)).toBe(expected);
  });

  it("never invents a delay for an unreadable timestamp", () => {
    expect(reviewOverdueLabel("not-a-date", NOW)).toBe("到期时间未提供");
  });
});

describe("reviewReasonFacts", () => {
  it("carries the queue's own facts, not a mockup sample", () => {
    const facts = reviewReasonFacts(
      item({ dueAt: "2026-09-13T12:00:00.000Z", scheduleGeneration: 3 }),
      2,
      NOW,
    );

    expect(facts).toEqual({
      ready: true,
      blockedReason: null,
      overdue: "已超过 3 天",
      relatedCards: 2,
      affectedObjectives: 1,
      scheduleGeneration: 3,
      queuePosition: 0,
    });
    expect(reviewReasonSentence(facts)).toBe("已超过 3 天 · 同一理解目标还有 1 张到期卡 · 已经排到第 3 轮，所以它排在队首。");
    expect(reviewReasonTag(facts)).toEqual({ label: "排在最前", tone: "red" });
  });

  it("names the seat of a card the reader stepped to instead of claiming the head", () => {
    const facts = reviewReasonFacts(
      item({ dueAt: "2026-09-13T12:00:00.000Z", scheduleGeneration: 2 }),
      1,
      NOW,
      2,
    );

    expect(reviewReasonSentence(facts)).toBe("已超过 3 天 · 已经排到第 2 轮，所以它排在第 3 位。");
    expect(reviewReasonTag(facts)).toEqual({ label: "排在第 3 位", tone: "red" });
    expect(reviewReasonSentence(facts)).not.toContain("队首");
  });

  it("stands down when a card cannot start yet", () => {
    const facts = reviewReasonFacts(
      item({ startability: { kind: "blocked", reason: "cooldown" } }),
      1,
      NOW,
    );

    expect(facts.ready).toBe(false);
    expect(reviewReasonTag(facts)).toEqual({ label: "仍在无辅助冷却期", tone: "" });
    expect(reviewReasonSentence(facts)).toContain("仍在无辅助冷却期");
    expect(reviewReasonSentence(facts)).not.toContain("排在最前");
  });

  it("says only what is true for a single, first-round card", () => {
    const facts = reviewReasonFacts(item(), 1, NOW);
    expect(reviewReasonSentence(facts)).toBe("刚刚到期，所以它排在队首。");
  });
});

describe("reviewStartabilityLabel", () => {
  it.each([
    { startability: { kind: "ready" } as const, expected: "可以开始" },
    { startability: { kind: "blocked", reason: "cooldown" } as const, expected: "冷却中" },
  ])("labels $startability.kind", ({ startability, expected }) => {
    expect(reviewStartabilityLabel(item({ startability }))).toBe(expected);
  });
});

describe("deckDragShift", () => {
  it("follows the pointer exactly while there is a card in that direction", () => {
    expect(deckDragShift(-120, true)).toBe(-120);
    expect(deckDragShift(64, true)).toBe(64);
  });

  it("damps the pull at the first and the last loaded card", () => {
    expect(deckDragShift(-120, false)).toBeCloseTo(-120 * DECK_EDGE_RESISTANCE);
    expect(deckDragShift(64, false)).toBeCloseTo(64 * DECK_EDGE_RESISTANCE);
  });
});

describe("deckDragOutcome", () => {
  const base = {
    reach: 600,
    velocity: 0,
    canPrevious: true,
    canNext: true,
    hasMore: false,
  };

  it("treats a press that barely moved as a click, not a swipe", () => {
    expect(deckDragOutcome({ ...base, dx: -2 })).toBe("snap-back");
  });

  it("draws the card once it has been dragged far enough off the pile", () => {
    expect(deckDragOutcome({ ...base, dx: -(600 * DECK_DRAG_RATIO) })).toBe("next");
    expect(deckDragOutcome({ ...base, dx: 600 * DECK_DRAG_RATIO })).toBe("previous");
  });

  it("puts the card back on the pile when the drag stops short and is not a flick", () => {
    expect(deckDragOutcome({ ...base, dx: -100 })).toBe("snap-back");
    expect(deckDragOutcome({ ...base, dx: 100 })).toBe("snap-back");
  });

  it("lets a flick commit even when the card hardly moved", () => {
    expect(deckDragOutcome({ ...base, dx: -40, velocity: -DECK_FLING_VELOCITY })).toBe("next");
    expect(deckDragOutcome({ ...base, dx: 40, velocity: DECK_FLING_VELOCITY })).toBe("previous");
  });

  it("reads the direction from the sign of the drag, not from the velocity", () => {
    // 往回甩但仍然拖在左边：手势的方向按位置算，松手不会反向跳。
    expect(deckDragOutcome({ ...base, dx: -300, velocity: 0.9 })).toBe("next");
    expect(deckDragOutcome({ ...base, dx: 300, velocity: -0.9 })).toBe("previous");
  });

  it("only reads the next page when the loaded cards really are used up", () => {
    expect(deckDragOutcome({ ...base, dx: -400, canNext: false, hasMore: true })).toBe("load-next");
    // 没有下一页时，末尾就是末尾：滑不动，也不会把手势变成一次空读。
    expect(deckDragOutcome({ ...base, dx: -400, canNext: false, hasMore: false })).toBe("snap-back");
  });

  it("never walks off the front of the queue", () => {
    expect(deckDragOutcome({ ...base, dx: 400, canPrevious: false })).toBe("snap-back");
  });
});

describe("reviewSequenceAfter", () => {
  const items: ReviewItem[] = [
    item({ reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", objectiveId: "objective-a" }),
    item({ reviewId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", objectiveId: "objective-b" }),
    item({ reviewId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", objectiveId: "objective-c" }),
    item({ reviewId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", objectiveId: "objective-d" }),
    item({ reviewId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", objectiveId: "objective-e" }),
  ];
  const labels: Record<string, string> = {
    "objective-b": "间隔效应",
    "objective-c": "认知负荷",
    "objective-d": "反馈设计",
    "objective-e": "提取练习",
  };
  const labelOf = (candidate: ReviewItem) => labels[candidate.objectiveId] ?? null;

  it("lists the next three labelled stops after the front card", () => {
    expect(reviewSequenceAfter(items, 0, labelOf).map((stop) => stop.label))
      .toEqual(["间隔效应", "认知负荷", "反馈设计"]);
  });

  it("skips a stop whose objective has not published a label", () => {
    expect(reviewSequenceAfter(items, 1, labelOf).map((stop) => stop.label))
      .toEqual(["认知负荷", "反馈设计", "提取练习"]);
  });

  it("stops at the end of the loaded queue", () => {
    expect(reviewSequenceAfter(items, 3, labelOf)).toHaveLength(1);
    expect(reviewSequenceAfter(items, 4, labelOf)).toEqual([]);
  });

  it("names the card behind every label so a skipped stop cannot shift the target", () => {
    const stops = reviewSequenceAfter(items, 1, labelOf);

    expect(stops).toEqual([
      { reviewId: items[2].reviewId, label: "认知负荷", offset: 1 },
      { reviewId: items[3].reviewId, label: "反馈设计", offset: 2 },
      { reviewId: items[4].reviewId, label: "提取练习", offset: 3 },
    ]);
  });

  it("carries the distance the carousel has to slide, not the stop's ordinal", () => {
    // objective-b 没有标签，所以第一站其实是第 3 张牌：滑 1 格会停在别人的卡上。
    const stops = reviewSequenceAfter(items, 0, labelOf);

    expect(stops.map((stop) => stop.offset)).toEqual([1, 2, 3]);
    expect(stops[0].reviewId).toBe(items[1].reviewId);
  });
});

describe("deck lines", () => {
  it("numbers the card from its real position", () => {
    expect(reviewDeckPosition(0, 6)).toBe("第 1 张 / 共 6 张");
    expect(reviewDeckPosition(5, 12)).toBe("第 6 张 / 共 12 张");
  });

  it("counts against the server total, not the loaded page", () => {
    expect(reviewDeckPosition(0, 137)).toBe("第 1 张 / 共 137 张");
    expect(reviewDeckPosition(19, 137)).toBe("第 20 张 / 共 137 张");
  });

  it("names the schedule round instead of an invented estimate", () => {
    expect(reviewDeckRound(1)).toBe("排期第 1 轮");
    expect(reviewDeckRound(4)).toBe("排期第 4 轮");
  });
});

describe("queue contract", () => {
  it("accepts the sanitized queue shape the deck reads", () => {
    const queue: ReviewQueueV2 = { version: 2, items: [item()], total: 1, nextCursor: null };
    expect(queue.items[0].startability.kind).toBe("ready");
  });
});
