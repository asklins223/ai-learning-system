import type { ViewPresetId } from "../app/room-machine";
import { SCENE_WORLD, type ScenePoint, type SceneSize } from "./scene-geometry";

export type SceneCameraPreset = {
  readonly label: string;
  readonly scale: number;
  readonly xPercent: number;
  readonly yPercent: number;
};

/**
 * A finite affine camera in reference-frame pixels.
 *
 * `viewport` is the untransformed reference frame. The matrix maps canonical
 * room-world points into that frame after the named camera preset is applied;
 * it deliberately stays 2D until a renderer owns a deeper camera contract.
 */
export type SceneCameraMatrix = Readonly<{
  readonly viewport: Readonly<SceneSize>;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly tx: number;
  readonly ty: number;
}>;

const CAMERA_MATRIX_EPSILON = 1e-9;

/**
 * V1 uses a finite set of named compositions. The same values drive the room
 * poster and every DOM scene reference frame; surfaces never invent their own
 * camera offsets.
 */
export const SCENE_CAMERA_PRESETS: Readonly<Record<ViewPresetId, SceneCameraPreset>> = Object.freeze({
  room: { label: "房间总览", scale: 1, xPercent: 0, yPercent: 0 },
  study: { label: "研究册近景", scale: 1.12, xPercent: 0, yPercent: -3.5 },
  notebook: { label: "笔记近景", scale: 1.13, xPercent: 1.5, yPercent: -4 },
  "card-generation": { label: "卡片生成近景", scale: 1.15, xPercent: -2.5, yPercent: -4.5 },
  review: { label: "复习近景", scale: 1, xPercent: 0, yPercent: 0 },
  search: { label: "档案墙总览", scale: 1, xPercent: 0, yPercent: 0 },
  graph: { label: "窗景近景", scale: 1.18, xPercent: 0, yPercent: 6 },
  validation: { label: "验证近景", scale: 1.12, xPercent: 1.5, yPercent: -3.5 },
  "source-library": { label: "来源库近景", scale: 1.04, xPercent: 0, yPercent: 0 },
  "source-detail": { label: "来源详情近景", scale: 1.08, xPercent: 1, yPercent: -2 },
  "note-library": { label: "笔记库近景", scale: 1.04, xPercent: 0, yPercent: 0 },
  "objective-library": { label: "理解目标近景", scale: 1.04, xPercent: -1, yPercent: 0 },
  "objective-detail": { label: "理解目标详情近景", scale: 1.1, xPercent: 0, yPercent: -2 },
  "companion-center": { label: "伴星中心近景", scale: 1.02, xPercent: 0, yPercent: 0 },
  settings: { label: "设置近景", scale: 1.02, xPercent: 0, yPercent: 0 },
});

export function sceneCameraPreset(viewPreset: ViewPresetId): SceneCameraPreset {
  return SCENE_CAMERA_PRESETS[viewPreset];
}

function isFinitePoint(point: ScenePoint): boolean {
  return point.every(Number.isFinite);
}

function isValidViewport(viewport: SceneSize | null | undefined): boolean {
  if (!viewport) return false;
  return Number.isFinite(viewport.width)
    && Number.isFinite(viewport.height)
    && viewport.width > 0
    && viewport.height > 0;
}

function isValidPreset(preset: SceneCameraPreset | null | undefined): boolean {
  if (!preset) return false;
  return Number.isFinite(preset.scale)
    && preset.scale > 0
    && Number.isFinite(preset.xPercent)
    && Number.isFinite(preset.yPercent);
}

/** Build the one affine camera shared by a future renderer and input parser. */
export function sceneCameraMatrixForViewport(
  preset: SceneCameraPreset,
  viewport: SceneSize,
): SceneCameraMatrix | null {
  if (!isValidPreset(preset) || !isValidViewport(viewport)) return null;

  const baseScaleX = viewport.width / SCENE_WORLD.width;
  const baseScaleY = viewport.height / SCENE_WORLD.height;
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const scale = preset.scale;
  const translationX = (preset.xPercent / 100) * viewport.width;
  const translationY = (preset.yPercent / 100) * viewport.height;

  return Object.freeze({
    viewport: Object.freeze({ width: viewport.width, height: viewport.height }),
    a: baseScaleX * scale,
    b: 0,
    c: 0,
    d: baseScaleY * scale,
    tx: centerX * (1 - scale) + translationX,
    ty: centerY * (1 - scale) + translationY,
  });
}

/** Return whether a camera matrix is safe to use for projection or input. */
export function isValidSceneCameraMatrix(matrix: SceneCameraMatrix | null | undefined): boolean {
  if (!matrix || !isValidViewport(matrix.viewport)) return false;
  if (![matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty].every(Number.isFinite)) return false;
  return Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) > CAMERA_MATRIX_EPSILON;
}

/** Project one canonical room-world point into camera-viewport pixels. */
export function projectSceneCameraPoint(
  point: ScenePoint,
  matrix: SceneCameraMatrix,
): ScenePoint | null {
  if (!isFinitePoint(point) || !isValidSceneCameraMatrix(matrix)) return null;
  const projected: ScenePoint = [
    matrix.a * point[0] + matrix.c * point[1] + matrix.tx,
    matrix.b * point[0] + matrix.d * point[1] + matrix.ty,
  ];
  return isFinitePoint(projected) ? projected : null;
}

/** Invert one camera-viewport point back into canonical room-world pixels. */
export function unprojectSceneCameraPoint(
  point: ScenePoint,
  matrix: SceneCameraMatrix,
): ScenePoint | null {
  if (!isFinitePoint(point) || !isValidSceneCameraMatrix(matrix)) return null;
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  const offsetX = point[0] - matrix.tx;
  const offsetY = point[1] - matrix.ty;
  const unprojected: ScenePoint = [
    (matrix.d * offsetX - matrix.c * offsetY) / determinant,
    (-matrix.b * offsetX + matrix.a * offsetY) / determinant,
  ];
  return isFinitePoint(unprojected) ? unprojected : null;
}

export function sceneCameraCssValues(preset: SceneCameraPreset): {
  "--scene-camera-scale": string;
  "--scene-camera-x-percent": string;
  "--scene-camera-y-percent": string;
} {
  return {
    "--scene-camera-scale": String(preset.scale),
    "--scene-camera-x-percent": `${preset.xPercent}%`,
    "--scene-camera-y-percent": `${preset.yPercent}%`,
  };
}
