import { describe, expect, it, vi } from "vitest";
import { createHomeAmbientDirector, type HomeAmbientRegionRuntime } from "./home-ambient-director";
import { LIGHTHOUSE_HOME_SCENE_PROFILE, type HomeSceneRegionId } from "./home-scene-profile";

function harness(random: () => number = () => 0) {
  const played: Array<[HomeSceneRegionId, string]> = [];
  const settled: HomeSceneRegionId[] = [];
  const regions = Object.fromEntries((["window", "desk", "shelf", "rest"] as const).map((region) => [
    region,
    {
      play: vi.fn((cueId: string) => { played.push([region, cueId]); return true; }),
      settle: vi.fn(() => { settled.push(region); }),
      setTime: vi.fn(),
      destroy: vi.fn(),
    } satisfies HomeAmbientRegionRuntime,
  ])) as unknown as Record<HomeSceneRegionId, HomeAmbientRegionRuntime>;
  const director = createHomeAmbientDirector({
    regions,
    cues: LIGHTHOUSE_HOME_SCENE_PROFILE.ambientCues,
    random,
  });
  const advance = (milliseconds: number) => {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 100) director.tick(Math.min(100, milliseconds - elapsed));
  };
  return { director, regions, played, settled, advance };
}

describe("HomeAmbientDirector", () => {
  it("schedules low-frequency cues without repeating the same region", () => {
    const { director, played, advance } = harness();
    director.setContext({ motionMode: "full", time: "day", paused: false, priorityRegion: null });
    advance(6_100);
    advance(10_100);
    expect(played.slice(0, 2).map(([region]) => region)).toEqual(["window", "desk"]);
  });

  it("gives every region a turn within the starvation window", () => {
    const { director, played, advance } = harness();
    director.setContext({ motionMode: "full", time: "day", paused: false, priorityRegion: null });
    advance(49_000);
    expect(new Set(played.map(([region]) => region))).toEqual(new Set(["window", "desk", "shelf", "rest"]));
  });

  it("weights the real-state region and caps overlapping interaction cues at two regions", () => {
    const { director, played, regions, advance } = harness(() => 0.5);
    director.setContext({ motionMode: "full", time: "day", paused: false, priorityRegion: "rest" });
    advance(10_100);
    director.trigger("desk", "page-lift");
    director.trigger("shelf", "catalog-breathe");
    expect(played.map(([region]) => region)).toEqual(["rest", "desk", "shelf"]);
    expect(regions.rest.settle).toHaveBeenCalledTimes(2);
  });

  it("lets interaction cues run in Lite, pauses cleanly, and ignores missing cues", () => {
    const { director, played, settled, advance } = harness();
    director.setContext({ motionMode: "lite", time: "dusk", paused: false, priorityRegion: "shelf" });
    director.trigger("shelf", "catalog-breathe");
    director.trigger("shelf", "missing-cue");
    expect(played).toEqual([["shelf", "catalog-breathe"]]);
    director.pause();
    advance(50_000);
    expect(played).toHaveLength(1);
    expect(new Set(settled)).toEqual(new Set(["window", "desk", "shelf", "rest"]));
  });

  it("settles immediately in Off and applies time changes to every region", () => {
    const { director, regions, settled } = harness();
    director.setContext({ motionMode: "off", time: "night", paused: false, priorityRegion: null });
    expect(new Set(settled)).toEqual(new Set(["window", "desk", "shelf", "rest"]));
    for (const runtime of Object.values(regions)) expect(runtime.setTime).toHaveBeenCalledWith("night");
  });

  it("does not replay missed ambient cues after pause and resume", () => {
    const { director, played, advance } = harness();
    director.setContext({ motionMode: "full", time: "day", paused: true, priorityRegion: null });
    advance(50_000);
    expect(played).toEqual([]);
    director.setContext({ motionMode: "full", time: "day", paused: false, priorityRegion: null });
    advance(5_900);
    expect(played).toEqual([]);
    advance(200);
    expect(played).toHaveLength(1);
  });
});
