import {
  isConvexSceneQuad,
  sceneQuadArea,
  SCENE_COORDINATE_SPACE_ID,
  SCENE_WORLD,
  type ScenePoint,
  type SceneQuad,
  type SceneRect,
} from "./scene-geometry";
import type {
  SceneContentInsets,
  SceneSurfaceRegistryMetadata,
  SceneSurfaceRegistration,
} from "./scene-surfaces";

const CALIBRATION_ARTIFACT_VERSION = 1;
const MINIMUM_CALIBRATION_QUAD_AREA = 16;
const MAX_CALIBRATION_ARTIFACT_BYTES = 1_000_000;

export type SurfaceQuadMap = Readonly<Record<string, SceneQuad>>;

export type SurfaceCalibrationMode = Readonly<{
  readonly theme: "day" | "night";
  readonly renderer: "poster" | "canvas";
  readonly motion: "full" | "off";
}>;

export type SurfaceCalibrationArtifactSurface = Readonly<{
  readonly id: string;
  readonly strategy: "homography";
  readonly sourceRect: SceneRect;
  readonly quad: SceneQuad;
  readonly clipPolygon: SceneQuad;
  readonly contentInsets: SceneContentInsets;
}>;

export type SurfaceCalibrationArtifact = Readonly<{
  readonly artifactVersion: typeof CALIBRATION_ARTIFACT_VERSION;
  readonly schemaVersion: number;
  readonly coordinateSpace: SceneSurfaceRegistryMetadata["coordinateSpace"];
  readonly assetRevision: string;
  readonly assetHashes: Readonly<Record<string, string>>;
  readonly baseCalibrationRevision: string;
  readonly calibrationMode: SurfaceCalibrationMode;
  readonly surfaces: readonly SurfaceCalibrationArtifactSurface[];
}>;

export type SurfaceCalibrationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type SurfaceCalibrationValidation = Readonly<{
  readonly status: "valid" | "stale" | "invalid";
  readonly message: string;
  readonly artifact?: SurfaceCalibrationArtifact;
  readonly overrides?: SurfaceQuadMap;
}>;

export type SurfaceCalibrationReadResult = Readonly<
  | { readonly status: "missing" | "unavailable"; readonly message: string }
  | SurfaceCalibrationValidation
>;

export type SurfaceCalibrationWriteResult = Readonly<{
  readonly status: "written" | "unavailable" | "failed";
  readonly message: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be present.`);
  return value;
}

function parsePoint(value: unknown, label: string): ScenePoint {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label} must contain x and y.`);
  return [finiteNumber(value[0], `${label}.x`), finiteNumber(value[1], `${label}.y`)];
}

function cloneQuad(quad: SceneQuad): SceneQuad {
  return Object.freeze(quad.map(([x, y]) => Object.freeze([x, y] as ScenePoint)) as unknown as SceneQuad);
}

function parseQuad(
  value: unknown,
  label: string,
  enforceWorldBounds = false,
  minimumArea = MINIMUM_CALIBRATION_QUAD_AREA,
): SceneQuad {
  if (!Array.isArray(value) || value.length !== 4) throw new Error(`${label} must contain four ordered points.`);
  const quad = value.map((point, index) => parsePoint(point, `${label}[${index}]`)) as unknown as SceneQuad;
  if (!isConvexSceneQuad(quad, minimumArea) || sceneQuadArea(quad) < minimumArea) {
    throw new Error(`${label} must be a convex quad with area at least ${minimumArea}.`);
  }
  if (enforceWorldBounds && quad.some(([x, y]) => x < 0 || x > SCENE_WORLD.width || y < 0 || y > SCENE_WORLD.height)) {
    throw new Error(`${label} must stay inside the canonical world bounds.`);
  }
  return cloneQuad(quad);
}

function parseRect(value: unknown, label: string): SceneRect {
  if (!isRecord(value)) throw new Error(`${label} must be a rectangle.`);
  const rect = {
    x: finiteNumber(value.x, `${label}.x`),
    y: finiteNumber(value.y, `${label}.y`),
    width: finiteNumber(value.width, `${label}.width`),
    height: finiteNumber(value.height, `${label}.height`),
  };
  if (rect.width <= 0 || rect.height <= 0) throw new Error(`${label} must have positive dimensions.`);
  return Object.freeze(rect);
}

