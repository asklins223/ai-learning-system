import { describe, expect, it } from "vitest";
import {
  SCENE_CAMERA_PRESETS,
  sceneCameraMatrixForViewport,
} from "./scene-camera";
import { createSceneProjectionFrame, type SceneProjectionFrameInput } from "./scene-renderer-frame";

describe("scene renderer frame factory", () => {
  const input: SceneProjectionFrameInput = {
    viewport: { width: 1672, height: 941 },
    frameBounds: { left: 120, top: 48, width: 836, height: 470.5 },
    cameraPreset: SCENE_CAMERA_PRESETS.study,
  };

  it("builds an immutable frame from the shared viewport contract", () => {
    const frame = createSceneProjectionFrame(input);
    const expectedMatrix = sceneCameraMatrixForViewport(
      SCENE_CAMERA_PRESETS.study,
      input.viewport,
    );

    expect(frame).not.toBeNull();
    expect(frame!.cameraMatrix).toEqual(expectedMatrix);
    expect(frame!.frameBounds).toEqual(input.frameBounds);
    expect(frame!.frameBounds).not.toBe(input.frameBounds);
    expect(Object.isFrozen(frame)).toBe(true);
    expect(Object.isFrozen(frame!.frameBounds)).toBe(true);
  });

  it("fails closed for malformed viewport, bounds, preset and input", () => {
    expect(createSceneProjectionFrame({
      ...input,
      viewport: { width: 0, height: input.viewport.height },
    })).toBeNull();
    expect(createSceneProjectionFrame({
      ...input,
      frameBounds: { ...input.frameBounds, width: Number.NaN },
    })).toBeNull();
    expect(createSceneProjectionFrame({
      ...input,
      cameraPreset: { ...SCENE_CAMERA_PRESETS.study, scale: Number.NaN },
    })).toBeNull();
    expect(createSceneProjectionFrame(null)).toBeNull();
    expect(createSceneProjectionFrame({
      ...input,
      frameBounds: undefined,
    } as unknown as SceneProjectionFrameInput)).toBeNull();
  });
});
