export const SCENE_COORDINATE_SPACE_ID = "room-1672x941";

export const SCENE_WORLD = Object.freeze({
  width: 1672,
  height: 941,
  aspectRatio: 1672 / 941,
});

export type SceneFitMode = "cover" | "contain";
export type ScenePoint = readonly [x: number, y: number];
export type SceneQuad = readonly [ScenePoint, ScenePoint, ScenePoint, ScenePoint];

export type SceneSize = {
  readonly width: number;
  readonly height: number;
};

export type SceneRect = SceneSize & {
  readonly x: number;
  readonly y: number;
};

export type StageMatrix = {
  readonly fitMode: SceneFitMode;
  readonly viewport: SceneSize;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly renderedWidth: number;
  readonly renderedHeight: number;
};

export type Homography = readonly [
  h11: number,
  h12: number,
  h13: number,
  h21: number,
  h22: number,
  h23: number,
  h31: number,
  h32: number,
  h33: number,
];

export type QuadProjection = {
  readonly sourceSize: SceneSize;
  readonly destination: SceneQuad;
};

/**
 * Independent raster layers may keep a very small edge bleed so a camera
 * transform never exposes a one-pixel seam at the canonical world boundary.
 * This is registration bleed only; parallax offsets remain governed by the
 * D0-D6 depth budgets.
 */
export const ROOM_SCENE_LAYER_REGISTRATION_BLEED = 2;

const GEOMETRY_EPSILON = 1e-9;
const MINIMUM_QUAD_AREA = 1e-8;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isFinitePoint(value: unknown): value is ScenePoint {
  return Array.isArray(value)
    && value.length === 2
    && value.every((entry) => Number.isFinite(entry));
}

function isFiniteSize(value: unknown): value is SceneSize {
  if (!value || typeof value !== "object") return false;
  const size = value as Partial<SceneSize>;
  return isPositiveFinite(size.width ?? Number.NaN)
    && isPositiveFinite(size.height ?? Number.NaN);
}

/** Resolve the world-space rectangle implied by a Sprite registration. */
export function resolveRoomSceneLayerRegistrationRect(
  position: ScenePoint | null | undefined,
  size: SceneSize | null | undefined,
  anchor: ScenePoint | null | undefined,
): SceneRect | null {
  if (
    !isFinitePoint(position)
    || !isFiniteSize(size)
    || !isFinitePoint(anchor)
    || anchor.some((value) => value < 0 || value > 1)
  ) {
    return null;
  }

  const rect = {
    x: position[0] - size.width * anchor[0],
    y: position[1] - size.height * anchor[1],
    width: size.width,
    height: size.height,
  };
  return Object.values(rect).every(Number.isFinite) ? Object.freeze(rect) : null;
}

/**
 * Keep the complete registered layer rectangle inside the canonical room
 * world, with only the explicit edge bleed above permitted.
 */
export function isRoomSceneLayerRegistrationWithinWorld(
  position: ScenePoint | null | undefined,
  size: SceneSize | null | undefined,
  anchor: ScenePoint | null | undefined,
  bleed = ROOM_SCENE_LAYER_REGISTRATION_BLEED,
): boolean {
  if (!Number.isFinite(bleed) || bleed < 0) return false;
  const rect = resolveRoomSceneLayerRegistrationRect(position, size, anchor);
  if (!rect) return false;
  return rect.x >= -bleed
    && rect.y >= -bleed
    && rect.x + rect.width <= SCENE_WORLD.width + bleed
    && rect.y + rect.height <= SCENE_WORLD.height + bleed;
}

export function computeStageMatrix(
  viewportWidth: number,
  viewportHeight: number,
  fitMode: SceneFitMode = "cover",
): StageMatrix {
  if (!isPositiveFinite(viewportWidth) || !isPositiveFinite(viewportHeight)) {
    throw new RangeError("Stage viewport dimensions must be positive finite numbers.");
  }

  const horizontalScale = viewportWidth / SCENE_WORLD.width;
  const verticalScale = viewportHeight / SCENE_WORLD.height;
  const scale = fitMode === "cover"
    ? Math.max(horizontalScale, verticalScale)
    : Math.min(horizontalScale, verticalScale);
  const renderedWidth = SCENE_WORLD.width * scale;
  const renderedHeight = SCENE_WORLD.height * scale;

  return Object.freeze({
    fitMode,
    viewport: Object.freeze({ width: viewportWidth, height: viewportHeight }),
    scale,
    offsetX: (viewportWidth - renderedWidth) / 2,
    offsetY: (viewportHeight - renderedHeight) / 2,
    renderedWidth,
    renderedHeight,
  });
}

export function projectWorldPoint(point: ScenePoint, matrix: StageMatrix): ScenePoint {
  return [
    matrix.offsetX + point[0] * matrix.scale,
    matrix.offsetY + point[1] * matrix.scale,
  ];
}

export function unprojectScreenPoint(point: ScenePoint, matrix: StageMatrix): ScenePoint {
  return [
    (point[0] - matrix.offsetX) / matrix.scale,
    (point[1] - matrix.offsetY) / matrix.scale,
  ];
}

