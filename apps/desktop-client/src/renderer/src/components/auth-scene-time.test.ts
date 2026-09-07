import { describe, expect, it } from "vitest";
import {
  authSceneLabel,
  resolveAuthScene,
  resolveAuthSceneFromDate,
} from "./auth-scene-time";

function localTime(hour: number, minute: number): Date {
  return new Date(2026, 8, 2, hour, minute, 0, 0);
}

describe("auth scene time", () => {
  it("maps the system clock to the three available lighting states", () => {
    expect(resolveAuthSceneFromDate(localTime(6, 59))).toBe("night");
    expect(resolveAuthSceneFromDate(localTime(7, 0))).toBe("day");
    expect(resolveAuthSceneFromDate(localTime(16, 59))).toBe("day");
    expect(resolveAuthSceneFromDate(localTime(17, 0))).toBe("dusk");
    expect(resolveAuthSceneFromDate(localTime(19, 29))).toBe("dusk");
    expect(resolveAuthSceneFromDate(localTime(19, 30))).toBe("night");
  });

  it("lets a deliberate time choice override the clock without changing its label", () => {
    expect(resolveAuthScene("dusk", localTime(10, 0))).toBe("dusk");
    expect(resolveAuthScene("system", localTime(18, 0))).toBe("dusk");
    expect(authSceneLabel("night")).toBe("夜读");
  });
});