function parseInsets(value: unknown, label: string): SceneContentInsets {
  if (!isRecord(value)) throw new Error(`${label} must define four normalized insets.`);
  const insets = {
    top: finiteNumber(value.top, `${label}.top`),
    right: finiteNumber(value.right, `${label}.right`),
    bottom: finiteNumber(value.bottom, `${label}.bottom`),
    left: finiteNumber(value.left, `${label}.left`),
  };
  if (Object.values(insets).some((inset) => inset < 0 || inset >= 1)) {
    throw new Error(`${label} values must be normalized to [0, 1).`);
  }
  return Object.freeze(insets);
}

function parseAssetHashes(value: unknown, label: string): Readonly<Record<string, string>> {
  if (!isRecord(value) || !Object.keys(value).length) throw new Error(`${label} must be a non-empty object.`);
  const hashes = Object.fromEntries(
    Object.entries(value)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, digest]) => {
        if (!key.trim() || typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest)) {
          throw new Error(`${label}.${key} must be a SHA-256 digest.`);
        }
        return [key, digest.toLowerCase()];
      }),
  );
  return Object.freeze(hashes);
}

function parseCoordinateSpace(value: unknown): SceneSurfaceRegistryMetadata["coordinateSpace"] {
  if (!isRecord(value)
    || value.id !== SCENE_COORDINATE_SPACE_ID
    || value.width !== SCENE_WORLD.width
    || value.height !== SCENE_WORLD.height
    || value.fitMode !== "cover") {
    throw new Error("artifact coordinateSpace does not match the canonical room world.");
  }
  return Object.freeze({
    id: SCENE_COORDINATE_SPACE_ID,
    width: SCENE_WORLD.width,
    height: SCENE_WORLD.height,
    fitMode: "cover" as const,
  });
}

function parseMode(value: unknown): SurfaceCalibrationMode {
  if (!isRecord(value)
    || (value.theme !== "day" && value.theme !== "night")
    || (value.renderer !== "poster" && value.renderer !== "canvas")
    || (value.motion !== "full" && value.motion !== "off")) {
    throw new Error("artifact calibrationMode is invalid.");
  }
  return Object.freeze({
    theme: value.theme,
    renderer: value.renderer,
    motion: value.motion,
  });
}