function crossProduct(origin: ScenePoint, first: ScenePoint, second: ScenePoint): number {
  return (first[0] - origin[0]) * (second[1] - origin[1])
    - (first[1] - origin[1]) * (second[0] - origin[0]);
}

export function sceneQuadArea(quad: SceneQuad): number {
  let doubleArea = 0;
  for (let index = 0; index < quad.length; index += 1) {
    const current = quad[index];
    const next = quad[(index + 1) % quad.length];
    doubleArea += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(doubleArea) / 2;
}

export function isConvexSceneQuad(quad: SceneQuad, minimumArea = MINIMUM_QUAD_AREA): boolean {
  if (quad.some((point) => point.some((value) => !Number.isFinite(value)))) return false;
  if (sceneQuadArea(quad) <= minimumArea) return false;

  let winding = 0;
  for (let index = 0; index < quad.length; index += 1) {
    const cross = crossProduct(
      quad[index],
      quad[(index + 1) % quad.length],
      quad[(index + 2) % quad.length],
    );
    if (Math.abs(cross) <= GEOMETRY_EPSILON) return false;
    const direction = Math.sign(cross);
    if (winding === 0) winding = direction;
    else if (direction !== winding) return false;
  }

  return true;
}

function solveLinearSystem(inputMatrix: readonly (readonly number[])[], inputVector: readonly number[]): number[] | null {
  const matrix = inputMatrix.map((row) => [...row]);
  const vector = [...inputVector];
  const size = vector.length;

  for (let pivotIndex = 0; pivotIndex < size; pivotIndex += 1) {
    let pivotRow = pivotIndex;
    for (let row = pivotIndex + 1; row < size; row += 1) {
      if (Math.abs(matrix[row][pivotIndex]) > Math.abs(matrix[pivotRow][pivotIndex])) pivotRow = row;
    }

    [matrix[pivotIndex], matrix[pivotRow]] = [matrix[pivotRow], matrix[pivotIndex]];
    [vector[pivotIndex], vector[pivotRow]] = [vector[pivotRow], vector[pivotIndex]];

    const pivot = matrix[pivotIndex][pivotIndex];
    if (!Number.isFinite(pivot) || Math.abs(pivot) <= GEOMETRY_EPSILON) return null;

    for (let column = pivotIndex; column < size; column += 1) matrix[pivotIndex][column] /= pivot;
    vector[pivotIndex] /= pivot;

    for (let row = 0; row < size; row += 1) {
      if (row === pivotIndex) continue;
      const factor = matrix[row][pivotIndex];
      for (let column = pivotIndex; column < size; column += 1) {
        matrix[row][column] -= factor * matrix[pivotIndex][column];
      }
      vector[row] -= factor * vector[pivotIndex];
    }
  }

  return vector.every(Number.isFinite) ? vector : null;
}

export function solveHomography(source: SceneQuad, destination: SceneQuad): Homography | null {
  if (!isConvexSceneQuad(source) || !isConvexSceneQuad(destination)) return null;

  const matrix: number[][] = [];
  const vector: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const [x, y] = source[index];
    const [X, Y] = destination[index];
    matrix.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    vector.push(X);
    matrix.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    vector.push(Y);
  }

  const values = solveLinearSystem(matrix, vector);
  if (!values || values.length !== 8) return null;
  return [...values, 1] as unknown as Homography;
}

export function applyHomography(point: ScenePoint, homography: Homography): ScenePoint | null {
  const [h11, h12, h13, h21, h22, h23, h31, h32, h33] = homography;
  const denominator = h31 * point[0] + h32 * point[1] + h33;
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= GEOMETRY_EPSILON) return null;

  const projected: ScenePoint = [
    (h11 * point[0] + h12 * point[1] + h13) / denominator,
    (h21 * point[0] + h22 * point[1] + h23) / denominator,
  ];
  return projected.every(Number.isFinite) ? projected : null;
}

function formatMatrixValue(value: number): string {
  if (Math.abs(value) <= 1e-12) return "0";
  return Number(value.toPrecision(12)).toString();
}

export function homographyToCssMatrix3d(input: QuadProjection): string | null {
  const { width, height } = input.sourceSize;
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) return null;

  const source: SceneQuad = [[0, 0], [width, 0], [width, height], [0, height]];
  const values = solveHomography(source, input.destination);
  if (!values) return null;

  const [h11, h12, h13, h21, h22, h23, h31, h32, h33] = values;
  return `matrix3d(${[
    h11, h21, 0, h31,
    h12, h22, 0, h32,
    0, 0, 1, 0,
    h13, h23, 0, h33,
  ].map(formatMatrixValue).join(", ")})`;
}

export function relativeQuadToPixels(quad: SceneQuad, sourceSize: SceneSize): SceneQuad {
  return quad.map(([x, y]) => [x * sourceSize.width, y * sourceSize.height] as ScenePoint) as unknown as SceneQuad;
}

export function relativeQuadToCssMatrix3d(sourceSize: SceneSize, relativeDestination: SceneQuad): string | null {
  return homographyToCssMatrix3d({
    sourceSize,
    destination: relativeQuadToPixels(relativeDestination, sourceSize),
  });
}
