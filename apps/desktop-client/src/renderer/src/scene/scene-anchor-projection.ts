import {
  isValidSceneCameraMatrix,
  projectSceneCameraPoint,
  type SceneCameraMatrix,
} from "./scene-camera";
import type { ScenePoint } from "./scene-geometry";
import type { SceneAnchor } from "./scene-depth";
import type { SceneFrameBounds } from "./scene-input";

export type SceneProjectionFrame = Readonly<{
  /** Client-space bounds of the untransformed renderer viewport. */
  readonly frameBounds: SceneFrameBounds;
  readonly cameraMatrix: SceneCameraMatrix;
}>;

export type SceneViewportProjection = Readonly<{
  readonly viewportPoint: ScenePoint;
  readonly clientPoint: ScenePoint;
  readonly visible: boolean;
}>;

export type SceneAnchorProjection = Readonly<{
  readonly id: SceneAnchor["id"];
  readonly label: string;
  readonly worldPoint: ScenePoint;
  /** Point in the camera matrix's untransformed viewport pixels. */
  readonly viewportPoint: ScenePoint;
  readonly clientPoint: ScenePoint;
  /** False when the projected point is outside the renderer viewport. */
  readonly visible: boolean;
}>;

function isFinitePoint(point: ScenePoint | null | undefined): boolean {
  if (!Array.isArray(point) || point.length !== 2) return false;
  return point.every(Number.isFinite);
}

/** Validate one renderer-facing projection before it reaches a display sink. */
export function isValidSceneAnchorProjection(value: unknown): value is SceneAnchorProjection {
  if (!value || typeof value !== "object") return false;
  const projection = value as Partial<SceneAnchorProjection>;
  return typeof projection.id === "string"
    && typeof projection.label === "string"
    && isFinitePoint(projection.worldPoint)
    && isFinitePoint(projection.viewportPoint)
    && isFinitePoint(projection.clientPoint)
    && typeof projection.visible === "boolean";
}

/** Validate a complete batch supplied to a renderer projection sink. */
export function isValidSceneAnchorProjectionBatch(
  value: unknown,
): value is readonly SceneAnchorProjection[] {
  return Array.isArray(value) && value.every(isValidSceneAnchorProjection);
}

function isValidFrameBounds(bounds: SceneFrameBounds | null | undefined): boolean {
  if (!bounds || typeof bounds !== "object") return false;
  return [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.width > 0
    && bounds.height > 0;
}

/** Return whether a renderer frame has usable bounds and an invertible camera. */
export function isValidSceneProjectionFrame(frame: SceneProjectionFrame | null | undefined): boolean {
  if (!frame || typeof frame !== "object") return false;
  return isValidFrameBounds(frame.frameBounds) && isValidSceneCameraMatrix(frame.cameraMatrix);
}

function copyPoint(point: ScenePoint): ScenePoint {
  return Object.freeze([point[0], point[1]]) as unknown as ScenePoint;
}

/** Map a canonical world point through camera space into client coordinates. */
export function projectSceneViewportPoint(
  worldPoint: ScenePoint,
  frameBounds: SceneFrameBounds,
  cameraMatrix: SceneCameraMatrix,
): SceneViewportProjection | null {
  if (!isFinitePoint(worldPoint) || !isValidFrameBounds(frameBounds) || !isValidSceneCameraMatrix(cameraMatrix)) {
    return null;
  }

  const viewportPoint = projectSceneCameraPoint(worldPoint, cameraMatrix);
  if (!viewportPoint) return null;
  const clientPoint: ScenePoint = [
    frameBounds.left + (viewportPoint[0] / cameraMatrix.viewport.width) * frameBounds.width,
    frameBounds.top + (viewportPoint[1] / cameraMatrix.viewport.height) * frameBounds.height,
  ];
  if (!isFinitePoint(clientPoint)) return null;

  return Object.freeze({
    viewportPoint: copyPoint(viewportPoint),
    clientPoint: copyPoint(clientPoint),
    visible: viewportPoint[0] >= 0
      && viewportPoint[0] <= cameraMatrix.viewport.width
      && viewportPoint[1] >= 0
      && viewportPoint[1] <= cameraMatrix.viewport.height,
  });
}

/** Project one registered world anchor without mutating the registry or DOM. */
export function projectSceneAnchor(
  anchor: SceneAnchor,
  frame: SceneProjectionFrame,
): SceneAnchorProjection | null {
  if (!anchor || typeof anchor !== "object" || typeof anchor.id !== "string" || typeof anchor.label !== "string") {
    return null;
  }
  if (!isValidSceneProjectionFrame(frame) || !isFinitePoint(anchor.point)) return null;

  const projection = projectSceneViewportPoint(anchor.point, frame.frameBounds, frame.cameraMatrix);
  if (!projection) return null;

  return Object.freeze({
    id: anchor.id,
    label: anchor.label,
    worldPoint: copyPoint(anchor.point),
    viewportPoint: projection.viewportPoint,
    clientPoint: projection.clientPoint,
    visible: projection.visible,
  });
}

/** Batch project a registry in insertion order for a renderer bridge. */
export function projectSceneAnchorRegistry(
  registry: Readonly<Record<string, SceneAnchor>>,
  frame: SceneProjectionFrame,
): readonly SceneAnchorProjection[] {
  if (!registry || typeof registry !== "object" || !isValidSceneProjectionFrame(frame)) return Object.freeze([]);

  return Object.freeze(Object.values(registry).flatMap((anchor) => {
    const projection = projectSceneAnchor(anchor, frame);
    return projection ? [projection] : [];
  }));
}
