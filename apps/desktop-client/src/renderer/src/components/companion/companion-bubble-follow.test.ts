import { describe, expect, it } from "vitest";
import {
  COMPANION_BUBBLE_FOLLOW_SLACK_PX,
  companionBubbleAtBottom,
  createCompanionBubbleFollow,
} from "./companion-bubble-follow";

/** 一个装满了的正文容器：3 行内容、2 行可视，钉底时 scrollTop = 26。 */
const overflow = { scrollHeight: 78, clientHeight: 52 };

describe("companionBubbleAtBottom", () => {
  it("counts a short reply with no scrollbar as following", () => {
    expect(companionBubbleAtBottom({ scrollTop: 0, scrollHeight: 40, clientHeight: 72 })).toBe(true);
  });

  it("counts a container pinned to the bottom as following", () => {
    expect(companionBubbleAtBottom({ scrollTop: 200, scrollHeight: 272, clientHeight: 72 })).toBe(true);
  });

  it("tolerates the sub-pixel error of a programmatic pin", () => {
    expect(companionBubbleAtBottom({ scrollTop: 199.5, scrollHeight: 272, clientHeight: 72 })).toBe(true);
  });

  it("draws the line one slack above the bottom", () => {
    const slack = COMPANION_BUBBLE_FOLLOW_SLACK_PX;
    expect(companionBubbleAtBottom({ scrollTop: 200 - slack, scrollHeight: 272, clientHeight: 72 })).toBe(true);
    expect(companionBubbleAtBottom({ scrollTop: 200 - slack - 1, scrollHeight: 272, clientHeight: 72 })).toBe(false);
  });

  it("reads a real scroll back up as the user leaving the bottom", () => {
    // 一行文字（~28px）之上：不小于一个滚轮格，也不小于容差。
    expect(companionBubbleAtBottom({ scrollTop: 172, scrollHeight: 272, clientHeight: 72 })).toBe(false);
  });
});

describe("createCompanionBubbleFollow", () => {
  it("follows from the start and pins to the bottom", () => {
    const follow = createCompanionBubbleFollow();
    expect(follow.following).toBe(true);
    expect(follow.pinnedScrollTop({ ...overflow, scrollTop: 0 })).toBe(78);
  });

  it("steps aside once the user scrolls up, and keeps out of the way", () => {
    const follow = createCompanionBubbleFollow();
    follow.noteScroll({ ...overflow, scrollTop: 0 });
    expect(follow.following).toBe(false);
    // 正文继续长：钉底的值仍然是"什么都不做"，用户读的那一段不会被抢走。
    expect(follow.pinnedScrollTop({ scrollHeight: 130, clientHeight: 52, scrollTop: 0 })).toBeNull();
  });

  it("takes over again when the user comes back to the bottom", () => {
    const follow = createCompanionBubbleFollow();
    follow.noteScroll({ ...overflow, scrollTop: 0 });
    follow.noteScroll({ ...overflow, scrollTop: 26 });
    expect(follow.following).toBe(true);
    expect(follow.pinnedScrollTop({ ...overflow, scrollTop: 26 })).toBe(78);
  });

  it("keeps following a short reply that has no scrollbar", () => {
    const follow = createCompanionBubbleFollow();
    const short = { scrollHeight: 26, clientHeight: 52, scrollTop: 0 };
    follow.noteScroll(short);
    expect(follow.following).toBe(true);
    expect(follow.pinnedScrollTop(short)).toBe(26);
  });

  it("starts over on a new bubble", () => {
    const follow = createCompanionBubbleFollow();
    follow.noteScroll({ ...overflow, scrollTop: 0 });
    expect(follow.following).toBe(false);
    follow.reset();
    expect(follow.following).toBe(true);
    expect(follow.pinnedScrollTop({ ...overflow, scrollTop: 0 })).toBe(78);
  });

  it("tolerates the sub-pixel gap of its own pin", () => {
    const follow = createCompanionBubbleFollow();
    follow.noteScroll({ ...overflow, scrollTop: 26 - COMPANION_BUBBLE_FOLLOW_SLACK_PX });
    expect(follow.following).toBe(true);
  });
});
