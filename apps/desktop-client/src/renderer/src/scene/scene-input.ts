import {
  applyHomography,
  SCENE_WORLD,
  solveHomography,
  type ScenePoint,
  type SceneQuad,
} from "./scene-geometry";
import {
  isValidSceneCameraMatrix,
  unprojectSceneCameraPoint,
  type SceneCameraMatrix,
} from "./scene-camera";
import type { SceneSurfaceRegistration } from "./scene-surfaces";

export type NormalizedSurfacePoint = readonly [u: number, v: number];

export type SceneFrameBounds = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

export type SurfaceInputResolution = Readonly<{
  worldPoint: ScenePoint;
  localPoint: NormalizedSurfacePoint;
  inside: boolean;
}>;

function surfaceSourceQuad(surface: SceneSurfaceRegistration): SceneQuad {
  const { sourceRect } = surface;
  return [
    [sourceRect.x, sourceRect.y],
    [sourceRect.x + sourceRect.width, sourceRect.y],
    [sourceRect.x + sourceRect.width, sourceRect.y + sourceRect.height],
    [sourceRect.x, sourceRect.y + sourceRect.height],
  ];
}

function isFinitePoint(point: ScenePoint): boolean {
  return point.every(Number.isFinite);
}

/**
 * Convert a client-space point into canonical room-world coordinates.
 *
 * The optional camera matrix is for an untransformed renderer viewport. The
 * existing DOM path intentionally omits it because its frame bounds already
 * include the CSS camera transform; passing both would invert the camera twice.
 */
export function clientPointToReferenceWorld(
  clientPoint: ScenePoint,
  frameBounds: SceneFrameBounds,
  cameraMatrix?: SceneCameraMatrix,
): ScenePoint | null {
  if (!isFinitePoint(clientPoint)) return null;
  if (!Object.values(frameBounds).every(Number.isFinite)) return null;
  if (frameBounds.width <= 0 || frameBounds.height <= 0) return null;

  if (cameraMatrix) {
    if (!isValidSceneCameraMatrix(cameraMatrix)) return null;
    const viewportPoint: ScenePoint = [
      ((clientPoint[0] - frameBounds.left) / frameBounds.width) * cameraMatrix.viewport.width,
      ((clientPoint[1] - frameBounds.top) / frameBounds.height) * cameraMatrix.viewport.height,
    ];
    return unprojectSceneCameraPoint(viewportPoint, cameraMatrix);
  }

  return [
    ((clientPoint[0] - frameBounds.left) / frameBounds.width) * SCENE_WORLD.width,
    ((clientPoint[1] - frameBounds.top) / frameBounds.height) * SCENE_WORLD.height,
  ];
}

/** Map a normalized point inside a registered Surface to the canonical room world. */
export function projectSurfacePoint(
  surface: SceneSurfaceRegistration,
  normalizedPoint: NormalizedSurfacePoint,
  worldQuad: SceneQuad = surface.quad,
): ScenePoint | null {
  if (!isFinitePoint(normalizedPoint)) return null;
  const homography = solveHomography(surfaceSourceQuad(surface), worldQuad);
  if (!homography) return null;

  const { sourceRect } = surface;
  return applyHomography([
    sourceRect.x + normalizedPoint[0] * sourceRect.width,
    sourceRect.y + normalizedPoint[1] * sourceRect.height,
  ], homography);
}

/** Map a canonical room-world point back into a registered Surface's normalized coordinates. */
export function unprojectSurfacePoint(
  surface: SceneSurfaceRegistration,
  worldPoint: ScenePoint,
  worldQuad: SceneQuad = surface.quad,
): NormalizedSurfacePoint | null {
  if (!isFinitePoint(worldPoint)) return null;
  const homography = solveHomography(worldQuad, surfaceSourceQuad(surface));
  if (!homography) return null;

  const sourcePoint = applyHomography(worldPoint, homography);
  if (!sourcePoint) return null;
  const { sourceRect } = surface;
  return [
    (sourcePoint[0] - sourceRect.x) / sourceRect.width,
    (sourcePoint[1] - sourceRect.y) / sourceRect.height,
  ];
}

export function isInsideNormalizedSurfacePoint(
  point: NormalizedSurfacePoint,
  tolerance = 1e-6,
): boolean {
  return isFinitePoint(point)
    && point[0] >= -tolerance
    && point[0] <= 1 + tolerance
    && point[1] >= -tolerance
    && point[1] <= 1 + tolerance;
}

/** Resolve a pointer against one Surface without taking ownership of its DOM hit target. */
export function resolveSurfaceInput(input: {
  readonly clientPoint: ScenePoint;
  readonly frameBounds: SceneFrameBounds;
  readonly surface: SceneSurfaceRegistration;
  readonly worldQuad?: SceneQuad;
  readonly cameraMatrix?: SceneCameraMatrix;
}): SurfaceInputResolution | null {
  const worldPoint = clientPointToReferenceWorld(input.clientPoint, input.frameBounds, input.cameraMatrix);
  if (!worldPoint) return null;
  const localPoint = unprojectSurfacePoint(input.surface, worldPoint, input.worldQuad);
  if (!localPoint) return null;
  return Object.freeze({
    worldPoint,
    localPoint,
    inside: isInsideNormalizedSurfacePoint(localPoint),
  });
}