function parseArtifactSurface(value: unknown, index: number): SurfaceCalibrationArtifactSurface {
  const label = `surfaces[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return Object.freeze({
    id: nonEmptyString(value.id, `${label}.id`),
    strategy: value.strategy === "homography" ? "homography" : (() => { throw new Error(`${label}.strategy must be homography.`); })(),
    sourceRect: parseRect(value.sourceRect, `${label}.sourceRect`),
    quad: parseQuad(value.quad, `${label}.quad`, true),
    clipPolygon: parseQuad(value.clipPolygon, `${label}.clipPolygon`, false, 1e-8),
    contentInsets: parseInsets(value.contentInsets, `${label}.contentInsets`),
  });
}

function parseArtifactValue(value: unknown): SurfaceCalibrationArtifact {
  if (!isRecord(value)) throw new Error("calibration artifact must be an object.");
  if (value.artifactVersion !== CALIBRATION_ARTIFACT_VERSION) {
    throw new Error(`unsupported calibration artifact version: ${String(value.artifactVersion)}`);
  }
  const rawSurfaces = value.surfaces;
  if (!Array.isArray(rawSurfaces) || !rawSurfaces.length) throw new Error("artifact surfaces must be non-empty.");
  const surfaces = rawSurfaces.map(parseArtifactSurface);
  const ids = new Set<string>();
  for (const surface of surfaces) {
    if (ids.has(surface.id)) throw new Error(`artifact contains duplicate Surface: ${surface.id}`);
    ids.add(surface.id);
  }

  return Object.freeze({
    artifactVersion: CALIBRATION_ARTIFACT_VERSION,
    schemaVersion: positiveInteger(value.schemaVersion, "artifact.schemaVersion"),
    coordinateSpace: parseCoordinateSpace(value.coordinateSpace),
    assetRevision: nonEmptyString(value.assetRevision, "artifact.assetRevision"),
    assetHashes: parseAssetHashes(value.assetHashes, "artifact.assetHashes"),
    baseCalibrationRevision: nonEmptyString(value.baseCalibrationRevision, "artifact.baseCalibrationRevision"),
    calibrationMode: parseMode(value.calibrationMode),
    surfaces: Object.freeze(surfaces),
  });
}

function sameRecord(first: Readonly<Record<string, string>>, second: Readonly<Record<string, string>>): boolean {
  const firstEntries = Object.entries(first).sort(([left], [right]) => left.localeCompare(right));
  const secondEntries = Object.entries(second).sort(([left], [right]) => left.localeCompare(right));
  return firstEntries.length === secondEntries.length
    && firstEntries.every(([key, value], index) => key === secondEntries[index]?.[0] && value === secondEntries[index]?.[1]);
}

function sameCoordinateSpace(
  first: SurfaceCalibrationArtifact["coordinateSpace"],
  second: SurfaceCalibrationArtifact["coordinateSpace"],
): boolean {
  return first.id === second.id
    && first.width === second.width
    && first.height === second.height
    && first.fitMode === second.fitMode;
}

function invalid(message: string, artifact?: SurfaceCalibrationArtifact): SurfaceCalibrationValidation {
  return Object.freeze({ status: "invalid" as const, message, ...(artifact ? { artifact } : {}) });
}

export function createSurfaceCalibrationArtifact(
  registry: SceneSurfaceRegistryMetadata,
  surfaces: readonly SceneSurfaceRegistration[],
  quads: SurfaceQuadMap,
  mode: SurfaceCalibrationMode,
): SurfaceCalibrationArtifact {
  const orderedSurfaces = [...surfaces].sort((first, second) => first.id.localeCompare(second.id));
  return Object.freeze({
    artifactVersion: CALIBRATION_ARTIFACT_VERSION,
    schemaVersion: registry.schemaVersion,
    coordinateSpace: registry.coordinateSpace,
    assetRevision: registry.assetRevision,
    assetHashes: Object.freeze(Object.fromEntries(
      Object.entries(registry.assetHashes).sort(([first], [second]) => first.localeCompare(second)),
    )),
    baseCalibrationRevision: registry.calibrationRevision,
    calibrationMode: Object.freeze({ ...mode }),
    surfaces: Object.freeze(orderedSurfaces.map((surface) => Object.freeze({
      id: surface.id,
      strategy: surface.strategy,
      sourceRect: Object.freeze({ ...surface.sourceRect }),
      quad: cloneQuad(quads[surface.id] ?? surface.quad),
      clipPolygon: cloneQuad(surface.clipPolygon),
      contentInsets: Object.freeze({ ...surface.contentInsets }),
    }))),
  });
}

export function serializeSurfaceCalibrationArtifact(artifact: SurfaceCalibrationArtifact): string {
  return JSON.stringify(artifact, null, 2);
}

export function parseSurfaceCalibrationArtifact(raw: string):
  | Readonly<{ status: "valid"; artifact: SurfaceCalibrationArtifact }>
  | Readonly<{ status: "invalid"; message: string }> {
  if (typeof raw !== "string" || raw.length > MAX_CALIBRATION_ARTIFACT_BYTES) {
    return Object.freeze({ status: "invalid" as const, message: "校准 artifact 超过允许大小。" });
  }
  try {
    return Object.freeze({ status: "valid" as const, artifact: parseArtifactValue(JSON.parse(raw)) });
  } catch (error) {
    return Object.freeze({
      status: "invalid" as const,
      message: error instanceof Error ? error.message : "校准 artifact 无法解析。",
    });
  }
}

export function validateSurfaceCalibrationArtifact(
  artifact: SurfaceCalibrationArtifact,
  registry: SceneSurfaceRegistryMetadata,
  surfaces: readonly SceneSurfaceRegistration[],
): SurfaceCalibrationValidation {
  if (artifact.schemaVersion !== registry.schemaVersion) {
    return Object.freeze({ status: "stale", message: "校准 schema 已变化，请重新校准。", artifact });
  }
  if (!sameCoordinateSpace(artifact.coordinateSpace, registry.coordinateSpace)) {
    return Object.freeze({ status: "stale", message: "校准使用了不同的世界坐标空间，已忽略。", artifact });
  }
  if (artifact.assetRevision !== registry.assetRevision || artifact.baseCalibrationRevision !== registry.calibrationRevision) {
    return Object.freeze({ status: "stale", message: "关联资产或基础校准版本已变化，已忽略旧校准。", artifact });
  }
  if (!sameRecord(artifact.assetHashes, registry.assetHashes)) {
    return Object.freeze({ status: "stale", message: "关联资产 hash 已变化，已忽略旧校准。", artifact });
  }

  const expectedIds = [...surfaces].map((surface) => surface.id).sort();
  const actualIds = artifact.surfaces.map((surface) => surface.id).sort();
  if (expectedIds.length !== actualIds.length || expectedIds.some((id, index) => id !== actualIds[index])) {
    return invalid("校准 artifact 的 Surface 集合与当前 registry 不一致。", artifact);
  }

  const overrides = Object.fromEntries(artifact.surfaces.map((surface) => [surface.id, surface.quad]));
  return Object.freeze({
    status: "valid" as const,
    message: "校准 artifact 与当前 registry 匹配。",
    artifact,
    overrides: Object.freeze(overrides),
  });
}

export function surfaceCalibrationStorageKey(
  registry: SceneSurfaceRegistryMetadata,
  surfaces: readonly SceneSurfaceRegistration[],
): string {
  const ids = [...surfaces].map((surface) => surface.id).sort().join("|");
  return `ailearn:surface-calibration:v${CALIBRATION_ARTIFACT_VERSION}:${registry.coordinateSpace.id}:${ids}`;
}

export function getSessionSurfaceCalibrationStorage(): SurfaceCalibrationStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function readStoredSurfaceCalibration(
  storage: SurfaceCalibrationStorage | undefined,
  key: string,
  registry: SceneSurfaceRegistryMetadata,
  surfaces: readonly SceneSurfaceRegistration[],
): SurfaceCalibrationReadResult {
  if (!storage) return Object.freeze({ status: "unavailable" as const, message: "当前环境不提供开发会话存储。" });
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return Object.freeze({ status: "unavailable" as const, message: "无法读取开发会话校准。" });
  }
  if (raw === null) return Object.freeze({ status: "missing" as const, message: "当前开发会话没有已保存校准。" });
  const parsed = parseSurfaceCalibrationArtifact(raw);
  if (parsed.status === "invalid") return parsed;
  return validateSurfaceCalibrationArtifact(parsed.artifact, registry, surfaces);
}

export function writeStoredSurfaceCalibration(
  storage: SurfaceCalibrationStorage | undefined,
  key: string,
  artifact: SurfaceCalibrationArtifact,
): SurfaceCalibrationWriteResult {
  if (!storage) return Object.freeze({ status: "unavailable" as const, message: "当前环境不提供开发会话存储。" });
  try {
    storage.setItem(key, serializeSurfaceCalibrationArtifact(artifact));
    return Object.freeze({ status: "written" as const, message: "校准已写入当前开发会话。" });
  } catch {
    return Object.freeze({ status: "failed" as const, message: "校准已应用到当前预览，但开发会话写回失败。" });
  }
}

export function clearStoredSurfaceCalibration(
  storage: SurfaceCalibrationStorage | undefined,
  key: string,
): SurfaceCalibrationWriteResult {
  if (!storage) return Object.freeze({ status: "unavailable" as const, message: "当前环境不提供开发会话存储。" });
  try {
    storage.removeItem(key);
    return Object.freeze({ status: "written" as const, message: "已清除当前开发会话的校准。" });
  } catch {
    return Object.freeze({ status: "failed" as const, message: "无法清除当前开发会话的校准。" });
  }
}
