import { describe, expect, it } from "vitest";
import { RESULT_QUERY_MAX_ATTEMPTS, RESULT_QUERY_MAX_DURATION_MS, resultPollDelayMs } from "./result-polling";

describe("result query budget", () => {
  it("allows at most eight bounded queries with exponential backoff", () => {
    expect(RESULT_QUERY_MAX_ATTEMPTS).toBe(8);
    expect(resultPollDelayMs(0, 0)).toBe(1000);
    expect(resultPollDelayMs(1, 1000)).toBe(2000);
    expect(resultPollDelayMs(4, 15000)).toBe(10000);
    expect(resultPollDelayMs(6, 35000)).toBe(10000);
    expect(resultPollDelayMs(7, 45000)).toBeNull();
  });

  it("stops at the total budget and never schedules a late request", () => {
    expect(resultPollDelayMs(2, RESULT_QUERY_MAX_DURATION_MS)).toBeNull();
    expect(resultPollDelayMs(2, 57_001)).toBeNull();
    expect(resultPollDelayMs(2, 50_000)).toBe(4000);
  });
});
