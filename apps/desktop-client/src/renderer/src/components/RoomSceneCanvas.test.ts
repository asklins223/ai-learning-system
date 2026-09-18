import { describe, expect, it } from "vitest";
import type { SceneDepthBandId } from "../scene/scene-depth";
import { hasExactRoomSceneLayerDepths } from "./RoomSceneCanvas";

const REQUIRED_HOME_DEPTHS = ["D1", "D2", "D3", "D4"] as const;
const layers = (...depths: SceneDepthBandId[]) => depths.map((depth) => ({ depth }));

describe("Room scene Pixi layer pack gate", () => {
  it("accepts at least one independently mounted layer for every required depth", () => {
    expect(hasExactRoomSceneLayerDepths(
      layers("D1", "D2", "D3", "D4"),
      REQUIRED_HOME_DEPTHS,
    )).toBe(true);
  });

  it("accepts several independently cropped objects in one depth band", () => {
    expect(hasExactRoomSceneLayerDepths(
      layers("D1", "D2", "D3", "D4", "D4"),
      REQUIRED_HOME_DEPTHS,
    )).toBe(true);
  });

  it("rejects missing and unexpected foreground layers", () => {
    expect(hasExactRoomSceneLayerDepths(
      layers("D1", "D2", "D3"),
      REQUIRED_HOME_DEPTHS,
    )).toBe(false);
    expect(hasExactRoomSceneLayerDepths(
      layers("D1", "D2", "D3", "D4", "D6"),
      REQUIRED_HOME_DEPTHS,
    )).toBe(false);
  });
});
