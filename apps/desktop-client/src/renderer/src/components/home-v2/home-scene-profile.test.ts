import { describe, expect, it } from "vitest";
import {
  LIGHTHOUSE_HOME_SCENE_PROFILE,
  homeSceneTimeForThemeMode,
  normalizedHomeFloorPolygon,
  resolveHomeSceneTime,
  validateHomeSceneProfile,
} from "./home-scene-profile";

describe("HomeSceneProfileV1", () => {
  it("validates the lighthouse room and keeps its floor in normalized world space", () => {
    expect(validateHomeSceneProfile(LIGHTHOUSE_HOME_SCENE_PROFILE)).toEqual([]);
    expect(normalizedHomeFloorPolygon()).toHaveLength(6);
    expect(normalizedHomeFloorPolygon().every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1)).toBe(true);
  });

  it.each([
    ["2026-09-15T06:59:00", "night"],
    ["2026-09-15T07:00:00", "day"],
    ["2026-09-15T17:29:00", "day"],
    ["2026-09-15T17:30:00", "dusk"],
    ["2026-09-15T19:29:00", "dusk"],
    ["2026-09-15T19:30:00", "night"],
  ] as const)("maps %s to %s", (localTime, expected) => {
    expect(resolveHomeSceneTime(new Date(localTime))).toBe(expected);
  });

  it("keeps manual theme selection binary while system time may select dusk", () => {
    const dusk = new Date("2026-09-15T18:00:00");
    expect(homeSceneTimeForThemeMode({ themeMode: "system", theme: "day", now: dusk })).toBe("dusk");
    expect(homeSceneTimeForThemeMode({ themeMode: "manual", theme: "night", now: dusk })).toBe("night");
  });

  it("fails closed for invalid world geometry and duplicate cue ids", () => {
    const invalid = {
      ...LIGHTHOUSE_HOME_SCENE_PROFILE,
      world: { width: 100, height: 100 },
      ambientCues: {
        ...LIGHTHOUSE_HOME_SCENE_PROFILE.ambientCues,
        desk: [
          LIGHTHOUSE_HOME_SCENE_PROFILE.ambientCues.desk[0],
          LIGHTHOUSE_HOME_SCENE_PROFILE.ambientCues.desk[0],
        ],
      },
    } as unknown as typeof LIGHTHOUSE_HOME_SCENE_PROFILE;
    expect(validateHomeSceneProfile(invalid)).toEqual(expect.arrayContaining([
      "world must be 1672x941",
      "region desk has an invalid cue id",
    ]));
  });
});
