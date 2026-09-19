import { describe, expect, it } from "vitest";
import {
  COMPANION_BUBBLE_MAX_CHARS,
  COMPANION_BUBBLE_MIN_HEIGHT_PX,
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
