import type { CSSProperties } from "react";
import notebookSurfaceData from "./notebook-surfaces.json";
import reviewSurfaceData from "./review-surfaces.json";
import searchSurfaceData from "./search-surfaces.json";
import studySurfaceData from "./study-surfaces.json";
import {
  isConvexSceneQuad,
  SCENE_COORDINATE_SPACE_ID,
  SCENE_WORLD,
  type ScenePoint,
  type SceneQuad,
  type SceneRect,
} from "./scene-geometry";

export type SceneContentInsets = {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
};

export type SceneSurfaceRegistration = {
  readonly id: string;
  readonly coordinateSpace: typeof SCENE_COORDINATE_SPACE_ID;
  readonly strategy: "homography";
  readonly sourceRect: SceneRect;
  readonly quad: SceneQuad;
  readonly clipPolygon: SceneQuad;
  readonly contentInsets: SceneContentInsets;
  readonly assetRevision: string;
  readonly calibrationRevision: string;
};

export type SceneSurfaceRegistryMetadata = {
  readonly schemaVersion: number;
  readonly coordinateSpace: {
    readonly id: typeof SCENE_COORDINATE_SPACE_ID;
    readonly width: typeof SCENE_WORLD.width;
    readonly height: typeof SCENE_WORLD.height;
    readonly fitMode: "cover";
  };
  readonly compactMediaQuery: string;
  readonly assetRevision: string;
  readonly assetHashes: Readonly<Record<string, string>>;
  readonly calibrationRevision: string;
};

export type SceneRectStyle = CSSProperties & {
  readonly "--scene-rect-left": string;
  readonly "--scene-rect-top": string;
  readonly "--scene-rect-width": string;
  readonly "--scene-rect-height": string;
};

export type SceneSurfaceStyle = SceneRectStyle & {
  readonly "--scene-surface-clip": string;
  readonly "--scene-content-top": string;
  readonly "--scene-content-right": string;
  readonly "--scene-content-bottom": string;
  readonly "--scene-content-left": string;
};

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function parseSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest.`);
  }
  return value.toLowerCase();
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be present.`);
  return value;
}

function parsePoint(value: unknown, label: string): ScenePoint {
  if (!Array.isArray(value) || value.length !== 2) throw new Error(`${label} must contain x and y.`);
  return [finiteNumber(value[0], `${label}.x`), finiteNumber(value[1], `${label}.y`)];
}

function parseQuad(value: unknown, label: string): SceneQuad {
  if (!Array.isArray(value) || value.length !== 4) throw new Error(`${label} must contain four ordered points.`);
  const quad = value.map((point, index) => parsePoint(point, `${label}[${index}]`)) as unknown as SceneQuad;
  if (!isConvexSceneQuad(quad)) throw new Error(`${label} must be a non-self-intersecting convex quad.`);
  return Object.freeze(quad);
}

function parseRect(value: unknown, label: string): SceneRect {
  if (!value || typeof value !== "object") throw new Error(`${label} must be a rectangle.`);
  const input = value as Record<string, unknown>;
  const rect = {
    x: finiteNumber(input.x, `${label}.x`),
    y: finiteNumber(input.y, `${label}.y`),
    width: finiteNumber(input.width, `${label}.width`),
    height: finiteNumber(input.height, `${label}.height`),
  };
  if (rect.width <= 0 || rect.height <= 0) throw new Error(`${label} must have positive dimensions.`);
  return Object.freeze(rect);
}

function parseInsets(value: unknown, label: string): SceneContentInsets {
  if (!value || typeof value !== "object") throw new Error(`${label} must define four insets.`);
  const input = value as Record<string, unknown>;
  const insets = {
    top: finiteNumber(input.top, `${label}.top`),
    right: finiteNumber(input.right, `${label}.right`),
    bottom: finiteNumber(input.bottom, `${label}.bottom`),
    left: finiteNumber(input.left, `${label}.left`),
  };
  if (Object.values(insets).some((inset) => inset < 0 || inset >= 1)) {
    throw new Error(`${label} values must be normalized to [0, 1).`);
  }
  return Object.freeze(insets);
}

