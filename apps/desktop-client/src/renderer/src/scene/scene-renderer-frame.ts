import {
  isValidSceneCameraMatrix,
  sceneCameraMatrixForViewport,
  type SceneCameraPreset,
} from "./scene-camera";
import {
  isValidSceneProjectionFrame,
  type SceneProjectionFrame,
} from "./scene-anchor-projection";
import type { SceneSize } from "./scene-geometry";
import type { SceneFrameBounds } from "./scene-input";

export type SceneProjectionFrameInput = Readonly<{
  readonly viewport: SceneSize;
  readonly frameBounds: SceneFrameBounds;
  readonly cameraPreset: SceneCameraPreset;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Build the renderer frame shared by the Pixi camera, anchor projection and
 * future Canvas pointer bridge. The caller owns when this is recomputed (for
 * example after resize or a named camera change); this helper owns validation
 * and never mutates the caller's bounds or viewport objects.
 */
export function createSceneProjectionFrame(
  input: SceneProjectionFrameInput | null | undefined,
): SceneProjectionFrame | null {
  if (!isRecord(input)) return null;

  const rawViewport = input.viewport;
  const rawFrameBounds = input.frameBounds;
  const rawCameraPreset = input.cameraPreset;
  if (!isRecord(rawViewport) || !isRecord(rawFrameBounds) || !isRecord(rawCameraPreset)) return null;

  const viewport = rawViewport as unknown as SceneSize;
  const frameBounds = rawFrameBounds as unknown as SceneFrameBounds;
  const cameraPreset = rawCameraPreset as unknown as SceneCameraPreset;
  const cameraMatrix = sceneCameraMatrixForViewport(cameraPreset, viewport);
  if (!cameraMatrix || !isValidSceneCameraMatrix(cameraMatrix)) return null;

  const frame = Object.freeze({
    frameBounds: Object.freeze({
      left: frameBounds.left,
      top: frameBounds.top,
      width: frameBounds.width,
      height: frameBounds.height,
    }),
    cameraMatrix,
  });

  return isValidSceneProjectionFrame(frame) ? frame : null;
}
