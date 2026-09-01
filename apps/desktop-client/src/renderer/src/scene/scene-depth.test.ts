import { describe, expect, it } from "vitest";
import { isRoomSceneAnchorId, SCENE_DEPTH_BANDS, ROOM_SCENE_ANCHORS, sceneAnchorStyle } from "./scene-depth";

describe("room depth registration", () => {
  it("keeps monotonic depth/parallax bands within the V1 safety envelope", () => {
    expect(SCENE_DEPTH_BANDS.map((band) => band.id)).toEqual(["D0", "D1", "D2", "D3", "D4", "D5", "D6"]);
    expect(SCENE_DEPTH_BANDS.map((band) => band.parallaxFactor)).toEqual([
      0.12,
      0.32,
      0.46,
      0.68,
      0.86,
      1,
      1.16,
    ]);
    expect(SCENE_DEPTH_BANDS.at(-1)?.maxOffsetX).toBeLessThanOrEqual(12);
  });

  it("projects registered room anchors into the canonical reference frame", () => {
    const style = sceneAnchorStyle(ROOM_SCENE_ANCHORS["room.notebook"]);
    expect(style).toEqual({ left: "50%", top: "58%" });
  });

  it("accepts only anchors registered by the room scene", () => {
    expect(isRoomSceneAnchorId("room.notebook")).toBe(true);
    expect(isRoomSceneAnchorId("room.unknown")).toBe(false);
    expect(isRoomSceneAnchorId(null)).toBe(false);
    expect(Object.keys(ROOM_SCENE_ANCHORS)).toHaveLength(6);
  });
});
