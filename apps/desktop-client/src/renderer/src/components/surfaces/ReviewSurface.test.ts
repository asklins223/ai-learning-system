import { describe, expect, it } from "vitest";
import { reviewWindowStart } from "./ReviewSurface";

const REVIEW_WINDOW_SIZE = 6;

describe("reviewWindowStart", () => {
  it.each([
    { itemCount: 0, selectedIndex: -1, expectedStart: 0 },
    { itemCount: 1, selectedIndex: 0, expectedStart: 0 },
    { itemCount: 6, selectedIndex: 0, expectedStart: 0 },
    { itemCount: 6, selectedIndex: 5, expectedStart: 0 },
    { itemCount: 8, selectedIndex: 0, expectedStart: 0 },
    { itemCount: 8, selectedIndex: 5, expectedStart: 0 },
    { itemCount: 8, selectedIndex: 6, expectedStart: 6 },
    { itemCount: 8, selectedIndex: 7, expectedStart: 6 },
    { itemCount: 20, selectedIndex: 0, expectedStart: 0 },
    { itemCount: 20, selectedIndex: 5, expectedStart: 0 },
    { itemCount: 20, selectedIndex: 6, expectedStart: 6 },
    { itemCount: 20, selectedIndex: 11, expectedStart: 6 },
    { itemCount: 20, selectedIndex: 12, expectedStart: 12 },
    { itemCount: 20, selectedIndex: 17, expectedStart: 12 },
    { itemCount: 20, selectedIndex: 18, expectedStart: 18 },
    { itemCount: 20, selectedIndex: 19, expectedStart: 18 },
    { itemCount: 21, selectedIndex: 20, expectedStart: 18 },
  ])(
    "returns $expectedStart for itemCount=$itemCount and selectedIndex=$selectedIndex",
    ({ itemCount, selectedIndex, expectedStart }) => {
      expect(reviewWindowStart(selectedIndex, itemCount)).toBe(expectedStart);
    },
  );

  it.each([8, 20, 21, 27])("keeps every selected item in a six-item aligned window for %i items", (itemCount) => {
    for (let selectedIndex = 0; selectedIndex < itemCount; selectedIndex += 1) {
      const start = reviewWindowStart(selectedIndex, itemCount);
      const end = Math.min(start + REVIEW_WINDOW_SIZE, itemCount);

      expect(start % REVIEW_WINDOW_SIZE).toBe(0);
      expect(selectedIndex).toBeGreaterThanOrEqual(start);
      expect(selectedIndex).toBeLessThan(end);
      expect(end - start).toBeLessThanOrEqual(REVIEW_WINDOW_SIZE);
    }
  });

  it("is deterministic for repeated selection calculations", () => {
    const first = reviewWindowStart(18, 20);

    expect(reviewWindowStart(18, 20)).toBe(first);
    expect(reviewWindowStart(18, 20)).toBe(first);
  });
});
