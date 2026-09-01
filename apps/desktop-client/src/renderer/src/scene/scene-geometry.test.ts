import { describe, expect, it } from "vitest";
import {
  applyHomography,
  computeStageMatrix,
  homographyToCssMatrix3d,
  isConvexSceneQuad,
  isRoomSceneLayerRegistrationWithinWorld,
  projectWorldPoint,
  resolveRoomSceneLayerRegistrationRect,
  solveHomography,
  unprojectScreenPoint,
  type SceneQuad,
} from "./scene-geometry";
import {
  NOTEBOOK_SURFACE_REGISTRY,
  NOTEBOOK_SURFACE_STYLES,
  REVIEW_SURFACE_REGISTRY,
  SEARCH_SURFACE_REGISTRY,
  SEARCH_SURFACE_STYLES,
  STUDY_SURFACE_REGISTRY,
  STUDY_SURFACE_STYLES,
  surfaceLocalQuad,
} from "./scene-surfaces";

describe("computeStageMatrix", () => {
  it("uses one centered cover matrix for the 1672×941 room world", () => {
    const matrix = computeStageMatrix(1024, 700);

    expect(matrix.scale).toBeCloseTo(0.7438894793, 9);
    expect(matrix.renderedWidth).toBeCloseTo(1243.783209, 6);
    expect(matrix.renderedHeight).toBeCloseTo(700, 9);
    expect(matrix.offsetX).toBeCloseTo(-109.891605, 6);
    expect(matrix.offsetY).toBeCloseTo(0, 9);
  });

  it("supports contain without creating a second coordinate space", () => {
    const matrix = computeStageMatrix(1024, 700, "contain");

    expect(matrix.scale).toBeCloseTo(1024 / 1672, 9);
    expect(matrix.offsetX).toBeCloseTo(0, 9);
    expect(matrix.offsetY).toBeGreaterThan(0);
  });

  it("round-trips world points through the stage matrix", () => {
    const matrix = computeStageMatrix(1440, 810);
    const worldPoint = [611.818, 673.45] as const;

    expect(unprojectScreenPoint(projectWorldPoint(worldPoint, matrix), matrix)).toEqual([
      expect.closeTo(worldPoint[0], 9),
      expect.closeTo(worldPoint[1], 9),
    ]);
  });

  it("rejects non-positive viewport dimensions", () => {
    expect(() => computeStageMatrix(0, 700)).toThrow(RangeError);
    expect(() => computeStageMatrix(1024, Number.NaN)).toThrow(RangeError);
  });
});

describe("Room layer registration geometry", () => {
  it("resolves a sprite registration around its normalized anchor", () => {
    expect(resolveRoomSceneLayerRegistrationRect(
      [100, 80],
      { width: 40, height: 20 },
      [0.5, 0.25],
    )).toEqual({ x: 80, y: 75, width: 40, height: 20 });
  });

  it("allows only the explicit two-pixel world-edge bleed", () => {
    expect(isRoomSceneLayerRegistrationWithinWorld(
      [0, 0],
      { width: 1674, height: 943 },
      [0, 0],
    )).toBe(true);
    expect(isRoomSceneLayerRegistrationWithinWorld(
      [-3, 0],
      { width: 40, height: 20 },
      [0, 0],
    )).toBe(false);
    expect(isRoomSceneLayerRegistrationWithinWorld(
      [0, 0],
      { width: 40, height: 20 },
      [1.1, 0],
    )).toBe(false);
  });
});

