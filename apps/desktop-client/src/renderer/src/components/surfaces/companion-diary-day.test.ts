import { describe, expect, it } from "vitest";
import {
  DIARY_STRIP_DAYS,
  diaryDayLabel,
  diaryDayStrip,
  isIsoDate,
  shiftIsoDate,
  toIsoDate,
  todayIsoDate,
} from "./companion-diary-day";

describe("companion diary day arithmetic", () => {
  it("steps over a month boundary", () => {
    expect(shiftIsoDate("2026-09-01", -1)).toBe("2026-08-31");
    expect(shiftIsoDate("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftIsoDate("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("steps over a leap day without drifting", () => {
    expect(shiftIsoDate("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftIsoDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftIsoDate("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("keeps the same wall-clock day at both ends of a DST change", () => {
    // Canada/Europe DST days are 23 or 25 hours long; a millisecond-based step
    // lands on the wrong calendar day, a calendar step never does.
    expect(shiftIsoDate("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftIsoDate("2026-11-01", -1)).toBe("2026-10-31");
    expect(shiftIsoDate(shiftIsoDate("2026-03-08", 1), -1)).toBe("2026-03-08");
  });

  it("reads the local calendar day, not UTC midnight", () => {
    // 2026-09-16T23:30 local is still 16 September, wherever the machine sits.
    const local = new Date(2026, 8, 16, 23, 30);
    expect(toIsoDate(local)).toBe("2026-09-16");
    expect(todayIsoDate(local)).toBe("2026-09-16");

    // A calendar day must round-trip through local parts unchanged in every
    // timezone. The UTC-parsed form does not: west of Greenwich
    // `new Date("2026-09-16")` is the 15th locally, which is exactly the bug
    // this module exists to avoid. Asserting the round-trip keeps the test
    // portable instead of pinning it to one offset.
    for (const day of ["2026-01-01", "2026-03-08", "2026-09-16", "2026-12-31"]) {
      expect(shiftIsoDate(day, 0)).toBe(day);
      expect(toIsoDate(new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))))).toBe(day);
    }
  });

  it("names the last three days and dates the rest", () => {
    const today = "2026-09-16";
    expect(diaryDayLabel("2026-09-16", today)).toBe("今天");
    expect(diaryDayLabel("2026-09-15", today)).toBe("昨天");
    expect(diaryDayLabel("2026-09-14", today)).toBe("前天");
    expect(diaryDayLabel("2026-09-10", today)).toBe("9 月 10 日");
    // 1 September must not read as "9 月 1 日" with a leading zero.
    expect(diaryDayLabel("2026-09-01", today)).toBe("9 月 1 日");
  });

  it("builds a newest-first strip ending on the anchor", () => {
    const strip = diaryDayStrip("2026-09-16");
    expect(strip).toHaveLength(DIARY_STRIP_DAYS);
    expect(strip[0]).toBe("2026-09-16");
    expect(strip[1]).toBe("2026-09-15");
    expect(strip[6]).toBe("2026-09-10");
  });

  it("rejects anything that is not a real calendar day", () => {
    expect(isIsoDate("2026-09-16")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-9-16")).toBe(false);
    expect(isIsoDate("2026-09-16T00:00:00Z")).toBe(false);
  });
});
