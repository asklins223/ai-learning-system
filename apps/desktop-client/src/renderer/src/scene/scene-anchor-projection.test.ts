import { describe, expect, it } from "vitest";
import { SCENE_CAMERA_PRESETS, sceneCameraMatrixForViewport, type SceneCameraMatrix } from "./scene-camera";
import {
  projectSceneAnchor,
  projectSceneAnchorRegistry,
  projectSceneViewportPoint,
  type SceneProjectionFrame,
} from "./scene-anchor-projection";
import { ROOM_SCENE_ANCHORS } from "./scene-depth";

describe("scene anchor projection bridge", () => {
  const viewport = { width: 1672, height: 941 };
  const frameBounds = { left: 120, top: 48, width: 836, height: 470.5 };
  const cameraMatrix = sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.room, viewport)!;
  const frame: SceneProjectionFrame = { frameBounds, cameraMatrix };

  it("maps one world anchor through camera viewport into client space", () => {
    const anchor = ROOM_SCENE_ANCHORS["room.notebook"];
    const projection = projectSceneAnchor(anchor, frame);

    expect(projection).toEqual({
      id: anchor.id,
      label: anchor.label,
      worldPoint: anchor.point,
      viewportPoint: anchor.point,
      clientPoint: [538, 320.89],
      visible: true,
    });
  });

  it("keeps the same batch order and reports offscreen points without clamping them", () => {
    const shiftedMatrix = Object.freeze({
      ...cameraMatrix,
      tx: cameraMatrix.tx + viewport.width * 2,
    });
    const shiftedFrame = { frameBounds, cameraMatrix: shiftedMatrix };
    const projection = projectSceneAnchor(ROOM_SCENE_ANCHORS["room.notebook"], shiftedFrame);
    const batch = projectSceneAnchorRegistry(ROOM_SCENE_ANCHORS, frame);

    expect(projection?.visible).toBe(false);
    expect(projection?.viewportPoint[0]).toBeGreaterThan(viewport.width);
    expect(batch.map((item) => item.id)).toEqual(Object.keys(ROOM_SCENE_ANCHORS));
    expect(batch).toHaveLength(Object.keys(ROOM_SCENE_ANCHORS).length);
  });

  it("returns null or an empty batch for invalid geometry instead of partial coordinates", () => {
    const malformedMatrix = { a: 1, d: 1 } as unknown as SceneCameraMatrix;

    expect(projectSceneViewportPoint([0, 0], { ...frameBounds, width: 0 }, cameraMatrix)).toBeNull();
    expect(projectSceneAnchor(ROOM_SCENE_ANCHORS["room.notebook"], {
      frameBounds,
      cameraMatrix: malformedMatrix,
    })).toBeNull();
    expect(projectSceneAnchorRegistry(ROOM_SCENE_ANCHORS, {
      frameBounds,
      cameraMatrix: malformedMatrix,
    })).toEqual([]);
  });
});