describe("homography", () => {
  const source: SceneQuad = [[0, 0], [200, 0], [200, 100], [0, 100]];
  const destination: SceneQuad = [[5, 8], [192, -4], [205, 104], [-3, 96]];

  it("maps every source corner onto its registered destination corner", () => {
    const homography = solveHomography(source, destination);
    expect(homography).not.toBeNull();

    source.forEach((point, index) => {
      const projected = applyHomography(point, homography!);
      expect(projected?.[0]).toBeCloseTo(destination[index][0], 7);
      expect(projected?.[1]).toBeCloseTo(destination[index][1], 7);
    });
  });

  it("emits a finite CSS matrix3d", () => {
    const matrix = homographyToCssMatrix3d({ sourceSize: { width: 200, height: 100 }, destination });

    expect(matrix).toMatch(/^matrix3d\(/);
    expect(matrix).not.toMatch(/NaN|Infinity/);
  });

  it("rejects collapsed and self-intersecting quads", () => {
    const collapsed: SceneQuad = [[0, 0], [1, 0], [2, 0], [0, 0]];
    const bowTie: SceneQuad = [[0, 0], [1, 1], [1, 0], [0, 1]];

    expect(isConvexSceneQuad(collapsed)).toBe(false);
    expect(isConvexSceneQuad(bowTie)).toBe(false);
    expect(solveHomography(source, bowTie)).toBeNull();
  });
});

describe("Review SurfaceRegistry", () => {
  it("keeps all five Review surfaces in the canonical room coordinate space", () => {
    expect(REVIEW_SURFACE_REGISTRY.coordinateSpace).toMatchObject({
      id: "room-1672x941",
      width: 1672,
      height: 941,
      fitMode: "cover",
    });
    expect(Object.keys(REVIEW_SURFACE_REGISTRY.surfaces)).toEqual([
      "tapeHeader",
      "tapeBody",
      "tapeFooter",
      "notebookLeft",
      "notebookRight",
    ]);
    expect(REVIEW_SURFACE_REGISTRY.assetHashes.day).toHaveLength(64);
    expect(REVIEW_SURFACE_REGISTRY.assetHashes.night).toHaveLength(64);

    for (const surface of Object.values(REVIEW_SURFACE_REGISTRY.surfaces)) {
      expect(surface.coordinateSpace).toBe("room-1672x941");
      expect(isConvexSceneQuad(surface.quad)).toBe(true);
      expect(isConvexSceneQuad(surfaceLocalQuad(surface))).toBe(true);
    }
  });

  it("preserves the measured left-page rise toward the gutter", () => {
    const localQuad = surfaceLocalQuad(REVIEW_SURFACE_REGISTRY.surfaces.notebookLeft);

    expect(localQuad[0]).toEqual([0, 0]);
    expect(localQuad[1][0]).toBeCloseTo(1, 5);
    expect(localQuad[1][1]).toBeCloseTo(-0.105, 5);
    expect(localQuad[3][1]).toBeCloseTo(0.92, 5);
  });

  it("segments the tape continuously while preserving its progressive fan", () => {
    const { tapeHeader, tapeBody, tapeFooter } = REVIEW_SURFACE_REGISTRY.surfaces;

    expect(tapeHeader.sourceRect.y + tapeHeader.sourceRect.height).toBeCloseTo(tapeBody.sourceRect.y, 6);
    expect(tapeBody.sourceRect.y + tapeBody.sourceRect.height).toBeCloseTo(tapeFooter.sourceRect.y, 6);
    expect(tapeHeader.sourceRect.height + tapeBody.sourceRect.height + tapeFooter.sourceRect.height)
      .toBeCloseTo(REVIEW_SURFACE_REGISTRY.tapeBounds.height, 6);

    const localBody = surfaceLocalQuad(tapeBody);
    const topWidth = localBody[1][0] - localBody[0][0];
    const bottomWidth = localBody[2][0] - localBody[3][0];
    expect(localBody[3][0]).toBeLessThan(localBody[0][0]);
    expect(bottomWidth).toBeLessThan(topWidth);
  });

  it("accepts a valid development-time world-quad override without mutating the registry", () => {
    const surface = REVIEW_SURFACE_REGISTRY.surfaces.tapeHeader;
    const override: SceneQuad = [
      [surface.quad[0][0] + 1, surface.quad[0][1]],
      surface.quad[1],
      surface.quad[2],
      surface.quad[3],
    ];

    expect(surfaceLocalQuad(surface, override)[0][0]).toBeCloseTo(
      (override[0][0] - surface.sourceRect.x) / surface.sourceRect.width,
      8,
    );
    expect(surface.quad[0][0]).not.toBe(override[0][0]);
  });
});

describe("Study SurfaceRegistry", () => {
  it("registers both notebook pages and the source slip in the canonical room world", () => {
    expect(STUDY_SURFACE_REGISTRY.coordinateSpace).toMatchObject({
      id: "room-1672x941",
      width: 1672,
      height: 941,
      fitMode: "cover",
    });
    expect(Object.keys(STUDY_SURFACE_REGISTRY.surfaces)).toEqual([
      "notebookLeft",
      "notebookRight",
      "sourceSlip",
    ]);
    expect(Object.keys(STUDY_SURFACE_REGISTRY.assetHashes)).toEqual(["day", "night", "notebook"]);

    for (const surface of Object.values(STUDY_SURFACE_REGISTRY.surfaces)) {
      expect(surface.coordinateSpace).toBe("room-1672x941");
      expect(surface.assetRevision).toBe(STUDY_SURFACE_REGISTRY.assetRevision);
      expect(isConvexSceneQuad(surface.quad)).toBe(true);
      expect(isConvexSceneQuad(surfaceLocalQuad(surface))).toBe(true);
    }
  });

  it("keeps each page independent around the physical gutter", () => {
    const left = STUDY_SURFACE_REGISTRY.surfaces.notebookLeft.quad;
    const right = STUDY_SURFACE_REGISTRY.surfaces.notebookRight.quad;

    expect(left[1][1]).toBeGreaterThan(left[0][1]);
    expect(left[2][1]).toBeGreaterThan(left[3][1]);
    expect(right[0][1]).toBeGreaterThan(right[1][1]);
    expect(right[3][1]).toBeGreaterThan(right[2][1]);
    expect(right[0][0] - left[1][0]).toBeLessThan(40);
  });

  it("carries calibrated content insets into the generated surface style", () => {
    expect(STUDY_SURFACE_STYLES.notebookLeft["--scene-content-top"]).toBe("13%");
    expect(STUDY_SURFACE_STYLES.notebookRight["--scene-content-left"]).toBe("11.5%");
    expect(STUDY_SURFACE_STYLES.sourceSlip["--scene-content-right"]).toBe("5.5%");
  });
});

describe("Notebook editor SurfaceRegistry", () => {
  it("registers the editable page, action page and provenance slip in the shared room world", () => {
    expect(NOTEBOOK_SURFACE_REGISTRY.coordinateSpace).toMatchObject({
      id: "room-1672x941",
      width: 1672,
      height: 941,
      fitMode: "cover",
    });
    expect(Object.keys(NOTEBOOK_SURFACE_REGISTRY.surfaces)).toEqual([
      "editorPage",
      "actionPage",
      "sourceSlip",
    ]);
    expect(Object.keys(NOTEBOOK_SURFACE_REGISTRY.assetHashes)).toEqual([
      "day",
      "night",
      "notebook",
      "paperFibres",
    ]);

    for (const surface of Object.values(NOTEBOOK_SURFACE_REGISTRY.surfaces)) {
      expect(surface.coordinateSpace).toBe("room-1672x941");
      expect(surface.assetRevision).toBe(NOTEBOOK_SURFACE_REGISTRY.assetRevision);
      expect(isConvexSceneQuad(surface.quad)).toBe(true);
      expect(isConvexSceneQuad(surfaceLocalQuad(surface))).toBe(true);
    }
  });

  it("keeps the editable page and action page independent around the gutter", () => {
    const editor = NOTEBOOK_SURFACE_REGISTRY.surfaces.editorPage.quad;
    const action = NOTEBOOK_SURFACE_REGISTRY.surfaces.actionPage.quad;

    expect(editor[1][1]).toBeGreaterThan(editor[0][1]);
    expect(action[0][1]).toBeGreaterThan(action[1][1]);
    expect(action[0][0] - editor[1][0]).toBeLessThan(40);
    expect(NOTEBOOK_SURFACE_REGISTRY.surfaces.sourceSlip.sourceRect.x).toBeGreaterThan(action[0][0]);
  });

  it("keeps editable controls inside calibrated content safe areas", () => {
    expect(NOTEBOOK_SURFACE_STYLES.editorPage["--scene-content-left"]).toBe("12%");
    expect(NOTEBOOK_SURFACE_STYLES.actionPage["--scene-content-bottom"]).toBe("11%");
    expect(NOTEBOOK_SURFACE_STYLES.sourceSlip["--scene-content-top"]).toBe("12%");
  });
});

describe("Search catalog SurfaceRegistry", () => {
  it("registers the query ledger, two result shelves and boundary slip in the shared room world", () => {
    expect(SEARCH_SURFACE_REGISTRY.coordinateSpace).toMatchObject({
      id: "room-1672x941",
      width: 1672,
      height: 941,
      fitMode: "cover",
    });
    expect(Object.keys(SEARCH_SURFACE_REGISTRY.surfaces)).toEqual([
      "queryLedger",
      "upperShelf",
      "lowerShelf",
      "boundarySlip",
    ]);
    expect(Object.keys(SEARCH_SURFACE_REGISTRY.assetHashes)).toEqual([
      "day",
      "foreground.day",
      "foreground.night",
      "night",
    ]);

    for (const surface of Object.values(SEARCH_SURFACE_REGISTRY.surfaces)) {
      expect(surface.coordinateSpace).toBe("room-1672x941");
      expect(surface.assetRevision).toBe(SEARCH_SURFACE_REGISTRY.assetRevision);
      expect(isConvexSceneQuad(surface.quad)).toBe(true);
      expect(isConvexSceneQuad(surfaceLocalQuad(surface))).toBe(true);
    }
  });

  it("keeps catalog surfaces ordered across the reference wall", () => {
    const { queryLedger, upperShelf, lowerShelf, boundarySlip } = SEARCH_SURFACE_REGISTRY.surfaces;

    expect(boundarySlip.sourceRect.y + boundarySlip.sourceRect.height).toBeLessThanOrEqual(queryLedger.sourceRect.y);
    expect(queryLedger.sourceRect.y + queryLedger.sourceRect.height).toBeLessThanOrEqual(upperShelf.sourceRect.y);
    expect(upperShelf.sourceRect.y + upperShelf.sourceRect.height).toBeLessThanOrEqual(lowerShelf.sourceRect.y);
    expect(queryLedger.quad[0][1]).toBeGreaterThan(queryLedger.quad[1][1]);
    expect(lowerShelf.quad[3][1]).toBeGreaterThan(lowerShelf.quad[2][1]);
  });

  it("carries readable safe areas into every projected shelf surface", () => {
    expect(SEARCH_SURFACE_STYLES.queryLedger["--scene-content-left"]).toBe("5.5%");
    expect(SEARCH_SURFACE_STYLES.upperShelf["--scene-content-top"]).toBe("8%");
    expect(SEARCH_SURFACE_STYLES.lowerShelf["--scene-content-bottom"]).toBe("3%");
    expect(SEARCH_SURFACE_STYLES.boundarySlip["--scene-content-right"]).toBe("8%");
  });
});
