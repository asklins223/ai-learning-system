import { describe, expect, it } from "vitest";
import { projectSceneCameraPoint, SCENE_CAMERA_PRESETS, sceneCameraMatrixForViewport } from "./scene-camera";
import {
  clientPointToReferenceWorld,
  isInsideNormalizedSurfacePoint,
  projectSurfacePoint,
  resolveSurfaceInput,
  unprojectSurfacePoint,
} from "./scene-input";
import { REVIEW_SURFACE_REGISTRY } from "./scene-surfaces";
import type { SceneQuad } from "./scene-geometry";

describe("scene surface input projection", () => {
  const surface = REVIEW_SURFACE_REGISTRY.surfaces.notebookLeft;

  it("converts client points through the visible reference-frame bounds", () => {
    const frameBounds = { left: 120, top: 48, width: 836, height: 470.5 };

    expect(clientPointToReferenceWorld([538, 283.25], frameBounds)).toEqual([
      expect.closeTo(836, 8),
      expect.closeTo(470.5, 8),
    ]);
    expect(clientPointToReferenceWorld([120 - 10, 48], frameBounds)).toEqual([
      expect.closeTo(-20, 8),
      expect.closeTo(0, 8),
    ]);
    expect(clientPointToReferenceWorld([0, 0], { ...frameBounds, width: 0 })).toBeNull();
  });

  it("round-trips normalized points through a perspective Surface quad", () => {
    const localPoint = [0.37, 0.62] as const;
    const worldPoint = projectSurfacePoint(surface, localPoint);

    expect(worldPoint).not.toBeNull();
    const roundTrip = unprojectSurfacePoint(surface, worldPoint!);
    expect(roundTrip?.[0]).toBeCloseTo(localPoint[0], 8);
    expect(roundTrip?.[1]).toBeCloseTo(localPoint[1], 8);
  });

  it("keeps outside points distinguishable for renderer hit testing", () => {
    const outside = unprojectSurfacePoint(surface, [surface.quad[0][0] - 20, surface.quad[0][1] - 20]);

    expect(outside).not.toBeNull();
    expect(isInsideNormalizedSurfacePoint(outside!)).toBe(false);
    expect(isInsideNormalizedSurfacePoint([0, 1])).toBe(true);
    expect(isInsideNormalizedSurfacePoint([1.0000005, 0.5])).toBe(true);
  });

  it("resolves client input to world and local coordinates with an explicit hit result", () => {
    const localPoint = [0.37, 0.62] as const;
    const worldPoint = projectSurfacePoint(surface, localPoint);
    const frameBounds = { left: 20, top: 10, width: 1672, height: 941 };
    const resolution = resolveSurfaceInput({
      clientPoint: [frameBounds.left + worldPoint![0], frameBounds.top + worldPoint![1]],
      frameBounds,
      surface,
    });

    expect(resolution?.worldPoint[0]).toBeCloseTo(worldPoint![0], 8);
    expect(resolution?.worldPoint[1]).toBeCloseTo(worldPoint![1], 8);
    expect(resolution?.localPoint[0]).toBeCloseTo(localPoint[0], 8);
    expect(resolution?.localPoint[1]).toBeCloseTo(localPoint[1], 8);
    expect(resolution?.inside).toBe(true);
  });

  it("uses an explicit camera matrix when the renderer viewport is not CSS-transformed", () => {
    const viewport = { width: 1672, height: 941 };
    const cameraMatrix = sceneCameraMatrixForViewport(SCENE_CAMERA_PRESETS.study, viewport);
    const localPoint = [0.37, 0.62] as const;
    const worldPoint = projectSurfacePoint(surface, localPoint);
    const cameraPoint = projectSceneCameraPoint(worldPoint!, cameraMatrix!);
    const frameBounds = { left: 20, top: 10, width: 1200, height: 675 };
    const clientPoint = [
      frameBounds.left + (cameraPoint![0] / viewport.width) * frameBounds.width,
      frameBounds.top + (cameraPoint![1] / viewport.height) * frameBounds.height,
    ] as const;
    const resolution = resolveSurfaceInput({
      clientPoint,
      frameBounds,
      surface,
      cameraMatrix: cameraMatrix!,
    });

    expect(resolution?.worldPoint[0]).toBeCloseTo(worldPoint![0], 8);
    expect(resolution?.worldPoint[1]).toBeCloseTo(worldPoint![1], 8);
    expect(resolution?.localPoint[0]).toBeCloseTo(localPoint[0], 8);
    expect(resolution?.localPoint[1]).toBeCloseTo(localPoint[1], 8);
    expect(resolution?.inside).toBe(true);
  });

  it("fails closed before reading a malformed camera viewport", () => {
    const malformedMatrix = { a: 1, d: 1, tx: 0, ty: 0 } as unknown as Parameters<typeof clientPointToReferenceWorld>[2];

    expect(clientPointToReferenceWorld([200, 120], {
      left: 20,
      top: 10,
      width: 1200,
      height: 675,
    }, malformedMatrix)).toBeNull();
  });

  it("rejects non-finite points and invalid override quads", () => {
    const invalidQuad = [[0, 0], [1, 0], [0, 0], [0, 1]] as SceneQuad;

    expect(projectSurfacePoint(surface, [Number.NaN, 0.5])).toBeNull();
    expect(unprojectSurfacePoint(surface, [Number.POSITIVE_INFINITY, 2])).toBeNull();
    expect(projectSurfacePoint(surface, [0.5, 0.5], invalidQuad)).toBeNull();
    expect(unprojectSurfacePoint(surface, [0.5, 0.5], invalidQuad)).toBeNull();
  });
});
