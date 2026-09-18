import { describe, expect, it } from "vitest";
import {
  HOME_WINDOW_ASPECT_RATIO,
  HOME_WINDOW_INITIAL_CONTENT_SIZE,
  HOME_WINDOW_MINIMUM_SIZE,
  HOME_WINDOW_RATIO_TOLERANCE,
  HOME_WINDOW_WORLD_SIZE,
  homeWindowSizeProblems,
  isHomeWindowAspectRatio,
} from "./window-geometry";

describe("Home window geometry", () => {
  it("uses the canonical room ratio for the native window", () => {
    expect(HOME_WINDOW_ASPECT_RATIO).toBe(HOME_WINDOW_WORLD_SIZE.width / HOME_WINDOW_WORLD_SIZE.height);
    expect(isHomeWindowAspectRatio(HOME_WINDOW_INITIAL_CONTENT_SIZE)).toBe(true);
    expect(isHomeWindowAspectRatio(HOME_WINDOW_MINIMUM_SIZE)).toBe(true);
  });

  it("rejects the tall dimensions that used to expose stage bars", () => {
    expect(isHomeWindowAspectRatio({ width: 1024, height: 700 })).toBe(false);
    expect(isHomeWindowAspectRatio({ width: 700, height: 640 })).toBe(false);
  });

  it("locks the minimum size to the canonical ratio", () => {
    const minimumRatio = HOME_WINDOW_MINIMUM_SIZE.width / HOME_WINDOW_MINIMUM_SIZE.height;
    expect(Math.abs(minimumRatio - HOME_WINDOW_ASPECT_RATIO)).toBeLessThanOrEqual(HOME_WINDOW_RATIO_TOLERANCE);
    expect(homeWindowSizeProblems(HOME_WINDOW_MINIMUM_SIZE.width, HOME_WINDOW_MINIMUM_SIZE.height)).toEqual([]);
  });

  it("accepts every reachable Home V2 acceptance size", () => {
    for (const [width, height] of [[1440, 810], [1280, 720], [1920, 1080]] as const) {
      expect(homeWindowSizeProblems(width, height)).toEqual([]);
    }
  });

  it("rejects 1024x700 as both below the minimum and off-ratio", () => {
    const problems = homeWindowSizeProblems(1024, 700);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("1280x720");
    expect(problems[1]).toContain("1920:1080");
  });

  it("rejects 720x480, which the ratio-locked native window cannot reach", () => {
    expect(homeWindowSizeProblems(720, 480)).toHaveLength(2);
  });

  it("applies exactly HOME_WINDOW_RATIO_TOLERANCE to the acceptance ratio", () => {
    const heightWithinTolerance = HOME_WINDOW_WORLD_SIZE.width
      / (HOME_WINDOW_ASPECT_RATIO + HOME_WINDOW_RATIO_TOLERANCE * 0.9);
    const heightBeyondTolerance = HOME_WINDOW_WORLD_SIZE.width
      / (HOME_WINDOW_ASPECT_RATIO + HOME_WINDOW_RATIO_TOLERANCE * 1.1);

    expect(homeWindowSizeProblems(HOME_WINDOW_WORLD_SIZE.width, heightWithinTolerance)).toEqual([]);
    expect(homeWindowSizeProblems(HOME_WINDOW_WORLD_SIZE.width, heightBeyondTolerance))
      .toEqual([expect.stringContaining("1920:1080")]);
  });

  it("rejects sizes that are not positive finite numbers", () => {
    expect(homeWindowSizeProblems(Number.NaN, 810)).toHaveLength(1);
    expect(homeWindowSizeProblems(1440, 0)).toHaveLength(1);
  });
});