function parseRegistryMetadata(value: unknown, label: string): SceneSurfaceRegistryMetadata {
  if (!value || typeof value !== "object") throw new Error(`${label} must be a surface registry.`);
  const input = value as Record<string, unknown>;
  const coordinateSpace = input.coordinateSpace as Record<string, unknown> | undefined;
  if (
    coordinateSpace?.id !== SCENE_COORDINATE_SPACE_ID
    || coordinateSpace.width !== SCENE_WORLD.width
    || coordinateSpace.height !== SCENE_WORLD.height
    || coordinateSpace.fitMode !== "cover"
  ) {
    throw new Error(`${label} surface registry does not match the canonical room coordinate space.`);
  }
  const schemaVersion = finiteNumber(input.schemaVersion, `${label}.schemaVersion`);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error(`${label}.schemaVersion must be a positive integer.`);
  }
  if (!input.assetHashes || typeof input.assetHashes !== "object" || Array.isArray(input.assetHashes)) {
    throw new Error(`${label}.assetHashes must be an object.`);
  }
  const assetHashes = Object.fromEntries(
    Object.entries(input.assetHashes as Record<string, unknown>)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, digest]) => [key, parseSha256(digest, `${label}.assetHashes.${key}`)]),
  );
  if (!Object.keys(assetHashes).length) throw new Error(`${label}.assetHashes must not be empty.`);

  return Object.freeze({
    schemaVersion,
    coordinateSpace: Object.freeze({
      id: SCENE_COORDINATE_SPACE_ID,
      width: SCENE_WORLD.width,
      height: SCENE_WORLD.height,
      fitMode: "cover" as const,
    }),
    compactMediaQuery: nonEmptyString(input.compactMediaQuery, `${label}.compactMediaQuery`),
    assetRevision: nonEmptyString(input.assetRevision, `${label}.assetRevision`),
    assetHashes: Object.freeze(assetHashes),
    calibrationRevision: nonEmptyString(input.calibrationRevision, `${label}.calibrationRevision`),
  });
}

function parseSurface(
  value: unknown,
  label: string,
  metadata: Pick<SceneSurfaceRegistryMetadata, "assetRevision" | "calibrationRevision">,
): SceneSurfaceRegistration {
  if (!value || typeof value !== "object") throw new Error(`${label} must be a surface registration.`);
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || !input.id) throw new Error(`${label}.id must be present.`);
  if (input.strategy !== "homography") throw new Error(`${label}.strategy must be homography.`);

  return Object.freeze({
    id: input.id,
    coordinateSpace: SCENE_COORDINATE_SPACE_ID,
    strategy: "homography",
    sourceRect: parseRect(input.sourceRect, `${label}.sourceRect`),
    quad: parseQuad(input.quad, `${label}.quad`),
    clipPolygon: parseQuad(input.clipPolygon, `${label}.clipPolygon`),
    contentInsets: parseInsets(input.contentInsets, `${label}.contentInsets`),
    assetRevision: metadata.assetRevision,
    calibrationRevision: metadata.calibrationRevision,
  });
}

const reviewMetadata = parseRegistryMetadata(reviewSurfaceData, "review");
const notebookBounds = parseRect(reviewSurfaceData.notebookBounds, "review.notebookBounds");
const tapeBounds = parseRect(reviewSurfaceData.tapeBounds, "review.tapeBounds");
const tapeHeader = parseSurface(reviewSurfaceData.surfaces.tapeHeader, "review.surfaces.tapeHeader", reviewMetadata);
const tapeBody = parseSurface(reviewSurfaceData.surfaces.tapeBody, "review.surfaces.tapeBody", reviewMetadata);
const tapeFooter = parseSurface(reviewSurfaceData.surfaces.tapeFooter, "review.surfaces.tapeFooter", reviewMetadata);
const notebookLeft = parseSurface(reviewSurfaceData.surfaces.notebookLeft, "review.surfaces.notebookLeft", reviewMetadata);
const notebookRight = parseSurface(reviewSurfaceData.surfaces.notebookRight, "review.surfaces.notebookRight", reviewMetadata);

export const REVIEW_SURFACE_REGISTRY = Object.freeze({
  ...reviewMetadata,
  tapeBounds,
  notebookBounds,
  surfaces: Object.freeze({ tapeHeader, tapeBody, tapeFooter, notebookLeft, notebookRight }),
});

const studyMetadata = parseRegistryMetadata(studySurfaceData, "study");
const studyNotebookBounds = parseRect(studySurfaceData.notebookBounds, "study.notebookBounds");
const studyNotebookLeft = parseSurface(
  studySurfaceData.surfaces.notebookLeft,
  "study.surfaces.notebookLeft",
  studyMetadata,
);
const studyNotebookRight = parseSurface(
  studySurfaceData.surfaces.notebookRight,
  "study.surfaces.notebookRight",
  studyMetadata,
);
const studySourceSlip = parseSurface(
  studySurfaceData.surfaces.sourceSlip,
  "study.surfaces.sourceSlip",
  studyMetadata,
);

