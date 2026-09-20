import { describe, expect, it } from "vitest";
import {
  COMPANION_BUBBLE_MAX_CHARS,
  COMPANION_BUBBLE_MIN_HEIGHT_PX,
  companionBubbleHoldMs,
  companionBubbleLineHeights,
  companionBubbleMaxHeightPx,
  companionBubbleOverflows,
  companionBubbleText,
  estimateCompanionReadDurationMs,
} from "./companion-bubble-reveal";

describe("companionBubbleText", () => {
  it("shows nothing before the first character lands", () => {
    expect(companionBubbleText("她还在想。", 0)).toBe("");
    expect(companionBubbleText("她还在想。", -5)).toBe("");
  });

  it("slices exactly at the spoken character count", () => {
    expect(companionBubbleText("第一句。第二句。", 4)).toBe("第一句。");
  });

  it("treats an over-long count as fully revealed", () => {
    expect(companionBubbleText("已经念完了。", 999)).toBe("已经念完了。");
  });

  it("trims the source so the count lines up with the spoken text", () => {
    expect(companionBubbleText("  念到的部分  ", 3)).toBe("念到的");
  });

  it("stops growing at the cap and admits there is more", () => {
    const long = "长".repeat(COMPANION_BUBBLE_MAX_CHARS + 80);
    const shown = companionBubbleText(long, long.length);
    expect(shown.length).toBe(COMPANION_BUBBLE_MAX_CHARS + 1);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("does not add the ellipsis when only part of a short reply is revealed", () => {
    expect(companionBubbleText("这一句还没念完。", 3)).toBe("这一句");
  });
});

describe("estimateCompanionReadDurationMs", () => {
  it("uses the reading cadence in the middle of the range", () => {
    expect(estimateCompanionReadDurationMs(50)).toBe(3_000);
  });

  it("clamps both ends so a very short or very long line still feels right", () => {
    expect(estimateCompanionReadDurationMs(0)).toBe(1_200);
    expect(estimateCompanionReadDurationMs(1)).toBe(1_200);
    expect(estimateCompanionReadDurationMs(10_000)).toBe(12_000);
  });
});

describe("companionBubbleOverflows", () => {
  it("only asks for the drawer entry once the reply really is too long", () => {
    expect(companionBubbleOverflows("短".repeat(COMPANION_BUBBLE_MAX_CHARS))).toBe(false);
    expect(companionBubbleOverflows("长".repeat(COMPANION_BUBBLE_MAX_CHARS + 1))).toBe(true);
  });
});

describe("companionBubbleMaxHeightPx", () => {
  it("leaves the bubble only the room above the rail budget", () => {
    // 1440×810 实测：气泡底边在视口顶下方 311px，预算是 148px。
    expect(companionBubbleMaxHeightPx(311, 148)).toBe(163);
  });

  it("rounds so the CSS variable never carries a fraction", () => {
    expect(companionBubbleMaxHeightPx(311.4, 148.6)).toBe(163);
  });

  it("falls back to the CSS min-height when the window leaves no room", () => {
    expect(companionBubbleMaxHeightPx(148, 148)).toBe(COMPANION_BUBBLE_MIN_HEIGHT_PX);
    expect(companionBubbleMaxHeightPx(90, 148)).toBe(COMPANION_BUBBLE_MIN_HEIGHT_PX);
    expect(companionBubbleMaxHeightPx(0, 148)).toBe(COMPANION_BUBBLE_MIN_HEIGHT_PX);
  });

  it("never reports a negative height when a measurement comes back empty", () => {
    // `getBoundingClientRect().bottom` 或 CSS 变量读不出来时是 NaN，不能让变量变成 `NaNpx`。
    expect(companionBubbleMaxHeightPx(Number.NaN, 148)).toBe(COMPANION_BUBBLE_MIN_HEIGHT_PX);
    expect(companionBubbleMaxHeightPx(311, Number.NaN)).toBe(COMPANION_BUBBLE_MIN_HEIGHT_PX);
  });

  it("honours an explicit floor", () => {
    expect(companionBubbleMaxHeightPx(100, 148, 120)).toBe(120);
  });
});

describe("companionBubbleLineHeights", () => {
  it("snaps the ceiling down to whole lines above the chrome", () => {
    // 1440×810 实测：可用 300px，正文以外占 39px，一行 26.14px → 放得下 9 整行。
    const grid = companionBubbleLineHeights({ available: 300, chrome: 39, lineHeight: 26.14 });
    expect(grid.maxHeight).toBe(Math.round(39 + 9 * 26.14));
    expect(grid.minHeight).toBe(Math.round(39 + 26.14));
  });

  it("keeps the pinned view on whole lines (the top line is never cut in half)", () => {
    // 关键不变量：容器高度 − chrome 落在行高的整数倍上，钉底后 scrollTop 才落在行边界。
    // 允许的误差只有"整体取整到像素"那半格——落在上一行的行距里，切不到字形。
    const lineHeight = 26.14;
    const grid = companionBubbleLineHeights({ available: 300, chrome: 39, lineHeight });
    const lines = (grid.maxHeight - 39) / lineHeight;
    expect(Math.abs(lines - Math.round(lines)) * lineHeight).toBeLessThan(0.5);
  });

  it("falls back to a single whole line when the window leaves no room", () => {
    const grid = companionBubbleLineHeights({ available: 72, chrome: 39, lineHeight: 26.14 });
    // 一行：宁可略高于预算，也不交出半行。
    expect(grid.maxHeight).toBe(Math.round(39 + 26.14));
    expect(grid.minHeight).toBe(grid.maxHeight);
  });

  it("rounds both ends so the CSS variables never carry a fraction", () => {
    const grid = companionBubbleLineHeights({ available: 300, chrome: 39.4, lineHeight: 26.14 });
    expect(Number.isInteger(grid.maxHeight)).toBe(true);
    expect(Number.isInteger(grid.minHeight)).toBe(true);
  });

  it("treats an unmeasured chrome as zero", () => {
    const grid = companionBubbleLineHeights({ available: 100, chrome: Number.NaN, lineHeight: 25 });
    expect(grid.minHeight).toBe(25);
    expect(grid.maxHeight).toBe(100);
  });

  it("keeps the legacy floor when the line height cannot be measured", () => {
    const grid = companionBubbleLineHeights({ available: 300, chrome: 39, lineHeight: Number.NaN });
    expect(grid.minHeight).toBe(COMPANION_BUBBLE_MIN_HEIGHT_PX);
    expect(grid.maxHeight).toBe(300);
    // 可用空间也测不出来时只放一行：宁可矮，也不要一个纳不进任何行的容器。
    const single = companionBubbleLineHeights({ available: Number.NaN, chrome: 39, lineHeight: 26 });
    expect(single.minHeight).toBe(65);
    expect(single.maxHeight).toBe(65);
  });
});

describe("companionBubbleHoldMs", () => {
  it("replaces the old fixed 1.1s hold with a 2.4s floor (plan §3: short replies need time too)", () => {
    expect(companionBubbleHoldMs(0)).toBe(2_400);
    expect(companionBubbleHoldMs(-3)).toBe(2_400);
    expect(companionBubbleHoldMs(10)).toBe(2_520);
  });

  it("grows with the text and caps at 6s at the bubble capacity (300 chars)", () => {
    expect(companionBubbleHoldMs(100)).toBe(3_600);
    expect(companionBubbleHoldMs(300)).toBe(6_000);
  });

  it("stays at the cap for over-long text", () => {
    expect(companionBubbleHoldMs(500)).toBe(6_000);
  });
});