export const STUDY_SURFACE_REGISTRY = Object.freeze({
  ...studyMetadata,
  notebookBounds: studyNotebookBounds,
  surfaces: Object.freeze({
    notebookLeft: studyNotebookLeft,
    notebookRight: studyNotebookRight,
    sourceSlip: studySourceSlip,
  }),
});

const notebookMetadata = parseRegistryMetadata(notebookSurfaceData, "notebook");
const notebookEditorBounds = parseRect(notebookSurfaceData.notebookBounds, "notebook.notebookBounds");
const notebookEditorPage = parseSurface(
  notebookSurfaceData.surfaces.editorPage,
  "notebook.surfaces.editorPage",
  notebookMetadata,
);
const notebookActionPage = parseSurface(
  notebookSurfaceData.surfaces.actionPage,
  "notebook.surfaces.actionPage",
  notebookMetadata,
);
const notebookSourceSlip = parseSurface(
  notebookSurfaceData.surfaces.sourceSlip,
  "notebook.surfaces.sourceSlip",
  notebookMetadata,
);

export const NOTEBOOK_SURFACE_REGISTRY = Object.freeze({
  ...notebookMetadata,
  notebookBounds: notebookEditorBounds,
  surfaces: Object.freeze({
    editorPage: notebookEditorPage,
    actionPage: notebookActionPage,
    sourceSlip: notebookSourceSlip,
  }),
});

const searchMetadata = parseRegistryMetadata(searchSurfaceData, "search");
const searchCatalogBounds = parseRect(searchSurfaceData.catalogBounds, "search.catalogBounds");
const searchQueryLedger = parseSurface(
  searchSurfaceData.surfaces.queryLedger,
  "search.surfaces.queryLedger",
  searchMetadata,
);
const searchUpperShelf = parseSurface(
  searchSurfaceData.surfaces.upperShelf,
  "search.surfaces.upperShelf",
  searchMetadata,
);
const searchLowerShelf = parseSurface(
  searchSurfaceData.surfaces.lowerShelf,
  "search.surfaces.lowerShelf",
  searchMetadata,
);
const searchBoundarySlip = parseSurface(
  searchSurfaceData.surfaces.boundarySlip,
  "search.surfaces.boundarySlip",
  searchMetadata,
);

export const SEARCH_SURFACE_REGISTRY = Object.freeze({
  ...searchMetadata,
  catalogBounds: searchCatalogBounds,
  surfaces: Object.freeze({
    queryLedger: searchQueryLedger,
    upperShelf: searchUpperShelf,
    lowerShelf: searchLowerShelf,
    boundarySlip: searchBoundarySlip,
  }),
});

function percentage(value: number): string {
  return `${Number((value * 100).toFixed(6))}%`;
}

export function sceneRectStyle(rect: SceneRect, container: SceneRect): SceneRectStyle {
  return Object.freeze({
    "--scene-rect-left": percentage((rect.x - container.x) / container.width),
    "--scene-rect-top": percentage((rect.y - container.y) / container.height),
    "--scene-rect-width": percentage(rect.width / container.width),
    "--scene-rect-height": percentage(rect.height / container.height),
  }) as SceneRectStyle;
}

export function surfaceLocalQuad(
  surface: SceneSurfaceRegistration,
  worldQuad: SceneQuad = surface.quad,
): SceneQuad {
  const { sourceRect } = surface;
  const quad = worldQuad.map(([x, y]) => [
    (x - sourceRect.x) / sourceRect.width,
    (y - sourceRect.y) / sourceRect.height,
  ] as ScenePoint) as unknown as SceneQuad;
  if (!isConvexSceneQuad(quad)) throw new Error(`${surface.id} resolves to an invalid local quad.`);
  return quad;
}

function clipPolygonCss(quad: SceneQuad): string {
  return `polygon(${quad.map(([x, y]) => `${percentage(x)} ${percentage(y)}`).join(", ")})`;
}

export function surfaceStyle(surface: SceneSurfaceRegistration, container: SceneRect): SceneSurfaceStyle {
  return Object.freeze({
    ...sceneRectStyle(surface.sourceRect, container),
    "--scene-surface-clip": clipPolygonCss(surface.clipPolygon),
    "--scene-content-top": percentage(surface.contentInsets.top),
    "--scene-content-right": percentage(surface.contentInsets.right),
    "--scene-content-bottom": percentage(surface.contentInsets.bottom),
    "--scene-content-left": percentage(surface.contentInsets.left),
  }) as SceneSurfaceStyle;
}

const worldRect: SceneRect = Object.freeze({ x: 0, y: 0, width: SCENE_WORLD.width, height: SCENE_WORLD.height });

export const REVIEW_TAPE_STYLE = sceneRectStyle(REVIEW_SURFACE_REGISTRY.tapeBounds, worldRect);
export const REVIEW_NOTEBOOK_STYLE = sceneRectStyle(REVIEW_SURFACE_REGISTRY.notebookBounds, worldRect);
export const REVIEW_SURFACE_STYLES = Object.freeze({
  tapeHeader: surfaceStyle(REVIEW_SURFACE_REGISTRY.surfaces.tapeHeader, REVIEW_SURFACE_REGISTRY.tapeBounds),
  tapeBody: surfaceStyle(REVIEW_SURFACE_REGISTRY.surfaces.tapeBody, REVIEW_SURFACE_REGISTRY.tapeBounds),
  tapeFooter: surfaceStyle(REVIEW_SURFACE_REGISTRY.surfaces.tapeFooter, REVIEW_SURFACE_REGISTRY.tapeBounds),
  notebookLeft: surfaceStyle(REVIEW_SURFACE_REGISTRY.surfaces.notebookLeft, REVIEW_SURFACE_REGISTRY.notebookBounds),
  notebookRight: surfaceStyle(REVIEW_SURFACE_REGISTRY.surfaces.notebookRight, REVIEW_SURFACE_REGISTRY.notebookBounds),
});

export const STUDY_NOTEBOOK_STYLE = sceneRectStyle(STUDY_SURFACE_REGISTRY.notebookBounds, worldRect);
export const STUDY_SURFACE_STYLES = Object.freeze({
  notebookLeft: surfaceStyle(STUDY_SURFACE_REGISTRY.surfaces.notebookLeft, STUDY_SURFACE_REGISTRY.notebookBounds),
  notebookRight: surfaceStyle(STUDY_SURFACE_REGISTRY.surfaces.notebookRight, STUDY_SURFACE_REGISTRY.notebookBounds),
  sourceSlip: surfaceStyle(STUDY_SURFACE_REGISTRY.surfaces.sourceSlip, STUDY_SURFACE_REGISTRY.notebookBounds),
});

export const NOTEBOOK_OBJECT_STYLE = sceneRectStyle(NOTEBOOK_SURFACE_REGISTRY.notebookBounds, worldRect);
export const NOTEBOOK_SURFACE_STYLES = Object.freeze({
  editorPage: surfaceStyle(NOTEBOOK_SURFACE_REGISTRY.surfaces.editorPage, NOTEBOOK_SURFACE_REGISTRY.notebookBounds),
  actionPage: surfaceStyle(NOTEBOOK_SURFACE_REGISTRY.surfaces.actionPage, NOTEBOOK_SURFACE_REGISTRY.notebookBounds),
  sourceSlip: surfaceStyle(NOTEBOOK_SURFACE_REGISTRY.surfaces.sourceSlip, NOTEBOOK_SURFACE_REGISTRY.notebookBounds),
});

export const SEARCH_CATALOG_STYLE = sceneRectStyle(SEARCH_SURFACE_REGISTRY.catalogBounds, worldRect);
export const SEARCH_SURFACE_STYLES = Object.freeze({
  queryLedger: surfaceStyle(SEARCH_SURFACE_REGISTRY.surfaces.queryLedger, SEARCH_SURFACE_REGISTRY.catalogBounds),
  upperShelf: surfaceStyle(SEARCH_SURFACE_REGISTRY.surfaces.upperShelf, SEARCH_SURFACE_REGISTRY.catalogBounds),
  lowerShelf: surfaceStyle(SEARCH_SURFACE_REGISTRY.surfaces.lowerShelf, SEARCH_SURFACE_REGISTRY.catalogBounds),
  boundarySlip: surfaceStyle(SEARCH_SURFACE_REGISTRY.surfaces.boundarySlip, SEARCH_SURFACE_REGISTRY.catalogBounds),
});
